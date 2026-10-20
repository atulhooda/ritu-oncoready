"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import type { Me } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api<Me>("/auth/me")
      .then((me) => router.replace(me.role === "resident" ? "/cases" : "/faculty"))
      .catch(() => router.replace("/login"));
  }, [router]);
  return null;
}
