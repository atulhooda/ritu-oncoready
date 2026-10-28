"use client";

import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Shell } from "@/components/Shell";
import { useMe } from "@/components/useMe";
import { Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api";

/**
 * Where DigiLocker sends the patient back (?code&state). In demo mode it first stands in for
 * DigiLocker's consent screen, clearly labelled, so the whole flow can be tried without DigiLocker.
 */
export default function DigiLockerReturnPage() {
  const me = useMe(["patient"]);
  const router = useRouter();
  const [params, setParams] = useState<{ code: string; state: string; demo: boolean; error: string | null } | null>(null);
  const [status, setStatus] = useState<"consent" | "working" | "error">("working");
  const [message, setMessage] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const p = { code: q.get("code") ?? "", state: q.get("state") ?? "", demo: q.get("demo") === "1", error: q.get("error_description") ?? q.get("error") };
    setParams(p);
    if (p.error) {
      setStatus("error");
      setMessage(p.error === "access_denied" ? "You did not allow access in DigiLocker." : p.error);
    } else if (!p.code || !p.state) {
      setStatus("error");
      setMessage("DigiLocker did not send the sign-in back. Try again from your profile.");
    } else if (p.demo) setStatus("consent");
  }, []);

  const finish = useCallback(async () => {
    if (!params || sent.current) return;
    sent.current = true;
    setStatus("working");
    try {
      await api("/me/digilocker/complete", { method: "POST", body: JSON.stringify({ code: params.code, state: params.state }) });
      router.replace("/patient/profile");
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Could not finish the DigiLocker sign-in");
    }
  }, [params, router]);

  useEffect(() => {
    if (me && params && !params.demo && !params.error && params.code && params.state) void finish();
  }, [me, params, finish]);

  return (
    <Shell me={me}>
      <div className="mx-auto max-w-lg">
        <Card className="p-7 sm:p-9">
          {status === "consent" ? (
            <div className="space-y-5">
              <Label>DigiLocker · demo</Label>
              <h1 className="text-2xl font-bold tracking-tight">Share your details with your clinic?</h1>
              <p className="text-[15px] text-ink/80">
                In the live service this screen is DigiLocker&apos;s own. Your clinic would receive your name, date of birth and sex as
                registered with DigiLocker, and the documents you choose to import.
              </p>
              <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[14px] text-amber-900">
                <ShieldCheck size={18} className="mt-0.5 shrink-0" />
                <span>Demo mode: DigiLocker is not connected. Nothing is checked; your profile is marked &quot;DigiLocker demo&quot;.</span>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button onClick={finish}>Allow</Button>
                <Button variant="secondary" onClick={() => router.replace("/patient/profile")}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : status === "working" ? (
            <div className="flex items-center gap-3">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              <span className="font-medium">Finishing the DigiLocker sign-in…</span>
            </div>
          ) : (
            <div className="space-y-4">
              <h1 className="text-xl font-bold">DigiLocker sign-in did not finish</h1>
              <p className="text-[15px] text-ink/80">{message}</p>
              <Button onClick={() => router.replace("/patient/profile")}>Back to your profile</Button>
            </div>
          )}
        </Card>
      </div>
    </Shell>
  );
}
