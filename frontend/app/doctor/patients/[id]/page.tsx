"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { DocViewer, TimelineView, type Viewer } from "@/components/CaseViews";
import { DoctorSummary } from "@/components/DoctorSummary";
import { SessionRecording } from "@/components/SessionRecording";
import { TranscriptView } from "@/components/IntakeSummaryView";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Card, EmptyState, Label, PageHeader, Pill, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import type { DocumentInfo, DoctorPatientDetail, IntakeSummary, PatientDetails, SourceRef } from "@/lib/types";
import { detailsLine, LANGUAGES, SEX_LABELS, TREATMENT_LABELS } from "@/lib/types";

type Tab = "summary" | "records";

export default function DoctorPatientPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe(["doctor"]);
  const [p, setP] = useState<DoctorPatientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [turn, setTurn] = useState<number | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  useEffect(() => {
    if (!me) return;
    api<DoctorPatientDetail>(`/doctor/patients/${id}`)
      .then((d) => {
        setP(d);
        // Open the newest conversation that has something in it; an empty latest one is noted separately.
        const withFacts = d.sessions.find((s) => s.sections.some((sec) => sec.facts.length));
        setSessionId((withFacts ?? d.sessions[0])?.session_id ?? null);
        const first = d.records.find((r) => r.page_count);
        if (first) setViewer({ docId: first.id, page: 1 });
      })
      .catch((e) => setError(e.message));
  }, [me, id]);

  const docs: DocumentInfo[] = (p?.records ?? []).map((r) => ({ id: r.id, filename: r.filename, page_count: r.page_count, status: r.status }));
  const factCount = (s: IntakeSummary) => s.sections.reduce((n, sec) => n + sec.facts.length, 0);
  const symptoms = new Set(
    (p?.sessions ?? []).flatMap((s) => s.sections.find((sec) => sec.section === "current_symptom")?.facts.map((f) => f.label.toLowerCase()) ?? []),
  ).size;
  const selected = p?.sessions.find((s) => s.session_id === sessionId) ?? null;
  const latest = p?.sessions[0];
  const showTurn = (n: number) => {
    setTurn(n);
    setTranscriptOpen(true);
    setTimeout(() => document.getElementById(`turn-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };
  const openSource = (s: SourceRef) => {
    setViewer({ docId: s.document_id, page: s.page_number, highlight: s.text_span });
    setTimeout(() => document.getElementById("records-viewer")?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  return (
    <Shell me={me}>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {p && (
        <>
          <Link href="/doctor" className="text-sm font-medium text-brand hover:underline">
            ← Patients
          </Link>
          <div className="mt-4">
            <PageHeader
              eyebrow={`Pre-visit · sent ${new Date(p.published_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}
              title={p.name}
              subtitle={[detailsLine(p.details), "Demo persona · synthetic data"].filter(Boolean).join("  ·  ")}
            />
          </div>
          <div className="mb-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Symptoms" value={symptoms} sub={`across ${p.sessions.length} conversation${p.sessions.length === 1 ? "" : "s"}`} />
            <Stat label="Records" value={p.records.length} sub={`${p.records.filter((r) => r.status === "extracted").length} read`} />
            <Stat label="Flags" tone={p.timeline.flags.length ? "red" : undefined} value={p.timeline.flags.length} sub={p.timeline.flags[0]?.message ?? "none from records"} />
            <Stat
              label="Pending tests"
              tone={p.timeline.pending_tests.length ? "brand" : undefined}
              value={p.timeline.pending_tests.length}
              sub={p.timeline.pending_tests.map((t) => t.test_name.replaceAll("_", " ")).join(", ") || "none"}
            />
          </div>
          <div className="mb-5 flex gap-2">
            <Pill active={tab === "summary"} onClick={() => setTab("summary")}>
              Ritu session
            </Pill>
            <Pill active={tab === "records"} onClick={() => setTab("records")}>
              Records & timeline
            </Pill>
          </div>

          {tab === "summary" &&
            (selected ? (
              <>
                {p.sessions.length > 1 && (
                  <div className="mb-5 flex flex-wrap gap-2">
                    {p.sessions.map((s, i) => (
                      <Pill key={s.session_id} active={s.session_id === sessionId} onClick={() => setSessionId(s.session_id)}>
                        {i === 0 ? "Latest · " : ""}
                        {s.ended_at ? new Date(s.ended_at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—"}
                        {s.language ? ` · ${(LANGUAGES[s.language] ?? s.language).split(" · ").pop()}` : ""}
                        {` · ${factCount(s)} noted`}
                      </Pill>
                    ))}
                  </div>
                )}
                {latest && latest.session_id !== sessionId && factCount(latest) === 0 && (
                  <p className="mb-5 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink/80">
                    Latest conversation ({latest.ended_at ? new Date(latest.ended_at).toLocaleDateString([], { day: "numeric", month: "short" }) : "—"}): the patient reported nothing new.
                    Showing the most recent conversation with details.
                  </p>
                )}
                <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
                  <DoctorSummary summary={selected} onTurn={showTurn} />
                  <div className="space-y-6 xl:sticky xl:top-24 xl:h-fit">
                    {selected.has_recording && <SessionRecording caseId={p.case_id} sessionId={selected.session_id} />}
                    <DetailsCard d={p.details} />
                    <Card>
                      <button
                        onClick={() => setTranscriptOpen((o) => !o)}
                        className="flex w-full items-center justify-between px-7 py-5 text-left"
                        aria-expanded={transcriptOpen}
                      >
                        <Label>Full conversation</Label>
                        <span className="text-sm font-medium text-brand">{transcriptOpen ? "Hide" : `Show · ${selected.transcript.length} turns`}</span>
                      </button>
                      {transcriptOpen && <TranscriptView summary={selected} highlight={turn} bare />}
                    </Card>
                  </div>
                </div>
              </>
            ) : (
              <EmptyState title="No conversation with Ritu yet." />
            ))}

          {tab === "records" &&
            (p.records.length === 0 ? (
              <EmptyState title="No records uploaded.">The patient has not added earlier records yet.</EmptyState>
            ) : (
              <div className="grid gap-6 xl:grid-cols-2">
                <TimelineView t={p.timeline} onSource={openSource} />
                <div id="records-viewer">
                  {docs.length ? <DocViewer docs={docs} viewer={viewer} setViewer={setViewer} sticky /> : <Card className="p-6"><Label>Records</Label></Card>}
                </div>
              </div>
            ))}
        </>
      )}
    </Shell>
  );
}

function DetailsCard({ d }: { d: PatientDetails }) {
  const rows: [string, string | null][] = [
    ["Age", d.age !== null ? `${d.age} (born ${d.date_of_birth})` : null],
    ["Sex", d.sex ? SEX_LABELS[d.sex] : null],
    ["Cancer type", d.cancer_type],
    ["Found", d.diagnosed_on ? new Date(d.diagnosed_on).toLocaleDateString([], { month: "long", year: "numeric" }) : null],
    ["Stage (as told to patient)", d.stage_reported],
    ["Treatment status", d.treatment_status ? TREATMENT_LABELS[d.treatment_status] : null],
    ["Current treatment", d.current_treatment],
    ["Treating hospital", d.treating_hospital],
    ["Treating doctor", d.treating_doctor],
    ["Other conditions", d.other_conditions],
    ["Language", LANGUAGES[d.preferred_language] ?? d.preferred_language],
    ["Phone", d.phone],
  ];
  return (
    <Card>
      <div className="border-b border-line/70 px-7 py-5">
        <Label>Patient details · self-reported</Label>
      </div>
      <dl className="divide-y divide-line/60 px-7 py-2 text-[15px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-6 py-2.5">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right font-medium">{v || <span className="font-normal text-muted">—</span>}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
