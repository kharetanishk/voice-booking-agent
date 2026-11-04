import { useRef } from "react";
import { AgentOrb } from "./components/AgentOrb";
import { Stepper } from "./components/Stepper";
import { Timeline } from "./components/Timeline";
import { TrackingTiles } from "./components/TrackingTiles";
import { useCall, type Phase } from "./useCall";

const PHASE_TEXT: Record<Phase, { title: string; caption: string }> = {
  idle: { title: "Ready", caption: "Press start, then say your tracking ID." },
  connecting: { title: "Connecting", caption: "Setting up the microphone and the line." },
  reconnecting: { title: "Reconnecting", caption: "The line dropped. We will pick up where we left off." },
  listening: { title: "Listening", caption: "Go ahead, I am listening." },
  thinking: { title: "Thinking", caption: "Working on it, one moment." },
  speaking: { title: "Speaking", caption: "You can interrupt me at any time." },
};

const SLOW_RESPONSE_MS = 1500;
const BAD_RESPONSE_MS = 3000;

const RESPONSE_COLOURS = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" };

const responseLevel = (ms: number) => (ms < SLOW_RESPONSE_MS ? "good" : ms < BAD_RESPONSE_MS ? "warn" : "bad");

export function App() {
  const call = useCall();
  const active = call.phase !== "idle";
  const text = PHASE_TEXT[call.phase];
  const stage = useRef<HTMLElement>(null);

  // The stage card leans slightly towards the pointer, which gives the glass some depth.
  const lean = (event: React.PointerEvent) => {
    const box = stage.current!.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    stage.current!.style.setProperty("--tilt-x", `${(-y * 6).toFixed(2)}deg`);
    stage.current!.style.setProperty("--tilt-y", `${(x * 8).toFixed(2)}deg`);
  };
  const level = () => {
    stage.current!.style.setProperty("--tilt-x", "0deg");
    stage.current!.style.setProperty("--tilt-y", "0deg");
  };

  return (
    // On a laptop or desktop the whole call fits on one screen. Only the timeline scrolls, and it follows the talk by itself.
    <div className="relative flex min-h-screen flex-col gap-4 overflow-hidden px-[clamp(16px,3vw,40px)] py-4 font-sans text-[15px] leading-normal min-[901px]:h-screen">
      <div className="animate-float pointer-events-none fixed -top-36 -left-32 size-[520px] rounded-full bg-(--scene-a) opacity-75 blur-[90px]" />
      <div className="animate-float pointer-events-none fixed top-[10%] -right-52 size-[600px] rounded-full bg-(--scene-b) opacity-75 blur-[90px] [animation-delay:-7s]" />
      <div className="animate-float pointer-events-none fixed -bottom-56 left-[30%] size-[560px] rounded-full bg-(--scene-c) opacity-75 blur-[90px] [animation-delay:-13s]" />

      <header className="relative z-10 mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="size-9 rounded-full bg-[radial-gradient(circle,#ffd9a8_0.9px,transparent_1.5px)] bg-[length:4px_4px] shadow-[0_8px_20px_-8px_var(--shadow)] [mask-image:radial-gradient(circle_at_32%_28%,#000_5%,rgba(0,0,0,0.25)_100%)]" />
          <div>
            <h1 className="text-lg font-bold tracking-tight">Reschedule a Delivery</h1>
            <p className="text-xs text-muted">Move your courier delivery to a new slot, just by talking.</p>
          </div>
        </div>
        <div className="glass order-last w-full rounded-full px-5 py-2 min-[901px]:order-none min-[901px]:w-auto min-[901px]:min-w-[520px] min-[901px]:flex-1 min-[901px]:max-w-[640px]">
          <Stepper stage={call.stage} />
        </div>
        <div className="flex items-center gap-2.5">
          <span className={`glass inline-flex items-center gap-2 rounded-full px-3.5 py-[7px] text-[13px] ${active ? "text-ink" : "text-muted"}`}>
            <span className={`size-2 rounded-full ${call.phase === "reconnecting" ? "animate-live bg-warn" : active ? "animate-live bg-good shadow-[0_0_0_4px_rgba(63,154,98,0.2)]" : "bg-muted"}`} />
            {call.phase === "reconnecting" ? "Reconnecting" : active ? "On a call" : "Not connected"}
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid w-full max-w-[1400px] flex-1 grid-cols-1 gap-5 min-[901px]:min-h-0 min-[901px]:grid-cols-[minmax(360px,5fr)_7fr]">
        <section
          ref={stage}
          onPointerMove={lean}
          onPointerLeave={level}
          className="glass glow-border flex flex-col items-center gap-3 rounded-[28px] px-6 pt-4 pb-5 text-center transition-transform duration-200 [transform:perspective(1200px)_rotateX(var(--tilt-x,0deg))_rotateY(var(--tilt-y,0deg))] min-[901px]:min-h-0"
        >
          <div className="relative aspect-square w-full max-w-[400px] min-[901px]:aspect-auto min-[901px]:min-h-[180px] min-[901px]:flex-1">
            <AgentOrb phase={call.phase} levels={call.levels} />
          </div>

          <div className="animate-rise" key={call.phase}>
            <h2 className="bg-linear-to-r from-[#ffb680] via-[#ffd98a] to-[#ff9aa8] bg-clip-text text-2xl font-bold tracking-tight text-transparent">{text.title}</h2>
            <p className="text-sm text-muted">{text.caption}</p>
          </div>

          <button
            type="button"
            onClick={active ? call.end : call.start}
            className={`min-w-52 cursor-pointer rounded-full px-9 py-3 text-base font-bold transition hover:-translate-y-0.5 active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold ${
              active ? "glass text-ink shadow-[0_12px_24px_-10px_rgba(212,87,77,0.5)]" : "gold-surface border-0"
            }`}
          >
            {active ? "End call" : call.canResume ? "Resume call" : "Start call"}
          </button>

          <TrackingTiles id={call.trackingId} confirmed={call.idConfirmed} />

          <dl className="flex w-full gap-3">
            <div className="flex flex-1 items-center justify-between rounded-2xl bg-tile px-3.5 py-2">
              <dt className="text-[11px] tracking-wider text-muted uppercase">Response time</dt>
              <dd className="font-bold">
                {call.responseMs === undefined ? (
                  "-"
                ) : (
                  <>
                    <span className={`mr-2 inline-block size-[9px] rounded-full ${RESPONSE_COLOURS[responseLevel(call.responseMs)]}`} />
                    {(call.responseMs / 1000).toFixed(1)} s
                  </>
                )}
              </dd>
            </div>
            <div className="flex flex-1 items-center justify-between rounded-2xl bg-tile px-3.5 py-2">
              <dt className="text-[11px] tracking-wider text-muted uppercase">Bookings made</dt>
              <dd className="font-bold">{call.bookings}</dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-col gap-4 min-[901px]:min-h-0">
          <Timeline items={call.timeline} interim={call.interim} />
        </div>
      </main>
    </div>
  );
}
