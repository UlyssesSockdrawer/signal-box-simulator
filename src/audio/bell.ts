import { codeToGroups } from '../core/bellcodes';
import type { BellCode, Settings } from '../core/types';
import { DEFAULT_BELL } from './bellData.generated';

/**
 * Plays block bell codes. Each beat plays the bell recording (the built-in
 * one, or a file loaded in Settings), or a synthesised strike if chosen.
 */
export class BellPlayer {
  private ctx: AudioContext | null = null;
  private sample: AudioBuffer | null = null;
  private sampleSource = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(private settings: () => Settings) {}

  /** Must be called from a user gesture (browsers block sound until then). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private async loadSample(): Promise<void> {
    const s = this.settings();
    const url = s.bellSynth ? '' : s.bellSoundDataUrl || DEFAULT_BELL;
    if (url === this.sampleSource) return;
    this.sampleSource = url;
    this.sample = null;
    if (!url || !this.ctx) return;
    try {
      const comma = url.indexOf(',');
      const bin = atob(url.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      this.sample = await this.ctx.decodeAudioData(bytes.buffer);
    } catch {
      this.sample = null;
    }
  }

  /** One strike of the bell, at audio time `when`. */
  private strike(when: number, gain: number): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(ctx.destination);
    if (this.sample) {
      const src = ctx.createBufferSource();
      src.buffer = this.sample;
      src.connect(out);
      src.start(when);
      return;
    }
    // Synth: a few inharmonic partials with fast attack and long decay, like a small gong bell.
    const base = 1180;
    const partials: Array<[number, number, number]> = [
      [1, 0.55, 1.6],
      [2.41, 0.25, 0.9],
      [3.87, 0.12, 0.55],
      [5.2, 0.06, 0.35],
    ];
    for (const [ratio, amp, decay] of partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = base * ratio;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(amp, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      osc.connect(g).connect(out);
      osc.start(when);
      osc.stop(when + decay + 0.05);
    }
    // Clapper "tick" transient
    const noiseLen = Math.floor(ctx.sampleRate * 0.015);
    const buf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
    const n = ctx.createBufferSource();
    const ng = ctx.createGain();
    ng.gain.value = 0.25;
    n.buffer = buf;
    n.connect(ng).connect(out);
    n.start(when);
  }

  /**
   * Ring a code. onBeat is called (on the main thread) as each beat sounds,
   * so the UI can flash the bell. Codes queue up rather than overlapping.
   */
  ring(code: BellCode, onBeat: (beatIndex: number, groupIndex: number) => void = () => {}, onDone: () => void = () => {}): void {
    this.queue = this.queue.then(() => this.ringNow(code, onBeat)).then(onDone, onDone);
  }

  private async ringNow(code: BellCode, onBeat: (beat: number, group: number) => void): Promise<void> {
    const s = this.settings();
    const groups = codeToGroups(code);
    if (this.ctx) await this.loadSample();
    const ctx = this.ctx;
    const startAudio = ctx ? ctx.currentTime + 0.05 : 0;
    let offset = 0;
    let beat = 0;
    const timers: Promise<void>[] = [];
    groups.forEach((count, gi) => {
      for (let i = 0; i < count; i++) {
        const at = offset;
        const b = beat++;
        if (ctx && ctx.state === 'running') this.strike(startAudio + at / 1000, s.volume);
        timers.push(
          new Promise((res) =>
            setTimeout(() => {
              onBeat(b, gi);
              if (s.vibrate && 'vibrate' in navigator) {
                try {
                  navigator.vibrate(40);
                } catch {
                  /* ignore */
                }
              }
              res();
            }, at + 50),
          ),
        );
        offset += s.bellBeatMs;
      }
      offset += s.bellGroupPauseMs - s.bellBeatMs;
    });
    await Promise.all(timers);
    await new Promise((r) => setTimeout(r, 400));
  }

  /** Short dull click for the user's own tapper presses. */
  click(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.settings().tapperClick) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 180;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * this.settings().volume, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  }
}
