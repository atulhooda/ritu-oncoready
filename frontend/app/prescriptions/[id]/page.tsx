"use client";

import { Printer } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { PrescriptionView } from "@/components/scribe/PrescriptionView";
import { useMe } from "@/components/useMe";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import type { Prescription } from "@/lib/types";

/** One approved prescription on its own page, for printing or saving as PDF (doctors and the patient). */
export default function PrescriptionPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const [rx, setRx] = useState<Prescription | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (me) api<Prescription>(`/prescriptions/${id}`).then(setRx).catch((e) => setError(e.message));
  }, [me, id]);
  return (
    <main className="min-h-screen bg-paper px-4 py-8 print:bg-white print:p-0">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex justify-end print:hidden">
          <Button onClick={() => window.print()} disabled={!rx}>
            <Printer size={17} /> Print or save as PDF
          </Button>
        </div>
        {error && <p className="text-red-700">{error}</p>}
        {rx ? <PrescriptionView rx={rx} /> : !error && <p className="text-muted">Loading…</p>}
      </div>
    </main>
  );
}
