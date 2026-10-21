import Link from "next/link";

type Tone = "green" | "red" | "amber" | "slate" | "blue";

const TONES: Record<Tone, string> = {
  green: "bg-green-50 text-green-800 border-green-200",
  red: "bg-red-50 text-red-700 border-red-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  slate: "bg-white text-muted border-line",
  blue: "bg-brand-soft text-brand border-brand/20",
};

export function Badge({ tone = "slate", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/** Mono, letter-spaced section label: "QUEUE", "RECENT", ... */
export function Label({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`font-mono text-[11px] uppercase tracking-[0.22em] text-muted ${className}`}>{children}</div>;
}

export function Eyebrow({ children, dot = "brand" }: { children: React.ReactNode; dot?: "brand" | "green" }) {
  return (
    <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.22em] text-muted">
      <span className={`h-1.5 w-1.5 rounded-full ${dot === "green" ? "bg-green-600" : "bg-brand"}`} />
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  accent,
  subtitle,
  actions,
  live,
}: {
  eyebrow: string;
  title: string;
  accent?: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  live?: boolean;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <Eyebrow dot={live ? "green" : "brand"}>{eyebrow}</Eyebrow>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-6xl">
          {title}
          {accent ? (
            <>
              {" "}
              <span className="font-serif font-normal italic text-brand">{accent}</span>
            </>
          ) : (
            <span className="text-brand">.</span>
          )}
        </h1>
        {subtitle && <p className="mt-2 text-lg text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line/70 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${className}`}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#d8d5cc] bg-[#faf9f6] px-6 py-16 text-center">
      <p className="text-lg font-medium">{title}</p>
      {children && <p className="mt-2 text-muted">{children}</p>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "brand" | "green" | "red" }) {
  const color = tone === "brand" ? "text-brand" : tone === "green" ? "text-green-600" : tone === "red" ? "text-red-600" : "";
  return (
    <Card className="p-7">
      <Label>{label}</Label>
      <div className={`mt-4 text-5xl font-extrabold tracking-tight ${color}`}>{value}</div>
      {sub && <div className="mt-3 text-muted">{sub}</div>}
    </Card>
  );
}

export function Pill({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
        active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink/80 hover:border-ink/30"
      }`}
    >
      {children}
    </button>
  );
}

const BUTTON = {
  primary: "bg-brand text-white shadow-[0_6px_16px_-6px_rgba(58,79,224,0.7)] hover:bg-brand-hover",
  secondary: "border border-line bg-white text-ink hover:border-ink/30",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[15px] font-semibold transition disabled:opacity-50 ${BUTTON[variant]} ${className}`}
    />
  );
}

export function TextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium text-brand hover:underline">
      {children}
    </Link>
  );
}
