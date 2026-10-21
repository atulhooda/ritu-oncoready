"use client";

import { Save } from "lucide-react";
import { useEffect, useState } from "react";

import { Field, Select, TextArea, TextInput } from "@/components/Field";
import { PatientAside } from "@/components/PatientAside";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Button, Card, Label, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { PatientDetails } from "@/lib/types";
import { LANGUAGES, SEX_LABELS, TREATMENT_LABELS } from "@/lib/types";

type Form = Record<keyof Omit<PatientDetails, "age" | "updated_at">, string>;

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

export default function MyProfilePage() {
  const { me, profile, reload } = usePatient();
  const [form, setForm] = useState<Form | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && !form) setForm(toForm(profile.details));
  }, [profile, form]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (!form) return;
    setSaving(true);
    setStatus(null);
    try {
      const body = { ...form, diagnosed_on: form.diagnosed_on ? `${form.diagnosed_on}-01` : "" };
      await api("/me/details", { method: "PUT", body: JSON.stringify(body) });
      await reload();
      setStatus({ tone: "ok", text: "Saved." });
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : "Could not save" });
    } finally {
      setSaving(false);
    }
  }

  const age = form ? ageFrom(form.date_of_birth) : null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Shell
      me={me}
      actions={
        form && (
          <Button onClick={() => save()} disabled={saving}>
            <Save size={17} /> {saving ? "Saving…" : "Save profile"}
          </Button>
        )
      }
    >
      {profile && form && (
        <>
          <PageHeader eyebrow="My profile" live title="Hello," accent={`${profile.name.split(" ")[0]}.`} subtitle="Tell us about yourself. Your doctor sees this when you send your profile." />
          {status && (
            <p className={`mb-5 rounded-xl border px-4 py-3 text-sm ${status.tone === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"}`}>
              {status.text}
            </p>
          )}
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <form onSubmit={save} className="space-y-6">
              <Card className="p-7">
                <Label>About you</Label>
                <div className="mt-6 grid gap-5 sm:grid-cols-2">
                  <Field label="Full name" hint="From your account">
                    <TextInput value={profile.name} disabled />
                  </Field>
                  <Field label="Email" hint="From your account">
                    <TextInput value={profile.email} disabled />
                  </Field>
                  <Field label="Date of birth" hint={age !== null ? `Age ${age}` : undefined}>
                    <TextInput type="date" max={today} value={form.date_of_birth} onChange={set("date_of_birth")} />
                  </Field>
                  <Field label="Sex">
                    <Select options={SEX_LABELS} placeholder="Choose…" value={form.sex} onChange={set("sex")} />
                  </Field>
                  <Field label="Phone">
                    <TextInput inputMode="tel" placeholder="+91 98200 11111" value={form.phone} onChange={set("phone")} />
                  </Field>
                  <Field label="Language for Ritu" hint="Ritu talks to you in this language">
                    <Select options={LANGUAGES} value={form.preferred_language} onChange={set("preferred_language")} />
                  </Field>
                </div>
              </Card>

              <Card className="p-7">
                <Label>Your cancer</Label>
                <p className="mt-2 text-sm text-muted">As you understand it. Leave anything blank if you are not sure; your doctor will check your records.</p>
                <div className="mt-6 grid gap-5 sm:grid-cols-2">
                  <Field label="Cancer type">
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
                <div className="mt-7 flex items-center gap-4">
                  <Button disabled={saving}>
                    <Save size={17} /> {saving ? "Saving…" : "Save profile"}
                  </Button>
                  {profile.details.updated_at && (
                    <span className="text-sm text-muted">Last saved {new Date(profile.details.updated_at).toLocaleString()}</span>
                  )}
                </div>
              </Card>
            </form>
            <PatientAside profile={profile} />
          </div>
        </>
      )}
    </Shell>
  );
}
