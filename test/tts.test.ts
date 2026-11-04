import { afterEach, expect, test } from "bun:test";
import { synthesize, TTS_SAMPLE_RATE } from "../server/tts";

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
