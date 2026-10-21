"use client";

import { CheckCircle2, FileUp, Mic, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { IntakeSummaryView } from "@/components/IntakeSummaryView";
import { SessionPanel } from "@/components/SessionPanel";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Button, Card, Label, PageHeader } from "@/components/ui";
import { api, API_URL, getToken } from "@/lib/api";
import type { IntakeSession, PatientProfile, RecordInfo } from "@/lib/types";

const RECORD_STATUS: Record<string, { tone: "green" | "amber" | "red" | "slate"; text: string }> = {
  uploaded: { tone: "amber", text: "reading…" },
  ocr_done: { tone: "amber", text: "reading…" },
  extracted: { tone: "green", text: "ready" },
  failed: { tone: "red", text: "could not read" },
};

export default function PatientPage() {
  const me = useMe(["patient"]);
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [live, setLive] = useState<IntakeSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<PatientProfile>("/me/profile").then(setProfile), []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const latest = profile?.sessions[profile.sessions.length - 1];
  const working = latest && ["completed"].includes(latest.status);
  const readingRecords = profile?.records.some((r) => r.status === "uploaded" || r.status === "ocr_done");
  useEffect(() => {
    if (!working && !readingRecords) return;
    const t = setInterval(load, 3000); // summary or records are being processed
    return () => clearInterval(t);
  }, [working, readingRecords, load]);

  async function start() {
    setMessage(null);
    try {
      setLive(await api<IntakeSession>("/me/sessions", { method: "POST" }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not start a session");
    }
  }

  const finished = useCallback(() => {
    setLive(null);
    load();
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setMessage(null);
    try {
      for (const f of Array.from(files)) {
        const body = new FormData();
        body.append("file", f);
        const res = await fetch(`${API_URL}/me/records`, { method: "POST", body, headers: { Authorization: `Bearer ${getToken()}` } });
        if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      }
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function sendToDoctor() {
    try {
      await api("/me/publish", { method: "POST" });
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not send");
    }
  }

  const first = profile?.name.split(" ")[0];
  const summarized = !!profile?.summary;
  return (
    <Shell me={me}>
      {profile && (
        <>
          <PageHeader
            eyebrow="My profile"
            live
            title="Hello,"
            accent={`${first}.`}
            subtitle={profile.published_at ? `Sent to your doctor ${new Date(profile.published_at).toLocaleString()}` : "Talk to Ritu, add your old records, then send everything to your doctor."}
          />
          {message && <p className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{message}</p>}
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="space-y-6">
              {live ? (
                <SessionPanel session={live} onFinished={finished} />
              ) : (
                <Card className="p-7">
                  <Label>Step 1 · Talk to Ritu</Label>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-5">
                    <div className="max-w-xl">
                      <p className="text-lg font-semibold">
                        {working ? "Ritu is writing up your session…" : summarized ? "Session done." : "Tell Ritu how you are feeling."}
                      </p>
                      <p className="mt-1 text-muted">
                        Ritu asks about your symptoms right now, then about earlier reports, scans or prescriptions. It takes a few minutes.
                      </p>
                      {latest?.status === "failed" && <p className="mt-2 text-sm text-red-700">Last session did not finish: {latest.error}</p>}
                    </div>
                    <Button onClick={start} disabled={!!working}>
                      <Mic size={18} /> {summarized ? "Start a new session" : "Start session"}
                    </Button>
                  </div>
                </Card>
              )}

              {profile.summary && !live && <IntakeSummaryView summary={profile.summary} audience="patient" />}

              <Card className="p-7">
                <Label>Step 2 · Previous records</Label>
                <div className="mt-4 rounded-2xl border border-dashed border-[#d8d5cc] bg-[#faf9f6] px-6 py-8 text-center">
                  <FileUp size={26} className="mx-auto text-muted" strokeWidth={1.5} />
                  <p className="mt-2 font-medium">Upload reports, scans, prescriptions or discharge summaries</p>
                  <p className="text-sm text-muted">PDF or photos (PNG, JPEG), up to 20 MB each</p>
                  <input ref={fileInput} type="file" multiple accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => upload(e.target.files)} />
                  <Button variant="secondary" className="mt-4" onClick={() => fileInput.current?.click()} disabled={uploading}>
                    {uploading ? "Uploading…" : "Choose files"}
                  </Button>
                </div>
                {profile.records.length > 0 && (
                  <ul className="mt-5 divide-y divide-line/60">
                    {profile.records.map((r: RecordInfo) => {
                      const st = RECORD_STATUS[r.status] ?? { tone: "slate" as const, text: r.status };
                      return (
                        <li key={r.id} className="flex items-center justify-between gap-3 py-3">
                          <span className="truncate">{r.filename}</span>
                          <Badge tone={st.tone}>{st.text}</Badge>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card className="p-7">
                <Label>Step 3 · Send to your doctor</Label>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-5">
                  <p className="max-w-xl text-muted">
                    {profile.published_at
                      ? "Sent. Records you add later are shared with your doctor automatically."
                      : "Your doctor sees what Ritu noted, the conversation, and every record you uploaded."}
                  </p>
                  {profile.published_at ? (
                    <Badge tone="green">sent {new Date(profile.published_at).toLocaleDateString()}</Badge>
                  ) : (
                    <Button onClick={sendToDoctor} disabled={!summarized}>
                      <Send size={17} /> Send to doctor
                    </Button>
                  )}
                </div>
              </Card>
            </div>

            <aside className="space-y-6">
              <Card className="p-6">
                <Label>Progress</Label>
                <ul className="mt-5 space-y-3 text-[16px]">
                  {[
                    ["Talked to Ritu", summarized],
                    [`Records added (${profile.records.length})`, profile.records.length > 0],
                    ["Sent to doctor", !!profile.published_at],
                  ].map(([label, ok]) => (
                    <li key={label as string} className="flex items-center justify-between">
                      <span className={ok ? "" : "text-muted"}>{label as string}</span>
                      <CheckCircle2 size={20} className={ok ? "text-green-600" : "text-line"} />
                    </li>
                  ))}
                </ul>
              </Card>
              <Card className="p-6">
                <Label>Good to know</Label>
                <p className="mt-4 text-[15px] text-ink/80">
                  Ritu only collects information for your doctor. It does not diagnose or give medical advice. If you feel very unwell, contact emergency services.
                </p>
                <p className="mt-3 text-xs text-muted">Demo persona · synthetic data only.</p>
              </Card>
            </aside>
          </div>
        </>
      )}
    </Shell>
  );
}
