"use client";

import { Mic, PhoneOff, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge, Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import { RituVoice, type VoiceState } from "@/lib/ritu-voice";
import type { IntakeScript, IntakeSession } from "@/lib/types";

/** Live session with Ritu: voice in the browser when Ritu is connected, otherwise the typed simulator. */
export function SessionPanel({ session, onFinished }: { session: IntakeSession; onFinished: () => void }) {
  return session.mode === "ritu" && session.ritu ? (
    <VoiceSession session={session} onFinished={onFinished} />
  ) : (
    <SimulatedSession session={session} onFinished={onFinished} />
  );
}

function VoiceSession({ session, onFinished }: { session: IntakeSession; onFinished: () => void }) {
  const voice = useRef<RituVoice | null>(null);
  const [state, setState] = useState<VoiceState>("connecting");
  const [speaking, setSpeaking] = useState<"ritu" | "patient" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const v = new RituVoice(session.ritu!.ws_url, session.ritu!.token, (s, detail) => {
      setState(s);
      if (detail) setError(detail);
      if (s === "ended") onFinished();
    }, setSpeaking);
    voice.current = v;
    v.start().catch((e) => {
      setState("error");
      setError(e instanceof Error ? e.message : "Microphone unavailable");
    });
    return () => v.stop();
  }, [session.ritu, onFinished]);

  return (
    <Card className="p-8 text-center">
      <Label>Talking to Ritu</Label>
      <div className="relative mx-auto my-8 flex h-36 w-36 items-center justify-center">
        <span className={`absolute inset-0 rounded-full bg-brand/15 ${state === "live" ? "animate-ping" : ""}`} />
        <span className="relative flex h-28 w-28 items-center justify-center rounded-full bg-brand text-white shadow-[0_12px_32px_-8px_rgba(58,79,224,0.8)]">
          <Mic size={40} strokeWidth={1.75} />
        </span>
      </div>
      <p className="text-lg font-semibold">
        {state === "connecting" && "Connecting to Ritu…"}
        {state === "live" && (speaking === "ritu" ? "Ritu is speaking" : speaking === "patient" ? "Listening…" : "Go ahead, Ritu is listening")}
        {state === "ended" && "Session ended"}
        {state === "error" && "Could not connect"}
      </p>
      <p className="mt-1 text-muted">Ritu will ask how you are feeling now, then about your earlier records.</p>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {state !== "ended" && (
        <Button variant="secondary" className="mt-6" onClick={() => voice.current?.stop()}>
          <PhoneOff size={17} /> End session
        </Button>
      )}
    </Card>
  );
}

type Turn = { role: "ritu" | "patient"; text: string };

function SimulatedSession({ session, onFinished }: { session: IntakeSession; onFinished: () => void }) {
  const [script, setScript] = useState<IntakeScript | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const prompts = script ? script.steps.flatMap((s) => s.prompts.map((p) => ({ step: s.id, prompt: p }))) : [];
  const asked = turns.filter((t) => t.role === "ritu").length;
  const done = script !== null && asked >= prompts.length && turns[turns.length - 1]?.role === "patient";

  useEffect(() => {
    api<IntakeScript>("/me/intake-script").then((s) => {
      setScript(s);
      setTurns([{ role: "ritu", text: s.steps[0].prompts[0] }]);
    });
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); // returns a Promise in newer Chrome
  }, [turns]);

  function reply(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    const next: Turn[] = [...turns, { role: "patient", text: answer.trim() }];
    if (asked < prompts.length) next.push({ role: "ritu", text: prompts[asked].prompt });
    setTurns(next);
    setAnswer("");
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const all = script ? [...turns, { role: "ritu" as const, text: script.closing }] : turns;
      await api(`/me/sessions/${session.id}/simulate`, { method: "POST", body: JSON.stringify({ turns: all }) });
      onFinished();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the session");
      setBusy(false);
    }
  }

  const currentStep = prompts[Math.max(0, asked - 1)]?.step;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-7 py-5">
        <Label>Session with Ritu</Label>
        <Badge tone="amber">simulator: Ritu voice not connected yet</Badge>
      </div>
      <div className="flex gap-2 px-7 pt-5">
        {script?.steps.map((s, i) => (
          <Badge key={s.id} tone={currentStep === s.id ? "blue" : "slate"}>
            {i + 1}. {s.id === "current_symptoms" ? "How you feel now" : "Earlier records"}
          </Badge>
        ))}
      </div>
      <div className="max-h-[420px] space-y-3 overflow-y-auto px-7 py-5">
        {turns.map((t, i) => (
          <div key={i} className={`flex ${t.role === "patient" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${t.role === "patient" ? "bg-brand text-white" : "bg-paper text-ink"}`}>
              {t.role === "ritu" && <div className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted">Ritu</div>}
              {t.text}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="border-t border-line/70 px-7 py-5">
        {!done ? (
          <form onSubmit={reply} className="flex gap-3">
            <input
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Type your answer…"
              className="flex-1 rounded-xl border border-line bg-white px-4 py-3 outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
            />
            <Button disabled={!answer.trim()}>
              <Send size={16} /> Reply
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted">{script?.closing}</p>
            <Button onClick={finish} disabled={busy}>
              {busy ? "Saving…" : "Finish session"}
            </Button>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </div>
    </Card>
  );
}
