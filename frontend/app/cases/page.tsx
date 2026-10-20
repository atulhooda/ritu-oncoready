"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { api } from "@/lib/api";
import type { Brief, CaseSummary } from "@/lib/types";

export default function CasesPage() {
  const me = useMe(["resident"]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [briefs, setBriefs] = useState<Record<string, Brief["status"] | "none">>({});

  useEffect(() => {
    if (!me) return;
    api<CaseSummary[]>("/cases").then(async (list) => {
      setCases(list);
      const entries = await Promise.all(
        list.map((c) =>
          api<Brief>(`/cases/${c.id}/brief`)
            .then((b) => [c.id, b.status] as const)
            .catch(() => [c.id, "none"] as const), // 404: not started
        ),
      );
      setBriefs(Object.fromEntries(entries));
    });
  }, [me]);

  return (
    <Shell me={me}>
      <h1 className="mb-4 text-lg font-semibold">Cases</h1>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {cases.map((c) => {
          const status = briefs[c.id];
          return (
            <li key={c.id}>
              <Link href={`/cases/${c.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50">
                <div>
                  <div className="font-medium">
                    {c.case_code} · {c.title}
                  </div>
                  {c.summary && <div className="text-sm text-slate-500">{c.summary}</div>}
                </div>
                {status === "none" || status === undefined ? (
                  <Badge tone="slate">Not started</Badge>
                ) : status === "draft" ? (
                  <Badge tone="amber">Draft</Badge>
                ) : (
                  <Badge tone="green">Submitted</Badge>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}
