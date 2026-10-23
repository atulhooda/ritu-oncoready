/**
 * Speech for the doctor's records assistant (see BEHAVIOR_SPEC.md):
 *  - speaking: Ritu's Sarvam voice (POST /doctor/assistant/speech -> Ritu /v1/speech, 24 kHz WAV).
 *    When Ritu is not connected, the browser's own speechSynthesis voice is used instead.
 *  - recognition: the browser's Web Speech API (Chrome / Edge). These browsers send the audio to
 *    their own speech service, so it is NOT offline. Firefox has none; Safari's is partial.
 * No speech logic lives on OncoReady's server; Ritu does the speaking.
 */

import { API_URL, getToken } from "@/lib/api";

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

export type PlayState = "loading" | "playing" | "paused" | "stopped";
export type VoiceEngine = "sarvam" | "browser";

/** One answer is read at a time, across the whole page. */
let current: { audio: HTMLAudioElement | null; url: string | null; onState: (s: PlayState) => void } | null = null;

export function stopSpeech(): void {
  if (current) {
    current.audio?.pause();
    if (current.url) URL.revokeObjectURL(current.url);
    const done = current.onState;
    current = null;
    done("stopped");
  }
  if (canSpeak()) window.speechSynthesis.cancel();
}

export function pauseSpeech(): void {
  if (!current) return;
  if (current.audio) current.audio.pause();
  else window.speechSynthesis.pause();
  current.onState("paused");
}

export function resumeSpeech(): void {
  if (!current) return;
  if (current.audio) void current.audio.play();
  else window.speechSynthesis.resume();
  current.onState("playing");
}

function browserVoice(text: string, me: NonNullable<typeof current>): void {
  if (!canSpeak()) return stopSpeech();
  const u = new SpeechSynthesisUtterance(spoken(text));
  u.lang = "en-IN";
  u.rate = 0.98;
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === "en-IN") ?? voices.find((v) => v.lang.startsWith("en"));
  if (voice) u.voice = voice;
  u.onend = u.onerror = () => current === me && stopSpeech();
  window.speechSynthesis.speak(u);
  me.onState("playing");
}

/** Read text aloud in Ritu's Sarvam voice; the browser's voice if Ritu is not connected. */
export async function speak(text: string, onState: (s: PlayState) => void): Promise<VoiceEngine> {
  stopSpeech();
  const me = { audio: null as HTMLAudioElement | null, url: null as string | null, onState };
  current = me;
  onState("loading");
  try {
    const r = await fetch(`${API_URL}/doctor/assistant/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken(text).slice(0, 2000) }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const blob = await r.blob();
    if (current !== me) return "sarvam"; // stopped or replaced while loading
    me.url = URL.createObjectURL(blob);
    me.audio = new Audio(me.url);
    me.audio.onended = () => current === me && stopSpeech();
    await me.audio.play();
    onState("playing");
    return "sarvam";
  } catch {
    if (current !== me) return "browser";
    me.audio = null;
    browserVoice(text, me);
    return "browser";
  }
}
