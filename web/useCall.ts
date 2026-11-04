// Everything about one call that the page needs: what the agent is doing, the timeline and the summary numbers.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LogKind } from "../server/booking";
import type { ServerMessage } from "../server/protocol";
import type { Stage } from "../server/session";
import { createPlayer, startMic, type Mic, type Player } from "./audio";
import { PREVIEW_INTERIM, PREVIEW_SUMMARY, PREVIEW_TIMELINE } from "./preview";

export type Levels = { agent: () => number; caller: () => number };
export type Phase = "idle" | "connecting" | "reconnecting" | "listening" | "thinking" | "speaking";

export type TimelineItem = {
  id: number;
  seconds: number;
  kind: "user" | "agent" | "backend" | LogKind;
  text: string;
  technical?: boolean;
};

export type Summary = { stage?: Stage; trackingId: string; idConfirmed: boolean; bookings: number; responseMs?: number };
type ActiveCall = {
  socket?: WebSocket;
  mic: Mic;
  player: Player;
  sessionId: string;
  // Kept for the whole call, so a reconnect uses the same brain and voice.
  ended: boolean;
  // Failed connection attempts since the line was last up.
  attempts: number;
  lost: boolean;
};

const EMPTY_SUMMARY: Summary = { trackingId: "", idConfirmed: false, bookings: 0 };
// The agent often pauses briefly between sentences. It only counts as finished speaking after this long.
const SPEAKING_GAP_MS = 350;
// The browser remembers the call so a dropped or reloaded page can pick it up again.
const SESSION_KEY = "callSession";
const MAX_RECONNECT_ATTEMPTS = 8;
const MAX_RECONNECT_DELAY_MS = 4000;

function savedSession(): string | undefined {
  try {
    return localStorage.getItem(SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveSession(id: string | undefined) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode can block storage. The call still works, it just cannot be resumed after a reload.
  }
}

// ?phase=speaking shows the page in that state, with sample content and without a call, to preview the design.
const previewPhase = new URLSearchParams(location.search).get("phase") as Phase | null;

export function useCall() {
  const [phase, setPhase] = useState<Phase>(previewPhase ?? "idle");
  const [summary, setSummary] = useState<Summary>(previewPhase ? PREVIEW_SUMMARY : EMPTY_SUMMARY);
  const [timeline, setTimeline] = useState<TimelineItem[]>(previewPhase ? PREVIEW_TIMELINE : []);
  const [interim, setInterim] = useState(previewPhase === "listening" ? PREVIEW_INTERIM : "");
  const [canResume, setCanResume] = useState(() => !previewPhase && savedSession() !== undefined);

  const call = useRef<ActiveCall | undefined>(undefined);
  const asking = useRef(false);
  const startedAt = useRef(0);
  const nextId = useRef(0);
  // end is defined further down, and messages need to reach it.
  const endRef = useRef(() => {});
  const gapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const addToTimeline = useCallback((kind: TimelineItem["kind"], text: string, technical = false) => {
    const seconds = Math.floor((Date.now() - startedAt.current) / 1000);
    setTimeline((items) => [...items, { id: nextId.current++, seconds, kind, text, technical }]);
  }, []);

  const onMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "user":
          setInterim("");
          setPhase("thinking");
          return addToTimeline("user", message.text);
        case "agent":
          return addToTimeline("agent", message.text);
        case "log":
          return addToTimeline(message.kind, message.text);
        case "backend":
          return addToTimeline("backend", message.text, message.mode === "ok");
        case "interim":
          return setInterim(message.text);
        case "state":
          setSummary((old) => ({ ...old, stage: message.stage, trackingId: message.trackingId, idConfirmed: message.idConfirmed, bookings: message.bookings }));
          // A finished call cannot be resumed, so the next one starts fresh.
          if (message.stage === "DONE") saveSession(undefined);
          return setPhase((current) => (current === "connecting" || current === "reconnecting" ? "listening" : current));
        case "metric":
          if (message.name === "response") setSummary((old) => ({ ...old, responseMs: message.ms }));
          return;
        case "hangup":
          return endRef.current();
        case "stop_audio":
          call.current?.player.stop();
          speechSynthesis.cancel();
          return setPhase("listening");
        case "speak_fallback": {
          const speech = new SpeechSynthesisUtterance(message.text);
          speech.onend = () => setPhase("listening");
          setPhase("speaking");
          return speechSynthesis.speak(speech);
        }
      }
    },
    [addToTimeline],
  );

  // The caller hung up on purpose. The server forgets the call, so it cannot be resumed.
  const end = useCallback(() => {
    const ended = call.current;
    call.current = undefined;
    clearTimeout(gapTimer.current);
    if (ended) {
      ended.ended = true;
      if (ended.socket?.readyState === WebSocket.OPEN) ended.socket.send(JSON.stringify({ type: "hangup" }));
      ended.socket?.close();
      ended.mic.stop();
    }
    saveSession(undefined);
    setCanResume(false);
    speechSynthesis.cancel();
    setPhase("idle");
    setInterim("");
  }, []);

  endRef.current = end;

  // Opens the connection for the current call. If it drops, tries again with the same session id.
  const connect = useCallback(() => {
    const active = call.current;
    if (!active || active.ended) return;

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws?session=${active.sessionId}`);
    socket.binaryType = "arraybuffer";
    active.socket = socket;

    socket.onopen = () => {
      if (!active.lost) return;
      active.lost = false;
      active.attempts = 0;
      addToTimeline("good", "Connection restored");
    };
    socket.onmessage = (event) => (typeof event.data === "string" ? onMessage(JSON.parse(event.data)) : active.player.play(event.data));
    socket.onclose = () => {
      if (call.current !== active || active.ended) return;

      active.player.stop();
      speechSynthesis.cancel();
      setInterim("");
      setPhase("reconnecting");
      if (!active.lost) {
        active.lost = true;
        addToTimeline("warn", "The connection dropped. Reconnecting, the call will pick up where it left off.");
      }
      if (++active.attempts > MAX_RECONNECT_ATTEMPTS) {
        addToTimeline("bad", "Could not reconnect. Press Resume call to try again.");
        active.ended = true;
        call.current = undefined;
        active.mic.stop();
        setCanResume(true);
        return setPhase("idle");
      }
      setTimeout(connect, Math.min(1000 * active.attempts, MAX_RECONNECT_DELAY_MS));
    };
  }, [addToTimeline, onMessage]);

  const start = useCallback(async () => {
    if (call.current || asking.current) return;
    asking.current = true;
    setPhase("connecting");

    let mic: Mic;
    try {
      mic = await startMic({
        onAudio: (audio) => call.current?.socket?.readyState === WebSocket.OPEN && call.current.socket.send(audio),
        onSpeech: () => call.current?.player.duck(),
        agentLevel: () => call.current?.player.level() ?? 0,
      });
    } catch {
      setPhase("idle");
      addToTimeline("bad", "The microphone is blocked. Allow microphone access in the browser and try again.");
      return;
    } finally {
      asking.current = false;
    }

    // A saved session means the last call was cut off, so carry on with it.
    const resumed = savedSession();
    const sessionId = resumed ?? crypto.randomUUID();
    saveSession(sessionId);
    setCanResume(false);

    startedAt.current = Date.now();
    setTimeline([]);
    setSummary(EMPTY_SUMMARY);
    if (resumed) addToTimeline("info", "Resuming your previous call");

    const player = createPlayer(mic.context, {
      onPlaying: () => {
        clearTimeout(gapTimer.current);
        setPhase("speaking");
      },
      onIdle: () => {
        gapTimer.current = setTimeout(() => setPhase((current) => (current === "speaking" ? "listening" : current)), SPEAKING_GAP_MS);
      },
    });

    call.current = { mic, player, sessionId, ended: false, attempts: 0, lost: false };
    connect();
  }, [addToTimeline, connect]);

  // Closing the page is not hanging up. The call stays on the server for a while so it can be resumed.
  useEffect(
    () => () => {
      const active = call.current;
      if (!active) return;
      active.ended = true;
      active.socket?.close();
      active.mic.stop();
    },
    [],
  );

  // How loud each side is right now. The orb reads these many times a second, so they are not React state.
  const levels = useRef<Levels>({
    agent: () => call.current?.player.level() ?? 0,
    caller: () => call.current?.mic.level() ?? 0,
  }).current;

  // While the booking is being made the agent is working even if it is quiet.
  const shown: Phase = phase === "listening" && summary.stage === "BOOKING" ? "thinking" : phase;

  return { phase: shown, ...summary, timeline, interim, canResume, start, end, levels };
}
