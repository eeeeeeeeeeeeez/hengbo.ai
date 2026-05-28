import { createServer } from "http";
import { WebSocketServer, WebSocket as WS } from "ws";

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
              "你是一個溫塊、簡潔的語音助手。請用繁體中文口語回覆，每次回答盡量簡短自然，適合即時語音對話。",
          },
        ],
      },
    },
  });
}

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hengbo AI WebSocket Proxy is running.");
});

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

  clientWs.on("message", (data) => {
    if (upstream.readyState === WS.OPEN) upstream.send(data);
  });

  clientWs.on("close", () => {
    console.log("[LiveProxy] Client disconnected");
    upstream.close();
  });
});

if (process.env.NODE_ENV !== "production") {
  httpServer.listen(port, () => {
    console.log(`\n✅  Ready on http://localhost:${port}`);
  });
}

export default httpServer;
