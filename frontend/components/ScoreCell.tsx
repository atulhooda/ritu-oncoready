import { Badge } from "@/components/Shell";
import type { BriefSummary } from "@/lib/types";

export function ScoreCell({ b }: { b: BriefSummary }) {
  if (b.status === "scoring_failed") return <Badge tone="red">scoring failed</Badge>;
  if (!b.score) return <Badge tone="slate">scoring…</Badge>;
  return (
    <span className="whitespace-nowrap">
      {b.score.percent}% <span className="text-slate-500">({b.score.points_earned}/{b.score.points_possible})</span>{" "}
      {b.score.critical_missed > 0 && <Badge tone="red">{b.score.critical_missed} critical missed</Badge>}
    </span>
  );
}
