"use client";

import { AlertTriangle, Check, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { CaseReview, DoctorRef, IntakeFact, IntakeSummary, Me, PatientDetails, ReviewContent } from "@/lib/types";
import { detailsLine } from "@/lib/types";

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

const NOTES = [
  { key: "findings", label: "From the records and conversation", placeholder: "What you found in the records, transcript or recording. E.g. Echo 12 Mar: LVEF 48%, was 60% in Jan." },
  { key: "concerns", label: "Concerns", placeholder: "What the senior should look at first." },
  { key: "questions", label: "For the senior doctor", placeholder: "Questions or decisions you need from them." },
] as const;

type Fact = IntakeFact & { section: string; sectionLabel: string };
type Patient = { name: string; details: PatientDetails; records: number };

/** "score: 5/10, location: Head" -> "5/10 · Head" */
const detailText = (f: IntakeFact) => Object.values(f.details).filter(Boolean).join(" · ");

/** The summary as the senior doctor reads it. Also the live preview while the junior writes it. */
function SummaryCard({ patient, facts, content, review, preview }: { patient: Patient; facts: Fact[]; content: ReviewContent; review: CaseReview; preview?: boolean }) {
  const chosen = facts.filter((f) => content.facts.includes(f.id));
  const urgent = chosen.filter((f) => f.urgent);
  const groups = chosen.reduce<{ label: string; facts: Fact[] }[]>((gs, f) => {
    const last = gs[gs.length - 1];
    if (last?.label === f.sectionLabel) last.facts.push(f);
    else gs.push({ label: f.sectionLabel, facts: [f] });
    return gs;
  }, []);
  const notes = NOTES.filter((n) => content[n.key].trim());
  return (
    <div className="space-y-5">
      <div>
        <div className="text-xl font-semibold">{patient.name}</div>
        <div className="text-muted">{[detailsLine(patient.details), patient.details.stage_reported, `${patient.records} record${patient.records === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</div>
        {!preview && review.junior && (
          <div className="mt-2 text-sm text-muted">
            From {review.junior.name}
            {review.senior ? ` to ${review.senior.name}` : ""}
            {review.sent_at ? ` · ${at(review.sent_at)}` : ""}
          </div>
        )}
      </div>
      {urgent.length > 0 && (
        <div className="flex gap-2.5 rounded-xl border border-red-600/60 bg-red-50 px-4 py-3 text-[15px] text-red-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold">On the urgent-signs list: </span>
            {urgent.map((f) => f.label.toLowerCase()).join(", ")}
          </span>
        </div>
      )}
      {notes.map((n) => (
        <div key={n.key}>
          <Label>{n.label}</Label>
          <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed">{content[n.key]}</p>
        </div>
      ))}
      {groups.map((g) => (
        <div key={g.label}>
          <Label>{g.label} · as the patient said</Label>
          <ul className="mt-2 space-y-1.5">
            {g.facts.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-2 text-[15px]">
                <span className={`font-medium ${f.urgent ? "text-red-800" : ""}`}>{f.label}</span>
                {detailText(f) && <span className="text-sm text-muted">{detailText(f)}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!notes.length && !groups.length && <p className="text-muted">Nothing ticked or written yet.</p>}
    </div>
  );
}

/** The junior doctor's summary for the senior. The assigned junior ticks what the senior should see
 *  from the patient's report, adds notes and sends it to a senior they choose; everyone else reads it. */
export function ReviewPanel({ caseId, me, review, report, patient, onChange }: {
  caseId: string;
  me: Me;
  review: CaseReview;
  report: IntakeSummary | null;
  patient: Patient;
  onChange: (r: CaseReview) => void;
}) {
  const editable = me.role === "doctor" && review.status === "with_junior" && review.junior?.id === me.id;
  const facts: Fact[] = useMemo(
    () => (report?.sections ?? []).flatMap((s) => s.facts.map((f) => ({ ...f, section: s.section, sectionLabel: s.label }))),
    [report],
  );
  const [content, setContent] = useState<ReviewContent | null>(review.content);
  const [dirty, setDirty] = useState(false);
  const [seniors, setSeniors] = useState<DoctorRef[]>([]);
  const [senior, setSenior] = useState("");
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(review.content);
    setDirty(false);
  }, [review.content]);
  useEffect(() => {
    if (editable) api<DoctorRef[]>("/doctor/seniors").then(setSeniors).catch(() => {});
  }, [editable]);

  if (review.status === "unassigned" || !content) {
    return (
      <Card className="p-6 sm:p-7">
        <Label>Summary for the senior doctor</Label>
        <p className="mt-3 text-muted">Waiting for a junior doctor. It goes to one automatically as soon as the hospital has an active junior.</p>
      </Card>
    );
  }

  if (!editable) {
    return (
      <Card className="max-w-3xl p-6 sm:p-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Label>Summary for the senior doctor</Label>
          {review.status === "with_senior" ? <Badge tone="green">Sent</Badge> : <Badge tone="amber">Being prepared by {review.junior?.name}</Badge>}
        </div>
        <SummaryCard patient={patient} facts={facts} content={content} review={review} />
        <p className="mt-6 border-t border-line/70 pt-4 text-sm text-muted">The full report, check-ins, records and recording are in the tabs above.</p>
      </Card>
    );
  }

  const edit = (next: ReviewContent) => {
    setContent(next);
    setDirty(true);
  };
  const toggle = (id: string) => edit({ ...content, facts: content.facts.includes(id) ? content.facts.filter((x) => x !== id) : [...content.facts, id] });
  const sections = facts.reduce<{ label: string; facts: Fact[] }[]>((gs, f) => {
    const g = gs.find((x) => x.label === f.sectionLabel);
    if (g) g.facts.push(f);
    else gs.push({ label: f.sectionLabel, facts: [f] });
    return gs;
  }, []);
  const empty = !content.facts.length && !NOTES.some((n) => content[n.key].trim());

  async function run(kind: "save" | "send") {
    setBusy(kind);
    setError(null);
    try {
      const r = kind === "save"
        ? await api<CaseReview>(`/doctor/patients/${caseId}/summary`, { method: "PUT", body: JSON.stringify(content) })
        : await api<CaseReview>(`/doctor/patients/${caseId}/send`, { method: "POST", body: JSON.stringify({ ...content, senior_user_id: senior }) });
      onChange(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-6">
        <Card className="p-6 sm:p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Label>1 · What the patient reported</Label>
            <span className="text-sm text-muted">
              {content.facts.length} of {facts.length} ticked for the senior
            </span>
          </div>
          {facts.length === 0 ? (
            <p className="mt-4 text-muted">Nothing was noted in the conversation.</p>
          ) : (
            <div className="mt-4 space-y-5">
              {sections.map((g) => (
                <div key={g.label}>
                  <div className="mb-1.5 text-sm font-semibold text-ink/70">{g.label}</div>
                  <ul className="divide-y divide-line/60 rounded-xl border border-line/80">
                    {g.facts.map((f) => {
                      const on = content.facts.includes(f.id);
                      return (
                        <li key={f.id}>
                          <label className={`flex cursor-pointer gap-3 px-4 py-3 transition ${on ? "bg-brand/[0.04]" : "hover:bg-paper"}`}>
                            <input type="checkbox" checked={on} onChange={() => toggle(f.id)} className="mt-1 h-4 w-4 shrink-0 accent-[#3a4fe0]" />
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{f.label}</span>
                                {detailText(f) && <span className="text-sm text-muted">{detailText(f)}</span>}
                                {f.urgent && <Badge tone="red">Urgent sign</Badge>}
                              </span>
                              <span className="mt-0.5 block truncate text-sm italic text-muted">“{f.quote}”</span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-6 sm:p-7">
          <Label>2 · Your notes</Label>
          <p className="mt-1 text-sm text-muted">Check the records and conversation (tabs above, or ask Ritu at the bottom right). Leave a box empty to skip it.</p>
          <div className="mt-5 space-y-5">
            {NOTES.map((n) => (
              <label key={n.key} className="block">
                <span className="mb-1.5 block font-medium">{n.label}</span>
                <textarea
                  id={`review-${n.key}`}
                  value={content[n.key]}
                  onChange={(e) => edit({ ...content, [n.key]: e.target.value })}
                  placeholder={n.placeholder}
                  rows={n.key === "findings" ? 4 : 2}
                  className="w-full resize-y rounded-xl border border-line bg-white px-4 py-3 text-[15px] leading-relaxed outline-none placeholder:text-muted/70 focus:border-brand focus:ring-4 focus:ring-brand/15"
                />
              </label>
            ))}
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <Label>3 · Send</Label>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <select
              id="review-senior"
              value={senior}
              onChange={(e) => setSenior(e.target.value)}
              className="min-w-[220px] flex-1 rounded-xl border border-line bg-white px-4 py-3 text-[15px] outline-none focus:border-brand sm:flex-none"
            >
              <option value="">Choose a senior doctor…</option>
              {seniors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button disabled={busy !== null || !senior || empty} onClick={() => run("send")}>
              <Send size={17} /> {busy === "send" ? "Sending…" : "Send to senior"}
            </Button>
            <Button variant="secondary" disabled={busy !== null || empty || !dirty} onClick={() => run("save")}>
              <Check size={17} /> {busy === "save" ? "Saving…" : "Save draft"}
            </Button>
            <span className="text-sm text-muted">
              {dirty ? "Unsaved changes" : review.summary_is_draft ? "Not saved yet" : `Saved ${at(review.summary_updated_at)}`}
            </span>
          </div>
          {seniors.length === 0 && <p className="mt-3 text-sm text-muted">No senior doctors yet: ask the hospital to add one.</p>}
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        </Card>
      </div>

      <div className="xl:sticky xl:top-24 xl:h-fit">
        <Card className="p-6">
          <div className="mb-5 flex items-center justify-between gap-2">
            <Label>Preview · what the senior sees</Label>
          </div>
          <SummaryCard patient={patient} facts={facts} content={content} review={review} preview />
        </Card>
      </div>
    </div>
  );
}
