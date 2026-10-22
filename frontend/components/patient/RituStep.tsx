"use client";

import { Keyboard, Mic, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";

import { IntakeSummaryView } from "@/components/IntakeSummaryView";
import { SessionPanel } from "@/components/SessionPanel";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import type { IntakeSession, PatientProfile } from "@/lib/types";
import { LANGUAGES } from "@/lib/types";

export function RituStep({ profile, clinic, reload }: { profile: PatientProfile; clinic: string; reload: () => Promise<void> }) {
  const [live, setLive] = useState<IntakeSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState(true);
  const latest = profile.sessions[profile.sessions.length - 1];
  const writing = latest?.status === "completed";
  const voice = profile.voice_mode === "ritu";
  const language = LANGUAGES[profile.details.preferred_language] ?? profile.details.preferred_language;

  async function start() {
    setError(null);
    try {
      setLive(await api<IntakeSession>("/me/sessions", { method: "POST", body: JSON.stringify({ record_audio: voice && record }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    }
  }
  const finished = useCallback(() => {
    setLive(null);
    reload();
  }, [reload]);

  if (live) return <SessionPanel session={live} onFinished={finished} />;

  return (
    <div className="space-y-6">
      {writing ? (
        <div className="flex items-center gap-4 rounded-2xl bg-brand-soft/60 px-6 py-5">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          <div>
            <p className="font-semibold">Ritu is writing up your conversation…</p>
            <p className="text-sm text-muted">This takes a few seconds.</p>
          </div>
        </div>
      ) : profile.summary ? null : (
        <div className="space-y-5">
          <p className="text-[17px] leading-relaxed text-ink/85">
            Ritu is the pre-visit assistant for {clinic}. She will ask how you are feeling right now, then about any earlier reports you have.
            {voice ? ` She starts in ${language} and follows you if you answer in another language.` : ""}
          </p>
          <ul className="space-y-2.5 text-[15px] text-ink/80">
            <li className="flex gap-3">
              <ShieldCheck size={19} className="mt-0.5 shrink-0 text-green-700" strokeWidth={1.75} />
              Your answers go only to your care team at {clinic}.
            </li>
            <li className="flex gap-3">
              <ShieldCheck size={19} className="mt-0.5 shrink-0 text-green-700" strokeWidth={1.75} />
              Ritu does not diagnose or give medical advice. If you feel very unwell, contact emergency services.
            </li>
            <li className="flex gap-3">
              {voice ? <Mic size={19} className="mt-0.5 shrink-0 text-muted" strokeWidth={1.75} /> : <Keyboard size={19} className="mt-0.5 shrink-0 text-muted" strokeWidth={1.75} />}
              {voice ? "Speak normally and pause when you are done. Allow the microphone when your browser asks." : "You will type your answers."}
            </li>
          </ul>
          {voice && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-[#fcfbf9] px-4 py-3 text-[15px]">
              <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-brand)]" />
              <span>
                <span className="font-medium">Record the audio of this conversation for my care team.</span>
                <span className="block text-sm text-muted">Only your care team can listen to it. You can untick this and still talk to Ritu.</span>
              </span>
            </label>
          )}
        </div>
      )}
      {latest?.status === "failed" && !profile.summary && <p className="text-sm text-red-700">The last conversation did not finish. Please try again.</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {profile.summary && !writing && <IntakeSummaryView summary={profile.summary} audience="patient" />}
      <div>
        {profile.summary ? (
          <Button variant="secondary" onClick={start} disabled={writing}>
            <Mic size={17} /> Talk to Ritu again
          </Button>
        ) : (
          <Button onClick={start} disabled={writing}>
            <Mic size={18} /> Start talking to Ritu
          </Button>
        )}
      </div>
    </div>
  );
}
