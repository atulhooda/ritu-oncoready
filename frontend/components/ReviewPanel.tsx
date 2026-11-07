"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Check, Plus, Send, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import { setSummaryTarget } from "@/lib/summaryPoints";
import { buildSeries, TrendsGrid } from "@/components/Trends";
import { narrative } from "@/lib/narrative";
import type { CaseReview, DoctorRef, ReviewEventOut, IntakeFact, IntakeSummary, LabSeries, Me, Medicine, PatientDetails, ReviewContent, SummaryPoint, SymptomCourse } from "@/lib/types";
import { detailsLine } from "@/lib/types";

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

/** The kinds of point a junior adds, in the order the senior reads them. */
const KINDS: { key: SummaryPoint["kind"]; label: string; short: string; tone: string }[] = [
  { key: "concern", label: "Concerns", short: "Concern", tone: "border-red-300 bg-red-50 text-red-800" },
  { key: "finding", label: "From the records and conversation", short: "Finding", tone: "border-blue-300 bg-blue-50 text-blue-800" },
  { key: "question", label: "For the senior doctor", short: "For senior", tone: "border-amber-300 bg-amber-50 text-amber-900" },
];
const kindOf = (k: SummaryPoint["kind"]) => KINDS.find((x) => x.key === k)!;

type Fact = IntakeFact & { section: string; sectionLabel: string };
type Patient = {
  name: string;
  details: PatientDetails;
  records: number;
  medicines: Medicine[];
  labs: LabSeries[];
  course: SymptomCourse | null;
};

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
  const notes = KINDS.map((k) => ({ ...k, points: content.points.filter((p) => p.kind === k.key) })).filter((k) => k.points.length);
  const story = narrative({ name: patient.name, details: patient.details, facts: chosen, labs: patient.labs, medicines: patient.medicines });
  const series = buildSeries(patient.labs, patient.medicines, patient.course);
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
      <div>
        <Label>Overview</Label>
        <p className="mt-1.5 text-[15px] leading-relaxed">{story.join(" ")}</p>
        <p className="mt-1 text-xs text-muted">Built from the patient&apos;s report and the records; read the sources before relying on it.</p>
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
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed">
            {n.points.map((p, i) => (
              <li key={i}>
                <span className="whitespace-pre-wrap">{p.text}</span>
                {p.source && <span className="ml-1.5 rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-[11px] text-muted">· {p.source}</span>}
              </li>
            ))}
          </ul>
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
      {series.length > 0 && (
        <div>
          <Label>Over time · records and the patient&apos;s scores, on one timeline</Label>
          <div className="mt-2">
            <TrendsGrid series={series} cols={preview ? 1 : 2} />
          </div>
        </div>
      )}
      {patient.medicines.length > 0 && (
        <div>
          <Label>Medicines in the records</Label>
          <ul className="mt-2 space-y-1 text-[15px]">
            {patient.medicines.map((m) => (
              <li key={m.drug} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{m.drug}</span>
                {m.latest && (
                  <span className="text-sm text-muted">
                    {[`${m.latest.dose} ${m.latest.unit ?? ""}`.trim(), m.latest.frequency, m.latest.date ? `latest ${new Date(m.latest.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : null].filter(Boolean).join(" · ")}
                  </span>
                )}
                <span className="text-xs text-muted">· {m.entries.length} record entr{m.entries.length === 1 ? "y" : "ies"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">Drug interactions are not checked automatically; review the list against a drug reference.</p>
        </div>
      )}
      {!notes.length && !groups.length && <p className="text-muted">Nothing ticked or added yet.</p>}
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
  // While editing, Ritu's answers can be added as points ("Add to summary" under each answer).
  const [fromRitu, setFromRitu] = useState(0);
  useEffect(() => {
    if (!editable) return;
    setSummaryTarget(({ text, source }) => {
      setContent((c) => (c ? { ...c, points: [...c.points, { kind: "finding", text, source }] } : c));
      setDirty(true);
      setFromRitu((n) => n + 1);
    });
    return () => setSummaryTarget(null);
  }, [editable]);
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<SummaryPoint["kind"]>("finding");
  const newPoint = useRef<HTMLTextAreaElement>(null);

  if (review.status === "unassigned" || !content) {
    return (
      <Card className="p-6 sm:p-7">
        <Label>Summary for the senior doctor</Label>
        <p className="mt-3 text-muted">Waiting for a junior doctor. It goes to one automatically as soon as the hospital has an active junior.</p>
      </Card>
    );
  }

  if (!editable) {
    const isSenior = me.role === "doctor" && review.status === "with_senior" && review.senior?.id === me.id;
    return (
      <div className="max-w-3xl space-y-6">
        <Card className="p-6 sm:p-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <Label>Summary for the senior doctor</Label>
            {review.reviewed_at ? (
              <Badge tone="green">Reviewed by {review.reviewed_by?.name} · {at(review.reviewed_at)}</Badge>
            ) : review.status === "with_senior" ? (
              <Badge tone="green">Sent</Badge>
            ) : (
              <Badge tone="amber">Being prepared by {review.junior?.name}</Badge>
            )}
          </div>
          <SummaryCard patient={patient} facts={facts} content={content} review={review} />
          {isSenior && <SeniorActions caseId={caseId} review={review} onChange={onChange} />}
          <p className="mt-6 border-t border-line/70 pt-4 text-sm text-muted">The full report, check-ins, records and recording are in the tabs above.</p>
        </Card>
        <History events={review.history} />
      </div>
    );
  }
  const returned = review.history.at(-1)?.action === "returned" ? review.history.at(-1) : null;

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
  const empty = !content.facts.length && !content.points.some((p) => p.text.trim());
  const setPoints = (points: SummaryPoint[]) => edit({ ...content, points });
  const addPoint = () => {
    const text = draft.trim();
    if (!text) return;
    setPoints([...content.points, { kind: draftKind, text, source: null }]);
    setDraft("");
    newPoint.current?.focus();
  };
  const move = (i: number, by: number) => {
    const ps = [...content.points];
    [ps[i], ps[i + by]] = [ps[i + by], ps[i]];
    setPoints(ps);
  };

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
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px] [&>*]:min-w-0">
      <div className="space-y-6">
        {returned && (
          <Card className="border-amber-300 bg-amber-50 p-5">
            <p className="text-sm font-semibold text-amber-900">
              Returned by {returned.by?.name} · {at(returned.at)}
            </p>
            <p className="mt-1 text-ink">{returned.note}</p>
          </Card>
        )}
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
                  <div className="mb-2 text-[15px] font-semibold text-ink">{g.label}</div>
                  <ul className="divide-y divide-line/60 rounded-xl border border-line/80">
                    {g.facts.map((f) => {
                      const on = content.facts.includes(f.id);
                      return (
                        <li key={f.id}>
                          <label className={`flex cursor-pointer gap-3 px-4 py-3 transition ${on ? "bg-brand/[0.06] shadow-[inset_3px_0_0_#3a4fe0]" : "hover:bg-paper"}`}>
                            <input type="checkbox" checked={on} onChange={() => toggle(f.id)} className="mt-1 h-4 w-4 shrink-0 accent-[#3a4fe0]" />
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{f.label}</span>
                                {detailText(f) && <span className="text-sm text-muted">{detailText(f)}</span>}
                                {f.urgent && <Badge tone="red">Urgent sign</Badge>}
                              </span>
                              <span className="mt-0.5 block line-clamp-2 text-sm italic text-muted">“{f.quote}”</span>
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
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Label>2 · Your points</Label>
            <span className="text-sm text-muted">{content.points.length} added</span>
          </div>
          <p className="mt-1 text-sm text-muted">
            One point at a time: what you found in the records, a concern, or a question for the senior. Or ask Ritu (bottom right) and tap
            <span className="font-medium text-brand"> Add to summary</span> under the answer.
          </p>

          {content.points.length > 0 && (
            <ul className="mt-4 space-y-2">
              {content.points.map((p, i) => (
                <li key={i} className="group flex items-start gap-2 rounded-xl border border-line/80 bg-white px-3 py-2.5">
                  <select
                    aria-label="Kind of point"
                    value={p.kind}
                    onChange={(e) => setPoints(content.points.map((x, j) => (j === i ? { ...x, kind: e.target.value as SummaryPoint["kind"] } : x)))}
                    className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold outline-none ${kindOf(p.kind).tone}`}
                  >
                    {KINDS.map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.short}
                      </option>
                    ))}
                  </select>
                  <div className="min-w-0 flex-1">
                    <textarea
                      value={p.text}
                      onChange={(e) => setPoints(content.points.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                      rows={Math.min(6, Math.max(1, Math.ceil(p.text.length / 70)))}
                      className="w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none"
                    />
                    {p.source && <div className="text-xs text-muted">Source: {p.source}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 text-muted opacity-60 transition group-hover:opacity-100">
                    <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="rounded p-1 hover:bg-paper disabled:opacity-30">
                      <ArrowUp size={15} />
                    </button>
                    <button onClick={() => move(i, 1)} disabled={i === content.points.length - 1} aria-label="Move down" className="rounded p-1 hover:bg-paper disabled:opacity-30">
                      <ArrowDown size={15} />
                    </button>
                    <button onClick={() => setPoints(content.points.filter((_, j) => j !== i))} aria-label="Remove point" className="rounded p-1 hover:bg-red-50 hover:text-red-700">
                      <X size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 rounded-xl border border-line bg-paper/60 p-3 focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/15">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  onClick={() => setDraftKind(k.key)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${draftKind === k.key ? k.tone : "border-line bg-white text-ink/60 hover:border-ink/30"}`}
                >
                  {k.short}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <textarea
                id="review-new-point"
                ref={newPoint}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    addPoint();
                  }
                }}
                rows={1}
                placeholder={
                  draftKind === "concern" ? "e.g. Ankle swelling and breathlessness while on trastuzumab"
                    : draftKind === "question" ? "e.g. Repeat echo before the next cycle?"
                    : "e.g. Echo 12 Mar: LVEF 48%, was 60% in Jan"
                }
                className="min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-[15px] outline-none placeholder:text-muted/70"
              />
              <Button onClick={addPoint} disabled={!draft.trim()} className="px-4 py-2.5">
                <Plus size={17} /> Add
              </Button>
            </div>
            <div className="mt-1 px-1 text-xs text-muted">Enter adds the point · Shift+Enter for a new line</div>
          </div>
          {fromRitu > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-brand">
              <Sparkles size={14} /> {fromRitu} point{fromRitu === 1 ? "" : "s"} added from Ritu. Edit the wording if needed.
            </p>
          )}
        </Card>

        <Card className="p-5 sm:p-6">
          <Label>3 · Send</Label>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <select
              id="review-senior"
              value={senior}
              onChange={(e) => setSenior(e.target.value)}
              className="w-full rounded-xl border border-line bg-white px-4 py-3 text-[15px] outline-none focus:border-brand sm:w-auto sm:min-w-[220px] sm:flex-none"
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

/** The senior doctor's sign-off, or the summary back to the junior with a reason. */
function SeniorActions({ caseId, review, onChange }: { caseId: string; review: CaseReview; onChange: (r: CaseReview) => void }) {
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(path: "reviewed" | "return") {
    setBusy(true);
    setError(null);
    try {
      onChange(await api<CaseReview>(`/doctor/patients/${caseId}/${path}`, {
        method: "POST", body: path === "return" ? JSON.stringify({ note }) : undefined,
      }));
      setReturning(false);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-6 border-t border-line/70 pt-5">
      {returning ? (
        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="return-note">What should the junior change?</label>
          <textarea id="return-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3}
            className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm" />
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy || !note.trim()} onClick={() => act("return")}>{busy ? "Returning…" : "Return to junior"}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => setReturning(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {!review.reviewed_at && (
            <Button disabled={busy} onClick={() => act("reviewed")}>
              <Check size={17} /> {busy ? "Saving…" : "Mark reviewed"}
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => setReturning(true)}>Return to junior…</Button>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}

const ACTIONS: Record<ReviewEventOut["action"], string> = {
  assigned: "Assigned to the junior", saved: "Summary saved", sent: "Sent to the senior", reviewed: "Reviewed", returned: "Returned to the junior",
};

/** Who did what and when; each step keeps the summary as it stood then. */
function History({ events }: { events: ReviewEventOut[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!events.length) return null;
  return (
    <Card className="p-6 sm:p-7">
      <Label>History</Label>
      <ol className="mt-4 space-y-3">
        {events.map((e, i) => (
          <li key={i} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs text-muted">{at(e.at)}</span>
              <span className="font-medium">{ACTIONS[e.action]}</span>
              <span className="text-muted">{e.by ? `by ${e.by.name}` : "automatically"}</span>
              {e.summary && (e.action === "saved" || e.action === "sent") && (
                <button onClick={() => setOpen(open === i ? null : i)} className="text-brand hover:underline">
                  {open === i ? "Hide summary" : "Summary at this step"}
                </button>
              )}
            </div>
            {e.note && <p className="mt-1 text-ink/80">“{e.note}”</p>}
            {open === i && <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-paper p-3 font-sans text-xs text-ink/80">{e.summary}</pre>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
