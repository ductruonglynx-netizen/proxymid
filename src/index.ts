export interface Env {
  RELAY_ROOM: DurableObjectNamespace;
  RELAY_SHARED_SECRET?: string;
}

type RelayRole = 'provider' | 'client';

interface RelaySocketMeta {
  role: RelayRole;
  joinedAt: number;
}

interface StoredToken {
  code: string;
  long: string;
  token: string;
  provider: string;
  issuedAt: string;
}

interface PublishTokenBody {
  token?: string;
  apiKey?: string;
  accessToken?: string;
  authorization?: string;
  bearerToken?: string;
  long?: string;
  provider?: string;
}

const ROOM_CODE_RE = /^\d{4,8}$/;
const TOKEN_KEY_RE = /^AIza[0-9A-Za-z\-_]{20,}$/;
const OAUTH_BEARER_RE = /^ya29\.[0-9A-Za-z\-_.]+$/;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const normalizePathname = (pathname: string): string => {
  const normalized = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return normalized || '/';
};

function withCors(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  next.set('Access-Control-Allow-Origin', '*');
  next.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Relay-Secret');
  return next;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: withCors(JSON_HEADERS),
  });
}

function parseCode(url: URL): string {
  const raw = (url.searchParams.get('code') || '').trim();
  if (ROOM_CODE_RE.test(raw)) return raw;

  const pathname = normalizePathname(url.pathname);
  const patterns = [
    /^\/(\d{4,8})$/,
    /^\/code=(\d{4,8})$/,
    /^\/(?:room|ws|connect)\/(\d{4,8})$/,
    /^\/(?:publish-token|stats)\/(\d{4,8})$/,
    /^\/(\d{4,8})\/(?:publish-token|stats)$/,
    /^\/code=(\d{4,8})\/(?:publish-token|stats)$/,
  ];

  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match?.[1] && ROOM_CODE_RE.test(match[1])) {
      return match[1];
    }
  }

  return '';
}

function parseRole(url: URL): RelayRole | null {
  const raw = (url.searchParams.get('role') || '').trim().toLowerCase();
  if (raw === 'provider' || raw === 'client') return raw;
  return null;
}

function sanitizeBearer(input: string): string {
  return input.replace(/^Bearer\s+/i, '').trim();
}

function extractToken(input: unknown): string {
  if (typeof input === 'string') {
    const trimmed = sanitizeBearer(input);
    if (TOKEN_KEY_RE.test(trimmed) || OAUTH_BEARER_RE.test(trimmed)) return trimmed;

    try {
      return extractToken(JSON.parse(input));
    } catch {
      return '';
    }
  }

  if (!input || typeof input !== 'object') return '';
  const row = input as Record<string, unknown>;
  const candidates = [
    row.token,
    row.apiKey,
    row.accessToken,
    row.authorization,
    row.bearerToken,
  ];

  for (const candidate of candidates) {
    const trimmed = sanitizeBearer(String(candidate || ''));
    if (TOKEN_KEY_RE.test(trimmed) || OAUTH_BEARER_RE.test(trimmed)) {
      return trimmed;
    }
  }

  return '';
}

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 12) return `${trimmed.slice(0, 4)}...`;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

function authorizePublish(request: Request, env: Env): boolean {
  const expected = (env.RELAY_SHARED_SECRET || '').trim();
  if (!expected) return true;

  const secretHeader = (request.headers.get('x-relay-secret') || '').trim();
  const authHeader = sanitizeBearer(request.headers.get('authorization') || '');
  return secretHeader === expected || authHeader === expected;
}

async function readPublishBody(request: Request): Promise<PublishTokenBody> {
  const text = await request.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text) as PublishTokenBody;
  } catch {
    return { token: text.trim() };
  }
}

async function forwardRoomRequest(
  env: Env,
  code: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(code));
  return stub.fetch(`https://relay-room.internal${path}?code=${code}`, init);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors() });
    }

    if (pathname === '/health') {
      return json({
        ok: true,
        service: 'proxymid',
        date: new Date().toISOString(),
      });
    }

    const code = parseCode(url);

    const isPublishRoute =
      pathname === '/publish-token' ||
      /^\/publish-token\/\d{4,8}$/.test(pathname) ||
      /^\/\d{4,8}\/publish-token$/.test(pathname);

    if (isPublishRoute) {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'Use POST /publish-token/1234 or POST /1234/publish-token' }, 405);
      }
      if (!code) {
        return json({ ok: false, error: 'Invalid or missing code. Expected 4-8 digits.' }, 400);
      }
      if (!authorizePublish(request, env)) {
        return json({ ok: false, error: 'Unauthorized publish request.' }, 401);
      }

      const payload = await readPublishBody(request);
      const token = extractToken(payload);
      if (!token) {
        return json({ ok: false, error: 'Missing token/apiKey/accessToken in body.' }, 400);
      }

      return forwardRoomRequest(env, code, '/publish-token', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          code,
          long: String(payload.long || code),
          provider: String(payload.provider || 'ai.studio'),
          token,
        }),
      });
    }

    const isStatsRoute =
      pathname === '/stats' ||
      /^\/code=\d{4,8}\/stats$/.test(pathname) ||
      /^\/stats\/\d{4,8}$/.test(pathname) ||
      /^\/\d{4,8}\/stats$/.test(pathname);

    if (isStatsRoute) {
      if (!code) {
        return json({ ok: false, error: 'Missing code.' }, 400);
      }
      return forwardRoomRequest(env, code, '/stats');
    }

    const isConnectRoute =
      pathname === '/' ||
      pathname === '/ws' ||
      pathname === '/connect' ||
      /^\/code=\d{4,8}$/.test(pathname) ||
      /^\/\d{4,8}$/.test(pathname) ||
      /^\/(?:room|ws|connect)\/\d{4,8}$/.test(pathname);

    if (isConnectRoute) {
      if (!code) {
        return json(
          {
            ok: false,
            error: 'Missing or invalid code. Use /1234 or ?code=1234',
            exampleRoom: '/1234',
            examplePublish: '/publish-token/1234',
            examplePublishAlt: '/1234/publish-token',
            exampleWebSocket: 'wss://<your-worker-domain>/1234',
          },
          400,
        );
      }

      if (!isWebSocketUpgrade(request)) {
        return json({
          ok: true,
          code,
          room: `https://${url.host}/${code}`,
          connect: `wss://${url.host}/${code}`,
          connectLegacy: `wss://${url.host}/?code=${code}`,
          publish: `https://${url.host}/publish-token/${code}`,
          publishAlt: `https://${url.host}/${code}/publish-token`,
          stats: `https://${url.host}/stats/${code}`,
        });
      }

      return forwardRoomRequest(env, code, '/ws', request);
    }

    return json(
      {
        ok: true,
        name: 'proxymid',
        health: '/health',
        room: '/1234',
        websocket: '/1234',
        websocketLegacy: '/?code=1234',
        publish: '/publish-token/1234',
        publishAlt: '/1234/publish-token',
        stats: '/stats/1234',
      },
      200,
    );
  },
} satisfies ExportedHandler<Env>;

export class RelayRoom {
  private sockets = new Map<WebSocket, RelaySocketMeta>();
  private requestMap = new Map<string, WebSocket>();
  private lastToken: StoredToken | null = null;
  private stateLoaded = false;
  private roomCode = '';

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;

    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as RelaySocketMeta | null;
      if (meta) {
        this.sockets.set(ws, meta);
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.roomCode = (await this.ctx.storage.get<string>('room_code')) || '';
    this.lastToken = (await this.ctx.storage.get<StoredToken>('last_token')) || null;
    this.stateLoaded = true;
  }

  private getProviderSocket(): WebSocket | null {
    for (const [ws, meta] of this.sockets.entries()) {
      if (meta.role === 'provider' && ws.readyState === WebSocket.OPEN) {
        return ws;
      }
    }
    return null;
  }

  private countClients(): number {
    let count = 0;
    for (const meta of this.sockets.values()) {
      if (meta.role === 'client') count += 1;
    }
    return count;
  }

  private decideRole(requestedRole: RelayRole | null): RelayRole {
    if (requestedRole) return requestedRole;
    return this.getProviderSocket() ? 'client' : 'provider';
  }

  private buildTokenEnvelope(payload: StoredToken): string {
    return JSON.stringify({
      type: 'token',
      code: payload.code,
      long: payload.long,
      token: payload.token,
      provider: payload.provider,
      issuedAt: payload.issuedAt,
    });
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  private broadcast(raw: string, predicate?: (ws: WebSocket, meta: RelaySocketMeta) => boolean): void {
    for (const [ws, meta] of this.sockets.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (predicate && !predicate(ws, meta)) continue;
      ws.send(raw);
    }
  }

  private deletePendingForSocket(ws: WebSocket): void {
    for (const [requestId, owner] of this.requestMap.entries()) {
      if (owner === ws) this.requestMap.delete(requestId);
    }
  }

  private async storeAndBroadcastToken(payload: StoredToken): Promise<void> {
    this.lastToken = payload;
    await this.ctx.storage.put('last_token', payload);
    this.broadcast(this.buildTokenEnvelope(payload), (_ws, meta) => meta.role === 'client');
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const code = parseCode(url);

    if (!code) {
      return json({ ok: false, error: 'Invalid room code.' }, 400);
    }

    this.roomCode = code;
    await this.ctx.storage.put('room_code', code);

    if (url.pathname === '/publish-token') {
      const payload = (await request.json()) as PublishTokenBody & { code?: string };
      const token = extractToken(payload);
      if (!token) {
        return json({ ok: false, error: 'Missing token.' }, 400);
      }

      const row: StoredToken = {
        code,
        long: String(payload.long || code),
        token,
        provider: String(payload.provider || 'ai.studio'),
        issuedAt: new Date().toISOString(),
      };

      await this.storeAndBroadcastToken(row);
      return json({
        ok: true,
        code,
        long: row.long,
        provider: row.provider,
        issuedAt: row.issuedAt,
        tokenPreview: maskToken(row.token),
        clients: this.countClients(),
      });
    }

    if (url.pathname === '/stats') {
      return json({
        ok: true,
        code,
        hasProvider: Boolean(this.getProviderSocket()),
        clients: this.countClients(),
        pendingRequests: this.requestMap.size,
        hasToken: Boolean(this.lastToken?.token),
        tokenIssuedAt: this.lastToken?.issuedAt || null,
      });
    }

    if (!isWebSocketUpgrade(request)) {
      return json({
        ok: true,
        code,
        hasProvider: Boolean(this.getProviderSocket()),
        clients: this.countClients(),
        hasToken: Boolean(this.lastToken?.token),
      });
    }

    const requestedRole = parseRole(url);
    const role = this.decideRole(requestedRole);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const meta: RelaySocketMeta = { role, joinedAt: Date.now() };

    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    this.sockets.set(server, meta);

    this.sendJson(server, {
      type: 'system',
      event: role === 'provider' ? 'provider_connected' : 'client_connected',
      code,
      at: new Date().toISOString(),
    });

    if (role === 'client' && this.lastToken?.token) {
      this.sendJson(server, JSON.parse(this.buildTokenEnvelope(this.lastToken)));
    }

    if (role === 'client') {
      const provider = this.getProviderSocket();
      if (provider) {
        this.sendJson(provider, {
          type: 'system',
          event: 'client_connected',
          code,
          at: new Date().toISOString(),
        });
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();

    const meta = this.sockets.get(ws);
    if (!meta) return;

    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let data: Record<string, unknown>;

    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (data.type === 'ping') {
      this.sendJson(ws, { type: 'pong', at: Date.now() });
      return;
    }

    if (data.type === 'token') {
      if (meta.role !== 'provider') {
        this.sendJson(ws, {
          type: 'system',
          event: 'publish_denied',
          message: 'Only provider sockets can publish tokens.',
        });
        return;
      }

      const token = extractToken(data);
      if (!token) return;

      await this.storeAndBroadcastToken({
        code: String(data.code || this.roomCode || this.lastToken?.code || ''),
        long: String(data.long || data.code || this.roomCode || this.lastToken?.long || ''),
        token,
        provider: String(data.provider || 'provider-socket'),
        issuedAt: new Date().toISOString(),
      });
      return;
    }

    if (meta.role === 'provider') {
      const requestId = String(data.request_id || '');
      if (requestId && this.requestMap.has(requestId)) {
        const client = this.requestMap.get(requestId);
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(raw);
        }
        if (data.event_type === 'stream_close' || data.event_type === 'error') {
          this.requestMap.delete(requestId);
        }
        return;
      }

      this.broadcast(raw, (_client, clientMeta) => clientMeta.role === 'client');
      return;
    }

    const provider = this.getProviderSocket();
    const requestId = String(data.request_id || '');
    if (!provider) {
      this.sendJson(ws, {
        request_id: requestId,
        event_type: 'error',
        status: 503,
        message: 'Provider chưa kết nối',
      });
      return;
    }

    if (requestId) this.requestMap.set(requestId, ws);
    provider.send(raw);
  }

  webSocketClose(ws: WebSocket): void {
    const meta = this.sockets.get(ws);
    if (!meta) return;

    this.sockets.delete(ws);
    this.deletePendingForSocket(ws);

    if (meta.role === 'provider') {
      for (const [requestId, client] of this.requestMap.entries()) {
        this.sendJson(client, {
          request_id: requestId,
          event_type: 'error',
          status: 503,
          message: 'Provider disconnected',
        });
      }
      this.requestMap.clear();
      this.broadcast(
        JSON.stringify({
          type: 'system',
          event: 'provider_disconnected',
          at: new Date().toISOString(),
        }),
        (_client, clientMeta) => clientMeta.role === 'client',
      );
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }
}
