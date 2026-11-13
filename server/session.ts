import type { Booking } from "./booking";
import type { Slot } from "./fakeBackend";

export type Stage = "ASK_ID" | "CONFIRM_ID" | "OFFER_SLOTS" | "CONFIRM_SLOT" | "BOOKING" | "DONE";

export type Turn = { role: "user" | "assistant"; text: string };

export type Session = {
  id: string;
  stage: Stage;
  trackingId: string;
  // True only after the caller said yes to this exact ID. Nothing can be booked before that.
  idConfirmed: boolean;
  slots: Slot[];
  chosenSlotId?: string;
  confirmedSlotId?: string;
  booking?: Booking;
  lastSaid: string;
  // The last few things said by each side, so an answer can take the conversation into account.
  history: Turn[];
  // "no, the last two digits": a correction that names the place but not the value yet.
  pendingFix?: string;
  // Digits of the ID heard without its two letters. Kept so the caller only has to add the letters.
  heldDigits?: string;
  // Tracking IDs in a row that did not come out right, so each retry is worded differently.
  idMisses?: number;
  // The caller asked for a moment. The agent waits quietly until this time.
  holdUntil?: number;
  busy: boolean;
  // The turn being worked on right now. A call that reconnects waits for it before speaking.
  turn?: Promise<void>;
};

// How long a dropped call can be picked up again.
export const SESSION_TTL_MS = 10 * 60 * 1000;

export const sessions = new Map<string, Session>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function newSession(id: string): Session {
  return { id, stage: "ASK_ID", trackingId: "", idConfirmed: false, slots: [], lastSaid: "", history: [], busy: false };
}

// A connection is back (or new), so the call is no longer waiting to expire.
export function getSession(id: string): Session {
  clearTimeout(expiryTimers.get(id));
  expiryTimers.delete(id);
  let session = sessions.get(id);
  if (!session) {
    session = newSession(id);
    sessions.set(id, session);
  }
  return session;
}

// The connection dropped. Keep the call for a while in case the caller comes back.
export function releaseSession(id: string, ttlMs = SESSION_TTL_MS) {
  if (!sessions.has(id)) return;
  clearTimeout(expiryTimers.get(id));
  expiryTimers.set(id, setTimeout(() => discardSession(id), ttlMs));
}

// The call is over for good, so a later connection starts fresh.
export function discardSession(id: string) {
  clearTimeout(expiryTimers.get(id));
  expiryTimers.delete(id);
  sessions.delete(id);
}
