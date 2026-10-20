import { describe, expect, it } from 'vitest';
import { createDefaultState as shippedState } from './defaults';
import { placesWorkedBy } from './places';
import { FakeScheduler } from './scheduler';
import { createBoxSession } from './session';
import { ThroughWorkings } from './throughTrains';
import { TimetableRunner } from './timetableRunner';
import { addTimetable, addTrain, findTimetable } from './timetables';
import type { AppState, Location } from './types';

/** Sigsim Central with its box being worked (both lines opened), and a runner for its layout. */
function setup(opts: { worked?: boolean; minutes?: number; operator?: 'simulated' | 'me'; open?: boolean } = {}) {
  const state: AppState = shippedState();
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
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
  const tick = (ms = 4000) => sched.advance(ms);
  const openLine = (s: (typeof sessions)[number]) => {
    s.controller.sendBell('1');
    tick();
    s.controller.sendBell('5-5-5');
    tick(8000);
  };
  if (opts.open !== false) for (const s of sessions) openLine(s);
  const runner = new TimetableRunner({
    getState: () => state,
    scheduler: sched,
    layoutId: 'layout1',
    box: (id) => (opts.worked === false || id !== box.id ? null : { sessions, workings }),
    moveLoco: (id, loc: Location) => {
      const l = state.roster.find((x) => x.id === id);
      if (l) l.location = loc;
    },
    setWorking: (id, w) => {
      const l = state.roster.find((x) => x.id === id);
      if (l) Object.assign(l.working, w);
    },
    minutesOfDay: () => opts.minutes ?? 9 * 60,
    autoMoveMs: 5000,
  });
  const [west, east] = sessions.map((s) => s.controller);
  const item = (id: string) => runner.items.find((x) => x.id === id)!;
  const loco = (id: string) => state.roster.find((l) => l.id === id)!;
  return { state, sched, tick, runner, west, east, workings, item, loco, sessions, openLine, tt: (id: string) => findTimetable(state, id)!.tt };
}

/** Receive the train being offered on a line into a road, all the way to Train out of section. */
function receive(t: ReturnType<typeof setup>, c: typeof t.west, code: string, at: { placeId: string; roadId: string }) {
  t.tick();
  c.sendBell('1');
  t.tick();
  c.sendBell(code);
  c.setInstrument('LC');
  t.tick(8000);
  c.sendBell('2');
  c.setInstrument('TOL');
  t.tick();
  c.confirmIncomingArrived(at);
  c.sendBell('1');
  t.tick();
  c.sendBell('2-1');
  t.tick();
  c.setInstrument('LB');
  t.tick();
}

describe('timetable runner', () => {
  it('works each move as the route through the boxes needs', () => {
    const t = setup();
    t.runner.load(t.tt('tt-sgc-sequence'));
    const kinds = (id: string) => t.runner.segmentsFor({ ...t.item(id), locoId: 'x' }).map((s) => (s.kind === 'through' ? `through:${s.fromConnId}>${s.toConnId}` : 'connId' in s ? `${s.kind}:${s.connId}` : s.kind));
    expect(kinds('seq-ex1')).toEqual(['through:sgc-west>sgc-east']);
    expect(kinds('seq-st1')).toEqual(['incoming:sgc-east']);
    expect(kinds('seq-st2')).toEqual(['shunt']);
    expect(kinds('seq-pg1')).toEqual(['outgoing:sgc-east']);
    expect(kinds('seq-cl1')).toEqual(['incoming:sgc-west']);
    // Where the incoming coal train is to go, and the road the pick-up goods is to run into.
    const cl1 = t.runner.segmentsFor({ ...t.item('seq-cl1'), locoId: 'x' })[0];
    expect(cl1).toMatchObject({ dest: { kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-siding' } });
  });

  it('runs an operations sequence: offers, arrivals, shunt cards and departures', () => {
    const t = setup();
    t.runner.load(t.tt('tt-sgc-sequence'));
    t.runner.start();
    // Step 1: the express is offered by Fiddle Yard West and routed through to the east.
    expect(t.west.view.incoming).toMatchObject({ locoId: 'lms6233', trainTypeId: 'express_passenger' });
    expect(t.workings.route('sgc-west')).toBe('sgc-east');
    expect(t.item('seq-st1').state).toBe('waiting');
    // Marked done before it leaves: the offer is withdrawn and the loco is put where it ends.
    expect(t.runner.markDone('seq-ex1')).toBeNull();
    expect(t.west.view.incoming).toBeNull();
    expect(t.loco('lms6233').location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road2' });
    // Step 2: the stopper is offered from the east, working as an ordinary passenger.
    expect(t.east.view.incoming).toMatchObject({ locoId: 'lms5025', trainTypeId: 'ordinary_passenger' });
    expect(t.runner.arrivalHint('sigsim-central', 'sgc-east', 'lms5025')).toEqual({ placeId: 'sgc-station', roadId: 'sgc-p2' });
    receive(t, t.east, '3-1', { placeId: 'sgc-station', roadId: 'sgc-p2' });
    expect(t.item('seq-st1').state).toBe('done');
    // Step 3: the light engine shunt (a card) and the pick-up goods released with it (a departure).
    expect(t.item('seq-st2').card?.kind).toBe('shunt');
    expect(t.loco('lms5025').working.trainTypeId).toBe('light_engine');
    expect(t.east.view.outgoing).toMatchObject({ locoId: 'lms7298', trainTypeId: 'pickup_goods' });
    expect(t.runner.guidance('sigsim-central')?.text).toMatch(/due to depart to Fiddle Yard East/);
    expect(t.runner.departureRoad('sigsim-central', 'sgc-east', 'lms7298')).toBe('fye-road3');
    t.runner.done('seq-st2');
    expect(t.loco('lms5025').location).toEqual({ kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-shed' });
    // The next step waits for the departure to finish.
    expect(t.item('seq-st3').state).toBe('waiting');
    t.runner.skip('seq-pg1');
    expect(t.east.view.outgoing).toBeNull();
    expect(t.item('seq-st3').state).toBe('active');
  });

  it('a through express is done once it has arrived at the far end, and the next move follows', () => {
    const t = setup();
    t.runner.load(t.tt('tt-sgc-sequence'));
    t.runner.start();
    t.tick();
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('4');
    t.west.setInstrument('LC');
    t.tick(500);
    // Offered on to the east, which accepts; the west despatches it.
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('4');
    t.tick(8000);
    t.west.sendBell('2');
    t.west.setInstrument('TOL');
    t.tick();
    t.east.sendBell('2');
    t.tick();
    t.west.confirmIncomingArrived(null, { moveLoco: false });
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('2-1');
    t.tick();
    t.west.setInstrument('LB');
    t.tick();
    expect(t.item('seq-ex1').state).toBe('active');
    expect(t.runner.departureRoad('sigsim-central', 'sgc-east', 'lms6233')).toBe('fye-road2');
    t.east.confirmOutgoingArrived('fye-road2', 'lms6233');
    t.tick(5000);
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('2-1');
    t.tick();
    expect(t.item('seq-ex1').state).toBe('done');
    expect(t.loco('lms6233').location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road2' });
    expect(t.workings.route('sgc-west')).toBe('');
    expect(t.east.view.incoming).toMatchObject({ locoId: 'lms5025' });
  });

  it('runs a session clock: moves are released at their times, any loco is found by its job', () => {
    const t = setup();
    const tt = t.tt('tt-sgc-morning');
    // The pick-up goods worked by any loco with the job.
    tt.trains.find((x) => x.id === 'tr-pickup')!.locoId = '';
    t.runner.load(tt);
    t.runner.start();
    expect(t.runner.clockNow()).toBe(9 * 60);
    expect(t.item('ex1').state).toBe('active');
    expect(t.item('st1').state).toBe('waiting');
    t.runner.skip('ex1');
    t.tick(15 * 60_000);
    expect(Math.round(t.runner.clockNow()!)).toBe(9 * 60 + 15);
    expect(t.item('st1').state).toBe('active');
    expect(t.item('st1').late).toBe(0);
    // Pausing holds the clock.
    t.runner.pause(true);
    t.tick(30 * 60_000);
    expect(Math.round(t.runner.clockNow()!)).toBe(9 * 60 + 15);
    expect(t.item('pg1').state).toBe('waiting');
    t.runner.pause(false);
    // Release by hand: the pick-up goods goes now, worked by the Jinty (its job, standing in the goods siding).
    t.runner.skip('st1');
    expect(t.runner.releaseNow('pg1')).toBeNull();
    expect(t.item('pg1').locoId).toBe('lms7298');
  });

  it('a real-time timetable started late can skip the moves whose time has passed', () => {
    const t = setup({ minutes: 10 * 60 });
    const tt = t.tt('tt-sgc-morning');
    tt.timing = 'clock';
    expect(t.runner.pastCount(tt)).toBe(7);
    t.runner.load(tt);
    t.runner.start({ past: 'skip' });
    expect(t.runner.items.filter((x) => x.state === 'skipped').map((x) => x.id)).toEqual(['ex1', 'st1', 'st2', 'pg1', 'st3', 'cl1', 'st4']);
    expect(t.item('ex2').state).toBe('waiting');
  });

  it('moves no box you work signals happen by themselves, or wait for the operator', () => {
    for (const operator of ['simulated', 'me'] as const) {
      const t = setup();
      const l = t.state.layouts[0];
      const tt = addTimetable(t.state, l.id, 'sequence')!;
      const { entry } = addTrain(t.state, l, tt, { locoId: 'lms6233' })!;
      entry.kind = 'leave';
      entry.from = { placeId: 'fy-west', roadId: 'fyw-road1' };
      t.runner.load(tt);
      t.runner.start({ operator });
      const it0 = t.runner.items[0];
      if (operator === 'me') {
        expect(it0.card?.kind).toBe('operator');
        expect(it0.card?.text).toMatch(/Take 6233 Duchess of Sutherland off the layout/);
        t.runner.done(it0.id);
      } else {
        expect(it0.card).toBeNull();
        t.tick(6000);
      }
      expect(it0.state).toBe('done');
      expect(t.loco('lms6233').location).toEqual({ kind: 'offLayout' });
    }
  });

  it('a box nobody is working: its moves are simulated too', () => {
    const t = setup({ worked: false });
    t.runner.load(t.tt('tt-sgc-sequence'));
    t.runner.start();
    expect(t.item('seq-ex1').segs[0].kind).toBe('auto');
    t.tick(6000);
    expect(t.loco('lms6233').location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road2' });
    expect(t.item('seq-st1').state).toBe('active');
  });

  it('switches timetable on the fly: moves under way finish, then positioning moves, then the new timetable', () => {
    const t = setup();
    t.runner.load(t.tt('tt-sgc-sequence'));
    t.runner.start();
    expect(t.item('seq-ex1').state).toBe('active');
    // The express has been accepted from the west when we switch.
    t.tick();
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('4');
    t.west.setInstrument('LC');
    t.tick(500);
    expect(t.west.view.incoming?.acceptedAt).not.toBeNull();
    const morning = t.tt('tt-sgc-morning');
    // The express will end up in FYE road 2, but the morning service starts it in FYW road 1.
    const pos = t.runner.positioningFor(morning);
    expect(pos.map((p) => [p.locoId, p.entry.kind, p.entry.from.placeId, p.entry.to.placeId])).toEqual([['lms6233', 'run', 'fy-east', 'fy-west']]);
    t.runner.switchTo(morning, { positioning: pos });
    const ids = t.runner.items.map((x) => x.id);
    expect(ids.slice(0, 2)).toEqual(['seq-ex1', pos[0].entry.id]);
    expect(t.runner.items[0].finishing).toBe(true);
    // The positioning move waits for the express to finish its run.
    expect(t.runner.items[1].state).toBe('waiting');
    expect(t.item('ex1').state).toBe('waiting');
  });

  it('switching drops a move only offered (not yet accepted): its offer is withdrawn', () => {
    const t = setup();
    t.runner.load(t.tt('tt-sgc-sequence'));
    t.runner.start();
    expect(t.west.view.incoming?.locoId).toBe('lms6233');
    const morning = t.tt('tt-sgc-morning');
    expect(t.runner.positioningFor(morning)).toEqual([]);
    t.runner.switchTo(morning);
    expect(t.runner.items.some((x) => x.finishing)).toBe(false);
    // The morning service's express is offered afresh.
    expect(t.item('ex1').state).toBe('active');
    expect(t.west.view.incoming?.locoId).toBe('lms6233');
  });

  it('waits for the box to be open on every line before anything happens (and the session clock waits too)', () => {
    const t = setup({ open: false });
    t.runner.load(t.tt('tt-sgc-morning'));
    t.runner.start();
    expect(t.runner.waitingForOpen()).toBe('Sigsim Central');
    expect(t.item('ex1').state).toBe('waiting');
    // Opening one line is not enough: an offer now could not be answered while the other line is being opened.
    t.openLine(t.sessions[0]);
    t.tick(60_000);
    expect(t.west.view.incoming).toBeNull();
    expect(t.runner.clockNow()).toBe(9 * 60);
    t.openLine(t.sessions[1]);
    t.tick(1500);
    expect(t.runner.waitingForOpen()).toBeNull();
    expect(t.west.view.incoming?.locoId).toBe('lms6233');
    expect(t.west.log.some((e) => /Timetable: 1E01 The Express/.test(e.text))).toBe(true);
  });

  it('a simulated fiddle yard operator reports a departure arrived at the far end', () => {
    const t = setup();
    const l = t.state.layouts[0];
    const tt = addTimetable(t.state, l.id, 'sequence')!;
    const { entry } = addTrain(t.state, l, tt, { locoId: 'lms7298' })!;
    entry.trainTypeId = 'pickup_goods';
    entry.to = { placeId: 'fy-east', roadId: 'fye-road3' };
    t.runner.load(tt);
    t.runner.start();
    expect(t.east.view.outgoing?.locoId).toBe('lms7298');
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('3');
    t.tick();
    expect(t.east.view.remoteInstrument).toBe('LC');
    t.east.sendBell('2');
    t.tick();
    expect(t.east.view.outgoing?.departed).toBe(true);
    expect(t.runner.autoArrivalAt('sigsim-central', 'sgc-east')).not.toBeNull();
    expect(t.runner.items[0].status).toMatch(/simulated operator reports it arrived/);
    t.tick(9000);
    expect(t.east.view.outgoing?.arrived).toBe(true);
    t.tick(5000);
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('2-1');
    t.tick();
    expect(t.runner.items[0].state).toBe('done');
    expect(t.loco('lms7298').location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road3' });
  });
});
