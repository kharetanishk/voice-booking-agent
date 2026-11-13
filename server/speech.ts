// Helpers for telling a caller who is answering us apart from noise, echo and people in the background.
import type { Stage } from "./session";
import { matchIntent } from "./intents";
import { hasIdSpeech, mentionsIdPosition } from "./trackingId";

const FILLER_WORDS = new Set(["um", "uh", "hmm", "mm", "mhm", "ah", "er", "oh"]);

// Echo needs at least this many words. A short answer like "yes" is never treated as echo.
const MIN_ECHO_WORDS = 3;

// Below this the recognizer is guessing, which is what background voices usually look like.
export const MIN_BARGE_IN_CONFIDENCE = 0.6;
// Control words ("yes", "not", "sure") are common in ordinary talk. They only count in a short answer.
const MAX_SHORT_ANSWER_WORDS = 5;

const CONTROL_WORDS =
  /\b(yes|yeah|yep|yup|no|nope|nah|not|wrong|correct|right|stop|wait|hold on|hang on|shut up|be quiet|stop talking|repeat|again|pardon|sorry|actually|cancel|start over|bye|goodbye|thanks|thank you|okay|ok|sure|please|hello|hi|hey|help|huh|confused|understand)\b/i;
const SLOT_WORDS =
  /\b(first|second|third|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|other|another|different|earlier|later)\b/i;
// Talk about the delivery itself is meant for the agent, however long it is.
const DOMAIN_WORDS = /\b(tracking|track|id|parcel|package|delivery|deliver|courier|slot|book|booking|reschedule|reference|digits?|letters?|characters?)\b/i;
const QUESTION_START = /^(what|who|why|how|when|where|can|could|do|does|is|are|will|would|should|may)\b/i;
const MIN_QUESTION_WORDS = 3;

// "I want to change the tracking ID", "that ID is wrong", "it is a different parcel".
const NEW_ID_PATTERNS = [
  /\b(change|correct|redo|update|different|another|new|wrong|incorrect|other)\b[^.?!]{0,30}\b(tracking|id|number)\b/i,
  /\b(tracking|id|number)\b[^.?!]{0,30}\b(wrong|incorrect|different|change|mistake|not right)\b/i,
  /\bnot (my|the) (tracking )?(id|number)\b/i,
  /\b(different|another|other|second) (parcel|package|order)\b/i,
];

export function wantsNewId(text: string): boolean {
  return NEW_ID_PATTERNS.some((pattern) => pattern.test(text));
}

export function realWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !FILLER_WORDS.has(word));
}

export function isQuestion(text: string): boolean {
  return QUESTION_START.test(text.trim()) && realWords(text).length >= MIN_QUESTION_WORDS;
}

// The agent's own voice coming back through the mic: several words, all of which the agent just said.
export function isEcho(words: string[], agentText: string): boolean {
  if (words.length < MIN_ECHO_WORDS) return false;
  const said = new Set(realWords(agentText));
  return words.every((word) => said.has(word));
}

// Does this sound like it belongs to the conversation we are having right now?
// Chatter between other people usually matches none of these.
export function isRelevant(text: string, stage: Stage): boolean {
  // "wait wait wait" is one word said three times, still a short answer.
  const short = new Set(realWords(text)).size <= MAX_SHORT_ANSWER_WORDS;
  if ((short && CONTROL_WORDS.test(text)) || isQuestion(text) || wantsNewId(text) || matchIntent(text) || DOMAIN_WORDS.test(text)) return true;
  // An ID can be changed at any step, so ID speech always counts, and so does "the last digit should be five".
  if (hasIdSpeech(text) || mentionsIdPosition(text)) return true;
  return (stage === "OFFER_SLOTS" || stage === "CONFIRM_SLOT") && SLOT_WORDS.test(text);
}

// True when the caller is genuinely talking over the agent, so the agent should stop.
export function isInterruption(text: string, agentText: string, stage: Stage, confidence = 1): boolean {
  const words = realWords(text);
  if (words.length === 0 || isEcho(words, agentText)) return false;
  return confidence >= MIN_BARGE_IN_CONFIDENCE && isRelevant(text, stage);
}
