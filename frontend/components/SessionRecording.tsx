"use client";

import { Play } from "lucide-react";
import { useEffect, useState } from "react";

import { Card, Label } from "@/components/ui";
import { API_URL, getToken } from "@/lib/api";

/** Doctor-side player for a conversation's audio. Fetched on demand (the request needs the bearer token). */
export function SessionRecording({ caseId, sessionId }: { caseId: string; sessionId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    setSrc(null);
    setState("idle");
  }, [sessionId]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  async function load() {
    setState("loading");
    try {
      const r = await fetch(`${API_URL}/doctor/patients/${caseId}/sessions/${sessionId}/recording`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!r.ok) throw new Error(String(r.status));
      setSrc(URL.createObjectURL(await r.blob()));
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <Card className="p-6">
      <Label>Recording</Label>
      {src ? (
        <audio controls autoPlay src={src} className="mt-4 w-full" />
      ) : (
        <button
          onClick={load}
          disabled={state === "loading"}
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2.5 text-[15px] font-semibold hover:border-ink/30 disabled:opacity-50"
        >
          <Play size={16} /> {state === "loading" ? "Loading…" : "Listen to the conversation"}
        </button>
      )}
      {state === "error" && <p className="mt-2 text-sm text-red-700">Could not load the recording.</p>}
      <p className="mt-3 text-xs text-muted">Recorded in the patient&apos;s browser with their consent.</p>
    </Card>
  );
}
