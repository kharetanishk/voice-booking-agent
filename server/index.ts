import index from "../web/index.html";
import { startCall, type Call } from "./call";
import type { ClientMessage } from "./protocol";
import { discardSession, releaseSession } from "./session";
import { createBackend } from "./fakeBackend";
import { createLlm, modelsFromEnv, VERTEX_MODELS, vertexToken, vertexUrl } from "./llm";
import { banner, log } from "./logger";

type SocketData = { sessionId: string; call?: Call };

const deepgramKey = process.env.DEEPGRAM_API_KEY;
if (!deepgramKey) throw new Error("DEEPGRAM_API_KEY is missing. Copy .env.example to .env and fill it in.");

const port = Number(process.env.PORT ?? 3000);
const backend = createBackend();

// Gemini on Vertex AI when VERTEX_PROJECT is set (needs GOOGLE_APPLICATION_CREDENTIALS, a service account key file),
// otherwise OpenRouter. Without either, the agent runs on its rules alone.
const vertexProject = process.env.VERTEX_PROJECT;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const models = vertexProject
  ? modelsFromEnv(process.env.VERTEX_MODEL, VERTEX_MODELS)
  : modelsFromEnv(process.env.OPENROUTER_MODEL);
const llm = vertexProject
  ? createLlm(vertexToken(), models, vertexUrl(vertexProject))
  : openRouterKey
    ? createLlm(openRouterKey, models)
    : undefined;

// The connection that currently owns each call. A call that reconnects replaces its old connection.
const activeCalls = new Map<string, Call>();

Bun.serve<SocketData>({
  port,
  routes: { "/": index },
  fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const sessionId = url.searchParams.get("session") ?? crypto.randomUUID();
      if (server.upgrade(request, { data: { sessionId } })) return;
    }
    if (url.pathname === "/api/bookings") return Response.json([...backend.bookings.values()]);

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { sessionId } = ws.data;
      activeCalls.get(sessionId)?.end();
      ws.data.call = startCall(ws, sessionId, { backend, llm, deepgramKey });
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
  ["Brain", llm ? `${models[0]} (+${models.length - 1} backups)` : "fixed replies only (set VERTEX_PROJECT or OPENROUTER_API_KEY)"],
  ["Voice", "Deepgram aura-2"],
  ["Booking system", "demo courier backend"],
]);
