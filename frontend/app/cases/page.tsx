"use client";

import { ArrowRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Card, EmptyState, Label, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import type { Brief, CaseSummary } from "@/lib/types";
import { caseTitle } from "@/lib/types";

type Status = "none" | "draft" | "submitted";
const FILTERS: { key: Status | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "none", label: "Not started" },
  { key: "draft", label: "Draft" },
  { key: "submitted", label: "Submitted" },
];

export default function CasesPage() {
  const me = useMe(["resident"]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [filter, setFilter] = useState<Status | "all">("all");
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const list = await api<CaseSummary[]>("/cases");
    const entries = await Promise.all(
      list.map((c) =>
        api<Brief>(`/cases/${c.id}/brief`)
          .then((b) => [c.id, b.status === "draft" ? "draft" : "submitted"] as const)
          .catch(() => [c.id, "none"] as const), // 404: not started
      ),
    );
    setCases(list);
    setStatus(Object.fromEntries(entries));
    setUpdated(new Date());
  }, []);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const counts = useMemo(() => {
    const c = { none: 0, draft: 0, submitted: 0 };
    cases.forEach((k) => c[status[k.id] ?? "none"]++);
    return c;
  }, [cases, status]);
  const shown = cases.filter((c) => filter === "all" || (status[c.id] ?? "none") === filter);

  return (
    <Shell me={me}>
      <PageHeader
        eyebrow="Cases"
        live
        title="Your cases"
        subtitle={`${cases.length} synthetic cases${updated ? ` · updated ${updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`}
        actions={
          <button onClick={load} className="rounded-full p-2 text-muted hover:bg-white" aria-label="Refresh">
            <RefreshCw size={20} strokeWidth={1.75} />
          </button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div>
          <div className="mb-5 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </Pill>
            ))}
          </div>
          {shown.length === 0 ? (
            <EmptyState title="No cases here.">Try another filter.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {shown.map((c) => {
                const s = status[c.id] ?? "none";
                return (
                  <li key={c.id}>
                    <Link href={`/cases/${c.id}`}>
                      <Card className="group flex items-center justify-between gap-6 p-6 transition hover:border-ink/20">
                        <div className="min-w-0">
                          <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted">{c.case_code}</div>
                          <div className="mt-1 text-lg font-semibold">{caseTitle(c.title)}</div>
                          {c.summary && <div className="mt-1 text-muted">{c.summary}</div>}
                        </div>
                        <div className="flex shrink-0 items-center gap-4">
                          {s === "none" ? <Badge>not started</Badge> : s === "draft" ? <Badge tone="amber">draft</Badge> : <Badge tone="green">submitted</Badge>}
                          <ArrowRight size={18} className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
                        </div>
                      </Card>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <aside className="space-y-6">
          <Card className="p-6">
            <Label>Progress</Label>
            <dl className="mt-5 space-y-3 text-[17px]">
              {[
                ["not started", counts.none],
                ["draft", counts.draft],
                ["submitted", counts.submitted],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card className="p-6">
            <Label>How it works</Label>
            <ol className="mt-5 space-y-3 text-[15px] text-ink/80">
              <li>1. Read the source pages.</li>
              <li>2. Write your brief in five sections.</li>
              <li>3. Submit. The AI timeline then unlocks next to your brief.</li>
            </ol>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}
