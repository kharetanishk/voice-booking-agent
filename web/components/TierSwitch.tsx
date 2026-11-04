// Picks the brain and voice for the next call. Standard uses Gemini on Vertex AI (or free OpenRouter models)
// and the Deepgram voice, premium uses paid OpenRouter models and the ElevenLabs voice.
import { useEffect, useState } from "react";
import type { Tier } from "../useCall";

const OPTIONS: { tier: Tier; label: string; hint: string }[] = [
  { tier: "free", label: "Standard", hint: "Gemini on Vertex AI and the Deepgram voice." },
  { tier: "premium", label: "Premium", hint: "Paid OpenRouter models and the ElevenLabs voice. Needs OpenRouter credit and an ElevenLabs key." },
];

const STORAGE_KEY = "tier";

export function savedTier(): Tier {
  try {
    return localStorage.getItem(STORAGE_KEY) === "premium" ? "premium" : "free";
  } catch {
    return "free";
  }
}

type Props = { tier: Tier; onChange: (tier: Tier) => void; locked: boolean };

export function TierSwitch({ tier, onChange, locked }: Props) {
  const [premiumReady, setPremiumReady] = useState(true);

  // The server only offers premium when its keys are set.
  useEffect(() => {
    fetch("/api/tiers")
      .then((response) => response.json())
      .then((data: { premium: boolean }) => {
        setPremiumReady(data.premium);
        if (!data.premium) onChange("free");
      })
      .catch(() => {});
  }, [onChange]);

  const choose = (next: Tier) => {
    onChange(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode can block storage. The choice still applies to this visit.
    }
  };

  return (
    <div
      className="glass inline-flex rounded-full p-[3px]"
      role="radiogroup"
      aria-label="Brain and voice"
      title={locked ? "Change this between calls" : OPTIONS.find((option) => option.tier === tier)?.hint}
    >
      {OPTIONS.map((option) => {
        const disabled = locked || (option.tier === "premium" && !premiumReady);
        return (
          <button
            key={option.tier}
            type="button"
            role="radio"
            aria-checked={tier === option.tier}
            disabled={disabled}
            title={option.tier === "premium" && !premiumReady ? "Premium needs OPENROUTER_API_KEY and ELEVENLABS_API_KEY on the server" : option.hint}
            onClick={() => choose(option.tier)}
            className={`rounded-full px-3 py-1 text-xs transition ${
              tier === option.tier ? "gold-surface font-semibold" : "text-muted"
            } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
