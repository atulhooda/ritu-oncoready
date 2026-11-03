import type { Prescription, RxText } from "@/lib/types";
import { SEX_LABELS } from "@/lib/types";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** The approved prescription as a document: the same on the doctor's side, the patient's side and
 *  when printed. Everything in it was approved by the doctor named at the bottom. */
export function PrescriptionView({ rx }: { rx: Prescription }) {
  const r = rx.report;
  const p = rx.patient;
  const list = (title: string, items: RxText[]) =>
    items.length > 0 && (
      <section className="mt-6">
        <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-ink/60">{title}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px]">
          {items.map((t, i) => (
            <li key={i}>{t.text}</li>
          ))}
        </ul>
      </section>
    );
  return (
    <article className="rx-print rounded-2xl border border-line bg-white p-6 text-ink sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink pb-4">
        <div>
          <div className="text-2xl font-bold tracking-tight">{rx.clinic ?? "Clinic"}</div>
          <div className="text-sm text-muted">Prescription</div>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold">{day(rx.approved_at)}</div>
          <div className="font-mono text-xs text-muted">Rx {rx.id.slice(0, 8).toUpperCase()}</div>
        </div>
      </header>

      <div className="mt-4 grid gap-1 text-[15px] sm:grid-cols-2">
        <div>
          <span className="text-muted">Patient: </span>
          <span className="font-semibold">{p.name}</span>
        </div>
        <div className="sm:text-right">
          {[p.age !== null ? `${p.age} y` : null, p.sex ? SEX_LABELS[p.sex] : null, p.patient_number].filter(Boolean).join(" · ")}
        </div>
      </div>

      {list("Assessment (as said by the doctor)", r.assessment)}

      <section className="mt-6">
        <h3 className="text-2xl font-serif italic">Rx</h3>
        {r.medicines.length ? (
          <table className="mt-2 w-full border-collapse text-left text-[14.5px]">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink/60">
                <th className="py-2 pr-3 font-semibold">#</th>
                <th className="py-2 pr-3 font-semibold">Medicine</th>
                <th className="py-2 pr-3 font-semibold">Dose</th>
                <th className="py-2 pr-3 font-semibold">How often</th>
                <th className="py-2 pr-3 font-semibold">For</th>
                <th className="py-2 font-semibold">Instructions</th>
              </tr>
            </thead>
            <tbody>
              {r.medicines.map((m, i) => {
                const stopped = /^\s*(stop|hold|discontinue)/i.test(m.instructions ?? "");
                return (
                <tr key={i} className={`border-b border-line/60 align-top ${stopped ? "text-ink/60" : ""}`}>
                  <td className="py-2 pr-3 text-muted">{i + 1}</td>
                  <td className="py-2 pr-3 font-semibold">
                    <span className={stopped ? "line-through" : ""}>{m.name}</span>
                    {stopped && <span className="ml-2 rounded border border-red-300 px-1.5 py-px text-[11px] font-bold uppercase tracking-wide text-red-700">Stop / hold</span>}
                    {m.route && <span className="block text-xs font-normal text-muted">{m.route}</span>}
                  </td>
                  <td className="py-2 pr-3">{m.dose ?? "—"}</td>
                  <td className="py-2 pr-3">{m.frequency ?? "—"}</td>
                  <td className="py-2 pr-3">{m.duration ?? "—"}</td>
                  <td className="py-2">{m.instructions ?? ""}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-muted">No medicines prescribed.</p>
        )}
      </section>

      {list("Tests and referrals", r.tests)}
      {list("Advice", r.advice)}
      {list("Follow-up", r.follow_up)}
      {r.notes && (
        <section className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-ink/60">Notes</h3>
          <p className="mt-2 whitespace-pre-wrap text-[15px]">{r.notes}</p>
        </section>
      )}

      <footer className="mt-10 flex flex-wrap items-end justify-between gap-4 border-t border-line pt-4 text-sm">
        <p className="max-w-sm text-xs text-muted">
          Drafted from the recorded consultation and reviewed, edited and approved by the doctor. Pilot: synthetic / demo use only.
        </p>
        <div className="text-right">
          <div className="font-semibold">{r.prescriber?.name}</div>
          {r.prescriber?.qualification && <div>{r.prescriber.qualification}</div>}
          {r.prescriber?.registration_number && (
            <div className="text-muted">
              Reg. {r.prescriber.registration_number}
              {r.prescriber.medical_council ? `, ${r.prescriber.medical_council}` : ""}
            </div>
          )}
          <div className="mt-1 text-xs text-muted">Approved electronically, {day(rx.approved_at)}</div>
        </div>
      </footer>
    </article>
  );
}
