// Streams caller audio (16 kHz PCM16) to Deepgram and reports what was said.

export type Stt = { send: (audio: Uint8Array) => void; close: () => void };

type Handlers = {
  // confidence is how sure the recognizer is, from 0 to 1.
  onInterim: (text: string, confidence?: number) => void;
  // One finished chunk of speech. endOfSpeech says the speaker also paused, so this is probably the end of what they said.
  // Under constant background talk there may never be a pause, so chunks are handled one by one.
  onFinal: (text: string, confidence?: number, endOfSpeech?: boolean) => void;
  // Speech that was heard but too uncertain to trust, for example in loud background noise.
  onUnclear: (text: string, confidence: number) => void;
  // The caller has been quiet for utterance_end_ms: whatever was said so far is all there is.
  onUtteranceEnd?: () => void;
  onError: (message: string) => void;
};

const KEY_TERMS = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike",
  "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "X-ray", "Yankee", "Zulu",
  "as in", "tracking ID",
  // The whole phrase, because a lone letter at the start of a sentence is the part that gets lost.
  ...["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike",
    "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "X-ray", "Yankee", "Zulu"]
    .map((word) => `${word[0]} as in ${word}`),
];

// Wrong characters in a tracking ID are worse than a repeated request, so doubtful speech is dropped.
const MIN_CONFIDENCE = 0.5;

export function createStt(apiKey: string, handlers: Handlers): Stt {
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    endpointing: "700",
    utterance_end_ms: "1500",
  });
  // Tells the recognizer which words to expect, so it hears them correctly even over noise.
  for (const term of KEY_TERMS) params.append("keyterm", term);
  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  const waiting: Uint8Array[] = [];

  socket.onopen = () => {
    for (const audio of waiting.splice(0)) socket.send(audio);
  };
  socket.onerror = () => handlers.onError("Speech recognition connection error");
  socket.onclose = () => handlers.onError("Speech recognition disconnected");
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "UtteranceEnd") return handlers.onUtteranceEnd?.();
    if (message.type !== "Results") return;

    const alternative = message.channel.alternatives[0];
    const text: string = alternative?.transcript ?? "";
    const confidence: number = alternative?.confidence ?? 1;
    if (!text) return;

    if (!message.is_final) return handlers.onInterim(text, confidence);
    if (confidence < MIN_CONFIDENCE) return handlers.onUnclear(text, confidence);
    handlers.onFinal(text, confidence, message.speech_final === true);
  };

  return {
    send: (audio) => (socket.readyState === WebSocket.OPEN ? socket.send(audio) : waiting.push(audio)),
    close: () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
      // Closing a socket that is still opening reports an error. That is expected here, so it is not reported.
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    },
  };
}
