"use client";

import { useEffect, useState } from "react";

import { Field, TextInput } from "@/components/Field";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Button, Card, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { Practitioner } from "@/lib/types";
import { formatId14 } from "@/lib/types";

const COUNCILS = [
  "National Medical Commission", "Andhra Pradesh Medical Council", "Delhi Medical Council", "Gujarat Medical Council",
  "Karnataka Medical Council", "Kerala Medical Council", "Maharashtra Medical Council", "Punjab Medical Council",
  "Rajasthan Medical Council", "Tamil Nadu Medical Council", "Telangana State Medical Council", "Uttar Pradesh Medical Council",
  "West Bengal Medical Council",
];

type Form = Pick<Practitioner, "hpr_id" | "registration_number" | "medical_council" | "qualification">;

export default function DoctorProfilePage() {
  const me = useMe(["doctor"]);
  const [doc, setDoc] = useState<Practitioner | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!me) return;
    api<Practitioner>("/doctor/me").then((d) => {
      setDoc(d);
      setForm({ hpr_id: d.hpr_id ? formatId14(d.hpr_id) : "", registration_number: d.registration_number ?? "", medical_council: d.medical_council ?? "", qualification: d.qualification ?? "" });
    });
  }, [me]);

  const set = (k: keyof Form, fmt: (v: string) => string = (v) => v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => (f ? { ...f, [k]: fmt(e.target.value) } : f));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      setDoc(await api<Practitioner>("/doctor/me", { method: "PUT", body: JSON.stringify(form) }));
      setStatus({ ok: true, text: "Saved." });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Could not save" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell me={me}>
      <div className="mx-auto max-w-3xl">
        <PageHeader size="sm" eyebrow="My profile" title={doc?.name ?? "Your details"} subtitle="Shown on every pre-visit report you open." />
        {form && (
          <Card className="p-6 sm:p-8">
            <form onSubmit={save} className="space-y-5">
              <Field label="HPR ID" hint="Your 14-digit ID in ABDM's Healthcare Professionals Registry (hpr.abdm.gov.in).">
                <TextInput inputMode="numeric" placeholder="71-1234-5678-9012" value={form.hpr_id ?? ""} onChange={set("hpr_id", formatId14)} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Registration number">
                  <TextInput placeholder="e.g. DMC/R/12345" value={form.registration_number ?? ""} onChange={set("registration_number")} />
                </Field>
                <Field label="Medical council">
                  <TextInput list="councils" placeholder="e.g. Delhi Medical Council" value={form.medical_council ?? ""} onChange={set("medical_council")} />
                  <datalist id="councils">
                    {COUNCILS.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </Field>
              </div>
              <Field label="Qualifications">
                <TextInput placeholder="e.g. MBBS, MD, DM (Medical Oncology)" value={form.qualification ?? ""} onChange={set("qualification")} />
              </Field>
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Self-declared. These are not yet checked against the HPR or your council&apos;s register, and reports say so.
              </p>
              <div className="flex items-center gap-4">
                <Button type="submit" disabled={saving}>
                  Save
                </Button>
                {status && <span className={`text-sm ${status.ok ? "text-green-700" : "text-red-700"}`}>{status.text}</span>}
              </div>
            </form>
          </Card>
        )}
      </div>
    </Shell>
  );
}
