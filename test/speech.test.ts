import { expect, test } from "bun:test";
import { isInterruption, isRelevant, wantsNewId } from "../server/speech";

const agent = "Let me read that back. B as in Bravo, D as in Delta, 4 1 8 2 0 7. Is that correct?";

test("a short answer interrupts", () => {
  expect(isInterruption("yes", agent, "CONFIRM_ID")).toBe(true);
  expect(isInterruption("no, not D", agent, "CONFIRM_ID")).toBe(true);
});

test("a correction that reuses the agent's words interrupts only if it adds words of its own", () => {
  expect(isInterruption("B as in Bravo", "B as in Bravo, D as in Delta", "CONFIRM_ID")).toBe(false);
  expect(isInterruption("no B as in Bravo not D", agent, "CONFIRM_ID")).toBe(true);
});

test("filler sounds do not interrupt", () => {
  expect(isInterruption("um", agent, "CONFIRM_ID")).toBe(false);
  expect(isInterruption("uh hmm", agent, "CONFIRM_ID")).toBe(false);
  expect(isInterruption("", agent, "CONFIRM_ID")).toBe(false);
});

test("the agent's own voice coming back through the mic is not an interruption", () => {
  expect(isInterruption("let me read that back", agent, "CONFIRM_ID")).toBe(false);
  expect(isInterruption("is that correct", agent, "CONFIRM_ID")).toBe(false);
});

test("people talking in the background do not interrupt", () => {
  expect(isInterruption("did you see the game last night", agent, "CONFIRM_ID")).toBe(false);
  expect(isInterruption("we should leave around six tomorrow", agent, "CONFIRM_ID")).toBe(false);
  expect(isInterruption("I told him the meeting moved", agent, "ASK_ID")).toBe(false);
});

test("a doubtful transcript does not interrupt, even if it sounds relevant", () => {
  expect(isInterruption("yes", agent, "CONFIRM_ID", 0.3)).toBe(false);
  expect(isInterruption("yes", agent, "CONFIRM_ID", 0.9)).toBe(true);
});

test("what counts as relevant depends on the step", () => {
  expect(isInterruption("the second one", "I can offer first, second, third", "OFFER_SLOTS")).toBe(true);
  expect(isInterruption("saturday afternoon", "I can offer first, second, third", "OFFER_SLOTS")).toBe(true);
  expect(isInterruption("B D four one", "Please say your tracking ID", "ASK_ID")).toBe(true);
  expect(isInterruption("saturday afternoon", "Please say your tracking ID", "ASK_ID")).toBe(false);
});

test("a question to the agent interrupts", () => {
  expect(isInterruption("who am I talking to", agent, "CONFIRM_ID")).toBe(true);
  expect(isInterruption("can I speak to a person", agent, "CONFIRM_ID")).toBe(true);
});

test("ordinary talk that happens to contain words like not or right is not relevant", () => {
  expect(isRelevant("it was unbelievable I could not believe the score", "ASK_ID")).toBe(false);
  expect(isRelevant("right so we can go ahead and plan the weekend", "ASK_ID")).toBe(false);
  expect(isRelevant("no not D", "CONFIRM_ID")).toBe(true);
  expect(isRelevant("no, B as in Bravo, not D", "CONFIRM_ID")).toBe(true);
});

test("short answers and hold-ons are relevant", () => {
  expect(isRelevant("hold on a second", "ASK_ID")).toBe(true);
  expect(isRelevant("I do not understand", "ASK_ID")).toBe(true);
  expect(isRelevant("help", "ASK_ID")).toBe(true);
});

test("recognizes a wish to change the tracking ID", () => {
  for (const text of [
    "I want to change the tracking ID",
    "I want to change the whole tracking ID",
    "the tracking number is wrong",
    "that's not my tracking ID",
    "I gave you the wrong ID",
    "it's a different parcel",
    "can I use another tracking number",
  ]) {
    expect(wantsNewId(text)).toBe(true);
  }
});

test("other changes are not mistaken for a new tracking ID", () => {
  for (const text of ["change the address", "I want to change the slot", "the second one", "yes that is correct", "can you change the delivery to Tuesday"]) {
    expect(wantsNewId(text)).toBe(false);
  }
});

test("a new ID or a request to change it counts as relevant at every step", () => {
  expect(isRelevant("I want to change the tracking ID", "OFFER_SLOTS")).toBe(true);
  expect(isRelevant("A as in Alpha, K as in Kilo, five five two zero one nine", "CONFIRM_SLOT")).toBe(true);
  expect(isRelevant("we should leave around six tomorrow", "OFFER_SLOTS")).toBe(true);
  expect(isRelevant("we should leave around six tomorrow", "DONE")).toBe(false);
});

test("a word said over and over is still a short answer", () => {
  expect(isRelevant("wait wait wait wait wait wait wait", "OFFER_SLOTS")).toBe(true);
});

test("anything about the delivery is for the agent, however long", () => {
  expect(isRelevant("i don't want to tell you my tracking id what's the weather outside", "ASK_ID")).toBe(true);
  expect(isRelevant("when exactly will the courier come to my house tomorrow", "OFFER_SLOTS")).toBe(true);
});

test("talk about a place in the ID is relevant, and so is telling the agent to stop", async () => {
  const { isRelevant } = await import("../server/speech");
  expect(isRelevant("the last digit is five", "CONFIRM_ID")).toBe(true);
  expect(isRelevant("no the last digit should be five", "CONFIRM_ID")).toBe(true);
  expect(isRelevant("shut up", "ASK_ID")).toBe(true);
  expect(isRelevant("we should leave around six tomorrow", "ASK_ID")).toBe(false);
});
