"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Button, Card, Label, PageHeader, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import type { BriefDetail, ScoredItem } from "@/lib/types";
import { caseTitle, SECTION_KEYS } from "@/lib/types";

export default function FacultyBriefPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe(["faculty", "admin"]);
  const [brief, setBrief] = useState<BriefDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me) api<BriefDetail>(`/faculty/briefs/${id}`).then(setBrief).catch((e) => setError(e.message));
  }, [me, id]);

  async function act(path: string, init: RequestInit) {
    setError(null);
    try {
      setBrief(await api<BriefDetail>(path, init));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }

  const matched = brief?.items.filter((i) => i.matched).length ?? 0;
  const overrides = brief?.items.filter((i) => i.source === "override").length ?? 0;

  return (
    <Shell me={me}>
      {error && <p className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {brief && (
        <>
          <Link href="/faculty" className="text-sm font-medium text-brand hover:underline">
            ← Assessments
          </Link>
          <div className="mt-4">
            <PageHeader
              eyebrow={`${brief.case_code} · ${brief.resident_name}`}
              title={caseTitle(brief.case_title) || "Brief"}
              subtitle={`Submitted ${brief.submitted_at ? new Date(brief.submitted_at).toLocaleString() : "—"}`}
            />
          </div>
          {brief.scoring_error && <p className="mb-5 text-sm text-red-700">Scoring error: {brief.scoring_error}</p>}
          <div className="mb-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Score" tone="brand" value={brief.score ? <>{Number(brief.score.percent).toFixed(0)}<span className="text-3xl">%</span></> : "—"} sub={brief.score ? `${brief.score.points_earned} / ${brief.score.points_possible} points` : "scoring…"} />
            <Stat label="Items matched" value={`${matched}/${brief.items.length}`} sub="rubric items" />
            <Stat label="Critical missed" tone={brief.score?.critical_missed ? "red" : "green"} value={brief.score?.critical_missed ?? "—"} sub="must-catch items" />
            <Stat label="Overrides" value={overrides} sub={brief.score ? `engine ${brief.score.engine_version}` : ""} />
          </div>
          <div className="grid gap-6 xl:grid-cols-[2fr_3fr]">
            <Card className="h-fit p-7">
              <Label>Resident brief</Label>
              <div className="mt-5 space-y-5">
                {SECTION_KEYS.map((k) => (
                  <div key={k}>
                    <h3 className="text-[15px] font-semibold">{brief.section_labels[k]}</h3>
                    <p className="mt-1 whitespace-pre-wrap text-ink/80">{brief.sections[k] || <span className="text-muted">(empty)</span>}</p>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <div className="flex items-center justify-between border-b border-line/70 px-7 py-5">
                <Label>Rubric items</Label>
                <span className="text-sm text-muted">
                  {brief.items.length - matched} of {brief.items.length} missed
                </span>
              </div>
              <ul>
                {brief.items.map((item) => (
                  <ItemRow
                    key={item.rubric_item_id}
                    item={item}
                    onOverride={(body) =>
                      act(`/faculty/briefs/${brief.id}/items/${item.rubric_item_id}/override`, { method: "PUT", body: JSON.stringify(body) })
                    }
                    onClear={() => act(`/faculty/briefs/${brief.id}/items/${item.rubric_item_id}/override`, { method: "DELETE" })}
                  />
                ))}
                {brief.items.length === 0 && <li className="px-7 py-6 text-muted">Not scored yet.</li>}
              </ul>
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}

function ItemRow({
  item,
  onOverride,
  onClear,
}: {
  item: ScoredItem;
  onOverride: (body: { matched: boolean; comment: string; evidence_quote?: string }) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [quote, setQuote] = useState("");
  const target = !item.matched;
  const titleColor = item.matched ? "text-green-800" : item.is_critical ? "text-red-700" : "text-amber-800";

  return (
    <li className="grid grid-cols-[64px_1fr] gap-4 border-t border-line/60 px-7 py-6 first:border-t-0">
      <div className="text-right">
        <div className="text-2xl font-extrabold">{Number(item.weight).toFixed(0)}</div>
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted">pts</div>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[17px] font-semibold ${titleColor}`}>{item.description}</span>
          {item.matched ? <Badge tone="green">matched</Badge> : <Badge tone={item.is_critical ? "red" : "amber"}>missed</Badge>}
          {item.is_critical && <Badge tone="red">critical</Badge>}
          <Badge>{item.category.replaceAll("_", " ")}</Badge>
          {item.source === "override" && <Badge tone="blue">faculty override</Badge>}
        </div>
        {item.evidence && (
          <blockquote className="mt-3 rounded-xl border-l-4 border-green-500 bg-green-50/60 px-4 py-2.5 text-ink/85">
            <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
              {item.evidence_section?.replaceAll("_", " ")}
            </div>
            “{item.evidence}”
          </blockquote>
        )}
        {item.source === "override" && (
          <p className="mt-2 text-sm text-ink/70">
            <span className="font-medium">{item.overridden_by}:</span> {item.override_comment}{" "}
            <span className="text-muted">(matcher said {item.matcher_matched ? "matched" : "missed"})</span>
          </p>
        )}
        {item.rejected_evidence.length > 0 && (
          <details className="mt-2 text-sm text-muted">
            <summary className="cursor-pointer">{item.rejected_evidence.length} matcher quote(s) rejected: not found in brief</summary>
            <ul className="ml-5 mt-1 list-disc">
              {item.rejected_evidence.map((r, i) => (
                <li key={i}>“{r.quote}”</li>
              ))}
            </ul>
          </details>
        )}
        <div className="mt-3 flex gap-4 text-sm">
          <button onClick={() => setOpen(!open)} className="font-medium text-brand hover:underline">
            Mark as {target ? "matched" : "missed"}…
          </button>
          {item.source === "override" && (
            <button onClick={onClear} className="font-medium text-muted hover:text-ink">
              Remove override
            </button>
          )}
        </div>
        {open && (
          <form
            className="mt-3 space-y-3 rounded-xl border border-line bg-paper/60 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              onOverride({ matched: target, comment, ...(quote.trim() ? { evidence_quote: quote } : {}) });
              setOpen(false);
              setComment("");
              setQuote("");
            }}
          >
            <textarea
              required
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Why? (required)"
              className="w-full rounded-xl border border-line bg-white px-3 py-2 outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
            />
            {target && (
              <input
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                placeholder="Evidence quote from the brief (optional, must match exactly)"
                className="w-full rounded-xl border border-line bg-white px-3 py-2 outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
              />
            )}
            <Button className="px-4 py-2 text-sm">Save override</Button>
          </form>
        )}
      </div>
    </li>
  );
}
