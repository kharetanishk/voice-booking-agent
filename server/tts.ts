// Turns text into speech with Deepgram Aura-2: 24 kHz PCM16, streamed as it is generated.

export const TTS_SAMPLE_RATE = 24000;

async function* body(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`speech error ${response.status}`);
  for await (const chunk of response.body) yield chunk;
}

function deepgram(text: string, signal: AbortSignal) {
  const params = new URLSearchParams({
    model: "aura-2-thalia-en",
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

export async function* synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  yield* wholeSamples(await deepgram(text, signal));
}
