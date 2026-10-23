import { createDefaultState as shippedState } from './defaults';
import { OccupancyBoard } from './occupancy';
import { placesWorkedBy } from './places';
import { RailwaySim } from './railwaySim';
import { FakeScheduler } from './scheduler';
import { createBoxSession } from './session';
import { ThroughWorkings } from './throughTrains';
import { connectTrainEvents, type RunningMode } from './trainEvents';
import { TimetableRunner } from './timetableRunner';
import type { AppState } from './types';

/*
 * Test harness: Sigsim Central worked in signaller play mode on a simulated railway with a fake
 * clock (used by the simulated running and interlocking tests).
 */

/** Sigsim Central worked in signaller play mode on the simulated railway. */
export function play(opts: { state?: AppState; mode?: RunningMode; scale?: number } = {}) {
  const state = opts.state ?? shippedState();
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  state.settings.timeScale = opts.scale ?? 10;
  const box = state.boxes[0];
  const sched = new FakeScheduler();
  const sessions = createBoxSession(box, () => state, sched);
  for (const s of sessions) {
    s.controller.events.on('locoMoved', (m) => {
      const l = state.roster.find((x) => x.id === m.locoId);
      if (l) l.location = m.location;
    });
    s.neighbour!.start();
  }
  const workings = new ThroughWorkings(sessions, {
    worksPlaces: () => placesWorkedBy(state, box.id).length > 0,
    codeSet: () => state.codeSets[0],
    trainTypes: () => state.trainTypes,
    locoLabel: (id) => id,
  });
  const board = new OccupancyBoard();
  const sim = new RailwaySim({ getState: () => state, scheduler: sched, layoutId: box.layoutId, board, update: (fn) => fn(state) });
  const trains = connectTrainEvents(opts.mode ?? 'play', sessions, workings, {
    board,
    detection: { arrived: (c) => !!sim.incoming(box.id, c)?.arrivedDetected, passed: (c) => !!sim.incoming(box.id, c)?.passedDetected },
  });
  if ((opts.mode ?? 'play') === 'play') sim.attach({ boxId: box.id, sessions, workings, source: trains.source });
  const tick = (ms = 4000) => sched.advance(ms);
  for (const s of sessions) {
    s.controller.sendBell('1');
    tick();
    s.controller.sendBell('5-5-5');
    tick(8000);
  }
  const [west, east] = sessions.map((s) => s.controller);
  const code = (id: string) => state.layouts[0].trackPlan.circuits.find((c) => c.id === id)?.code ?? id;
  const occupied = () => board.occupiedIds().map(code).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const loco = (id: string) => state.roster.find((l) => l.id === id)!;
  /** Run until the condition holds (or give up after `max` ms), collecting circuits seen occupied by a loco. */
  const until = (cond: () => boolean, max = 600_000) => {
    for (let t = 0; t < max && !cond(); t += 500) tick(500);
    return cond();
  };
  const runner = new TimetableRunner({
    getState: () => state,
    scheduler: sched,
    layoutId: box.layoutId,
    box: (id) => (id === box.id ? { sessions, workings, mode: trains.mode, trains: trains.source, railway: trains.mode === 'play' ? { shunt: (b, l, to, done, o) => sim.shunt(b, l, to, done, o), runRound: (b, l, done) => sim.runRound(b, l, done), prepareDeparture: (b, l, c) => sim.prepareDeparture(b, l, c) } : undefined } : null),
    moveLoco: (id, loc) => {
      const l = state.roster.find((x) => x.id === id);
      if (l) l.location = loc;
    },
    setWorking: (id, w) => {
      const l = state.roster.find((x) => x.id === id);
      if (l) Object.assign(l.working, w);
    },
    minutesOfDay: () => 9 * 60,
    autoMoveMs: 5000,
  });
  return { state, box, sched, sessions, workings, board, sim, trains, tick, west, east, occupied, loco, until, code, runner };
}

/** Accept the train offered on a line and acknowledge Train entering section. */
export function accept(t: ReturnType<typeof play>, c: typeof t.west, bell: string) {
  t.tick();
  c.sendBell('1');
  t.tick();
  c.sendBell(bell);
  c.setInstrument('LC');
  t.tick(8000);
  c.sendBell('2');
  c.setInstrument('TOL');
  t.tick(500);
}

