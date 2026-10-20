"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { setToken } from "@/lib/api";
import type { Me } from "@/lib/types";

export function Shell({ me, children }: { me: Me | null; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <Link href={me?.role === "resident" ? "/cases" : "/faculty"} className="font-semibold">
            Ritu OncoReady
          </Link>
          <span className="hidden text-xs text-amber-700 sm:block">Synthetic cases only. Not for clinical use.</span>
          {me && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-600">
                {me.full_name} · {me.role}
              </span>
              <button
                className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
                onClick={() => {
                  setToken(null);
                  router.replace("/login");
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{me ? children : <p className="text-slate-500">Loading…</p>}</main>
    </div>
  );
}

export function Badge({ tone, children }: { tone: "green" | "red" | "amber" | "slate" | "blue"; children: React.ReactNode }) {
  const tones = {
    green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-800",
    amber: "bg-amber-100 text-amber-800",
    slate: "bg-slate-100 text-slate-700",
    blue: "bg-blue-100 text-blue-800",
  };
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
