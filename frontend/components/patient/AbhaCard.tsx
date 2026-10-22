"use client";

import { BadgeCheck, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Field, TextInput } from "@/components/Field";
import { Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { AbhaLink, PatientProfile } from "@/lib/types";
import { formatId14 } from "@/lib/types";


export function AbhaStatus({ abha }: { abha: AbhaLink }) {
  return abha.verified_via === "abdm_sandbox" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800 ring-1 ring-green-600/30">
      <BadgeCheck size={13} /> Verified with ABDM (sandbox)
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-600/30">
      Demo link · not verified with ABDM
    </span>
  );
}

/** Link the patient's ABHA (Ayushman Bharat Health Account) with an OTP to the mobile linked to it. */
export function AbhaCard({ profile, onChange }: { profile: PatientProfile; onChange: () => Promise<void> | void }) {
  const abha = profile.details.abha;
  const [number, setNumber] = useState("");
  const [txn, setTxn] = useState<{ txn_id: string; demo_otp: string | null } | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  const sendOtp = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => setTxn(await api("/me/abha/otp", { method: "POST", body: JSON.stringify({ abha_number: number }) })));
  };
  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api("/me/abha/verify", { method: "POST", body: JSON.stringify({ abha_number: number, txn_id: txn!.txn_id, otp }) });
      setTxn(null);
      setNumber("");
      setOtp("");
      await onChange();
    });
  };
  const unlink = () =>
    run(async () => {
      await api("/me/abha", { method: "DELETE" });
      await onChange();
    });

  return (
    <Card className="p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Label>Health ID (ABHA)</Label>
          <p className="mt-2 max-w-xl text-[15px] text-ink/80">
            Link your Ayushman Bharat Health Account so your care team knows this profile is yours.
          </p>
        </div>
        <ShieldCheck size={28} className="hidden shrink-0 text-brand sm:block" strokeWidth={1.6} />
      </div>

      {abha ? (
        <div className="mt-5 space-y-3">
          <dl className="grid gap-x-8 gap-y-2 text-[15px] sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted">ABHA number</dt>
            <dd className="font-medium tabular-nums">{abha.number}</dd>
            {abha.address && (
              <>
                <dt className="text-muted">ABHA address</dt>
                <dd className="font-medium">{abha.address}</dd>
              </>
            )}
            {abha.name && (
              <>
                <dt className="text-muted">Name on ABHA</dt>
                <dd className="font-medium">{abha.name}</dd>
              </>
            )}
            <dt className="text-muted">Linked</dt>
            <dd>{new Date(abha.verified_at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <AbhaStatus abha={abha} />
            <button onClick={unlink} disabled={busy} className="text-sm font-medium text-muted hover:text-red-700">
              Unlink
            </button>
          </div>
          <p className="text-xs text-muted">We keep only the last four digits of your ABHA number.</p>
        </div>
      ) : txn ? (
        <form onSubmit={verify} className="mt-5 space-y-4">
          <p className="text-[15px]">
            We sent an OTP to the mobile number linked with ABHA <span className="font-semibold tabular-nums">{number}</span>.
          </p>
          {txn.demo_otp && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Demo mode (ABDM sandbox not connected): no SMS is sent. Use OTP <span className="font-mono font-semibold">{txn.demo_otp}</span>.
            </p>
          )}
          <Field label="OTP">
            <TextInput inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} autoFocus />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy || otp.length < 4}>
              Verify and link
            </Button>
            <Button type="button" variant="secondary" onClick={() => setTxn(null)}>
              Change number
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={sendOtp} className="mt-5 space-y-4">
          <Field label="ABHA number" hint="14 digits, on your ABHA card or in the ABHA app.">
            <TextInput inputMode="numeric" placeholder="91-1234-5678-9012" value={number} onChange={(e) => setNumber(formatId14(e.target.value))} />
          </Field>
          <Button type="submit" disabled={busy || number.replace(/\D/g, "").length !== 14}>
            Send OTP
          </Button>
          {profile.abha_mode === "demo" && (
            <p className="text-xs text-muted">Demo: ABDM sandbox is not connected yet, so any 14-digit number works and nothing is checked.</p>
          )}
        </form>
      )}
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
    </Card>
  );
}
