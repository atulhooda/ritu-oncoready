"use client";

import { Mic, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge, Button, Card, Label } from "@/components/ui";
import { RituVoice, type VoicePhase } from "@/lib/ritu-voice";
import type { IntakeSession } from "@/lib/types";

const STATUS: Record<VoicePhase, { title: string; hint: string }> = {
  connecting: { title: "Connecting to Ritu…", hint: "Allow microphone access if your browser asks." },
  ritu: { title: "Ritu is speaking", hint: "Listen. You can answer when she finishes." },
  listening: { title: "Your turn, Ritu is listening", hint: "Speak normally, then pause when you are done." },
  thinking: { title: "Ritu heard you", hint: "She is preparing her reply…" },
  ended: { title: "Session finished", hint: "Ritu is writing up what you shared." },
  error: { title: "Could not connect", hint: "Check your microphone and try again." },
};

type Caption = { role: "ritu" | "patient"; text: string };

/** Live voice session with Ritu: an orb that shows who is talking (driven by real audio levels) + captions. */
export function VoiceSession({ session, onFinished }: { session: IntakeSession; onFinished: () => void }) {
  const voice = useRef<RituVoice | null>(null);
  const [phase, setPhase] = useState<VoicePhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  const captionEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const v = new RituVoice(session.ritu!.ws_url, session.ritu!.token, {
      onPhase: (p, detail) => {
        setPhase(p);
        if (detail) setError(detail);
        if (p === "ended") onFinished();
      },
      onCaption: (role, text) => setCaptions((c) => [...c, { role, text }]),
    });
    voice.current = v;
    v.start().catch((e) => {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Microphone unavailable");
    });

    // Feed live loudness into CSS variables; the orb, halos and bars read them.
    let raf = 0;
    const tick = () => {
      const { ritu, mic } = v.levels();
      const el = stage.current;
      if (el) {
        el.style.setProperty("--ritu", ritu.toFixed(3));
        el.style.setProperty("--mic", mic.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v.stop();
    };
  }, [session.ritu, onFinished]);

  useEffect(() => {
    captionEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); // returns a Promise in newer Chrome
  }, [captions]);

  const status = STATUS[phase];
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-7 py-5">
        <Label>Talking to Ritu</Label>
        <Badge tone={phase === "error" ? "red" : phase === "ended" ? "slate" : "green"}>
          {phase === "error" ? "not connected" : phase === "ended" ? "ended" : "● live"}
        </Badge>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1fr_1fr]">
        <div ref={stage} className="voice-stage flex flex-col items-center px-7 py-10 text-center" data-phase={phase}>
          <div className="voice-orb-wrap">
            <span className="voice-halo voice-halo-1" />
            <span className="voice-halo voice-halo-2" />
            <div className="voice-orb">
              {phase === "listening" ? (
                <div className="voice-bars" aria-hidden>
                  {[0.55, 0.85, 1, 0.85, 0.55].map((w, i) => (
                    <span key={i} style={{ ["--w" as string]: w }} />
                  ))}
                </div>
              ) : phase === "thinking" ? (
                <div className="voice-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
              ) : (
                <Mic size={44} strokeWidth={1.6} />
              )}
            </div>
          </div>
          <div className="mt-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${phase === "ritu" ? "bg-brand" : phase === "listening" ? "bg-green-600" : "bg-line"}`} />
            {phase === "ritu" ? "Ritu" : phase === "listening" || phase === "thinking" ? "You" : "—"}
          </div>
          <p className="mt-2 text-xl font-semibold" aria-live="polite">
            {status.title}
          </p>
          <p className="mt-1 text-muted">{error ?? status.hint}</p>
          {phase !== "ended" && (
            <Button variant="secondary" className="mt-7" onClick={() => voice.current?.stop()}>
              <PhoneOff size={17} /> End session
            </Button>
          )}
        </div>

        <div className="border-t border-line/70 lg:border-l lg:border-t-0">
          <div className="px-7 pt-5">
            <Label>Live captions</Label>
          </div>
          <div className="max-h-[360px] min-h-[220px] space-y-3 overflow-y-auto px-7 py-5">
            {captions.length === 0 && <p className="text-muted">What you and Ritu say appears here.</p>}
            {captions.map((c, i) => (
              <div key={i} className={`flex ${c.role === "patient" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${c.role === "patient" ? "bg-brand text-white" : "bg-paper text-ink"}`}>
                  <div className={`mb-0.5 font-mono text-[10px] uppercase tracking-[0.2em] ${c.role === "patient" ? "text-white/70" : "text-muted"}`}>
                    {c.role === "patient" ? "You" : "Ritu"}
                  </div>
                  {c.text}
                </div>
              </div>
            ))}
            <div ref={captionEnd} />
          </div>
        </div>
      </div>
    </Card>
  );
}
