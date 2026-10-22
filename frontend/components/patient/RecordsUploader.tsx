"use client";

import { Camera, FileText, FileUp, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge, Button, Label } from "@/components/ui";
import { api, API_URL, getToken } from "@/lib/api";
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
  const camera = useRef<HTMLInputElement>(null);
  const mentioned = mentionedRecords(profile);
  // Photos waiting to be saved as one document (a report photographed page by page).
  const [shots, setShots] = useState<{ file: File; url: string }[]>([]);
  const [docName, setDocName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(window.matchMedia("(pointer: coarse)").matches), []);
  // Release preview URLs only when the component goes away (not on every change).
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  function addShots(files: FileList | null) {
    if (!files?.length) return;
    // Read the files NOW: resetting the input below empties this FileList.
    const added = Array.from(files).map((file) => ({ file, url: URL.createObjectURL(file) }));
    setShots((s) => [...s, ...added]);
    if (camera.current) camera.current.value = "";
  }

  function dropShot(shot: { file: File; url: string }) {
    URL.revokeObjectURL(shot.url);
    setShots((all) => all.filter((x) => x !== shot));
  }

  async function saveShots() {
    if (!shots.length) return;
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      shots.forEach((s, i) => body.append("pages", s.file, `page-${i + 1}.jpg`));
      if (docName.trim()) body.append("name", docName.trim());
      const res = await fetch(`${API_URL}/me/records`, { method: "POST", body, headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      setShots([]);
      setDocName("");
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/me/records/${id}`, { method: "DELETE" });
      setConfirming(null);
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove");
    }
  }

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
        {/* capture opens the rear camera on phones; on a computer it is a photo picker */}
        <input ref={camera} type="file" accept="image/*" capture="environment" multiple={!touch} className="hidden" onChange={(e) => addShots(e.target.files)} />
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button type="button" onClick={() => camera.current?.click()} disabled={uploading}>
            <Camera size={17} /> {touch ? "Take a photo" : "Photograph a report"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => input.current?.click()} disabled={uploading}>
            {uploading ? "Uploading…" : "Choose files"}
          </Button>
        </div>
      </div>

      {shots.length > 0 && (
        <div className="rounded-2xl border border-brand/30 bg-white p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold">
              {shots.length} page{shots.length === 1 ? "" : "s"} ready to save as one document
            </p>
            <button type="button" onClick={() => { shots.forEach((x) => URL.revokeObjectURL(x.url)); setShots([]); }} className="text-sm text-muted hover:text-ink">
              Discard
            </button>
          </div>
          <ol className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
            {shots.map((s, i) => (
              <li key={s.url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                <img src={s.url} alt={`Page ${i + 1}`} className="aspect-[3/4] w-full rounded-lg border border-line object-cover" />
                <span className="absolute bottom-1 left-1 rounded bg-ink/75 px-1.5 text-xs text-white">{i + 1}</span>
                <button
                  type="button"
                  aria-label={`Remove page ${i + 1}`}
                  onClick={() => dropShot(s)}
                  className="absolute right-1 top-1 rounded-full bg-white/90 p-1 shadow hover:bg-white"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => camera.current?.click()}
                className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-sm text-muted hover:border-brand hover:text-brand"
              >
                <Plus size={18} /> Add page
              </button>
            </li>
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              placeholder="Name it, e.g. Blood report March"
              className="min-w-[220px] flex-1 rounded-xl border border-line px-4 py-2.5 outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
            />
            <Button type="button" onClick={saveShots} disabled={uploading}>
              {uploading ? "Saving…" : `Save as one document`}
            </Button>
          </div>
        </div>
      )}
      {profile.records.length > 0 && (
        <div>
          <Label>Uploaded · {profile.records.length}</Label>
          <ul className="mt-3 divide-y divide-line/60 rounded-xl border border-line/70 bg-white">
            {profile.records.map((r) => {
              const st = STATUS[r.status] ?? { tone: "slate" as const, text: r.status };
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
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
                  <div className={`flex shrink-0 items-center gap-2 ${confirming === r.id ? "w-full justify-end sm:w-auto" : ""}`}>
                    {confirming === r.id ? (
                      <>
                        <span className="text-sm text-ink/70">Remove this record? Your care team will no longer see it.</span>
                        <button type="button" onClick={() => remove(r.id)} className="rounded-lg bg-red-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-700">
                          Remove
                        </button>
                        <button type="button" onClick={() => setConfirming(null)} className="rounded-lg px-2 py-1 text-sm text-muted hover:text-ink">
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <Badge tone={st.tone}>{st.text}</Badge>
                        <button type="button" aria-label={`Remove ${r.filename}`} onClick={() => setConfirming(r.id)} className="rounded-lg p-1.5 text-muted hover:bg-red-50 hover:text-red-600">
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
