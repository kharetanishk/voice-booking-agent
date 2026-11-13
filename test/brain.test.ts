import { expect, test } from "bun:test";
import { handleTurn } from "../server/brain";
import { createBackend, type Mode } from "../server/fakeBackend";
import type { Llm } from "../server/llm";
import { newSession } from "../server/session";

const fast = { retries: 2, timeoutMs: 30, backoffMs: 1, waitFirstMs: 10, waitEveryMs: 1000 };
const FULL_ID = "B as in Bravo, D as in Delta, four one eight two zero seven";

function setup(script: Mode[] = [], llm?: Llm, timing = fast) {
  const backend = createBackend({ normalMs: 1, slowMs: 60, failMs: 1 });
  backend.forced = "ok";
  backend.script = script;
  const said: string[] = [];
  const session = newSession("test");
  const deps = { backend, say: (text: string) => said.push(text), log: () => {}, llm, timing };
  const talk = async (...lines: string[]) => {
    for (const line of lines) await handleTurn(session, line, deps);
  };
  return { backend, session, said, talk };
}

test("books a delivery on the happy path", async () => {
  const { backend, session, said, talk } = setup();
  await talk(FULL_ID, "yes", "the second one", "yes");
  expect(session.stage).toBe("DONE");
  expect(backend.bookings.size).toBe(1);
  expect(said.at(-1)).toContain("You're all set");
});

test("collects the ID over several turns", async () => {
  const { session, talk } = setup();
  await talk("B as in Bravo, D as in Delta, four one");
  expect(session.stage).toBe("ASK_ID");
  expect(session.trackingId).toBe("BD41");
  await talk("eight two zero seven");
  expect(session.stage).toBe("CONFIRM_ID");
});

test("keeps the digits and asks only for the letters when a letter was missed", async () => {
  const { session, said, talk } = setup();
  await talk("seasoned broccoli D as in Delta four one eight two zero seven");
  expect(session.trackingId).toBe("");
  expect(said.at(-1)).toContain("both letters");
  await talk("bravo delta");
  expect(session.stage).toBe("CONFIRM_ID");
  expect(session.trackingId).toBe("BD418207");
});

test("fixes one letter when the caller corrects it", async () => {
  const { session, said, talk } = setup();
  await talk("D as in Delta, D as in Delta, four one eight two zero seven");
  await talk("no, B as in Bravo, not D");
  expect(session.trackingId).toBe("BD418207");
  expect(said.at(-1)).toContain("B as in Bravo");
  expect(session.stage).toBe("CONFIRM_ID");
});

test("does not move on from the ID without a yes", async () => {
  const { session, talk } = setup();
  await talk(FULL_ID, "hmm not sure");
  expect(session.stage).toBe("CONFIRM_ID");
});

test("never books without an explicit yes", async () => {
  const { backend, session, talk } = setup();
  await talk(FULL_ID, "yes", "the second one", "hmm maybe");
  expect(session.stage).toBe("CONFIRM_SLOT");
  expect(backend.bookings.size).toBe(0);
});

test("a caller who changes their mind is asked to confirm the new slot", async () => {
  const { backend, session, talk } = setup();
  await talk(FULL_ID, "yes", "the first one");
  const other = session.slots[4]!;
  await talk(`actually ${other.day} ${other.period}`);
  expect(session.chosenSlotId).toBe(other.id);
  expect(backend.bookings.size).toBe(0);
  await talk("yes");
  expect([...backend.bookings.values()][0]!.slotId).toBe(other.id);
});

test("a lost reply when booking does not double-book", async () => {
  const { backend, session, talk } = setup();
  await talk(FULL_ID, "yes", "the second one");
  backend.script = ["lostack", "ok"];
  await talk("yes");
  expect(session.stage).toBe("DONE");
  expect(backend.bookings.size).toBe(1);
});

test("a failed booking is reported honestly and can be retried", async () => {
  const { backend, session, said, talk } = setup();
  await talk(FULL_ID, "yes", "the second one");
  backend.script = ["fail", "fail", "fail", "ok"];
  await talk("yes");
  expect(said.at(-1)).toContain("nothing's been booked");
  expect(session.stage).toBe("CONFIRM_SLOT");
  expect(backend.bookings.size).toBe(0);
  await talk("yes");
  expect(session.stage).toBe("DONE");
  expect(backend.bookings.size).toBe(1);
});

test("an unreachable backend leaves the outcome unknown and checking again is safe", async () => {
  const { backend, session, said, talk } = setup();
  await talk(FULL_ID, "yes", "the second one");
  backend.script = ["lostack", "lostack", "lostack", "fail", "fail"];
  await talk("yes");
  expect(session.stage).toBe("BOOKING");
  expect(said.at(-1)).toContain("don't want to book it twice");
  await talk("yes");
  expect(session.stage).toBe("DONE");
  expect(backend.bookings.size).toBe(1);
});

test("keeps talking while the slot lookup fails, then recovers", async () => {
  const { backend, session, said, talk } = setup();
  await talk(FULL_ID);
  backend.script = ["fail", "fail", "fail"];
  await talk("yes");
  expect(said.at(-1)).toContain("trouble reaching");
  expect(session.slots.length).toBe(0);
  await talk("yes");
  expect(session.slots.length).toBeGreaterThan(0);
});

test("tells the caller to wait while the backend is slow", async () => {
  const { backend, session, said, talk } = setup([], undefined, { ...fast, timeoutMs: 200 });
  await talk(FULL_ID, "yes", "the second one");
  backend.script = ["slow"];
  await talk("yes");
  expect(said.some((line) => line.includes("Just a sec"))).toBe(true);
  expect(session.stage).toBe("DONE");
});

test("answers a side question with the LLM, then repeats what it needs", async () => {
  const llm: Llm = async () => "I can only help with rescheduling.";
  const { said, talk } = setup([], llm);
  await talk("what is the weather like");
  expect(said.at(-1)).toContain("I can only help with rescheduling.");
  expect(said.at(-1)).toContain("tracking ID");
});

test("still replies when the LLM fails", async () => {
  const llm: Llm = async () => {
    throw new Error("down");
  };
  const { said, talk } = setup([], llm);
  await talk("purple banana window");
  expect(said.at(-1)).toContain("didn't catch that");
});

test("start over resets the call", async () => {
  const { session, talk } = setup();
  await talk(FULL_ID, "yes", "start over");
  expect(session.stage).toBe("ASK_ID");
  expect(session.trackingId).toBe("");
});

const neverCalled: Llm = async () => {
  throw new Error("the LLM should not be needed for this");
};

test("who are you is answered from rules, without the LLM, then the agent asks again", async () => {
  const { said, talk } = setup([], neverCalled);
  await talk("wait, who am I talking to?");
  expect(said.at(-1)).toContain("automated assistant");
  expect(said.at(-1)).toContain("tracking ID");
});

test("a request for a human is answered honestly", async () => {
  const { said, talk } = setup([], neverCalled);
  await talk("can I speak to a real person");
  expect(said.at(-1)).toContain("not able to transfer");
});

test("questions the agent cannot answer are not made up", async () => {
  const { said, talk } = setup([], neverCalled);
  await talk("where is my parcel right now");
  expect(said.at(-1)).toMatch(/can't see where your parcel/);
  await talk("how much does this cost");
  expect(said.at(-1)).toMatch(/can.t quote/);
});

test("hold on makes the agent wait quietly", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk("hold on a second, let me find it");
  expect(said.at(-1)).toContain("take your time");
  expect(session.holdUntil!).toBeGreaterThan(Date.now());
});

test("repeat says the last thing again without piling up", async () => {
  const { session, said, talk } = setup();
  session.lastSaid = "Please say your tracking ID.";
  await talk("sorry, can you repeat that");
  await talk("say that again");
  expect(said.at(-1)).toBe("Sure. Please say your tracking ID.");
});

test("goodbye ends the call", async () => {
  const { session, talk } = setup();
  await talk("never mind, goodbye");
  expect(session.stage).toBe("DONE");
});

test("the LLM sees the conversation so far, and its answer is cleaned up", async () => {
  let seen: { role: string; content: string }[] = [];
  const llm: Llm = async (_system, turns) => {
    seen = turns;
    return "**Sure thing!** It is a quick call. Second sentence. Third sentence.";
  };
  const { said, talk } = setup([], llm);
  await talk("what is the weather like");
  expect(seen.at(-1)).toEqual({ role: "user", content: "what is the weather like" });
  expect(said.at(-1)).toContain("Sure thing! It is a quick call.");
  expect(said.at(-1)).not.toContain("*");
  expect(said.at(-1)).not.toContain("Third sentence");
});

test("the LLM can say a remark was not meant for the agent, and then the agent stays quiet", async () => {
  const llm: Llm = async () => "IGNORE";
  const { said, talk } = setup([], llm);
  await talk("I told him we would be there by six");
  expect(said.length).toBe(0);
});

test("a yes buried in a long sentence does not confirm anything", async () => {
  const { session, talk } = setup();
  await talk(FULL_ID, "yes I think so but let me check with my wife first");
  expect(session.stage).toBe("CONFIRM_ID");
});

test("people talking in the background do not change the ID", async () => {
  const { session, talk } = setup();
  await talk("B as in Bravo, D as in Delta, four one");
  await talk("I will be there in one hour");
  expect(session.trackingId).toBe("BD41");
});

test("an LLM answer that asks its own question is trimmed so the caller is not asked twice", async () => {
  const llm: Llm = async () => "I can only help reschedule your delivery. Please give me your tracking ID. Is that okay?";
  const { said, talk } = setup([], llm);
  await talk("what is the capital of France");
  const answer = said.at(-1)!;
  expect(answer).toStartWith("I can only help reschedule your delivery.");
  expect(answer.match(/tracking ID/gi)?.length).toBe(1);
});

test("an LLM answer made only of questions falls back to the fixed reply", async () => {
  const llm: Llm = async () => "Could you tell me your tracking ID?";
  const { said, talk } = setup([], llm);
  await talk("what is the capital of France");
  expect(said.at(-1)).toContain("I can only help with rescheduling");
});

const OTHER_ID = "A as in Alpha, K as in Kilo, five five two zero one nine";

test("the ID is only confirmed after the caller says yes to it", async () => {
  const { session, talk } = setup();
  await talk(FULL_ID);
  expect(session.trackingId).toBe("BD418207");
  expect(session.idConfirmed).toBe(false);
  await talk("yes");
  expect(session.idConfirmed).toBe(true);
});

test("a new ID said after the old one was confirmed has to be confirmed again", async () => {
  const { session, said, talk } = setup();
  await talk(FULL_ID, "yes");
  expect(session.stage).toBe("OFFER_SLOTS");

  await talk(OTHER_ID);
  expect(session.trackingId).toBe("AK552019");
  expect(session.idConfirmed).toBe(false);
  expect(session.stage).toBe("CONFIRM_ID");
  expect(session.slots).toEqual([]);
  expect(said.at(-1)).toContain("different ID");

  await talk("yes");
  expect(session.idConfirmed).toBe(true);
  expect(session.stage).toBe("OFFER_SLOTS");
});

test("a new ID after a slot was picked drops the slot, and nothing is booked until everything is confirmed again", async () => {
  const { backend, session, talk } = setup();
  await talk(FULL_ID, "yes", "the second one");
  expect(session.stage).toBe("CONFIRM_SLOT");

  await talk(OTHER_ID);
  expect(session.chosenSlotId).toBeUndefined();
  expect(session.confirmedSlotId).toBeUndefined();
  expect(backend.bookings.size).toBe(0);

  await talk("the second one");
  expect(session.stage).toBe("CONFIRM_ID");
  expect(backend.bookings.size).toBe(0);

  await talk("yes", "the second one", "yes");
  expect(session.stage).toBe("DONE");
  expect([...backend.bookings.keys()][0]).toStartWith("AK552019:");
});

test("saying you want to change the tracking ID starts the ID over", async () => {
  const { session, said, talk } = setup();
  await talk(FULL_ID, "yes", "I want to change the whole tracking ID");
  expect(session.idConfirmed).toBe(false);
  expect(session.slots).toEqual([]);
  expect(said.at(-1)).toContain("which part to change");

  await talk(OTHER_ID);
  expect(session.trackingId).toBe("AK552019");
  expect(session.stage).toBe("CONFIRM_ID");
});

test("the new ID can be given in the same sentence as the request to change it", async () => {
  const { session, said, talk } = setup();
  await talk(FULL_ID, "yes", `actually I want to change the tracking ID to ${OTHER_ID}`);
  expect(session.trackingId).toBe("AK552019");
  expect(session.stage).toBe("CONFIRM_ID");
  expect(said.at(-1)).toContain("Is that right");
});

test("saying the ID is wrong while it is being confirmed asks for a new one", async () => {
  const { session, said, talk } = setup();
  await talk(FULL_ID, "no, that tracking ID is wrong");
  expect(said.at(-1)).toContain("which part to change");
  await talk(OTHER_ID);
  expect(session.trackingId).toBe("AK552019");
});

test("a correction made after the ID was confirmed changes it and asks again", async () => {
  const { session, talk } = setup();
  await talk(FULL_ID, "yes", "the third digit is 9");
  expect(session.trackingId).toBe("BD419207");
  expect(session.stage).toBe("CONFIRM_ID");
  expect(session.idConfirmed).toBe(false);
});

test("a completely different ID while confirming is called out as a different ID", async () => {
  const { session, said, talk } = setup();
  await talk(FULL_ID, OTHER_ID);
  expect(session.trackingId).toBe("AK552019");
  expect(said.at(-1)).toContain("different ID");
  expect(session.idConfirmed).toBe(false);
});

test("a one letter fix while confirming still says sorry about that", async () => {
  const { said, talk } = setup();
  await talk("D as in Delta, D as in Delta, four one eight two zero seven", "no, B as in Bravo, not D");
  expect(said.at(-1)).toContain("sorry about that");
});

test("a different ID said while the first one is still being collected replaces it", async () => {
  const { session, talk } = setup();
  await talk("B as in Bravo, D as in Delta, four one");
  expect(session.trackingId).toBe("BD41");
  await talk(OTHER_ID);
  expect(session.trackingId).toBe("AK552019");
  expect(session.stage).toBe("CONFIRM_ID");
});

test("after a booking is done a new ID starts a new request and the old booking stays", async () => {
  const { backend, session, said, talk } = setup();
  await talk(FULL_ID, "yes", "the second one", "yes");
  expect(session.stage).toBe("DONE");
  await talk("I have another parcel", OTHER_ID);
  expect(session.stage).toBe("CONFIRM_ID");
  expect(session.trackingId).toBe("AK552019");
  expect(backend.bookings.size).toBe(1);
  expect(said.at(-1)).toContain("Is that right");
});

test("a new ID that arrives garbled in two pieces is put together once both pieces are heard", async () => {
  const { session, talk } = setup();
  await talk(FULL_ID, "yes");
  await talk("a is in alpha k as in kilo five five two zero one nine");
  expect(session.trackingId).toBe("AK552019");
  expect(session.stage).toBe("CONFIRM_ID");
  expect(session.idConfirmed).toBe(false);
});

test("the start of a new ID after confirmation is collected like a fresh ID", async () => {
  const { session, said, talk } = setup();
  await talk(FULL_ID, "yes");
  await talk("k as in kilo five five two zero one nine");
  expect(session.stage).toBe("ASK_ID");
  expect(said.at(-1)).toContain("both letters");
  await talk(OTHER_ID);
  expect(session.stage).toBe("CONFIRM_ID");
  expect(session.trackingId).toBe("AK552019");
});

test("answers to the slot question are not mistaken for the start of an ID", async () => {
  const { session, talk } = setup();
  await talk(FULL_ID, "yes", "the second one");
  expect(session.stage).toBe("CONFIRM_SLOT");
  expect(session.trackingId).toBe("BD418207");
  expect(session.idConfirmed).toBe(true);
  await talk("actually saturday at four");
  expect(session.idConfirmed).toBe(true);
  expect(session.trackingId).toBe("BD418207");
});

test("a bare yes with nothing to confirm is not sent to the LLM", async () => {
  const { said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes", "yes");
  expect(said.at(-1)).toContain("not sure what you're answering");
  expect(said.at(-1)).toContain("Which works for you");
});

test("just the two letters of a new ID, said after confirmation, start collecting it", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes", "a as in alpha k as in kilo");
  expect(session.stage).toBe("ASK_ID");
  expect(session.trackingId).toBe("AK");
  expect(said.at(-1)).toContain("What comes next");
});

// The exact call from the log: the ID was fixed with "the last digit" style corrections.
test("the tracking ID is wrong, the last digit should be seven: fixes that digit instead of starting over", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk("A B nine zero nine five nine one", "yes");
  await talk("the tracking id is wrong the last digit should be seven");
  expect(session.trackingId).toBe("AB909597");
  expect(session.stage).toBe("CONFIRM_ID");
  expect(session.idConfirmed).toBe(false);
  expect(said.at(-1)).toContain("9 0 9 5 9 7");
});

test("a correction split over two breaths is put together: no the last two digits ... should be one three", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk("A B nine zero nine five nine seven");
  await talk("no the last two digit");
  expect(said.at(-1)).toContain("what should it be");
  await talk("should be one three");
  expect(session.trackingId).toBe("AB909513");
  expect(said.at(-1)).toContain("9 0 9 5 1 3");
  expect(said.at(-1)).not.toContain("9 0 9 5 9 7");
  await talk("yes");
  expect(session.idConfirmed).toBe(true);
});

test("position words: last, first, letters and digits", async () => {
  const { updateId } = await import("../server/trackingId");
  expect(updateId("BD418207", "the last digit is nine")).toBe("BD418209");
  expect(updateId("BD418207", "the last two digits are one three")).toBe("BD418213");
  expect(updateId("BD418207", "the first letter is c")).toBe("CD418207");
  expect(updateId("BD418207", "the last letter should be k")).toBe("BK418207");
  expect(updateId("BD418207", "the first two digits are 9 9")).toBe("BD998207");
});

test("ID characters the agent cannot place are never sent to the LLM", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "five three");
  expect(session.trackingId).toBe("BD418207");
  expect(said.at(-1)).toContain("couldn't tell which part");
});

test("an LLM answer that reads out letters or digits is not spoken", async () => {
  const llm: Llm = async () => "A as in Alpha, B as in Bravo, 9 0 9 5 1 3.";
  const { said, talk } = setup([], llm);
  await talk("purple banana window");
  expect(said.at(-1)).not.toContain("Alpha");
});

test("the ID is wrong, then the fix in the next breath: the fix applies to the current ID", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk("A B nine zero nine five nine one", "yes", "the tracking ID is wrong");
  expect(session.trackingId).toBe("AB909591");
  await talk("the last digit should be seven");
  expect(session.trackingId).toBe("AB909597");
  expect(said.at(-1)).toContain("Is that right");
});

test("two letters written as one word are read as letters", async () => {
  const { updateId } = await import("../server/trackingId");
  expect(updateId("", "ab nine zero nine five nine one")).toBe("AB909591");
  expect(updateId("", "it is nine zero nine five")).not.toStartWith("IS");
});

test("an LLM answer that claims to change the ID or book something is not spoken", async () => {
  const llm: Llm = async () => "I'll change the second character. Your slot is booked.";
  const { said, talk } = setup([], llm);
  await talk(FULL_ID, "purple banana window");
  expect(said.at(-1)).not.toContain("change the second character");
  expect(said.at(-1)).not.toContain("booked");
});

const answers = (reply: string): Llm => async () => reply;

test("reads the LLM's decision in its different forms", async () => {
  const { readMeaning } = await import("../server/brain");
  expect(readMeaning("YES")).toEqual({ kind: "yes" });
  expect(readMeaning("**No.**")).toEqual({ kind: "no" });
  expect(readMeaning("SLOT 2")).toEqual({ kind: "slot", index: 2 });
  expect(readMeaning("IGNORE")).toEqual({ kind: "ignore" });
  expect(readMeaning("GOODBYE")).toEqual({ kind: "goodbye" });
  expect(readMeaning("SAY: I only need it to find your delivery.")).toEqual({ kind: "say", text: "I only need it to find your delivery." });
});

test("a yes the rules miss, like sounds good to me, confirms the ID through the LLM", async () => {
  const { session, talk } = setup([], answers("YES"));
  await talk(FULL_ID, "sounds good to me");
  expect(session.idConfirmed).toBe(true);
  expect(session.stage).toBe("OFFER_SLOTS");
});

test("the LLM can pick the slot the caller described in their own words", async () => {
  const { session, said, talk } = setup();
  await talk(FULL_ID, "yes");
  const brainWithSlot = setup([], answers("SLOT 3"));
  Object.assign(brainWithSlot.session, session);
  await brainWithSlot.talk("hmm the latest one works better for me");
  expect(brainWithSlot.session.stage).toBe("CONFIRM_SLOT");
  expect(brainWithSlot.session.chosenSlotId).toBe(session.slots[2]!.id);
  expect(said.length).toBeGreaterThan(0);
});

test("a vague yes is never enough to book: the agent checks with a plain question first", async () => {
  const { backend, session, said, talk } = setup([], answers("YES"));
  await talk(FULL_ID, "yes", "the second one", "I suppose that works");
  expect(backend.bookings.size).toBe(0);
  expect(session.stage).toBe("CONFIRM_SLOT");
  expect(said.at(-1)).toContain("Just to confirm");
  await talk("yes");
  expect(backend.bookings.size).toBe(1);
});

test("a reluctant caller gets an honest reason, not a dropped turn", async () => {
  const { said, talk } = setup([], neverCalled);
  await talk("why should I tell you my tracking id");
  expect(said.at(-1)).toContain("only use the tracking ID");
  await talk("I don't want to tell you my tracking id");
  expect(said.at(-1)).toContain("only use the tracking ID");
});

test("the LLM's own answer is spoken, then the agent asks its question again", async () => {
  const { said, talk } = setup([], answers("SAY It is a bit cloudy where I am, but I cannot check the weather."));
  await talk("what's the weather outside");
  expect(said.at(-1)).toContain("cannot check the weather");
  expect(said.at(-1)).toContain("tracking ID");
});

test("unsure words the LLM ignores leave no trace in the conversation", async () => {
  const { session, said } = setup([], answers("IGNORE"));
  const { handleTurn } = await import("../server/brain");
  const taken = await handleTurn(session, "did you see the game last night", { backend: createBackend({ normalMs: 1 }), say: (t) => said.push(t), log: () => {}, llm: answers("IGNORE") }, true);
  expect(taken).toBe(false);
  expect(session.history.some((turn) => turn.text.includes("game"))).toBe(false);
  expect(said.length).toBe(0);
});

test("the last one picks the last slot offered, and naming the chosen slot again is checked, not booked", async () => {
  const { backend, session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes", "the last one");
  expect(session.chosenSlotId).toBe(session.slots[2]!.id);
  await talk("the last one works fine");
  expect(backend.bookings.size).toBe(0);
  expect(said.at(-1)).toContain("Just to confirm");
});

test("asked the same thing twice, the agent answers in new words instead of repeating itself", async () => {
  const { said, talk } = setup([], answers("SAY It is only used to find your parcel, nothing else."));
  await talk("why should I tell you my tracking id");
  expect(said.at(-1)).toContain("only use the tracking ID");
  await talk("but why should I tell you my tracking id");
  expect(said.at(-1)).toContain("only used to find your parcel");
});

test("a day and a spoken time pick that exact slot, without the LLM", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes");
  const [morning, , evening] = session.slots;
  await talk(`${evening!.day} 4 pm`);
  expect(session.chosenSlotId).toBe(evening!.id);
  await talk("no", "at ten o'clock");
  expect(session.chosenSlotId).toBe(morning!.id);
  await talk("no", "option two");
  expect(session.chosenSlotId).toBe(session.slots[1]!.id);
  expect(said.at(-1)).toBe(`${session.slots[1]!.label}. Shall I go ahead and book that?`);
});

test("a day that is not on offer gets the closest slot at the time asked for", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes");
  const missing = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].find(
    (day) => !session.slots.some((slot) => slot.day === day),
  )!;
  await talk(`${missing} 4 pm`);
  expect(session.stage).toBe("CONFIRM_SLOT");
  expect(said.at(-1)).toBe(`Ah, I don't have anything on ${missing}, but I do have ${session.slots[2]!.label}. Shall I go ahead and book that?`);
});

test("a time that is not on offer gets the nearest slot that day", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes");
  const evening = session.slots[2]!;
  await talk(`${evening.day} at 8 pm`);
  expect(session.chosenSlotId).toBe(evening.id);
  expect(said.at(-1)).toContain("anything at 8 PM");
});

test("naming only a day reads out that day's times, then a position picks from them", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes");
  const later = session.slots[4]!;
  await talk(`can I do ${later.day} instead`);
  expect(said.at(-1)).toBe(`On ${later.day}, I have 9 AM to 11 AM, 1 PM to 3 PM or 4 PM to 6 PM. Which time works for you?`);
  await talk("the second one");
  expect(session.chosenSlotId).toBe(later.id);
});

test("wait a second is not the second slot", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk(FULL_ID, "yes", "wait a second");
  expect(session.chosenSlotId).toBeUndefined();
  expect(said.at(-1)).toContain("take your time");
});

test("digits without letters are kept, and the letters can follow", async () => {
  const { session, said, talk } = setup();
  await talk("four one eight two zero seven");
  expect(said.at(-1)).toContain("Got it, 4 1 8 2 0 7");
  await talk("bravo delta");
  expect(session.trackingId).toBe("BD418207");
  expect(session.stage).toBe("CONFIRM_ID");
});

test("an ID that goes wrong halfway keeps the good start", async () => {
  const { session, said, talk } = setup();
  await talk("bravo delta four one alpha two zero seven");
  expect(said.at(-1)).toContain("then I lost you");
  expect(session.trackingId).toBe("BD41");
  await talk("eight two zero seven");
  expect(session.trackingId).toBe("BD418207");
});

test("a missed ID is asked for in different words each time", async () => {
  const { said, talk } = setup();
  await talk("four bravo delta one");
  await talk("four bravo delta one");
  expect(said.at(-1)).not.toBe(said.at(-2));
  expect(said.at(-1)).toContain("two letters and then six digits");
});

test("reads the JSON turn the model is asked for", async () => {
  const { readMeaning } = await import("../server/brain");
  expect(readMeaning('{"action":"yes","reply":"","slot":0}')).toEqual({ kind: "yes" });
  expect(readMeaning('{"action":"slot","reply":"","slot":3}')).toEqual({ kind: "slot", index: 3 });
  expect(readMeaning('{"action":"say","reply":"I can\'t see that from here.","slot":0}')).toEqual({ kind: "say", text: "I can't see that from here." });
  expect(readMeaning('{"action":"say","reply":"I changed your slot.","slot":0}')).toBeUndefined();
});

test("a half-written JSON answer gives up its finished part", async () => {
  const { partialTurn } = await import("../server/brain");
  expect(partialTurn('{"action": "say", "reply": "Sure. I can\\u20')).toEqual({ action: "say", reply: "Sure. I can", closed: false });
  expect(partialTurn('{"action": "say", "reply": "Sure. \\"Yes\\" works.", "sl')).toEqual({ action: "say", reply: 'Sure. "Yes" works.', closed: true });
  expect(partialTurn('{"act')).toEqual({ action: undefined, closed: false });
});

test("a streamed reply is spoken sentence by sentence while the model is still writing, and nothing twice", async () => {
  const spokenEarly: string[] = [];
  let said: string[] = [];
  const reply = '{"action": "say", "reply": "I\'m sorry, I don\'t have that information. The courier\'s customer support can tell you.", "slot": 0}';
  const llm: Llm = async (_system, _turns, onText) => {
    for (let i = 20; i <= reply.indexOf("customer"); i += 7) onText?.(reply.slice(0, i));
    spokenEarly.push(...said);
    onText?.(reply);
    return reply;
  };
  const brain = setup([], llm);
  said = brain.said;
  await brain.talk("will the driver call before coming");
  expect(spokenEarly).toEqual(["I'm sorry, I don't have that information."]);
  expect(brain.said).toEqual([
    "I'm sorry, I don't have that information.",
    "The courier's customer support can tell you.",
    "What's your tracking ID?",
  ]);
});

test("an ignored turn streams nothing", async () => {
  const llm: Llm = async (_s, _t, onText) => {
    onText?.('{"action": "ignore", "reply": "Sure thing.", "slot": 0}');
    return '{"action": "ignore", "reply": "Sure thing.", "slot": 0}';
  };
  const session = (await import("../server/session")).newSession("t");
  const said: string[] = [];
  const taken = await handleTurn(session, "pass the salt", { backend: createBackend({ normalMs: 1 }), say: (t) => said.push(t), log: () => {}, llm }, true);
  expect(taken).toBe(false);
  expect(said).toEqual([]);
});

test("a caller without the tracking ID is helped once, then offered a way out instead of being asked again", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk("I don't know my tracking id");
  expect(said.at(-1)).toContain("text message or email the courier sent");
  expect(session.holdUntil).toBeGreaterThan(Date.now());
  await talk("i don't know my tracking id");
  expect(said.at(-1)).toContain("Shall I end the call for now?");
  await talk("yes");
  expect(session.stage).toBe("DONE");
  expect(said.at(-1)).toContain("Goodbye");
});

test("the same question is not tacked onto every answer", async () => {
  const { said, talk } = setup([], answers('{"action":"say","reply":"I only use it to find your parcel.","slot":0}'));
  await talk("why do you want that", "but why though", "seriously why");
  const asks = said.filter((line) => line.includes("What's your tracking ID?")).length;
  expect(asks).toBeLessThanOrEqual(2);
});

test("two letters written as one word complete the ID when the digits were already given", async () => {
  const { session, said, talk } = setup([], neverCalled);
  await talk("nine one two one three five");
  await talk("yes i said dd");
  expect(session.trackingId).toBe("DD912135");
  expect(session.stage).toBe("CONFIRM_ID");
  expect(said.at(-1)).toContain("D as in Delta, D as in Delta");
});

test("while digits are held, the follow-up asks only for the letters", async () => {
  const { said, talk } = setup([], answers('{"action":"say","reply":"Thanks, I have noted down those two letters.","slot":0}'));
  await talk("nine one two one three five", "hmm hang on what");
  expect(said.join(" ")).not.toContain("noted down");
  expect(said.at(-1)).not.toContain("What's your tracking ID");
});
