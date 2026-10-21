"use client";

import Link from "next/link";

import { RecordsUploader } from "@/components/patient/RecordsUploader";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Card, PageHeader } from "@/components/ui";

export default function RecordsPage() {
  const { me, profile, reload } = usePatient();
  return (
    <Shell me={me}>
      {profile && (
        <div className="mx-auto max-w-4xl">
          <PageHeader
            size="sm"
            eyebrow="My records"
            title="Your records"
            subtitle={
              profile.published_at
                ? "Anything you add here is shared with your care team automatically."
                : "Reports, scans and prescriptions. They are shared with your care team when you send your check-in."
            }
          />
          <Card className="p-6 sm:p-8">
            <RecordsUploader profile={profile} onChange={reload} />
          </Card>
          {!profile.published_at && (
            <p className="mt-4 text-sm text-muted">
              Done adding?{" "}
              <Link href="/patient?step=review" className="font-medium text-brand hover:underline">
                Review and send your check-in →
              </Link>
            </p>
          )}
        </div>
      )}
    </Shell>
  );
}
