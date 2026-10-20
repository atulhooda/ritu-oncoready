"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import { Badge, Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
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

  return (
    <Shell me={me}>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {trend && (
        <>
          <Link href="/faculty" className="text-sm text-blue-700 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="mb-4 text-lg font-semibold">{trend.resident.name}: trend across cases</h1>
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-2 font-medium">Cases</h2>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                {trend.cases.map((b) => (
                  <li key={b.id} className="px-3 py-2 text-sm">
                    <Link href={`/faculty/briefs/${b.id}`} className="text-blue-700 hover:underline">
                      {b.case_code}
                    </Link>{" "}
                    <span className="text-slate-500">{b.submitted_at ? new Date(b.submitted_at).toLocaleDateString() : ""}</span>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-2 w-40 rounded bg-slate-100">
                        <div className="h-2 rounded bg-slate-700" style={{ width: `${b.score ? Number(b.score.percent) : 0}%` }} />
                      </div>
                      <ScoreCell b={b} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h2 className="mb-2 font-medium">Rubric categories, most missed first</h2>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                {trend.categories.map((c) => (
                  <li key={c.category} className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.category.replaceAll("_", " ")}</span>
                      {c.repeatedly_missed && <Badge tone="red">missed in {c.cases_with_miss} cases</Badge>}
                      {c.critical_missed > 0 && <Badge tone="amber">{c.critical_missed} critical</Badge>}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-2 w-40 rounded bg-slate-100">
                        <div className="h-2 rounded bg-red-500" style={{ width: `${c.miss_rate * 100}%` }} />
                      </div>
                      <span className="text-slate-600">
                        missed {c.missed}/{c.items} items across {c.cases} case(s)
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </Shell>
  );
}
