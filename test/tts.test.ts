import { afterEach, expect, test } from "bun:test";
import { createSpeaker, synthesize, TTS_SAMPLE_RATE } from "../server/tts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Fakes Deepgram: records the request and streams back the given chunks.
function fakeDeepgram(chunks: number[]) {
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(1));
        controller.close();
      },
    });
    return new Response(stream);
  }) as typeof fetch;
  return requests;
}

async function speak() {
  const out: Uint8Array[] = [];
  for await (const chunk of synthesize("Shall I book that?", new AbortController().signal)) out.push(chunk);
  return out;
}

test("asks Deepgram for raw 24 kHz PCM from an Aura-2 voice", async () => {
  const requests = fakeDeepgram([480]);
  await speak();
  const url = new URL(requests[0]!.url);
  expect(url.searchParams.get("model")).toStartWith("aura-2-");
  expect(url.searchParams.get("encoding")).toBe("linear16");
  expect(url.searchParams.get("sample_rate")).toBe(String(TTS_SAMPLE_RATE));
  expect(url.searchParams.get("container")).toBe("none");
  expect(requests[0]!.body.text).toBe("Shall I book that?");
});

test("never splits a 16-bit sample across chunks, and loses no audio", async () => {
  fakeDeepgram([3, 5, 1, 7]);
  const out = await speak();
  expect(out.every((chunk) => chunk.length % 2 === 0)).toBe(true);
  expect(out.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(16);
});

test("a failed request is an error, not silence", async () => {
  globalThis.fetch = (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
  expect(speak()).rejects.toThrow("speech error 429");
});

// A stand-in for Deepgram's speech socket that the test drives by hand.
class FakeSocket {
  binaryType = "";
  sent: any[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number }) => void;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  audio(size: number) {
    this.onmessage?.({ data: new Uint8Array(size).buffer });
  }
  flushed() {
    this.onmessage?.({ data: JSON.stringify({ type: "Flushed" }) });
  }
}

function fakeSpeaker() {
  const sockets: FakeSocket[] = [];
  const speaker = createSpeaker("key", () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { speaker, sockets };
}

async function collect(chunks: AsyncGenerator<Uint8Array>) {
  let bytes = 0;
  for await (const chunk of chunks) bytes += chunk.length;
  return bytes;
}

test("speaks over HTTP while the socket is still opening, then over the socket", async () => {
  const requests = fakeDeepgram([480]);
  const { speaker, sockets } = fakeSpeaker();
  expect(await collect(speaker.synthesize("Hi.", new AbortController().signal))).toBe(480);
  expect(requests.length).toBe(1);

  sockets[0]!.onopen!();
  const reply = collect(speaker.synthesize("Shall I book that?", new AbortController().signal));
  await Bun.sleep(0);
  expect(sockets[0]!.sent).toEqual([{ type: "Speak", text: "Shall I book that?" }, { type: "Flush" }]);
  sockets[0]!.audio(200);
  sockets[0]!.audio(100);
  sockets[0]!.flushed();
  expect(await reply).toBe(300);
  expect(requests.length).toBe(1);
  speaker.close();
});

test("an interrupted sentence drops its socket, so its leftover audio never reaches the next sentence", async () => {
  fakeDeepgram([480]);
  const { speaker, sockets } = fakeSpeaker();
  sockets[0]!.onopen!();
  const interrupt = new AbortController();
  const cut = collect(speaker.synthesize("A long answer.", interrupt.signal));
  await Bun.sleep(0);
  sockets[0]!.audio(200);
  interrupt.abort();
  expect(cut).rejects.toThrow();
  expect(sockets[0]!.closed).toBe(true);
  expect(sockets.length).toBe(2);

  sockets[1]!.onopen!();
  const next = collect(speaker.synthesize("Go ahead.", new AbortController().signal));
  await Bun.sleep(0);
  sockets[0]!.audio(999);
  sockets[1]!.audio(100);
  sockets[1]!.flushed();
  expect(await next).toBe(100);
  speaker.close();
});

test("a socket that fails before any audio falls back to HTTP for that sentence", async () => {
  const requests = fakeDeepgram([480]);
  const { speaker, sockets } = fakeSpeaker();
  sockets[0]!.onopen!();
  const reply = collect(speaker.synthesize("Hello.", new AbortController().signal));
  await Bun.sleep(0);
  sockets[0]!.onmessage!({ data: JSON.stringify({ type: "Error", description: "busy" }) });
  expect(await reply).toBe(480);
  expect(requests.length).toBe(1);
  speaker.close();
});
