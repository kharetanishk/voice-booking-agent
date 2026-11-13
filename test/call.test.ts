import { expect, test } from "bun:test";
import { startCall } from "../server/call";
import { createBackend, type Backend } from "../server/fakeBackend";
import type { Llm } from "../server/llm";
import type { ServerMessage } from "../server/protocol";
import type { createStt } from "../server/stt";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Handlers = Parameters<typeof createStt>[1];

// A call with fake speech services: the agent "speaks" 20 chunks, 20 ms apart.
function setup(silenceMs?: number, again?: { sessionId: string; backend: Backend }, recoverMs?: number, idPauseMs?: number, llm?: Llm) {
  const messages: ServerMessage[] = [];
  const audio: Uint8Array[] = [];
  let handlers!: Handlers;

  const backend = again?.backend ?? createBackend({ normalMs: 1, slowMs: 150 });
  if (!again) backend.forced = "ok";
  const sessionId = again?.sessionId ?? `test-${Math.random()}`;

  const socket = {
    send: (data: string | Uint8Array) => {
      if (typeof data === "string") messages.push(JSON.parse(data));
      else audio.push(data);
    },
  };
  const services = {
    createStt: ((_key: string, given: Handlers) => {
      handlers = given;
      return { send: () => {}, close: () => {} };
    }) as typeof createStt,
    synthesize: async function* (_text: string, signal: AbortSignal) {
      for (let i = 0; i < 20 && !signal.aborted; i++) {
        await sleep(20);
        yield new Uint8Array(480);
      }
    },
  };

  const call = startCall(socket, sessionId, { backend, deepgramKey: "x", silenceMs, recoverMs, idPauseMs, llm }, services);
  const types = () => messages.map((message) => message.type);
  const lastState = () => messages.findLast((m) => m.type === "state") as Extract<ServerMessage, { type: "state" }>;
  const spoken = () => messages.filter((m) => m.type === "agent").map((m) => (m as { text: string }).text);
  return { call, backend, sessionId, messages, audio, handlers: () => handlers, types, lastState, spoken };
}

test("speaks the greeting, then listens", async () => {
  const { audio, types } = setup();
  await sleep(100);
  expect(types()).toContain("agent");
  expect(audio.length).toBeGreaterThan(0);
});

test("the caller speaking over the agent stops the audio at once", async () => {
  const { audio, types, handlers } = setup();
  await sleep(100);
  handlers().onInterim("yes");
  const sentBefore = audio.length;

  expect(types()).toContain("stop_audio");
  await sleep(200);
  expect(audio.length).toBe(sentBefore);
});

test("a full ID said over the greeting is still understood", async () => {
  const { handlers, lastState } = setup();
  await sleep(100);
  handlers().onInterim("B as in");
  handlers().onFinal("B as in Bravo D as in Delta four one eight two zero seven");
  await sleep(100);

  expect(lastState().trackingId).toBe("BD418207");
  expect(lastState().stage).toBe("CONFIRM_ID");
});

test("filler sounds do not interrupt the agent", async () => {
  const { types, handlers } = setup();
  await sleep(100);
  handlers().onInterim("um");
  handlers().onFinal("uh hmm");
  expect(types()).not.toContain("stop_audio");
  expect(types()).not.toContain("user");
});

test("the agent's own voice picked up by the mic does not interrupt it", async () => {
  const { types, handlers } = setup();
  await sleep(100);
  handlers().onInterim("hi I can reschedule your delivery");
  expect(types()).not.toContain("stop_audio");
});

test("unclear speech gets a reply instead of silence", async () => {
  const { messages, handlers } = setup();
  await sleep(600);
  handlers().onUnclear("the", 0.2);
  const spoken = messages.filter((message) => message.type === "agent").map((message) => (message as { text: string }).text);
  expect(spoken.at(-1)).toContain("noisy on the line");
});

test("speech after the agent has stopped is a normal turn", async () => {
  const { handlers, lastState } = setup();
  await sleep(600);
  handlers().onFinal("B as in Bravo D as in Delta four one eight two zero seven");
  await sleep(100);
  expect(lastState().stage).toBe("CONFIRM_ID");
});

test("a silent caller is asked again, with the same question, then left alone after three tries", async () => {
  const { call, spoken } = setup(60);
  await sleep(1800);
  const reminders = spoken().filter((text) => text.startsWith("Hello? I can't hear you."));
  expect(reminders.length).toBe(3);
  expect(reminders[0]).toContain("What's your tracking ID?");
  call.end();
});

test("a caller who speaks is not nagged", async () => {
  const { call, handlers, spoken } = setup(60);
  await sleep(100);
  handlers().onInterim("B as in");
  handlers().onFinal("B as in Bravo D as in Delta four one eight two zero seven");
  await sleep(300);
  expect(spoken().some((text) => text.startsWith("Hello? I can't hear you."))).toBe(false);
  call.end();
});

test("a caller who reconnects is welcomed back and the conversation carries on", async () => {
  const first = setup();
  await sleep(100);
  first.handlers().onFinal("B as in Bravo D as in Delta four one eight two zero seven");
  await sleep(100);
  first.call.end();

  const second = setup(undefined, first);
  await sleep(100);
  expect(second.spoken()[0]).toContain("Welcome back");
  expect(second.spoken()[0]).toContain("Is that right");
  expect(second.spoken().join(" ")).not.toContain("Hi, I can reschedule");
  expect(second.lastState().trackingId).toBe("BD418207");

  await sleep(600);
  second.handlers().onFinal("yes");
  await sleep(100);
  expect(second.lastState().stage).toBe("OFFER_SLOTS");
  second.call.end();
});

test("the old connection says nothing once it has dropped", async () => {
  const first = setup();
  await sleep(100);
  first.call.end();
  const before = first.messages.length;
  const audioBefore = first.audio.length;
  first.handlers().onFinal("B as in Bravo D as in Delta four one eight two zero seven");
  await sleep(300);
  expect(first.messages.length).toBe(before);
  expect(first.audio.length).toBe(audioBefore);
});

test("a booking that finishes while the line is down is reported on reconnect, and made only once", async () => {
  const first = setup();
  const say = async (text: string) => {
    first.handlers().onFinal(text);
    await sleep(80);
  };
  await sleep(100);
  await say("B as in Bravo D as in Delta four one eight two zero seven");
  await say("yes");
  await say("the second one");
  first.backend.forced = "slow";
  await say("yes");
  expect(first.lastState().stage).toBe("BOOKING");

  first.call.end();
  const second = setup(undefined, first);
  await sleep(500);

  const welcome = second.spoken()[0]!;
  expect(welcome).toContain("Welcome back");
  expect(welcome).toContain("You're all set");
  expect(first.spoken().some((text) => text.includes("You're all set"))).toBe(false);
  expect(first.backend.bookings.size).toBe(1);
  second.call.end();
});

test("people talking in the background do not stop the agent", async () => {
  const { types, handlers } = setup();
  await sleep(100);
  handlers().onInterim("did you see the game last night");
  handlers().onFinal("did you see the game last night", 0.9);
  expect(types()).not.toContain("stop_audio");
  expect(types()).not.toContain("user");
});

test("a doubtful transcript does not stop the agent", async () => {
  const { types, handlers } = setup();
  await sleep(100);
  handlers().onInterim("yes", 0.3);
  expect(types()).not.toContain("stop_audio");
});

test("background talk while the agent is waiting gets no answer", async () => {
  const { types, handlers, spoken } = setup();
  await sleep(600);
  const before = spoken().length;
  handlers().onFinal("we should leave around six tomorrow", 0.5);
  await sleep(100);
  expect(types()).not.toContain("user");
  expect(spoken().length).toBe(before);
});

test("if the caller cut in and it was only background talk, the agent repeats itself at once", async () => {
  const { handlers, spoken } = setup();
  await sleep(100);
  handlers().onInterim("no");
  await sleep(30);
  handlers().onFinal("the weather is nice today", 0.5);
  await sleep(100);
  expect(spoken().at(-1)).toMatch(/^Sorry, as I was saying\. Hi there, I can help you reschedule/);
});

test("if the caller cut in and then said nothing useful, the agent takes the floor back", async () => {
  const { call, handlers, spoken } = setup(undefined, undefined, 80);
  await sleep(100);
  handlers().onInterim("yes");
  await sleep(250);
  expect(spoken().at(-1)).toMatch(/^Sorry, as I was saying\./);
  call.end();
});

test("after several chunks of background talk the agent says it can hear other people, once", async () => {
  const { handlers, spoken } = setup();
  await sleep(600);
  for (const chatter of ["so I told him we should leave around six", "and then grab some food after the game", "did you see what happened last night", "it was unbelievable honestly"]) {
    handlers().onFinal(chatter, 0.9);
    await sleep(20);
  }
  await sleep(200);
  const notices = spoken().filter((text) => text.includes("other people talking nearby"));
  expect(notices.length).toBe(1);
});

test("the page is told the ID is not confirmed until the caller says yes", async () => {
  const { handlers, lastState } = setup();
  await sleep(100);
  handlers().onFinal("B as in Bravo D as in Delta four one eight two zero seven");
  await sleep(100);
  expect(lastState().trackingId).toBe("BD418207");
  expect(lastState().idConfirmed).toBe(false);

  await sleep(600);
  handlers().onFinal("yes");
  await sleep(100);
  expect(lastState().idConfirmed).toBe(true);
});

test("after the ID is confirmed, a new ID that comes in two chunks is waited for and put together", async () => {
  const { handlers, lastState } = setup();
  await sleep(100);
  handlers().onFinal("B as in Bravo D as in Delta four one eight two zero seven");
  await sleep(150);
  await sleep(500);
  handlers().onFinal("yes");
  await sleep(200);
  expect(lastState().stage).toBe("OFFER_SLOTS");

  handlers().onFinal("a is in alpha", 0.9, false);
  await sleep(300);
  expect(lastState().stage).toBe("OFFER_SLOTS");
  handlers().onFinal("k as in kilo five five two zero one nine", 0.9, true);
  await sleep(300);
  expect(lastState().trackingId).toBe("AK552019");
  expect(lastState().stage).toBe("CONFIRM_ID");
  expect(lastState().idConfirmed).toBe(false);
});

test("an unfinished ID is not read back while the caller is still talking", async () => {
  const { call, handlers, spoken, lastState } = setup(undefined, undefined, undefined, 100);
  await sleep(600);
  handlers().onFinal("b as in bravo", 0.9, true);
  await sleep(60);
  handlers().onInterim("d as in delta four one");
  await sleep(150);
  expect(spoken().some((text) => text.includes("What comes next"))).toBe(false);

  handlers().onFinal("d as in delta four one eight two zero seven", 0.9, true);
  await sleep(150);
  expect(lastState().trackingId).toBe("BD418207");
  expect(lastState().stage).toBe("CONFIRM_ID");
  expect(spoken().some((text) => text.includes("What comes next"))).toBe(false);
  call.end();
});

test("an unfinished ID is read back once the caller really has stopped", async () => {
  const { call, handlers, spoken } = setup(undefined, undefined, undefined, 100);
  await sleep(600);
  handlers().onFinal("b as in bravo", 0.9, true);
  await sleep(300);
  expect(spoken().some((text) => text.includes("What comes next"))).toBe(true);
  call.end();
});

// Replays the call from the log: the booking failed, then the caller asked to end the call.
async function toFailedBooking() {
  const call = setup();
  const say = async (text: string) => {
    call.handlers().onFinal(text, 1, true);
    await sleep(700);
  };
  await sleep(600);
  await say("B as in Bravo D as in Delta four one eight two zero seven");
  await say("yes");
  await say("the second one");
  call.backend.forced = "fail";
  await say("yes");
  await sleep(1500);
  return { ...call, say };
}

test("no, you can end up the call: the agent says goodbye and hangs up, it is not treated as someone else", async () => {
  const { say, spoken, types, messages } = await toFailedBooking();
  expect(spoken().at(-1)).toContain("nothing's been booked");
  await say("no you can end up the call");
  await sleep(700);
  expect(spoken().at(-1)).toContain("Goodbye");
  expect(types()).toContain("hangup");
  expect(messages.some((m) => m.type === "log" && m.text.includes("talk between other people"))).toBe(false);
}, 15000);

test("after a booking, the agent asks if there is anything else, and a no ends the call gracefully", async () => {
  const call = setup();
  const say = async (text: string) => {
    call.handlers().onFinal(text, 1, true);
    await sleep(700);
  };
  await sleep(600);
  await say("B as in Bravo D as in Delta four one eight two zero seven");
  await say("yes");
  await say("the second one");
  await say("yes");
  expect(call.spoken().at(-1)).toContain("anything else");
  await say("no thanks");
  await sleep(700);
  expect(call.spoken().at(-1)).toContain("Goodbye");
  expect(call.types()).toContain("hangup");
}, 15000);

async function toBooked(silenceMs?: number) {
  const call = setup(silenceMs);
  const say = async (text: string) => {
    call.handlers().onFinal(text, 1, true);
    await sleep(700);
  };
  await sleep(600);
  await say("B as in Bravo D as in Delta four one eight two zero seven");
  await say("yes");
  await say("the second one");
  await say("yes");
  return { ...call, say };
}

test("after a booking, silence first gets one check, then a goodbye, never a sudden hang-up", async () => {
  const call = await toBooked(1500);
  expect(call.spoken().at(-1)).toContain("anything else");

  await sleep(1000);
  expect(call.types()).not.toContain("hangup");
  expect(call.spoken().at(-1)).toContain("anything else");

  await sleep(1200);
  expect(call.spoken().at(-1)).toBe("Anything else I can help with, or shall I end the call?");
  expect(call.types()).not.toContain("hangup");

  await sleep(2000);
  expect(call.spoken().at(-1)).toContain("Goodbye");
  expect(call.types()).toContain("hangup");
  expect(call.spoken().some((text) => text.includes("cannot hear you"))).toBe(false);
}, 20000);

test("the wait for an answer only starts once the agent has finished speaking", async () => {
  const call = await toBooked(1500);
  // The fake voice takes about 0.4 s per sentence, so nothing should happen before speech plus the full wait.
  await sleep(1200);
  expect(call.spoken().at(-1)).toContain("anything else");
}, 15000);

test("speaking during the goodbye cancels the hang-up and the agent listens", async () => {
  const call = await toBooked();
  call.handlers().onFinal("no thanks", 1, true);
  await sleep(150);
  expect(call.spoken().at(-1)).toContain("Goodbye");
  call.handlers().onInterim("wait");
  await call.say("wait I have another parcel");
  await sleep(500);
  expect(call.types()).not.toContain("hangup");
}, 15000);

test("yes to shall I end the call ends it, yes to anything else keeps going", async () => {
  const call = await toBooked();
  await call.say("yes");
  expect(call.spoken().at(-1)).toContain("another parcel");
  expect(call.types()).not.toContain("hangup");
}, 15000);

test("short clear speech that matches no rule is checked with the LLM before it is ignored", async () => {
  const askedAbout: string[] = [];
  const llm: Llm = async (_system, turns) => {
    askedAbout.push(turns.at(-1)!.content);
    return "YES";
  };
  const call = setup(undefined, undefined, undefined, undefined, llm);
  await sleep(600);
  call.handlers().onFinal("honestly I am not so sure about this", 0.95, true);
  await sleep(200);
  expect(askedAbout).toContain("honestly I am not so sure about this");
  expect(call.types()).toContain("user");
});

test("if the LLM says it was not meant for the agent, it is ignored", async () => {
  const llm: Llm = async () => "IGNORE";
  const call = setup(undefined, undefined, undefined, undefined, llm);
  await sleep(600);
  call.handlers().onFinal("did you see what happened last night", 0.95, true);
  await sleep(200);
  expect(call.types()).not.toContain("user");
});

test("a caller who cut in and is still talking is not talked over by the recovery line", async () => {
  const { call, handlers, spoken } = setup(undefined, undefined, 80);
  await sleep(100);
  handlers().onInterim("nine");
  for (const words of ["nine nine", "nine nine one", "nine nine one one", "nine nine one one two"]) {
    await sleep(50);
    handlers().onInterim(words);
  }
  expect(spoken().some((line) => line.startsWith("Sorry, as I was saying"))).toBe(false);
  call.end();
});
