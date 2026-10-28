export type Role = "resident" | "faculty" | "admin" | "patient" | "doctor";

export function homeFor(role: Role): string {
  return { resident: "/cases", faculty: "/faculty", admin: "/faculty", patient: "/patient", doctor: "/doctor" }[role];
}

export interface Me {
  id: string;
  org_id: string;
  /** Staff sign in with email; patients who signed up use their phone. */
  email: string | null;
  phone?: string | null;
  /** The patient's OncoReady ID, e.g. OR-7K3F-9Q2D (patients who signed up). */
  patient_number?: string | null;
  full_name: string;
  role: Role;
  org_name: string | null;
}

export interface CaseSummary {
  id: string;
  case_code: string;
  title: string;
  summary: string | null;
  status: string;
}

export interface DocumentInfo {
  id: string;
  filename: string;
  page_count: number | null;
  status: string;
}

export const SECTION_KEYS = [
  "key_changes",
  "pending_investigations",
  "discrepancies_noticed",
  "treatment_history",
  "red_flags",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type Sections = Record<SectionKey, string>;

export interface Brief {
  id: string;
  case_id: string;
  status: "draft" | "submitted" | "scored" | "scoring_failed";
  submitted_at: string | null;
  sections: Sections;
  section_labels: Record<SectionKey, string>;
}

export interface SourceRef {
  document_id: string;
  filename: string;
  page_number: number;
  page_url: string;
  image_url: string;
  text_span: string;
}

export interface TimelineEvent {
  id: string;
  event_date: string | null;
  date_precision: string;
  category: string;
  description: string | null;
  source: SourceRef;
}

export interface Timeline {
  events: TimelineEvent[];
  date_unclear: { label: string; events: TimelineEvent[] };
  pending_tests: { id: string; test_name: string; ordered_date: string | null; source: SourceRef }[];
  discrepancies: { id: string; field: string; description: string }[];
  flags: { rule: string; message: string }[];
}

export interface ScoreSummary {
  points_earned: string;
  points_possible: string;
  percent: string;
  critical_missed: number;
  engine_version: string;
}

export interface BriefSummary {
  id: string;
  case_id: string;
  case_code: string | null;
  case_title: string | null;
  resident_id: string;
  resident_name: string | null;
  status: string;
  submitted_at: string | null;
  scoring_error: string | null;
  score: ScoreSummary | null;
}

export interface ScoredItem {
  rubric_item_id: string;
  category: string;
  description: string;
  weight: string;
  is_critical: boolean;
  matched: boolean;
  source: "matcher" | "override" | "none";
  matcher_matched: boolean | null;
  evidence: string | null;
  evidence_section: SectionKey | null;
  override_comment: string | null;
  overridden_by: string | null;
  rejected_evidence: { quote: string; reason: string }[];
}

export interface BriefDetail extends BriefSummary {
  sections: Sections;
  section_labels: Record<SectionKey, string>;
  items: ScoredItem[];
}

export interface ResidentRow {
  id: string;
  name: string;
  email: string;
  briefs: number;
  mean_percent: number | null;
}

export interface CategoryTrend {
  category: string;
  items: number;
  missed: number;
  critical_missed: number;
  cases: number;
  cases_with_miss: number;
  miss_rate: number;
  repeatedly_missed: boolean;
}

export interface Trend {
  resident: { id: string; name: string };
  cases: BriefSummary[];
  categories: CategoryTrend[];
}

/** "Synthetic case: new left breast mass" -> "New left breast mass" */
export function caseTitle(title: string | null | undefined): string {
  const t = (title ?? "").replace(/^Synthetic case:\s*/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// --- patient intake ---------------------------------------------------------------------

export interface IntakeFact {
  id: string;
  label: string;
  details: Record<string, string>;
  quote: string;
  turn_index: number;
  /** Every verified quote about this problem, primary first. */
  evidence?: { turn_index: number; quote: string }[];
  /** On the fixed urgent-signs list (matched in code on the backend). */
  urgent?: boolean;
}

/** pre_visit: the full history before a visit; check_in: a short conversation between visits. */
export type SessionKind = "pre_visit" | "check_in";

export interface IntakeSummary {
  session_id: string;
  kind?: SessionKind;
  mode: "ritu" | "simulator";
  language?: string;
  has_recording?: boolean;
  started_at: string | null;
  ended_at: string | null;
  sections: { section: string; label: string; facts: IntakeFact[] }[];
  transcript: { turn_index: number; role: "patient" | "ritu" | "system"; text: string }[];
}

export interface IntakeSession {
  id: string;
  kind?: SessionKind;
  recording_consent?: boolean;
  has_recording?: boolean;
  status: "created" | "in_progress" | "completed" | "summarized" | "failed" | "expired";
  mode: "ritu" | "simulator";
  error: string | null;
  ritu?: { ws_url: string; token: string; expires_at: string | null };
}

export interface RecordInfo {
  id: string;
  filename: string;
  status: string;
  page_count: number | null;
  uploaded_at: string;
  error: string | null;
}

export interface PatientDetails {
  date_of_birth: string | null;
  sex: "female" | "male" | "intersex" | "other" | "prefer_not_to_say" | null;
  phone: string | null;
  preferred_language: string;
  cancer_type: string | null;
  diagnosed_on: string | null;
  stage_reported: string | null;
  treatment_status: "not_started" | "on_treatment" | "completed" | "follow_up" | "not_sure" | null;
  current_treatment: string | null;
  treating_hospital: string | null;
  treating_doctor: string | null;
  other_conditions: string | null;
  age: number | null;
  updated_at: string | null;
  /** Linked ABHA (number masked to the last 4 digits), or null. */
  abha: AbhaLink | null;
  /** Identity verified through DigiLocker, or null. */
  identity: VerifiedIdentity | null;
}

export interface VerifiedIdentity {
  name: string | null;
  dob: string | null;
  gender: "M" | "F" | "T" | null;
  verified_at: string;
  /** digilocker: live DigiLocker. digilocker_demo: demo mode (not a real check). */
  verified_via: "digilocker" | "digilocker_demo";
}

export interface DigiLockerDocument {
  uri: string;
  name: string;
  issuer: string | null;
  date: string | null;
  mime: string;
  source: "issued" | "uploaded";
  imported: boolean;
}

export interface AbhaLink {
  number: string;
  address: string | null;
  name: string | null;
  verified_at: string;
  /** abdm_sandbox: OTP checked by the ABDM sandbox. demo: ABDM not connected (no credentials). */
  verified_via: "abdm_sandbox" | "demo";
}

export const LANGUAGES: Record<string, string> = {
  "en-IN": "English",
  "hi-IN": "हिन्दी · Hindi",
  "mr-IN": "मराठी · Marathi",
  "gu-IN": "ગુજરાતી · Gujarati",
  "kn-IN": "ಕನ್ನಡ · Kannada",
  "ta-IN": "தமிழ் · Tamil",
  "te-IN": "తెలుగు · Telugu",
  "bn-IN": "বাংলা · Bengali",
  "pa-IN": "ਪੰਜਾਬੀ · Punjabi",
  "ml-IN": "മലയാളം · Malayalam",
  "od-IN": "ଓଡ଼ିଆ · Odia",
};

export const SEX_LABELS: Record<string, string> = {
  female: "Female",
  male: "Male",
  intersex: "Intersex",
  other: "Other",
  prefer_not_to_say: "Prefer not to say",
};

export const TREATMENT_LABELS: Record<string, string> = {
  not_started: "Not started yet",
  on_treatment: "On treatment now",
  completed: "Finished treatment",
  follow_up: "In follow-up",
  not_sure: "Not sure",
};

/** "54 · Female · Breast cancer" from whatever the patient filled in. */
export function detailsLine(d: Pick<PatientDetails, "age" | "sex" | "cancer_type"> | null | undefined): string {
  if (!d) return "";
  return [d.age !== null ? `${d.age} y` : null, d.sex ? SEX_LABELS[d.sex] : null, d.cancer_type].filter(Boolean).join(" · ");
}

export interface PatientProfile {
  name: string;
  email: string | null;
  phone: string | null;
  patient_number: string | null;
  details: PatientDetails;
  case_id: string;
  published_at: string | null;
  voice_mode: "ritu" | "simulator";
  abha_mode: "abdm_sandbox" | "demo";
  sessions: IntakeSession[];
  summary: IntakeSummary | null;
  /** Between-visit check-ins, newest first. */
  check_ins: IntakeSummary[];
  symptom_course: SymptomCourse;
  records: RecordInfo[];
}

export interface IntakeScript {
  steps: { id: string; goal: string; prompts: string[] }[];
  closing: string;
  closing_example: string;
}

export interface DoctorPatientRow {
  case_id: string;
  name: string;
  patient_number: string | null;
  age: number | null;
  sex: PatientDetails["sex"];
  cancer_type: string | null;
  abha_verified_via: AbhaLink["verified_via"] | null;
  published_at: string;
  symptoms: string[];
  conversations: number;
  check_ins: number;
  last_check_in: { ended_at: string | null; urgent: string[] } | null;
  records: number;
  pending_tests: number;
  discrepancies: number;
  flags: number;
}

export interface DoctorPatientDetail {
  case_id: string;
  name: string;
  patient_number: string | null;
  published_at: string;
  details: PatientDetails;
  summary: IntakeSummary | null;
  sessions: IntakeSummary[];
  symptom_course: SymptomCourse;
  records: RecordInfo[];
  timeline: Timeline;
}

/** Each symptom across conversations, oldest to newest. A null cell: not mentioned that time. */
export interface SymptomCourse {
  sessions: { session_id: string; kind: SessionKind; ended_at: string | null }[];
  rows: {
    label: string;
    urgent: boolean;
    cells: ({ fact_id: string; score: number | null; trend: string | null; severity: string | null; urgent: boolean } | null)[];
  }[];
}

/** A doctor's professional details. Self-declared: not yet verified with HPR. */
export interface Practitioner {
  name: string;
  email: string;
  hpr_id: string | null;
  registration_number: string | null;
  medical_council: string | null;
  qualification: string | null;
  verified: boolean;
}

/** 71123456789012 -> 71-1234-5678-9012 */
export function formatId14(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 14);
  return [d.slice(0, 2), d.slice(2, 6), d.slice(6, 10), d.slice(10, 14)].filter(Boolean).join("-");
}

/** Where a statement in a records-assistant answer comes from. */
export type AssistantSource =
  | { type: "document"; document_id: string; filename: string; page_number: number; text_span: string }
  | { type: "conversation"; session_id: string; session_kind: SessionKind; turn_index: number; quote: string; label: string };

/** RITU records assistant answer. Every line is built in code from cited record text. */
export interface AssistantAnswer {
  question: string;
  method: "measurements" | "pending_tests" | "records_search" | "keyword_search";
  status: "answered" | "not_found";
  lines: { text: string; refs: number[]; kind: "statement" | "missing" | "note" | "computed" | "heading" | "quote"; flag?: string }[];
  sources: {
    n: number;
    source: AssistantSource;
    date: string | null;
    /** stated: the date written with the fact; document: the document's date; conversation: when the patient said it. */
    date_basis: "stated" | "document" | "conversation" | null;
    value?: string;
    unit?: string | null;
  }[];
  conflict: string | null;
  notice: string | null;
  searched: { documents: number; pages: number; conversations: number };
}
