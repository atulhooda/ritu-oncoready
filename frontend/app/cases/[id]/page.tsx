"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PageImage } from "@/components/PageImage";
import { Badge, Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { api, ApiError } from "@/lib/api";
import type { Brief, CaseSummary, DocumentInfo, Sections, SourceRef, Timeline, TimelineEvent } from "@/lib/types";
import { SECTION_KEYS } from "@/lib/types";

const EMPTY: Sections = {
  key_changes: "",
  pending_investigations: "",
  discrepancies_noticed: "",
  treatment_history: "",
  red_flags: "",
};
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
  const [viewer, setViewer] = useState<{ docId: string; page: number; highlight?: string } | null>(null);
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
    if (!confirm("Submit your brief? It cannot be edited afterwards, and the AI timeline will be unlocked.")) return;
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
    <Shell me={me}>
      {kase && (
        <div className="mb-4">
          <h1 className="text-lg font-semibold">
            {kase.case_code} · {kase.title}
          </h1>
          {kase.summary && <p className="text-sm text-slate-600">{kase.summary}</p>}
        </div>
      )}
      {message && <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>}

      {!submitted ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="mb-2 font-medium">Source documents</h2>
            <DocViewer docs={docs} viewer={viewer} setViewer={setViewer} />
          </section>
          <section>
            <h2 className="mb-2 font-medium">Readiness brief</h2>
            <div className="space-y-3">
              {SECTION_KEYS.map((k) => (
                <label key={k} className="block text-sm">
                  <span className="font-medium text-slate-700">{LABELS[k]}</span>
                  <textarea
                    value={draft[k]}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                    rows={4}
                    maxLength={5000}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2"
                  />
                </label>
              ))}
              <div className="flex gap-2">
                <button onClick={() => save().catch((e) => setMessage(e.message))} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm">
                  Save draft
                </button>
                <button onClick={submit} className="rounded bg-slate-900 px-3 py-2 text-sm text-white">
                  Submit brief
                </button>
              </div>
            </div>
            <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
              🔒 The AI timeline is locked until you submit your brief.
            </div>
          </section>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm text-slate-600">
            <Badge tone="green">Submitted</Badge>
            {brief?.submitted_at && <span>{new Date(brief.submitted_at).toLocaleString()}</span>}
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 font-medium">Your brief</h2>
              <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
                {SECTION_KEYS.map((k) => (
                  <div key={k}>
                    <h3 className="text-sm font-medium text-slate-700">{LABELS[k]}</h3>
                    <p className="whitespace-pre-wrap text-sm">{brief?.sections[k] || <span className="text-slate-400">(empty)</span>}</p>
                  </div>
                ))}
              </div>
            </section>
            <section>
              <h2 className="mb-2 font-medium">AI timeline</h2>
              {timeline ? <TimelineView t={timeline} onSource={openSource} /> : <p className="text-sm text-slate-500">Loading…</p>}
            </section>
          </div>
          <section className="mt-6">
            <h2 className="mb-2 font-medium">Source documents</h2>
            <DocViewer docs={docs} viewer={viewer} setViewer={setViewer} />
          </section>
        </>
      )}
    </Shell>
  );
}

function DocViewer({
  docs,
  viewer,
  setViewer,
}: {
  docs: DocumentInfo[];
  viewer: { docId: string; page: number; highlight?: string } | null;
  setViewer: (v: { docId: string; page: number; highlight?: string }) => void;
}) {
  const doc = docs.find((d) => d.id === viewer?.docId);
  if (!docs.length) return <p className="text-sm text-slate-500">No documents.</p>;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap gap-1">
        {docs.map((d) => (
          <button
            key={d.id}
            onClick={() => setViewer({ docId: d.id, page: 1 })}
            className={`rounded px-2 py-1 text-xs ${d.id === viewer?.docId ? "bg-slate-900 text-white" : "bg-slate-100"}`}
          >
            {d.filename}
          </button>
        ))}
      </div>
      {doc && viewer && (
        <>
          <div className="mb-2 flex items-center gap-2 text-sm">
            <button disabled={viewer.page <= 1} onClick={() => setViewer({ docId: doc.id, page: viewer.page - 1 })} className="rounded border px-2 disabled:opacity-40">
              ‹
            </button>
            <span>
              Page {viewer.page} of {doc.page_count ?? "?"}
            </span>
            <button
              disabled={viewer.page >= (doc.page_count ?? 1)}
              onClick={() => setViewer({ docId: doc.id, page: viewer.page + 1 })}
              className="rounded border px-2 disabled:opacity-40"
            >
              ›
            </button>
          </div>
          {viewer.highlight && (
            <p className="mb-2 rounded bg-yellow-50 px-2 py-1 text-xs text-yellow-900">Source text: “{viewer.highlight}”</p>
          )}
          <PageImage path={`/documents/${doc.id}/pages/${viewer.page}/image`} alt={`${doc.filename} page ${viewer.page}`} />
        </>
      )}
    </div>
  );
}

function EventRow({ e, onSource }: { e: TimelineEvent; onSource: (s: SourceRef) => void }) {
  const date =
    e.event_date === null
      ? "—"
      : e.date_precision === "month"
        ? e.event_date.slice(0, 7)
        : e.date_precision === "year"
          ? e.event_date.slice(0, 4)
          : e.event_date;
  return (
    <li className="flex gap-3 py-2 text-sm">
      <span className="w-24 shrink-0 font-mono text-xs text-slate-500">
        {date}
        {e.date_precision === "inferred" && " ~"}
      </span>
      <div>
        <Badge tone="slate">{e.category}</Badge> {e.description}
        <button onClick={() => onSource(e.source)} className="block text-xs text-blue-700 hover:underline">
          {e.source.filename} p.{e.source.page_number}
        </button>
      </div>
    </li>
  );
}

function TimelineView({ t, onSource }: { t: Timeline; onSource: (s: SourceRef) => void }) {
  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      {t.flags.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Flags</h3>
          <ul className="mt-1 space-y-1">
            {t.flags.map((f, i) => (
              <li key={i} className="text-sm">
                <Badge tone="red">{f.rule}</Badge> {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {t.pending_tests.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Pending tests</h3>
          <ul className="mt-1 space-y-1">
            {t.pending_tests.map((p) => (
              <li key={p.id} className="text-sm">
                <Badge tone="amber">pending</Badge> {p.test_name.replaceAll("_", " ")}
                {p.ordered_date && <span className="text-slate-500"> (ordered {p.ordered_date})</span>}{" "}
                <button onClick={() => onSource(p.source)} className="text-xs text-blue-700 hover:underline">
                  {p.source.filename} p.{p.source.page_number}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {t.discrepancies.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Discrepancies</h3>
          <ul className="mt-1 space-y-1">
            {t.discrepancies.map((d) => (
              <li key={d.id} className="text-sm">
                <Badge tone="blue">{d.field}</Badge> {d.description}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="text-sm font-medium">Timeline</h3>
        <ul className="divide-y divide-slate-100">
          {t.events.map((e) => (
            <EventRow key={e.id} e={e} onSource={onSource} />
          ))}
        </ul>
      </div>
      {t.date_unclear.events.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">{t.date_unclear.label}</h3>
          <ul className="divide-y divide-slate-100">
            {t.date_unclear.events.map((e) => (
              <EventRow key={e.id} e={e} onSource={onSource} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
