const INPUT =
  "w-full rounded-xl border border-line bg-[#fcfbf9] px-4 py-3 text-[15px] outline-none focus:border-brand focus:bg-white focus:ring-4 focus:ring-brand/15";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[15px] font-medium text-ink/85">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] text-muted">{hint}</span>}
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
    <select {...props} className={`${INPUT} appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2720%27%20height=%2720%27%20fill=%27none%27%20stroke=%27%236b6a66%27%20stroke-width=%272%27%3E%3Cpath%20d=%27M5%208l5%205%205-5%27/%3E%3C/svg%3E")] bg-[position:right_1rem_center] bg-no-repeat pr-11`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {Object.entries(options).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}
