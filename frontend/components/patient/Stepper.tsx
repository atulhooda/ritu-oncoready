import { Check } from "lucide-react";

import { STEPS, type StepId } from "@/lib/patient";

/** Four-step progress. Desktop: labelled steps. Phone: "Step 2 of 4" + bar. Every step is clickable. */
export function Stepper({ current, done, onSelect }: { current: StepId; done: Record<StepId, boolean>; onSelect: (s: StepId) => void }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Check-in steps">
      <div className="sm:hidden">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-semibold">
            Step {idx + 1} of {STEPS.length} · {STEPS[idx].title}
          </span>
          <span className="text-muted">~{STEPS[idx].minutes} min</span>
        </div>
        <div className="mt-2 flex gap-1.5">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              aria-label={s.title}
              className={`h-1.5 flex-1 rounded-full ${done[s.id] ? "bg-green-600" : i === idx ? "bg-brand" : "bg-line"}`}
            />
          ))}
        </div>
      </div>
      <ol className="hidden items-center gap-2 sm:flex">
        {STEPS.map((s, i) => {
          const active = s.id === current;
          const ok = done[s.id];
          return (
            <li key={s.id} className="flex flex-1 items-center gap-2">
              <button
                onClick={() => onSelect(s.id)}
                aria-current={active ? "step" : undefined}
                className={`flex min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left transition ${active ? "bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-line" : "hover:bg-white/60"}`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    ok ? "bg-green-600 text-white" : active ? "bg-brand text-white" : "border border-line bg-white text-muted"
                  }`}
                >
                  {ok ? <Check size={16} strokeWidth={2.5} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={`block truncate text-[15px] font-semibold ${active ? "text-ink" : ok ? "text-ink/80" : "text-muted"}`}>{s.title}</span>
                  <span className="block text-xs text-muted">~{s.minutes} min</span>
                </span>
              </button>
              {i < STEPS.length - 1 && <span className={`h-px flex-1 ${ok ? "bg-green-600/50" : "bg-line"}`} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
