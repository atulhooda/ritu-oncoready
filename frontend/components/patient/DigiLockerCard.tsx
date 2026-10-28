"use client";

import { BadgeCheck, Download, FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { DigiLockerDocument, PatientProfile, VerifiedIdentity } from "@/lib/types";

const GENDER: Record<string, string> = { M: "Male", F: "Female", T: "Transgender" };

export function IdentityBadge({ identity }: { identity: VerifiedIdentity }) {
  return identity.verified_via === "digilocker" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800 ring-1 ring-green-600/30">
      <BadgeCheck size={13} /> Verified with DigiLocker
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-600/30">
      DigiLocker demo · not a real check
    </span>
  );
}

/** Verify identity with DigiLocker, then copy documents from it into "My records". */
export function DigiLockerCard({ profile, onChange }: { profile: PatientProfile; onChange: () => Promise<void> | void }) {
  const identity = profile.details.identity;
  const [docs, setDocs] = useState<DigiLockerDocument[] | null>(null);
  const [docsNote, setDocsNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDocs = useCallback(() => {
    api<{ documents: DigiLockerDocument[] }>("/me/digilocker/documents")
      .then((r) => {
        setDocs(r.documents);
        setDocsNote(null);
      })
      .catch((e) => {
        setDocs(null);
        setDocsNote(e instanceof Error ? e.message : null);
      });
  }, []);

  useEffect(() => {
    if (identity) loadDocs();
  }, [identity, loadDocs]);

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      const r = await api<{ authorize_url: string }>("/me/digilocker/start", { method: "POST" });
      window.location.assign(r.authorize_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach DigiLocker");
      setBusy(null);
    }
  }

  async function importDoc(uri: string) {
    setBusy(uri);
    setError(null);
    try {
      await api("/me/digilocker/import", { method: "POST", body: JSON.stringify({ uri }) });
      setDocs((d) => d?.map((x) => (x.uri === uri ? { ...x, imported: true } : x)) ?? null);
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-6 sm:p-8">
      <Label>DigiLocker</Label>
      {!identity ? (
        <div className="mt-2 space-y-4">
          <p className="max-w-xl text-[15px] text-ink/80">
            Verify your name, date of birth and sex with DigiLocker, and bring in reports saved there. You sign in on DigiLocker&apos;s own page.
          </p>
          <Button onClick={connect} disabled={busy === "connect"}>
            {busy === "connect" ? "Opening DigiLocker…" : "Verify with DigiLocker"}
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-5">
          <dl className="grid gap-x-8 gap-y-2 text-[15px] sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted">Name</dt>
            <dd className="font-medium">{identity.name ?? "—"}</dd>
            <dt className="text-muted">Date of birth</dt>
            <dd className="font-medium">{identity.dob ? new Date(identity.dob + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "—"}</dd>
            <dt className="text-muted">Sex</dt>
            <dd className="font-medium">{identity.gender ? GENDER[identity.gender] : "—"}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <IdentityBadge identity={identity} />
            <span className="text-xs text-muted">
              Verified {new Date(identity.verified_at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}
            </span>
          </div>

          <div className="border-t border-line pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">Documents in your DigiLocker</h3>
              {!docs && (
                <button onClick={connect} className="text-sm font-medium text-brand hover:underline">
                  Connect again to import
                </button>
              )}
            </div>
            {docs ? (
              docs.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No documents found in your DigiLocker.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
                  {docs.map((d) => (
                    <li key={d.uri} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <FileText size={18} className="shrink-0 text-muted" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{d.name}</div>
                          <div className="truncate text-xs text-muted">
                            {[d.issuer, d.date].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </div>
                      {d.imported ? (
                        <span className="text-sm font-medium text-green-700">In your records</span>
                      ) : (
                        <button
                          onClick={() => importDoc(d.uri)}
                          disabled={busy !== null}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-ink/30 disabled:opacity-50"
                        >
                          <Download size={14} /> {busy === d.uri ? "Importing…" : "Add to my records"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <p className="mt-2 text-sm text-muted">{docsNote ?? "Loading…"}</p>
            )}
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Card>
  );
}
