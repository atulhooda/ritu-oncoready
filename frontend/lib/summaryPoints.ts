import { useSyncExternalStore } from "react";

/** Lets other parts of the patient page (the Ritu records assistant) add a point to the summary the
 *  junior doctor is editing. The summary editor registers itself while it is open and editable. */
export type NewPoint = { text: string; source: string | null };
type Target = (p: NewPoint) => void;

let target: Target | null = null;
const listeners = new Set<() => void>();

export function setSummaryTarget(t: Target | null) {
  target = t;
  listeners.forEach((l) => l());
}

/** The function that adds a point, or null when no summary is being edited. */
export function useSummaryTarget(): Target | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => target,
    () => null,
  );
}
