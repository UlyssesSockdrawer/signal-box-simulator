import type { BellCode, TapSettings } from './types';
import type { Scheduler } from './scheduler';

export interface TapProgress {
  groups: number[];
  pressed: boolean;
  holding: boolean;
}

/**
 * Turns presses of the bell tapper into a bell code by timing the pauses.
 *  - a pause longer than groupGapMs between beats starts a new group (3 … 1 → "3-1")
 *  - silence longer than codeEndMs after the last beat ends the code
 *  - a last beat held for holdMs or more is reported as holdLast (token release)
 */
export class TapDecoder {
  private groups: number[] = [];
  private pressedAt: number | null = null;
  private lastReleaseAt: number | null = null;
  private lastHeld = false;
  private endTimer: number | null = null;
  private holdTimer: number | null = null;
  private holding = false;

  constructor(
    private settings: () => TapSettings,
    private scheduler: Scheduler,
    private onCode: (code: BellCode, holdLast: boolean) => void,
    private onProgress: (p: TapProgress) => void = () => {},
  ) {}

  press(): void {
    if (this.pressedAt !== null) return;
    const now = this.scheduler.now();
    if (this.endTimer !== null) {
      this.scheduler.clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    const s = this.settings();
    if (this.groups.length === 0 || this.lastReleaseAt === null || now - this.lastReleaseAt > s.groupGapMs) {
      this.groups.push(1);
    } else {
      this.groups[this.groups.length - 1]++;
    }
    this.pressedAt = now;
    this.lastHeld = false;
    this.holdTimer = this.scheduler.setTimeout(() => {
      this.holding = true;
      this.progress();
    }, s.holdMs);
    this.progress();
  }

  release(): void {
    if (this.pressedAt === null) return;
    const now = this.scheduler.now();
    const s = this.settings();
    this.lastHeld = now - this.pressedAt >= s.holdMs;
    this.pressedAt = null;
    this.lastReleaseAt = now;
    this.holding = false;
    if (this.holdTimer !== null) this.scheduler.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.endTimer = this.scheduler.setTimeout(() => this.finish(), s.codeEndMs);
    this.progress();
  }

  /** Abandon whatever has been tapped so far. */
  reset(): void {
    if (this.endTimer !== null) this.scheduler.clearTimeout(this.endTimer);
    if (this.holdTimer !== null) this.scheduler.clearTimeout(this.holdTimer);
    this.endTimer = this.holdTimer = null;
    this.groups = [];
    this.pressedAt = this.lastReleaseAt = null;
    this.holding = this.lastHeld = false;
    this.progress();
  }

  private finish(): void {
    this.endTimer = null;
    const code = this.groups.join('-');
    const held = this.lastHeld;
    this.groups = [];
    this.lastReleaseAt = null;
    this.lastHeld = false;
    this.progress();
    if (code) this.onCode(code, held);
  }

  private progress(): void {
    this.onProgress({ groups: [...this.groups], pressed: this.pressedAt !== null, holding: this.holding });
  }
}
