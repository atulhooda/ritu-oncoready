/**
 * Browser speech for the doctor's records assistant (a prototype fallback, see BEHAVIOR_SPEC.md):
 *  - recognition: the Web Speech API (Chrome / Edge). These browsers send the audio to their own
 *    speech service, so it is NOT offline. Firefox has no recognition; Safari's is partial.
 *  - speaking: speechSynthesis, using the device's installed voices (works offline).
 * No speech logic lives on OncoReady's server.
 */

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const canRecognize = () => recognitionClass() !== null;
export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

export const RECOGNITION_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.",
  "service-not-allowed": "Your browser does not allow speech recognition here. You can type the question instead.",
  "audio-capture": "No microphone was found. Check that one is connected.",
  "no-speech": "I didn't hear anything. Tap the microphone and try again.",
  network: "Speech recognition needs an internet connection in this browser.",
  aborted: "",
};

/** Ask for the microphone first, so a blocked or missing mic gives a clear message. */
export async function checkMicrophone(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) return "This browser cannot use a microphone here (it needs https or localhost).";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return null;
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    return name === "NotFoundError" ? RECOGNITION_ERRORS["audio-capture"] : RECOGNITION_ERRORS["not-allowed"];
  }
}

export function listen(handlers: {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): { stop: () => void; abort: () => void } {
  const Cls = recognitionClass();
  if (!Cls) {
    handlers.onError("Voice input needs Chrome or Edge. You can still type your question.");
    handlers.onEnd();
    return { stop() {}, abort() {} };
  }
  const r = new Cls();
  r.lang = "en-IN";
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let final = "";
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) final += res[0].transcript;
      else interim += res[0].transcript;
    }
    handlers.onInterim((final + interim).trim());
  };
  r.onerror = (e) => {
    const msg = RECOGNITION_ERRORS[e.error] ?? `Speech recognition failed (${e.error}).`;
    if (msg) handlers.onError(msg);
  };
  r.onend = () => {
    if (final.trim()) handlers.onFinal(final.trim());
    handlers.onEnd();
  };
  r.start();
  return { stop: () => r.stop(), abort: () => r.abort() };
}

/** Units read the way a person would say them. */
export function spoken(text: string): string {
  return text
    .replace(/[“”"]/g, "")
    .replace(/\bbpm\b/g, "beats per minute")
    .replace(/\bmmHg\b/g, "millimetres of mercury")
    .replace(/\bg\/dL\b/g, "grams per decilitre")
    .replace(/°F/g, "degrees Fahrenheit")
    .replace(/°C/g, "degrees Celsius")
    .replace(/\bkg\b/g, "kilograms")
    .replace(/(\d)\/(\d)/g, "$1 over $2");
}

export function speak(text: string, onEnd: () => void): void {
  if (!canSpeak()) return onEnd();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(spoken(text));
  u.lang = "en-IN";
  u.rate = 0.98;
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang === "en-IN") ?? window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("en"));
  if (voice) u.voice = voice;
  u.onend = onEnd;
  u.onerror = onEnd;
  window.speechSynthesis.speak(u);
}
