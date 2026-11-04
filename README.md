# Voice Booking Agent

[![CI](https://github.com/kharetanishk/voice-booking-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/kharetanishk/voice-booking-agent/actions/workflows/ci.yml)

A real-time voice agent that reschedules parcel deliveries. You talk to it in the browser: it asks for your tracking ID, reads it back phonetically, offers delivery slots and books one when you say yes. The courier backend behind it is fake and misbehaves on purpose (slow, failing, losing replies, hanging), and the agent copes without going silent and without ever booking twice.

**Live demo: <https://voice-agent.lunarnodes.co.in>** (Chrome, headphones recommended)

The whole voice pipeline is assembled by hand. There is no voice-agent platform (no Vapi, Retell or LiveKit Agents), so turn-taking, barge-in, latency and failure handling are all in this repo and all tested.

```
 Browser                                   Bun server (one state machine per call)
┌──────────────────────────┐   WebSocket   ┌──────────────────────────────────────────────────────────┐
│ AudioWorklet mic, 16 kHz │──PCM16 up────►│ Deepgram nova-3 streaming STT                            │
│ Energy VAD, adaptive     │               │   keyterm boosting for the NATO alphabet, interims       │
│   noise floor            │               │ Turn assembly: pauses, half-read IDs, "still talking"    │
│ Ducks agent audio the    │               │ Barge-in filter: echo, fillers, confidence, relevance    │
│   instant you speak      │               │ Brain: deterministic state machine + tracking-ID parser  │
│ Gapless 24 kHz playback  │◄─PCM + events─│   Gemini only for off-script turns, constrained output   │
│ Live timeline + metrics  │               │ Booking client: idempotency key, retries, status check   │
└──────────────────────────┘               │ Deepgram Aura-2 TTS, streamed sentence by sentence       │
                                           └───────────────────────────┬──────────────────────────────┘
                                                                       ▼
                                                     Fake courier API (chaos modes)
```

---

## Engineering highlights

### Turn-taking and barge-in, in two layers
- **In the browser (instant):** an energy VAD learns the room's noise floor during the first second, then needs speech 3.5× louder than the background for about 200 ms, with the bar raised by the agent's own playback level to ignore echo. The moment it fires, the agent's audio is ducked to 25%, so cutting in feels immediate even before the server has heard a word.
- **On the server (decisive):** the agent only stops if real words arrive on Deepgram's *interim* results: fillers ("um", "mhm") are dropped, low-confidence speech (< 0.6) is treated as background voices, three or more words that match what the agent is saying are treated as echo, and the words must be relevant to the current question. A real interruption aborts the TTS stream and flushes the browser's queued audio. If nothing useful follows within 3.5 s, the agent says *"Sorry, as I was saying…"* and carries on.

### Understanding tracking IDs by code, not by the LLM
`server/trackingId.ts` turns speech into an ID: NATO words, *"B as in Bravo"*, *"double five"*, *"oh"* as zero, letters run together, and corrections such as *"B not D"* or *"the last two digits are one three"*, even when the fix comes in a second breath. Callers pause between characters, so a half-read ID waits up to 1.6 s for the rest instead of being answered early. Nothing moves on until a plain yes to the read-back.

### An LLM with guardrails
A small state machine owns the conversation. Gemini is consulted only when the rules don't understand the caller, and it can only answer with `YES`, `NO`, `SLOT n`, `GOODBYE`, `IGNORE` or `SAY <reply>`, which the code then checks. A vague yes still gets *"Just to be sure, shall I book…?"*. Models are tried as a cascade, each with a 2.2 s budget inside a 4.5 s total, rate-limited models are rested for 60 s, and if every model fails the agent falls back to fixed replies. It never goes silent.

### Exactly-once booking under failure
Each booking gets one idempotency key, saved before the request is sent. Retries reuse it and the backend dedupes on it. If every reply is lost, the agent checks the booking status before telling the caller anything. Anything slow gets *"one moment, still checking"* within 1.5 s.

### Calls that survive the real world
- **Dropped connection:** close the tab mid-call, reopen it, press **Resume call**. The session is kept for 10 minutes and the browser reconnects with backoff, so the agent says *"Welcome back"* and continues from the same step.
- **Silence:** after 8 s of silence the agent asks again (*"Sorry, I cannot hear you…"*), up to three times. *"Hold on a second"* gets a quiet 30 s wait.
- **Background talk:** chatter nearby that isn't about the delivery is ignored and doesn't reset the silence watchdog.

### Observability
Every event prints one coloured line on the server (`HEARD`, `AGENT`, `BRAIN`, `BACKEND`, `BARGE-IN`, `VOICE`…) and appears on the page's live timeline, together with two measured latencies per reply: time to first synthesized audio, and time from the caller's final transcript to the agent's first sound.

---

## Measured latency

From a scripted call against the live deployment (synthetic caller audio streamed in real time):

| Turn | Agent's first sound after the caller's final transcript |
|---|---|
| Handled by the rules (read-back, slot offer, booking) | 0.75 to 1.2 s |
| Needs Gemini (off-script question or remark) | 1.5 to 2.3 s |

Most of the rule-handled time is the first byte of synthesized speech (0.75 to 0.9 s), because the server is in India and Deepgram's speech endpoints are in the US. Hosted in the US, the same pipeline measured 0.14 to 0.3 s to first audio.

---

## Things to try

| Try this | What should happen |
|---|---|
| Give a wrong letter, then say *"no, B as in Bravo, not D"* | Only that letter changes, then it reads the ID back again |
| *"the last two digits are one three"* | Fixes just those two digits |
| Talk over the agent while it is speaking | It stops at once and listens |
| *"why do you need my tracking ID?"*, *"what's the weather?"* | An honest short answer, then it carries on |
| *"hold on a second"* | It waits quietly |
| Say a completely different ID after confirming one | It reads the new one back and needs a fresh yes |
| *"you can end the call"* | It says goodbye and hangs up |
| Close the tab mid-call, reopen, press **Resume call** | *"Welcome back"*, and it carries on from the same step |

A tracking ID is two letters and six digits, for example *"B as in Bravo, D as in Delta, four one eight two zero seven"*.

### Stress test the booking system
The bar under the timeline changes how the fake courier API behaves on the **booking request**. Everything before the booking stays normal, so you always get to see the behaviour you picked.

| Option | What the agent does |
|---|---|
| Random | Each request may be fast, slow, failing or lose its reply (slot lookups can misbehave too) |
| Always works | Books straight away |
| Slow (6 s) | Says *"one moment, still checking"*, then books |
| Fails | Retries, then says *"nothing has been booked, shall I try again?"* |
| Loses the reply | The booking is saved but the reply is lost. It retries with the same key and finds it: exactly one booking |
| Never answers | Gives up after about 17 s and says so honestly |

**Bookings made** on the page, and `/api/bookings`, show that nothing is ever booked twice.

---

## Run it locally

You need [Bun](https://bun.sh) 1.2 or newer, Chrome with a microphone, a [Deepgram](https://console.deepgram.com) key, and one LLM credential.

```bash
git clone https://github.com/kharetanishk/voice-booking-agent.git && cd voice-booking-agent
bun install
cp .env.example .env    # fill in DEEPGRAM_API_KEY and an LLM (see below)
bun run dev             # http://localhost:3000
```

For the LLM, either:
- **Gemini on Vertex AI:** set `VERTEX_PROJECT`, and for local development `GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)` instead of a key file, or
- **OpenRouter:** set `OPENROUTER_API_KEY` (free models work).

Without any LLM the agent still runs on its rules alone.

```bash
bun test            # 166 tests, no keys needed
bun run typecheck   # strict TypeScript, server and browser
bun server/chat.ts  # the same agent as a text chat in the terminal
```

---

## Production deployment

The live demo runs as a Docker container behind nginx on a Linux VM:

```bash
docker build -t voice-agent .
docker run -d --name voice-agent --restart unless-stopped \
  -p 127.0.0.1:3040:3000 \
  --env-file /root/voice-agent.env \
  -v /root/voice-agent-key.json:/key.json:ro \
  --memory 512m --log-opt max-size=10m --log-opt max-file=3 \
  voice-agent
```

- **Network:** the container only listens on localhost. nginx terminates TLS (Let's Encrypt via certbot) and proxies the WebSocket with upgrade headers and a one-hour timeout. See [`deploy/nginx.conf`](deploy/nginx.conf).
- **Secrets:** the env file and the service account key are readable only by root, mounted read-only, and never baked into the image (`.dockerignore` excludes `.env`).
- **LLM credentials:** a dedicated service account with only `roles/aiplatform.user`. The server signs a JWT with its key and exchanges it for an access token, cached until a minute before expiry. No Google SDK dependency.
- **One instance:** calls and bookings live in memory, so the service runs as a single instance. Postgres and Redis are the next step for horizontal scaling (see the design notes).

---

## Configuration

| Setting | Required | What it does |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes | Speech to text and the standard voice |
| `VERTEX_PROJECT` | one LLM option | Google Cloud project for Gemini on Vertex AI |
| `GOOGLE_APPLICATION_CREDENTIALS` | with Vertex | Path to the service account key file |
| `VERTEX_MODEL` | no | Gemini models, tried in order. Default: Flash Lite 3.5, then 3.1 |
| `OPENROUTER_API_KEY` | other LLM option | OpenRouter instead of Vertex AI |
| `OPENROUTER_MODEL` | no | OpenRouter models for the standard tier, tried in order |
| `OPENROUTER_PAID_MODEL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` | no | The Premium tier: paid models and an ElevenLabs voice |
| `PORT` | no | Defaults to 3000 |

---

## Project layout

| Path | What lives there |
|---|---|
| `server/index.ts` | Web server, WebSocket, stress test and booking endpoints |
| `server/call.ts` | One live call: listening, turn assembly, barge-in, silence, speaking, hang-up |
| `server/brain.ts` | The conversation. Code owns the state and the rules; the LLM only helps understand and phrase |
| `server/speech.ts` | Telling the caller apart from echo, fillers and background voices |
| `server/trackingId.ts` | Turns speech into an ID, including corrections |
| `server/booking.ts` | Safe booking: confirm gate, idempotency key, timeouts, retries, status check |
| `server/fakeBackend.ts` | The misbehaving courier API |
| `server/stt.ts`, `server/tts.ts`, `server/llm.ts` | Deepgram, ElevenLabs, Vertex AI and OpenRouter clients |
| `web/` | React + Tailwind page: mic worklet, VAD, playback, agent orb, live timeline, stress test |
| `test/` | 166 tests, one file per part, run in CI on every push |
| `deploy/` | nginx config for production |

For the decisions, what was cut and what is still weak, see **[docs/DESIGN.md](docs/DESIGN.md)**.
