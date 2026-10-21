"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";

import { DetailsForm } from "@/components/patient/DetailsForm";
import { ReadyScreen } from "@/components/patient/ReadyScreen";
import { RecordsUploader } from "@/components/patient/RecordsUploader";
import { ReviewStep } from "@/components/patient/ReviewStep";
import { RituStep } from "@/components/patient/RituStep";
import { Stepper } from "@/components/patient/Stepper";
import { Shell } from "@/components/Shell";
import { usePatient } from "@/components/usePatient";
import { Button, Card, PageHeader } from "@/components/ui";
import { firstOpenStep, markNoRecords, STEPS, stepDone, type StepId } from "@/lib/patient";

const STEP_INTRO: Record<StepId, string> = {
  about: "A few details about you and your cancer, as you understand it.",
  ritu: "A short conversation with Ritu about how you are feeling and what records you have.",
  records: "Photos or PDFs of earlier reports, scans or prescriptions. Skip this if you have none.",
  review: "Check everything once, then send it to your care team.",
};

function readStepFromUrl(): StepId | null {
  if (typeof window === "undefined") return null;
  const s = new URLSearchParams(window.location.search).get("step");
  return STEPS.some((x) => x.id === s) ? (s as StepId) : null;
}

export default function CheckInPage() {
  const { me, profile, reload } = usePatient();
  const [step, setStep] = useState<StepId | null>(null);
  const [showReady, setShowReady] = useState(false);

  useEffect(() => {
    if (!profile || step) return;
    const fromUrl = readStepFromUrl();
    const open = firstOpenStep(profile);
    if (fromUrl) setStep(fromUrl);
    else if (!open) setShowReady(true);
    else setStep(open);
  }, [profile, step]);

  const go = (s: StepId) => {
    setShowReady(false);
    setStep(s);
    window.history.replaceState(null, "", `/patient?step=${s}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const next = () => {
    if (!step) return;
    const i = STEPS.findIndex((s) => s.id === step);
    if (i < STEPS.length - 1) go(STEPS[i + 1].id);
  };
  const back = () => {
    if (!step) return;
    const i = STEPS.findIndex((s) => s.id === step);
    if (i > 0) go(STEPS[i - 1].id);
  };

  const clinic = me?.org_name ?? "your clinic";
  const done = profile
    ? (Object.fromEntries(STEPS.map((s) => [s.id, stepDone(profile, s.id)])) as Record<StepId, boolean>)
    : ({ about: false, ritu: false, records: false, review: false } as Record<StepId, boolean>);

  // Once sent, the review step turns into the "ready" screen.
  useEffect(() => {
    if (profile?.published_at && step === "review") {
      setShowReady(true);
      window.history.replaceState(null, "", "/patient");
    }
  }, [profile?.published_at, step]);

  const total = STEPS.reduce((n, s) => n + s.minutes, 0);
  return (
    <Shell me={me}>
      {profile && (
        <div className="mx-auto max-w-4xl">
          <PageHeader
            size="sm"
            eyebrow={`Visit check-in · ${clinic}`}
            title={showReady ? "All done" : `Hello ${profile.name.split(" ")[0]}, let's get you ready for your visit`}
            subtitle={showReady ? undefined : `${STEPS.length} short steps · about ${total} minutes. You can stop and come back any time.`}
          />
          {showReady ? (
            <ReadyScreen profile={profile} clinic={clinic} onReview={() => go("review")} />
          ) : (
            step && (
              <>
                <Stepper current={step} done={done} onSelect={go} />
                <Card className="mt-6 p-6 sm:p-8">
                  <h2 className="text-2xl font-bold tracking-tight">{STEPS.find((s) => s.id === step)!.title}</h2>
                  <p className="mt-1 text-muted">{STEP_INTRO[step]}</p>
                  <div className="mt-7">
                    {step === "about" && (
                      <DetailsForm
                        key={profile.case_id}
                        profile={profile}
                        requiredHint
                        submitLabel="Save and continue"
                        onSaved={async () => {
                          await reload();
                          next();
                        }}
                      />
                    )}
                    {step === "ritu" && <RituStep profile={profile} clinic={clinic} reload={reload} />}
                    {step === "records" && <RecordsUploader profile={profile} onChange={reload} />}
                    {step === "review" && <ReviewStep profile={profile} clinic={clinic} reload={reload} goTo={go} />}
                  </div>
                </Card>
                {step !== "about" && step !== "review" && (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                    <Button variant="secondary" onClick={back}>
                      <ArrowLeft size={17} /> Back
                    </Button>
                    {step === "ritu" && (
                      <Button onClick={next} disabled={!profile.summary}>
                        Continue <ArrowRight size={17} />
                      </Button>
                    )}
                    {step === "records" && (
                      <div className="flex flex-wrap gap-3">
                        {profile.records.length === 0 && (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              markNoRecords(profile.case_id, true);
                              next();
                            }}
                          >
                            I don&apos;t have any records
                          </Button>
                        )}
                        <Button onClick={next} disabled={profile.records.length === 0}>
                          Continue <ArrowRight size={17} />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {step === "review" && (
                  <div className="mt-5">
                    <Button variant="secondary" onClick={back}>
                      <ArrowLeft size={17} /> Back
                    </Button>
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}
    </Shell>
  );
}
