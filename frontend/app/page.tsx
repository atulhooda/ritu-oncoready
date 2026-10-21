"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import type { Me } from "@/lib/types";
import { homeFor } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api<Me>("/auth/me")
      .then((me) => router.replace(homeFor(me.role)))
      .catch(() => router.replace("/login"));
  }, [router]);
  return null;
}
