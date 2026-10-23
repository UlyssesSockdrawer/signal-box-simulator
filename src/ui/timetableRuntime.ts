import { realScheduler } from '../core/scheduler';
import { TimetableRunner } from '../core/timetableRunner';
import type { Ctx } from './app';
import { peekBoxRuntime } from './boxRuntime';

/*
 * One timetable runner per layout, kept for the app session (like the boxes' running state):
 * started from a signal box's Timetable panel, it keeps running while you visit other screens.
 * Boxes take part when they are being worked (their screen has been opened).
 */
const runners = new Map<string, TimetableRunner>();
const listeners = new Set<(layoutId: string) => void>();

/** Hear about any timetable's progress (a move released, a card waiting, the clock…). */
export function onRunnerChange(fn: (layoutId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getRunner(ctx: Ctx, layoutId: string): TimetableRunner {
  let r = runners.get(layoutId);
  if (r) return r;
  const store = ctx.store;
  r = new TimetableRunner({
    getState: () => store.state,
    scheduler: realScheduler,
    layoutId,
    box: (boxId) => {
      const rt = peekBoxRuntime(boxId);
      const box = store.state.boxes.find((b) => b.id === boxId);
      if (!rt || !box || box.layoutId !== layoutId) return null;
      const sim = rt.sim;
      return {
        sessions: rt.conns.map((c) => c.session),
        workings: rt.workings,
        mode: rt.mode,
        trains: rt.trains,
        railway: sim ? { shunt: (b, l, to, done, o) => sim.shunt(b, l, to, done, o), runRound: (b, l, done) => sim.runRound(b, l, done), prepareDeparture: (b, l, c) => sim.prepareDeparture(b, l, c) } : undefined,
      };
    },
    moveLoco: (id, loc) =>
      store.update((s) => {
        const l = s.roster.find((x) => x.id === id);
        if (l) l.location = loc;
      }),
    setWorking: (id, w) =>
      store.update((s) => {
        const l = s.roster.find((x) => x.id === id);
        if (l) Object.assign(l.working, w);
      }),
  });
  runners.set(layoutId, r);
  r.events.on('change', () => {
    for (const fn of [...listeners]) fn(layoutId);
  });
  return r;
}

/** The layout's runner if one has been made (does not make one). */
export function peekRunner(layoutId: string | undefined): TimetableRunner | undefined {
  return layoutId ? runners.get(layoutId) : undefined;
}

/** Stop every timetable (e.g. before all data is reset or replaced). */
export function disposeAllRunners(): void {
  for (const r of runners.values()) r.dispose();
  runners.clear();
}
