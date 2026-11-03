"use client";

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { Field, TextInput } from "@/components/Field";
import { Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";
import type { PatientProfile } from "@/lib/types";

/** The patient's account: name and email (their login), phone, OncoReady ID, and password. */
export function AccountCard({ profile, onChange }: { profile: PatientProfile; onChange: () => Promise<void> | void }) {
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; where: "account" | "password" } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(where: "account" | "password", fn: () => Promise<void>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: done, where });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save", where });
    } finally {
      setBusy(false);
    }
  }

  const saveAccount = (e: React.FormEvent) => {
    e.preventDefault();
    run("account", async () => {
      await api("/me/account", { method: "PUT", body: JSON.stringify({ full_name: name, email }) });
      await onChange();
    }, "Saved.");
  };

  const savePassword = (e: React.FormEvent) => {
    e.preventDefault();
    run("password", async () => {
      await api("/me/password", { method: "PUT", body: JSON.stringify({ current_password: current, new_password: next }) });
      setCurrent("");
      setNext("");
    }, "Password changed.");
  };

  const note = (where: "account" | "password") =>
    msg?.where === where && <span className={`text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>;

  return (
    <Card className="p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Label>Your account</Label>
        {profile.patient_number && (
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-muted">OncoReady ID</div>
            <div className="font-mono text-xl font-semibold tracking-wider">{profile.patient_number}</div>
          </div>
        )}
      </div>

      <form onSubmit={saveAccount} className="mt-5 space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Full name">
            <TextInput id="account-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </Field>
          <Field label="Email" hint="You log in with this email">
            <TextInput id="account-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
        </div>
        {profile.phone && (
          <p className="flex flex-wrap items-center gap-2 text-[15px]">
            <span className="text-muted">Mobile (WhatsApp):</span> <span className="font-medium">{profile.phone}</span>
            {profile.phone_verified ? (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-green-700">
                <CheckCircle2 size={15} /> verified
              </span>
            ) : (
              <span className="text-sm text-muted">not verified</span>
            )}
          </p>
        )}
        <div className="flex items-center gap-4">
          <Button disabled={busy}>Save</Button>
          {note("account")}
        </div>
      </form>

      <form onSubmit={savePassword} className="mt-8 space-y-5 border-t border-line pt-6">
        <h3 className="font-semibold">Change password</h3>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Current password">
            <TextInput id="current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <TextInput id="new-password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
          </Field>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="secondary" disabled={busy || next.length < 8}>
            Change password
          </Button>
          {note("password")}
        </div>
      </form>
    </Card>
  );
}
