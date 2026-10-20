"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ScoreCell } from "@/components/ScoreCell";
import { Badge, Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { api } from "@/lib/api";
import type { BriefDetail, ScoredItem } from "@/lib/types";
import { SECTION_KEYS } from "@/lib/types";

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

  return (
    <Shell me={me}>
      {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {brief && (
        <>
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <Link href="/faculty" className="text-sm text-blue-700 hover:underline">
                ← Dashboard
              </Link>
              <h1 className="text-lg font-semibold">
                {brief.resident_name} · {brief.case_code} {brief.case_title}
              </h1>
            </div>
            <div className="text-sm">
              <ScoreCell b={brief} />
              {brief.score && <span className="ml-2 text-xs text-slate-500">engine {brief.score.engine_version}</span>}
            </div>
          </div>
          {brief.scoring_error && <p className="mb-3 text-sm text-red-700">Scoring error: {brief.scoring_error}</p>}
          <div className="grid gap-6 lg:grid-cols-5">
            <section className="lg:col-span-2">
              <h2 className="mb-2 font-medium">Brief</h2>
              <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
                {SECTION_KEYS.map((k) => (
                  <div key={k}>
                    <h3 className="text-sm font-medium text-slate-700">{brief.section_labels[k]}</h3>
                    <p className="whitespace-pre-wrap text-sm">{brief.sections[k] || <span className="text-slate-400">(empty)</span>}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="lg:col-span-3">
              <h2 className="mb-2 font-medium">Rubric items</h2>
              <ul className="space-y-3">
                {brief.items.map((item) => (
                  <ItemCard
                    key={item.rubric_item_id}
                    item={item}
                    onOverride={(body) =>
                      act(`/faculty/briefs/${brief.id}/items/${item.rubric_item_id}/override`, { method: "PUT", body: JSON.stringify(body) })
                    }
                    onClear={() => act(`/faculty/briefs/${brief.id}/items/${item.rubric_item_id}/override`, { method: "DELETE" })}
                  />
                ))}
                {brief.items.length === 0 && <p className="text-sm text-slate-500">Not scored yet.</p>}
              </ul>
            </section>
          </div>
        </>
      )}
    </Shell>
  );
}

function ItemCard({
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

  return (
    <li className={`rounded-lg border bg-white p-3 ${item.matched ? "border-green-200" : item.is_critical ? "border-red-300" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {item.matched ? <Badge tone="green">matched</Badge> : <Badge tone={item.is_critical ? "red" : "slate"}>missed</Badge>}
        {item.is_critical && <Badge tone="red">critical</Badge>}
        <Badge tone="slate">{item.category}</Badge>
        <span className="text-xs text-slate-500">weight {item.weight}</span>
        {item.source === "override" && <Badge tone="amber">faculty override</Badge>}
      </div>
      <p className="mt-1 text-sm font-medium">{item.description}</p>
      {item.evidence && (
        <blockquote className="mt-1 border-l-2 border-green-400 pl-2 text-sm text-slate-700">
          “{item.evidence}” <span className="text-xs text-slate-500">({item.evidence_section?.replaceAll("_", " ")})</span>
        </blockquote>
      )}
      {item.source === "override" && (
        <p className="mt-1 text-xs text-amber-800">
          Override by {item.overridden_by}: {item.override_comment} (matcher said {item.matcher_matched ? "matched" : "missed"})
        </p>
      )}
      {item.rejected_evidence.length > 0 && (
        <details className="mt-1 text-xs text-slate-500">
          <summary>{item.rejected_evidence.length} matcher quote(s) rejected (not found in brief)</summary>
          <ul className="ml-4 list-disc">
            {item.rejected_evidence.map((r, i) => (
              <li key={i}>“{r.quote}”</li>
            ))}
          </ul>
        </details>
      )}
      <div className="mt-2 flex gap-2 text-xs">
        <button onClick={() => setOpen(!open)} className="text-blue-700 hover:underline">
          Override → mark {target ? "matched" : "missed"}
        </button>
        {item.source === "override" && (
          <button onClick={onClear} className="text-blue-700 hover:underline">
            Remove override
          </button>
        )}
      </div>
      {open && (
        <form
          className="mt-2 space-y-2"
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
            placeholder="Comment (required)"
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
          {target && (
            <input
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
              placeholder="Evidence quote from the brief (optional, must match exactly)"
              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          )}
          <button className="rounded bg-slate-900 px-3 py-1 text-sm text-white">Save override</button>
        </form>
      )}
    </li>
  );
}
