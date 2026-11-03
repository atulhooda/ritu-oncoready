"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Card, EmptyState, Label, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import type { CaseReview, DoctorPatientRow, HospitalDoctor, ReviewStatus } from "@/lib/types";
import { detailsLine } from "@/lib/types";

type Filter = "all" | ReviewStatus;

const STATUS: Record<ReviewStatus, { label: string; tone: "amber" | "blue" | "green" }> = {
  unassigned: { label: "Needs a junior doctor", tone: "amber" },
  with_junior: { label: "With junior doctor", tone: "blue" },
  with_senior: { label: "Sent to senior", tone: "green" },
};

export default function HospitalPatients() {
  const me = useMe(["hospital"]);
  const [rows, setRows] = useState<DoctorPatientRow[]>([]);
  const [doctors, setDoctors] = useState<HospitalDoctor[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<DoctorPatientRow[]>("/hospital/patients").then(setRows).catch((e) => setError(e.message));
    api<HospitalDoctor[]>("/hospital/doctors").then(setDoctors).catch(() => {});
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const juniors = doctors.filter((d) => d.seniority === "junior" && d.active);

  async function assign(caseId: string, juniorId: string) {
    setError(null);
    try {
      const review = await api<CaseReview>(`/hospital/patients/${caseId}/assign`, { method: "POST", body: JSON.stringify({ junior_user_id: juniorId }) });
      setRows((rs) => rs.map((r) => (r.case_id === caseId ? { ...r, review: { ...r.review, status: review.status, junior: review.junior } } : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not assign");
    }
  }

  const shown = rows.filter((r) => filter === "all" || r.review.status === filter);
  const count = (s: ReviewStatus) => rows.filter((r) => r.review.status === s).length;

  return (
    <Shell me={me}>
      <PageHeader
        eyebrow="Hospital"
        live
        title="Patients"
        subtitle="Everyone who sent their check-in. Assign each one to a junior doctor."
        actions={
          <button onClick={load} className="rounded-full p-2 text-muted hover:bg-white" aria-label="Refresh">
            <RefreshCw size={20} strokeWidth={1.75} />
          </button>
        }
      />
      {doctors.length > 0 && juniors.length === 0 && (
        <p className="mb-6 rounded-xl border border-line bg-white px-5 py-3.5 text-[15px]">
          Add a junior doctor before assigning patients.{" "}
          <Link href="/hospital/doctors" className="font-medium text-brand hover:underline">Add doctors →</Link>
        </p>
      )}
      {doctors.length === 0 && (
        <p className="mb-6 rounded-xl border border-line bg-white px-5 py-3.5 text-[15px]">
          Start by adding your junior and senior doctors.{" "}
          <Link href="/hospital/doctors" className="font-medium text-brand hover:underline">Add doctors →</Link>
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div>
          <div className="mb-5 flex flex-wrap gap-2">
            {([["all", "All"], ["unassigned", "Needs a junior"], ["with_junior", "With junior"], ["with_senior", "Sent to senior"]] as const).map(([k, label]) => (
              <Pill key={k} active={filter === k} onClick={() => setFilter(k)}>
                {label}
              </Pill>
            ))}
          </div>
          {error && <p className="mb-4 text-sm text-red-700">{error}</p>}
          {shown.length === 0 ? (
            <EmptyState title="No patients here.">Patients appear when they send their check-in with Ritu.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {shown.map((r) => (
                <li key={r.case_id}>
                  <Card className="p-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
                          sent {new Date(r.published_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                        </div>
                        <Link href={`/doctor/patients/${r.case_id}`} className="mt-1 flex flex-wrap items-center gap-2 hover:text-brand">
                          <span className="text-xl font-semibold">{r.name}</span>
                          {r.patient_number && <span className="font-mono text-sm text-muted">{r.patient_number}</span>}
                        </Link>
                        {detailsLine(r) && <div className="text-muted">{detailsLine(r)}</div>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {r.symptoms.slice(0, 5).map((s) => <Badge key={s}>{s}</Badge>)}
                        </div>
                      </div>
                      <Badge tone={STATUS[r.review.status].tone}>{STATUS[r.review.status].label}</Badge>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line/70 pt-4 text-[15px]">
                      {r.review.status === "with_senior" ? (
                        <span className="text-muted">
                          {r.review.junior?.name} → <span className="text-ink">{r.review.senior?.name}</span>
                        </span>
                      ) : (
                        <>
                          <label htmlFor={`assign-${r.case_id}`} className="text-muted">Junior doctor</label>
                          <select
                            id={`assign-${r.case_id}`}
                            value={r.review.junior?.id ?? ""}
                            onChange={(e) => e.target.value && assign(r.case_id, e.target.value)}
                            className="rounded-xl border border-line bg-white px-3 py-2 outline-none focus:border-brand"
                          >
                            <option value="">Choose…</option>
                            {r.review.junior && !juniors.some((j) => j.id === r.review.junior!.id) && (
                              <option value={r.review.junior.id}>{r.review.junior.name}</option>
                            )}
                            {juniors.map((j) => (
                              <option key={j.id} value={j.id}>{j.name}</option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside>
          <Card className="p-6">
            <Label>Overview</Label>
            <dl className="mt-5 space-y-3 text-[17px]">
              {([["needs a junior", count("unassigned")], ["with junior doctors", count("with_junior")], ["sent to seniors", count("with_senior")],
                ["junior doctors", juniors.length], ["senior doctors", doctors.filter((d) => d.seniority === "senior" && d.active).length]] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}
