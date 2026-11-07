"use client";

import { useState } from "react";

import { dayMonthYear } from "@/components/CaseViews";
import { Badge, Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { MissingItem, PatientRequestOut, PatientWords, Readiness, SourceRef } from "@/lib/types";

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
  caseId,
  requests,
  onRequests,
}: {
  r: Readiness;
  onSource: (s: SourceRef) => void;
  onWords: (w: PatientWords) => void;
  caseId: string;
  requests: PatientRequestOut[];
  onRequests: (rs: PatientRequestOut[]) => void;
}) {
  const ask = (kind: PatientRequestOut["kind"], text: string) =>
    api<PatientRequestOut[]>(`/doctor/patients/${caseId}/requests`, { method: "POST", body: JSON.stringify({ kind, text }) }).then(onRequests);
  const asked = new Set(requests.map((q) => q.text));
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
                    {w.details?.trend === "resolved" && <Badge tone="green">gone now</Badge>}
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
          {r.advised_tests && (
            <div className="mt-5 border-t border-line/70 pt-4">
              <h3 className="mb-2 text-sm font-semibold text-ink/80">Advised at the last consultation ({day(r.advised_tests.date)})</h3>
              <ul className="space-y-2">
                {r.advised_tests.items.map((t, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {t.status === "result_in_records" ? (
                      <Badge tone="green">result in records</Badge>
                    ) : t.status === "no_result" ? (
                      <Badge tone="amber">no result yet</Badge>
                    ) : (
                      <Badge tone="slate">check</Badge>
                    )}
                    <span className="font-medium">{t.text}</span>
                    {t.result && (
                      <>
                        <span className="text-sm text-muted">{day(t.result.date)}</span>
                        {page(t.result.source)}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
                <MissingRow m={m} words={words} onSource={onSource} ask={ask} asked={asked} />
              </li>
            ))}
            {!r.inconsistent.length && !r.missing.length && <li className="text-muted">Nothing found.</li>}
          </ul>
        </Card>
      </div>

      <AskPatient requests={requests} ask={ask} />

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

/** What the record request for a "not uploaded" item says to the patient. */
const recordAsk = (m: Extract<MissingItem, { kind: "record_not_uploaded" }>) =>
  `Please upload your ${m.tests.map(testName).join(" / ")} report${m.record_date ? ` (${m.record_date})` : ""}${m.facility ? ` from ${m.facility}` : ""}.`;

function MissingRow({
  m,
  words,
  onSource,
  ask,
  asked,
}: {
  m: MissingItem;
  words: (w: PatientWords) => React.ReactNode;
  onSource: (s: SourceRef) => void;
  ask: (kind: PatientRequestOut["kind"], text: string) => Promise<void>;
  asked: Set<string>;
}) {
  switch (m.kind) {
    case "record_not_uploaded":
      return (
        <div>
          <MissingRecord m={m} words={words} />
          {asked.has(recordAsk(m)) ? (
            <span className="mt-1 inline-block text-sm text-muted">Asked the patient.</span>
          ) : (
            <button onClick={() => ask("record", recordAsk(m))} className="mt-1 text-sm font-medium text-brand hover:underline">
              Ask the patient to upload it
            </button>
          )}
        </div>
      );
    case "medicine_not_in_records":
      return <MedicineOnlyFromPatient m={m} words={words} />;
    default:
      return <OtherMissing m={m} onSource={onSource} />;
  }
}

function MissingRecord({ m, words }: { m: Extract<MissingItem, { kind: "record_not_uploaded" }>; words: (w: PatientWords) => React.ReactNode }) {
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
}

function MedicineOnlyFromPatient({ m, words }: { m: Extract<MissingItem, { kind: "medicine_not_in_records" }>; words: (w: PatientWords) => React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <Badge tone="amber">only from the patient</Badge>
      <span>
        <span className="font-medium">{m.label}</span>: no record names it.
      </span>
      {words(m)}
    </div>
  );
}

function OtherMissing({ m, onSource }: { m: MissingItem; onSource: (s: SourceRef) => void }) {
  switch (m.kind) {
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

/** Ask the patient for more before the visit; their answers come back here. */
function AskPatient({ requests, ask }: { requests: PatientRequestOut[]; ask: (kind: PatientRequestOut["kind"], text: string) => Promise<void> }) {
  const [kind, setKind] = useState<PatientRequestOut["kind"]>("question");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      await ask(kind, text);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-6 sm:p-7">
      <Label>Ask the patient</Label>
      <p className="mb-4 mt-1 text-sm text-muted">The patient sees this on their page and answers there, or uploads the record.</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <select value={kind} onChange={(e) => setKind(e.target.value as PatientRequestOut["kind"])} aria-label="What to ask for"
          className="rounded-xl border border-line bg-white px-3 py-2">
          <option value="question">A question</option>
          <option value="record">A record to upload</option>
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} aria-label="Your request"
          placeholder={kind === "question" ? "e.g. How many days did the fever last?" : "e.g. Please upload your last CT report"}
          className="min-w-0 flex-1 rounded-xl border border-line bg-white px-3 py-2" />
        <Button disabled={busy || !text.trim()} onClick={send}>{busy ? "Sending…" : "Send"}</Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {requests.length > 0 && (
        <ul className="mt-5 space-y-3 border-t border-line/70 pt-4">
          {requests.map((q) => (
            <li key={q.id} className="text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge tone={q.status === "answered" ? "green" : "amber"}>{q.status === "answered" ? "answered" : "waiting"}</Badge>
                <span className="font-medium">{q.text}</span>
                <span className="text-muted">
                  {q.asked_by?.name} · {dayMonthYear(q.asked_at)}
                </span>
              </div>
              {q.status === "answered" && (
                <p className="mt-1 text-ink/80">
                  {q.kind === "question" ? `“${q.answer}”` : q.document ? `Uploaded: ${q.document.filename} (in Records & timeline)` : "Uploaded (since removed by the patient)"}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
