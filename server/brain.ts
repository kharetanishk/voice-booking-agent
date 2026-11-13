import { bookSlot, callWithRetry, startBooking, withWaitNotice, type LogKind, type Options } from "./booking";
import type { Backend, Slot } from "./fakeBackend";
import { matchIntent, type Intent } from "./intents";
import type { Llm } from "./llm";
import type { Session } from "./session";
import { matchSlot, type SlotMatch } from "./slotMatch";
import { isQuestion, wantsNewId } from "./speech";
import { hasValidShape, ID_LENGTH, idCharsIn, isValid, mentionsIdPosition, namesPositionOnly, spell, updateId } from "./trackingId";

export type Deps = {
  backend: Backend;
  say: (text: string) => void;
  log: (kind: LogKind, text: string) => void;
  llm?: Llm;
  timing?: Options;
  // Ends the call once the goodbye has been spoken.
  hangUp?: () => void;
};

type Ctx = { session: Session; deps: Deps; say: (text: string) => void };

const FILLERS = [
  "Just a sec, still checking.",
  "Still on it, thanks for bearing with me.",
  "Sorry, this is taking a bit longer than usual. Nearly there.",
];

// How long the agent waits quietly after the caller says "hold on".
const HOLD_MS = 30_000;
const HISTORY_TURNS = 6;
const LLM_WAIT_NOTICE_MS = 2200;
const MAX_ANSWER_CHARS = 220;
const MAX_YES_WORDS = 6;

const YES = /\b(yes|yeah|yep|yup|sure|correct|right|confirm|confirmed|okay|ok|please do|go ahead|book it)\b/i;
const NO = /\b(no|nope|nah|not|wrong|incorrect|dont|don't|cancel)\b/i;
const START_OVER = /\b(start over|begin again|restart)\b/i;

// A confirmation is a short answer. A long sentence that happens to contain "yes" is probably someone else talking.
const isYes = (text: string) => YES.test(text) && !NO.test(text) && text.trim().split(/\s+/).length <= MAX_YES_WORDS;
const isNo = (text: string) => NO.test(text);

export function greet(session: Session, deps: Deps) {
  speak(session, deps, "Hi there, I can help you reschedule your delivery. What's your tracking ID?");
}

// Handles one thing the caller said. Returns false if it turned out not to be meant for the agent.
// An unsure turn is speech that might be background talk: it skips the rules and goes to the LLM, which can ignore it.
export async function handleTurn(session: Session, text: string, deps: Deps, unsure = false): Promise<boolean> {
  const ctx: Ctx = { session, deps, say: (line) => speak(session, deps, line) };
  if (session.busy) {
    ctx.say("Hang on, I'm still on it.");
    return true;
  }

  remember(session, "user", text);
  session.busy = true;
  // Talk about the ID itself ("the last digit should be five") is clearly for the agent, so it gets the rules.
  const turn = (unsure && !talksAboutId(text) ? fallback(ctx, text, true) : route(ctx, text)).finally(() => {
    session.busy = false;
  });
  session.turn = turn.then(() => {}, () => {});
  const taken = (await turn) !== IGNORED;
  // Talk that was not for the agent should not shape later answers.
  if (!taken) session.history.pop();
  return taken;
}

function remember(session: Session, role: "user" | "assistant", text: string) {
  session.history.push({ role, text });
  session.history.splice(0, Math.max(0, session.history.length - HISTORY_TURNS * 2));
}

function speak(session: Session, deps: Deps, text: string) {
  session.lastSaid = text;
  remember(session, "assistant", text);
  deps.say(text);
}

async function route(ctx: Ctx, text: string) {
  const { session, say } = ctx;

  // "you can end the call" works at any step.
  if (matchIntent(text)?.name === "goodbye") return sayGoodbye(ctx);

  if (START_OVER.test(text)) {
    clearBookingState(session);
    return say("No problem, let's start fresh. What's your tracking ID?");
  }

  // The caller can fix or change the ID at any point, not only while we are asking for it.
  const pendingFix = session.pendingFix;
  session.pendingFix = undefined;
  if (session.trackingId) {
    // A correction can come in two breaths: "no, the last two digits" ... "should be one three".
    const said = pendingFix ? `${pendingFix} ${text}` : text;
    const fixed = applyId(session.trackingId, said);
    if (fixed !== session.trackingId && isValid(fixed) && (pendingFix || wantsNewId(text) || namesPositionOrNot(text))) {
      return replaceId(ctx, fixed);
    }
    if (namesPositionOnly(said)) {
      session.pendingFix = said;
      return say("Sure, what should it be?");
    }
  }
  if (wantsNewId(text)) return changeId(ctx, text);
  if (session.stage !== "ASK_ID" && session.stage !== "CONFIRM_ID") {
    const changed = applyId(session.trackingId, text);
    if (changed !== session.trackingId && isValid(changed)) return replaceId(ctx, changed);
    // The start of a new ID, for example when it arrives in pieces. Collect it like a fresh ID.
    if (startsNewId(idCharsIn(text))) {
      ctx.deps.log("warn", "Caller started giving a new tracking ID");
      clearBookingState(session);
      return askId(ctx, text);
    }
  }

  switch (session.stage) {
    case "ASK_ID": return askId(ctx, text);
    case "CONFIRM_ID": return confirmId(ctx, text);
    case "OFFER_SLOTS": return chooseSlot(ctx, text);
    case "CONFIRM_SLOT": return confirmSlot(ctx, text);
    case "BOOKING": return retryBooking(ctx, text);
    case "DONE": return afterBooking(ctx, text);
  }
}

// The booking is done and the agent asked "anything else?".
async function afterBooking(ctx: Ctx, text: string) {
  if (isQuestion(text)) return fallback(ctx, text);
  // "yes" to "shall I end the call?" means end it, while "yes" to "anything else?" means there is more.
  const askedToEnd = /end the call/i.test(ctx.session.lastSaid);
  if (isYes(text) && !askedToEnd) return ctx.say("Sure thing. If you've got another parcel to move, just tell me its tracking ID.");
  sayGoodbye(ctx);
}

export function sayGoodbye({ session, deps, say }: Ctx) {
  const booked = session.booking?.status === "done";
  session.stage = "DONE";
  deps.log("good", "The call is ending with a goodbye");
  say(booked ? "Thanks for calling, and have a great day. Goodbye." : "Okay, thanks for calling. Take care. Goodbye.");
  deps.hangUp?.();
}

// Forgets the ID and everything that depended on it, and goes back to asking for it.
function clearBookingState(session: Session) {
  Object.assign(session, {
    stage: "ASK_ID",
    trackingId: "",
    idConfirmed: false,
    slots: [],
    chosenSlotId: undefined,
    confirmedSlotId: undefined,
    booking: undefined,
    heldDigits: undefined,
    idMisses: 0,
  });
}

// "I want to change the tracking ID" or "the ID is wrong". The fix or the new ID often follows in the next breath,
// so the current ID is kept until we know which: "the last digit is seven" fixes it, a whole ID replaces it.
function changeId(ctx: Ctx, text: string) {
  const { session, deps, say } = ctx;
  deps.log("warn", "Caller wants to change the tracking ID");
  if (applyId("", text) !== "") {
    clearBookingState(session);
    return askId(ctx, text);
  }
  if (!session.trackingId) return say("No problem. What's the tracking ID?");
  // The ID is in question now, so nothing can be booked against it until it is confirmed again.
  Object.assign(session, { stage: "CONFIRM_ID", idConfirmed: false, slots: [], chosenSlotId: undefined, confirmedSlotId: undefined });
  session.pendingFix = text;
  say("No problem. Tell me which part to change, like the last digit is seven, or just read out the whole new ID.");
}

// "the third digit is 9" or "B not D": a correction that says where, as opposed to a whole new ID.
const namesPositionOrNot = (text: string) => /\bnot\b/i.test(text) || namesPositionOnly(text.split(/\b(is|are|should|to)\b/i)[0] ?? "");

// The caller gave a different ID, or corrected part of it. The new one has to be confirmed again,
// and the slot picked for the old one no longer counts.
function replaceId(ctx: Ctx, id: string) {
  const { session, deps, say } = ctx;
  const different = changedCharacters(session.trackingId, id) >= NEW_ID_CHARACTERS;
  deps.log("warn", `Tracking ID changed from ${session.trackingId} to ${id}, waiting for the caller to confirm it`);
  Object.assign(session, {
    stage: "CONFIRM_ID",
    trackingId: id,
    idConfirmed: false,
    slots: [],
    chosenSlotId: undefined,
    confirmedSlotId: undefined,
    booking: undefined,
  });
  say(different ? `Oh, a different ID. Let me read it back: ${spell(id)}. Is that right?` : `Ah, sorry about that. So that's ${spell(id)}. Is that right?`);
}

// The two letters an ID begins with, a few characters that begin with a letter, or several of any kind.
// A lone digit is just an answer like "the second one".
const startsNewId = (chars: string) =>
  chars.length >= 5 || (chars.length >= 3 && /^[A-Z]/.test(chars)) || /^[A-Z]{2}/.test(chars);

const changedCharacters = (a: string, b: string) => [...b].filter((char, index) => char !== a[index]).length;
// A different ID in three or more places is a new ID, not a small correction.
const NEW_ID_CHARACTERS = 3;

// A full ID said from scratch replaces the old one. Otherwise the text adds to it or corrects it.
function applyId(current: string, text: string): string {
  const fresh = updateId("", text);
  return isValid(fresh) ? fresh : updateId(current, text);
}

function askId(ctx: Ctx, text: string) {
  const { session, deps, say } = ctx;
  const before = session.trackingId;
  let id = applyId(before, text);

  // The digits came first and were kept. These are the letters that go in front of them.
  if (session.heldDigits && /^[A-Z]{1,2}$/.test(id)) {
    if (id.length === 1) {
      session.trackingId = id;
      return say(`${spell(id)}, got it. And the second letter?`);
    }
    id += session.heldDigits;
  }

  if (!hasValidShape(id)) return missedId(ctx, id);

  session.trackingId = id;
  session.idConfirmed = false;
  if (id === before) return fallback(ctx, text);
  session.heldDigits = undefined;
  session.idMisses = 0;

  deps.log("info", `Understood so far: ${[...id.padEnd(ID_LENGTH, "_")].join(" ")}`);
  if (isValid(id)) {
    session.stage = "CONFIRM_ID";
    return say(`Okay, let me read that back. ${spell(id)}. Is that right?`);
  }
  say(`Got it, ${spell(id)}. What comes next?`);
}

// What was heard is not two letters then six digits. Keep what can be kept and ask only for what is missing,
// so the caller does not have to start over, and do not say the same thing twice in a row.
function missedId(ctx: Ctx, id: string) {
  const { session, deps, say } = ctx;
  session.idMisses = (session.idMisses ?? 0) + 1;
  deps.log("warn", `Heard ${id}, which is not two letters then six digits`);

  // Letters then digits, but not two letters: keep the digits and ask for the letters.
  const [, letters = "", digits] = id.match(/^([A-Z]*)(\d+)$/) ?? [];
  if (digits) {
    session.trackingId = "";
    session.heldDigits = digits.slice(0, ID_LENGTH - 2);
    const numbers = [...session.heldDigits].join(" ");
    if (!letters) return say(`Got it, ${numbers}. There should be two letters before the numbers. What are they?`);
    if (letters.length === 1) return say(`I've got ${spell(letters)}, then ${numbers}, but there should be two letters at the start. What are both letters?`);
    return say(`Hmm, I heard ${letters.length} letters, ${spell(letters)}, but the ID only has two. Which two is it?`);
  }

  // The start was fine and then it went wrong: keep the start and ask for the rest.
  let good = id;
  while (good && !hasValidShape(good)) good = good.slice(0, -1);
  if (good.length >= 2 && session.idMisses <= 2) {
    session.trackingId = good;
    return say(`I got ${spell(good)}, then I lost you for a second. What comes after that?`);
  }

  session.trackingId = "";
  session.heldDigits = undefined;
  const lines = [
    "Sorry, I missed a bit of that. Could you say the tracking ID again, a little slower?",
    "Sorry, I'm still not getting it. It's two letters and then six digits, like B D 4 1 8 2 0 7.",
    "Let's take it bit by bit. Just the two letters first, like B as in Bravo, D as in Delta.",
  ];
  say(lines[Math.min(session.idMisses, lines.length) - 1]!);
}

async function confirmId(ctx: Ctx, text: string) {
  const { session, deps, say } = ctx;
  if (isYes(text)) return acceptId(ctx);

  const next = applyId(session.trackingId, text);
  if (next !== session.trackingId && isValid(next)) return replaceId(ctx, next);
  // Letters or digits we could not place. Never hand these to the LLM, it would make up its own version of the ID.
  if (idCharsIn(text)) {
    return say("Sorry, I couldn't tell which part to change. You could say something like the last digit is seven, or just read the whole ID again.");
  }
  if (isNo(text)) return say("Oh, sorry about that. Which part's wrong? Just tell me the fix, like the last two digits are one three.");
  await fallback(ctx, text);
}

function acceptId(ctx: Ctx) {
  const { session, deps } = ctx;
  deps.log("good", `Caller confirmed tracking ID ${session.trackingId}`);
  session.idConfirmed = true;
  session.stage = "OFFER_SLOTS";
  return offerSlots(ctx);
}

function chooseThis(ctx: Ctx, slot: Slot, lead = `${slot.label}.`) {
  const { session, deps, say } = ctx;
  deps.log("info", `Caller chose ${slot.label}`);
  session.chosenSlotId = slot.id;
  session.stage = "CONFIRM_SLOT";
  say(`${lead} Shall I go ahead and book that?`);
}

// The caller named a slot, a day, or a time. One slot fits: confirm it. Several fit: read just those out.
// Nothing fits: say so and offer the closest one, instead of a dead end.
function offerMatch(ctx: Ctx, match: SlotMatch) {
  const { session, say } = ctx;
  const sorry = match.instead ? `Ah, I don't have ${match.instead}` : "";
  if ("slot" in match) return chooseThis(ctx, match.slot, sorry ? `${sorry}, but I do have ${match.slot.label}.` : undefined);

  const { options } = match;
  session.stage = "OFFER_SLOTS";
  session.chosenSlotId = undefined;
  // The options go first, so "the second one" means the second one just read out.
  session.slots = [...options, ...session.slots.filter((slot) => !options.includes(slot))];
  const day = options[0]!.day;
  const prompt = options.every((slot) => slot.day === day)
    ? `On ${day}, I have ${joinOr(options.map((slot) => slot.label.slice(day.length + 1)))}. Which time works for you?`
    : slotPrompt(session);
  say(sorry ? `${sorry}. ${prompt}` : prompt);
}

const joinOr = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

async function offerSlots(ctx: Ctx) {
  const { session, deps, say } = ctx;
  const options = callOptions(ctx);
  const slots = await withWaitNotice(options, () => callWithRetry(() => deps.backend.slots(), "Looking up delivery slots", options));

  if (!slots) {
    deps.log("bad", "Could not load delivery slots");
    return say("Hmm, I'm having trouble reaching the scheduling system. Shall I try again?");
  }
  session.slots = slots;
  say(`Great, thanks. ${slotPrompt(session)}`);
}

async function chooseSlot(ctx: Ctx, text: string) {
  const { session, deps, say } = ctx;
  if (!session.slots.length) {
    if (isNo(text)) {
      session.stage = "DONE";
      return say("No problem. Feel free to call back any time. Goodbye.");
    }
    return offerSlots(ctx);
  }

  const match = matchSlot(session.slots, text);
  if (!match) return fallback(ctx, text);
  offerMatch(ctx, match);
}

async function confirmSlot(ctx: Ctx, text: string) {
  const { session, deps, say } = ctx;
  const chosen = session.slots.find((slot) => slot.id === session.chosenSlotId)!;

  const match = matchSlot(session.slots, text);
  const named = match && !match.instead ? ("slot" in match ? [match.slot] : match.options) : [];
  if (match && !named.includes(chosen)) {
    deps.log("info", "Caller asked for a different slot");
    return offerMatch(ctx, match);
  }
  // "the last one works fine" names the slot that is already chosen. It sounds like a yes but is not a plain one.
  if (named.length && !isYes(text)) return say(`Just to confirm, shall I book ${chosen.label}?`);
  if (isYes(text)) {
    session.confirmedSlotId = chosen.id;
    deps.log("good", `Caller confirmed ${chosen.label}`);
    return book(ctx, chosen);
  }
  if (isNo(text)) {
    session.stage = "OFFER_SLOTS";
    session.chosenSlotId = undefined;
    return say(`No worries. ${slotPrompt(session)}`);
  }
  await fallback(ctx, text);
}

async function book(ctx: Ctx, slot: Slot) {
  const { session, deps, say } = ctx;
  // The flow cannot reach this without a confirmed ID. This makes sure of it.
  if (!session.idConfirmed) throw new Error("the tracking ID was not confirmed by the caller");
  session.stage = "BOOKING";
  session.booking = startBooking(session.trackingId, slot.id, session.confirmedSlotId);

  const booking = await bookSlot(deps.backend, session.booking, callOptions(ctx));

  if (booking.status === "done") {
    session.stage = "DONE";
    deps.log("good", `Booked ${slot.label}, reference ${booking.ref}`);
    return say(`You're all set. Your delivery is now booked for ${slot.label}. Your reference is ${booking.ref!.replace("-", " ")}. Is there anything else I can help with?`);
  }
  if (booking.status === "failed") {
    session.stage = "CONFIRM_SLOT";
    session.confirmedSlotId = undefined;
    deps.log("bad", "Booking failed, nothing was booked");
    return say("Sorry, I couldn't complete the booking, and nothing's been booked. Shall I try again?");
  }
  deps.log("bad", "Booking outcome unknown");
  say("I couldn't confirm whether that went through, and I don't want to book it twice. Shall I check again?");
}

// The booking outcome was unknown. Checking again is safe because the booking key never changes.
async function retryBooking(ctx: Ctx, text: string) {
  const { session, say } = ctx;
  if (isYes(text)) return book(ctx, session.slots.find((slot) => slot.id === session.chosenSlotId)!);
  if (isNo(text)) {
    session.stage = "DONE";
    return say("Understood. Please call back in a little while to check on it. Goodbye.");
  }
  await fallback(ctx, text);
}

// The caller said something the rules could not use. Fixed rules answer the common requests. Everything else goes
// to the LLM, which works out what the caller meant. The code still decides what happens: the LLM can only pick from
// a few actions, and a booking still needs a plain yes.
async function fallback(ctx: Ctx, text: string, unsure = false): Promise<void | typeof IGNORED> {
  const { session, deps, say } = ctx;

  if (session.lastSaid.endsWith(END_FOR_NOW)) {
    if (isYes(text)) return sayGoodbye(ctx);
    if (isNo(text)) return say("Okay. Whenever you have it, just read it out.");
  }

  // A rule answers a common request. If the same answer was just given, the caller was not satisfied, so the LLM
  // answers in its own words instead of the agent repeating itself.
  const intent = matchIntent(text);
  if (intent) {
    const sameAgain = intent.reply !== undefined && session.lastSaid.startsWith(intent.reply);
    const fresh = sameAgain ? await understand(ctx, unsure) : undefined;
    return fresh ? act(ctx, text, fresh) : answerIntent(ctx, intent);
  }

  // A bare yes or no with nothing to confirm is not something to ask the LLM about.
  if (!unsure && (isYes(text) || isNo(text)) && text.trim().split(/\s+/).length <= 3) {
    return say(`Sorry, I'm not sure what you're answering. ${reprompt(session)}`);
  }

  const meaning = await understand(ctx, unsure);
  if (meaning) return act(ctx, text, meaning);

  // No LLM answer. Unsure speech is let go, anything else gets a fixed reply so the caller is never left in silence.
  if (unsure) return IGNORED;
  if (isQuestion(text)) return say(`I'm afraid I can only help with rescheduling your delivery. ${reprompt(session)}`);
  // Said again, the same words sound like a broken record.
  const sorry = session.lastSaid.startsWith("Sorry, I didn't catch that") ? "Sorry, I still didn't get that." : "Sorry, I didn't catch that.";
  say(`${sorry} ${reprompt(session)}`);
}

type Meaning =
  | { kind: "yes" | "no" | "goodbye" | "ignore" }
  | { kind: "slot"; index: number }
  | { kind: "say"; text: string; spoken?: Spoken };

// The sentences of an LLM reply that were already handled while it streamed in: spoken, or dropped as unsafe.
type Spoken = { done: number; said: string[]; chars: number };
const MAX_SENTENCES = 2;

async function act(ctx: Ctx, text: string, meaning: Meaning): Promise<void | typeof IGNORED> {
  const { session, deps, say } = ctx;
  deps.log("info", `The LLM understood: ${meaning.kind === "say" ? "a question or remark" : meaning.kind === "slot" ? `slot ${meaning.index}` : meaning.kind}`);
  const chosen = session.slots.find((slot) => slot.id === session.chosenSlotId);

  switch (meaning.kind) {
    case "ignore":
      deps.log("info", `Ignored "${text}", it was not meant for the agent`);
      return IGNORED;
    case "goodbye":
      return sayGoodbye(ctx);
    case "slot": {
      const slot = session.slots[meaning.index - 1];
      if (slot && (session.stage === "OFFER_SLOTS" || session.stage === "CONFIRM_SLOT")) return chooseThis(ctx, slot);
      return say(reprompt(session));
    }
    case "yes":
      if (session.stage === "CONFIRM_ID") {
        // The model reads a yes into things like "my tracking id" or a half-heard correction. Confirming the wrong ID
        // books the wrong parcel, so a "yes" that talks about the ID itself is checked with the caller instead.
        if (talksAboutId(text)) return say("Sorry, just to be sure, is that tracking ID right now?");
        return acceptId(ctx);
      }
      // A booking needs a plain yes, so a yes the LLM read into a vague answer is checked first.
      if (session.stage === "CONFIRM_SLOT" && chosen) return say(`Just to confirm, shall I book ${chosen.label}?`);
      if (session.stage === "DONE") return say("Sure thing. If you've got another parcel to move, just tell me its tracking ID.");
      return say(reprompt(session));
    case "no":
      if (session.stage === "CONFIRM_ID") return say("Oh, sorry about that. Which part's wrong? Just tell me the fix, like the last digit is seven.");
      if (session.stage === "CONFIRM_SLOT") {
        session.stage = "OFFER_SLOTS";
        session.chosenSlotId = undefined;
        return say(`No worries. ${slotPrompt(session)}`);
      }
      if (session.stage === "DONE") return sayGoodbye(ctx);
      return say(reprompt(session));
    case "say": {
      // Sentences that streamed in were spoken already. Say the rest together with the next question.
      const rest = nextSentences(meaning.spoken ?? newSpoken(), splitSentences(meaning.text));
      const line = [...rest, nextQuestion(session)].join(" ").trim();
      if (line) say(line);
      return;
    }
  }
}

const IGNORED = "ignored" as const;

function systemPrompt(session: Session, unsure: boolean): string {
  const slots = session.slots.length
    ? `The slots on offer are: ${session.slots.slice(0, 3).map((slot, i) => `${i + 1}) ${slot.label}`).join(", ")}.`
    : "";
  return [
    "You are the brain of a phone agent for a courier service. Its only job is to reschedule one delivery:",
    "get the tracking ID (two letters and six digits), confirm it, offer delivery slots, and book one after a clear yes.",
    `The agent last said: "${session.lastSaid}"`,
    slots,
    unsure
      ? "The caller is in a car and other people may be talking nearby. These words may not be meant for the agent. " +
        "If they do not answer the agent and do not talk to the agent about the call, they were said to someone else: action ignore."
      : "",
    "Read the caller's last words and answer with a JSON object: action, reply, slot. action is one of:",
    "yes (the caller agrees with or confirms what the agent just asked),",
    "no (the caller disagrees or declines),",
    slots ? "slot (the caller picks one of the slots on offer, in their own words; put its number in slot)," : "",
    "goodbye (the caller wants to end the call),",
    "ignore (the words were said to someone else, not to the agent),",
    "say (anything else said to the agent: a question, a worry, a complaint, small talk; put the answer in reply).",
    "reply is empty unless action is say, and slot is 0 unless action is slot.",
    "A say reply is one or two short, warm, natural spoken sentences that respond to exactly what the caller said,",
    "the way a friendly person on the phone would say it. Contractions are good. No lists, no formal phrases.",
    "If they are reluctant to give the ID, explain why the agent needs it.",
    "Do not ask any question and do not ask for the tracking ID, the agent adds its next question itself.",
    "Never say any letters or digits of the tracking ID, and never say something was changed or booked.",
    "The agent knows nothing about the courier beyond this call. It cannot see where the parcel is, its contents, or whether it",
    "will arrive in time, and it knows nothing about how drivers work: whether they call ahead, where they leave parcels,",
    "signatures, safe places, prices, refunds, fees or any other policy. Never guess or invent any of these, not even reassuringly.",
    "For any question like that, say plainly that you don't have that information, and that the courier's customer support can help.",
    "Examples:",
    "Caller: 'will the driver call me before coming' -> say: I'm sorry, I don't have that information. The courier's customer support can tell you.",
    "Caller: 'will it arrive in time for the birthday' -> say: I can't see where the parcel is right now, but I can move it to a time that suits you.",
    "Caller: 'can they leave it with my neighbour' -> say: I'm afraid I can't arrange that from here. The courier's customer support can help with delivery instructions.",
    "Caller: 'how much does rescheduling cost' -> say: I don't have pricing information, I'm sorry. The courier's customer support can tell you.",
    "Agent asked to confirm the ID, caller: 'yep spot on' -> yes.",
    "Agent offered slots, caller: 'the later one in the afternoon' -> slot, with that slot's number.",
    "Caller: 'what's the weather like' -> say: I'm afraid I can't check the weather from here.",
    "Caller: 'this is taking forever' -> say: Sorry about the wait, we are nearly there.",
    "Caller: 'did you remember to buy the milk' -> ignore.",
    "Caller: 'can you pass me the water' -> ignore.",
    "Caller: 'I'm done, you can go' -> goodbye.",
  ]
    .filter(Boolean)
    .join(" ");
}

// Asks the LLM what the caller meant. Nothing if there is no LLM or it does not answer in time.
// A spoken reply streams: each sentence is said as soon as it is complete, while the model is still writing the next.
async function understand({ session, deps, say }: Ctx, unsure: boolean): Promise<Meaning | undefined> {
  if (!deps.llm) return;
  const spoken = newSpoken();
  // "One moment" only covers silence. Once the answer has started playing it would talk over itself.
  // The model usually starts answering in about 1.4 s, so "one sec" only covers a reply that is genuinely slow.
  const options: Options = { waitFirstMs: LLM_WAIT_NOTICE_MS, ...deps.timing, onWait: () => !spoken.said.length && say("One sec.") };
  const onText = (soFar: string) => {
    const turn = partialTurn(soFar);
    if (turn.action !== "say" || turn.reply === undefined) return;
    const sentences = splitSentences(turn.reply);
    // The last sentence may still be growing, unless the reply is finished.
    for (const sentence of nextSentences(spoken, turn.closed ? sentences : sentences.slice(0, -1))) say(sentence);
  };
  try {
    const turns = session.history.map((turn) => ({ role: turn.role, content: turn.text }));
    const startedAt = Date.now();
    const raw = await withWaitNotice(options, () => deps.llm!(systemPrompt(session, unsure), turns, onText));
    deps.log("info", `LLM answered in ${Date.now() - startedAt} ms`);
    const meaning = readMeaning(raw);
    if (meaning?.kind === "say") return { ...meaning, spoken };
    return meaning ?? (spoken.said.length ? { kind: "say", text: "", spoken } : undefined);
  } catch (error) {
    deps.log("warn", `LLM unavailable: ${(error as Error).message}`);
    // Part of the answer was already spoken, so the turn is answered. Just ask the next question.
    if (spoken.said.length) return { kind: "say", text: "", spoken };
  }
}

const newSpoken = (): Spoken => ({ done: 0, said: [], chars: 0 });
const splitSentences = (text: string) => text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);

// What a half-written JSON answer says so far: {"action": "say", "reply": "I can't see wh
export function partialTurn(soFar: string): { action?: string; reply?: string; closed: boolean } {
  const action = soFar.match(/"action"\s*:\s*"(\w+)"/)?.[1];
  const reply = soFar.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)(")?/);
  if (!reply) return { action, closed: false };
  let body = reply[1]!;
  if (!reply[2]) body = body.replace(/\\u?[0-9a-fA-F]{0,3}$|\\$/, "");
  try {
    return { action, reply: JSON.parse(`"${body}"`) as string, closed: Boolean(reply[2]) };
  } catch {
    return { action, closed: false };
  }
}

// The sentences not handled yet that are safe to say, within the length limit. Marks them all as handled.
// The system asks the next question itself, so a sentence that asks something is dropped. So is anything that claims to
// change the ID or the booking, because only the system can do that.
function nextSentences(spoken: Spoken, sentences: string[]): string[] {
  const out: string[] = [];
  for (const sentence of sentences.slice(spoken.done)) {
    spoken.done++;
    let clean = sentence.replace(/[*_`#>]/g, "").trim();
    if (!clean || spoken.said.length >= MAX_SENTENCES) continue;
    // Only the code knows what was captured, so a sentence about letters, digits or "noting it down" is dropped too.
    if (/\?$|\b(please|could you|can you)\b|\bas in\b|\d|\b(characters?|letters?|digits?|numbers?|change|changed|update|updated|correct(ed)?|book(ed)?|slots?|noted|note|saved|recorded|written|captured)\b/i.test(clean)) continue;
    if (spoken.chars + clean.length > MAX_ANSWER_CHARS) {
      if (spoken.said.length) continue;
      clean = clean.slice(0, MAX_ANSWER_CHARS).replace(/\s+\S*$/, "") + ".";
    }
    spoken.said.push(clean);
    spoken.chars += clean.length;
    out.push(clean);
  }
  return out;
}

export function readMeaning(raw: string): Meaning | undefined {
  // The JSON the model is asked for.
  try {
    const turn = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim()) as { action?: string; reply?: string; slot?: number };
    switch (turn.action) {
      case "yes": case "no": case "goodbye": case "ignore": return { kind: turn.action };
      case "slot": return turn.slot ? { kind: "slot", index: turn.slot } : undefined;
      case "say": return sayable(turn.reply ?? "");
    }
  } catch {}
  // A model that ignored the JSON format and answered in words: "YES", "SLOT 2", "SAY: ...".
  const line = raw.replace(/[*_`#>"]/g, "").trim();
  const word = line.split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z]/g, "");
  if (word === "YES") return { kind: "yes" };
  if (word === "NO") return { kind: "no" };
  if (word === "GOODBYE") return { kind: "goodbye" };
  if (word === "IGNORE") return { kind: "ignore" };
  if (word === "SLOT") {
    const index = Number(line.match(/\d/)?.[0]);
    return index ? { kind: "slot", index } : undefined;
  }
  return sayable(word === "SAY" ? line.replace(/^\S+\s*:?\s*/, "") : line);
}

// A reply with nothing safe to say counts as no answer. The text is kept whole: act() filters it sentence by sentence,
// in step with what already streamed out.
function sayable(reply: string): Meaning | undefined {
  const text = reply.replace(/\s+/g, " ").trim();
  return nextSentences(newSpoken(), splitSentences(text)).length ? { kind: "say", text } : undefined;
}

function answerIntent({ session, deps, say }: Ctx, intent: Intent) {
  deps.log("info", `Caller asked for: ${intent.name}`);
  switch (intent.name) {
    case "goodbye":
      return sayGoodbye({ session, deps, say });
    case "wait":
      session.holdUntil = Date.now() + HOLD_MS;
      return say("Of course, take your time. I'll be right here.");
    case "repeat":
      return say(`Sure. ${session.lastSaid.replace(/^(Sure\. )+/, "")}`);
    case "no ID":
      // First time: help them find it and wait. Second time: don't nag, offer to end the call.
      if (session.lastSaid.startsWith(WHERE_TO_FIND_ID)) {
        return say(`${NO_ID_GIVE_UP} ${END_FOR_NOW}`);
      }
      session.holdUntil = Date.now() + HOLD_MS;
      return say(WHERE_TO_FIND_ID);
    default:
      return say(`${intent.reply} ${nextQuestion(session)}`.trim());
  }
}

const WHERE_TO_FIND_ID =
  "No problem. It's usually in the text message or email the courier sent you: two letters and six digits. Take your time, I'll wait while you look.";
const NO_ID_GIVE_UP = "Without the tracking ID I can't find your delivery, and I don't want to move the wrong one.";
const END_FOR_NOW = "You can call back any time once you have it. Shall I end the call for now?";

const talksAboutId = (text: string) =>
  idCharsIn(text) !== "" || mentionsIdPosition(text) || /\b(tracking|id|digits?|letters?|numbers?|characters?)\b/i.test(text);

// The next question, unless the agent asked it in the last two things it said. Hearing the same question after every
// answer is what makes a voice agent sound like a loop.
function nextQuestion(session: Session): string {
  const question = reprompt(session);
  const recent = session.history.filter((turn) => turn.role === "assistant").slice(-2);
  return question && recent.some((turn) => turn.text.includes(question)) ? "" : question;
}

function reprompt(session: Session): string {
  switch (session.stage) {
    case "ASK_ID":
      if (session.heldDigits) return "What are the two letters before the numbers?";
      return session.trackingId ? "What comes next in the tracking ID?" : "What's your tracking ID?";
    // The ID was just read out in full. Reading it again on every turn is slow and robotic.
    case "CONFIRM_ID": return /which part/i.test(session.lastSaid) ? "Which part should I change?" : "Did I get that ID right?";
    case "OFFER_SLOTS": return session.slots.length ? slotPrompt(session) : "Shall I try again?";
    case "CONFIRM_SLOT": {
      const chosen = session.slots.find((slot) => slot.id === session.chosenSlotId);
      return chosen ? `Shall I go ahead with ${chosen.label}?` : "Shall I go ahead and book it?";
    }
    case "BOOKING": return "Shall I check again?";
    case "DONE": return "";
  }
}

// Three slots on one day are said the way a person would: the day once, then the times.
function slotPrompt(session: Session): string {
  const offered = session.slots.slice(0, 3);
  const day = offered[0]!.day;
  if (offered.every((slot) => slot.day === day)) {
    const times = offered.map((slot) => `${slot.period} ${slot.label.slice(day.length + 1)}`);
    return `I have ${day} ${joinOr(times)}. Which works for you?`;
  }
  return `I can offer ${joinOr(offered.map((slot) => slot.label))}. Which works for you?`;
}

function callOptions({ say, deps }: Ctx): Options {
  return {
    ...deps.timing,
    onEvent: deps.log,
    onWait: (count) => {
      deps.log("warn", "The system is slow, telling the caller to wait");
      say(FILLERS[Math.min(count, FILLERS.length) - 1]!);
    },
  };
}
