"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Card, EmptyState, Label, PageHeader, Pill, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import type { BriefSummary, ResidentRow } from "@/lib/types";
import { caseTitle } from "@/lib/types";

export default function FacultyDashboard() {
  const me = useMe(["faculty", "admin"]);
  const [residents, setResidents] = useState<ResidentRow[]>([]);
  const [briefs, setBriefs] = useState<BriefSummary[]>([]);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    if (!me) return;
    api<ResidentRow[]>("/faculty/residents").then(setResidents);
    api<BriefSummary[]>("/faculty/briefs").then(setBriefs);
  }, [me]);

  const stats = useMemo(() => {
    const scored = briefs.filter((b) => b.score);
    const mean = scored.length ? scored.reduce((s, b) => s + Number(b.score!.percent), 0) / scored.length : null;
    return {
      mean,
      critical: scored.reduce((s, b) => s + b.score!.critical_missed, 0),
      withCritical: scored.filter((b) => b.score!.critical_missed > 0).length,
      pending: briefs.filter((b) => !b.score).length,
    };
  }, [briefs]);
  const shown = briefs.filter((b) => !filter || b.resident_id === filter);

  return (
    <Shell me={me}>
      <PageHeader eyebrow="Assessments" title="Assessments" subtitle="What residents caught, what they missed, and where to look first." />
      <div className="mb-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Submitted" value={briefs.length} sub={`${residents.length} resident${residents.length === 1 ? "" : "s"}`} />
        <Stat label="Mean score" value={stats.mean === null ? "—" : <>{stats.mean.toFixed(0)}<span className="text-3xl">%</span></>} tone="brand" sub="across scored briefs" />
        <Stat label="Critical missed" value={stats.critical} tone={stats.critical ? "red" : "green"} sub={`in ${stats.withCritical} brief${stats.withCritical === 1 ? "" : "s"}`} />
        <Stat label="Needs you" value={stats.pending} sub="scoring or failed" />
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-7 py-5">
          <Label>Submitted briefs</Label>
          <div className="flex flex-wrap gap-2">
            <Pill active={!filter} onClick={() => setFilter("")}>
              All
            </Pill>
            {residents.map((r) => (
              <Pill key={r.id} active={filter === r.id} onClick={() => setFilter(r.id)}>
                {r.name}
              </Pill>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No submitted briefs yet.">Briefs appear here as residents submit them.</EmptyState>
          </div>
        ) : (
          <ul>
            {shown.map((b) => (
              <li key={b.id} className="border-t border-line/60 first:border-t-0">
                <Link href={`/faculty/briefs/${b.id}`} className="group grid items-center gap-4 px-7 py-5 hover:bg-[#fbfaf7] md:grid-cols-[90px_1fr_auto_auto]">
                  <div className="text-3xl font-extrabold tracking-tight">{b.score ? `${Number(b.score.percent).toFixed(0)}` : "—"}<span className="text-base font-semibold text-muted">{b.score ? "%" : ""}</span></div>
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {b.case_code} · {caseTitle(b.case_title)}
                    </div>
                    <div className="text-muted">
                      {b.resident_name} · submitted {b.submitted_at ? new Date(b.submitted_at).toLocaleDateString() : "—"}
                    </div>
                  </div>
                  <ScoreCell b={b} showPercent={false} />
                  <ArrowRight size={18} className="hidden text-muted group-hover:text-ink md:block" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
