/**
 * Audio transport between the browser and the Ritu voice server. Ritu does all speech work
 * (recognition, conversation, synthesis); this only moves audio. Protocol: Ritu's /media-stream
 * (see ritu voice/public/test-harness.html and docs/VOICE_INTEGRATION.md):
 *   up:   connected, start{customParameters.session_token}, media{payload: base64 PCM16 8 kHz}, mark, stop
 *   down: media (same encoding), mark (echo when played), clear (flush playback),
 *         oncoready_caption {role, text} (live captions, intake sessions only)
 */

const RATE = 8000;

/** connecting → ritu (speaking) → listening → thinking (heard you, preparing a reply) → ritu … → ended */
export type VoicePhase = "connecting" | "ritu" | "listening" | "thinking" | "ended" | "error";

export interface VoiceEvents {
  onPhase: (phase: VoicePhase, detail?: string) => void;
  onCaption?: (role: "ritu" | "patient", text: string) => void;
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function toBase64Pcm16(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64Pcm16(payload: string): Float32Array<ArrayBuffer> {
  const binary = atob(payload);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(binary.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

function rms(analyser: AnalyserNode | null, buf: Float32Array<ArrayBuffer>): number {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 4); // speech RMS ~0.05-0.25 → 0.2-1
}

export class RituVoice {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private levelBuf = new Float32Array(512);
  private playing: AudioBufferSourceNode[] = [];
  private playEnd = 0;
  private phase: VoicePhase = "connecting";
  private stopped = false;

  constructor(
    private wsUrl: string,
    private token: string,
    private events: VoiceEvents,
  ) {}

  private setPhase(p: VoicePhase, detail?: string) {
    if (this.phase === p && !detail) return;
    if (this.phase === "ended" && p !== "error") return;
    this.phase = p;
    this.events.onPhase(p, detail);
  }

  /** Live loudness 0..1 of Ritu's playback and of the microphone (for the animation). */
  levels(): { ritu: number; mic: number } {
    return { ritu: rms(this.outAnalyser, this.levelBuf), mic: rms(this.micAnalyser, this.levelBuf) };
  }

  async start(): Promise<void> {
    this.setPhase("connecting");
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // stop() can land while the permission prompt is open (React dev mode mounts, unmounts and
    // remounts every effect). A stopped instance must not go on to open the socket: it would spend
    // the single-use token and play Ritu's audio from a component no longer on screen.
    if (this.stopped) {
      mic.getTracks().forEach((t) => t.stop());
      return;
    }
    this.mic = mic;
    this.ctx = new AudioContext();
    this.outAnalyser = this.ctx.createAnalyser();
    this.outAnalyser.fftSize = 512;
    // Gentler playback. Phone-band (8 kHz) speech concentrates its energy in the 2-4 kHz
    // "presence" band, which is what reads as shrill on laptop speakers. Soften it, add a
    // little low-end warmth, and sit slightly below full scale.
    const warmth = this.ctx.createBiquadFilter();
    warmth.type = "lowshelf";
    warmth.frequency.value = 300;
    warmth.gain.value = 3;
    const soften = this.ctx.createBiquadFilter();
    soften.type = "highshelf";
    soften.frequency.value = 2200;
    soften.gain.value = -6;
    const level = this.ctx.createGain();
    level.gain.value = 0.85;
    this.outAnalyser.connect(warmth).connect(soften).connect(level).connect(this.ctx.destination);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;

    const source = this.ctx.createMediaStreamSource(this.mic);
    source.connect(this.micAnalyser);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    source.connect(this.processor);
    this.processor.connect(this.ctx.destination); // required for onaudioprocess to fire; outputs silence
    this.processor.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const payload = toBase64Pcm16(downsample(e.inputBuffer.getChannelData(0), this.ctx!.sampleRate, RATE));
      this.ws.send(JSON.stringify({ event: "media", media: { payload } }));
    };

    const id = Math.random().toString(36).slice(2, 11);
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({ event: "connected" }));
      this.ws!.send(
        JSON.stringify({
          event: "start",
          start: {
            streamSid: `ob_${id}`,
            callSid: `ob_${id}`,
            customParameters: { session_token: this.token, callSource: "oncoready_browser" },
          },
        }),
      );
    };
    this.ws.onmessage = (ev) => this.handle(ev.data);
    this.ws.onerror = () => this.setPhase("error", "Connection to Ritu failed");
    this.ws.onclose = () => {
      this.cleanup();
      this.setPhase("ended");
    };
  }

  private handle(raw: string) {
    let msg: { event?: string; media?: { payload?: string }; mark?: { name?: string }; role?: string; text?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event === "media" && msg.media?.payload && this.ctx && this.outAnalyser) {
      const samples = fromBase64Pcm16(msg.media.payload);
      const buffer = this.ctx.createBuffer(1, samples.length, RATE);
      buffer.copyToChannel(samples, 0);
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.outAnalyser);
      const at = Math.max(this.ctx.currentTime, this.playEnd);
      node.start(at);
      this.playEnd = at + buffer.duration;
      this.playing.push(node);
      node.onended = () => {
        this.playing = this.playing.filter((n) => n !== node);
        if (!this.playing.length && this.phase === "ritu") this.setPhase("listening");
      };
      this.setPhase("ritu");
    } else if (msg.event === "mark" && msg.mark?.name) {
      // Echo once our playback reaches this point, as the phone network would.
      const wait = this.ctx ? Math.max(0, (this.playEnd - this.ctx.currentTime) * 1000) : 0;
      const name = msg.mark.name;
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event: "mark", mark: { name } }));
        if (name === "ritu_done" && !this.playing.length) this.setPhase("listening");
      }, wait);
    } else if (msg.event === "clear") {
      this.playing.forEach((n) => n.stop());
      this.playing = [];
      this.playEnd = this.ctx?.currentTime ?? 0;
      this.setPhase("listening");
    } else if (msg.event === "oncoready_caption" && (msg.role === "ritu" || msg.role === "patient") && msg.text) {
      this.events.onCaption?.(msg.role, msg.text);
      if (msg.role === "patient" && this.phase !== "ritu") this.setPhase("thinking");
    }
  }

  stop() {
    this.stopped = true;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event: "stop" }));
    this.ws?.close();
    this.cleanup();
  }

  private cleanup() {
    this.processor?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.playing.forEach((n) => n.stop());
    this.playing = [];
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close();
    this.processor = null;
    this.mic = null;
    this.outAnalyser = null;
    this.micAnalyser = null;
  }
}
