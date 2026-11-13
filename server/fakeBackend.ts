// The courier backend behind the demo. In production every request succeeds.
// Tests inject the failure modes below to prove the agent copes with a real, unreliable backend.

export type Mode = "ok" | "slow" | "fail" | "lostack" | "hang";
// start and end are hours on a 24-hour clock, so a time the caller says can be matched to a slot.
export type Slot = { id: string; label: string; day: string; period: "morning" | "afternoon" | "evening"; start: number; end: number };
export type BackendBooking = { ref: string; key: string; slotId: string };

export type CallKind = "slots" | "book" | "status";
export type BackendEvent = { call: CallKind; mode: Mode };

type Options = { normalMs?: number; slowMs?: number; failMs?: number };

// ok: answers fast. slow: answers late. fail: errors, nothing saved.
// lostack: saves the booking but the reply is lost. hang: never answers.

const WINDOWS = [
  { period: "morning", time: "9 AM to 11 AM", start: 9, end: 11 },
  { period: "afternoon", time: "1 PM to 3 PM", start: 13, end: 15 },
  { period: "evening", time: "4 PM to 6 PM", start: 16, end: 18 },
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function slotList(): Slot[] {
  return [1, 2].flatMap((daysAhead) => {
    const date = new Date(Date.now() + daysAhead * 86_400_000);
    const day = date.toLocaleDateString("en-US", { weekday: "long" });
    const iso = date.toISOString().slice(0, 10);
    return WINDOWS.map(({ period, time, start, end }, i) => ({ id: `${iso}-${i + 1}`, label: `${day} ${time}`, day, period, start, end }));
  });
}

export function createBackend({ normalMs = 300, slowMs = 6000, failMs = 500 }: Options = {}) {
  const bookings = new Map<string, BackendBooking>();
  const listeners = new Set<(event: BackendEvent) => void>();

  const backend = {
    bookings,
    // Test only: forces every booking request into one mode.
    // Looking up slots and checking a booking stay normal, so the agent can still recover.
    forced: undefined as Mode | undefined,
    // Test only: modes used by the next calls, in order.
    script: [] as Mode[],

    // Tells the listener what the backend decided to do, before it does it.
    subscribe(listener: (event: BackendEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    pickMode(kind: CallKind = "book"): Mode {
      const scripted = backend.script.shift();
      if (scripted) return scripted;
      return backend.forced && kind === "book" ? backend.forced : "ok";
    },

    slots: () => act("slots", slotList),

    // Booking the same key twice returns the first booking.
    book: (key: string, slotId: string) =>
      act("book", () => {
        const existing = bookings.get(key);
        if (existing) return existing;
        const booking = { ref: `CR-${7000 + bookings.size + 1}`, key, slotId };
        bookings.set(key, booking);
        return booking;
      }),

    status: (key: string) => act("status", () => bookings.get(key) ?? null),
  };

  async function act<T>(call: CallKind, run: () => T): Promise<T> {
    const mode = backend.pickMode(call);
    listeners.forEach((listener) => listener({ call, mode }));
    if (mode === "hang") return new Promise<T>(() => {});
    if (mode === "fail") {
      await sleep(failMs);
      throw new Error("backend error 500");
    }
    await sleep(mode === "slow" ? slowMs : normalMs);
    const result = run();
    if (mode === "lostack") throw new Error("connection reset");
    return result;
  }

  return backend;
}

export type Backend = ReturnType<typeof createBackend>;
