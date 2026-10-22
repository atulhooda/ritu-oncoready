import { Badge, Card, Label } from "@/components/ui";
import type { IntakeSummary } from "@/lib/types";

const DETAIL_LABELS: Record<string, string> = {
  onset: "since", duration: "for", severity: "severity", score: "score", location: "where", frequency: "how often",
  last_dose: "last dose", missed_doses: "missed",
  triggers: "triggers", dose: "dose", record_type: "type", record_date: "when", facility: "where", notes: "note",
};

export function IntakeSummaryView({
  summary,
  audience,
  onTurn,
}: {
  summary: IntakeSummary;
  audience: "patient" | "doctor";
  onTurn?: (turn: number) => void;
}) {
  const total = summary.sections.reduce((n, s) => n + s.facts.length, 0);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-7 py-5">
        <Label>{audience === "patient" ? "What Ritu noted" : "Pre-visit summary"}</Label>
        <div className="flex items-center gap-2 text-sm text-muted">
          <Badge>{summary.mode === "ritu" ? "Ritu voice" : "simulator"}</Badge>
          {summary.ended_at && new Date(summary.ended_at).toLocaleString()}
        </div>
      </div>
      {total === 0 && <p className="px-7 py-6 text-muted">Nothing was noted from this session.</p>}
      {summary.sections
        .filter((s) => s.facts.length)
        .map((s) => (
          <div key={s.section} className="border-t border-line/60 px-7 py-5 first:border-t-0">
            <div className="flex items-center justify-between">
              <Label>{s.label}</Label>
              <span className="font-semibold">{s.facts.length}</span>
            </div>
            <ul className="mt-3 space-y-4">
              {s.facts.map((f) => (
                <li key={f.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[17px] font-semibold">{f.label}</span>
                    {Object.entries(f.details).map(([k, v]) => (
                      <Badge key={k}>
                        {DETAIL_LABELS[k] ?? k}: {v}
                      </Badge>
                    ))}
                  </div>
                  <blockquote className="mt-2 rounded-xl border-l-4 border-brand/60 bg-brand-soft/50 px-4 py-2 text-ink/85">
                    “{f.quote}”
                    {onTurn ? (
                      <button onClick={() => onTurn(f.turn_index)} className="ml-2 font-mono text-[11px] uppercase tracking-wider text-brand hover:underline">
                        turn {f.turn_index}
                      </button>
                    ) : null}
                  </blockquote>
                </li>
              ))}
            </ul>
          </div>
        ))}
      <p className="border-t border-line/60 px-7 py-4 text-xs text-muted">
        {audience === "doctor"
          ? "Patient-reported, in their own words. Not verified, no interpretation added. Synthetic demo persona."
          : "These are your own words from the session. Your doctor sees this when you send it."}
      </p>
    </Card>
  );
}

export function TranscriptView({ summary, highlight }: { summary: IntakeSummary; highlight?: number | null }) {
  return (
    <Card>
      <div className="border-b border-line/70 px-7 py-5">
        <Label>Transcript</Label>
      </div>
      <ol className="space-y-3 px-7 py-5">
        {summary.transcript.map((t) => (
          <li
            key={t.turn_index}
            id={`turn-${t.turn_index}`}
            className={`flex gap-3 rounded-xl p-2 transition ${highlight === t.turn_index ? "bg-yellow-50 ring-1 ring-yellow-300" : ""}`}
          >
            <span className="w-16 shrink-0 font-mono text-[11px] uppercase tracking-wider text-muted">
              {t.turn_index} · {t.role}
            </span>
            <p className={t.role === "patient" ? "font-medium" : "text-ink/70"}>{t.text}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}
