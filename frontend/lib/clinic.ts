/** The clinic a patient last joined from (its code and name), so the login page can offer it again. */
const KEY = "oncoready.clinic";

export function rememberClinic(code: string, name: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ code, name }));
  } catch {
    /* storage unavailable */
  }
}

export function lastClinic(): { code: string; name: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.code === "string" ? v : null;
  } catch {
    return null;
  }
}
