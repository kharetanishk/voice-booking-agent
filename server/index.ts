import index from "../web/index.html";
import { startCall, type Call } from "./call";
import type { ClientMessage } from "./protocol";
import { discardSession, releaseSession } from "./session";
import { createBackend, type Mode } from "./fakeBackend";
import { createLlm, modelsFromEnv, VERTEX_MODELS, vertexToken, vertexUrl } from "./llm";
import { banner, log } from "./logger";

type Tier = "free" | "premium";
type SocketData = { sessionId: string; tier: Tier; call?: Call };

const deepgramKey = process.env.DEEPGRAM_API_KEY;
if (!deepgramKey) throw new Error("DEEPGRAM_API_KEY is missing. Copy .env.example to .env and fill it in.");

const port = Number(process.env.PORT ?? 3000);
const backend = createBackend();
const openRouterKey = process.env.OPENROUTER_API_KEY;
// With VERTEX_PROJECT set, the free tier uses Gemini on Vertex AI instead of OpenRouter.
// Needs GOOGLE_APPLICATION_CREDENTIALS, the path to a service account key file.
const vertexProject = process.env.VERTEX_PROJECT;

// Standard ("free"): Gemini on Vertex AI, or free OpenRouter models, and the Deepgram voice.
// Premium: paid OpenRouter models and the ElevenLabs voice. Needs both keys, otherwise only standard is offered.
const freeModels = vertexProject
  ? modelsFromEnv(process.env.VERTEX_MODEL, VERTEX_MODELS)
  : modelsFromEnv(process.env.OPENROUTER_MODEL);
const paidModels = (process.env.OPENROUTER_PAID_MODEL ?? "google/gemini-2.5-flash,anthropic/claude-haiku-4.5")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const premiumReady = Boolean(openRouterKey && process.env.ELEVENLABS_API_KEY);
const tiers = {
  free: {
    llm: vertexProject
      ? createLlm(vertexToken(), freeModels, vertexUrl(vertexProject))
      : openRouterKey ? createLlm(openRouterKey, freeModels) : undefined,
    voice: "deepgram" as const,
  },
  premium: { llm: openRouterKey ? createLlm(openRouterKey, paidModels) : undefined, voice: "elevenlabs" as const },
};

const MODES: Mode[] = ["ok", "slow", "fail", "lostack", "hang"];

// The connection that currently owns each call. A call that reconnects replaces its old connection.
const activeCalls = new Map<string, Call>();

Bun.serve<SocketData>({
  port,
  routes: { "/": index },
  fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const sessionId = url.searchParams.get("session") ?? crypto.randomUUID();
      const tier: Tier = url.searchParams.get("tier") === "premium" && premiumReady ? "premium" : "free";
      if (server.upgrade(request, { data: { sessionId, tier } })) return;
    }
    // Stress test. With ?mode=slow the booking requests behave that way, ?mode=random goes back to normal.
    // Without a mode it just reports the current setting.
    if (url.pathname === "/api/chaos") {
      const mode = url.searchParams.get("mode");
      if (mode === "random") backend.forced = undefined;
      else if (mode && MODES.includes(mode as Mode)) backend.forced = mode as Mode;
      else if (mode) return Response.json({ error: `unknown mode ${mode}` }, { status: 400 });
      if (mode) log("BACKEND", `Stress test set to: ${backend.forced ?? "random"}`, "warn");
      return Response.json({ mode: backend.forced ?? "random" });
    }
    if (url.pathname === "/api/tiers") return Response.json({ premium: premiumReady });
    if (url.pathname === "/api/bookings") return Response.json([...backend.bookings.values()]);

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { sessionId } = ws.data;
      activeCalls.get(sessionId)?.end();
      const { tier } = ws.data;
      log("CALL", `${tier} tier: ${tier === "premium" ? `${paidModels[0]} and the ElevenLabs voice` : `${freeModels[0]} and the Deepgram voice`}`, "info", sessionId.slice(0, 4));
      ws.data.call = startCall(ws, sessionId, { backend, ...tiers[tier], deepgramKey });
      activeCalls.set(sessionId, ws.data.call);
    },
    message(ws, data) {
      if (typeof data !== "string") return ws.data.call?.sendAudio(data);
      const message: ClientMessage = JSON.parse(data);
      if (message.type === "hangup") {
        ws.data.call?.end();
        activeCalls.delete(ws.data.sessionId);
        discardSession(ws.data.sessionId);
        log("CALL", "the caller ended the call", "good", ws.data.sessionId.slice(0, 4));
      }
    },
    close(ws) {
      ws.data.call?.end();
      // Only the connection that owns the call may start the countdown. An old one may close after a newer one took over.
      if (activeCalls.get(ws.data.sessionId) === ws.data.call) {
        activeCalls.delete(ws.data.sessionId);
        releaseSession(ws.data.sessionId);
      }
    },
  },
});

banner("Reschedule voice agent", [
  ["Open", `http://localhost:${port}`],
  ["Listening", "Deepgram nova-3"],
  ["Standard tier", vertexProject || openRouterKey ? `${freeModels[0]} (+${freeModels.length - 1} backups), Deepgram aura-2 voice` : "fixed replies only (set VERTEX_PROJECT or OPENROUTER_API_KEY), Deepgram aura-2 voice"],
  ["Premium tier", premiumReady ? `${paidModels.join(", then ")}, ElevenLabs voice` : "off (needs OPENROUTER_API_KEY and ELEVENLABS_API_KEY)"],
  ["Booking system", "fake courier backend, misbehaves at random (change it with the stress test bar)"],
]);
