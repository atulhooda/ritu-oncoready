import type { PatientProfile } from "@/lib/types";

export type StepId = "about" | "ritu" | "records" | "review";

export const STEPS: { id: StepId; title: string; short: string; minutes: number }[] = [
  { id: "about", title: "About you", short: "About you", minutes: 1 },
  { id: "ritu", title: "Talk to Ritu", short: "Talk to Ritu", minutes: 3 },
  { id: "records", title: "Earlier records", short: "Records", minutes: 1 },
  { id: "review", title: "Review & send", short: "Send", minutes: 1 },
];

const NO_RECORDS_KEY = (caseId: string) => `oncoready.noRecords.${caseId}`;

export function markNoRecords(caseId: string, value: boolean) {
  try {
    if (value) localStorage.setItem(NO_RECORDS_KEY(caseId), "1");
    else localStorage.removeItem(NO_RECORDS_KEY(caseId));
  } catch {
    /* storage unavailable: the step simply stays open */
  }
}

function saidNoRecords(caseId: string): boolean {
  try {
    return localStorage.getItem(NO_RECORDS_KEY(caseId)) === "1";
  } catch {
    return false;
  }
}

export function detailsComplete(p: PatientProfile): boolean {
  const d = p.details;
  return !!(d.date_of_birth && d.sex && d.cancer_type);
}

export function stepDone(p: PatientProfile, id: StepId): boolean {
  switch (id) {
    case "about":
      return detailsComplete(p);
    case "ritu":
      return !!p.summary;
    case "records":
      return p.records.length > 0 || !!p.published_at || saidNoRecords(p.case_id);
    case "review":
      return !!p.published_at;
  }
}

export function firstOpenStep(p: PatientProfile): StepId | null {
  return STEPS.find((s) => !stepDone(p, s.id))?.id ?? null;
}

/** Records Ritu heard the patient mention, as short labels. */
export function mentionedRecords(p: PatientProfile): string[] {
  return p.summary?.sections.find((s) => s.section === "previous_record")?.facts.map((f) => f.label) ?? [];
}
