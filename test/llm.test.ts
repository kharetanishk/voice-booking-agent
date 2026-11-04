import { afterEach, expect, test } from "bun:test";
import { createLlm } from "../server/llm";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Fakes OpenRouter: each model answers with the given status and text.
function fakeOpenRouter(answers: Record<string, [number, string]>) {
  const asked: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const { model } = JSON.parse(String(init.body));
    asked.push(model);
    const [status, content] = answers[model]!;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as typeof fetch;
  return asked;
}

test("tries the next model when one is rate limited or answers with nothing", async () => {
  const asked = fakeOpenRouter({ a: [429, ""], b: [200, ""], c: [200, "YES"] });
  const llm = createLlm("key", ["a", "b", "c"]);
  expect(await llm("system", [])).toBe("YES");
  expect(asked).toEqual(["a", "b", "c"]);
});

test("a rate limited model is skipped on the next request", async () => {
  const asked = fakeOpenRouter({ a: [429, ""], b: [200, "NO"] });
  const llm = createLlm("key", ["a", "b"]);
  await llm("system", []);
  asked.length = 0;
  await llm("system", []);
  expect(asked).toEqual(["b"]);
});

test("stops at the first good answer, so the free quota is not wasted", async () => {
  const asked = fakeOpenRouter({ a: [200, "YES"], b: [200, "NO"] });
  const llm = createLlm("key", ["a", "b"]);
  expect(await llm("system", [])).toBe("YES");
  expect(asked).toEqual(["a"]);
});

test("says why when every model fails", async () => {
  fakeOpenRouter({ a: [500, ""], b: [429, ""] });
  const llm = createLlm("key", ["a", "b"]);
  expect(llm("system", [])).rejects.toThrow(/a: answered 500, b: answered 429/);
});

test("asks the given endpoint with the key", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  }) as typeof fetch;
  const llm = createLlm("tok", ["a"], "https://gemini.example/chat");
  expect(await llm("system", [])).toBe("OK");
  expect(seen).toEqual(["https://gemini.example/chat Bearer tok"]);
});
