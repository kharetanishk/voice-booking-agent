// One phone call: caller audio in, agent speech out.
import { greet, handleTurn, sayGoodbye, type Deps } from "./brain";
import type { Backend, CallKind, Mode } from "./fakeBackend";
import type { Llm } from "./llm";
import { log, type Level, type Scope } from "./logger";
import type { ServerMessage } from "./protocol";
import { getSession } from "./session";
import { isInterruption, isRelevant, realWords } from "./speech";
import { createStt } from "./stt";
import { isValid, looksLikeIdStart, updateId } from "./trackingId";
import { synthesize, TTS_SAMPLE_RATE } from "./tts";

export type Socket = { send: (data: string | Uint8Array) => void };
export type Call = { sendAudio: (audio: Uint8Array) => void; end: () => void };
type Shared = {
  backend: Backend;
  llm?: Llm;
  deepgramKey: string;
  silenceMs?: number;
  recoverMs?: number;
  idPauseMs?: number;
};
type Services = { createStt: typeof createStt; synthesize: typeof synthesize };

// Callers pause between characters, so an unfinished ID waits a little longer for the rest.
const ID_PAUSE_MS = 1600;
// Chunks of speech are collected until the caller pauses this long. Constant background talk gives no pause of its own.
const CHUNK_PAUSE_MS = 700;
// A chunk of an unfinished ID that was not followed by a pause: the caller is probably still reading it out.
const ID_CHUNK_WAIT_MS = 2400;
// While the caller is still producing words, an unfinished ID is not answered yet. This is the longest it waits in total.
const STILL_TALKING_MS = 1200;
const MAX_ID_WAIT_MS = 7000;
const STILL_TALKING_RECHECK_MS = 400;
const SPEECH_TIMEOUT_MS = 15_000;
// Extra time after the computed end of speech, to cover network and playback delay.
const PLAYBACK_MARGIN_MS = 300;
// agar user shant rha , agent ke answer finish krne ke itne time tak , so agent will say ki i cannot hear ...
const SILENCE_MS = 8000;
const MAX_REMINDERS = 3;
// After the caller cuts in, how long to wait for something useful before taking the floor back.
const RECOVER_MS = 3500;
// After this many chunks of talk that is not about the call in a row, the agent says it is hearing other voices.
const BACKGROUND_CHUNKS_BEFORE_NOTICE = 3;
// While the agent waits, speech this short and this clear might be the caller even if it matches no rule.
const MAYBE_CALLER_MAX_WORDS = 25;
const MAYBE_CALLER_MIN_CONFIDENCE = 0.8;

const BACKEND_CALL_NAMES: Record<CallKind, string> = { slots: "Slot lookup", book: "Booking request", status: "Status check" };
const BACKEND_BEHAVIOURS: Record<Mode, string> = {
  ok: "answered normally",
  slow: "is answering slowly (about 6 seconds)",
  fail: "returned an error and saved nothing",
  lostack: "saved the booking but the reply will be lost",
  hang: "will never answer",
};

export function startCall(
  socket: Socket,
  sessionId: string,
  { backend, llm, deepgramKey, silenceMs = SILENCE_MS, recoverMs = RECOVER_MS, idPauseMs = ID_PAUSE_MS }: Shared,
  services: Services = { createStt, synthesize },
): Call {
  const session = getSession(sessionId);

  let heardText = "";
  let heardConfidence = 1;
  // The words being collected might be background talk, so the brain is allowed to ignore them.
  let heardUnsure = false;
  let heardAt = 0;
  let lastCallerWordAt = 0;
  let waitingForRestOfId = false;
  // True from the moment the agent stops because of the caller until the caller's answer arrives.
  let cutIn = false;
  let backgroundChunks = 0;
  let backgroundNoticeGiven = false;
  let recoverTimer: ReturnType<typeof setTimeout> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let speechQueue: Promise<void> = Promise.resolve();
  let sentencesQueued = 0;
  let speakingUntil = 0;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let reminders = 0;
  let lastQuestion = "";
  // Aborted when the caller interrupts, which cancels every sentence that has not finished playing.
  let interrupted = new AbortController();
  // Once the connection has gone, the call stops talking. A turn that is still running just finishes quietly.
  let ended = false;

  const callId = sessionId.slice(0, 4);
  const note = (scope: Scope, text: string, level: Level = "info") => log(scope, text, level, callId);
  const send = (message: ServerMessage) => !ended && socket.send(JSON.stringify(message));
  const isSpeaking = () => sentencesQueued > 0 || Date.now() < speakingUntil;

  const sendState = () =>
    send({ type: "state", stage: session.stage, trackingId: session.trackingId, idConfirmed: session.idConfirmed, bookings: backend.bookings.size });

  let hangingUp = false;
  // How many times the agent checked "anything else?" after the booking.
  let doneChecks = 0;

  const deps: Deps = {
    backend,
    llm,
    say: (text) => speak(text),
    log: (kind, text) => tell(kind, text),
    hangUp,
  };

  // Lets the goodbye finish playing, then tells the page to end the call.
  // If the caller speaks during the goodbye, interrupt() cancels this and the call carries on.
  let hangUpTimer: ReturnType<typeof setTimeout> | undefined;
  function hangUp() {
    if (hangingUp) return;
    hangingUp = true;
    clearTimeout(silenceTimer);
    void speechQueue.then(() => {
      if (!hangingUp) return;
      hangUpTimer = setTimeout(() => {
        tell("good", "The agent ended the call after saying goodbye", "CALL");
        send({ type: "hangup" });
      }, Math.max(0, speakingUntil - Date.now()));
    });
  }

  function cancelHangUp() {
    if (!hangingUp) return;
    hangingUp = false;
    clearTimeout(hangUpTimer);
    tell("info", "The caller spoke during the goodbye, so the agent kept the line open", "CALL");
  }

  // Shows a line in the browser timeline and in the server terminal.
  function tell(kind: Level, text: string, scope: Scope = "BRAIN") {
    send({ type: "log", kind, text });
    note(scope, text, kind);
    sendState();
  }

  const stopListening = backend.subscribe(({ call, mode }) => {
    const text = `${BACKEND_CALL_NAMES[call]}: the booking system ${BACKEND_BEHAVIOURS[mode]}`;
    send({ type: "backend", mode, text });
    note("BACKEND", text, mode === "ok" ? "info" : "warn");
  });

  // Sentences are spoken one after another, in the order they were said.
  function speak(text: string, isReminder = false) {
    if (ended) return;
    if (!isReminder) lastQuestion = text;
    send({ type: "agent", text });
    note("AGENT", text);
    sentencesQueued++;
    const cancelled = interrupted.signal;
    speechQueue = speechQueue.then(() => streamSpeech(text, cancelled));
  }

  async function streamSpeech(text: string, cancelled: AbortSignal) {
    if (cancelled.aborted) return;

    const requestedAt = Date.now();
    let firstAudioAt = requestedAt;
    let bytes = 0;
    try {
      const request = AbortSignal.any([cancelled, AbortSignal.timeout(SPEECH_TIMEOUT_MS)]);
      for await (const chunk of services.synthesize(text, request)) {
        if (cancelled.aborted) return;
        if (bytes === 0) {
          firstAudioAt = Date.now();
          send({ type: "metric", name: "voice", ms: firstAudioAt - requestedAt });
          note("VOICE", `first sound after ${firstAudioAt - requestedAt} ms`);
          if (heardAt) {
            const gap = firstAudioAt - heardAt;
            send({ type: "metric", name: "response", ms: gap });
            note("VOICE", `reply started ${(gap / 1000).toFixed(1)} s after the caller stopped speaking`, gap < 1500 ? "good" : gap < 3000 ? "warn" : "bad");
          }
          heardAt = 0;
        }
        bytes += chunk.length;
        if (!ended) socket.send(chunk);
      }
    } catch (error) {
      if (cancelled.aborted) return;
      tell("warn", `Voice failed (${(error as Error).message}), using the browser voice`, "VOICE");
      send({ type: "speak_fallback", text });
    }

    if (cancelled.aborted) return;
    sentencesQueued--;
    // Playback starts at the first chunk, or right after the previous sentence finishes.
    const seconds = bytes / 2 / TTS_SAMPLE_RATE;
    speakingUntil = Math.max(firstAudioAt, speakingUntil) + seconds * 1000 + PLAYBACK_MARGIN_MS;
    if (sentencesQueued === 0) waitForCaller();
  }

  // Never leave the caller in silence: if they say nothing, say we cannot hear them and ask again.
  function waitForCaller() {
    clearTimeout(silenceTimer);
    if (hangingUp) return;
    // The wait only starts once the agent has finished speaking.
    const afterSpeech = Math.max(0, speakingUntil - Date.now());
    // After the booking, silence means the caller is probably done. Check once, then say goodbye.
    if (session.stage === "DONE") {
      silenceTimer = setTimeout(() => {
        if (isSpeaking() || session.busy) return waitForCaller();
        if (doneChecks++ === 0) return speak("Is there anything else, or shall I end the call?", true);
        sayGoodbye({ session, deps, say: speak });
      }, silenceMs + afterSpeech);
      return;
    }
    if (reminders >= MAX_REMINDERS) return;
    const patience = Math.max(0, (session.holdUntil ?? 0) - Date.now());
    silenceTimer = setTimeout(remind, silenceMs + Math.max(0, speakingUntil - Date.now()) + patience);
  }

  function remind() {
    // Words are still being collected or worked out, so the caller is not silent.
    if (isSpeaking() || session.busy || heardText) return waitForCaller();
    reminders++;
    tell("warn", "The caller said nothing, so the agent asked again", "CALL");
    speak(`Sorry, I cannot hear you. ${lastQuestion}`, true);
  }

  // The caller spoke over the agent: stop talking now and forget the rest of what was queued.
  function interrupt() {
    interrupted.abort();
    interrupted = new AbortController();
    sentencesQueued = 0;
    speakingUntil = 0;
    cutIn = true;
    cancelHangUp();
    clearTimeout(recoverTimer);
    recoverTimer = setTimeout(recover, recoverMs);
    send({ type: "stop_audio" });
    tell("info", "Caller spoke over the agent, so the agent stopped talking", "BARGE-IN");
  }

  // The caller cut in but nothing useful followed, so it was probably noise. Take the floor back and repeat.
  function recover() {
    if (!cutIn || isSpeaking() || session.busy || heardText) return;
    cutIn = false;
    tell("info", "Nothing useful followed the interruption, so the agent carried on", "BARGE-IN");
    speak(`Sorry, as I was saying. ${session.lastSaid}`, true);
  }

  function onInterim(text: string, confidence = 1) {
    const relevant = isRelevant(text, session.stage);
    // Only speech about this call counts as the caller answering. Background talk must not keep the watchdog quiet.
    if (relevant) {
      clearTimeout(silenceTimer);
      lastCallerWordAt = Date.now();
      send({ type: "interim", text });
    }
    if (isSpeaking() && isInterruption(text, session.lastSaid, session.stage, confidence)) interrupt();
  }

  // One finished chunk of what the recognizer heard. Chunks about the call are collected and answered together.
  function onHeard(text: string, confidence = 1, endOfSpeech = true) {
    note("HEARD", `"${text}"${confidence < 1 ? ` (confidence ${confidence.toFixed(2)})` : ""}`);

    if (isSpeaking()) {
      if (!isInterruption(text, session.lastSaid, session.stage, confidence)) {
        return tell("info", `Ignored "${text}", it was noise, an echo or talk that is not about this call`, "LISTEN");
      }
      interrupt();
    } else if (!isRelevant(text, session.stage)) {
      // The agent is waiting, so the caller is the most likely speaker. Short, clear speech gets a second opinion
      // before it is dropped. Long or doubtful talk is treated as people in the background.
      const maybeCaller = realWords(text).length <= MAYBE_CALLER_MAX_WORDS && confidence >= MAYBE_CALLER_MIN_CONFIDENCE;
      if (!maybeCaller) return ignoreBackground(text);
      return accept(text, confidence, endOfSpeech, true);
    }
    accept(text, confidence, endOfSpeech);
  }

  function noteCallerSpoke() {
    backgroundChunks = 0;
    doneChecks = 0;
    cancelHangUp();
  }

  // Talk that has nothing to do with the call is dropped here, so it never piles up around the caller's own words.
  function ignoreBackground(text: string) {
    tell("info", `Ignored "${text}", it sounded like talk between other people`, "LISTEN");
    if (++backgroundChunks >= BACKGROUND_CHUNKS_BEFORE_NOTICE && !backgroundNoticeGiven && !heardText) {
      backgroundNoticeGiven = true;
      speak("I can hear other people talking nearby. If you can, please move away from them or speak closer to the microphone.", true);
      return;
    }
    recoverNow();
  }

  // Speech the agent will answer.
  function accept(text: string, confidence: number, endOfSpeech: boolean, unsure = false) {
    // Unsure words only count as the caller once the brain decides they were meant for the agent.
    if (!unsure) noteCallerSpoke();

    reminders = 0;
    clearTimeout(silenceTimer);
    // Once anything clearly for the agent is in the collected words, the whole turn is treated as for the agent.
    heardUnsure = heardText ? heardUnsure && unsure : unsure;
    heardText = `${heardText} ${text}`.trim();
    heardConfidence = Math.min(heardConfidence, confidence);
    heardAt = Date.now();
    // Only wait for more of the ID if this sounded like part of one. Other talk is dealt with straight away.
    const withThis = updateId(session.trackingId, heardText);
    const idUnfinished =
      session.stage === "ASK_ID"
        ? withThis !== session.trackingId && !isValid(withThis)
        : looksLikeIdStart(heardText) && !isValid(updateId("", heardText));
    clearTimeout(holdTimer);
    waitingForRestOfId = idUnfinished;
    const wait = idUnfinished ? (endOfSpeech ? idPauseMs : ID_CHUNK_WAIT_MS) : endOfSpeech ? 0 : CHUNK_PAUSE_MS;
    holdTimer = setTimeout(deliver, wait);
  }

  // Heard something, but too unclear to trust. Ask again instead of staying silent.
  function onUnclear(text: string, confidence: number) {
    tell("warn", `Could not make out "${text}" (confidence ${confidence.toFixed(2)})`, "LISTEN");
    if (!isSpeaking() && !heardText) speak("Sorry, there is a lot of noise on the line. Could you say that again?", true);
  }

  async function deliver() {
    // The recognizer can end a chunk at a comma while the caller carries on. If words are still arriving, wait.
    const stillTalking = Date.now() - lastCallerWordAt < STILL_TALKING_MS;
    if (waitingForRestOfId && stillTalking && Date.now() - heardAt < MAX_ID_WAIT_MS) {
      holdTimer = setTimeout(deliver, STILL_TALKING_RECHECK_MS);
      return;
    }
    const text = heardText;
    const unsure = heardUnsure;
    heardText = "";
    heardConfidence = 1;
    heardUnsure = false;
    if (!text) return;

    cutIn = false;
    clearTimeout(recoverTimer);
    // An unsure turn only shows up as the caller's words if the brain decides they were meant for the agent.
    if (!unsure) send({ type: "user", text });
    try {
      const taken = await handleTurn(session, text, deps, unsure);
      if (!taken) {
        ignoreBackground(text);
        waitForCaller();
      } else if (unsure) {
        noteCallerSpoke();
        send({ type: "user", text });
      }
    } catch (error) {
      tell("bad", `Something went wrong: ${(error as Error).message}`, "CALL");
      speak("Sorry, something went wrong on my side. Could you say that again?");
    }
    sendState();
  }

  // If the caller had cut in and then turned out to be background talk, pick up straight away.
  function recoverNow() {
    clearTimeout(recoverTimer);
    recover();
  }

  const stt = services.createStt(deepgramKey, {
    onInterim,
    onFinal: onHeard,
    onUnclear,
    onError: (message) => tell("bad", message, "LISTEN"),
  });

  // A session that already has history is a caller coming back after the line dropped.
  const resuming = session.lastSaid !== "";
  if (resuming) void resume();
  else {
    note("CALL", `started, session ${sessionId}`, "good");
    greet(session, deps);
  }
  sendState();

  // Picks the conversation up where it stopped. If a turn was still running, its result is what gets repeated.
  async function resume() {
    tell("good", `Reconnected, the call continues at step ${session.stage}`, "CALL");
    await session.turn;
    if (ended) return;
    lastQuestion = session.lastSaid;
    speak(`Welcome back, sorry about the interruption. ${session.lastSaid}`, true);
    sendState();
  }

  return {
    sendAudio: stt.send,
    end: () => {
      if (ended) return;
      note("CALL", `connection closed at step ${session.stage}, bookings made: ${backend.bookings.size}`, "good");
      ended = true;
      interrupted.abort();
      stopListening();
      clearTimeout(silenceTimer);
      clearTimeout(holdTimer);
      clearTimeout(recoverTimer);
      clearTimeout(hangUpTimer);
      stt.close();
    },
  };
}
