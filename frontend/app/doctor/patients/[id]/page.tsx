"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { DocViewer, TimelineView, type Viewer } from "@/components/CaseViews";
import { HospitalReport } from "@/components/HospitalReport";
import { RituAssistant } from "@/components/RituAssistant";
import { SessionRecording } from "@/components/SessionRecording";
import { SymptomCourse } from "@/components/SymptomCourse";
import { TranscriptView } from "@/components/IntakeSummaryView";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Card, EmptyState, Label, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import type { AssistantSource, DocumentInfo, DoctorPatientDetail, IntakeSummary, Practitioner, SourceRef } from "@/lib/types";
import { detailsLine, LANGUAGES } from "@/lib/types";

type Tab = "summary" | "check_ins" | "records";

const when = (s: IntakeSummary) =>
  s.ended_at ? new Date(s.ended_at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
const isCheckIn = (s: IntakeSummary) => s.kind === "check_in";

export default function DoctorPatientPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe(["doctor"]);
  const [p, setP] = useState<DoctorPatientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [turn, setTurn] = useState<number | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [checkInId, setCheckInId] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<Practitioner | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  useEffect(() => {
    if (!me) return;
    api<Practitioner>("/doctor/me").then(setDoctor).catch(() => {});
    api<DoctorPatientDetail>(`/doctor/patients/${id}`)
      .then((d) => {
        setP(d);
        // Open the newest pre-visit history that has something in it; an empty latest one is noted separately.
        const visits = d.sessions.filter((s) => !isCheckIn(s));
        const withFacts = visits.find((s) => s.sections.some((sec) => sec.facts.length));
        setSessionId((withFacts ?? visits[0])?.session_id ?? null);
        setCheckInId(d.sessions.find(isCheckIn)?.session_id ?? null);
        const first = d.records.find((r) => r.page_count);
        if (first) setViewer({ docId: first.id, page: 1 });
      })
      .catch((e) => setError(e.message));
  }, [me, id]);

  const docs: DocumentInfo[] = (p?.records ?? []).map((r) => ({ id: r.id, filename: r.filename, page_count: r.page_count, status: r.status }));
  const factCount = (s: IntakeSummary) => s.sections.reduce((n, sec) => n + sec.facts.length, 0);
  const visits = (p?.sessions ?? []).filter((s) => !isCheckIn(s));
  const checkIns = (p?.sessions ?? []).filter(isCheckIn);
  const selected = visits.find((s) => s.session_id === sessionId) ?? null;
  const selectedCheckIn = checkIns.find((s) => s.session_id === checkInId) ?? null;
  const latest = visits[0];
  const checkInUrgent = checkIns[0]?.sections.some((sec) => sec.facts.some((f) => f.urgent));
  const pick = (id: string) => {
    if (checkIns.some((s) => s.session_id === id)) {
      setCheckInId(id);
      setTab("check_ins");
    } else {
      setSessionId(id);
      setTab("summary");
    }
    setTurn(null);
  };
  const conversation = (s: IntakeSummary) => (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <HospitalReport summary={s} details={p!.details} patientName={p!.name} patientNumber={p!.patient_number} clinic={me?.org_name ?? "Clinic"} doctor={doctor} onTurn={showTurn} />
      <div className="space-y-6 xl:sticky xl:top-24 xl:h-fit">
        {s.has_recording && <SessionRecording key={s.session_id} caseId={p!.case_id} sessionId={s.session_id} />}
        <Card>
          <button
            onClick={() => setTranscriptOpen((o) => !o)}
            className="flex w-full items-center justify-between px-7 py-5 text-left"
            aria-expanded={transcriptOpen}
          >
            <Label>Full conversation</Label>
            <span className="text-sm font-medium text-brand">{transcriptOpen ? "Hide" : `Show · ${s.transcript.length} turns`}</span>
          </button>
          {transcriptOpen && <TranscriptView summary={s} highlight={turn} bare />}
        </Card>
      </div>
    </div>
  );
  const showTurn = (n: number) => {
    setTurn(n);
    setTranscriptOpen(true);
    setTimeout(() => document.getElementById(`turn-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };
  const openSource = (s: SourceRef) => {
    setViewer({ docId: s.document_id, page: s.page_number, highlight: s.text_span });
    setTimeout(() => document.getElementById("records-viewer")?.scrollIntoView({ behavior: "smooth" }), 50);
  };
  // A source cited by the records assistant: the page in the document viewer, or the conversation turn.
  const openAssistantSource = (s: AssistantSource) => {
    if (s.type === "document") {
      setTab("records");
      setViewer({ docId: s.document_id, page: s.page_number, highlight: s.text_span });
      setTimeout(() => document.getElementById("records-viewer")?.scrollIntoView({ behavior: "smooth" }), 80);
      return;
    }
    if (s.session_kind === "check_in") {
      setCheckInId(s.session_id);
      setTab("check_ins");
    } else {
      setSessionId(s.session_id);
      setTab("summary");
    }
    showTurn(s.turn_index);
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
          <div className="mb-5 flex flex-wrap gap-2">
            <Pill active={tab === "summary"} onClick={() => setTab("summary")}>
              Pre-visit report
            </Pill>
            <Pill active={tab === "check_ins"} onClick={() => setTab("check_ins")}>
              Check-ins
              {checkIns.length > 0 && (
                <span className={`ml-2 rounded-full px-1.5 text-xs ${checkInUrgent ? "bg-red-100 text-red-700" : "bg-line text-ink/70"}`}>{checkIns.length}</span>
              )}
            </Pill>
            <Pill active={tab === "records"} onClick={() => setTab("records")}>
              Records & timeline
              {p.timeline.flags.length + p.timeline.pending_tests.length > 0 && (
                <span className="ml-2 rounded-full bg-red-100 px-1.5 text-xs text-red-700">{p.timeline.flags.length + p.timeline.pending_tests.length}</span>
              )}
            </Pill>
          </div>

          {tab === "summary" &&
            (selected ? (
              <>
                {visits.length > 1 && (
                  <div className="mb-5 flex flex-wrap gap-2">
                    {visits.map((s, i) => (
                      <Pill key={s.session_id} active={s.session_id === sessionId} onClick={() => setSessionId(s.session_id)}>
                        {i === 0 ? "Latest · " : ""}
                        {when(s)}
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
                {conversation(selected)}
              </>
            ) : (
              <EmptyState title="No conversation with Ritu yet." />
            ))}

          {tab === "check_ins" &&
            (selectedCheckIn ? (
              <div className="space-y-6">
                <Card className="p-6 sm:p-7">
                  <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                    <Label>Symptom course</Label>
                    <span className="text-sm text-muted">Pre-visit histories and check-ins, oldest to newest. Click a date to open it.</span>
                  </div>
                  <SymptomCourse course={p.symptom_course} onSelect={pick} selected={checkInId} />
                </Card>
                {checkIns.length > 1 && (
                  <div className="flex flex-wrap gap-2">
                    {checkIns.map((s, i) => (
                      <Pill key={s.session_id} active={s.session_id === checkInId} onClick={() => setCheckInId(s.session_id)}>
                        {i === 0 ? "Latest · " : ""}
                        {when(s)}
                        {s.sections.some((sec) => sec.facts.some((f) => f.urgent)) ? " · ⚠ urgent" : ` · ${factCount(s)} noted`}
                      </Pill>
                    ))}
                  </div>
                )}
                {conversation(selectedCheckIn)}
              </div>
            ) : (
              <EmptyState title="No check-ins yet.">Between visits, the patient can do a two-minute check-in with Ritu. They appear here with a symptom course.</EmptyState>
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
      {p && <RituAssistant key={p.case_id} caseId={p.case_id} patientName={p.name} onOpenSource={openAssistantSource} />}
    </Shell>
  );
}
