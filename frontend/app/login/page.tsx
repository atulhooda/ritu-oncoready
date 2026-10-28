"use client";

import { Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Eyebrow, Label } from "@/components/ui";
import { api, setToken } from "@/lib/api";
import { lastClinic } from "@/lib/clinic";
import type { Me } from "@/lib/types";
import { homeFor } from "@/lib/types";

const FIELDS = [
  { key: "org", label: "Organization", type: "text" },
  { key: "email", label: "Email", type: "email" },
  { key: "password", label: "Password", type: "password" },
] as const;

export default function LoginPage() {
  const router = useRouter();
  const [values, setValues] = useState({ org: "demo", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clinicCode, setClinicCode] = useState("");
  const [recent, setRecent] = useState<{ code: string; name: string } | null>(null);
  useEffect(() => setRecent(lastClinic()), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { access_token } = await api<{ access_token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ org_slug: values.org, email: values.email, password: values.password }),
      });
      setToken(access_token);
      const me = await api<Me>("/auth/me");
      router.replace(homeFor(me.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-paper lg:grid-cols-[1fr_1.1fr]">
      <section className="hidden flex-col justify-between bg-ink p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand font-extrabold">O</span>
          <span className="text-xl font-bold tracking-tight">OncoReady</span>
        </div>
        <div>
          <div className="font-mono text-xs uppercase tracking-[0.25em] text-white/50">Case readiness</div>
          <h2 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight">
            Read the chart.
            <br />
            Write the <span className="font-serif font-normal italic text-[#8e9bff]">brief.</span>
          </h2>
          <p className="mt-4 max-w-md text-white/60">
            Residents prepare on synthetic oncology cases; faculty see exactly what was caught and what was missed.
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/45">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" /> Synthetic cases · not for clinical use
        </div>
      </section>
      <section className="flex items-center justify-center px-4 py-12">
        <form onSubmit={submit} className="w-full max-w-md">
          <Eyebrow>Sign in</Eyebrow>
          <h1 className="mt-3 text-5xl font-extrabold tracking-tight">
            Welcome <span className="font-serif font-normal italic text-brand">back.</span>
          </h1>
          <div className="mt-8 space-y-5">
            {FIELDS.map((f) => (
              <label key={f.key} className="block">
                <Label className="mb-2">{f.label}</Label>
                <input
                  type={f.type}
                  value={values[f.key]}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="w-full rounded-xl border border-line bg-white px-4 py-3.5 text-lg outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
                  required
                />
              </label>
            ))}
          </div>
          {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
          <Button disabled={busy} className="mt-8 w-full py-3.5">
            {busy ? "Signing in…" : "Sign in"}
          </Button>

          <div className="mt-10 border-t border-line pt-8">
            <div className="flex items-center gap-2 font-semibold">
              <Smartphone size={18} className="text-brand" /> Patient? Use your phone
            </div>
            <p className="mt-1 text-sm text-muted">Patients sign in with their mobile number at their clinic. No password.</p>
            {recent && (
              <Link
                href={`/join/${recent.code}`}
                className="mt-4 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3 text-[15px] font-medium hover:border-brand/50"
              >
                <span>Continue at {recent.name}</span>
                <span className="text-brand">→</span>
              </Link>
            )}
            <div className="mt-3 flex gap-2">
              <input
                id="clinic-code"
                value={clinicCode}
                onChange={(e) => setClinicCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="Clinic code, e.g. CCC"
                aria-label="Clinic code"
                className="min-w-0 flex-1 rounded-xl border border-line bg-white px-4 py-3 font-mono uppercase tracking-wider outline-none focus:border-brand"
              />
              <button
                type="button"
                disabled={clinicCode.length < 3}
                onClick={() => router.push(`/join/${clinicCode}`)}
                className="rounded-xl border border-line bg-white px-4 font-semibold hover:border-ink/30 disabled:opacity-40"
              >
                Go
              </button>
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}
