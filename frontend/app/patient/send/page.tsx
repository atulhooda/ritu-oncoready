"use client";

import { Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PatientAside } from "@/components/PatientAside";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Badge, Button, Card, Label, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { LANGUAGES, SEX_LABELS, TREATMENT_LABELS } from "@/lib/types";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-2">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-medium">{v || <span className="font-normal text-muted">not given</span>}</dd>
    </div>
  );
}

export default function SendPage() {
  const { me, profile, reload } = usePatient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api("/me/publish", { method: "POST" });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <Shell me={me}>{null}</Shell>;
  const d = profile.details;
  const facts = profile.summary?.sections.reduce((n, s) => n + s.facts.length, 0) ?? 0;
  const symptoms = profile.summary?.sections.find((s) => s.section === "current_symptom")?.facts ?? [];
  const ready = !!profile.summary;

  return (
    <Shell me={me}>
      <PageHeader
        eyebrow="Send to doctor"
        title="Send to your"
        accent="doctor."
        subtitle={profile.published_at ? `Sent ${new Date(profile.published_at).toLocaleString()}. Your doctor sees updates automatically.` : "Check what your doctor will see, then send it."}
      />
      {error && <p className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card className="p-7">
            <div className="flex items-center justify-between">
              <Label>1 · Your details</Label>
              <Link href="/patient" className="text-sm font-medium text-brand hover:underline">Edit</Link>
            </div>
            <dl className="mt-4 divide-y divide-line/60">
              <Row k="Age" v={d.age !== null ? `${d.age}` : null} />
              <Row k="Sex" v={d.sex ? SEX_LABELS[d.sex] : null} />
              <Row k="Cancer type" v={d.cancer_type} />
              <Row k="Found" v={d.diagnosed_on ? new Date(d.diagnosed_on).toLocaleDateString([], { month: "long", year: "numeric" }) : null} />
              <Row k="Stage (as told to you)" v={d.stage_reported} />
              <Row k="Treatment" v={d.treatment_status ? TREATMENT_LABELS[d.treatment_status] : null} />
              <Row k="Treating hospital" v={d.treating_hospital} />
              <Row k="Language" v={LANGUAGES[d.preferred_language]} />
            </dl>
          </Card>

          <Card className="p-7">
            <div className="flex items-center justify-between">
              <Label>2 · What Ritu noted</Label>
              <Link href="/patient/session" className="text-sm font-medium text-brand hover:underline">{ready ? "View" : "Talk to Ritu"}</Link>
            </div>
            {ready ? (
              <>
                <p className="mt-4 text-muted">{facts} things noted, in your own words.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {symptoms.map((f) => (
                    <Badge key={f.id}>{f.label}</Badge>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-4 text-muted">You need to finish a session with Ritu before sending.</p>
            )}
          </Card>

          <Card className="p-7">
            <div className="flex items-center justify-between">
              <Label>3 · Records</Label>
              <Link href="/patient/records" className="text-sm font-medium text-brand hover:underline">Add more</Link>
            </div>
            {profile.records.length ? (
              <ul className="mt-4 space-y-2">
                {profile.records.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3">
                    <span className="truncate">{r.filename}</span>
                    <Badge tone={r.status === "extracted" ? "green" : r.status === "failed" ? "red" : "amber"}>
                      {r.status === "extracted" ? "ready" : r.status === "failed" ? "could not read" : "reading…"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-muted">No records yet. You can send without them and add them later.</p>
            )}
          </Card>

          <Card className="flex flex-wrap items-center justify-between gap-5 p-7">
            <p className="max-w-xl text-muted">
              {profile.published_at
                ? "Sent. Anything you change or add later is shared with your doctor automatically."
                : "Your doctor sees your details, what Ritu noted, the conversation, and every record."}
            </p>
            {profile.published_at ? (
              <Badge tone="green">sent {new Date(profile.published_at).toLocaleDateString()}</Badge>
            ) : (
              <Button onClick={send} disabled={!ready || busy}>
                <Send size={17} /> {busy ? "Sending…" : "Send to doctor"}
              </Button>
            )}
          </Card>
        </div>
        <PatientAside profile={profile} />
      </div>
    </Shell>
  );
}
