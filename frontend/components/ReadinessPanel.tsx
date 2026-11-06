"use client";

import { dayMonthYear } from "@/components/CaseViews";
import { Badge, Card, Label } from "@/components/ui";
import type { MissingItem, PatientWords, Readiness, SourceRef } from "@/lib/types";

/**
 * Before this consult: what changed since the last visit, what is still pending, what is missing
 * or does not agree, and where the patient is in their care. Every line opens its record page or
 * the patient's own words. Values are shown as written, never as better or worse.
 */
// derive.py's canonical test keys, as a doctor writes them
const TEST_NAMES: Record<string, string> = {
  ct: "CT", pet_ct: "PET-CT", mri: "MRI", pft: "PFT", her2_fish: "HER2 FISH", molecular_panel: "molecular panel",
};
const testName = (key: string) => TEST_NAMES[key] ?? key.replaceAll("_", " ");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ReadinessPanel({
  r,
  onSource,
  onWords,
}: {
  r: Readiness;
  onSource: (s: SourceRef) => void;
  onWords: (w: PatientWords) => void;
}) {
  const c = r.changes;
  const page = (s: SourceRef | null | undefined) =>
    s && (
      <button onClick={() => onSource(s)} className="whitespace-nowrap text-sm text-brand hover:underline">
        {s.filename} p.{s.page_number}
      </button>
    );
  const words = (w: PatientWords) => (
    <button onClick={() => onWords(w)} className="text-left text-sm italic text-ink/70 hover:text-brand hover:underline">
      “{w.quote}”
    </button>
  );
  const day = (iso: string | null | undefined) => (iso ? dayMonthYear(iso) : "date unclear");
  const since = r.last_visit
    ? `${r.last_visit.basis === "consultation" ? "last consultation in OncoReady" : "latest clinic note in the records"}, ${day(r.last_visit.date)}`
    : null;
  const changeCount = c
    ? c.new_records.length + c.events.length + c.labs.length + c.medicines.length + c.patient.symptoms.length + c.patient.hospital_visits.length
    : 0;

  return (
    <div className="space-y-6">
      <Card className="p-6 sm:p-7">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <Label>Since the last visit</Label>
          <span className="text-sm text-muted">
            {since ? <>Measured from the {since} {r.last_visit?.source && page(r.last_visit.source)}</> : "No earlier visit found in OncoReady or the records."}
          </span>
        </div>
        {!c ? (
          <p className="text-muted">Nothing to compare with yet. Pending items, gaps and milestones are below.</p>
        ) : changeCount === 0 && c.patient.medicines.length === 0 ? (
          <p className="text-muted">Nothing new in the records or from the patient since then.</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {c.labs.length > 0 && (
              <Section title="Values in the records">
                {c.labs.map((l) => (
                  <li key={l.label} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-medium">{capital(l.label)}</span>
                    <span className="font-mono text-sm">
                      {l.before ? `${l.before.value} (${day(l.before.date)}) → ` : ""}
                      {l.after.value}
                      {l.unit ? ` ${l.unit}` : ""} ({day(l.after.date)})
                    </span>
                    {l.readings_since > 1 && <span className="text-xs text-muted">{l.readings_since} readings since</span>}
                    {page(l.after.source)}
                  </li>
                ))}
              </Section>
            )}
            {c.medicines.length > 0 && (
              <Section title="Medicines in the records">
                {c.medicines.map((m) => (
                  <li key={m.drug} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Badge tone={m.change === "new" ? "blue" : "slate"}>{m.change === "new" ? "first recorded" : "dose written differently"}</Badge>
                    <span className="font-medium">{m.drug}</span>
                    <span className="font-mono text-sm">
                      {m.before ? `${m.before.dose ?? "?"} ${m.before.unit ?? ""} → ` : ""}
                      {m.after.dose ?? ""} {m.after.unit ?? ""} ({day(m.after.date)})
                    </span>
                    {page(m.after.source)}
                  </li>
                ))}
              </Section>
            )}
            {(c.patient.symptoms.length > 0 || c.patient.hospital_visits.length > 0 || c.patient.medicines.length > 0) && (
              <Section title={`What the patient told Ritu (${c.patient.conversations} conversation${c.patient.conversations === 1 ? "" : "s"})`}>
                {[...c.patient.symptoms, ...c.patient.hospital_visits, ...c.patient.medicines].map((w, i) => (
                  <li key={`${w.session_id}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {w.urgent && <Badge tone="red">urgent sign</Badge>}
                    <span className="font-medium">{w.label}</span>
                    {words(w)}
                  </li>
                ))}
              </Section>
            )}
            {(c.events.length > 0 || c.new_records.length > 0) && (
              <Section title="New in the records">
                {c.new_records.map((d) => (
                  <li key={d.id} className="text-sm">
                    <Badge tone="slate">uploaded {day(d.uploaded_at)}</Badge> <span className="font-medium">{d.filename}</span>
                  </li>
                ))}
                {c.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-mono text-xs text-muted">
                      {day(e.event_date)}
                      {e.date_basis === "document" ? " (page date)" : ""}
                    </span>
                    <span>{e.description}</span>
                    {page(e.source)}
                  </li>
                ))}
              </Section>
            )}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6 sm:p-7">
          <Label>Pending investigations</Label>
          <p className="mb-3 mt-1 text-sm text-muted">Ordered in the records, with no result on or after the order.</p>
          <ul className="space-y-2">
            {r.pending_tests.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge tone="amber">pending</Badge>
                <span className="font-medium">{testName(t.test_name)}</span>
                {t.ordered_date && <span className="text-sm text-muted">ordered {day(t.ordered_date)}</span>}
                {page(t.source)}
              </li>
            ))}
            {!r.pending_tests.length && <li className="text-muted">None found in the records.</li>}
          </ul>
        </Card>

        <Card className="p-6 sm:p-7">
          <Label>Missing or not agreeing</Label>
          <p className="mb-3 mt-1 text-sm text-muted">For the doctor to check; nothing here is a finding.</p>
          <ul className="space-y-3">
            {r.inconsistent.map((d) => (
              <li key={d.id}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone="blue">records disagree</Badge>
                  <span>{d.description}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3">{d.events.map((e) => <span key={e.id}>{page(e.source)}</span>)}</div>
              </li>
            ))}
            {r.missing.map((m, i) => (
              <li key={i}>
                <MissingRow m={m} words={words} onSource={onSource} />
              </li>
            ))}
            {!r.inconsistent.length && !r.missing.length && <li className="text-muted">Nothing found.</li>}
          </ul>
        </Card>
      </div>

      <Card className="p-6 sm:p-7">
        <Label>Care milestones</Label>
        <p className="mb-3 mt-1 text-sm text-muted">As the records state them, oldest first.</p>
        {r.milestones.length ? (
          <ol className="relative space-y-3 border-l border-line pl-5">
            {r.milestones.map((m, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-brand" aria-hidden />
                <span className="font-mono text-xs text-muted">{day(m.date)}</span>
                <span className="font-medium">
                  {m.label}
                  {m.cycle ? ` · cycle ${m.cycle}${m.of ? ` of ${m.of}` : ""}` : ""}
                </span>
                <span className="text-sm text-ink/80">{m.description}</span>
                {page(m.source)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted">No dated pathology, treatment, procedure or imaging in the records yet.</p>
        )}
      </Card>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink/80">{title}</h3>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}

function MissingRow({
  m,
  words,
  onSource,
}: {
  m: MissingItem;
  words: (w: PatientWords) => React.ReactNode;
  onSource: (s: SourceRef) => void;
}) {
  switch (m.kind) {
    case "record_not_uploaded":
      return (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Badge tone="amber">not uploaded</Badge>
          <span>
            Patient mentioned a {m.tests.map(testName).join(" / ")} report
            {m.record_date ? ` (${m.record_date})` : ""}
            {m.facility ? ` from ${m.facility}` : ""}; none in the records.
          </span>
          {words(m)}
        </div>
      );
    case "medicine_not_in_records":
      return (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Badge tone="amber">only from the patient</Badge>
          <span>
            <span className="font-medium">{m.label}</span>: no record names it.
          </span>
          {words(m)}
        </div>
      );
    case "page_hard_to_read":
      return (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Badge tone="slate">hard to read</Badge>
          <span>Words may be missing (read with {Math.round(m.confidence * 100)}% confidence).</span>
          <button
            onClick={() => onSource({ document_id: m.document_id, filename: m.filename ?? "", page_number: m.page_number, page_url: "", image_url: "", text_span: "" })}
            className="text-sm text-brand hover:underline"
          >
            {m.filename} p.{m.page_number}
          </button>
        </div>
      );
    case "facts_without_date":
      return (
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge tone="slate">no date</Badge>
          <span>
            {m.count} fact{m.count === 1 ? "" : "s"} in the records {m.count === 1 ? "has" : "have"} no readable date (see Records & timeline).
          </span>
        </div>
      );
    case "record_failed":
      return (
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge tone="red">not read</Badge>
          <span>
            <span className="font-medium">{m.filename}</span> could not be processed{m.error ? `: ${m.error}` : ""}.
          </span>
        </div>
      );
  }
}
