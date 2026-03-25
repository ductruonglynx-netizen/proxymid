# Proxymid

Cloudflare Worker nay dong vai tro "server trung chuyen token" giua:

- `ai.studio`: day token AI len worker
- `truyenforge`: ket noi WebSocket de nhan token va, neu can, tiep tuc dung cung protocol cu de forward request/response

## Kien truc

```text
AI Studio app
  -> POST /publish-token/1234
Cloudflare Worker + Durable Object
  -> broadcast {"type":"token","code":"1234","token":"..."}
TruyenForge
  -> WebSocket wss://<worker-domain>/1234
```

Worker van giu protocol relay cu:

- `type: "token"` de day token
- `type: "ping"` / `type: "pong"` de keep-alive
- `request_id` de provider va client co the forward request/response neu ban muon mo rong

## Cai dat

```bash
npm install
npm run check
npm run dev
```

Neu muon khoa endpoint publish, tao file `.dev.vars`:

```env
RELAY_SHARED_SECRET=your-strong-shared-secret
```

Deploy:

```bash
npm run deploy
```

## Endpoint

- `GET /health`
- `GET /1234`
- `GET /stats/1234`
- `POST /publish-token/1234`
- `POST /1234/publish-token`
- `WS /1234`

Worker van ho tro kieu cu de tuong thich nguoc:

- `GET /?code=1234`
- `GET /stats?code=1234`
- `POST /publish-token?code=1234`
- `WS /?code=1234`

## Body publish token

Gui mot trong cac field sau:

```json
{
  "token": "AIza...",
  "provider": "ai.studio",
  "long": "1234"
}
```

Hoac:

```json
{
  "accessToken": "ya29....",
  "provider": "ai.studio"
}
```

## Vi du tich hop AI Studio

Neu app `https://ai.studio/apps/d06ef4b0-7f98-4efe-8747-3fa5964aeddf` co the chay JavaScript client, chi can publish token bang `fetch`:

```ts
const workerBase = 'https://proxymid.ductruong-lynx.workers.dev';
const roomCode = '1234';
const token = aiToken; // API key hoac OAuth bearer token

await fetch(`${workerBase}/publish-token/${roomCode}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Relay-Secret': 'your-strong-shared-secret',
  },
  body: JSON.stringify({
    token,
    provider: 'ai.studio',
    long: roomCode,
  }),
});
```

Neu ban muon doc ma phong truc tiep tu link dang `https://proxymid.ductruong-lynx.workers.dev/1234`:

```ts
const roomCode = window.location.pathname.split('/').filter(Boolean)[0] || '';
```

## Vi du tich hop TruyenForge

Trong `truyentudoapp`, dat:

```env
VITE_RELAY_WS_BASE="wss://proxymid.ductruong-lynx.workers.dev/"
VITE_RELAY_WEB_BASE="https://proxymid.ductruong-lynx.workers.dev/"
```

Sau do tren giao dien TruyenForge, nhap ma phong `1234` hoac dan link day du `https://proxymid.ductruong-lynx.workers.dev/1234`, roi ket noi relay. Worker se day payload dang:

```json
{
  "type": "token",
  "code": "1234",
  "long": "1234",
  "token": "AIza...",
  "provider": "ai.studio"
}
```

Payload nay da tuong thich voi logic `extractRelayPayload(...)` co san trong app, mien la app nhan da ho tro tach room code tu pathname `/1234`.

## Ghi chu bao mat

- Neu `truyenforge` nhan token trong browser, token do se ton tai o phia client.
- Cloudflare Worker giup tach he thong va an backend trung gian, nhung khong bien token thanh "khong the xem duoc" sau khi ban da gui no vao browser.
- Neu can muc bao mat cao hon, nen chuyen sang kieu provider-side proxy: `truyenforge -> worker -> provider`, thay vi broadcast token thuan tuy.
