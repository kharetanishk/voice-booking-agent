// Things callers say that are not part of the booking. These are answered from fixed rules,
// so they work instantly and always give the same honest answer, with or without an LLM.

export type Intent = { name: string; reply?: string };

// Specific requests come first, so "wait, who am I talking to" is a question about the agent and not a request to wait.
const INTENTS: { name: string; match: RegExp; reply?: string }[] = [
  // The caller can't give the ID at all. Asking for it again would just go round in circles.
  { name: "no ID", match: /\b(don'?t|do not|can'?t|cannot|couldn'?t) (know|have|remember|recall|find|see)\b.{0,25}\b(id|number|code)\b|\b(lost|forgot|misplaced)\b.{0,20}\b(id|number|code)\b|\bno (tracking )?(id|number)\b/i },
  { name: "why the ID", match: /\b(why (do you need|should i (tell|give)|are you asking)|(don'?t|do not|won'?t|will not|not going to) (want to )?(tell|give|share)|is (it|this) safe|privacy)\b/i,
    reply: "I only use the tracking ID to find your delivery and move it to a new slot. I cannot reschedule without it, and I never ask for anything else." },
  { name: "human", match: /\b(human|real person|a person|representative|operator|someone else|customer (service|care|support)|(speak|talk) to (a|someone|somebody))\b/i,
    reply: "I cannot transfer you from here, but I can reschedule your delivery right now." },
  { name: "identity", match: /\b(who are you|who is this|who am i (talking|speaking)|what('?s| is) your name|which company|where are you calling)\b/i,
    reply: "I am the automated assistant for this courier service. I help customers reschedule their deliveries." },
  { name: "robot", match: /\b(are you (a |an )?(robot|bot|real|human|ai|machine|computer)|is this (a |an )?(robot|recording|real))\b/i,
    reply: "I am an automated assistant, not a person, but I can reschedule your delivery for you." },
  { name: "parcel status", match: /\b(where is my (parcel|package|order|delivery)|track (my|the) (parcel|package|order)|status of|has it (shipped|left|arrived)|when (will|is) (it|my (parcel|package|order|delivery)) (arrive|come|be delivered|get here))\b/i,
    reply: "I cannot look up where your parcel is from here. I can only move the delivery to a new slot." },
  { name: "address", match: /\b(change (the |my )?address|different address|another address|wrong address)\b/i,
    reply: "I cannot change the address on this call. I can only change the delivery slot." },
  { name: "cancel or refund", match: /\b(cancel (the |my )?(delivery|order|parcel|package)|return (it|the parcel|the package)|refund)\b/i,
    reply: "I cannot cancel or refund from here. I can only reschedule the delivery." },
  { name: "price", match: /\b(how much|cost|price|charge|fee)\b/i,
    reply: "I cannot quote prices or fees. I can only reschedule the delivery." },
  { name: "how it works", match: /\b(how long|how does (this|it) work|what can you do|what is this (for|about)|why (do you|are you) (need|asking)|what do you need)\b/i,
    reply: "I just need your tracking ID, then I will offer you some new delivery slots. It only takes a minute or so." },
  { name: "goodbye", match: /\b(goodbye|bye|hang up|end (the|this|up the) call|(cut|close|finish|stop) (the|this) call|that'?s (all|it)|we'?re done|i'?m done|no thanks|nothing else|never ?mind|forget it|you can go|i'?ll call (you )?(back|later))\b/i },
  { name: "repeat", match: /\b(repeat|say (that|it) (again|once more)|come again|pardon|what did you say|didn'?t (hear|catch|get)|what was that|sorry,? what)\b/i },
  { name: "wait", match: /\b(wait|hold on|hang on|one (moment|sec|second|minute)|just a (moment|sec|second|minute)|give me a (moment|sec|second|minute|bit)|let me (find|check|look|get|see|grab))\b/i },
  { name: "thanks", match: /\b(thanks|thank you|cheers)\b/i, reply: "You are welcome." },
  { name: "greeting", match: /^\s*(hi|hello|hey|are you there)\b/i, reply: "Hello." },
];

export function matchIntent(text: string): Intent | undefined {
  const found = INTENTS.find((intent) => intent.match.test(text));
  return found && { name: found.name, reply: found.reply };
}
