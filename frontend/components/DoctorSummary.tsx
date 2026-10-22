"use client";

import { Quote } from "lucide-react";
import { Fragment, useState } from "react";

import { Badge, Card, Label } from "@/components/ui";
import type { IntakeFact, IntakeSummary } from "@/lib/types";
import { LANGUAGES } from "@/lib/types";

/** Patient-reported items on a fixed list of urgent signs (matched in code, never by the LLM).
 *  Keep in step with the safety rule in backend/app/voice/script.py; clinically reviewed list. */
const URGENT = [
  /\bcough\w*( up| with)? blood|\bblood in (the )?(stool|urine|vomit|sputum|cough)|\bvomit\w* blood|\bblack stool|\bbleed/i,
  /\bfever|\bchills/i,
  /\bchest pain/i,
  /\bconfus|\bfaint|\bseizure|\bfits\b/i,
  /\bsuicid|\bself[- ]?harm|\bharm (my|them)sel/i,
  /\bcan'?t breathe|\bsevere(ly)? (short(ness)? of )?breath/i,
];

export function urgentItems(summary: IntakeSummary): IntakeFact[] {
  return summary.sections
    .filter((s) => ["current_symptom", "recent_care"].includes(s.section))
    .flatMap((s) => s.facts)
    .filter((f) => URGENT.some((re) => re.test(`${f.label} ${Object.values(f.details).join(" ")}`)));
}

function score(f: IntakeFact): number | null {
  const m = (f.details.score || f.details.severity || "").match(/(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n <= 10 ? n : null;
}

const TREND: Record<string, { text: string; tone: "red" | "green" | "slate" }> = {
  worsening: { text: "worsening", tone: "red" },
  improving: { text: "improving", tone: "green" },
  same: { text: "no change", tone: "slate" },
};

function detailLine(f: IntakeFact, skip: string[] = []): string {
  const d = f.details;
  const order: [string, string][] = [
    ["dose", ""], ["last_dose", "last: "], ["missed_doses", "missed: "], ["onset", "since "], ["duration", "for "],
    ["location", ""], ["frequency", ""], ["triggers", "with "], ["record_type", ""], ["record_date", ""],
    ["facility", ""], ["notes", ""],
  ];
  return order
    .filter(([k]) => d[k] && !skip.includes(k))
    .map(([k, prefix]) => `${prefix}${d[k]}`)
    .join(" · ");
}

function Evidence({ f, onTurn }: { f: IntakeFact; onTurn: (t: number) => void }) {
  const quotes = f.evidence?.length ? f.evidence : [{ turn_index: f.turn_index, quote: f.quote }];
  return (
    <ul className="space-y-1.5">
      {quotes.map((q, i) => (
        <li key={i} className="text-[15px] text-ink/80">
          “{q.quote}”{" "}
          <button onClick={() => onTurn(q.turn_index)} className="font-mono text-[11px] uppercase tracking-wider text-brand hover:underline">
            turn {q.turn_index}
          </button>
        </li>
      ))}
    </ul>
  );
}

function QuoteToggle({ open, onClick, count }: { open: boolean; onClick: () => void; count: number }) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      title="Show the patient's words"
      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${open ? "bg-brand-soft text-brand" : "text-muted hover:bg-paper"}`}
    >
      <Quote size={13} /> {count}
    </button>
  );
}

/** Clinical summary of one conversation: at-a-glance, symptom table, compact sections; quotes on demand. */
export function DoctorSummary({ summary, onTurn }: { summary: IntakeSummary; onTurn: (t: number) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const section = (key: string) => summary.sections.find((s) => s.section === key)?.facts ?? [];
  const symptoms = [...section("current_symptom")].sort((a, b) => (score(b) ?? -1) - (score(a) ?? -1));
  const concerns = section("concern");
  const treatment = section("treatment");
  const worst = symptoms.find((s) => score(s) !== null);
  const total = summary.sections.reduce((n, s) => n + s.facts.length, 0);
  const others = summary.sections.filter((s) => !["current_symptom", "concern"].includes(s.section));
  const lang = summary.language ? (LANGUAGES[summary.language] ?? summary.language).split(" · ").pop() : null;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-7 py-5">
        <Label>Pre-visit summary</Label>
        <span className="text-sm text-muted">
          {summary.ended_at && new Date(summary.ended_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
          {lang ? ` · ${lang}` : ""} · {summary.mode === "ritu" ? "voice" : "typed"}
        </span>
      </div>

      {total === 0 ? (
        <p className="px-7 py-6 text-muted">The patient reported nothing in this conversation.</p>
      ) : (
        <>
          {urgentItems(summary).length > 0 && (
            <div className="border-b border-red-200 bg-red-50 px-7 py-4 text-[15px] text-red-800">
              <span className="font-semibold">Urgent signs reported: </span>
              {urgentItems(summary).map((f) => f.label).join("; ")}
            </div>
          )}
          <div className="space-y-2 border-b border-line/70 bg-[#fbfaf7] px-7 py-5 text-[15px]">
            {concerns.length > 0 && (
              <p>
                <span className="font-semibold">Wants to discuss: </span>
                {concerns.map((c) => c.label).join("; ")}
              </p>
            )}
            {worst && (
              <p>
                <span className="font-semibold">Worst symptom: </span>
                {worst.label}, {score(worst)}/10{worst.details.trend ? `, ${TREND[worst.details.trend]?.text ?? worst.details.trend}` : ""}
              </p>
            )}
            {treatment.length > 0 && (
              <p>
                <span className="font-semibold">Treatment: </span>
                {treatment.map((t) => [t.label, detailLine(t)].filter(Boolean).join(" · ")).join("; ")}
              </p>
            )}
            <p className="text-muted">
              {symptoms.length} symptom{symptoms.length === 1 ? "" : "s"} reported
              {section("medication").length ? ` · ${section("medication").length} medicine(s)` : ""}
              {section("allergy").length ? ` · allergies: ${section("allergy").map((a) => a.label).join(", ")}` : " · no allergies mentioned"}
            </p>
          </div>

          {symptoms.length > 0 && (
            <div className="px-7 py-5">
              <Label>Symptoms</Label>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[15px]">
                  <thead>
                    <tr className="text-xs uppercase tracking-wider text-muted">
                      <th className="py-2 pr-3 font-medium">Symptom</th>
                      <th className="py-2 pr-3 font-medium">Score</th>
                      <th className="py-2 pr-3 font-medium">Course</th>
                      <th className="py-2 pr-3 font-medium">Details</th>
                      <th className="py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {symptoms.map((f) => {
                      const s = score(f);
                      const trend = f.details.trend ? TREND[f.details.trend] ?? { text: f.details.trend, tone: "slate" as const } : null;
                      return (
                        <Fragment key={f.id}>
                          <tr className="align-top">
                            <td className="py-3 pr-3 font-semibold">{f.label}</td>
                            <td className="py-3 pr-3">
                              {s === null ? <span className="text-muted">—</span> : <Badge tone={s >= 7 ? "red" : s >= 4 ? "amber" : "slate"}>{s}/10</Badge>}
                            </td>
                            <td className="py-3 pr-3">{trend ? <Badge tone={trend.tone}>{trend.text}</Badge> : <span className="text-muted">—</span>}</td>
                            <td className="py-3 pr-3 text-ink/80">{detailLine(f) || <span className="text-muted">—</span>}</td>
                            <td className="py-3 text-right">
                              <QuoteToggle open={open.has(f.id)} onClick={() => toggle(f.id)} count={f.evidence?.length ?? 1} />
                            </td>
                          </tr>
                          {open.has(f.id) && (
                            <tr>
                              <td colSpan={5} className="pb-4">
                                <div className="rounded-xl bg-brand-soft/50 px-4 py-3">
                                  <Evidence f={f} onTurn={onTurn} />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {others.filter((s) => s.facts.length).map((s) => (
            <div key={s.section} className="border-t border-line/60 px-7 py-5">
              <Label>{s.label}</Label>
              <ul className="mt-3 space-y-2.5">
                {s.facts.map((f) => (
                  <li key={f.id}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[15px]">
                        <span className="font-semibold">{f.label}</span>
                        {detailLine(f) && <span className="text-ink/75"> · {detailLine(f)}</span>}
                      </p>
                      <QuoteToggle open={open.has(f.id)} onClick={() => toggle(f.id)} count={f.evidence?.length ?? 1} />
                    </div>
                    {open.has(f.id) && (
                      <div className="mt-2 rounded-xl bg-brand-soft/50 px-4 py-3">
                        <Evidence f={f} onTurn={onTurn} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      <p className="border-t border-line/60 px-7 py-4 text-xs text-muted">
        Patient-reported, organised from their own words; quotes on each line. Not verified, nothing interpreted. Synthetic demo persona.
      </p>
    </Card>
  );
}
