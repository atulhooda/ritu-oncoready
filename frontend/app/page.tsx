"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PatientJoin } from "@/components/PatientJoin";
import { api, getToken } from "@/lib/api";
import type { Me } from "@/lib/types";
import { homeFor } from "@/lib/types";

/** The one public link: patients sign in or sign up here; doctors and hospitals follow the link to log in.
 *  Someone already signed in goes straight to their own home. */
export default function Home() {
  const router = useRouter();
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    if (!getToken()) {
      setSignedOut(true);
      return;
    }
    api<Me>("/auth/me")
      .then((me) => router.replace(homeFor(me.role)))
      .catch(() => setSignedOut(true));
  }, [router]);
  return signedOut ? <PatientJoin /> : null;
}
