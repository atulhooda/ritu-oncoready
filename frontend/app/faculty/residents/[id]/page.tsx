"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Card, Label, PageHeader, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import type { Trend } from "@/lib/types";

export default function ResidentTrendPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe(["faculty", "admin"]);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me) api<Trend>(`/faculty/residents/${id}/trend`).then(setTrend).catch((e) => setError(e.message));
  }, [me, id]);

  const scored = trend?.cases.filter((c) => c.score) ?? [];
  const mean = scored.length ? scored.reduce((s, c) => s + Number(c.score!.percent), 0) / scored.length : null;
  const repeated = trend?.categories.filter((c) => c.repeatedly_missed) ?? [];

  return (
    <Shell me={me}>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {trend && (
        <>
          <Link href="/faculty/residents" className="text-sm font-medium text-brand hover:underline">
            ← Residents
          </Link>
          <div className="mt-4">
            <PageHeader eyebrow="Resident trend" title={trend.resident.name} subtitle="Scores across cases, and the rubric categories that keep getting missed." />
          </div>
          <div className="mb-8 grid gap-5 sm:grid-cols-3">
            <Stat label="Cases" value={trend.cases.length} sub={`${scored.length} scored`} />
            <Stat label="Mean score" tone="brand" value={mean === null ? "—" : <>{mean.toFixed(0)}<span className="text-3xl">%</span></>} sub="across scored cases" />
            <Stat label="Repeat misses" tone={repeated.length ? "red" : "green"} value={repeated.length} sub={repeated.length ? repeated.map((c) => c.category.replaceAll("_", " ")).join(", ") : "none so far"} />
          </div>
          <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
            <Card>
              <div className="flex items-center justify-between border-b border-line/70 px-7 py-5">
                <Label>Missed most often</Label>
                <span className="text-sm text-muted">by miss rate</span>
              </div>
              <ul>
                {trend.categories.map((c) => (
                  <li key={c.category} className="grid grid-cols-[64px_1fr] gap-4 border-t border-line/60 px-7 py-5 first:border-t-0">
                    <div className="text-right">
                      <div className="text-2xl font-extrabold">{c.missed}</div>
                      <div className="font-mono text-xs text-muted">{Math.round(c.miss_rate * 100)}%</div>
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`text-[17px] font-semibold ${c.missed ? "text-amber-800" : "text-green-800"}`}>{c.category.replaceAll("_", " ")}</span>
                        {c.repeatedly_missed && <Badge tone="red">missed in {c.cases_with_miss} cases</Badge>}
                        {c.critical_missed > 0 && <Badge tone="red">{c.critical_missed} critical</Badge>}
                        {c.missed === 0 && <Badge tone="green">all caught</Badge>}
                      </div>
                      <p className="mt-1 text-muted">
                        Missed {c.missed} of {c.items} item{c.items === 1 ? "" : "s"} across {c.cases} case{c.cases === 1 ? "" : "s"}.
                      </p>
                      <div className="mt-2 h-1.5 w-full max-w-sm rounded-full bg-paper">
                        <div className="h-1.5 rounded-full bg-amber-500" style={{ width: `${c.miss_rate * 100}%` }} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="h-fit">
              <div className="border-b border-line/70 px-7 py-5">
                <Label>Cases</Label>
              </div>
              <ul>
                {trend.cases.map((b) => (
                  <li key={b.id} className="border-t border-line/60 px-7 py-5 first:border-t-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <Link href={`/faculty/briefs/${b.id}`} className="font-semibold hover:text-brand">
                        {b.case_code}
                      </Link>
                      <span className="font-mono text-xs text-muted">{b.submitted_at ? new Date(b.submitted_at).toLocaleDateString() : ""}</span>
                    </div>
                    <div className="mt-2 h-2 w-full rounded-full bg-paper">
                      <div className="h-2 rounded-full bg-brand" style={{ width: `${b.score ? Number(b.score.percent) : 0}%` }} />
                    </div>
                    <div className="mt-2 text-sm">
                      <ScoreCell b={b} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}
