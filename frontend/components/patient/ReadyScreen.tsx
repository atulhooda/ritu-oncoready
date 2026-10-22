import { CheckCircle2, FileUp, HeartPulse, Mic, PencilLine } from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui";
import type { PatientProfile } from "@/lib/types";

export function ReadyScreen({
  profile,
  clinic,
  onReview,
  onNewSession,
}: {
  profile: PatientProfile;
  clinic: string;
  onReview: () => void;
  onNewSession: () => void;
}) {
  const n = profile.records.length;
  return (
    <Card className="p-8 sm:p-10">
      <CheckCircle2 size={44} className="text-green-600" strokeWidth={1.6} />
      <h2 className="mt-5 text-3xl font-bold tracking-tight">You&apos;re ready for your visit.</h2>
      <p className="mt-2 max-w-xl text-[17px] text-ink/80">
        Your care team at {clinic} has your details, what you told Ritu{n ? `, and ${n} record${n === 1 ? "" : "s"}` : ""}.
        {profile.published_at && ` Sent ${new Date(profile.published_at).toLocaleDateString([], { day: "numeric", month: "long" })}.`}
      </p>
      <div className="mt-8">
        <h3 className="text-sm font-semibold">What happens next</h3>
        <ol className="mt-3 space-y-2 text-[15px] text-ink/80">
          <li>1. Your doctor reviews this before you arrive, so the visit can start with what matters to you.</li>
          <li>2. Found another report? Add it any time; it is shared automatically.</li>
          <li>3. Until then, do a quick check-in with Ritu every few days so your care team can see how you are doing.</li>
        </ol>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/patient/diary" className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-[15px] font-semibold text-white hover:bg-brand/90">
          <HeartPulse size={17} /> Check in with Ritu
        </Link>
        <button onClick={onNewSession} className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-5 py-3 text-[15px] font-semibold hover:border-ink/30">
          <Mic size={17} /> Start a new session
        </button>
        <Link href="/patient/records" className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-5 py-3 text-[15px] font-semibold hover:border-ink/30">
          <FileUp size={17} /> Add records
        </Link>
        <button onClick={onReview} className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-5 py-3 text-[15px] font-semibold hover:border-ink/30">
          <PencilLine size={17} /> Review or update
        </button>
      </div>
    </Card>
  );
}
