"use client";

import { FileText, FileUp } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { mentionedRecords } from "@/components/NextStepCard";
import { PatientAside } from "@/components/PatientAside";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Badge, Button, Card, EmptyState, Label, PageHeader } from "@/components/ui";
import { API_URL, getToken } from "@/lib/api";

const STATUS: Record<string, { tone: "green" | "amber" | "red" | "slate"; text: string }> = {
  uploaded: { tone: "amber", text: "reading…" },
  ocr_done: { tone: "amber", text: "reading…" },
  extracted: { tone: "green", text: "ready" },
  failed: { tone: "red", text: "could not read" },
};

export default function RecordsPage() {
  const { me, profile, reload } = usePatient();
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const body = new FormData();
        body.append("file", f);
        const res = await fetch(`${API_URL}/me/records`, { method: "POST", body, headers: { Authorization: `Bearer ${getToken()}` } });
        if (!res.ok) throw new Error(`${f.name}: ${(await res.json()).detail ?? res.statusText}`);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <Shell me={me}>
      {profile && (
        <>
          <PageHeader eyebrow="My records" title="Your" accent="records." subtitle="Reports, scans, prescriptions and discharge summaries. We read each page so your doctor sees everything in date order." />
          {error && <p className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="space-y-6">
              {mentionedRecords(profile).length > 0 && (
                <Card className="p-6">
                  <Label>You told Ritu you have</Label>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {mentionedRecords(profile).map((m) => (
                      <Badge key={m} tone="blue">{m}</Badge>
                    ))}
                  </div>
                </Card>
              )}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  upload(e.dataTransfer.files);
                }}
                className={`rounded-2xl border border-dashed px-6 py-14 text-center transition ${dragging ? "border-brand bg-brand-soft" : "border-[#d8d5cc] bg-[#faf9f6]"}`}
              >
                <FileUp size={30} className="mx-auto text-muted" strokeWidth={1.5} />
                <p className="mt-3 text-lg font-medium">Drop files here, or choose them</p>
                <p className="text-sm text-muted">PDF or photos (PNG, JPEG), up to 20 MB each</p>
                <input ref={input} type="file" multiple accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => upload(e.target.files)} />
                <Button variant="secondary" className="mt-5" onClick={() => input.current?.click()} disabled={uploading}>
                  {uploading ? "Uploading…" : "Choose files"}
                </Button>
              </div>

              {profile.records.length === 0 ? (
                <EmptyState title="No records yet.">Anything you upload shows up here.</EmptyState>
              ) : (
                <Card>
                  <div className="flex items-center justify-between border-b border-line/70 px-7 py-5">
                    <Label>Uploaded</Label>
                    <span className="font-semibold">{profile.records.length}</span>
                  </div>
                  <ul>
                    {profile.records.map((r) => {
                      const st = STATUS[r.status] ?? { tone: "slate" as const, text: r.status };
                      return (
                        <li key={r.id} className="flex items-center justify-between gap-4 border-t border-line/60 px-7 py-4 first:border-t-0">
                          <div className="flex min-w-0 items-center gap-3">
                            <FileText size={18} className="shrink-0 text-muted" strokeWidth={1.75} />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{r.filename}</div>
                              <div className="text-sm text-muted">
                                {new Date(r.uploaded_at).toLocaleString()}
                                {r.page_count ? ` · ${r.page_count} page${r.page_count === 1 ? "" : "s"}` : ""}
                              </div>
                            </div>
                          </div>
                          <Badge tone={st.tone}>{st.text}</Badge>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
              <Card className="flex flex-wrap items-center justify-between gap-4 p-6">
                <p className="text-muted">
                  {profile.records.length ? "Done adding records?" : "Don't have any records? You can still send what you told Ritu."}
                </p>
                <Link
                  href="/patient/send"
                  className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-[15px] font-semibold text-white shadow-[0_6px_16px_-6px_rgba(58,79,224,0.7)] hover:bg-brand-hover"
                >
                  {profile.records.length ? "Review and send to doctor" : "I don't have records, continue"}
                </Link>
              </Card>
            </div>
            <PatientAside profile={profile} />
          </div>
        </>
      )}
    </Shell>
  );
}
