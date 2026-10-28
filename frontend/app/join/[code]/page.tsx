"use client";

import { ArrowLeft, MessageCircle, ShieldCheck } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Eyebrow, Label } from "@/components/ui";
import { api, setToken } from "@/lib/api";
import { rememberClinic } from "@/lib/clinic";

type Clinic = { name: string; code: string; sms: "sms" | "demo"; whatsapp: boolean };
type Step = "phone" | "code" | "whatsapp" | "name";
type WhatsAppChallenge = { challenge_id: string; message: string; link: string; to: string };
type Verified = { access_token?: string; signup_token?: string; waiting?: boolean };

const INPUT =
  "w-full rounded-xl border border-line bg-white px-4 py-3.5 text-lg outline-none focus:border-brand focus:ring-4 focus:ring-brand/15";

/** Patient sign-up and sign-in at one clinic: phone, one-time code, and a name for new patients. */
export default function JoinClinicPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [missing, setMissing] = useState(false);
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [signupToken, setSignupToken] = useState("");
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wa, setWa] = useState<WhatsAppChallenge | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<Clinic>(`/join/${encodeURIComponent(code)}`)
      .then((c) => {
        setClinic(c);
        rememberClinic(c.code, c.name);
      })
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

  const afterVerified = (r: Verified) => {
    if (r.access_token) signedIn(r.access_token);
    else if (r.signup_token) {
      setSignupToken(r.signup_token);
      setStep("name");
    }
  };

  const startWhatsApp = (e?: React.FormEvent) => {
    e?.preventDefault();
    run(async () => {
      setWa(await api<WhatsAppChallenge>(`/join/${clinic!.code}/whatsapp`, { method: "POST", body: JSON.stringify({ phone }) }));
      setCopied(false);
      setStep("whatsapp");
    });
  };

  // While waiting for the WhatsApp message, ask the server every few seconds.
  useEffect(() => {
    if (step !== "whatsapp" || !wa || !clinic) return;
    let stopped = false;
    const t = setInterval(async () => {
      try {
        const r = await api<Verified>(`/join/${clinic.code}/whatsapp/status`, {
          method: "POST",
          body: JSON.stringify({ phone, challenge_id: wa.challenge_id }),
        });
        if (!stopped && !r.waiting) {
          clearInterval(t);
          afterVerified(r);
        }
      } catch (err) {
        clearInterval(t);
        if (!stopped) {
          setError(err instanceof Error ? err.message : "Verification stopped");
          setStep("phone");
        }
      }
    }, 2500);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only for a new challenge
  }, [step, wa, clinic]);

  const sendCode = (e?: React.FormEvent) => {
    e?.preventDefault();
    run(async () => {
      const r = await api<{ sent_to: string; demo_code: string | null }>(`/join/${clinic!.code}/otp`, {
        method: "POST",
        body: JSON.stringify({ phone }),
      });
      setSentTo(r.sent_to);
      setDemoCode(r.demo_code);
      setOtp("");
      setStep("code");
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ access_token?: string; signup_token?: string }>(`/join/${clinic!.code}/verify`, {
        method: "POST",
        body: JSON.stringify({ phone, code: otp }),
      });
      afterVerified(r);
    });
  };

  const register = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ access_token: string }>(`/join/${clinic!.code}/register`, {
        method: "POST",
        body: JSON.stringify({ signup_token: signupToken, full_name: name, accept_test_terms: agree }),
      });
      signedIn(r.access_token);
    });
  };

  return (
    <main className="grid min-h-screen bg-paper lg:grid-cols-[1fr_1.1fr]">
      <section className="hidden flex-col justify-between bg-ink p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand font-extrabold">O</span>
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

      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {missing ? (
            <>
              <Eyebrow>Join a clinic</Eyebrow>
              <h1 className="mt-3 text-4xl font-extrabold tracking-tight">Clinic not found</h1>
              <p className="mt-3 text-muted">
                Check the link or code your clinic gave you. Sign-up may also be closed for now.
              </p>
            </>
          ) : !clinic ? (
            <p className="text-muted">Loading…</p>
          ) : (
            <>
              <Eyebrow>{clinic.name}</Eyebrow>
              <h1 className="mt-3 text-5xl font-extrabold tracking-tight">
                {step === "name" ? (
                  <>
                    Nearly <span className="font-serif font-normal italic text-brand">there.</span>
                  </>
                ) : (
                  <>
                    Sign in or <span className="font-serif font-normal italic text-brand">join.</span>
                  </>
                )}
              </h1>
              <p className="mt-3 text-[16px] text-muted">
                {step === "phone" &&
                  (clinic.whatsapp
                    ? "Use your mobile number. You'll confirm it by sending us a WhatsApp message; no password needed."
                    : "Use your mobile number. We'll send you a one-time code; no password needed.")}
                {step === "whatsapp" && "Send the message below from WhatsApp on this phone. This page continues on its own."}
                {step === "code" && `Enter the 6-digit code sent to ${sentTo}.`}
                {step === "name" && "This number is new here. Tell us your name to create your account."}
              </p>

              <div className="mt-5 flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[14px] text-amber-900">
                <ShieldCheck size={18} className="mt-0.5 shrink-0" />
                <span>Pilot service: test accounts only. Please do not upload real medical records yet.</span>
              </div>

              {step === "phone" && (
                <form onSubmit={sendCode} className="mt-7 space-y-5">
                  <label className="block">
                    <Label className="mb-2">Mobile number</Label>
                    <input
                      id="phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="98123 45678"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className={INPUT}
                      required
                    />
                  </label>
                  {clinic.whatsapp ? (
                    <>
                      <button
                        type="button"
                        onClick={() => startWhatsApp()}
                        disabled={busy || phone.replace(/\D/g, "").length < 10}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1f8f4e] py-3.5 text-[15px] font-semibold text-white hover:bg-[#197a42] disabled:opacity-50"
                      >
                        <MessageCircle size={18} /> {busy ? "Starting…" : "Verify on WhatsApp"}
                      </button>
                      <button
                        type="submit"
                        disabled={busy || phone.replace(/\D/g, "").length < 10}
                        className="w-full text-center text-sm font-medium text-muted hover:text-ink disabled:opacity-50"
                      >
                        {clinic.sms === "sms" ? "Get a code by SMS instead" : "No WhatsApp? Get a code instead"}
                      </button>
                    </>
                  ) : (
                    <Button disabled={busy || phone.replace(/\D/g, "").length < 10} className="w-full py-3.5">
                      {busy ? "Sending…" : "Send code"}
                    </Button>
                  )}
                </form>
              )}

              {step === "whatsapp" && wa && (
                <div className="mt-7 space-y-5">
                  <div className="rounded-xl border border-line bg-white p-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted">Message to send</div>
                    <div className="mt-1 font-mono text-2xl font-semibold tracking-wider">{wa.message}</div>
                    <div className="mt-1 text-sm text-muted">to {wa.to} on WhatsApp</div>
                  </div>
                  <a
                    href={wa.link}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1f8f4e] py-3.5 text-[15px] font-semibold text-white hover:bg-[#197a42]"
                  >
                    <MessageCircle size={18} /> Open WhatsApp
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(wa.message).then(() => setCopied(true), () => setCopied(false));
                    }}
                    className="w-full text-center text-sm font-medium text-brand hover:underline"
                  >
                    {copied ? "Copied" : "Copy the message"}
                  </button>
                  <div className="flex items-center justify-center gap-2 text-sm text-muted">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                    Waiting for your message…
                  </div>
                  <button type="button" onClick={() => setStep("phone")} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
                    <ArrowLeft size={14} /> Change number
                  </button>
                </div>
              )}

              {step === "code" && (
                <form onSubmit={verify} className="mt-7 space-y-5">
                  {demoCode && (
                    <p className="rounded-lg bg-line/50 px-3 py-2 text-sm">
                      Demo mode, no SMS is sent. Your code is <span className="font-mono font-semibold tracking-widest">{demoCode}</span>
                    </p>
                  )}
                  <label className="block">
                    <Label className="mb-2">Code</Label>
                    <input
                      id="otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                      className={`${INPUT} text-center font-mono text-2xl tracking-[0.5em]`}
                      autoFocus
                      required
                    />
                  </label>
                  <Button disabled={busy || otp.length !== 6} className="w-full py-3.5">
                    {busy ? "Checking…" : "Continue"}
                  </Button>
                  <div className="flex items-center justify-between text-sm">
                    <button type="button" onClick={() => setStep("phone")} className="inline-flex items-center gap-1 text-muted hover:text-ink">
                      <ArrowLeft size={14} /> Change number
                    </button>
                    <button type="button" onClick={() => sendCode()} disabled={busy} className="font-medium text-brand hover:underline">
                      Send a new code
                    </button>
                  </div>
                </form>
              )}

              {step === "name" && (
                <form onSubmit={register} className="mt-7 space-y-5">
                  <label className="block">
                    <Label className="mb-2">Your full name</Label>
                    <input id="full-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} autoFocus required minLength={2} />
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 text-[15px]">
                    <input id="agree" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-brand)]" />
                    <span>I understand this is a pilot with test accounts, and I will not enter real medical records.</span>
                  </label>
                  <Button disabled={busy || !agree || name.trim().length < 2} className="w-full py-3.5">
                    {busy ? "Creating…" : "Create my account"}
                  </Button>
                </form>
              )}

              {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
