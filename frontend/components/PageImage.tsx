"use client";

import { useEffect, useState } from "react";

import { imageUrl } from "@/lib/api";

export function PageImage({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setError(null);
    imageUrl(path)
      .then((u) => {
        url = u;
        if (!cancelled) setSrc(u);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (error) return <p className="p-4 text-sm text-red-700">Could not load page image: {error}</p>;
  if (!src) return <p className="p-4 text-sm text-slate-500">Loading page…</p>;
  // eslint-disable-next-line @next/next/no-img-element -- authenticated blob URL
  return <img src={src} alt={alt} className="w-full border border-slate-200 bg-white" />;
}
