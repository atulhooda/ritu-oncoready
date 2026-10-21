import { FileUp, Send } from "lucide-react";
import Link from "next/link";

import { Badge, Card, Label } from "@/components/ui";
import type { PatientProfile } from "@/lib/types";

/** Records Ritu heard the patient mention, as short labels. */
export function mentionedRecords(profile: PatientProfile): string[] {
  return profile.summary?.sections.find((s) => s.section === "previous_record")?.facts.map((f) => f.label) ?? [];
}

const linkButton = "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[15px] font-semibold transition";
const primary = `${linkButton} bg-brand text-white shadow-[0_6px_16px_-6px_rgba(58,79,224,0.7)] hover:bg-brand-hover`;
const secondary = `${linkButton} border border-line bg-white text-ink hover:border-ink/30`;

/** After a session: upload the records Ritu heard about, or go straight to sending. */
export function NextStepCard({ profile }: { profile: PatientProfile }) {
  if (!profile.summary) return null;
  const mentioned = mentionedRecords(profile);
  const uploaded = profile.records.length;

  if (profile.published_at) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-4 p-7">
        <div>
          <Label>All set</Label>
          <p className="mt-2 text-lg font-semibold">Sent to your doctor.</p>
          <p className="text-muted">New records you add are shared automatically.</p>
        </div>
        <Link href="/patient/records" className={secondary}>
          <FileUp size={17} /> Add records
        </Link>
      </Card>
    );
  }

  return (
    <Card className="border-brand/30 p-7 shadow-[0_10px_30px_-18px_rgba(58,79,224,0.6)]">
      <Label>Next step</Label>
      {mentioned.length > 0 ? (
        <>
          <p className="mt-2 text-lg font-semibold">Upload the records you told Ritu about</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {mentioned.map((m) => (
              <Badge key={m} tone="blue">{m}</Badge>
            ))}
          </div>
          <p className="mt-3 text-muted">Photos from your phone or PDFs both work.{uploaded ? ` You have uploaded ${uploaded} so far.` : ""}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/patient/records" className={primary}>
              <FileUp size={17} /> Upload records
            </Link>
            <Link href="/patient/send" className={secondary}>
              <Send size={17} /> {uploaded ? "Send to doctor" : "Skip for now, send to doctor"}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-lg font-semibold">No earlier records? That is fine.</p>
          <p className="mt-1 text-muted">You can send what you told Ritu to your doctor now, and add records later if you find any.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/patient/send" className={primary}>
              <Send size={17} /> Send to doctor
            </Link>
            <Link href="/patient/records" className={secondary}>
              <FileUp size={17} /> I do have some records
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}
