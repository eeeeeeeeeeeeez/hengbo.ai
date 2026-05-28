// server.ts  ← 專案根目錄
// 自訂 Next.js 伺服器，同時處理 WebSocket 代理 → Gemini Live API
//
// 安裝依賴：npm i ws && npm i -D @types/ws ts-node
// 啟動：npx ts-node --skip-project server.ts
// 生產：先 next build，再 node dist/server.js

import { createServer } from "http";
import next from "next";
import { WebSocketServer, WebSocket as WS } from "ws";

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = parseInt(process.env.PORT ?? "3000", 10);

const GEMINI_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function buildSetupMsg(): string {
  return JSON.stringify({
    config: {
      model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Aoede" },
        },
      },
      systemInstruction: {
        parts: [
          {
            text:
              "你是一個溫暖、簡潔的語音助手。請用繁體中文口語回覆，每次回答盡量簡短自然，適合即時語音對話。",
          },
        ],
      },
    },
  });
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res));
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/live-ws") {
      wss.handleUpgrade(req, socket as never, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (clientWs: WS) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      clientWs.close(1011, "Missing GEMINI_API_KEY");
      return;
    }

    console.log("[LiveProxy] Client connected → opening Gemini WS…");
    const upstream = new WS(`${GEMINI_ENDPOINT}?key=${apiKey}`);

    upstream.on("open", () => {
      console.log("[LiveProxy] Gemini WS open, sending setup");
      upstream.send(buildSetupMsg());
    });

    // Gemini → browser
    upstream.on("message", (data) => {
      if (clientWs.readyState === WS.OPEN) clientWs.send(data);
    });

    upstream.on("close", (code, reason) => {
      console.log(`[LiveProxy] Gemini closed: ${code} ${reason}`);
      clientWs.close();
    });

    upstream.on("error", (err) => {
      console.error("[LiveProxy] Gemini error:", err.message);
      clientWs.close();
    });

    // Browser → Gemini
    clientWs.on("message", (data) => {
      if (upstream.readyState === WS.OPEN) upstream.send(data);
    });

    clientWs.on("close", () => {
      console.log("[LiveProxy] Client disconnected");
      upstream.close();
    });
  });

  httpServer.listen(port, () => {
    console.log(`\n✅  Ready on http://${hostname}:${port}`);
    console.log(`   WebSocket proxy: ws://${hostname}:${port}/api/live-ws\n`);
  });
});
