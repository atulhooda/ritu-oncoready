import type { IntakeFact, LabSeries, Medicine, PatientDetails } from "@/lib/types";
import { SEX_LABELS, TREATMENT_LABELS } from "@/lib/types";

/** The opening paragraph of the senior's summary, built in code from what the patient said and
 *  what the records state. Templates only: no interpretation, no causes, no advice. */
export function narrative({ name, details: d, facts, labs, medicines }: {
  name: string;
  details: PatientDetails;
  facts: (IntakeFact & { section: string })[];
  labs: LabSeries[];
  medicines: Medicine[];
}): string[] {
  const out: string[] = [];
  const said = (s: string | null) => (s && !/^(none|no|nil|na|n\/a|-)\.?$/i.test(s.trim()) ? s : null);
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const detail = (f: IntakeFact) => Object.values(f.details).filter(Boolean).join(", ");
  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const day = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const who = [d.age !== null ? `${d.age}-year-old` : null, d.sex && d.sex !== "prefer_not_to_say" ? SEX_LABELS[d.sex].toLowerCase() : null].filter(Boolean).join(" ");
  const found = d.diagnosed_on ? new Date(d.diagnosed_on).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : null;
  out.push(
    `${name}${who ? `, ${who},` : ""} reports ${d.cancer_type ? lower(d.cancer_type) : "a cancer diagnosis"}` +
      `${d.stage_reported ? ` (stage as told: ${d.stage_reported})` : ""}${found ? `, found in ${found}` : ""}` +
      `${d.treatment_status ? `; treatment: ${TREATMENT_LABELS[d.treatment_status].toLowerCase()}` : ""}` +
      `${d.current_treatment ? ` (${d.current_treatment})` : ""}.` +
      `${d.location ? ` Lives in ${d.location}.` : ""}${said(d.other_conditions) ? ` Other conditions: ${d.other_conditions}.` : ""}`,
  );

  const of = (section: string) => facts.filter((f) => f.section === section);
  const symptoms = of("current_symptom").map((f) => `${lower(f.label)}${detail(f) ? ` (${detail(f)})` : ""}`);
  if (symptoms.length) out.push(`Current symptoms: ${list(symptoms)}.`);
  const urgent = facts.filter((f) => f.urgent).map((f) => lower(f.label));
  if (urgent.length) out.push(`On the urgent-signs list: ${list(urgent)}.`);
  const family = of("family_history").map((f) => `${lower(f.label)}${detail(f) ? ` (${detail(f)})` : ""}`);
  if (family.length) out.push(`Family history of cancer: ${list(family)}.`);
  const exposure = of("exposure").map((f) => `${lower(f.label)}${detail(f) ? ` (${detail(f)})` : ""}`);
  if (exposure.length) out.push(`Exposures: ${list(exposure)}.`);
  const meds = [...of("treatment"), ...of("medication")].map((f) => lower(f.label));
  if (meds.length) out.push(`Treatment and medicines as told: ${list(meds)}.`);

  const labText = labs.slice(0, 4).map((l) => {
    const [a, b] = [l.points[0], l.points[l.points.length - 1]];
    const u = l.unit ?? "";
    return l.points.length > 1 ? `${l.label} ${a.value}${u} (${day(a.date)}) to ${b.value}${u} (${day(b.date)})` : `${l.label} ${a.value}${u} (${day(a.date)})`;
  });
  if (labText.length) out.push(`In the records: ${list(labText)}.`);
  const medText = medicines.map((m) => {
    const e = m.latest;
    return e ? `${m.drug} ${e.dose} ${e.unit ?? ""}${e.frequency ? ` ${e.frequency}` : ""}${e.date ? ` (latest ${day(e.date)})` : ""}`.replace(/\s+/g, " ").trim() : m.drug;
  });
  if (medText.length) out.push(`Medicines in the records: ${list(medText)}.`);
  return out;
}
