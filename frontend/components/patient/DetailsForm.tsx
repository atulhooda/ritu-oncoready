"use client";

import { useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/Field";
import { Button, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { PatientDetails, PatientProfile } from "@/lib/types";
import { LANGUAGES, SEX_LABELS, TREATMENT_LABELS } from "@/lib/types";

type Form = Record<keyof Omit<PatientDetails, "age" | "updated_at" | "abha" | "identity">, string>;

const CANCER_TYPES = ["Breast cancer", "Lung cancer", "Colorectal cancer", "Head and neck cancer", "Cervical cancer",
  "Ovarian cancer", "Prostate cancer", "Stomach cancer", "Blood cancer (leukaemia / lymphoma)"];

function toForm(d: PatientDetails): Form {
  return {
    date_of_birth: d.date_of_birth ?? "",
    sex: d.sex ?? "",
    phone: d.phone ?? "",
    preferred_language: d.preferred_language,
    cancer_type: d.cancer_type ?? "",
    diagnosed_on: d.diagnosed_on ? d.diagnosed_on.slice(0, 7) : "",
    stage_reported: d.stage_reported ?? "",
    treatment_status: d.treatment_status ?? "",
    current_treatment: d.current_treatment ?? "",
    treating_hospital: d.treating_hospital ?? "",
    treating_doctor: d.treating_doctor ?? "",
    other_conditions: d.other_conditions ?? "",
  };
}

function ageFrom(dob: string): number | null {
  if (!dob) return null;
  const b = new Date(dob), t = new Date();
  return t.getFullYear() - b.getFullYear() - (t < new Date(t.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
}

/** Patient-reported details. Used by the check-in's first step and by the Profile page. */
export function DetailsForm({
  profile,
  onSaved,
  submitLabel = "Save",
  requiredHint = false,
}: {
  profile: PatientProfile;
  onSaved: () => Promise<void> | void;
  submitLabel?: string;
  requiredHint?: boolean;
}) {
  const [form, setForm] = useState<Form>(() => toForm(profile.details));
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const body = { ...form, diagnosed_on: form.diagnosed_on ? `${form.diagnosed_on}-01` : "" };
      await api("/me/details", { method: "PUT", body: JSON.stringify(body) });
      setStatus({ tone: "ok", text: "Saved." });
      await onSaved();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : "Could not save" });
    } finally {
      setSaving(false);
    }
  }

  const age = ageFrom(form.date_of_birth);
  const today = new Date().toISOString().slice(0, 10);
  const req = requiredHint ? " *" : "";
  return (
    <form onSubmit={save} className="space-y-8">
      <section>
        <Label>About you</Label>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field label="Full name" hint="From your account">
            <TextInput value={profile.name} disabled />
          </Field>
          <Field label={`Date of birth${req}`} hint={age !== null ? `Age ${age}` : undefined}>
            <TextInput type="date" max={today} value={form.date_of_birth} onChange={set("date_of_birth")} />
          </Field>
          <Field label={`Sex${req}`}>
            <Select options={SEX_LABELS} placeholder="Choose…" value={form.sex} onChange={set("sex")} />
          </Field>
          <Field label="Phone">
            <TextInput inputMode="tel" placeholder="+91 98200 11111" value={form.phone} onChange={set("phone")} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Language for Ritu" hint="Ritu starts in this language and switches if you answer in another one">
              <Select options={LANGUAGES} value={form.preferred_language} onChange={set("preferred_language")} />
            </Field>
          </div>
        </div>
      </section>

      <section>
        <Label>Your cancer</Label>
        <p className="mt-2 text-sm text-muted">As you understand it. Leave anything blank if you are not sure; your doctor will check your records.</p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field label={`Cancer type${req}`}>
            <TextInput list="cancer-types" placeholder="e.g. Breast cancer" value={form.cancer_type} onChange={set("cancer_type")} />
            <datalist id="cancer-types">
              {CANCER_TYPES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="When it was found" hint="Month and year">
            <TextInput type="month" max={today.slice(0, 7)} value={form.diagnosed_on} onChange={set("diagnosed_on")} />
          </Field>
          <Field label="Stage" hint="If your doctor told you, e.g. Stage 2">
            <TextInput value={form.stage_reported} onChange={set("stage_reported")} />
          </Field>
          <Field label="Treatment status">
            <Select options={TREATMENT_LABELS} placeholder="Choose…" value={form.treatment_status} onChange={set("treatment_status")} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Current treatment" hint="Chemotherapy, radiation, surgery, tablets… in your own words">
              <TextArea value={form.current_treatment} onChange={set("current_treatment")} />
            </Field>
          </div>
          <Field label="Treating hospital">
            <TextInput value={form.treating_hospital} onChange={set("treating_hospital")} />
          </Field>
          <Field label="Treating doctor">
            <TextInput value={form.treating_doctor} onChange={set("treating_doctor")} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Other health conditions" hint="e.g. diabetes, blood pressure, heart problems">
              <TextArea value={form.other_conditions} onChange={set("other_conditions")} />
            </Field>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <Button disabled={saving}>{saving ? "Saving…" : submitLabel}</Button>
        {status && <span className={`text-sm ${status.tone === "ok" ? "text-green-700" : "text-red-700"}`}>{status.text}</span>}
        {requiredHint && <span className="text-sm text-muted">* needed before your visit</span>}
      </div>
    </form>
  );
}
