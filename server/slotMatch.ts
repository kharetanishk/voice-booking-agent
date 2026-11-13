import type { Slot } from "./fakeBackend";

// Which slot the caller's words point to. Works without the LLM, so "Sunday at 4 PM" or "option two" is instant.
// slot: one slot fits. options: several fit, so the caller picks from them.
// instead: what the caller asked for that is not on offer, when the match is the closest thing to it.
export type SlotMatch = ({ slot: Slot } | { options: Slot[] }) & { instead?: string };

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const N = `(\\d{1,2}|${Object.keys(NUMBERS).join("|")})`;
const toNumber = (word: string) => NUMBERS[word] ?? Number(word);

const ORDINALS = [/\b(first|1st)\b/, /\b(second|2nd)\b/, /\b(third|3rd)\b/];
const NAMED_OPTION = /\b(?:option|number|slot|choice)\s+(one|two|three|[1-3])\b/;
// The whole answer is just a number, maybe with a few words around it: "two", "I'll take three please".
const BARE_NUMBER = /^(?:(?:um|uh|the|ok|okay|ill take|take|lets do|lets go with|go with|i want)\s+)*(one|two|three|[1-3])(?:\s+please)?$/;

// "at four", "4 pm", "four o'clock", "4 to 6", "ten thirty". A bare number word is not a time, so "the evening one" is not 1 PM.
const TIME = new RegExp(
  `(?:\\b(at|around|about|by|after|before|from)\\s+)?\\b${N}(?::\\d{2})?(?:\\s*(am|pm|oclock|thirty|fifteen|forty five))?(?!\\w)(\\s+(?:to|till|until|or)\\s+${N})?`,
  "g",
);

const PERIODS: [RegExp, Slot["period"]][] = [
  [/\bmorning\b/, "morning"],
  [/\b(afternoon|noon|midday|lunch ?time)\b/, "afternoon"],
  [/\b(evening|tonight|night)\b/, "evening"],
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// The same weekday names the backend puts on its slots.
const weekdayIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-US", { weekday: "long" });

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\ba\.?\s?m\b\.?/g, "am")
    .replace(/\bp\.?\s?m\b\.?/g, "pm")
    .replace(/\bo\s?'?\s?clock\b/g, "oclock")
    .replace(/'/g, "")
    .replace(/[^a-z0-9:]+/g, " ")
    .trim();
}

function position(t: string, count: number): number | undefined {
  // "wait a second" is not the second slot.
  const ordinal = ORDINALS.findIndex((pattern) => pattern.test(t.replace(/\b(a|one) (second|sec)\b/g, "")));
  if (ordinal >= 0) return ordinal;
  if (/\b(last|final) one\b/.test(t)) return count - 1;
  const named = t.match(NAMED_OPTION) ?? t.match(BARE_NUMBER);
  return named ? toNumber(named[1]!) - 1 : undefined;
}

function dayNamed(t: string): string | undefined {
  if (/\bday after tomorrow\b/.test(t)) return weekdayIn(2);
  if (/\btomorrow\b/.test(t)) return weekdayIn(1);
  if (/\btoday\b/.test(t)) return weekdayIn(0);
  const day = WEEKDAYS.find((name) => new RegExp(`\\b${name}\\b`).test(t));
  return day && day[0]!.toUpperCase() + day.slice(1);
}

// The hour on a 24-hour clock. Without AM or PM, 7 to 11 is the morning and 1 to 6 the afternoon, as people mean it.
export function hourNamed(text: string): number | undefined {
  for (const match of normalize(text).matchAll(TIME)) {
    const [, before, number, after, range] = match;
    const isDigits = /^\d/.test(number!);
    if (!isDigits && !before && !after && !range) continue;
    const n = toNumber(number!);
    if (n > 23) continue;
    if (after === "pm") return n < 12 ? n + 12 : n;
    if (after === "am") return n === 12 ? 0 : n;
    if (n >= 13 || (n >= 7 && n <= 12)) return n;
    if (n >= 1) return n + 12;
  }
}

export function spokenHour(hour: number): string {
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

const distance = (slot: Slot, hour: number) => (hour < slot.start ? slot.start - hour : hour > slot.end ? hour - slot.end : 0);

// The first three slots are the ones read out to the caller, so "the second one" and a plain "evening" mean those.
export function matchSlot(slots: Slot[], text: string): SlotMatch | undefined {
  const offered = slots.slice(0, 3);
  const t = normalize(text);

  const index = position(t, offered.length);
  if (index !== undefined) return offered[index] ? { slot: offered[index] } : undefined;

  const day = dayNamed(t);
  const hour = hourNamed(t);
  const period = PERIODS.find(([pattern]) => pattern.test(t))?.[1];
  if (!day && hour === undefined && !period) return;

  const missing: string[] = [];
  let pool = day ? slots.filter((slot) => slot.day === day) : slots;
  if (!pool.length) {
    missing.push(`on ${day}`);
    pool = offered;
  }
  if (hour !== undefined) {
    const fits = pool.filter((slot) => distance(slot, hour) === 0);
    if (fits.length) pool = fits;
    else {
      missing.push(`at ${spokenHour(hour)}`);
      pool = [pool.reduce((a, b) => (distance(b, hour) < distance(a, hour) ? b : a))];
    }
  } else if (period) {
    const fits = pool.filter((slot) => slot.period === period);
    if (fits.length) pool = fits;
    else missing.push(`in the ${period}`);
  }

  const preferred = pool.filter((slot) => offered.includes(slot));
  const best = preferred.length ? preferred : pool;
  const instead = missing.length ? `anything ${missing.join(" ")}` : undefined;
  return best.length === 1 ? { slot: best[0]!, instead } : { options: best, instead };
}
