"use client";

import { Lock, Send } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { DocViewer, TimelineView, type Viewer } from "@/components/CaseViews";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Button, Card, Label, PageHeader } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Brief, CaseSummary, DocumentInfo, Sections, SourceRef, Timeline } from "@/lib/types";
import { caseTitle, SECTION_KEYS } from "@/lib/types";

const EMPTY: Sections = { key_changes: "", pending_investigations: "", discrepancies_noticed: "", treatment_history: "", red_flags: "" };
const LABELS: Record<keyof Sections, string> = {
  key_changes: "Key changes since last visit",
  pending_investigations: "Pending investigations",
  discrepancies_noticed: "Discrepancies noticed",
  treatment_history: "Treatment history",
  red_flags: "Red flags",
};

export default function CaseWorkspace() {
  const { id } = useParams<{ id: string }>();
  const me = useMe(["resident"]);
  const [kase, setKase] = useState<CaseSummary | null>(null);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState<Sections>(EMPTY);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const submitted = brief !== null && brief.status !== "draft";

  const load = useCallback(async () => {
    const [c, d] = await Promise.all([api<CaseSummary>(`/cases/${id}`), api<DocumentInfo[]>(`/cases/${id}/documents`)]);
    setKase(c);
    setDocs(d);
    if (d.length) setViewer((v) => v ?? { docId: d[0].id, page: 1 });
    try {
      const b = await api<Brief>(`/cases/${id}/brief`);
      setBrief(b);
      setDraft(b.sections);
      if (b.status !== "draft") setTimeline(await api<Timeline>(`/cases/${id}/timeline`));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }, [id]);

  useEffect(() => {
    if (me) load().catch((e) => setMessage(e.message));
  }, [me, load]);

  async function save() {
    const b = await api<Brief>(`/cases/${id}/brief`, { method: "PUT", body: JSON.stringify(draft) });
    setBrief(b);
    setMessage("Draft saved.");
  }

  async function submit() {
    if (!confirm("Submit your brief? It cannot be edited afterwards, and the AI timeline will unlock.")) return;
    try {
      await save();
      await api<Brief>(`/cases/${id}/brief/submit`, { method: "POST" });
      setMessage(null);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Submit failed");
    }
  }

  const openSource = (s: SourceRef) => setViewer({ docId: s.document_id, page: s.page_number, highlight: s.text_span });

  return (
    <Shell
      me={me}
      actions={
        !submitted && (
          <Button onClick={submit}>
            <Send size={17} /> Submit brief
          </Button>
        )
      }
    >
      {kase && (
        <PageHeader
          eyebrow={`Case · ${kase.case_code}`}
          live={!submitted}
          title={caseTitle(kase.title)}
          subtitle={kase.summary}
          actions={submitted ? <Badge tone="green">submitted {brief?.submitted_at && new Date(brief.submitted_at).toLocaleDateString()}</Badge> : <Badge tone="amber">{brief ? "draft" : "not started"}</Badge>}
        />
      )}
      {message && <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{message}</p>}

      {!submitted ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <DocViewer docs={docs} viewer={viewer} setViewer={setViewer} sticky />
          <div className="space-y-6">
            <Card className="p-6">
              <Label>Readiness brief</Label>
              <div className="mt-5 space-y-5">
                {SECTION_KEYS.map((k) => (
                  <label key={k} className="block">
                    <span className="text-[15px] font-semibold">{LABELS[k]}</span>
                    <textarea
                      value={draft[k]}
                      onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                      rows={3}
                      maxLength={5000}
                      className="mt-2 w-full rounded-xl border border-line bg-[#fcfbf9] px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-white focus:ring-4 focus:ring-brand/15"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => save().catch((e) => setMessage(e.message))}>
                  Save draft
                </Button>
                <Button onClick={submit}>
                  <Send size={17} /> Submit brief
                </Button>
              </div>
            </Card>
            <div className="flex items-center gap-4 rounded-2xl border border-dashed border-[#d8d5cc] bg-[#faf9f6] px-6 py-8">
              <Lock size={22} className="shrink-0 text-muted" strokeWidth={1.75} />
              <div>
                <p className="font-medium">AI timeline locked.</p>
                <p className="text-muted">It opens next to your brief once you submit.</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="p-6">
              <Label>Your brief</Label>
              <div className="mt-5 space-y-5">
                {SECTION_KEYS.map((k) => (
                  <div key={k}>
                    <h3 className="text-[15px] font-semibold">{LABELS[k]}</h3>
                    <p className="mt-1 whitespace-pre-wrap text-ink/80">{brief?.sections[k] || <span className="text-muted">(empty)</span>}</p>
                  </div>
                ))}
              </div>
            </Card>
            {timeline ? <TimelineView t={timeline} onSource={openSource} /> : <Card className="p-6 text-muted">Loading timeline…</Card>}
          </div>
          <div className="mt-6">
            <DocViewer docs={docs} viewer={viewer} setViewer={setViewer} />
          </div>
        </>
      )}
    </Shell>
  );
}
