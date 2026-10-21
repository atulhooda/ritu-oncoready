import { Badge } from "@/components/ui";
import type { BriefSummary } from "@/lib/types";

export function ScoreCell({ b, showPercent = true }: { b: BriefSummary; showPercent?: boolean }) {
  if (b.status === "scoring_failed") return <Badge tone="red">scoring failed</Badge>;
  if (!b.score) return <Badge>scoring…</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 whitespace-nowrap">
      {showPercent && <span className="font-semibold">{Number(b.score.percent).toFixed(0)}%</span>}
      <span className="text-muted">
        {b.score.points_earned}/{b.score.points_possible} pts
      </span>
      {b.score.critical_missed > 0 && <Badge tone="red">{b.score.critical_missed} critical missed</Badge>}
    </span>
  );
}
