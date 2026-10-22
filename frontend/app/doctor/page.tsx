"use client";

import { ArrowRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Card, EmptyState, Label, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import type { DoctorPatientRow } from "@/lib/types";
import { detailsLine } from "@/lib/types";

type Filter = "all" | "urgent" | "flags" | "pending" | "today";

const urgentCheckIn = (r: DoctorPatientRow) => (r.last_check_in?.urgent.length ?? 0) > 0;

export default function DoctorInbox() {
  const me = useMe(["doctor"]);
  const [rows, setRows] = useState<DoctorPatientRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(() => api<DoctorPatientRow[]>("/doctor/patients").then((r) => {
    setRows(r);
    setUpdated(new Date());
  }), []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const today = new Date().toDateString();
  const isToday = (r: DoctorPatientRow) => new Date(r.published_at).toDateString() === today;
  const shown = rows.filter((r) =>
    filter === "urgent" ? urgentCheckIn(r) : filter === "flags" ? r.flags + r.discrepancies > 0 : filter === "pending" ? r.pending_tests > 0 : filter === "today" ? isToday(r) : true,
  ).sort((a, b) => Number(urgentCheckIn(b)) - Number(urgentCheckIn(a)));

  return (
    <Shell me={me}>
      <PageHeader
        eyebrow="Patients"
        live
        title="Patients"
        subtitle={`Pre-visit summaries sent to you${updated ? ` · updated ${updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`}
        actions={
          <button onClick={load} className="rounded-full p-2 text-muted hover:bg-white" aria-label="Refresh">
            <RefreshCw size={20} strokeWidth={1.75} />
          </button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div>
          <div className="mb-5 flex flex-wrap gap-2">
            {([["all", "All"], ["urgent", "Urgent in check-in"], ["today", "Sent today"], ["flags", "Flags or discrepancies"], ["pending", "Pending tests"]] as const).map(([k, label]) => (
              <Pill key={k} active={filter === k} onClick={() => setFilter(k)}>
                {label}
              </Pill>
            ))}
          </div>
          {shown.length === 0 ? (
            <EmptyState title="No patients here yet.">Patients appear when they send you their session with Ritu.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {shown.map((r) => (
                <li key={r.case_id}>
                  <Link href={`/doctor/patients/${r.case_id}`}>
                    <Card className="group p-6 transition hover:border-ink/20">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
                            sent {new Date(r.published_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="text-xl font-semibold">{r.name}</span>
                            {r.abha_verified_via === "abdm_sandbox" && <Badge tone="green">ABHA verified</Badge>}
                            {r.abha_verified_via === "demo" && <Badge>ABHA (demo)</Badge>}
                          </div>
                          {urgentCheckIn(r) && (
                            <div className="mt-2 rounded-lg border border-red-600/70 px-3 py-1.5 text-sm text-red-800">
                              Check-in {r.last_check_in!.ended_at ? new Date(r.last_check_in!.ended_at).toLocaleDateString([], { day: "numeric", month: "short" }) : ""}: reported{" "}
                              {r.last_check_in!.urgent.map((u) => u.toLowerCase()).join(", ")}
                            </div>
                          )}
                          {detailsLine(r) && <div className="text-muted">{detailsLine(r)}</div>}
                          <div className="mt-2 flex flex-wrap gap-2">
                            {r.symptoms.length ? r.symptoms.map((s) => <Badge key={s}>{s}</Badge>) : <span className="text-muted">No symptoms noted</span>}
                          </div>
                        </div>
                        <ArrowRight size={18} className="mt-1 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" />
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2 text-sm">
                        {r.last_check_in ? (
                          <Badge>
                            {r.check_ins} check-in{r.check_ins === 1 ? "" : "s"} · last {r.last_check_in.ended_at ? new Date(r.last_check_in.ended_at).toLocaleDateString([], { day: "numeric", month: "short" }) : "—"}
                          </Badge>
                        ) : (
                          <Badge>No check-ins yet</Badge>
                        )}
                        <Badge>{r.records} record{r.records === 1 ? "" : "s"}</Badge>
                        {r.flags > 0 && <Badge tone="red">{r.flags} flag{r.flags === 1 ? "" : "s"}</Badge>}
                        {r.discrepancies > 0 && <Badge tone="blue">{r.discrepancies} discrepanc{r.discrepancies === 1 ? "y" : "ies"}</Badge>}
                        {r.pending_tests > 0 && <Badge tone="amber">{r.pending_tests} pending test{r.pending_tests === 1 ? "" : "s"}</Badge>}
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside className="space-y-6">
          <Card className="p-6">
            <Label>Inbox</Label>
            <dl className="mt-5 space-y-3 text-[17px]">
              {[
                ["urgent in check-in", rows.filter(urgentCheckIn).length],
                ["sent today", rows.filter(isToday).length],
                ["with flags", rows.filter((r) => r.flags > 0).length],
                ["with discrepancies", rows.filter((r) => r.discrepancies > 0).length],
                ["pending tests", rows.filter((r) => r.pending_tests > 0).length],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card className="p-6">
            <Label>About these summaries</Label>
            <p className="mt-4 text-[15px] text-ink/80">
              Ritu collects symptoms and record details in the patient&apos;s own words, before the visit and in short check-ins between visits. Every line links to what they said, and every record fact to its page. Nothing is diagnosed.
            </p>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}
