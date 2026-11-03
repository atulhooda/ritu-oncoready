"use client";

import { AbhaCard } from "@/components/patient/AbhaCard";
import { DetailsForm } from "@/components/patient/DetailsForm";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Card, Label, PageHeader } from "@/components/ui";

export default function ProfilePage() {
  const { me, profile, reload } = usePatient();
  return (
    <Shell me={me}>
      {profile && (
        <div className="mx-auto max-w-4xl space-y-6">
          <PageHeader size="sm" eyebrow="Profile" title="Your details" subtitle="Your care team sees these after you send your check-in." />
          {profile.patient_number && (
            <Card className="flex flex-wrap items-center justify-between gap-4 p-6 sm:p-8">
              <div>
                <Label>Your OncoReady ID</Label>
                <div className="mt-2 font-mono text-3xl font-semibold tracking-wider">{profile.patient_number}</div>
                <p className="mt-1 text-sm text-muted">Give this ID at the clinic so they can find your record. Signed in with {profile.phone}.</p>
              </div>
            </Card>
          )}
          <AbhaCard profile={profile} onChange={reload} />
          <Card className="p-6 sm:p-8">
            <DetailsForm key={profile.case_id} profile={profile} onSaved={reload} submitLabel="Save changes" />
          </Card>
          {profile.details.updated_at && (
            <p className="-mt-3 text-sm text-muted">Last saved {new Date(profile.details.updated_at).toLocaleString()}</p>
          )}
        </div>
      )}
    </Shell>
  );
}
