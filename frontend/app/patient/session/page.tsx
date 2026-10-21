"use client";

import { Mic } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";

import { IntakeSummaryView } from "@/components/IntakeSummaryView";
import { PatientAside } from "@/components/PatientAside";
import { SessionPanel } from "@/components/SessionPanel";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Button, Card, Label, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { IntakeSession } from "@/lib/types";
import { LANGUAGES } from "@/lib/types";

export default function TalkToRituPage() {
  const { me, profile, reload } = usePatient();
  const [live, setLive] = useState<IntakeSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      setLive(await api<IntakeSession>("/me/sessions", { method: "POST" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start a session");
    }
  }
  const finished = useCallback(() => {
    setLive(null);
    reload();
  }, [reload]);

  const latest = profile?.sessions[profile.sessions.length - 1];
  const writing = latest?.status === "completed";
  const language = profile ? LANGUAGES[profile.details.preferred_language] ?? profile.details.preferred_language : "";

  return (
    <Shell me={me}>
      {profile && (
        <>
          <PageHeader eyebrow="Talk to Ritu" live title="Talk to" accent="Ritu." subtitle="Ritu asks how you are feeling now, then about your earlier reports. It takes a few minutes." />
          {error && <p className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="space-y-6">
              {live ? (
                <SessionPanel session={live} onFinished={finished} />
              ) : (
                <Card className="p-7">
                  <Label>Session</Label>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-5">
                    <div className="max-w-xl">
                      <p className="text-lg font-semibold">
                        {writing ? "Ritu is writing up your session…" : profile.summary ? "Your last session is done." : "Ready when you are."}
                      </p>
                      <p className="mt-1 text-muted">
                        {profile.voice_mode === "ritu" ? (
                          <>Ritu will speak <b>{language}</b>. You can change this in <Link href="/patient" className="text-brand hover:underline">My profile</Link>. Allow microphone access when your browser asks.</>
                        ) : (
                          <>Ritu&apos;s voice is not connected yet, so you will type your answers to the same questions.</>
                        )}
                      </p>
                      {latest?.status === "failed" && <p className="mt-2 text-sm text-red-700">Last session did not finish: {latest.error}</p>}
                    </div>
                    <Button onClick={start} disabled={writing}>
                      <Mic size={18} /> {profile.summary ? "Start a new session" : "Start session"}
                    </Button>
                  </div>
                </Card>
              )}
              {profile.summary && !live && <IntakeSummaryView summary={profile.summary} audience="patient" />}
              {profile.summary && !live && (
                <p className="text-sm text-muted">
                  Next: <Link href="/patient/records" className="font-medium text-brand hover:underline">add your earlier records →</Link>
                </p>
              )}
            </div>
            <PatientAside profile={profile} />
          </div>
        </>
      )}
    </Shell>
  );
}
