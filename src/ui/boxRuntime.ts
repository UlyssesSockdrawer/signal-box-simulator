import { realScheduler } from '../core/scheduler';
import { Scorecard } from '../core/score';
import { placesWorkedBy } from '../core/places';
import { ThroughWorkings } from '../core/throughTrains';
import { BoxReferee } from '../core/referee';
import { BoxRegulator } from '../core/regulating';
import { incomingCandidates } from '../core/selection';
import { createBoxSession, locoLabel, type SectionSession } from '../core/session';
import { connectTrainEvents, DEFAULT_RUNNING_MODE, type BoxTrains, type RunningMode, type TrainEventSource } from '../core/trainEvents';
import type { BoxDef, Location } from '../core/types';
import type { Ctx } from './app';
import { getLayoutRailway, type LayoutRailway } from './railwayRuntime';
import type { RailwaySim } from '../core/railwaySim';

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
  /**
   * How this session of the box is run (model railway or signaller play). It belongs to the box
   * session, not to the layout or the box: chosen when the box is opened, kept until the box is
   * closed. (Every box opens in model railway mode until the choice is offered.)
   */
  mode: RunningMode;
  /** Where the signalling learns what trains did: report movements here (buttons, simulated operator). */
  trains: TrainEventSource;
  /** The box's layout's railway (occupancy board), or null for a box not on a layout. */
  railway: LayoutRailway | null;
  /** Signaller play mode: the simulated railway the box's trains run on (null in model railway mode). */
  sim: RailwaySim | null;
  conns: ConnRuntime[];
  /** The signaller's score for this session of the box (until it is closed, or a fresh score is started). */
  score: Scorecard;
  /** Trains offered on from one line to another (through trains at a box that is not the end of the line). */
  workings: ThroughWorkings;
  /** Refusals (trains held at far boxes) and regulating checks across the box's lines. */
  regulator: BoxRegulator;
  dispose(): void;
  /** Called after the box has been closed (7-5-5) and reset to its cold, unopened state. */
  onReset(fn: () => void): () => void;
}

/** Time to let the closing acknowledgement ring out before the box resets. */
const RESET_AFTER_CLOSE_MS = 2500;

const cache = new Map<string, BoxRuntime>();
/** The final score of a box that has just been closed, waiting to be shown. */
const finishedScores = new Map<string, Scorecard>();

/** The final score of the box's last session, once (it is removed when taken). */
export function takeFinishedScore(boxId: string): Scorecard | null {
  const s = finishedScores.get(boxId) ?? null;
  finishedScores.delete(boxId);
  return s;
}

function signatureOf(ctx: Ctx, box: BoxDef): string {
  const modes = box.connections.map((c) => ctx.store.state.settings.workingModes[c.id] ?? c.defaultWorking);
  return JSON.stringify([box.name, box.shortName, box.connections, modes]);
}

/** The running mode chosen when a box is next opened (taken once by the box screen). */
const openingModes = new Map<string, RunningMode>();
export function setOpeningMode(boxId: string, mode: RunningMode): void {
  openingModes.set(boxId, mode);
}
export function takeOpeningMode(boxId: string): RunningMode | undefined {
  const m = openingModes.get(boxId);
  openingModes.delete(boxId);
  return m;
}

/**
 * The box's running state, made if it is not running. `mode` is used only when a new session starts;
 * a running box keeps its mode, and a box rebuilt because its configuration changed carries its mode
 * over (it was not closed). After closing (7-5-5) the next session starts in the mode asked for.
 */
export function getBoxRuntime(ctx: Ctx, box: BoxDef, opts: { mode?: RunningMode } = {}): BoxRuntime {
  const sig = signatureOf(ctx, box);
  let rt = cache.get(box.id);
  let mode = opts.mode ?? DEFAULT_RUNNING_MODE;
  if (rt && rt.signature !== sig) {
    mode = rt.mode;
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
  const score = new Scorecard();
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
              if (score.entries.length) finishedScores.set(box.id, score.snapshot());
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

  // The far boxes referee their lines; the box's referee puts it all on the scorecard (clean working judged per train).
  const referee = new BoxReferee(sessions, score);
  const workings = new ThroughWorkings(sessions, {
    worksPlaces: () => placesWorkedBy(store.state, box.id).length > 0,
    codeSet: () => store.state.codeSets.find((c) => c.id === store.state.settings.codeSetId) ?? store.state.codeSets[0],
    trainTypes: () => store.state.trainTypes,
    locoLabel: (id) => locoLabel(store.state.roster.find((l) => l.id === id)),
  });
  const codeSet = () => store.state.codeSets.find((c) => c.id === store.state.settings.codeSetId) ?? store.state.codeSets[0];
  const regulator = new BoxRegulator(sessions, {
    scheduler: realScheduler,
    codeSet,
    trainTypes: () => store.state.trainTypes,
    settings: () => store.state.settings,
    locoLabel: (id) => locoLabel(store.state.roster.find((l) => l.id === id)),
    candidates: (conn) => incomingCandidates(store.state, conn).map((l) => ({ id: l.id, trainTypeId: l.working.trainTypeId })),
    score: (s, rule, detail, locoId) => referee.score(s, rule, detail, locoId),
  });
  // The one way in for what trains did (the box's buttons, the simulated fiddle yard operator).
  // The layout's railway: its occupancy board (hand-marked circuits in model railway mode) and, in
  // signaller play mode, the simulated railway the box's trains run on.
  const railway = box.layoutId && store.state.layouts.some((l) => l.id === box.layoutId) ? getLayoutRailway(ctx, box.layoutId) : null;
  const sim = mode === 'play' ? (railway?.sim ?? null) : null;
  const trains: BoxTrains = connectTrainEvents(mode, sessions, workings, {
    board: railway?.board,
    detection: sim
      ? { arrived: (connId) => !!sim.incoming(box.id, connId)?.arrivedDetected, passed: (connId) => !!sim.incoming(box.id, connId)?.passedDetected }
      : undefined,
  });
  const detachSim = sim ? sim.attach({ boxId: box.id, sessions, workings, source: trains.source }) : () => {};
  const runtime: BoxRuntime = {
    boxId: box.id,
    signature: sig,
    mode,
    trains: trains.source,
    railway,
    sim,
    conns,
    score,
    workings,
    regulator,
    onReset: (fn) => {
      resetListeners.add(fn);
      return () => resetListeners.delete(fn);
    },
    dispose: () => {
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = null;
      for (const off of offs) off();
      detachSim();
      trains.dispose();
      workings.dispose();
      regulator.dispose();
      referee.dispose();
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

/** A box's running state if it is being worked (its screen has been opened), without starting it. */
export function peekBoxRuntime(boxId: string): BoxRuntime | undefined {
  return cache.get(boxId);
}

/** Stop a box's running state, e.g. when the box is deleted. */
export function disposeBoxRuntime(boxId: string): void {
  cache.get(boxId)?.dispose();
}

/** Stop every running box and forget final scores, before all the app's data is replaced (reset or import). */
export function disposeAllBoxRuntimes(): void {
  for (const rt of [...cache.values()]) rt.dispose();
  cache.clear();
  finishedScores.clear();
}
