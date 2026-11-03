"use client";

import { Check, Send } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge, Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { CaseReview, DoctorRef, Me } from "@/lib/types";

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

/** The junior doctor's summary for the senior. The assigned junior edits it and sends it to a senior
 *  they choose; everyone else (the senior, the hospital) reads it. */
export function ReviewPanel({ caseId, me, review, onChange }: { caseId: string; me: Me; review: CaseReview; onChange: (r: CaseReview) => void }) {
  const editable = me.role === "doctor" && review.status === "with_junior" && review.junior?.id === me.id;
  const [text, setText] = useState(review.summary ?? "");
  const [seniors, setSeniors] = useState<DoctorRef[]>([]);
  const [senior, setSenior] = useState("");
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setText(review.summary ?? ""), [review.summary]);
  useEffect(() => {
    if (editable) api<DoctorRef[]>("/doctor/seniors").then(setSeniors).catch(() => {});
  }, [editable]);

  async function run(kind: "save" | "send") {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      const r = kind === "save"
        ? await api<CaseReview>(`/doctor/patients/${caseId}/summary`, { method: "PUT", body: JSON.stringify({ summary: text }) })
        : await api<CaseReview>(`/doctor/patients/${caseId}/send`, { method: "POST", body: JSON.stringify({ summary: text, senior_user_id: senior }) });
      onChange(r);
      setNote(kind === "save" ? "Saved." : `Sent to ${r.senior?.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  if (review.status === "unassigned") {
    return (
      <Card className="p-6 sm:p-7">
        <Label>Summary for the senior doctor</Label>
        <p className="mt-3 text-muted">Not assigned to a junior doctor yet. The hospital assigns it from its Patients page.</p>
      </Card>
    );
  }

  return (
    <Card className="p-6 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>Summary for the senior doctor</Label>
        <div className="flex flex-wrap gap-2 text-sm">
          {review.junior && <Badge>Junior: {review.junior.name}</Badge>}
          {review.status === "with_senior" ? (
            <Badge tone="green">Sent to {review.senior?.name} · {at(review.sent_at)}</Badge>
          ) : (
            <Badge tone="amber">{review.summary_is_draft ? "Draft from the patient's report" : `Saved ${at(review.summary_updated_at)}`}</Badge>
          )}
        </div>
      </div>

      {editable ? (
        <>
          <p className="mt-3 text-[15px] text-muted">
            Start from the patient&apos;s report below, add what you found in the records, transcript and recording (ask Ritu at the bottom right), then send it to a senior doctor.
          </p>
          <textarea
            id="review-summary"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            className="mt-4 w-full rounded-xl border border-line bg-white px-4 py-3 font-mono text-[14px] leading-relaxed outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={busy !== null || !text.trim()} onClick={() => run("save")}>
              <Check size={17} /> {busy === "save" ? "Saving…" : "Save"}
            </Button>
            <select
              id="review-senior"
              value={senior}
              onChange={(e) => setSenior(e.target.value)}
              className="rounded-xl border border-line bg-white px-4 py-3 text-[15px] outline-none focus:border-brand"
            >
              <option value="">Choose a senior doctor…</option>
              {seniors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button disabled={busy !== null || !senior || !text.trim()} onClick={() => run("send")}>
              <Send size={17} /> {busy === "send" ? "Sending…" : "Send to senior"}
            </Button>
            {seniors.length === 0 && <span className="text-sm text-muted">No senior doctors yet: ask the hospital to add one.</span>}
          </div>
        </>
      ) : (
        <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-paper px-5 py-4 font-sans text-[15px] leading-relaxed text-ink/90">
          {review.summary || "No summary yet."}
        </pre>
      )}
      {note && <p className="mt-3 text-sm text-green-700">{note}</p>}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Card>
  );
}
