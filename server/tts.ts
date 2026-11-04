// Turns text into speech with Deepgram Aura-2: 24 kHz PCM16, streamed as it is generated.

export const TTS_SAMPLE_RATE = 24000;
const MODEL = "aura-2-thalia-en";

export type Synthesize = (text: string, signal: AbortSignal) => AsyncGenerator<Uint8Array>;

async function* body(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`speech error ${response.status}`);
  for await (const chunk of response.body) yield chunk;
}

function deepgram(text: string, signal: AbortSignal) {
  const params = new URLSearchParams({
    model: MODEL,
    encoding: "linear16",
    sample_rate: String(TTS_SAMPLE_RATE),
    container: "none",
  });
  return fetch(`https://api.deepgram.com/v1/speak?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  }).then(body);
}

// Each chunk must hold whole 16-bit samples, so a split sample is carried to the next chunk.
async function* wholeSamples(source: AsyncIterable<Uint8Array>) {
  let leftover = new Uint8Array(0);
  for await (const chunk of source) {
    const joined = new Uint8Array(leftover.length + chunk.length);
    joined.set(leftover);
    joined.set(chunk, leftover.length);
    const even = joined.length - (joined.length % 2);
    leftover = joined.slice(even);
    if (even) yield joined.slice(0, even);
  }
}

// One HTTP request per sentence. Used when the speech socket is not available.
export async function* synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  yield* wholeSamples(await deepgram(text, signal));
}

// Opening a connection to Deepgram costs two round trips (TCP and TLS) before any audio, about 0.5 s from India.
// HTTP connections are dropped after about 4 s idle, which is shorter than almost every pause between turns, so a
// fresh connection per reply cost ~800 ms to first audio. One socket per call, opened while the greeting plays,
// stays open across turns and brings that to ~350 ms.
const OPEN_TIMEOUT_MS = 3000;

type Listener = { push: (chunk: Uint8Array) => void; finish: () => void; fail: (error: Error) => void };
export type Connect = (url: string, apiKey: string) => WebSocket;

const connectDeepgram: Connect = (url, apiKey) =>
  new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } } as unknown as string[]);

// Sentences go through the socket one at a time (the call queues them). Speak + Flush sends one sentence, and
// "Flushed" marks the end of its audio. The socket opens when the call starts; anything said before it is ready
// (usually the greeting) goes over HTTP instead of waiting. An interrupted sentence closes its socket, so leftover
// audio can never leak into the next sentence, and a fresh socket opens at once for the next reply.
export function createSpeaker(apiKey: string, connect: Connect = connectDeepgram) {
  const url = `wss://api.deepgram.com/v1/speak?${new URLSearchParams({
    model: MODEL,
    encoding: "linear16",
    sample_rate: String(TTS_SAMPLE_RATE),
  })}`;
  let live: WebSocket | undefined;
  let opening: WebSocket | undefined;
  let listener: Listener | undefined;
  let closed = false;

  function open() {
    if (closed || opening) return;
    const ws = connect(url, apiKey);
    opening = ws;
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => ws.close(), OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      if (opening === ws) opening = undefined;
      if (closed) return ws.close();
      live = ws;
    };
    ws.onmessage = (event) => {
      if (ws !== live) return;
      if (typeof event.data !== "string") return listener?.push(new Uint8Array(event.data as ArrayBuffer));
      const message = JSON.parse(event.data) as { type: string; description?: string };
      if (message.type === "Flushed") listener?.finish();
      else if (message.type === "Error") listener?.fail(new Error(`speech socket: ${message.description ?? "error"}`));
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      if (opening === ws) opening = undefined;
      if (live !== ws) return;
      live = undefined;
      listener?.fail(new Error(`speech socket closed (${event.code})`));
    };
  }

  // Drops the current socket (and any audio still on its way) and starts a new one.
  function reset() {
    const old = live;
    live = undefined;
    old?.close();
    open();
  }

  async function* overSocket(ws: WebSocket, text: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let done = false;
    let error: Error | undefined;
    let wake = () => {};
    listener = {
      push: (chunk) => (chunks.push(chunk), wake()),
      finish: () => ((done = true), wake()),
      fail: (failure) => ((error = failure), wake()),
    };
    const onAbort = () => {
      listener?.fail(new Error("aborted"));
      reset();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      ws.send(JSON.stringify({ type: "Speak", text }));
      ws.send(JSON.stringify({ type: "Flush" }));
      while (true) {
        if (chunks.length) yield chunks.shift()!;
        else if (error) throw error;
        else if (done) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      listener = undefined;
    }
  }

  open();

  return {
    async *synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
      if (!live) {
        open();
        yield* synthesize(text, signal);
        return;
      }
      let started = false;
      try {
        for await (const chunk of wholeSamples(overSocket(live, text, signal))) {
          started = true;
          yield chunk;
        }
      } catch (error) {
        if (started || signal.aborted) throw error;
        // The socket failed before any audio: say this sentence over HTTP and open a new socket for the next one.
        reset();
        yield* synthesize(text, signal);
      }
    },
    close() {
      closed = true;
      live?.close();
      opening?.close();
      live = opening = undefined;
    },
  };
}
