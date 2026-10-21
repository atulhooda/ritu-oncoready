import { Label } from "@/components/ui";

const INPUT =
  "w-full rounded-xl border border-line bg-[#fcfbf9] px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-white focus:ring-4 focus:ring-brand/15";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <Label className="mb-2">{label}</Label>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={INPUT} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={2} {...props} className={INPUT} />;
}

export function Select({ options, placeholder, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: Record<string, string>; placeholder?: string }) {
  return (
    <select {...props} className={`${INPUT} appearance-none`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {Object.entries(options).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}
