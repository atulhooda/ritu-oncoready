"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { api } from "@/lib/api";
import type { BriefSummary, ResidentRow } from "@/lib/types";

export default function FacultyDashboard() {
  const me = useMe(["faculty", "admin"]);
  const [residents, setResidents] = useState<ResidentRow[]>([]);
  const [briefs, setBriefs] = useState<BriefSummary[]>([]);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    if (!me) return;
    api<ResidentRow[]>("/faculty/residents").then(setResidents);
  }, [me]);
  useEffect(() => {
    if (!me) return;
    api<BriefSummary[]>(`/faculty/briefs${filter ? `?resident_id=${filter}` : ""}`).then(setBriefs);
  }, [me, filter]);

  return (
    <Shell me={me}>
      <h1 className="mb-4 text-lg font-semibold">Faculty dashboard</h1>
      <section className="mb-8">
        <h2 className="mb-2 font-medium">Residents</h2>
        <table className="w-full rounded-lg border border-slate-200 bg-white text-sm">
          <thead className="bg-slate-100 text-left">
            <tr>
              <th className="px-3 py-2">Resident</th>
              <th className="px-3 py-2">Submitted briefs</th>
              <th className="px-3 py-2">Mean score</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {residents.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2">{r.briefs}</td>
                <td className="px-3 py-2">{r.mean_percent === null ? "—" : `${r.mean_percent}%`}</td>
                <td className="px-3 py-2 text-right">
                  <Link href={`/faculty/residents/${r.id}`} className="text-blue-700 hover:underline">
                    Trend
                  </Link>{" "}
                  ·{" "}
                  <button onClick={() => setFilter(r.id)} className="text-blue-700 hover:underline">
                    Briefs
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <div className="mb-2 flex items-center gap-3">
          <h2 className="font-medium">Submitted briefs</h2>
          {filter && (
            <button onClick={() => setFilter("")} className="text-xs text-blue-700 hover:underline">
              Show all residents
            </button>
          )}
        </div>
        <table className="w-full rounded-lg border border-slate-200 bg-white text-sm">
          <thead className="bg-slate-100 text-left">
            <tr>
              <th className="px-3 py-2">Resident</th>
              <th className="px-3 py-2">Case</th>
              <th className="px-3 py-2">Submitted</th>
              <th className="px-3 py-2">Score</th>
            </tr>
          </thead>
          <tbody>
            {briefs.map((b) => (
              <tr key={b.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{b.resident_name}</td>
                <td className="px-3 py-2">
                  <Link href={`/faculty/briefs/${b.id}`} className="text-blue-700 hover:underline">
                    {b.case_code} · {b.case_title}
                  </Link>
                </td>
                <td className="px-3 py-2">{b.submitted_at ? new Date(b.submitted_at).toLocaleDateString() : "—"}</td>
                <td className="px-3 py-2">
                  <ScoreCell b={b} />
                </td>
              </tr>
            ))}
            {briefs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-slate-500">
                  No submitted briefs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
