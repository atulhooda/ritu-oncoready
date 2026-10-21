"use client";

import { ChevronLeft, ChevronRight, FileText } from "lucide-react";

import { PageImage } from "@/components/PageImage";
import { Badge, Card, Label, Pill } from "@/components/ui";
import type { DocumentInfo, SourceRef, Timeline, TimelineEvent } from "@/lib/types";

export type Viewer = { docId: string; page: number; highlight?: string };

export function DocViewer({
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

export function TimelineView({ t, onSource }: { t: Timeline; onSource: (s: SourceRef) => void }) {
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
