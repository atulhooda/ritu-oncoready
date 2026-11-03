import Image from "next/image";

/** The Engageo mark, used wherever the app shows its logo. */
export function Logo({ size = 36 }: { size?: number }) {
  return <Image src="/logo.png" alt="" width={size} height={size} className="shrink-0 rounded-lg" priority />;
}
