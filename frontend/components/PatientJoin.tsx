"use client";

import { CheckCircle2, Eye, EyeOff, ShieldCheck, Stethoscope } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Eyebrow } from "@/components/ui";
import { api, setToken } from "@/lib/api";
import { LANGUAGES, SEX_LABELS } from "@/lib/types";
import { Logo } from "@/components/Logo";

type Clinic = { name: string; code: string; phone_check: boolean };
type Tab = "signup" | "login";

const INPUT =
  "w-full rounded-xl border border-line bg-white px-4 py-3.5 text-lg outline-none focus:border-brand focus:ring-4 focus:ring-brand/15 h-14";

const FL = "mb-1.5 block text-[15px] font-medium text-ink/85";

function PasswordInput({ id, value, onChange, autoComplete }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input id={id} type={show ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} className={`${INPUT} pr-14`} required />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted hover:text-ink"
      >
        {show ? <EyeOff size={20} /> : <Eye size={20} />}
      </button>
    </span>
  );
}

/**
 * The patient's front door: "Create account" or "Log in". With a clinic code (/join/<code>) it is
 * that clinic; without one (the main page) the server's default clinic. Doctors and hospitals are
 * sent to the staff login from here.
 */
export function PatientJoin({ code }: { code?: string }) {
  const router = useRouter();
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>("signup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // sign up
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneToken, setPhoneToken] = useState<string | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState("");
  const [password, setPassword] = useState("");
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState("");
  const [location, setLocation] = useState("");
  const [language, setLanguage] = useState("en-IN");
  const [agree, setAgree] = useState(false);

  // log in
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  useEffect(() => {
    api<Clinic>(code ? `/join/${encodeURIComponent(code)}` : "/join")
      .then(setClinic)
      .catch(() => setMissing(true));
  }, [code]);

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

  const signedIn = (token: string) => {
    setToken(token);
    router.replace("/patient");
  };

  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  const phoneVerified = !!phoneToken && verifiedPhone === phone;

  const sendCode = () =>
    run(async () => {
      const r = await api<{ sent_to: string }>(`/join/${clinic!.code}/phone/send`, { method: "POST", body: JSON.stringify({ phone }) });
      setCodeSentTo(r.sent_to);
      setPhoneCode("");
    });

  const checkCode = () =>
    run(async () => {
      const r = await api<{ phone_token: string }>(`/join/${clinic!.code}/phone/verify`, {
        method: "POST",
        body: JSON.stringify({ phone, code: phoneCode }),
      });
      setPhoneToken(r.phone_token);
      setVerifiedPhone(phone);
      setCodeSentTo(null);
    });

  const signUp = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ access_token: string }>(`/join/${clinic!.code}/signup`, {
        method: "POST",
        body: JSON.stringify({
          full_name: name,
          email,
          phone,
          phone_token: phoneVerified ? phoneToken : null,
          password,
          date_of_birth: dob,
          sex,
          preferred_language: language,
          location: location.trim() || null,
          accept_test_terms: agree,
        }),
      });
      signedIn(r.access_token);
    });
  };

  const logIn = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ access_token: string }>(`/join/${clinic!.code}/login`, {
        method: "POST",
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      signedIn(r.access_token);
    });
  };

  const canSignUp =
    name.trim().length >= 2 && email.includes("@") && phoneOk && password.length >= 8 && !!dob && !!sex && agree && (!clinic?.phone_check || phoneVerified);

  return (
    <main className="grid min-h-screen bg-paper lg:grid-cols-[1fr_1.1fr]">
      <section className="hidden flex-col justify-between bg-ink p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-xl font-bold tracking-tight">OncoReady</span>
        </div>
        <div>
          <div className="font-mono text-xs uppercase tracking-[0.25em] text-white/50">Before your visit</div>
          <h2 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight">
            Tell us how you are.
            <br />
            Your doctor will <span className="font-serif font-normal italic text-[#8e9bff]">know.</span>
          </h2>
          <p className="mt-4 max-w-md text-white/60">
            Talk to Ritu in your language, add your reports, and your care team sees it all before you arrive.
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/45">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" /> Pilot · test accounts only
        </div>
      </section>

      <section className="flex items-start justify-center px-4 pb-12 pt-8 lg:items-center lg:py-12">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-2.5">
              <Logo />
              <span className="text-lg font-bold tracking-tight">OncoReady</span>
            </div>
            <p className="mt-4 text-[22px] font-extrabold leading-snug tracking-tight">
              Tell us how you are. Your doctor will <span className="font-serif font-normal italic text-brand">know.</span>
            </p>
          </div>
          {missing ? (
            <>
              <Eyebrow>Patients</Eyebrow>
              <h1 className="mt-3 text-4xl font-extrabold tracking-tight">{code ? "Clinic not found" : "Use your clinic's link"}</h1>
              <p className="mt-3 text-muted">
                {code
                  ? "Check the link or code your clinic gave you. Sign-up may also be closed for now."
                  : "Sign-up is not open on this page. Use the sign-up link your clinic gave you."}
              </p>
            </>
          ) : !clinic ? (
            <p className="text-muted">Loading…</p>
          ) : (
            <>
              <Eyebrow>{clinic.name}</Eyebrow>
              <div role="tablist" className="mt-4 grid grid-cols-2 rounded-xl border border-line bg-white p-1">
                {(
                  [
                    ["signup", "Create account"],
                    ["login", "Log in"],
                  ] as const
                ).map(([t, label]) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => {
                      setTab(t);
                      setError(null);
                    }}
                    className={`rounded-lg py-2.5 text-[15px] font-semibold transition ${tab === t ? "bg-brand text-white" : "text-muted hover:text-ink"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="mt-5 flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[14px] text-amber-900">
                <ShieldCheck size={18} className="mt-0.5 shrink-0" />
                <span>Pilot service: test accounts only. Please do not upload real medical records yet.</span>
              </div>

              {tab === "login" ? (
                <form onSubmit={logIn} className="mt-6 space-y-5">
                  <label className="block">
                    <span className={FL}>Email</span>
                    <input id="login-email" type="email" autoComplete="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} className={INPUT} required />
                  </label>
                  <label className="block">
                    <span className={FL}>Password</span>
                    <PasswordInput id="login-password" value={loginPassword} onChange={setLoginPassword} autoComplete="current-password" />
                  </label>
                  <Button disabled={busy} className="w-full py-3.5">
                    {busy ? "Logging in…" : "Log in"}
                  </Button>
                  <p className="text-center text-sm text-muted">
                    New here?{" "}
                    <button type="button" onClick={() => setTab("signup")} className="font-medium text-brand hover:underline">
                      Create an account
                    </button>
                  </p>
                </form>
              ) : (
                <form onSubmit={signUp} className="mt-6 space-y-5">
                  <label className="block">
                    <span className={FL}>Full name</span>
                    <input id="full-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} required minLength={2} />
                  </label>
                  <label className="block">
                    <span className={FL}>Email</span>
                    <input id="email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} required />
                  </label>

                  <div>
                    <span className={FL}>Mobile number (WhatsApp)</span>
                    <div className="flex gap-2">
                      <input
                        id="phone"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="98123 45678"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className={`${INPUT} min-w-0 flex-1`}
                        required
                      />
                      {clinic.phone_check && !phoneVerified && (
                        <button
                          type="button"
                          onClick={sendCode}
                          disabled={busy || !phoneOk}
                          className="shrink-0 rounded-xl bg-[#1f8f4e] px-4 text-[14px] font-semibold text-white hover:bg-[#197a42] disabled:opacity-50"
                        >
                          {codeSentTo ? "Resend" : "Send code"}
                        </button>
                      )}
                    </div>
                    {phoneVerified && (
                      <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-green-700">
                        <CheckCircle2 size={16} /> Number verified
                      </p>
                    )}
                    {clinic.phone_check && codeSentTo && !phoneVerified && (
                      <div className="mt-3 space-y-2">
                        <p className="text-sm text-muted">We sent a 6-digit code to {codeSentTo} on WhatsApp.</p>
                        <div className="flex gap-2">
                          <input
                            id="phone-code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            placeholder="6-digit code"
                            value={phoneCode}
                            onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ""))}
                            className={`${INPUT} min-w-0 flex-1 font-mono tracking-[0.3em]`}
                          />
                          <button
                            type="button"
                            onClick={checkCode}
                            disabled={busy || phoneCode.length !== 6}
                            className="shrink-0 rounded-xl border border-line bg-white px-4 text-[14px] font-semibold hover:border-ink/30 disabled:opacity-50"
                          >
                            Verify
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <label className="block">
                    <span className={FL}>Password</span>
                    <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="new-password" />
                    <span className="mt-1.5 block text-xs text-muted">At least 8 characters. You&apos;ll use your email and this password to log in.</span>
                  </label>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <label className="block">
                      <span className={FL}>Date of birth</span>
                      <input id="dob" type="date" autoComplete="bday" max={new Date().toISOString().slice(0, 10)} value={dob} onChange={(e) => setDob(e.target.value)} className={INPUT} required />
                    </label>
                    <label className="block">
                      <span className={FL}>Sex</span>
                      <select id="sex" value={sex} onChange={(e) => setSex(e.target.value)} className={`${INPUT} appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2720%27%20height=%2720%27%20fill=%27none%27%20stroke=%27%236b6a66%27%20stroke-width=%272%27%3E%3Cpath%20d=%27M5%208l5%205%205-5%27/%3E%3C/svg%3E")] bg-[position:right_1rem_center] bg-no-repeat pr-11`} required>
                        <option value="" disabled>
                          Choose…
                        </option>
                        {Object.entries(SEX_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="block">
                    <span className={FL}>Where you live</span>
                    <input id="location" autoComplete="address-level2" placeholder="Town or city, state (e.g. Pune, Maharashtra)" value={location} onChange={(e) => setLocation(e.target.value)} className={INPUT} />
                  </label>
                  <label className="block">
                    <span className={FL}>Language you&apos;re most comfortable in</span>
                    <select id="language" value={language} onChange={(e) => setLanguage(e.target.value)} className={`${INPUT} appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2720%27%20height=%2720%27%20fill=%27none%27%20stroke=%27%236b6a66%27%20stroke-width=%272%27%3E%3Cpath%20d=%27M5%208l5%205%205-5%27/%3E%3C/svg%3E")] bg-[position:right_1rem_center] bg-no-repeat pr-11`}>
                      {Object.entries(LANGUAGES).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 text-[15px]">
                    <input id="agree" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-brand)]" />
                    <span>I understand this is a pilot with test accounts, and I will not enter real medical records.</span>
                  </label>
                  <Button disabled={busy || !canSignUp} className="w-full py-3.5">
                    {busy ? "Please wait…" : "Create my account"}
                  </Button>
                  {clinic.phone_check && !phoneVerified && <p className="text-center text-xs text-muted">Verify your number to create the account.</p>}
                  <p className="text-center text-sm text-muted">
                    Already have an account?{" "}
                    <button type="button" onClick={() => setTab("login")} className="font-medium text-brand hover:underline">
                      Log in
                    </button>
                  </p>
                </form>
              )}

              {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
            </>
          )}

          <div className="mt-10 border-t border-line pt-6">
            <Link
              href="/login"
              className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3.5 text-[15px] font-medium hover:border-brand/50"
            >
              <span className="flex items-center gap-2">
                <Stethoscope size={18} className="text-brand" /> Hospital or doctor? Hospital login
              </span>
              <span className="text-brand">→</span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
