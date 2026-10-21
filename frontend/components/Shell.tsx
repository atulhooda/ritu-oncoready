"use client";

import { ClipboardCheck, FileUp, FolderOpen, LogOut, Menu, Mic, Send, Stethoscope, UserRound, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { setToken } from "@/lib/api";
import type { Me } from "@/lib/types";

export { Badge } from "@/components/ui";

const NAV = {
  resident: [{ href: "/cases", label: "Cases", icon: FolderOpen }],
  faculty: [
    { href: "/faculty", label: "Assessments", icon: ClipboardCheck },
    { href: "/faculty/residents", label: "Residents", icon: Users },
  ],
  patient: [
    { href: "/patient", label: "My profile", icon: UserRound },
    { href: "/patient/session", label: "Talk to Ritu", icon: Mic },
    { href: "/patient/records", label: "My records", icon: FileUp },
    { href: "/patient/send", label: "Send to doctor", icon: Send },
  ],
  doctor: [{ href: "/doctor", label: "Patients", icon: Stethoscope }],
};

function isActive(pathname: string, href: string) {
  if (href === "/faculty") return pathname === "/faculty" || pathname.startsWith("/faculty/briefs");
  if (href === "/patient") return pathname === "/patient";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return null;
  const part = (o: Intl.DateTimeFormatOptions) => now.toLocaleString("en-GB", o);
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  const text = `${part({ weekday: "short" })}, ${part({ day: "2-digit" })} ${part({ month: "short" })} ${time}`.toUpperCase();
  return (
    <div className="flex items-center gap-2 font-mono text-xs tracking-[0.2em] text-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
      {text}
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand font-extrabold text-white">O</span>
      <span className="text-xl font-bold tracking-tight text-white">OncoReady</span>
    </Link>
  );
}

function Sidebar({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const items = NAV[me.role === "admin" ? "faculty" : me.role];
  return (
    <div className="flex h-full flex-col bg-ink text-white/80">
      <div className="border-b border-white/10 px-6 py-5">
        <Brand />
      </div>
      <nav className="flex-1 px-3 py-8">
        <div className="mb-4 px-3 font-mono text-[11px] uppercase tracking-[0.25em] text-white/50">Workspace</div>
        <ul className="space-y-1.5">
          {items.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-[15px] transition ${
                    active ? "bg-brand text-white shadow-[0_8px_24px_-8px_rgba(58,79,224,0.9)]" : "hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <Icon size={19} strokeWidth={1.75} />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="space-y-5 border-t border-white/10 px-6 py-6">
        <div>
          <div className="font-semibold text-white">{me.org_name ?? "OncoReady"}</div>
          <div className="text-sm text-white/55">
            {me.role === "patient" || me.role === "doctor" ? "Demo patients · synthetic data" : "Synthetic teaching cases"}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <div className="min-w-0 rounded-lg border border-white/15 px-3 py-2">
            <div className="truncate text-white/85">{me.full_name}</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">{me.role}</div>
          </div>
          <button
            onClick={() => {
              setToken(null);
              router.replace("/login");
            }}
            className="flex shrink-0 items-center gap-2 text-white/70 hover:text-white"
          >
            <LogOut size={16} strokeWidth={1.75} /> Log out
          </button>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/45">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" /> Not for clinical use
        </div>
      </div>
    </div>
  );
}

export function Shell({ me, actions, children }: { me: Me | null; actions?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-paper text-ink">
      {me && (
        <aside className="fixed inset-y-0 left-0 hidden w-[260px] lg:block">
          <Sidebar me={me} />
        </aside>
      )}
      {me && open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[260px]">
            <Sidebar me={me} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
      <div className={me ? "lg:pl-[260px]" : ""}>
        <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-8">
            <div className="flex items-center gap-3">
              {me && (
                <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
                  {open ? <X size={20} /> : <Menu size={20} />}
                </button>
              )}
              <Clock />
            </div>
            <div className="flex items-center gap-3">{actions}</div>
          </div>
        </header>
        <main className="px-4 py-8 sm:px-8 sm:py-10">{me ? children : <p className="text-muted">Loading…</p>}</main>
      </div>
    </div>
  );
}
