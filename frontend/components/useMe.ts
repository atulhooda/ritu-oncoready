"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api, ApiError, setToken } from "@/lib/api";
import type { Me, Role } from "@/lib/types";

/** Loads the current user; redirects to /login when signed out or to home on a wrong role. */
export function useMe(allowed?: Role[]): Me | null {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const allowedKey = allowed?.join(",");

  useEffect(() => {
    api<Me>("/auth/me")
      .then((user) => {
        if (allowedKey && !allowedKey.split(",").includes(user.role)) {
          router.replace(user.role === "resident" ? "/cases" : "/faculty");
          return;
        }
        setMe(user);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setToken(null);
        router.replace("/login");
      });
  }, [router, allowedKey]);

  return me;
}
