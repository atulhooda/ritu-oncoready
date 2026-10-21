"use client";

import { FileText, FileUp } from "lucide-react";
import { useRef, useState } from "react";

import { Badge, Button, Label } from "@/components/ui";
import { API_URL, getToken } from "@/lib/api";
import { mentionedRecords } from "@/lib/patient";
import type { PatientProfile } from "@/lib/types";

const STATUS: Record<string, { tone: "green" | "amber" | "red" | "slate"; text: string }> = {
  uploaded: { tone: "amber", text: "reading…" },
  ocr_done: { tone: "amber", text: "reading…" },
  extracted: { tone: "green", text: "ready" },
  failed: { tone: "red", text: "could not read" },
};

/** Drop zone + list of uploaded records. Used by the check-in's records step and the My records page. */
export function RecordsUploader({ profile, onChange }: { profile: PatientProfile; onChange: () => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const mentioned = mentionedRecords(profile);

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
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-5">
      {mentioned.length > 0 && (
        <div className="rounded-xl bg-brand-soft/60 px-4 py-3">
          <div className="text-sm text-ink/80">You told Ritu you have:</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {mentioned.map((m) => (
              <Badge key={m} tone="blue">{m}</Badge>
            ))}
          </div>
        </div>
      )}
      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
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
        className={`rounded-2xl border border-dashed px-6 py-10 text-center transition ${dragging ? "border-brand bg-brand-soft" : "border-[#d8d5cc] bg-[#faf9f6]"}`}
      >
        <FileUp size={28} className="mx-auto text-muted" strokeWidth={1.5} />
        <p className="mt-3 font-medium">Add photos or PDFs of your reports</p>
        <p className="text-sm text-muted">Test reports, scans, prescriptions, discharge summaries · up to 20 MB each</p>
        <input ref={input} type="file" multiple accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => upload(e.target.files)} />
        <Button type="button" variant="secondary" className="mt-5" onClick={() => input.current?.click()} disabled={uploading}>
          {uploading ? "Uploading…" : "Choose files"}
        </Button>
      </div>
      {profile.records.length > 0 && (
        <div>
          <Label>Uploaded · {profile.records.length}</Label>
          <ul className="mt-3 divide-y divide-line/60 rounded-xl border border-line/70 bg-white">
            {profile.records.map((r) => {
              const st = STATUS[r.status] ?? { tone: "slate" as const, text: r.status };
              return (
                <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText size={18} className="shrink-0 text-muted" strokeWidth={1.75} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.filename}</div>
                      <div className="text-xs text-muted">
                        {new Date(r.uploaded_at).toLocaleDateString()}
                        {r.page_count ? ` · ${r.page_count} page${r.page_count === 1 ? "" : "s"}` : ""}
                      </div>
                    </div>
                  </div>
                  <Badge tone={st.tone}>{st.text}</Badge>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
