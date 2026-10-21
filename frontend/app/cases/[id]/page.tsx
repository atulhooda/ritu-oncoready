"use client";

import { ChevronLeft, ChevronRight, FileText, Lock, Send } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageImage } from "@/components/PageImage";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Button, Card, Label, PageHeader, Pill } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Brief, CaseSummary, DocumentInfo, Sections, SourceRef, Timeline, TimelineEvent } from "@/lib/types";
import { caseTitle, SECTION_KEYS } from "@/lib/types";

const EMPTY: Sections = { key_changes: "", pending_investigations: "", discrepancies_noticed: "", treatment_history: "", red_flags: "" };
const LABELS: Record<keyof Sections, string> = {
  key_changes: "Key changes since last visit",
  pending_investigations: "Pending investigations",
  discrepancies_noticed: "Discrepancies noticed",
  treatment_history: "Treatment history",
  red_flags: "Red flags",
};

type Viewer = { docId: string; page: number; highlight?: string };

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

function DocViewer({
  docs,
  viewer,
  setViewer,
  sticky,
}: {
  docs: DocumentInfo[];
  viewer: Viewer | null;
  setViewer: (v: Viewer) => void;
  sticky?: boolean;
}) {
  const doc = docs.find((d) => d.id === viewer?.docId);
  return (
    <Card className={`h-fit p-6 ${sticky ? "xl:sticky xl:top-24" : ""}`}>
      <Label>Source documents</Label>
      {!docs.length && <p className="mt-4 text-muted">No documents.</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {docs.map((d) => (
          <Pill key={d.id} active={d.id === viewer?.docId} onClick={() => setViewer({ docId: d.id, page: 1 })}>
            <span className="inline-flex items-center gap-1.5">
              <FileText size={14} /> {d.filename.replace(/\.pdf$/, "")}
            </span>
          </Pill>
        ))}
      </div>
      {doc && viewer && (
        <>
          <div className="my-4 flex items-center gap-3">
            <button
              disabled={viewer.page <= 1}
              onClick={() => setViewer({ docId: doc.id, page: viewer.page - 1 })}
              className="rounded-full p-1.5 hover:bg-paper disabled:opacity-30"
              aria-label="Previous page"
            >
              <ChevronLeft size={20} />
            </button>
            <span className="font-mono text-sm tracking-wider text-muted">
              PAGE {viewer.page} / {doc.page_count ?? "?"}
            </span>
            <button
              disabled={viewer.page >= (doc.page_count ?? 1)}
              onClick={() => setViewer({ docId: doc.id, page: viewer.page + 1 })}
              className="rounded-full p-1.5 hover:bg-paper disabled:opacity-30"
              aria-label="Next page"
            >
              <ChevronRight size={20} />
            </button>
          </div>
          {viewer.highlight && (
            <p className="mb-3 rounded-xl bg-yellow-50 px-3 py-2 text-sm text-yellow-900">Source text: “{viewer.highlight}”</p>
          )}
          <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-line">
            <PageImage path={`/documents/${doc.id}/pages/${viewer.page}/image`} alt={`${doc.filename} page ${viewer.page}`} />
          </div>
        </>
      )}
    </Card>
  );
}

function formatDate(e: TimelineEvent) {
  if (!e.event_date) return "—";
  if (e.date_precision === "month") return e.event_date.slice(0, 7);
  if (e.date_precision === "year") return e.event_date.slice(0, 4);
  return e.event_date + (e.date_precision === "inferred" ? " ~" : "");
}

function EventRow({ e, onSource }: { e: TimelineEvent; onSource: (s: SourceRef) => void }) {
  return (
    <li className="grid grid-cols-[110px_1fr] gap-4 py-3">
      <span className="pt-0.5 font-mono text-xs text-muted">{formatDate(e)}</span>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{e.category}</Badge>
          <span>{e.description}</span>
        </div>
        <button onClick={() => onSource(e.source)} className="mt-1 text-sm text-brand hover:underline">
          {e.source.filename} · p.{e.source.page_number}
        </button>
      </div>
    </li>
  );
}

function Block({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="border-t border-line/70 px-6 py-5 first:border-t-0">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {count !== undefined && <span className="font-semibold">{count}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function TimelineView({ t, onSource }: { t: Timeline; onSource: (s: SourceRef) => void }) {
  return (
    <Card>
      {t.flags.length > 0 && (
        <Block label="Flags" count={t.flags.length}>
          <ul className="space-y-2">
            {t.flags.map((f, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Badge tone="red">{f.rule.replaceAll("_", " ")}</Badge> {f.message}
              </li>
            ))}
          </ul>
        </Block>
      )}
      <Block label="Pending tests" count={t.pending_tests.length}>
        <ul className="space-y-2">
          {t.pending_tests.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <Badge tone="amber">pending</Badge>
              <span className="font-medium">{p.test_name.replaceAll("_", " ")}</span>
              {p.ordered_date && <span className="text-muted">ordered {p.ordered_date}</span>}
              <button onClick={() => onSource(p.source)} className="text-sm text-brand hover:underline">
                p.{p.source.page_number}
              </button>
            </li>
          ))}
          {!t.pending_tests.length && <li className="text-muted">None.</li>}
        </ul>
      </Block>
      <Block label="Discrepancies" count={t.discrepancies.length}>
        <ul className="space-y-2">
          {t.discrepancies.map((d) => (
            <li key={d.id} className="flex flex-wrap items-start gap-2">
              <Badge tone="blue">{d.field.replaceAll("_", " ")}</Badge> <span className="flex-1">{d.description}</span>
            </li>
          ))}
          {!t.discrepancies.length && <li className="text-muted">None.</li>}
        </ul>
      </Block>
      <Block label="Timeline" count={t.events.length}>
        <ul className="divide-y divide-line/60">
          {t.events.map((e) => (
            <EventRow key={e.id} e={e} onSource={onSource} />
          ))}
        </ul>
      </Block>
      {t.date_unclear.events.length > 0 && (
        <Block label={t.date_unclear.label} count={t.date_unclear.events.length}>
          <ul className="divide-y divide-line/60">
            {t.date_unclear.events.map((e) => (
              <EventRow key={e.id} e={e} onSource={onSource} />
            ))}
          </ul>
        </Block>
      )}
    </Card>
  );
}
