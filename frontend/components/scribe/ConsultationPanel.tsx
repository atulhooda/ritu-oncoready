"use client";

import { CheckCircle2, FileText, Loader2, Mic, Pause, Play, Plus, Printer, RotateCw, Square, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { PrescriptionView } from "@/components/scribe/PrescriptionView";
import { Badge, Button, Card, EmptyState, Label } from "@/components/ui";
import { api, API_URL, getToken } from "@/lib/api";
import type { CaseReview, Consultation, Me, Prescription, RxMedicine, RxReport, RxText } from "@/lib/types";

const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const STATUS = {
  processing: { label: "Transcribing…", tone: "blue" },
  draft: { label: "Draft: review and approve", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  failed: { label: "Failed", tone: "red" },
} as const;

function recorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m));
}

/** Records the consultation in the browser (with the patient's agreement) and uploads it. */
function Recorder({ caseId, onCreated }: { caseId: string; onCreated: (c: Consultation) => void }) {
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "recording" | "paused" | "uploading">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  async function upload(body: FormData) {
    setState("uploading");
    setError(null);
    try {
      const r = await fetch(`${API_URL}/doctor/patients/${caseId}/consultations`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` }, body });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Upload failed (${r.status})`);
      onCreated(data as Consultation);
      setTyped("");
      setTyping(false);
      setSeconds(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setState("idle");
    }
  }

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = recorderMime();
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = (r.mimeType || "audio/webm").split(";")[0];
        const body = new FormData();
        body.append("consent", "true");
        body.append("file", new Blob(chunks.current, { type }), `consultation.${type.split("/")[1]}`);
        upload(body);
      };
      r.start(5000);
      rec.current = r;
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState("recording");
    } catch {
      setError("Could not use the microphone. Allow microphone access in the browser and try again.");
    }
  }
  const pause = () => {
    rec.current?.pause();
    if (timer.current) clearInterval(timer.current);
    setState("paused");
  };
  const resume = () => {
    rec.current?.resume();
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    setState("recording");
  };
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    rec.current?.stop();
  };
  function submitTyped() {
    const body = new FormData();
    body.append("consent", String(consent));
    body.append("transcript", typed);
    upload(body);
  }

  const live = state === "recording" || state === "paused";
  return (
    <Card className="p-6 sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label>New consultation</Label>
        <span className="text-sm text-muted">Ritu scribe listens, then drafts the prescription from what you say.</span>
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-[15px]">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={live} className="mt-1 h-4 w-4 accent-[#3a4fe0]" />
        <span>The patient agrees to this consultation being recorded and transcribed.</span>
      </label>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {state === "idle" && (
          <Button onClick={start} disabled={!consent}>
            <Mic size={17} /> Start recording
          </Button>
        )}
        {live && (
          <>
            <span className="inline-flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 font-mono text-[15px] font-semibold text-red-700">
              <span className={`h-2.5 w-2.5 rounded-full bg-red-600 ${state === "recording" ? "animate-pulse" : ""}`} /> {clock(seconds)}
            </span>
            {state === "recording" ? (
              <Button variant="secondary" onClick={pause}>
                <Pause size={17} /> Pause
              </Button>
            ) : (
              <Button variant="secondary" onClick={resume}>
                <Play size={17} /> Resume
              </Button>
            )}
            <Button onClick={stop}>
              <Square size={16} /> Stop and draft prescription
            </Button>
          </>
        )}
        {state === "uploading" && (
          <span className="inline-flex items-center gap-2 text-muted">
            <Loader2 size={17} className="animate-spin" /> Uploading…
          </span>
        )}
        {state === "idle" && (
          <button onClick={() => setTyping((t) => !t)} className="text-sm font-medium text-brand hover:underline">
            {typing ? "Hide" : "Or paste a transcript"}
          </button>
        )}
      </div>
      {typing && state === "idle" && (
        <div className="mt-4">
          <textarea
            id="consultation-transcript"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            rows={7}
            placeholder={"Doctor: How is the breathlessness?\nPatient: Worse on the stairs.\nDoctor: Take furosemide 20 mg once a day for 5 days."}
            className="w-full rounded-xl border border-line bg-white px-4 py-3 font-mono text-[14px] outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
          />
          <Button className="mt-3" onClick={submitTyped} disabled={!consent || !typed.trim()}>
            <FileText size={17} /> Draft prescription from transcript
          </Button>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Card>
  );
}

const EMPTY_MED: RxMedicine = { name: "", dose: null, route: null, frequency: null, duration: null, instructions: null, evidence: null };
const TEXT_SECTIONS = [
  { key: "assessment", label: "Assessment (as you said it)", placeholder: "e.g. Fluid retention on trastuzumab" },
  { key: "tests", label: "Tests and referrals", placeholder: "e.g. Repeat echocardiogram this week" },
  { key: "advice", label: "Advice", placeholder: "e.g. Weigh daily; come back if breathless at rest" },
  { key: "follow_up", label: "Follow-up", placeholder: "e.g. After the echo report" },
] as const;

/** The doctor's edit of the extracted draft. Items found in the conversation show the words they
 *  came from; click one to see it in the transcript. */
function Editor({ c, caseId, onChange }: { c: Consultation; caseId: string; onChange: (c: Consultation) => void }) {
  const [r, setR] = useState<RxReport>(c.report!);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turn, setTurn] = useState<number | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const edit = (next: RxReport) => {
    setR(next);
    setDirty(true);
  };
  const setMed = (i: number, patch: Partial<RxMedicine>) => edit({ ...r, medicines: r.medicines.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setText = (key: (typeof TEXT_SECTIONS)[number]["key"], items: RxText[]) => edit({ ...r, [key]: items });
  const body = () => ({
    ...r,
    medicines: r.medicines.filter((m) => m.name.trim()).map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : v]))),
    ...Object.fromEntries(TEXT_SECTIONS.map(({ key }) => [key, r[key].filter((t) => t.text.trim())])),
    prescriber: undefined,
  });

  async function run(kind: "save" | "approve") {
    if (kind === "approve" && !window.confirm("Approve this prescription? It becomes read-only and the patient will see it.")) return;
    setBusy(kind);
    setError(null);
    try {
      const out = await api<Consultation>(`/doctor/patients/${caseId}/consultations/${c.id}/${kind === "save" ? "report" : "approve"}`, {
        method: kind === "save" ? "PUT" : "POST",
        body: JSON.stringify(body()),
      });
      setR(out.report!);
      setDirty(false);
      onChange(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }
  async function loadAudio() {
    const res = await fetch(`${API_URL}/doctor/patients/${caseId}/consultations/${c.id}/recording`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (res.ok) setAudio(URL.createObjectURL(await res.blob()));
  }
  const show = (n: number) => {
    setTurn(n);
    setTimeout(() => document.getElementById(`cturn-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };
  const said = (ev?: RxText["evidence"]) =>
    ev ? (
      <button onClick={() => show(ev.turn_index)} className="mt-1 block max-w-full truncate text-left text-xs italic text-muted hover:text-brand" title="Show in the transcript">
        Said: “{ev.quote}”
      </button>
    ) : null;
  const INPUT = "w-full rounded-lg border border-line bg-white px-2.5 py-2 text-[14px] outline-none focus:border-brand";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <Card className="p-6 sm:p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Label>Medicines</Label>
            <span className="text-sm text-muted">Only what was said in the consultation was drafted. Check every line.</span>
          </div>
          <div className="mt-4 space-y-3">
            {r.medicines.map((m, i) => (
              <div key={i} className="rounded-xl border border-line/80 p-3">
                <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto]">
                  <input aria-label="Medicine" placeholder="Medicine" value={m.name} onChange={(e) => setMed(i, { name: e.target.value })} className={`${INPUT} font-semibold`} />
                  <input aria-label="Dose" placeholder="Dose" value={m.dose ?? ""} onChange={(e) => setMed(i, { dose: e.target.value })} className={INPUT} />
                  <input aria-label="How often" placeholder="How often" value={m.frequency ?? ""} onChange={(e) => setMed(i, { frequency: e.target.value })} className={INPUT} />
                  <input aria-label="For how long" placeholder="For how long" value={m.duration ?? ""} onChange={(e) => setMed(i, { duration: e.target.value })} className={INPUT} />
                  <button onClick={() => edit({ ...r, medicines: r.medicines.filter((_, j) => j !== i) })} aria-label="Remove medicine" className="rounded-lg px-2 text-muted hover:bg-red-50 hover:text-red-700">
                    <X size={16} />
                  </button>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr]">
                  <input aria-label="Route" placeholder="Route (e.g. oral)" value={m.route ?? ""} onChange={(e) => setMed(i, { route: e.target.value })} className={INPUT} />
                  <input aria-label="Instructions" placeholder="Instructions (e.g. after food)" value={m.instructions ?? ""} onChange={(e) => setMed(i, { instructions: e.target.value })} className={INPUT} />
                </div>
                {said(m.evidence)}
              </div>
            ))}
            <Button variant="secondary" onClick={() => edit({ ...r, medicines: [...r.medicines, { ...EMPTY_MED }] })}>
              <Plus size={16} /> Add medicine
            </Button>
          </div>
        </Card>

        <Card className="space-y-6 p-6 sm:p-7">
          {TEXT_SECTIONS.map(({ key, label, placeholder }) => (
            <div key={key}>
              <Label>{label}</Label>
              <div className="mt-2 space-y-2">
                {r[key].map((t, i) => (
                  <div key={i}>
                    <div className="flex gap-2">
                      <input value={t.text} placeholder={placeholder} onChange={(e) => setText(key, r[key].map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className={INPUT} />
                      <button onClick={() => setText(key, r[key].filter((_, j) => j !== i))} aria-label="Remove" className="rounded-lg px-2 text-muted hover:bg-red-50 hover:text-red-700">
                        <X size={16} />
                      </button>
                    </div>
                    {said(t.evidence)}
                  </div>
                ))}
                <button onClick={() => setText(key, [...r[key], { text: "", evidence: null }])} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
          ))}
          <div>
            <Label>Notes</Label>
            <textarea value={r.notes} onChange={(e) => edit({ ...r, notes: e.target.value })} rows={3} className={`${INPUT} mt-2`} />
          </div>
        </Card>

        <Card className="flex flex-wrap items-center gap-3 p-5">
          <Button onClick={() => run("approve")} disabled={busy !== null}>
            <CheckCircle2 size={17} /> {busy === "approve" ? "Approving…" : "Approve prescription"}
          </Button>
          <Button variant="secondary" onClick={() => run("save")} disabled={busy !== null || !dirty}>
            {busy === "save" ? "Saving…" : "Save draft"}
          </Button>
          <span className="text-sm text-muted">{dirty ? "Unsaved changes" : c.updated_at ? `Saved ${when(c.updated_at)}` : "Draft from the consultation"}</span>
          {error && <p className="w-full text-sm text-red-700">{error}</p>}
        </Card>
      </div>

      <Card className="h-fit p-5 xl:sticky xl:top-24">
        <div className="flex items-center justify-between gap-2">
          <Label>Transcript</Label>
          {c.has_recording && !audio && (
            <button onClick={loadAudio} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
              <Play size={14} /> Listen
            </button>
          )}
        </div>
        {audio && <audio controls src={audio} className="mt-3 w-full" />}
        {(c.rejected ?? 0) > 0 && <p className="mt-2 text-xs text-muted">{c.rejected} suggested item(s) were dropped: their words were not in the transcript.</p>}
        <ol className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto pr-1 text-[14px]">
          {(c.transcript ?? []).map((t) => (
            <li key={t.turn_index} id={`cturn-${t.turn_index}`} className={`rounded-lg px-3 py-2 ${turn === t.turn_index ? "bg-amber-50 ring-1 ring-amber-300" : t.role === "doctor" ? "bg-brand/[0.05]" : "bg-paper"}`}>
              <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-ink/60">
                {t.role ?? (t.speaker !== null ? `Speaker ${t.speaker + 1}` : "Speaker")}
              </span>
              {t.text}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

/** Consultations and prescriptions for one patient. The senior doctor the patient was sent to
 *  records and approves; everyone who can see the patient reads the approved prescriptions. */
export function ConsultationPanel({ caseId, me, review }: { caseId: string; me: Me; review: CaseReview }) {
  const canRecord = me.role === "doctor" && review.status === "with_senior" && review.senior?.id === me.id;
  const [list, setList] = useState<Consultation[] | null>(null);
  const [open, setOpen] = useState<Consultation | null>(null);
  const [rx, setRx] = useState<Prescription | null>(null);

  const load = useCallback(() => api<Consultation[]>(`/doctor/patients/${caseId}/consultations`).then(setList).catch(() => setList([])), [caseId]);
  useEffect(() => {
    load();
  }, [load]);
  const select = useCallback(
    async (id: string) => {
      const c = await api<Consultation>(`/doctor/patients/${caseId}/consultations/${id}`);
      setOpen(c);
      setRx(c.status === "approved" ? await api<Prescription>(`/prescriptions/${id}`) : null);
    },
    [caseId],
  );
  // While one is being transcribed, check every few seconds.
  useEffect(() => {
    if (!open || open.status !== "processing") return;
    const t = setInterval(async () => {
      const c = await api<Consultation>(`/doctor/patients/${caseId}/consultations/${open.id}`);
      if (c.status !== "processing") {
        setOpen(c);
        load();
      }
    }, 4000);
    return () => clearInterval(t);
  }, [open, caseId, load]);

  async function retry(c: Consultation) {
    setOpen(await api<Consultation>(`/doctor/patients/${caseId}/consultations/${c.id}/retry`, { method: "POST" }));
    load();
  }

  return (
    <div className="space-y-6">
      {canRecord && (
        <Recorder
          caseId={caseId}
          onCreated={(c) => {
            setOpen(c);
            setRx(null);
            load();
          }}
        />
      )}

      {list && list.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => select(c.id)}
              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition ${open?.id === c.id ? "border-ink bg-ink text-white" : "border-line bg-white hover:border-ink/30"}`}
            >
              {when(c.created_at)}
              <span className={`h-2 w-2 rounded-full ${c.status === "approved" ? "bg-green-500" : c.status === "draft" ? "bg-amber-500" : c.status === "failed" ? "bg-red-500" : "bg-blue-500"}`} />
              {STATUS[c.status].label.replace(": review and approve", "")}
            </button>
          ))}
        </div>
      )}

      {open?.status === "processing" && (
        <Card className="flex items-center gap-3 p-6">
          <Loader2 className="animate-spin text-brand" />
          <div>
            <div className="font-semibold">Transcribing and drafting the prescription…</div>
            <div className="text-sm text-muted">A long consultation can take a few minutes. You can leave this page; it carries on.</div>
          </div>
        </Card>
      )}
      {open?.status === "failed" && (
        <Card className="p-6">
          <div className="font-semibold text-red-800">This consultation could not be processed.</div>
          <p className="mt-1 text-sm text-muted">{open.error}</p>
          {canRecord && (
            <Button variant="secondary" className="mt-4" onClick={() => retry(open)}>
              <RotateCw size={16} /> Try again
            </Button>
          )}
        </Card>
      )}
      {open?.status === "draft" && canRecord && open.report && (
        <Editor
          key={open.id}
          c={open}
          caseId={caseId}
          onChange={async (c) => {
            setOpen(c);
            if (c.status === "approved") setRx(await api<Prescription>(`/prescriptions/${c.id}`));
            load();
          }}
        />
      )}
      {open?.status === "approved" && rx && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="green">Approved {when(open.approved_at!)} · on the patient&apos;s record</Badge>
            <Link href={`/prescriptions/${open.id}`} target="_blank" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline">
              <Printer size={15} /> Open to print
            </Link>
          </div>
          <PrescriptionView rx={rx} />
        </div>
      )}

      {list && list.length === 0 && !canRecord && (
        <EmptyState title="No prescriptions yet.">Prescriptions appear here once the senior doctor approves one from a consultation.</EmptyState>
      )}
      {list && list.length > 0 && !open && <p className="text-muted">Choose a consultation above.</p>}
    </div>
  );
}
