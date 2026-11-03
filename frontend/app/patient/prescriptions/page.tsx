"use client";

import { Printer } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { PrescriptionView } from "@/components/scribe/PrescriptionView";
import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { EmptyState, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { Prescription } from "@/lib/types";

export default function PatientPrescriptions() {
  const me = useMe(["patient"]);
  const [list, setList] = useState<Prescription[] | null>(null);
  useEffect(() => {
    if (me) api<Prescription[]>("/me/prescriptions").then(setList).catch(() => setList([]));
  }, [me]);
  return (
    <Shell me={me}>
      <div className="mx-auto max-w-4xl">
        <PageHeader size="sm" eyebrow="Prescriptions" title="Your prescriptions" subtitle="Approved by your doctor after your consultation." />
        {list && list.length === 0 && <EmptyState title="No prescriptions yet.">After your consultation, the prescription your doctor approves appears here.</EmptyState>}
        <div className="space-y-8">
          {list?.map((rx) => (
            <div key={rx.id}>
              <div className="mb-2 flex justify-end">
                <Link href={`/prescriptions/${rx.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline">
                  <Printer size={15} /> Print or save
                </Link>
              </div>
              <PrescriptionView rx={rx} />
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
