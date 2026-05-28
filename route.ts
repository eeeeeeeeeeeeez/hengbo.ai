// app/api/live/route.ts
// ──────────────────────────────────────────────────────────────────
// HTTP POST endpoint:  browser POSTs PCM audio chunks (base64 JSON)
// and we forward them to Gemini Live API over a *server-side* WS
// that is kept alive per-session via a sessionId cookie/header.
//
// HOWEVER – the cleanest architecture for Gemini Live is a real WS
// proxy.  See server.ts (custom Next.js server) for the WS route.
// This REST fallback is only for environments that can't do custom servers.
// ──────────────────────────────────────────────────────────────────

export async function GET() {
  return Response.json({ status: "Use WebSocket via /api/live-ws (see server.ts)" });
}
