// Tracking ID: two letters then six digits, for example BD418207.

const NATO_WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
  "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo",
  "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu",
];

const LETTER_NAMES = {
  bee: "B", cee: "C", dee: "D", gee: "G", jay: "J", kay: "K",
  pee: "P", tee: "T", vee: "V", zee: "Z", em: "M", en: "N", ex: "X",
};

const DIGIT_WORDS = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

const WORDS = new Map<string, string>([
  ...NATO_WORDS.map((word, i): [string, string] => [word, String.fromCharCode(65 + i)]),
  ["alfa", "A"],
  ["juliett", "J"],
  ...Object.entries(LETTER_NAMES),
  ...Object.entries(DIGIT_WORDS),
]);

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
// "the third digit", "the last digit", "the last two digits", "the first letter".
const COUNTS: Record<string, number> = { two: 2, three: 3, four: 4, "2": 2, "3": 3, "4": 4 };
const POSITION_PATTERN = new RegExp(
  `\\b(last|${ORDINALS.join("|")})(?:\\s+(two|three|four|2|3|4))?\\s+(digit|letter|character|number)s?\\b`,
);
const AS_IN_PATTERN = new RegExp(`\\b[a-z0-9]+\\s+(?:as in|for)\\s+(${NATO_WORDS.join("|")})\\b`, "g");

export const ID_LENGTH = 8;

export function isValid(id: string): boolean {
  return /^[A-Z]{2}\d{6}$/.test(id);
}

// "B as in Bravo, D as in Delta, 4 1 8 2 0 7". Digits have no commas so the voice does not stall on each one.
export function spell(id: string): string {
  return [...id]
    .map((c, i) => {
      if (/\d/.test(c)) return (/\d/.test(id[i - 1] ?? "") ? " " : i ? ", " : "") + c;
      const word = NATO_WORDS[c.charCodeAt(0) - 65]!;
      return `${i ? ", " : ""}${c} as in ${word[0]!.toUpperCase()}${word.slice(1)}`;
    })
    .join("");
}

// True while the characters could still become a valid ID: up to two letters, then digits.
export function hasValidShape(id: string): boolean {
  return /^([A-Z]{0,2}|[A-Z]{2}\d{0,6})$/.test(id);
}

// True if the text sounds like someone reading out an ID, as opposed to talking about something else.
export function hasIdSpeech(text: string): boolean {
  return idSpeechIn(simplify(text)) !== "";
}

// The ID characters in the text, whatever is said around them. Empty if it does not sound like an ID.
export function idCharsIn(text: string): string {
  const speech = idSpeechIn(simplify(text));
  return speech ? fit(toChars(speech, true)) : "";
}

// Is this the start of someone reading out an ID? A letter, or a few characters, is enough. A single digit is not,
// so "the second one" is an answer and not an ID.
export function looksLikeIdStart(text: string): boolean {
  const chars = idCharsIn(text);
  return chars.length >= MIN_START_CHARS || /[A-Z]/.test(chars);
}
const MIN_START_CHARS = 3;

// The part of the text that is ID speech. If the whole text is mostly ID words, all of it. Otherwise only a long
// run of ID words inside it, which is how a caller's digits show up when someone else is talking over them.
function idSpeechIn(clean: string): string {
  if (looksLikeAnId(clean) && toChars(clean, true).length > 0) return clean;
  return longestIdRun(clean);
}

const MIN_RUN_WORDS = 4;

function longestIdRun(clean: string): string {
  let best: string[] = [];
  let run: string[] = [];
  for (const word of clean.split(/\s+/).filter(Boolean)) {
    if (WORDS.has(word) || /^\d+$/.test(word)) run.push(word);
    else if (!(NEUTRAL_WORDS.has(word) && run.length)) run = [];
    if (run.length > best.length) best = [...run];
  }
  return best.length >= MIN_RUN_WORDS ? best.join(" ") : "";
}

// Where in the ID a correction points to, and where the new value starts in the text.
function findPosition(clean: string) {
  const match = clean.match(POSITION_PATTERN);
  if (!match) return;
  const count = COUNTS[match[2] ?? ""] ?? 1;
  const kind = match[3];
  const [from, size] = kind === "letter" ? [0, 2] : kind === "character" ? [0, ID_LENGTH] : [2, ID_LENGTH - 2];
  const start = match[1] === "last" ? from + size - count : from + ORDINALS.indexOf(match[1]!);
  return { start, count, end: match.index! + match[0].length };
}

// "no, the last two digits" with no new value yet. The value usually follows in the next breath.
export function namesPositionOnly(text: string): boolean {
  const clean = simplify(text);
  const position = findPosition(clean);
  return position !== undefined && toChars(clean.slice(position.end)).length < position.count;
}

// Adds what the caller just said to the ID, or applies a correction if they made one.
export function updateId(current: string, text: string): string {
  const clean = simplify(text);

  const position = findPosition(clean);
  if (position) {
    const right = toChars(clean.slice(position.end)).slice(0, position.count);
    if (right.length < position.count) return current;
    return right.reduce((id, char, offset) => replaceAt(id, position.start + offset, char), current);
  }

  const [before = "", after] = clean.split(/\bnot\b/);
  if (after !== undefined) {
    const [right] = toChars(before);
    const [wrong] = toChars(after);
    if (!right || !wrong) return current;
    return replaceAt(current, current.indexOf(wrong), right);
  }

  // Anything else is new characters. Talk that is not about an ID, like people in the background, adds nothing.
  const speech = idSpeechIn(clean);
  if (!speech) return current;
  return fit([...current, ...toChars(speech, true)]);
}

function simplify(text: string): string {
  return text
    .toLowerCase()
    .replace(/x[- ]ray/g, "xray")
    .replace(AS_IN_PATTERN, "$1")
    .replace(/'/g, "")
    .replace(/[^a-z0-9 ]/g, " ");
}

// Words that can sit around an ID without being part of it.
const NEUTRAL_WORDS = new Set([
  "as", "in", "for", "double", "triple", "and", "then", "is", "its", "it", "thats", "my", "id", "tracking",
  "number", "the", "um", "uh", "okay", "ok", "so", "yes", "yeah", "no", "its", "said", "i",
]);

const COMMON_TWO_LETTER_WORDS = new Set([
  "am", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it", "me", "my", "no", "of", "oh", "ok", "on",
  "or", "so", "to", "up", "us", "we", "hi", "ha", "hm", "mm", "uh", "um", "ah", "er", "ya", "yo", "eh",
  "id", "pm", "ai", "tv", "mr", "ms", "dr", "st", "pa", "ma", "yes",
]);
// The recognizer often writes two spoken letters as one word: "dd", "bd".
const isLetterPair = (word: string) => /^[a-z]{2}$/.test(word) && !COMMON_TWO_LETTER_WORDS.has(word);
const isDigitWord = (word: string) => /^\d+$/.test(word) || DIGIT_WORD_SET.has(word);
const DIGIT_WORD_SET = new Set(Object.keys(DIGIT_WORDS));

const isIdWord = (word: string) => WORDS.has(word) || /^([a-z0-9]|\d+|[a-z]{2}\d+)$/.test(word) || isLetterPair(word);

// Someone reading out an ID says mostly ID words. Background chatter has many other words.
function looksLikeAnId(clean: string): boolean {
  const words = clean.split(/\s+/).filter(Boolean);
  const idWords = words.filter(isIdWord).length;
  const others = words.filter((word) => !isIdWord(word) && !NEUTRAL_WORDS.has(word)).length;
  return idWords > 0 && others <= idWords;
}

// Ignores words that are not part of an ID. A lone letter, digits, or "bd418" style words count.
// When strict, a lone letter only counts next to another ID word, so the "a" in "a few minutes" is skipped.
function toChars(text: string, strict = false): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let repeat = 1;
  for (const [index, word] of words.entries()) {
    if (word === "double") repeat = 2;
    else if (word === "triple") repeat = 3;
    else {
      const alone = /^[a-z]$/.test(word) && !WORDS.has(word);
      const next = words[index + 1];
      const before = words[index - 1];
      // "the second one" is an answer to "which slot", so the "one" after an ordinal is not a digit.
      const answeringWhich = before !== undefined && ORDINALS.includes(before) && /^(one|[1-9])$/.test(word);
      const skip = answeringWhich || (strict && alone && !(next && isIdWord(next)) && !(before && isIdWord(before)));
      // The recognizer often writes the two letters as one word, "ab nine zero ...".
      // Followed by digits, or said on its own as the answer to "what are the letters?".
      const pairOfLetters = isLetterPair(word) && (next === undefined ? out.length === 0 : isDigitWord(next));
      const found = skip
        ? ""
        : (WORDS.get(word) ?? (/^([a-z0-9]|\d+|[a-z]{2}\d+)$/.test(word) || pairOfLetters ? word.toUpperCase() : ""));
      for (const c of found) out.push(...Array<string>(repeat).fill(c));
      repeat = 1;
    }
  }
  return out;
}

function replaceAt(id: string, index: number, char: string): string {
  if (index < 0 || index >= id.length) return id;
  return fit([...id.slice(0, index), char, ...id.slice(index + 1)]);
}

// Positions 0-1 must be letters and 2-7 digits, so "oh" becomes O or 0 by position.
function fit(chars: string[]): string {
  return chars
    .map((c, i) => (i < 2 ? (c === "0" ? "O" : c) : c === "O" ? "0" : c))
    .join("")
    .slice(0, ID_LENGTH);
}
