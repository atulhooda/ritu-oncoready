"use client";

import { AlertTriangle, Mic } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";

import { SessionPanel } from "@/components/SessionPanel";
import { Shell } from "@/components/Shell";
import { SymptomCourse } from "@/components/SymptomCourse";
import { usePatient } from "@/components/usePatient";
import { Button, Card, Label, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { IntakeFact, IntakeSession, IntakeSummary, PatientProfile } from "@/lib/types";

const TREND_WORD: Record<string, string> = { worsening: "worse", improving: "better", same: "about the same" };

/** "7/10, worse, since yesterday" — only what the patient said. */
function detail(f: IntakeFact): string {
  const d = f.details;
  return [d.score, d.trend ? TREND_WORD[d.trend] ?? d.trend : null, d.onset ? `since ${d.onset.replace(/^since\s+/i, "")}` : null, d.missed_doses ? `missed: ${d.missed_doses}` : null]
    .filter(Boolean)
    .join(", ");
}

function daysAgo(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function cadence(p: PatientProfile): string {
  return p.details.treatment_status === "on_treatment"
    ? "While you are on treatment: every 2–3 days, and the day after each treatment."
    : "Once a week, or whenever something changes.";
}

function CheckInCard({ c, shared, latest }: { c: IntakeSummary; shared: boolean; latest: boolean }) {
  const facts = c.sections.flatMap((s) => s.facts);
  const urgent = facts.filter((f) => f.urgent);
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-semibold">
          {c.ended_at ? new Date(c.ended_at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—"}
        </div>
        <div className="text-sm text-muted">{shared ? "Shared with your care team" : "Not shared yet"}</div>
      </div>
      {latest && urgent.length > 0 && (
        <div className="mt-4 flex gap-3 rounded-xl border-2 border-red-600 px-4 py-3 text-[15px] text-red-800">
          <AlertTriangle size={19} className="mt-0.5 shrink-0" strokeWidth={2} />
          <p>
            You mentioned {urgent.map((f) => f.label.toLowerCase()).join(" and ")}. If this is happening now, contact your care team or emergency
            services. Do not wait for your next visit.
          </p>
        </div>
      )}
      {facts.length ? (
        <ul className="mt-3 space-y-1.5 text-[15px]">
          {facts.map((f) => (
            <li key={f.id}>
              <span className={`font-medium ${f.urgent ? "text-red-700" : ""}`}>{f.label}</span>
              {detail(f) && <span className="text-ink/70"> · {detail(f)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[15px] text-muted">Nothing new reported.</p>
      )}
    </Card>
  );
}

export default function DiaryPage() {
  const { me, profile, reload } = usePatient();
  const [live, setLive] = useState<IntakeSession | null>(null);
  const [record, setRecord] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const finished = useCallback(() => {
    setLive(null);
    reload();
  }, [reload]);

  const clinic = me?.org_name ?? "your clinic";
  const voice = profile?.voice_mode === "ritu";
  const checkIns = profile?.check_ins ?? [];
  const lastSession = profile?.sessions.filter((s) => s.kind === "check_in").at(-1);
  const writing = lastSession?.status === "completed";

  async function start() {
    setError(null);
    try {
      setLive(await api<IntakeSession>("/me/sessions", { method: "POST", body: JSON.stringify({ kind: "check_in", record_audio: voice && record }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    }
  }

  return (
    <Shell me={me}>
      {profile && (
        <div className="mx-auto max-w-4xl space-y-6">
          <PageHeader
            size="sm"
            eyebrow={`Between visits · ${clinic}`}
            title="How have you been?"
            subtitle="A two-minute check-in with Ritu. Your care team sees how you are doing between visits, in your own words."
          />

          {live ? (
            <Card className="p-6 sm:p-8">
              <SessionPanel session={live} onFinished={finished} />
            </Card>
          ) : (
            <Card className="p-6 sm:p-8">
              {writing ? (
                <div className="flex items-center gap-4">
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  <p className="font-semibold">Ritu is writing up your check-in…</p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-xl font-bold tracking-tight">
                      {checkIns[0] ? `Last check-in: ${daysAgo(checkIns[0].ended_at)}` : "Your first check-in"}
                    </h2>
                    <span className="text-sm text-muted">{cadence(profile)}</span>
                  </div>
                  <p className="text-[15px] text-ink/80">
                    Ritu asks how you have been{checkIns.length || profile.summary ? ", follows up what you told her last time," : ""} and checks for a few warning
                    signs. She does not diagnose or give medical advice.
                  </p>
                  {voice && (
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-[#fcfbf9] px-4 py-3 text-[15px]">
                      <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-brand)]" />
                      <span>
                        <span className="font-medium">Record the audio of this check-in for my care team.</span>
                        <span className="block text-sm text-muted">Only your care team can listen to it. You can untick this and still talk to Ritu.</span>
                      </span>
                    </label>
                  )}
                  {error && <p className="text-sm text-red-700">{error}</p>}
                  {lastSession?.status === "failed" && <p className="text-sm text-red-700">The last check-in did not finish. Please try again.</p>}
                  <Button onClick={start}>
                    <Mic size={18} /> Start a check-in
                  </Button>
                  {!profile.published_at && (
                    <p className="text-sm text-muted">
                      Check-ins reach your care team once you have sent your visit check-in.{" "}
                      <Link href="/patient" className="font-medium text-brand hover:underline">
                        Go to your visit check-in →
                      </Link>
                    </p>
                  )}
                </div>
              )}
            </Card>
          )}

          {profile.symptom_course.rows.length > 0 && (
            <Card className="p-6 sm:p-8">
              <Label>Your symptoms over time</Label>
              <div className="mt-4">
                <SymptomCourse course={profile.symptom_course} />
              </div>
            </Card>
          )}

          {checkIns.length > 0 && (
            <section className="space-y-3">
              <Label>Your check-ins</Label>
              {checkIns.map((c, i) => (
                <CheckInCard key={c.session_id} c={c} shared={!!profile.published_at} latest={i === 0} />
              ))}
            </section>
          )}
        </div>
      )}
    </Shell>
  );
}
