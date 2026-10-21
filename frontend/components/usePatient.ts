"use client";

import { useCallback, useEffect, useState } from "react";

import { useMe } from "@/components/useMe";
import { api } from "@/lib/api";
import type { Me, PatientProfile } from "@/lib/types";

/** Current patient + their profile; polls while a summary or record is still being processed. */
export function usePatient(): { me: Me | null; profile: PatientProfile | null; reload: () => Promise<void> } {
  const me = useMe(["patient"]);
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const reload = useCallback(() => api<PatientProfile>("/me/profile").then(setProfile), []);

  useEffect(() => {
    if (me) reload();
  }, [me, reload]);

  const busy =
    profile?.sessions.some((s) => s.status === "completed") ||
    profile?.records.some((r) => r.status === "uploaded" || r.status === "ocr_done");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [busy, reload]);

  return { me, profile, reload };
}
