"use client";
/**
 * app/page.tsx
 *
 * Gemini Live API  –  Native Audio  –  極簡泡泡 UI
 *
 * 流程：
 *   1. 點擊泡泡 → 連接 /api/live-ws (WebSocket 代理)
 *   2. 麥克風 PCM 16 kHz → 即時串流到 Gemini
 *   3. Gemini 回傳 PCM 24 kHz → ScriptProcessor 播放
 *   4. Web Audio AnalyserNode → 泡泡 scale / borderRadius 動畫
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────
type Phase = "idle" | "connecting" | "listening" | "speaking";

const LABEL: Record<Phase, string> = {
  idle: "點擊開始",
  connecting: "連線中…",
  listening: "聆聽中…",
  speaking: "說話中…",
};

const COLOR: Record<Phase, string> = {
  idle: "#b8a4f8",
  connecting: "#f9c76b",
  listening: "#6ee7d4",
  speaking: "#7eb8f7",
};

// ─── PCM helpers ─────────────────────────────────────────────────
/** Float32 samples → 16-bit little-endian PCM Buffer */
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** ArrayBuffer → base64 string */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** base64 → Int16Array PCM */
function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return new Int16Array(buf);
}

// ─── Component ───────────────────────────────────────────────────
export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [scale, setScale] = useState(1);
  const [bRadius, setBRadius] = useState(50);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const scriptRef = useRef<ScriptProcessorNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const animRef = useRef<number>(0);
  const pcmQueueRef = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);

  // ── Bubble animation ───────────────────────────────────────────
  const startAnim = useCallback((analyser: AnalyserNode) => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const n = avg / 100;
      setScale(1 + n * 0.5);
      setBRadius(50 - n * 20);
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }, []);

  const stopAnim = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    setScale(1);
    setBRadius(50);
  }, []);

  // ── Playback: schedule PCM chunk via AudioContext ──────────────
  const scheduleChunk = useCallback(
    (pcm: Int16Array) => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const SAMPLE_RATE = 24000;
      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        floats[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
      }
      const buffer = ctx.createBuffer(1, floats.length, SAMPLE_RATE);
      buffer.copyToChannel(floats, 0);

      const src = ctx.createBufferSource();
      src.buffer = buffer;

      // Connect through analyser for visualisation
      const analyser = analyserRef.current!;
      src.connect(analyser);
      analyser.connect(ctx.destination);

      const when = Math.max(ctx.currentTime, nextPlayTimeRef.current);
      src.start(when);
      nextPlayTimeRef.current = when + buffer.duration;
    },
    []
  );

  // ── Handle incoming Gemini message ─────────────────────────────
  const handleGeminiMsg = useCallback(
    (raw: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // Setup complete
      if (msg.setupComplete) {
        setPhase("listening");
        return;
      }

      // Audio data in serverContent
      const sc = msg.serverContent as
        | { modelTurn?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }
        | undefined;
      const parts = sc?.modelTurn?.parts ?? [];
      let gotAudio = false;
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
          const pcm = base64ToInt16(part.inlineData.data);
          pcmQueueRef.current.push(pcm);
          gotAudio = true;
        }
      }
      if (gotAudio && !isPlayingRef.current) {
        isPlayingRef.current = true;
        setPhase("speaking");
        nextPlayTimeRef.current = audioCtxRef.current?.currentTime ?? 0;
        const drain = () => {
          if (pcmQueueRef.current.length > 0) {
            const chunk = pcmQueueRef.current.shift()!;
            scheduleChunk(chunk);
            requestAnimationFrame(drain);
          } else {
            isPlayingRef.current = false;
          }
        };
        drain();
      }

      // Turn complete → back to listening
      if (
        (msg.serverContent as { turnComplete?: boolean } | undefined)
          ?.turnComplete
      ) {
        // small delay so last chunk finishes
        setTimeout(() => {
          setPhase("listening");
        }, 300);
      }
    },
    [scheduleChunk]
  );

  // ── Start session ──────────────────────────────────────────────
  const startSession = useCallback(async () => {
    setPhase("connecting");

    // AudioContext
    const ctx = new AudioContext({ sampleRate: 48000 });
    audioCtxRef.current = ctx;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;

    startAnim(analyser);

    // WebSocket
    const wsUrl =
      (typeof window !== "undefined" && window.location.protocol === "https:"
        ? "wss"
        : "ws") +
      "://" +
      window.location.host +
      "/api/live-ws";

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (ev) => handleGeminiMsg(ev.data as string);
    ws.onerror = () => {
      stopAnim();
      setPhase("idle");
    };
    ws.onclose = () => {
      stopAnim();
      setPhase("idle");
    };

    // Microphone capture
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;

    // Resample to 16 kHz via ScriptProcessorNode
    const micSource = ctx.createMediaStreamSource(stream);
    // 4096 samples @ 48kHz ≈ 85ms chunks; we'll downsample to 16kHz
    const scriptNode = ctx.createScriptProcessor(4096, 1, 1);
    scriptRef.current = scriptNode;

    scriptNode.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (phase === "speaking") return; // don't send mic during playback (barge-in optional)
      const input = e.inputBuffer.getChannelData(0);
      // Simple downsample 48k→16k (take every 3rd sample)
      const ratio = Math.round(ctx.sampleRate / 16000);
      const downsampled = new Float32Array(Math.floor(input.length / ratio));
      for (let i = 0; i < downsampled.length; i++) {
        downsampled[i] = input[i * ratio];
      }
      const pcm = floatTo16BitPCM(downsampled);
      const b64 = bufToBase64(pcm);
      ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
          },
        })
      );
    };

    micSource.connect(scriptNode);
    scriptNode.connect(ctx.destination); // must connect for onaudioprocess to fire (Chrome)
  }, [handleGeminiMsg, startAnim, stopAnim, phase]);

  // ── Stop session ───────────────────────────────────────────────
  const stopSession = useCallback(() => {
    wsRef.current?.close();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    scriptRef.current?.disconnect();
    audioCtxRef.current?.close();
    wsRef.current = null;
    micStreamRef.current = null;
    scriptRef.current = null;
    audioCtxRef.current = null;
    stopAnim();
    setPhase("idle");
  }, [stopAnim]);

  // ── Click handler ──────────────────────────────────────────────
  const handleClick = useCallback(() => {
    if (phase === "idle") startSession();
    else stopSession();
  }, [phase, startSession, stopSession]);

  useEffect(() => () => stopSession(), [stopSession]);

  const color = COLOR[phase];

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#09090c",
        fontFamily: "'DM Sans', sans-serif",
        gap: "2.4rem",
        overflow: "hidden",
      }}
    >
      {/* Ambient glow */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: `radial-gradient(ellipse 55% 45% at 50% 54%, ${color}1a 0%, transparent 70%)`,
          transition: "background 1s ease",
          pointerEvents: "none",
        }}
      />

      {/* Connecting ring */}
      {phase === "connecting" && (
        <>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div
            style={{
              position: "absolute",
              width: 200,
              height: 200,
              borderRadius: "50%",
              border: `2px solid ${color}`,
              borderTopColor: "transparent",
              animation: "spin 1s linear infinite",
              pointerEvents: "none",
            }}
          />
        </>
      )}

      {/* Ping ring when listening */}
      {phase === "listening" && (
        <>
          <style>{`@keyframes ping{0%{transform:scale(1);opacity:.5}100%{transform:scale(2);opacity:0}}`}</style>
          <div
            style={{
              position: "absolute",
              width: 160,
              height: 160,
              borderRadius: "50%",
              border: `1.5px solid ${color}`,
              animation: "ping 1.8s ease-out infinite",
              pointerEvents: "none",
            }}
          />
        </>
      )}

      {/* Bubble */}
      <button
        onClick={handleClick}
        aria-label={LABEL[phase]}
        style={{
          width: 160,
          height: 160,
          border: "none",
          cursor: "pointer",
          background: `radial-gradient(circle at 38% 35%, ${color}ee, ${color}77 60%, ${color}33)`,
          borderRadius: `${bRadius}%`,
          transform: `scale(${scale})`,
          transition: "background 0.9s ease, border-radius 0.05s linear",
          boxShadow: `0 0 80px 24px ${color}44, 0 0 160px 60px ${color}18`,
          outline: "none",
          willChange: "transform, border-radius",
          position: "relative",
          zIndex: 1,
        }}
      />

      {/* Label */}
      <p
        style={{
          color: "#ffffff66",
          fontSize: "0.78rem",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          margin: 0,
          position: "relative",
          zIndex: 1,
        }}
      >
        {LABEL[phase]}
        {phase !== "idle" && (
          <span style={{ marginLeft: 8, color: "#ffffff33", fontSize: "0.7rem" }}>
            (點擊停止)
          </span>
        )}
      </p>

      {/* Font */}
      <link
        rel="preconnect"
        href="https://fonts.googleapis.com"
      />
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400&display=swap"
        rel="stylesheet"
      />
    </main>
  );
}
