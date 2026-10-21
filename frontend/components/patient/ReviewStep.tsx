"use client";

import { Send } from "lucide-react";
import { useState } from "react";

import { Badge, Button, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { StepId } from "@/lib/patient";
import type { PatientProfile } from "@/lib/types";
import { detailsLine, LANGUAGES, TREATMENT_LABELS } from "@/lib/types";

function Section({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <div className="border-t border-line/60 py-5 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <Label>{title}</Label>
        <button type="button" onClick={onEdit} className="text-sm font-medium text-brand hover:underline">
          Edit
        </button>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function ReviewStep({ profile, clinic, reload, goTo }: { profile: PatientProfile; clinic: string; reload: () => Promise<void>; goTo: (s: StepId) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = profile.details;
  const symptoms = profile.summary?.sections.find((s) => s.section === "current_symptom")?.facts ?? [];
  const noted = profile.summary?.sections.reduce((n, s) => n + s.facts.length, 0) ?? 0;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api("/me/publish", { method: "POST" });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
      setBusy(false);
    }
  }

  return (
    <div>
      <Section title="About you" onEdit={() => goTo("about")}>
        <p className="font-medium">{[profile.name, detailsLine(d)].filter(Boolean).join(" · ")}</p>
        <p className="text-sm text-muted">
          {[d.stage_reported, d.treatment_status ? TREATMENT_LABELS[d.treatment_status] : null, d.treating_hospital, LANGUAGES[d.preferred_language]]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Section>
      <Section title="What you told Ritu" onEdit={() => goTo("ritu")}>
        {profile.summary ? (
          <>
            <p className="text-sm text-muted">
              {noted
                ? `${noted} thing${noted === 1 ? "" : "s"} noted, in your own words.`
                : "Ritu didn't note any symptoms or records from your last conversation."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {symptoms.map((f) => (
                <Badge key={f.id}>{f.label}</Badge>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-red-700">Talk to Ritu first; your care team needs this before your visit.</p>
        )}
      </Section>
      <Section title="Records" onEdit={() => goTo("records")}>
        {profile.records.length ? (
          <ul className="space-y-1.5 text-[15px]">
            {profile.records.map((r) => (
              <li key={r.id} className="truncate">{r.filename}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">None. You can add records later.</p>
        )}
      </Section>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-paper px-5 py-4">
        <p className="text-[15px] text-ink/80">Your care team at {clinic} will see all of this before your visit.</p>
        <Button onClick={send} disabled={!profile.summary || busy}>
          <Send size={17} /> {busy ? "Sending…" : "Send to my care team"}
        </Button>
      </div>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}
