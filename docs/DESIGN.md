# Design notes: reschedule-a-delivery voice agent

The decisions behind the agent, what was deliberately left out, and where it is still weak.

## What I chose, and why

**1. Code owns the conversation, the LLM only helps.**
A small state machine (ask ID → confirm ID → offer slots → confirm slot → book) decides everything. The LLM is called only when the rules don't understand the caller. It can't act on its own: it can only answer with one of `YES`, `NO`, `SLOT n`, `GOODBYE`, `IGNORE`, or `SAY <reply>`, and the code checks that decision.
*Why:* an LLM can be talked into things or can drift. Booking the wrong slot is the expensive mistake here, so the rules that prevent it live in code. A vague yes the LLM reads in ("eh, I guess that works") still gets *"Just to be sure, shall I book…?"*.

**2. The tracking ID is parsed by code, not by the LLM.**
It handles phonetic letters, *"double five"*, *"oh"* as zero, two letters run together as *"ab"*, and corrections like *"B not D"*, *"the last two digits are one three"*, or a fix said in two breaths. The ID is read back as *"B as in Bravo"* and nothing moves on until a plain yes. Changing it later resets everything that depended on it.
*Why:* in a noisy car, one wrong character means booking somebody else's parcel. Deterministic code is testable and never invents digits.

**3. No double-booking, by design.**
Each booking carries one idempotency key, saved before the request is sent. Retries reuse it, and the fake backend dedupes on it. If every reply is lost, the agent checks the booking status before saying anything. Anything slow gets *"one moment, still checking"* within 1.5 s.

**4. Barge-in in two layers.**
The browser dips the agent's voice the moment the caller makes a sound, which feels instant. The server then stops the agent only if real words arrive that fit the current question. Echo of its own voice, "um", and people talking nearby don't count.

**5. One small repo, no turnkey platform.**
- Bun with a single process, plus React and Tailwind.
- Deepgram for listening (nova-3, streaming) and speaking (Aura-2, streamed as raw PCM).
- Gemini on Vertex AI for the LLM, through its OpenAI-compatible endpoint. OpenRouter works as a drop-in alternative.
- The setup is `bun install` plus a Deepgram key and one LLM credential.
*Why:* owning every hop of the pipeline is the only way to control turn-taking, barge-in and latency precisely, and to see exactly where time goes.

**6. A swappable brain.**
Every LLM speaks the same OpenAI-compatible protocol, so moving between Vertex AI and OpenRouter is a config change.
*Why:* providers change price, quota and quality from month to month. The pipeline should not care.

**7. Gemini Flash Lite, not a bigger model.**
Measured on Vertex AI with the agent's real prompts: Flash Lite starts answering in 0.85 to 1.5 s, larger Flash models took 2 to 17 s because they think before answering. The LLM only phrases replies and classifies off-script turns, so speed matters more than depth.

## What I cut

| Cut | Why it's fine for now |
|---|---|
| Database, Redis | Calls and bookings live in memory. One process, one demo |
| Telephony, auth, multiple languages | Not asked for |
| Streaming LLM to speech | The LLM runs only on unusual turns and rarely sends long replies, so the gain was small |
| A trained turn-detection or noise model | Tuned rules and confidence thresholds got most of the way for much less work |
| A web of microservices | A single file per concern is easier to review and to run in five minutes |

## What's broken or weak

- **Two voices at the same loudness.** If someone next to the caller talks as loud as the caller, the recognizer merges them into one sentence. The agent never confirms or books on that, but it may need the ID repeated.
- **A lone "yes"** is sometimes missed by the recognizer, so the agent asks again. Safe, but slower.
- **LLM outages.** Models get rate-limited, return empty answers, or time out. When every model in the cascade fails, the agent falls back to fixed replies, so it never goes silent, but it loses the smart layer.
- **Distance to the speech provider.** The production server is in India and Deepgram's speech endpoints are in the US, so the first byte of synthesized speech takes about 0.75 to 0.9 s. Hosted in the US, the same call measured 0.14 to 0.3 s.
- **Memory only.** A server restart loses calls in progress and bookings.
- **Tested mostly with synthetic voices** (generated speech, fake car noise and chatter) plus one real browser session. Not yet with many real callers or real road noise.

## What I'd do next

1. **Measure before tuning:** record real noisy calls and track how often the ID is captured right first time and how long it takes to book.
2. **Better listening:** a proper voice-activity model on the client, and per-speaker separation, to beat the two-voices problem.
3. **Persistence:** Redis for sessions and Postgres for bookings, so calls survive a restart and the server can scale out.
4. **Stream LLM replies into speech** for longer answers, and keep a persistent TTS socket open per call to remove the per-sentence connection setup.
5. **Real backend integration** behind the same idempotent booking interface, with alerting on the "outcome unknown" case.
