export type Role = "resident" | "faculty" | "admin";

export interface Me {
  id: string;
  org_id: string;
  email: string;
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
