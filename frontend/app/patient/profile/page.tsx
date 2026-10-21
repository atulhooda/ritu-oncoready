"use client";

import { DetailsForm } from "@/components/patient/DetailsForm";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Card, PageHeader } from "@/components/ui";

export default function ProfilePage() {
  const { me, profile, reload } = usePatient();
  return (
    <Shell me={me}>
      {profile && (
        <div className="mx-auto max-w-4xl">
          <PageHeader size="sm" eyebrow="Profile" title="Your details" subtitle={`${profile.email} · your care team sees these after you send your check-in.`} />
          <Card className="p-6 sm:p-8">
            <DetailsForm key={profile.case_id} profile={profile} onSaved={reload} submitLabel="Save changes" />
          </Card>
          {profile.details.updated_at && (
            <p className="mt-3 text-sm text-muted">Last saved {new Date(profile.details.updated_at).toLocaleString()}</p>
          )}
        </div>
      )}
    </Shell>
  );
}
