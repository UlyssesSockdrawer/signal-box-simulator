import { describe, expect, it } from 'vitest';
import { createDefaultState as shippedState } from './defaults';
import { placesWorkedBy } from './places';
import { FakeScheduler } from './scheduler';
import { createBoxSession } from './session';
import { ThroughWorkings } from './throughTrains';
import { TimetableRunner } from './timetableRunner';
import { connectTrainEvents, type RunningMode } from './trainEvents';
import { addTimetable, addTrain, findTimetable, walkTimetable } from './timetables';
import { defaultGeneratorOptions, TimetableGenerator } from './timetableGenerator';
import type { AppState, Location, Timetable } from './types';

/** Sigsim Central with its box being worked (both lines opened), and a runner for its layout. */
function setup(opts: { worked?: boolean; minutes?: number; operator?: 'simulated' | 'me'; open?: boolean; mode?: RunningMode } = {}) {
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
  // The box session's train events, in its running mode (model railway unless a test says otherwise).
  const trains = connectTrainEvents(opts.mode ?? 'model', sessions, workings);
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
    box: (id) => (opts.worked === false || id !== box.id ? null : { sessions, workings, mode: trains.mode, trains: trains.source }),
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
  return { state, sched, tick, runner, west, east, workings, trains, item, loco, sessions, openLine, tt: (id: string) => findTimetable(state, id)!.tt };
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

/** A pick-up goods from the goods siding to Fiddle Yard East, offered and sent: on its way to the far end. */
function sendPickupToEast(t: ReturnType<typeof setup>) {
  const l = t.state.layouts[0];
  const tt = addTimetable(t.state, l.id, 'sequence')!;
  const { entry } = addTrain(t.state, l, tt, { locoId: 'lms7298' })!;
  entry.trainTypeId = 'pickup_goods';
  entry.to = { placeId: 'fy-east', roadId: 'fye-road3' };
  t.runner.load(tt);
  t.runner.start();
  t.east.sendBell('1');
  t.tick();
  t.east.sendBell('3');
  t.tick();
  t.east.sendBell('2');
  t.tick();
  expect(t.east.view.outgoing?.departed).toBe(true);
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
    // Learner prompts for a quiet line say what the timetable brings next on it.
    expect(t.runner.lineText('sigsim-central', 'sgc-east')).toMatch(/Next on this line: 1E01 The Express .* runs through to Fiddle Yard East \(step 1\): offer it on once you have accepted it from Fiddle Yard West/);
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
    // It has left Fiddle Yard West: when it should pass the box.
    expect(t.runner.dueAtBox('sigsim-central', 'sgc-west')?.through).toBe(true);
    expect(t.item('seq-ex1').status).toMatch(/due to pass Sigsim Central at about/);
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
    // The timetable log followed it all the way.
    const log = t.runner.log.map((l) => l.text).join('\n');
    expect(log).toMatch(/1E01: Accepted from Fiddle Yard West: offer it on to Fiddle Yard East/);
    expect(log).toMatch(/1E01: On its way from Fiddle Yard West, through to Fiddle Yard East/);
    expect(log).toMatch(/1E01: Sent on to Fiddle Yard East/);
    expect(log).toMatch(/1E01: Arrived at Fiddle Yard East: waiting for Fiddle Yard East to clear it back/);
    expect(log).toMatch(/Done: 1E01 The Express/);
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
    // The far box's "drive it in and press Arrived" part of the learner prompt is marked, so the box
    // can say the simulated operator does it instead.
    expect(t.east.view.guidanceDrive).toMatch(/press "Arrived/);
    expect(t.east.view.guidance).toContain(t.east.view.guidanceDrive);
    // The quiet west line says what is next there, not "choose a train and offer it".
    expect(t.west.view.guidanceIdle).toBe(true);
    expect(t.runner.lineText('sigsim-central', 'sgc-west')).toMatch(/^Timetable: the section is clear/);
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

  it("the simulated operator's arrival report goes through the box's source of train events", () => {
    const t = setup();
    const seen: string[] = [];
    t.trains.router.onApplied((e, outcome) => seen.push(`${e.type}:${'by' in e ? e.by : ''}:${outcome}`));
    sendPickupToEast(t);
    t.tick(9000);
    expect(t.east.view.outgoing?.arrived).toBe(true);
    expect(seen).toEqual(['arrivedFar:fiddleYardOperator:applied']);
    // A second report (the person pressing Arrived as well) counts for nothing.
    expect(t.trains.source.report({ type: 'arrivedFar', connectionId: 'sgc-east', locoId: 'lms7298', roadId: 'fye-road4', by: 'person' })).toBe('ignored');
    t.tick(5000);
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('2-1');
    t.tick();
    expect(t.loco('lms7298').location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road3' });
  });

  it("takes the box's running mode from its running state: the simulated operator works only in model railway mode", () => {
    const t = setup({ mode: 'play' });
    expect(t.trains.mode).toBe('play');
    sendPickupToEast(t);
    expect(t.runner.autoArrivalAt('sigsim-central', 'sgc-east')).toBeNull();
    expect(t.runner.items[0].status).toMatch(/the railway reports it/);
    t.tick(30_000);
    expect(t.east.view.outgoing?.arrived).toBeFalsy();
    // With no simulated railway attached (this test wires none), a movement can still be reported.
    expect(t.trains.source.report({ type: 'arrivedFar', connectionId: 'sgc-east', locoId: 'lms7298', roadId: 'fye-road3', by: 'person' })).toBe('applied');
    expect(t.east.view.outgoing?.arrived).toBe(true);
  });

  it('runs Endless: keeps six moves waiting in a sequence, and never finishes', () => {
    const t = setup({ worked: false });
    const opts = { ...defaultGeneratorOptions('sequence'), seed: 5 };
    const tt: Timetable = { id: 'endless', name: 'Endless', timing: 'sequence', startAt: 540, elapsed: false, speed: 1, validity: '', notes: '', trains: [], entries: [], generated: opts };
    t.runner.loadEndless(tt, new TimetableGenerator(t.state, t.state.layouts[0], opts));
    expect(t.runner.items.filter((x) => x.state === 'waiting').length).toBeGreaterThanOrEqual(6);
    t.runner.start({ operator: 'simulated' });
    for (let i = 0; i < 400; i++) {
      t.tick(2000);
      // Shunts and notes are cards: press Done as an operator would.
      for (const it of t.runner.items) if (it.state === 'active' && it.card) t.runner.done(it.id);
    }
    const done = t.runner.items.filter((x) => x.state === 'done').length;
    expect(done).toBeGreaterThan(12);
    expect(t.runner.items.filter((x) => x.state === 'waiting').length).toBeGreaterThanOrEqual(6);
    expect(t.runner.finished).toBe(false);
    // What has run so far is a proper timetable (Keep this as a timetable).
    const w = walkTimetable(t.state, t.state.layouts[0], t.runner.tt!);
    expect(w.errors).toBe(0);
  });

  it('runs Endless on a session clock: plans the next 15 minutes as the clock goes', () => {
    const t = setup({ worked: false });
    const opts = { ...defaultGeneratorOptions('session'), seed: 9, startAt: 600, speed: 12 };
    const tt: Timetable = { id: 'endless', name: 'Endless', timing: 'session', startAt: 600, elapsed: false, speed: 12, validity: '', notes: '', trains: [], entries: [], generated: opts };
    t.runner.loadEndless(tt, new TimetableGenerator(t.state, t.state.layouts[0], opts));
    const first = t.runner.items.length;
    expect(first).toBeGreaterThan(0);
    expect(Math.max(...t.runner.items.map((x) => x.entry.dep!))).toBeLessThan(600 + 15);
    t.runner.start({ operator: 'simulated' });
    for (let i = 0; i < 300; i++) {
      t.tick(1000);
      for (const it of t.runner.items) if (it.state === 'active' && it.card) t.runner.done(it.id);
    }
    // 300 s at twelve times = an hour of clock: more trains planned, none beyond 15 minutes ahead.
    const now = t.runner.clockNow()!;
    expect(now).toBeGreaterThan(650);
    expect(t.runner.items.length).toBeGreaterThan(first);
    expect(Math.max(...t.runner.items.map((x) => x.entry.dep!))).toBeLessThan(now + 15 + 1);
    expect(t.runner.items.filter((x) => x.state === 'done').length).toBeGreaterThan(4);
  });
});
