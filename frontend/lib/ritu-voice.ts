/**
 * Audio transport between the browser and the Ritu voice server. Ritu does all speech work
 * (recognition, conversation, synthesis); this only moves audio. Protocol: Ritu's /media-stream
 * (see ritu voice/public/test-harness.html and docs/VOICE_INTEGRATION.md):
 *   up:   connected, start{customParameters.session_token}, media{payload: base64 PCM16 8 kHz}, mark, stop
 *   down: media (same encoding), mark (echo when played), clear (flush playback)
 */

const RATE = 8000;

export type VoiceState = "connecting" | "live" | "ended" | "error";

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

export class RituVoice {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playing: AudioBufferSourceNode[] = [];
  private playEnd = 0;

  constructor(
    private wsUrl: string,
    private token: string,
    private onState: (state: VoiceState, detail?: string) => void,
    private onSpeaking: (who: "ritu" | "patient" | null) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.onState("connecting");
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.mic);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    this.processor.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const level = input.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      if (level > 0.08 && this.playEnd <= (this.ctx?.currentTime ?? 0)) this.onSpeaking("patient");
      const payload = toBase64Pcm16(downsample(input, this.ctx!.sampleRate, RATE));
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
      this.onState("live");
    };
    this.ws.onmessage = (ev) => this.handle(ev.data);
    this.ws.onerror = () => this.onState("error", "Connection to Ritu failed");
    this.ws.onclose = () => {
      this.cleanup();
      this.onState("ended");
    };
  }

  private handle(raw: string) {
    let msg: { event?: string; media?: { payload?: string }; mark?: { name?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event === "media" && msg.media?.payload && this.ctx) {
      const samples = fromBase64Pcm16(msg.media.payload);
      const buffer = this.ctx.createBuffer(1, samples.length, RATE);
      buffer.copyToChannel(samples, 0);
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.ctx.destination);
      const at = Math.max(this.ctx.currentTime, this.playEnd);
      node.start(at);
      this.playEnd = at + buffer.duration;
      this.playing.push(node);
      node.onended = () => {
        this.playing = this.playing.filter((n) => n !== node);
        if (!this.playing.length) this.onSpeaking(null);
      };
      this.onSpeaking("ritu");
    } else if (msg.event === "mark" && msg.mark?.name) {
      const wait = this.ctx ? Math.max(0, (this.playEnd - this.ctx.currentTime) * 1000) : 0;
      const name = msg.mark.name;
      setTimeout(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ event: "mark", mark: { name } })), wait);
    } else if (msg.event === "clear") {
      this.playing.forEach((n) => n.stop());
      this.playing = [];
      this.playEnd = this.ctx?.currentTime ?? 0;
    }
  }

  stop() {
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
  }
}
