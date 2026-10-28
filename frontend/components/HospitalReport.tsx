"use client";

import { Printer } from "lucide-react";
import { useState } from "react";

import type { IntakeFact, IntakeSummary, PatientDetails, Practitioner } from "@/lib/types";
import { formatId14, LANGUAGES, SEX_LABELS, TREATMENT_LABELS } from "@/lib/types";

/** On the fixed urgent-signs list. Matched in code on the backend (app/intake/urgent.py), never by the LLM. */
const isUrgent = (f: IntakeFact) => !!f.urgent;

function painScore(f: IntakeFact): number | null {
  const m = (f.details.score || f.details.severity || "").match(/(\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n <= 10 ? n : null;
}

/** "severe (8/10), worsening, since 3 weeks, site: chest" */
function clinicalDetail(f: IntakeFact): string {
  const d = f.details;
  const parts: string[] = [];
  const s = painScore(f);
  if (s !== null) parts.push(`${s >= 7 ? "severe" : s >= 4 ? "moderate" : "mild"} (${s}/10)`);
  else if (d.severity) parts.push(d.severity);
  if (d.trend) parts.push(d.trend === "same" ? "unchanged" : d.trend);
  if (d.onset) parts.push(`since ${d.onset.replace(/^since\s+/i, "")}`);
  if (d.duration) parts.push(`for ${d.duration.replace(/^for\s+/i, "")}`);
  if (d.location && !f.label.toLowerCase().includes(d.location.toLowerCase())) parts.push(`site: ${d.location}`);
  if (d.frequency) parts.push(d.frequency);
  if (d.triggers) parts.push(`brought on by ${d.triggers}`);
  for (const k of ["dose", "last_dose", "missed_doses", "record_type", "record_date", "facility", "notes"]) {
    if (!d[k]) continue;
    parts.push(k === "last_dose" ? `last: ${d[k]}` : k === "missed_doses" ? `missed: ${d[k]}` : d[k]);
  }
  return parts.join(", ");
}

function Ref({ n, open, onClick }: { n: number; open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Show the patient's words"
      className={`print-hide ml-1 align-super text-[11px] font-medium ${open ? "text-brand underline" : "text-brand/70 hover:text-brand"}`}
    >
      [{n}]
    </button>
  );
}

function Words({ f, onTurn }: { f: IntakeFact; onTurn: (t: number) => void }) {
  const quotes = f.evidence?.length ? f.evidence : [{ turn_index: f.turn_index, quote: f.quote }];
  return (
    <div className="mt-1.5 border-l-2 border-line pl-3 text-[14px] italic text-ink/70">
      {quotes.map((q, i) => (
        <div key={i}>
          “{q.quote}”{" "}
          <button onClick={() => onTurn(q.turn_index)} className="not-italic text-xs text-brand hover:underline">
            (conversation, turn {q.turn_index})
          </button>
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="border-b border-ink/15 pb-1.5 text-[13px] font-bold uppercase tracking-[0.12em] text-ink/80">{children}</h3>;
}

/** A pre-visit history laid out like a hospital report. Built entirely in code from the extracted facts. */
export function HospitalReport({
  summary,
  details,
  patientName,
  patientNumber,
  clinic,
  doctor,
  onTurn,
}: {
  summary: IntakeSummary;
  details: PatientDetails;
  patientName: string;
  patientNumber?: string | null;
  clinic: string;
  /** The doctor reading the report (self-declared professional details). */
  doctor?: Practitioner | null;
  onTurn: (t: number) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const facts = (key: string) => summary.sections.find((s) => s.section === key)?.facts ?? [];
  const checkIn = summary.kind === "check_in";
  const occasion = checkIn ? "the between-visit check-in" : "the pre-visit check-in";

  // Numbering for the [n] references, in reading order.
  let refNo = 0;
  const refs = new Map<string, number>();
  const ref = (f: IntakeFact) => {
    if (!refs.has(f.id)) refs.set(f.id, ++refNo);
    return refs.get(f.id)!;
  };

  const complaints = [...facts("current_symptom")].sort((a, b) => {
    const u = Number(isUrgent(b)) - Number(isUrgent(a));
    return u || (painScore(b) ?? -1) - (painScore(a) ?? -1);
  });
  const urgent = [...complaints, ...facts("recent_care")].filter(isUrgent);
  const worst = complaints.find((c) => painScore(c) !== null) ?? complaints[0];
  const date = summary.ended_at ? new Date(summary.ended_at) : null;
  const lang = summary.language ? (LANGUAGES[summary.language] ?? summary.language).split(" · ").pop() : null;
  const found = details.diagnosed_on ? new Date(details.diagnosed_on).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : null;

  const history = [
    `The patient is a ${details.age !== null ? `${details.age}-year-old ` : ""}${details.sex && details.sex !== "prefer_not_to_say" ? `${SEX_LABELS[details.sex].toLowerCase()} ` : ""}with ${details.cancer_type ? details.cancer_type.toLowerCase() : "a reported cancer diagnosis"}${found ? `, found in ${found}` : ""}${details.treatment_status ? `; treatment status: ${TREATMENT_LABELS[details.treatment_status].toLowerCase()}` : ""}.`,
    complaints.length
      ? `At ${occasion} the patient reported ${complaints.length} complaint${complaints.length === 1 ? "" : "s"}${worst ? `, most significantly ${worst.label.toLowerCase()}${clinicalDetail(worst) ? ` (${clinicalDetail(worst)})` : ""}` : ""}.`
      : `At ${occasion} the patient reported no new complaints.`,
    urgent.length ? `The patient also reported ${urgent.map((u) => u.label.toLowerCase()).join(" and ")}, which is on the urgent-signs list.` : "",
  ].filter(Boolean).join(" ");

  const Line = ({ f, numbered }: { f: IntakeFact; numbered?: number }) => (
    <li className="text-[15px] leading-relaxed">
      {numbered !== undefined && <span className="mr-2 tabular-nums text-ink/60">{numbered}.</span>}
      <span className={`font-semibold ${isUrgent(f) ? "text-red-700" : ""}`}>{f.label}</span>
      {clinicalDetail(f) && <span className="text-ink/80"> — {clinicalDetail(f)}</span>}
      <Ref n={ref(f)} open={open.has(f.id)} onClick={() => toggle(f.id)} />
      {open.has(f.id) && <Words f={f} onTurn={onTurn} />}
    </li>
  );

  const block = (title: string, list: IntakeFact[], empty: string | null) =>
    list.length || empty ? (
      <section className="space-y-2.5">
        <SectionTitle>{title}</SectionTitle>
        {list.length ? (
          <ul className="space-y-1.5">{list.map((f) => <Line key={f.id} f={f} />)}</ul>
        ) : (
          <p className="text-[15px] text-ink/70">{empty}</p>
        )}
      </section>
    ) : null;

  const row = (k: string, v: string | null | undefined) => (
    <div className="flex gap-3 py-1">
      <dt className="w-40 shrink-0 text-ink/60">{k}</dt>
      <dd className="font-medium">{v || <span className="font-normal text-ink/40">not stated</span>}</dd>
    </div>
  );

  return (
    <article className="print-report rounded-2xl border border-line/70 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      {/* Letterhead */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink px-8 pb-5 pt-7">
        <div>
          <div className="text-lg font-bold tracking-tight">{clinic}</div>
          <div className="text-sm text-ink/60">Department of Medical Oncology · {checkIn ? "Between-visit follow-up" : "Pre-visit service"}</div>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold">{checkIn ? "Between-visit check-in" : "Pre-visit patient history"}</div>
          <div className="text-ink/60">{date ? date.toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" }) : "—"}</div>
          <div className="text-ink/60">Ref. {checkIn ? "CI" : "PV"}-{String(summary.session_id).slice(0, 8).toUpperCase()}</div>
        </div>
      </header>

      <div className="space-y-7 px-8 py-7">
        {/* Patient particulars */}
        <section className="grid gap-x-10 text-[15px] sm:grid-cols-2">
          <dl>
            {row("Patient", patientNumber ? `${patientName} (${patientNumber})` : patientName)}
            {row(
              "ABHA",
              details.abha
                ? `${details.abha.address ?? details.abha.number} · ${details.abha.verified_via === "abdm_sandbox" ? "verified (ABDM sandbox)" : "demo"}`
                : "not linked",
            )}
            {row(
              "Identity",
              details.identity
                ? `${details.identity.verified_via === "digilocker" ? "verified with DigiLocker" : "DigiLocker demo, not verified"}${details.identity.name ? ` (${details.identity.name})` : ""}`
                : "not verified",
            )}
            {row("Age / Sex", [details.age !== null ? `${details.age} years` : null, details.sex ? SEX_LABELS[details.sex] : null].filter(Boolean).join(" / "))}
            {row("Diagnosis (as told)", [details.cancer_type, found ? `found ${found}` : null].filter(Boolean).join(", "))}
            {row("Stage (as told)", details.stage_reported)}
          </dl>
          <dl>
            {row("Treatment status", details.treatment_status ? TREATMENT_LABELS[details.treatment_status] : null)}
            {row("Treating hospital", details.treating_hospital)}
            {row("Other conditions", details.other_conditions)}
            {row("History taken in", [lang, summary.mode === "ritu" ? "voice" : "typed"].filter(Boolean).join(", "))}
          </dl>
        </section>

        {urgent.length > 0 && (
          <div className="rounded-lg border-2 border-red-600 px-5 py-3.5 text-[15px] text-red-800">
            <span className="font-bold uppercase tracking-wide">Attention: </span>
            the patient reported {urgent.map((u) => u.label.toLowerCase()).join(", ")}. Review before the visit.
          </div>
        )}

        <section className="space-y-2.5">
          <SectionTitle>History (patient-reported)</SectionTitle>
          <p className="text-[15px] leading-relaxed">{history}</p>
        </section>

        {complaints.length > 0 && (
          <section className="space-y-2.5">
            <SectionTitle>Presenting complaints</SectionTitle>
            <ol className="space-y-1.5">{complaints.map((f, i) => <Line key={f.id} f={f} numbered={i + 1} />)}</ol>
          </section>
        )}

        {block("Cancer treatment", facts("treatment"), null)}
        {block("Current medications", facts("medication"), checkIn ? null : "None reported.")}
        {block("Allergies", facts("allergy"), checkIn ? null : "None reported.")}
        {block("Hospital visits and investigations since last visit", facts("recent_care"), null)}
        {block("Past history", facts("past_history"), null)}
        {block("Records the patient has", facts("previous_record"), null)}
        {block("Patient's questions for the doctor", facts("concern"), null)}
      </div>

      {doctor && (
        <section className="border-t border-line px-8 py-5 text-[14px]">
          <div className="text-xs uppercase tracking-[0.12em] text-ink/60">Prepared for</div>
          <div className="mt-1 font-semibold">
            {doctor.name}
            {doctor.qualification ? <span className="font-normal text-ink/70">, {doctor.qualification}</span> : null}
          </div>
          <div className="text-ink/70">
            {[
              doctor.registration_number ? `Reg. No. ${doctor.registration_number}${doctor.medical_council ? ` (${doctor.medical_council})` : ""}` : null,
              doctor.hpr_id ? `HPR ID ${formatId14(doctor.hpr_id)}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Registration details not added"}
            {(doctor.registration_number || doctor.hpr_id) && <span className="text-ink/50"> · self-declared</span>}
          </div>
        </section>
      )}
      <footer className="flex flex-wrap items-end justify-between gap-4 border-t border-line px-8 py-5 text-xs leading-relaxed text-ink/60">
        <p className="max-w-2xl">
          Compiled from the patient&apos;s own words during an automated {checkIn ? "between-visit check-in" : "pre-visit conversation"} with Ritu
          {lang ? ` (${lang})` : ""}. Not clinically verified; nothing has been interpreted. Numbers in brackets show the patient&apos;s words.
          Synthetic demo patient.
        </p>
        <button onClick={() => window.print()} className="print-hide inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:border-ink/30">
          <Printer size={15} /> Print / save PDF
        </button>
      </footer>
    </article>
  );
}
