import { expect, test } from "bun:test";
import { matchIntent } from "../server/intents";

const name = (text: string) => matchIntent(text)?.name;

test("recognizes the common off-topic requests", () => {
  expect(name("who am I talking to")).toBe("identity");
  expect(name("what's your name")).toBe("identity");
  expect(name("are you a robot")).toBe("robot");
  expect(name("can I speak to a real person")).toBe("human");
  expect(name("where is my parcel right now")).toBe("parcel status");
  expect(name("I want to change the address")).toBe("address");
  expect(name("how much does this cost")).toBe("price");
  expect(name("cancel my delivery")).toBe("cancel or refund");
  expect(name("how does this work")).toBe("how it works");
});

test("recognizes requests to pause, repeat and stop", () => {
  expect(name("hold on a second")).toBe("wait");
  expect(name("give me a moment I need to find it")).toBe("wait");
  expect(name("sorry what did you say")).toBe("repeat");
  expect(name("can you say that again")).toBe("repeat");
  expect(name("never mind goodbye")).toBe("goodbye");
});

test("small talk and thanks", () => {
  expect(name("thank you")).toBe("thanks");
  expect(name("hello")).toBe("greeting");
});

test("anything else is not an intent", () => {
  expect(name("the weather is nice today")).toBeUndefined();
  expect(name("B as in Bravo")).toBeUndefined();
});

test("answers never claim things the agent cannot know", () => {
  for (const text of ["where is my parcel", "how much is it", "change the address", "cancel my order"]) {
    expect(matchIntent(text)?.reply).toMatch(/can't|cannot|not able/);
  }
});
