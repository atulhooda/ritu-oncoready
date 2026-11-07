import type { SymptomCourse as Course } from "@/lib/types";

type Cell = Course["rows"][number]["cells"][number];

const TREND: Record<string, { mark: string; word: string; tone: string }> = {
  worsening: { mark: "↑", word: "worse", tone: "text-red-700" },
  improving: { mark: "↓", word: "better", tone: "text-green-700" },
  same: { mark: "→", word: "same", tone: "text-ink/60" },
  resolved: { mark: "✓", word: "gone", tone: "text-green-700" },
};

function CellView({ c }: { c: Cell }) {
  if (!c) return <span className="text-ink/25">—</span>;
  const t = c.trend ? TREND[c.trend] : null;
  return (
    <span className={`whitespace-nowrap ${c.urgent ? "font-semibold text-red-700" : ""}`}>
      {c.score !== null ? `${c.score}/10` : c.trend === "resolved" ? "gone" : c.severity || "reported"}
      {t && (
        <span className={`ml-1 ${t.tone}`} title={t.word}>
          {t.mark}
        </span>
      )}
    </span>
  );
}

/** Each symptom across conversations, oldest to newest, in the patient's own ratings.
 *  A dash means it was not mentioned that time (not that it has gone). */
export function SymptomCourse({
  course,
  onSelect,
  selected,
}: {
  course: Course;
  onSelect?: (sessionId: string) => void;
  selected?: string | null;
}) {
  if (!course.rows.length) return <p className="text-[15px] text-muted">No symptoms reported yet.</p>;
  const date = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");
  return (
    <div>
      <div className="relative">
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[420px] border-collapse text-[14px] sm:text-[15px]">
            <thead>
              <tr className="border-b border-ink/15 text-left align-bottom">
                <th className="sticky left-0 z-10 bg-white py-2 pr-4 font-semibold">Symptom</th>
                {course.sessions.map((s) => {
                  const head = (
                    <>
                      <span className="block text-sm font-semibold">{date(s.ended_at)}</span>
                      <span className="block text-[11px] uppercase tracking-wide text-muted">{s.kind === "check_in" ? "Check-in" : "Visit"}</span>
                    </>
                  );
                  return (
                    <th key={s.session_id} className={`px-2 py-2 text-center font-normal ${s.session_id === selected ? "bg-brand-soft/60" : ""}`}>
                      {onSelect ? (
                        <button onClick={() => onSelect(s.session_id)} className="hover:text-brand">
                          {head}
                        </button>
                      ) : (
                        head
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {course.rows.map((r) => (
                <tr key={r.label} className="border-b border-line/70 last:border-0">
                  <td className={`sticky left-0 z-10 min-w-[8.5rem] max-w-[10rem] bg-white py-2.5 pr-4 shadow-[1px_0_0_var(--color-line)] sm:max-w-none ${r.urgent ? "font-semibold text-red-700" : "font-medium"}`}>{r.label}</td>
                  {r.cells.map((c, i) => (
                    <td key={i} className={`px-2 py-2.5 text-center tabular-nums ${course.sessions[i].session_id === selected ? "bg-brand-soft/60" : ""}`}>
                      <CellView c={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white sm:hidden" />
      </div>
      <p className="mt-2 text-xs text-muted sm:hidden">Swipe for more dates →</p>
      <p className="mt-3 text-xs text-muted">
        Scores are 0–10 ratings as told to Ritu. ↑ worse · ↓ better · → same · ✓ gone, as the patient said. A dash means it was not mentioned that time.
      </p>
    </div>
  );
}
