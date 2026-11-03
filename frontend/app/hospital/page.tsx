"use client";

import { UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Badge, Button, Card, EmptyState, Label, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { HospitalDoctor, Seniority } from "@/lib/types";

const INPUT = "w-full rounded-xl border border-line bg-white px-4 py-3 text-[15px] outline-none focus:border-brand focus:ring-4 focus:ring-brand/15";
const EMPTY = { full_name: "", email: "", password: "", seniority: "junior" as Seniority };

export default function HospitalDoctors() {
  const me = useMe(["hospital"]);
  const [doctors, setDoctors] = useState<HospitalDoctor[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (me) api<HospitalDoctor[]>("/hospital/doctors").then(setDoctors).catch((e) => setError(e.message));
  }, [me]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const d = await api<HospitalDoctor>("/hospital/doctors", { method: "POST", body: JSON.stringify(form) });
      setDoctors((ds) => [...ds, d]);
      setNote(`${d.name} can now log in on the Hospital login page with the hospital code, ${d.email} and the password you set.`);
      setForm(EMPTY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the doctor");
    } finally {
      setBusy(false);
    }
  }

  async function change(d: HospitalDoctor, body: Partial<{ seniority: Seniority; is_active: boolean; password: string }>) {
    setError(null);
    setNote(null);
    try {
      const updated = await api<HospitalDoctor>(`/hospital/doctors/${d.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setDoctors((ds) => ds.map((x) => (x.id === d.id ? updated : x)));
      if (body.password) setNote(`New password set for ${d.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }

  function resetPassword(d: HospitalDoctor) {
    const password = window.prompt(`New password for ${d.name} (at least 8 characters):`);
    if (password) change(d, { password });
  }

  const group = (s: Seniority) => doctors.filter((d) => d.seniority === s);

  return (
    <Shell me={me}>
      <PageHeader
        eyebrow="Hospital"
        title="Doctors"
        subtitle="Each patient who sends their check-in goes to a junior doctor automatically (whoever has the fewest). The junior sends their summary to a senior."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {error && <p className="text-sm text-red-700">{error}</p>}
          {note && <p className="text-sm text-green-700">{note}</p>}
          {doctors.length === 0 && <EmptyState title="No doctors yet.">Add your first junior and senior doctor on the right.</EmptyState>}
          {(["senior", "junior"] as const).map((s) =>
            group(s).length ? (
              <Card key={s} className="p-6">
                <Label>{s === "senior" ? "Senior doctors" : "Junior doctors"}</Label>
                <ul className="mt-4 divide-y divide-line/70">
                  {group(s).map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-semibold">
                          {d.name} {!d.active && <Badge>Deactivated</Badge>}
                        </div>
                        <div className="text-sm text-muted">
                          {d.email} · {d.patients} {s === "junior" ? "patient" : "summar"}
                          {s === "junior" ? (d.patients === 1 ? "" : "s") : d.patients === 1 ? "y" : "ies"} {s === "junior" ? "to send on" : "received"}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <select
                          aria-label={`Level for ${d.name}`}
                          value={d.seniority}
                          onChange={(e) => change(d, { seniority: e.target.value as Seniority })}
                          className="rounded-lg border border-line bg-white px-2.5 py-1.5"
                        >
                          <option value="junior">Junior</option>
                          <option value="senior">Senior</option>
                        </select>
                        <button onClick={() => resetPassword(d)} className="rounded-lg border border-line px-2.5 py-1.5 hover:border-ink/30">
                          Reset password
                        </button>
                        <button
                          onClick={() => change(d, { is_active: !d.active })}
                          className={`rounded-lg border px-2.5 py-1.5 ${d.active ? "border-line text-red-700 hover:border-red-300" : "border-line text-green-700 hover:border-green-300"}`}
                        >
                          {d.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null,
          )}
        </div>
        <Card className="h-fit p-6">
          <Label>Add a doctor</Label>
          <form onSubmit={add} className="mt-5 space-y-4">
            <input id="doctor-name" className={INPUT} placeholder="Full name, e.g. Dr. Asha Rao" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required minLength={2} />
            <input id="doctor-email" type="email" className={INPUT} placeholder="Email (their login)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <input id="doctor-password" type="text" className={INPUT} placeholder="Password (at least 8 characters)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} autoComplete="new-password" />
            <div className="grid grid-cols-2 gap-2">
              {(["junior", "senior"] as const).map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => setForm({ ...form, seniority: s })}
                  className={`rounded-xl border px-4 py-3 text-[15px] font-medium ${form.seniority === s ? "border-brand bg-brand/5 text-brand" : "border-line bg-white"}`}
                >
                  {s === "junior" ? "Junior doctor" : "Senior doctor"}
                </button>
              ))}
            </div>
            <Button disabled={busy} className="w-full">
              <UserPlus size={17} /> {busy ? "Adding…" : "Add doctor"}
            </Button>
            <p className="text-sm text-muted">They log in on the Hospital login page with the hospital code, their email and this password.</p>
          </form>
        </Card>
      </div>
    </Shell>
  );
}
