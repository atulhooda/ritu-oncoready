"use client";

import { useState } from "react";

import type { LabSeries, Medicine, SourceRef, SymptomCourse } from "@/lib/types";

/** One measure over time. Every chart on a page shares the same date range, so changes in a lab
 *  value, a drug dose and a symptom score line up vertically (one axis per chart, never two). */
export type Series = {
  key: string;
  label: string;
  unit: string | null;
  kind: "lab" | "dose" | "symptom";
  points: { date: string; value: number; note?: string; source?: SourceRef }[];
};

const W = 320;
const H = 120;
const PAD = { l: 34, r: 14, t: 16, b: 22 };
const fmtDate = (d: string, withYear = false) =>
  new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const KIND_LABEL = { lab: "Lab / test", dose: "Dose", symptom: "Symptom score (0-10)" } as const;

export function TrendChart({ s, domain, onSource }: { s: Series; domain: [number, number]; onSource?: (src: SourceRef) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = s.points.map((p) => ({ ...p, t: new Date(p.date).getTime() }));
  const values = pts.map((p) => p.value);
  let lo = s.kind === "symptom" ? 0 : Math.min(...values);
  let hi = s.kind === "symptom" ? 10 : Math.max(...values);
  if (lo === hi) {
    lo -= Math.abs(lo) * 0.2 || 1;
    hi += Math.abs(hi) * 0.2 || 1;
  }
  const span = domain[1] - domain[0] || 1;
  const x = (t: number) => PAD.l + ((t - domain[0]) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const last = pts[pts.length - 1];
  const h = hover !== null ? pts[hover] : null;
  return (
    <figure className="rounded-xl border border-line/80 bg-white p-3">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[14px] font-semibold capitalize">{s.label}</span>
        <span className="shrink-0 text-xs text-muted">{s.unit ?? KIND_LABEL[s.kind]}</span>
      </figcaption>
      <div className="relative mt-1">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${s.label}: ${pts.map((p) => `${fmtNum(p.value)} on ${fmtDate(p.date, true)}`).join(", ")}`}>
          {[lo, hi].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-line" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="fill-muted text-[10px]">{fmtNum(v)}</text>
            </g>
          ))}
          <text x={PAD.l} y={H - 4} className="fill-muted text-[10px]">{fmtDate(new Date(domain[0]).toISOString().slice(0, 10), true)}</text>
          <text x={W - PAD.r} y={H - 4} textAnchor="end" className="fill-muted text-[10px]">{fmtDate(new Date(domain[1]).toISOString().slice(0, 10), true)}</text>
          {pts.length > 1 && (
            <polyline points={pts.map((p) => `${x(p.t)},${y(p.value)}`).join(" ")} fill="none" stroke="#3a4fe0" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          )}
          {h && <line x1={x(h.t)} x2={x(h.t)} y1={PAD.t} y2={H - PAD.b} stroke="#3a4fe0" strokeOpacity={0.3} strokeDasharray="3 3" />}
          {pts.map((p, i) => (
            <g key={i}>
              <circle cx={x(p.t)} cy={y(p.value)} r={4} fill="#3a4fe0" stroke="white" strokeWidth={2} />
              <circle
                cx={x(p.t)}
                cy={y(p.value)}
                r={12}
                fill="transparent"
                className={p.source && onSource ? "cursor-pointer" : ""}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => p.source && onSource?.(p.source)}
              />
            </g>
          ))}
          {last && hover === null && (
            <text
              x={x(last.t) > W - 60 ? x(last.t) - 8 : x(last.t) + 8}
              y={y(last.value) < PAD.t + 14 ? y(last.value) + 14 : y(last.value) - 8}
              textAnchor={x(last.t) > W - 60 ? "end" : "start"}
              className="fill-ink text-[11px] font-semibold"
            >
              {fmtNum(last.value)}
            </text>
          )}
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs text-white shadow-lg"
            style={{ left: `${(x(h.t) / W) * 100}%`, top: `${(y(h.value) / H) * 100}%` }}
          >
            <span className="font-semibold">
              {fmtNum(h.value)} {s.unit ?? ""}
            </span>{" "}
            · {fmtDate(h.date, true)}
            {h.note ? ` · ${h.note}` : ""}
            {h.source ? <span className="block text-white/60">{h.source.filename} p.{h.source.page_number}</span> : null}
          </div>
        )}
      </div>
    </figure>
  );
}

/** Lab values, drug doses and symptom scores as series (only those with a dated number). */
export function buildSeries(labs: LabSeries[], medicines: Medicine[], course: SymptomCourse | null): Series[] {
  const out: Series[] = labs.map((l) => ({ key: `lab:${l.key}`, label: l.label, unit: l.unit, kind: "lab", points: l.points.map((p) => ({ date: p.date, value: p.value, source: p.source, note: p.date_basis === "document" ? "date of the record" : undefined })) }));
  for (const m of medicines) {
    const dated = m.entries.filter((e) => e.date && e.dose !== null);
    const unit = dated[0]?.unit ?? null;
    const same = dated.filter((e) => e.unit === unit); // one unit per graph
    if (same.length)
      out.push({ key: `dose:${m.drug}`, label: `${m.drug} dose`, unit, kind: "dose", points: same.map((e) => ({ date: e.date!, value: e.dose!, note: [e.frequency, e.date_basis === "document" ? "date of the record" : null].filter(Boolean).join(" · ") || undefined, source: e.source })) });
  }
  for (const row of course?.rows ?? []) {
    const points = row.cells.flatMap((c, i) => {
      const at = course!.sessions[i]?.ended_at;
      return c && c.score !== null && at ? [{ date: at.slice(0, 10), value: c.score, note: c.trend ?? undefined }] : [];
    });
    if (points.length >= 2) out.push({ key: `symptom:${row.label}`, label: row.label, unit: "0-10", kind: "symptom", points });
  }
  return out;
}

/** Small multiples on one shared timeline, so a change in one measure can be read against the others. */
export function TrendsGrid({ series, onSource, cols = 2 }: { series: Series[]; onSource?: (src: SourceRef) => void; cols?: 1 | 2 | 3 }) {
  const times = series.flatMap((s) => s.points.map((p) => new Date(p.date).getTime()));
  if (!times.length) return null;
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const pad = Math.max((hi - lo) * 0.04, 86_400_000 * 3);
  const domain: [number, number] = [lo - pad, hi + pad];
  return (
    <div className={`grid gap-3 ${cols === 3 ? "sm:grid-cols-2 xl:grid-cols-3" : cols === 2 ? "sm:grid-cols-2" : ""}`}>
      {series.map((s) => (
        <TrendChart key={s.key} s={s} domain={domain} onSource={onSource} />
      ))}
    </div>
  );
}
