/**
 * Short interface sounds, synthesised with Web Audio (no files to load). Quiet and brief: this
 * is a clinical tool. Never played while someone is speaking to Ritu, only at the edges of a
 * conversation. The viewer can turn them off; the choice is remembered in this browser.
 */

export type Sound = "send" | "listen" | "stop" | "answer" | "error" | "connect" | "end" | "success" | "remove";

type Note = { f: number; at: number; len: number; type?: OscillatorType; gain?: number };

const C5 = 523.25, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E6 = 1318.5, G6 = 1568, A3 = 220, E4 = 329.63;

const SOUNDS: Record<Sound, Note[]> = {
  send: [{ f: 1760, at: 0, len: 0.035, gain: 0.35 }],
  listen: [{ f: E5, at: 0, len: 0.09 }, { f: A5, at: 0.08, len: 0.14 }],
  stop: [{ f: A5, at: 0, len: 0.08 }, { f: E5, at: 0.07, len: 0.12 }],
  answer: [{ f: C6, at: 0, len: 0.35, gain: 0.6 }, { f: G6, at: 0.09, len: 0.45, gain: 0.45 }],
  error: [{ f: E4, at: 0, len: 0.14, type: "triangle" }, { f: A3, at: 0.13, len: 0.22, type: "triangle" }],
  connect: [{ f: C5, at: 0, len: 0.12 }, { f: E5, at: 0.09, len: 0.12 }, { f: G5, at: 0.18, len: 0.25 }],
  end: [{ f: G5, at: 0, len: 0.12 }, { f: E5, at: 0.1, len: 0.12 }, { f: C5, at: 0.2, len: 0.3 }],
  success: [{ f: C5, at: 0, len: 0.1 }, { f: E5, at: 0.07, len: 0.1 }, { f: G5, at: 0.14, len: 0.1 }, { f: C6, at: 0.21, len: 0.4 }, { f: E6, at: 0.21, len: 0.4, gain: 0.3 }],
  remove: [{ f: 392, at: 0, len: 0.1, type: "triangle", gain: 0.7 }],
};

const KEY = "oncoready.sounds";
const VOLUME = 0.07;
let ctx: AudioContext | null = null;
const listeners = new Set<(on: boolean) => void>();

export function soundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundsOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable: applies to this page only */
  }
  listeners.forEach((l) => l(on));
  if (on) play("send");
}

export function onSoundsChange(l: (on: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function play(name: Sound): void {
  if (typeof window === "undefined" || !soundsOn()) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = VOLUME;
    out.connect(ctx.destination);
    for (const n of SOUNDS[name]) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = n.type ?? "sine";
      osc.frequency.value = n.f;
      const start = t0 + n.at;
      // soft attack, exponential tail: a chime, not a beep
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(n.gain ?? 1, start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, start + n.len);
      osc.connect(env).connect(out);
      osc.start(start);
      osc.stop(start + n.len + 0.02);
    }
  } catch {
    /* no audio available: sounds are optional */
  }
}
