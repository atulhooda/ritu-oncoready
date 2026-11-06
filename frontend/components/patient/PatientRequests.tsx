"use client";

import { Check, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge, Button, Card, Label } from "@/components/ui";
import { api, API_URL, getToken } from "@/lib/api";
import type { PatientRequestOut } from "@/lib/types";

const when = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

/** What the patient's doctors asked for before the visit: a record to upload, or a question. */
export function PatientRequests() {
  const [items, setItems] = useState<PatientRequestOut[]>([]);
  const load = () => api<PatientRequestOut[]>("/me/requests").then(setItems).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  if (!items.length) return null;
  const open = items.filter((r) => r.status === "open");
  return (
    <Card className="mb-6 border-brand/30 p-6 sm:p-7">
      <Label>Your doctor asked</Label>
      <ul className="mt-4 space-y-5">
        {open.map((r) => (
          <li key={r.id}>
            <Ask r={r} onDone={load} />
          </li>
        ))}
        {items.filter((r) => r.status === "answered").map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-2 text-sm text-ink/70">
            <Badge tone="green">sent</Badge>
            <span>{r.text}</span>
            <span className="text-muted">· {r.kind === "record" ? r.document?.filename ?? "record sent" : `“${r.answer}”`}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Ask({ r, onDone }: { r: PatientRequestOut; onDone: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }
  const upload = (files: FileList | null) =>
    files?.length &&
    run(async () => {
      const body = new FormData();
      const pdf = files.length === 1 && files[0].type === "application/pdf";
      if (pdf) body.append("file", files[0]);
      else Array.from(files).forEach((f, i) => body.append("pages", f, f.name || `page-${i + 1}.jpg`));
      // "Please upload your PET-CT report (September)." -> "PET-CT report (September)"
      body.append("name", r.text.replace(/^please upload (your )?/i, "").replace(/[.\s]+$/, "").slice(0, 80));
      const res = await fetch(`${API_URL}/me/records`, { method: "POST", body, headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      const doc = (await res.json()) as { id: string };
      await api(`/me/requests/${r.id}/record`, { method: "POST", body: JSON.stringify({ document_id: doc.id }) });
    });
  return (
    <div>
      <p className="font-medium">{r.text}</p>
      <p className="mb-3 text-sm text-muted">
        {r.asked_by?.name ?? "Your doctor"} · {when(r.asked_at)}
      </p>
      {r.kind === "record" ? (
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl bg-brand px-5 py-3 text-[15px] font-semibold text-white ${busy ? "opacity-50" : ""}`}>
          <Upload size={17} /> {busy ? "Sending…" : "Upload photo or PDF"}
          <input type="file" accept="image/png,image/jpeg,application/pdf" multiple className="hidden" disabled={busy}
            onChange={(e) => upload(e.target.files)} />
        </label>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} aria-label="Your answer"
            className="w-full rounded-xl border border-line bg-white px-3 py-2" />
          <Button disabled={busy || !text.trim()} onClick={() => run(() => api(`/me/requests/${r.id}/answer`, { method: "POST", body: JSON.stringify({ text }) }))}>
            <Check size={17} /> {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
