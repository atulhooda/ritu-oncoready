"use client";

import { Eye, EyeOff, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Eyebrow, Label } from "@/components/ui";
import { api, setToken } from "@/lib/api";
import type { Me } from "@/lib/types";
import { homeFor } from "@/lib/types";
import { Logo } from "@/components/Logo";

const FIELDS = [
  { key: "org", label: "Clinic code", type: "text" },
  { key: "email", label: "Email", type: "email" },
  { key: "password", label: "Password", type: "password" },
] as const;

export default function LoginPage() {
  const router = useRouter();
  const [values, setValues] = useState({ org: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { access_token } = await api<{ access_token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ org_slug: values.org.trim().toLowerCase(), email: values.email.trim(), password: values.password }),
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
          <Logo />
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
          <Eyebrow>Doctors &amp; hospitals</Eyebrow>
          <h1 className="mt-3 text-5xl font-extrabold tracking-tight">
            Welcome <span className="font-serif font-normal italic text-brand">back.</span>
          </h1>
          <div className="mt-8 space-y-5">
            {FIELDS.map((f) => (
              <label key={f.key} className="block">
                <Label className="mb-2">{f.label}</Label>
                <span className="relative block">
                  <input
                    id={`login-${f.key}`}
                    type={f.type === "password" && showPassword ? "text" : f.type}
                    autoComplete={f.type === "password" ? "current-password" : f.type === "email" ? "username" : "organization"}
                    value={values[f.key]}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    className={`w-full rounded-xl border border-line bg-white px-4 py-3.5 text-lg outline-none focus:border-brand focus:ring-4 focus:ring-brand/15 ${f.type === "password" ? "pr-14" : ""}`}
                    required
                  />
                  {f.type === "password" && (
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      title={showPassword ? "Hide password" : "Show password"}
                      className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted hover:text-ink"
                    >
                      {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  )}
                </span>
              </label>
            ))}
          </div>
          {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
          <Button disabled={busy} className="mt-8 w-full py-3.5">
            {busy ? "Signing in…" : "Sign in"}
          </Button>

          <Link
            href="/"
            className="mt-10 flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3.5 text-[15px] font-medium hover:border-brand/50"
          >
            <span className="flex items-center gap-2">
              <Smartphone size={18} className="text-brand" /> Patient? Log in or create an account
            </span>
            <span className="text-brand">→</span>
          </Link>
        </form>
      </section>
    </main>
  );
}
