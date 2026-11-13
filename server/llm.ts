import { createSign } from "node:crypto";

export type ChatTurn ={ role: "user" | "assistant"; content: string };
// onText, when given, streams the answer: it is called with everything received so far, so speech can start on the
// first finished sentence instead of waiting for the whole answer.
export type Llm = (system: string, turns: ChatTurn[], onText?: (soFar: string) => void) => Promise<string>;

// The whole answer must arrive within this, or the agent carries on without it.
const TIMEOUT_MS = 4500;
// One model gets this long to start answering before the next one is tried. Once it is streaming, it may finish.
const PER_MODEL_MS = 2200;
const MAX_TOKENS = 160;
// A model that says it is rate limited is skipped for this long.
const COOL_DOWN_MS = 60_000;

// Free models are rate limited and sometimes slow, so they are tried one after another, fastest first, each with a
// short time limit. Asking them all at once would use up the free quota several times faster.
// Reasoning is switched off: it adds seconds and can use up the whole token budget before any answer is written.
// apiKey may be a function, for short-lived tokens such as Vertex AI's. url is any OpenAI-compatible chat endpoint.
// The answer is a JSON object with these fields, in this order, so "action" is known from the first few tokens and the
// reply can be spoken while it is still being written.
export const TURN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["yes", "no", "slot", "goodbye", "ignore", "say"] },
    reply: { type: "string" },
    slot: { type: "integer" },
  },
  required: ["action", "reply", "slot"],
};

// Full Gemini Flash and Pro think before answering unless told not to, which costs seconds on a phone call.
const thinksByDefault = (model: string) => /gemini-[\d.]+-(flash|pro)$/.test(model);

export function createLlm(
  apiKey: string | (() => Promise<string>),
  models: string[],
  url = "https://openrouter.ai/api/v1/chat/completions",
): Llm {
  const restingUntil = new Map<string, number>();

  return async (system, turns, onText) => {
    const deadline = Date.now() + TIMEOUT_MS;
    const failures: string[] = [];
    const ready = models.filter((model) => (restingUntil.get(model) ?? 0) < Date.now());

    for (const model of ready.length ? ready : models) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) break;
      // Waits PER_MODEL_MS for the first words, then up to the overall deadline for the rest.
      const abort = new AbortController();
      const startTimer = setTimeout(() => abort.abort(new Error("no answer in time")), Math.min(PER_MODEL_MS, timeLeft));
      const endTimer = setTimeout(() => abort.abort(new Error("answer took too long")), timeLeft);
      try {
        const token = typeof apiKey === "string" ? apiKey : await apiKey();
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            temperature: 0.2,
            stream: Boolean(onText),
            ...(thinksByDefault(model) ? { reasoning_effort: "minimal" } : { reasoning: { enabled: false } }),
            response_format: { type: "json_schema", json_schema: { name: "turn", schema: TURN_SCHEMA } },
            messages: [{ role: "system", content: system }, ...turns],
          }),
          signal: abort.signal,
        });
        if (response.status === 429) restingUntil.set(model, Date.now() + COOL_DOWN_MS);
        if (!response.ok) throw new Error(`answered ${response.status}`);
        const answer = onText ? await readStream(response, onText, () => clearTimeout(startTimer)) : await readWhole(response);
        if (!answer) throw new Error("empty answer");
        return answer;
      } catch (error) {
        failures.push(`${model.split("/").pop()}: ${(error as Error).message}`);
        // Words already went out to the caller, so another model must not answer the same turn again.
        if ((error as { spoke?: boolean }).spoke) break;
      } finally {
        clearTimeout(startTimer);
        clearTimeout(endTimer);
      }
    }
    throw new Error(failures.length ? failures.join(", ") : "no model answered in time");
  };
}

async function readWhole(response: Response): Promise<string | undefined> {
  const data = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
  return data.choices?.[0]?.message?.content?.trim();
}

// Server-sent events: "data: {json}" lines, each with the next piece of the answer.
async function readStream(response: Response, onText: (soFar: string) => void, onFirst: () => void): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  try {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const data = line.replace(/^data:\s*/, "").trim();
        if (!line.startsWith("data:") || !data || data === "[DONE]") continue;
        const piece = (JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[] }).choices?.[0]?.delta?.content;
        if (!piece) continue;
        if (!text) onFirst();
        text += piece;
        onText(text);
      }
    }
  } catch (error) {
    if (text) Object.assign(error as object, { spoke: true });
    throw error;
  }
  return text.trim();
}

// Gemini on Vertex AI through its OpenAI-compatible endpoint, billed to the Google Cloud project. Full Flash with minimal
// thinking is the smartest model that still starts answering in about 1.3 s; Flash-Lite is the faster backup.
export const VERTEX_MODELS = ["google/gemini-3.5-flash", "google/gemini-3.1-flash-lite"];
export const vertexUrl = (project: string) =>
  `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/endpoints/openapi/chat/completions`;

// Signs in as the service account in the key file at GOOGLE_APPLICATION_CREDENTIALS and reuses the token until a
// minute before it expires. Locally, GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token) works too.
export function vertexToken(): () => Promise<string> {
  let token = "";
  let expiresAt = 0;
  return async () => {
    if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
    if (Date.now() < expiresAt) return token;
    const account = await Bun.file(process.env.GOOGLE_APPLICATION_CREDENTIALS!).json();
    const now = Math.floor(Date.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!response.ok) throw new Error(`token ${response.status} ${(await response.text()).slice(0, 120)}`);
    const data = (await response.json()) as { access_token: string; expires_in: number };
    token = data.access_token;
    expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return token;
  };
}

// "a,b,c" from the environment, with a default list of free OpenRouter models that were checked to answer quickly.
export function modelsFromEnv(value: string | undefined, fallback = DEFAULT_MODELS): string[] {
  const list = (value ?? "").split(",").map((model) => model.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

const DEFAULT_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "cohere/north-mini-code:free",
];
