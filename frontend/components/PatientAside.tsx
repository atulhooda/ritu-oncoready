import { CheckCircle2 } from "lucide-react";
import Link from "next/link";

import { Card, Label } from "@/components/ui";
import type { PatientProfile } from "@/lib/types";

/** Right-hand progress card shared by the four patient pages. */
export function PatientAside({ profile }: { profile: PatientProfile }) {
  const d = profile.details;
  const steps = [
    { href: "/patient", label: "Profile filled in", ok: !!(d.date_of_birth && d.sex && d.cancer_type) },
    { href: "/patient/session", label: "Talked to Ritu", ok: !!profile.summary },
    { href: "/patient/records", label: `Records added (${profile.records.length})`, ok: profile.records.length > 0 },
    { href: "/patient/send", label: "Sent to doctor", ok: !!profile.published_at },
  ];
  return (
    <aside className="space-y-6">
      <Card className="p-6">
        <Label>Progress</Label>
        <ul className="mt-5 space-y-3 text-[16px]">
          {steps.map((s, i) => (
            <li key={s.href}>
              <Link href={s.href} className="flex items-center justify-between gap-3 hover:text-brand">
                <span className={s.ok ? "" : "text-muted"}>
                  {i + 1}. {s.label}
                </span>
                <CheckCircle2 size={20} className={s.ok ? "text-green-600" : "text-line"} />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-6">
        <Label>Good to know</Label>
        <p className="mt-4 text-[15px] text-ink/80">
          Ritu only collects information for your doctor. It does not diagnose or give medical advice. If you feel very unwell, contact emergency services.
        </p>
        <p className="mt-3 text-xs text-muted">Demo persona · synthetic data only.</p>
      </Card>
    </aside>
  );
}
