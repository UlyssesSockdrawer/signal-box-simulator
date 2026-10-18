import { realScheduler } from '../core/scheduler';
import { createBoxSession, type SectionSession } from '../core/session';
import type { BoxDef, Location } from '../core/types';
import type { Ctx } from './app';

/**
 * The running state of a signal box (controllers, simulated neighbours,
 * trains in section), kept alive while the user visits other screens such
 * as Settings, so they can come straight back to the box mid-train.
 * It is rebuilt only when the box's configuration changes.
 */
export interface ConnRuntime {
  session: SectionSession;
  lastBell: { code: string; hold: boolean } | null;
  /** Set by the box screen while it is showing, to flash the bell on each beat. */
  onBeat: ((beat: number) => void) | null;
}

export interface BoxRuntime {
  boxId: string;
  signature: string;
  conns: ConnRuntime[];
  dispose(): void;
  /** Called after the box has been closed (7-5-5) and reset to its cold, unopened state. */
  onReset(fn: () => void): () => void;
}

/** Time to let the closing acknowledgement ring out before the box resets. */
const RESET_AFTER_CLOSE_MS = 2500;

const cache = new Map<string, BoxRuntime>();

function signatureOf(ctx: Ctx, box: BoxDef): string {
  const modes = box.connections.map((c) => ctx.store.state.settings.workingModes[c.id] ?? c.defaultWorking);
  return JSON.stringify([box.name, box.shortName, box.connections, modes]);
}

export function getBoxRuntime(ctx: Ctx, box: BoxDef): BoxRuntime {
  const sig = signatureOf(ctx, box);
  let rt = cache.get(box.id);
  if (rt && rt.signature !== sig) {
    rt.dispose();
    rt = undefined;
  }
  if (rt) return rt;

  const store = ctx.store;
  const origins = new Map<string, Location>();
  const sessions = createBoxSession(box, () => store.state, realScheduler);
  const offs: Array<() => void> = [];
  const resetListeners = new Set<() => void>();
  let resetTimer: number | null = null;
  const conns: ConnRuntime[] = sessions.map((session) => {
    const cr: ConnRuntime = { session, lastBell: null, onBeat: null };
    const c = session.controller;
    // Trains move around the layout as they are signalled.
    offs.push(
      c.events.on('locoMoved', ({ locoId, location }) => {
        store.update((s) => {
          const l = s.roster.find((x) => x.id === locoId);
          if (!l) return;
          if (location.kind === 'section' && !origins.has(locoId)) origins.set(locoId, l.location);
          if (location.kind !== 'section') origins.delete(locoId);
          l.location = location;
        });
      }),
    );
    // The bell rings wherever you are in the app.
    offs.push(
      c.events.on('bellIn', ({ code, holdLast }) => {
        ctx.bell.ring(code, (beat) => {
          if (beat === 0) cr.lastBell = { code, hold: holdLast };
          cr.onBeat?.(beat);
        });
      }),
    );
    // Closing the box (7-5-5 acknowledged on every connection) puts the far signallers to sleep
    // and returns the whole box to the cold state it had when the app started.
    let wasOpen = c.view.boxOpen;
    offs.push(
      c.events.on('change', (v) => {
        if (wasOpen && !v.boxOpen) {
          const allClosed = sessions.every((s) => !s.controller.view.boxOpen);
          if (allClosed && resetTimer === null) {
            resetTimer = window.setTimeout(() => {
              resetTimer = null;
              runtime.dispose();
              for (const fn of [...resetListeners]) fn();
            }, RESET_AFTER_CLOSE_MS);
          }
        }
        wasOpen = v.boxOpen;
      }),
    );
    return cr;
  });

  const runtime: BoxRuntime = {
    boxId: box.id,
    signature: sig,
    conns,
    onReset: (fn) => {
      resetListeners.add(fn);
      return () => resetListeners.delete(fn);
    },
    dispose: () => {
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = null;
      for (const off of offs) off();
      for (const s of sessions) s.neighbour?.dispose();
      if (cache.get(box.id) === runtime) cache.delete(box.id);
      // Any train left "in section" goes back where it started.
      if (origins.size) {
        store.update((s) => {
          for (const [id, loc] of origins) {
            const l = s.roster.find((x) => x.id === id);
            if (l && l.location.kind === 'section') l.location = loc;
          }
        });
      }
    },
  };
  cache.set(box.id, runtime);
  for (const s of sessions) s.neighbour?.start();
  return runtime;
}

/** Stop a box's running state, e.g. when the box is deleted. */
export function disposeBoxRuntime(boxId: string): void {
  cache.get(boxId)?.dispose();
}
