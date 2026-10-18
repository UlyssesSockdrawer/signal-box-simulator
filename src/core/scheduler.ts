/** Time source + timers, abstracted so tests can run with a fake clock. */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/** Deterministic scheduler for tests: call advance(ms) to move time forward. */
export class FakeScheduler implements Scheduler {
  private t = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(id: number): void {
    this.timers.delete(id);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && (tm.at < nextAt || (tm.at === nextAt && id < nextId))) {
          nextAt = tm.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const tm = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = tm.at;
      tm.fn();
    }
    this.t = end;
  }
}

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Array<(e: Events[K]) => void> } = {};
  on<K extends keyof Events>(type: K, fn: (e: Events[K]) => void): () => void {
    (this.handlers[type] ??= []).push(fn);
    return () => {
      this.handlers[type] = this.handlers[type]!.filter((h) => h !== fn);
    };
  }
  emit<K extends keyof Events>(type: K, e: Events[K]): void {
    for (const h of this.handlers[type] ?? []) h(e);
  }
}
