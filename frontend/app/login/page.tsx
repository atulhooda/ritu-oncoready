"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { api, setToken } from "@/lib/api";
import type { Me } from "@/lib/types";

export default function LoginPage() {
  const router = useRouter();
  const [orgSlug, setOrgSlug] = useState("demo");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { access_token } = await api<{ access_token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ org_slug: orgSlug, email, password }),
      });
      setToken(access_token);
      const me = await api<Me>("/auth/me");
      router.replace(me.role === "resident" ? "/cases" : "/faculty");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-slate-900">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Ritu OncoReady</h1>
          <p className="text-sm text-slate-500">Case-readiness training on synthetic cases.</p>
        </div>
        {[
          ["Organization", orgSlug, setOrgSlug, "text"],
          ["Email", email, setEmail, "email"],
          ["Password", password, setPassword, "password"],
        ].map(([label, value, set, type]) => (
          <label key={label as string} className="block text-sm">
            <span className="text-slate-700">{label as string}</span>
            <input
              type={type as string}
              value={value as string}
              onChange={(e) => (set as (v: string) => void)(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
              required
            />
          </label>
        ))}
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
