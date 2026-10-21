"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Card, EmptyState, Label, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { ResidentRow } from "@/lib/types";

export default function ResidentsPage() {
  const me = useMe(["faculty", "admin"]);
  const [residents, setResidents] = useState<ResidentRow[] | null>(null);

  useEffect(() => {
    if (me) api<ResidentRow[]>("/faculty/residents").then(setResidents);
  }, [me]);

  return (
    <Shell me={me}>
      <PageHeader eyebrow="Residents" title="Find a" accent="resident." subtitle="Open a resident to see their scores across cases and the categories they keep missing." />
      {residents && residents.length === 0 && <EmptyState title="No residents yet." />}
      {residents && residents.length > 0 && (
        <Card>
          <div className="grid grid-cols-[1fr_120px_120px_24px] gap-4 border-b border-line/70 px-7 py-4">
            <Label>Resident</Label>
            <Label>Briefs</Label>
            <Label>Mean</Label>
            <span />
          </div>
          <ul>
            {residents.map((r) => (
              <li key={r.id} className="border-t border-line/60 first:border-t-0">
                <Link href={`/faculty/residents/${r.id}`} className="group grid grid-cols-[1fr_120px_120px_24px] items-center gap-4 px-7 py-5 hover:bg-[#fbfaf7]">
                  <div>
                    <div className="font-semibold">{r.name}</div>
                    <div className="text-sm text-muted">{r.email}</div>
                  </div>
                  <div className="text-lg font-semibold">{r.briefs}</div>
                  <div className="text-lg font-semibold">{r.mean_percent === null ? "—" : `${r.mean_percent.toFixed(0)}%`}</div>
                  <ArrowRight size={18} className="text-muted group-hover:text-ink" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Shell>
  );
}
