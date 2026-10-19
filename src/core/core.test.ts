import { describe, expect, it } from 'vitest';
import { DEFAULT_CODE_SETS, DEFAULT_TRAIN_TYPES, normaliseCode } from './bellcodes';
import { addBox, addConnection, canOpenBox, checkBoxName, checkBoxShort, checkConnName, checkShelfPositions, deleteBox, moveConnection, removeConnection, setShelfPositions } from './boxes';
import { createLinkPair } from './link';
import { trainsOnLayout } from './layoutRegister';
import { addPlace, addRoad, arrivalChoices, boxLocos, checkPlaceName, checkPlaceShort, checkRoadName, placesWorkedBy, removePlace, removeRoad, roadOfCircuit, sanitisePlaces, setConnectionPlace, setRoadCount, setWorker, tieRoad } from './places';
import { incomingCandidates } from './selection';
import { SectionController } from './sectionController';
import { createBectonState as createDefaultState } from './testState';
import { createDefaultState as shippedState } from './defaults';
import { JUNCTIONS, lineRun, localToWorld, orient, planIssues, portsOf } from './trackPlan';
import { ThroughWorkings } from './throughTrains';
import { BoxReferee } from './referee';
import { Scorecard } from './score';
import { FakeScheduler } from './scheduler';
import { createBoxSession } from './session';
import { migrate, Store } from './store';
import { layoutShelf, positionLabel } from './shelf';
import { TapDecoder } from './tapDecoder';
import type { AppState, Location, WorkingMode } from './types';

function setup(mode: WorkingMode) {
  const state: AppState = createDefaultState();
  state.settings.workingModes['becton-fy'] = mode;
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  const sched = new FakeScheduler();
  const [sess] = createBoxSession(state.boxes[0], () => state, sched);
  const c = sess.controller;
  const bellsIn: string[] = [];
  const hints: string[] = [];
  const moves: Array<{ locoId: string; location: Location }> = [];
  c.events.on('bellIn', (b) => bellsIn.push(b.code + (b.holdLast ? 'H' : '')));
  c.events.on('hint', (h) => hints.push(h.text));
  c.events.on('locoMoved', (m) => {
    moves.push(m);
    const l = state.roster.find((x) => x.id === m.locoId);
    if (l) l.location = m.location;
  });
  sess.neighbour!.start();
  const tick = (ms = 4000) => sched.advance(ms);
  // Open the box: 1, then 5-5-5.
  c.sendBell('1');
  tick();
  c.sendBell('5-5-5');
  tick(8000);
  bellsIn.length = 0;
  return { state, sched, c, nb: sess.neighbour!, bellsIn, hints, moves, tick };
}

describe('bell code helpers', () => {
  it('normalises typed codes', () => {
    expect(normaliseCode(' 3 1 ')).toBe('3-1');
    expect(normaliseCode('2–2–1')).toBe('2-2-1');
    expect(normaliseCode('16')).toBe('16');
    expect(normaliseCode('x')).toBe('');
  });
});

describe('TapDecoder', () => {
  it('decodes rhythm into groups, and detects a held last beat', () => {
    const sched = new FakeScheduler();
    const out: string[] = [];
    const d = new TapDecoder(() => ({ groupGapMs: 450, codeEndMs: 1400, holdMs: 900 }), sched, (c, h) => out.push(c + (h ? 'H' : '')));
    const tap = (hold = 100, gap = 150) => {
      d.press();
      sched.advance(hold);
      d.release();
      sched.advance(gap);
    };
    tap();
    tap();
    tap(100, 700); // pause → new group
    tap(100, 1500); // end of code
    expect(out).toEqual(['3-1']);
    tap();
    tap();
    tap(1200, 1500); // held last beat
    expect(out).toEqual(['3-1', '3H']);
  });
});

describe('Simplified absolute block, single line', () => {
  it('runs an incoming train end to end', () => {
    const t = setup('ab');
    expect(t.c.requestIncoming('ex1', 'ordinary_passenger')).toBeNull();
    t.tick();
    expect(t.bellsIn).toEqual(['1']);
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '3-1']);
    t.c.sendBell('3-1');
    t.c.setInstrument('LC');
    t.tick(8000);
    expect(t.bellsIn).toEqual(['1', '3-1', '2']);
    t.c.sendBell('2');
    t.c.setInstrument('TOL');
    t.tick();
    expect(t.state.roster.find((l) => l.id === 'ex1')!.location.kind).toBe('section');
    t.c.confirmIncomingArrived({ placeId: 'becton-station', roadId: 'becton-p1' });
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '3-1', '2', '1', '2-1']);
    t.c.setInstrument('LB');
    t.tick();
    expect(t.c.view.incoming).toBeNull();
    expect(t.state.roster.find((l) => l.id === 'ex1')!.location).toEqual({ kind: 'place', placeId: 'becton-station', roadId: 'becton-p1' });
    expect(t.c.irregularities).toEqual([]);
  });

  it('runs an outgoing train end to end', () => {
    const t = setup('ab');
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1']);
    t.c.sendBell('2-3');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '2-3']);
    expect(t.c.view.remoteInstrument).toBe('LC');
    t.c.sendBell('2');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('TOL');
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    expect(t.bellsIn).toEqual(['1', '2-3', '2', '1']);
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('2-1');
    t.c.sendBell('2-1');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('LB');
    expect(t.c.view.outgoing).toBeNull();
    expect(t.state.roster.find((l) => l.id === 'ex4')!.location).toEqual({ kind: 'place', placeId: 'fy1', roadId: 'road5' });
    expect(t.c.irregularities).toEqual([]);
  });

  it('reports each arrival once, however many times the button is pressed', () => {
    const t = setup('ab');
    // Outgoing
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-3');
    t.tick();
    t.c.sendBell('2');
    t.tick();
    t.c.confirmOutgoingArrived('road5', null);
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    t.c.confirmOutgoingArrived('road5', null);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    expect(t.c.view.outgoing).toBeNull();
    // Incoming
    expect(t.c.requestIncoming('ex1', 'ordinary_passenger')).toBeNull();
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.c.setInstrument('LC');
    t.tick(8000);
    t.c.sendBell('2');
    t.c.setInstrument('TOL');
    t.tick();
    t.c.confirmIncomingArrived({ placeId: 'becton-station', roadId: 'becton-p1' });
    t.c.confirmIncomingArrived({ placeId: 'becton-station', roadId: 'becton-p1' });
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    t.c.confirmIncomingArrived({ placeId: 'becton-station', roadId: 'becton-p1' });
    t.c.setInstrument('LB');
    t.tick(5000);
    expect(t.c.view.incoming).toBeNull();
    expect(t.c.irregularities).toEqual([]);
    expect(t.hints).toEqual([]);
  });

  it('ignores Is line clear without call attention, and hints', () => {
    const t = setup('ab');
    t.c.sendBell('3-1');
    t.tick();
    expect(t.bellsIn).toEqual([]);
    expect(t.hints.join(' ')).toMatch(/Call attention/);
  });

  it('rings again when the reply is wrong', () => {
    const t = setup('ab');
    t.c.requestIncoming('ex1', 'ordinary_passenger');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-2');
    t.tick(6000);
    expect(t.bellsIn).toEqual(['1', '3-1', '3-1']);
    expect(t.c.irregularities.length).toBe(1);
  });

  it('repeats call attention if unanswered', () => {
    const t = setup('ab');
    t.c.requestIncoming('ex1', 'ordinary_passenger');
    t.tick(30000);
    expect(t.bellsIn).toEqual(['1', '1']);
  });

  it('will not offer an incoming train while the single line is occupied', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    expect(t.c.requestIncoming('ex1', 'ordinary_passenger')).toMatch(/single line/);
  });

  it('cancels an accepted outgoing train with 3-5', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('LC');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-5');
    t.tick(6000);
    expect(t.bellsIn.at(-1)).toBe('3-5');
    expect(t.c.view.remoteInstrument).toBe('LB');
  });
});

describe('a train offered with the wrong description', () => {
  /** Offer the station pilot (a light engine, 2-3) as 3-1 and let it depart. */
  function sendMisdescribed(t: ReturnType<typeof setup>) {
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('LC'); // accepted as heard
    t.c.sendBell('2');
    t.tick();
  }

  it('is reported by the receiving box with 5-3 when the train arrives, then cleared back as usual', () => {
    const t = setup('ab');
    sendMisdescribed(t);
    t.bellsIn.length = 0;
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    expect(t.bellsIn).toEqual(['1']);
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '5-3']);
    expect(t.c.view.guidance).toMatch(/incorrectly described.*You offered 3-1, but it was 2-3/);
    expect(t.c.irregularities.join(' ')).toMatch(/offered as 3-1 .* but it was 2-3/);
    t.c.sendBell('5-3');
    t.tick(6000);
    expect(t.bellsIn).toEqual(['1', '5-3', '1']);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '5-3', '1', '2-1']);
    expect(t.c.view.outgoing).toBeNull();
    expect(t.state.roster.find((l) => l.id === 'ex4')!.location).toEqual({ kind: 'place', placeId: 'fy1', roadId: 'road5' });
  });

  it('is not reported if corrected while the train is on its way (1, 5-3, then the right code)', () => {
    const t = setup('ab');
    sendMisdescribed(t);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('5-3');
    t.tick();
    expect(t.c.view.guidance).toMatch(/send the correct description: 2-3/);
    t.c.sendBell('2-3');
    t.tick();
    expect(t.bellsIn.slice(-3)).toEqual(['1', '5-3', '2-3']);
    expect(t.c.view.outgoing?.departed).toBe(true); // still on its way, not re-offered
    t.bellsIn.length = 0;
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '2-1']);
  });

  it('corrected before it departs, the offer is withdrawn and the train offered again', () => {
    const t = setup('ab');
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('5-3');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('LB');
    t.c.sendBell('2-3');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('LC');
    t.c.sendBell('2');
    t.tick();
    t.bellsIn.length = 0;
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '2-1']);
  });
});

describe('Electric key token, single line', () => {
  it('runs an incoming train end to end', () => {
    const t = setup('token');
    t.c.requestIncoming('ex2', 'branch_passenger');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '1-3']);
    // forgetting to hold: rung again
    t.c.sendBell('1-3', false);
    t.tick(6000);
    expect(t.bellsIn).toEqual(['1', '1-3', '1-3']);
    t.c.sendBell('1-3', true);
    t.tick(9000);
    expect(t.c.view.tokenIndicator).toBe('coming');
    expect(t.bellsIn.at(-1)).toBe('2');
    t.c.sendBell('2');
    t.tick();
    t.c.confirmIncomingArrived({ placeId: 'becton-station', roadId: 'becton-p3' });
    expect(t.c.view.tokenInHand).toBe(true);
    // 2-1 before replacing token is refused
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('1');
    expect(t.c.replaceToken()).toBeNull();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('2-1');
    expect(t.c.view.incoming).toBeNull();
    expect(t.c.view.tokensInInstrument).toBe(7);
  });

  it('runs an outgoing train end to end', () => {
    const t = setup('token');
    expect(t.c.withdrawToken()).toMatch(/locked/);
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-3');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '2-3H']);
    expect(t.c.view.releaseAvailable).toBe(true);
    expect(t.c.withdrawToken()).toBeNull();
    expect(t.c.view.tokenIndicator).toBe('going');
    t.c.sendBell('2');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('2');
    t.c.confirmOutgoingArrived('road4', null);
    t.tick(5000);
    expect(t.c.view.tokenIndicator).toBe('normal');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.c.view.outgoing).toBeNull();
    expect(t.c.view.tokensInInstrument).toBe(5);
    expect(t.c.irregularities).toEqual([]);
  });

  it('lets the release lapse if no token is withdrawn', () => {
    const t = setup('token');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick(20000);
    expect(t.c.view.releaseAvailable).toBe(false);
    expect(t.nb.outgoing).toBeNull();
  });
});

describe('opening the box', () => {
  it('refuses trains until 5-5-5 has been exchanged', () => {
    const state: AppState = createDefaultState();
    state.settings.responseDelayMs = [1000, 1000];
    const sched = new FakeScheduler();
    const [sess] = createBoxSession(state.boxes[0], () => state, sched);
    const c = sess.controller;
    const bells: string[] = [];
    c.events.on('bellIn', (b) => bells.push(b.code));
    sess.neighbour!.start();
    expect(c.view.boxOpen).toBe(false);
    expect(c.view.guidance).toMatch(/5-5-5/);
    expect(c.requestIncoming('ex1', 'ordinary_passenger')).toMatch(/Open the box/);
    c.sendBell('1');
    sched.advance(4000);
    c.sendBell('3-1');
    sched.advance(4000);
    expect(bells).toEqual(['1']);
    c.sendBell('1');
    sched.advance(4000);
    c.sendBell('5-5-5');
    sched.advance(8000);
    expect(bells).toEqual(['1', '1', '5-5-5']);
    expect(c.view.boxOpen).toBe(true);
    expect(c.requestIncoming('ex1', 'ordinary_passenger')).toBeNull();
  });

  it('closes with 7-5-5 and then only answers the opening sequence', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('7-5-5');
    t.tick(8000);
    expect(t.bellsIn).toEqual(['1', '7-5-5']);
    expect(t.c.view.boxOpen).toBe(false);
    t.c.sendBell('16');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '7-5-5']);
    expect(t.hints.at(-1)).toMatch(/closed/);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('5-5-5');
    t.tick(8000);
    expect(t.c.view.boxOpen).toBe(true);
  });

  it('will not close while a train is being signalled', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('7-5-5');
    t.tick(8000);
    expect(t.c.view.boxOpen).toBe(true);
  });
});

describe('the starting data (Sigsim Central)', () => {
  it('is a generic example: one layout and box called Sigsim Central between two fiddle yards', () => {
    const s = shippedState();
    expect(s.layouts.map((l) => l.name)).toEqual(['Sigsim Central']);
    expect(s.boxes.map((b) => b.name)).toEqual(['Sigsim Central']);
    const box = s.boxes[0];
    expect(box.layoutId).toBe(s.layouts[0].id);
    expect(s.settings.activeLayoutId).toBe(s.layouts[0].id);
    expect(box.connections.map((c) => [c.neighbourName, c.lineType, s.layouts[0].places.find((p) => p.id === c.placeId)?.name])).toEqual([
      ['Fiddle Yard West', 'single', 'Fiddle Yard West'],
      ['Fiddle Yard East', 'single', 'Fiddle Yard East'],
    ]);
    expect(JSON.stringify(s).toLowerCase()).not.toMatch(/becton|tansley/);
  });

  it('has a passing loop with platforms 1 and 2, a goods siding and shed, all tied to the track plan without issues', () => {
    const s = shippedState();
    const layout = s.layouts[0];
    expect(planIssues(s, layout)).toEqual([]);
    expect(placesWorkedBy(s, s.boxes[0].id).map((p) => [p.kind, p.roads.map((r) => r.name)])).toEqual([
      ['station', ['P1', 'P2']],
      ['goods', ['Goods siding', 'Goods shed']],
    ]);
    for (const p of placesWorkedBy(s, s.boxes[0].id)) for (const r of p.roads) expect(layout.trackPlan.circuits.some((c) => c.id === r.circuitId)).toBe(true);
    expect(layout.trackPlan.circuits.filter((c) => c.platform).map((c) => c.platform!.number)).toEqual(['1', '2']);
    // Each single line is two track circuits (ready for trains shown moving through the section); catch points guard the goods yard exit.
    const plan = layout.trackPlan;
    const owned = (conn: string) => plan.circuits.filter((c) => c.owner.kind === 'line' && c.owner.connectionId === conn);
    expect(owned('sgc-west')).toHaveLength(2);
    expect(owned('sgc-east')).toHaveLength(2);
    expect(lineRun(plan, owned('sgc-west')[0].id).map((c) => c.name)).toEqual(['West far', 'West near', 'West end', 'Platform 1', 'East near', 'East far']);
    const trap = plan.junctions.find((j) => j.kind === 'catchPoints')!;
    expect(trap.boxId).toBe(s.boxes[0].id);
    // The circuit on each side of the catch points: towards points 2 (the main line) and towards the yard.
    const sideOf = (c: (typeof plan.circuits)[number]) => c.ends.find((e) => e.kind === 'joined' && e.junctionId !== trap.id)!;
    const neck = plan.circuits.find((c) => c.ends.some((e) => e.kind === 'joined' && e.junctionId === trap.id) && plan.junctions.find((j) => j.id === (sideOf(c) as { junctionId: string }).junctionId)?.number === '2')!;
    expect(neck).toBeTruthy();
    const neckPort = (neck.ends.find((e) => e.kind === 'joined' && e.junctionId === trap.id) as { port: string }).port;
    const port = portsOf(trap).find((p) => p.id === neckPort)!;
    const towardsMain = orient(trap, port.dx, port.dy); // the way the track leaves the catch points towards points 2
    // The trap blade derails traffic running the way the blade points: it must point towards the main line (out of the yard)...
    const [b0, b1] = JUNCTIONS.catchPoints.stubs![0].map(([x, y]) => localToWorld(trap, x, y));
    expect(Math.sign(towardsMain.x)).toBe(-1);
    expect(Math.sign(b1.x - b0.x)).toBe(Math.sign(towardsMain.x));
    // ...and throw the runaway away from the main line (which is below the goods yard on the plan).
    expect(b1.y).toBeLessThan(b0.y);
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s); // loads back unchanged
  });

  it('has four LMS locomotives of different types, with trains to offer from both fiddle yards and one to send away', () => {
    const s = shippedState();
    expect(s.roster).toHaveLength(4);
    expect(s.roster.every((l) => l.locoClass.startsWith('LMS '))).toBe(true);
    expect(new Set(s.roster.map((l) => l.locoClass)).size).toBe(4);
    expect(new Set(s.roster.map((l) => l.working.trainTypeId)).size).toBe(4);
    const [west, east] = s.boxes[0].connections;
    expect(incomingCandidates(s, west).length).toBeGreaterThan(0);
    expect(incomingCandidates(s, east).length).toBeGreaterThan(0);
    expect(arrivalChoices(s, s.boxes[0].id)).toHaveLength(4);
  });
});

describe('the starting data plays end to end', () => {
  it('runs the Duchess express through from Fiddle Yard West to Fiddle Yard East (the tutorial\'s through train), cleanly', () => {
    const state = shippedState();
    state.settings.responseDelayMs = [1000, 1000];
    state.settings.despatchDelayMs = [5000, 5000];
    const sched = new FakeScheduler();
    const box = state.boxes[0];
    const sessions = createBoxSession(box, () => state, sched);
    const [west, east] = sessions;
    for (const s of sessions) {
      s.controller.events.on('locoMoved', (m) => {
        const l = state.roster.find((x) => x.id === m.locoId);
        if (l) l.location = m.location;
      });
      s.neighbour!.start();
    }
    const card = new Scorecard(() => sched.now());
    new BoxReferee(sessions, card);
    const w = new ThroughWorkings(sessions, {
      worksPlaces: () => placesWorkedBy(state, box.id).length > 0,
      codeSet: () => state.codeSets[0],
      trainTypes: () => state.trainTypes,
      locoLabel: (id) => id ?? '',
    });
    const tick = (ms = 4000) => sched.advance(ms);
    for (const s of sessions) {
      s.controller.sendBell('1');
      tick();
      s.controller.sendBell('5-5-5');
      tick(8000);
    }
    const a = west.controller;
    const c = east.controller;
    expect(a.requestIncoming('lms6233', 'express_passenger')).toBeNull();
    expect(w.route('sgc-west')).toBe(''); // a box with a station stops trains unless told otherwise
    expect(w.setRoute('sgc-west', 'sgc-east')).toBeNull();
    tick();
    a.sendBell('1');
    tick();
    a.sendBell('4');
    a.setInstrument('LC');
    tick(500);
    expect(w.guidance()?.text).toMatch(/Offer .* on to Fiddle Yard East/);
    c.sendBell('1');
    tick();
    c.sendBell('4');
    tick(8000);
    a.sendBell('2');
    a.setInstrument('TOL');
    tick();
    c.sendBell('2');
    tick();
    a.confirmIncomingArrived(null, { moveLoco: !w.keepLocoWhereItIs('sgc-west') });
    a.sendBell('1');
    tick();
    a.sendBell('2-1');
    tick();
    a.setInstrument('LB');
    tick();
    c.confirmOutgoingArrived('fye-road2', 'lms6233');
    tick(5000);
    c.sendBell('1');
    tick();
    c.sendBell('2-1');
    tick();
    expect(a.view.incoming).toBeNull();
    expect(c.view.outgoing).toBeNull();
    expect(state.roster.find((l) => l.id === 'lms6233')!.location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road2' });
    expect(card.entries.filter((e) => e.points < 0)).toEqual([]);
    expect(card.entries.filter((e) => e.rule === 'clean_working')).toHaveLength(1); // one bonus for the whole journey
  });

  it('receives the express from Fiddle Yard West into P1 and sends the pilot to Fiddle Yard East', () => {
    const state = shippedState();
    state.settings.responseDelayMs = [1000, 1000];
    state.settings.despatchDelayMs = [5000, 5000];
    const sched = new FakeScheduler();
    const [west, east] = createBoxSession(state.boxes[0], () => state, sched);
    for (const s of [west, east]) {
      s.controller.events.on('locoMoved', (m) => {
        const l = state.roster.find((x) => x.id === m.locoId);
        if (l) l.location = m.location;
      });
      s.neighbour!.start();
    }
    const tick = (ms = 4000) => sched.advance(ms);
    for (const s of [west, east]) {
      s.controller.sendBell('1');
      tick();
      s.controller.sendBell('5-5-5');
      tick(8000);
    }
    // In from the west: 6233, express passenger (4), into P1.
    const w = west.controller;
    expect(w.requestIncoming('lms6233', 'express_passenger')).toBeNull();
    tick();
    w.sendBell('1');
    tick();
    w.sendBell('4');
    tick(1000);
    w.setInstrument('LC');
    tick(9000);
    w.sendBell('2');
    tick(1000);
    w.setInstrument('TOL');
    w.confirmIncomingArrived({ placeId: 'sgc-station', roadId: 'sgc-p1' });
    w.sendBell('1');
    tick();
    w.sendBell('2-1');
    tick(3000);
    w.setInstrument('LB');
    tick();
    expect(state.roster.find((l) => l.id === 'lms6233')!.location).toEqual({ kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' });
    expect(w.view.incoming).toBeNull();
    // Out to the east: the Jinty from the goods siding, light engine (2-3).
    const e = east.controller;
    e.setOutgoing('lms7298', 'light_engine');
    e.sendBell('1');
    tick();
    e.sendBell('2-3');
    tick();
    expect(e.view.remoteInstrument).toBe('LC');
    e.sendBell('2');
    tick();
    e.confirmOutgoingArrived('fye-road2', 'lms7298');
    tick(5000);
    e.sendBell('1');
    tick();
    e.sendBell('2-1');
    tick();
    expect(e.view.outgoing).toBeNull();
    expect(state.roster.find((l) => l.id === 'lms7298')!.location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road2' });
    expect([...w.irregularities, ...e.irregularities]).toEqual([]);
  });
});

describe('reset to defaults', () => {
  it('erases saved layouts, boxes and roster (and the old storage key) and starts again from the starting data', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const store = new Store(storage);
    store.update((s) => {
      s.layouts[0].name = 'My own railway';
      s.roster.length = 0;
      s.boxes.push({ ...structuredClone(s.boxes[0]), id: 'b2', name: 'Second', shortName: 'SEC' });
      s.settings.theme = 'lms';
    });
    mem.set('bts-signalbox-state', '{"old":true}');
    let heard = 0;
    store.subscribe(() => heard++);
    store.reset();
    const def = shippedState();
    expect(store.state).toEqual(def);
    expect(JSON.parse(mem.get('signal-box-simulator-state')!)).toEqual(def);
    expect(mem.has('bts-signalbox-state')).toBe(false);
    expect(heard).toBe(1);
    expect(new Store(storage).state).toEqual(migrate(shippedState())); // stays reset after a reload
  });
});

describe('store migration', () => {
  it('fills defaults into partial saved data', () => {
    const s = migrate({ settings: { volume: 0.2 }, roster: [] });
    expect(s.settings.volume).toBe(0.2);
    expect(s.settings.tap.holdMs).toBe(900);
    expect(s.boxes[0].id).toBe('sigsim-central');
    expect(s.roster).toEqual([]);
  });
});

describe('block shelf layout', () => {
  it('places Becton fiddle yard on the right of three positions', () => {
    const box = createDefaultState().boxes[0];
    const slots = layoutShelf(box);
    expect(slots.length).toBe(3);
    expect(slots[0]).toBeNull();
    expect(slots[1]).toBeNull();
    expect(slots[2]?.id).toBe('becton-fy');
    expect(positionLabel(2, 3)).toBe('Right');
  });
  it('moves clashing connections to the nearest free position', () => {
    const box = createDefaultState().boxes[0];
    box.connections.push({ ...box.connections[0], id: 'x', shelfPosition: 2 });
    const slots = layoutShelf(box);
    expect(slots[2]?.id).toBe('becton-fy');
    expect(slots[1]?.id).toBe('x');
  });
  it('migrates old saves without shelf data', () => {
    const def = createDefaultState();
    const old = JSON.parse(JSON.stringify(def));
    delete old.boxes[0].shelfPositions;
    delete old.boxes[0].connections[0].shelfPosition;
    const s = migrate(old);
    expect(s.boxes[0].shelfPositions).toBe(3);
    expect(s.boxes[0].connections[0].shelfPosition).toBe(2);
  });
});

describe('user boxes and connections', () => {
  it('adds new boxes with unique default names', () => {
    const s = createDefaultState();
    const a = addBox(s);
    const b = addBox(s);
    expect(a.name).toBe('New box');
    expect(b.name).toBe('New box 2');
    expect(a.shortName).toBe('NEW');
    expect(b.shortName).toBe('NEW2');
    expect(canOpenBox(a)).toBe(false);
    expect(canOpenBox(s.boxes[0])).toBe(true);
  });

  it('rejects duplicate and empty names', () => {
    const s = createDefaultState();
    const nb = addBox(s);
    expect(checkBoxName(s, 'becton', nb.id)).toMatch(/already/);
    expect(checkBoxName(s, '  ', nb.id)).toMatch(/Enter/);
    expect(checkBoxName(s, 'Becton', 'becton')).toBeNull();
    expect(checkBoxShort(s, 'bec', nb.id)).toMatch(/already/);
    expect(checkConnName(s.boxes[0], 'fiddle yard', null)).toMatch(/already connected/);
    expect(checkConnName(s.boxes[0], 'Becton', null)).toMatch(/itself/);
  });

  it('validates shelf positions', () => {
    const box = createDefaultState().boxes[0];
    expect(checkShelfPositions(box, '0')).not.toBeNull();
    expect(checkShelfPositions(box, '-2')).not.toBeNull();
    expect(checkShelfPositions(box, '2.5')).not.toBeNull();
    expect(checkShelfPositions(box, '9')).not.toBeNull();
    expect(checkShelfPositions(box, '')).not.toBeNull();
    expect(checkShelfPositions(box, '1')).toBeNull();
  });

  it('adds connections in free positions and grows a full shelf', () => {
    const s = createDefaultState();
    const box = addBox(s, 'layout1');
    box.shelfPositions = 1;
    const c1 = addConnection(s, box)!;
    expect(c1.shelfPosition).toBe(0);
    // The first fiddle yard on the box's layout; none for a box not on a layout.
    expect(c1.placeId).toBe('fy1');
    // …and its far box is recorded as working the yard.
    expect(s.layouts[0].places[0].workedBy).toContainEqual({ kind: 'remote', boxId: box.id, connectionId: c1.id });
    expect(addConnection(s, addBox(s))!.placeId).toBe('');
    const c2 = addConnection(s, box)!;
    expect(box.shelfPositions).toBe(2);
    expect(c2.shelfPosition).toBe(1);
    expect(c2.neighbourName).toBe('Connected box 2');
    expect(canOpenBox(box)).toBe(true);
    removeConnection(s, box.id, c1.id);
    expect(box.connections.map((c) => c.id)).toEqual([c2.id]);
  });

  it('swaps instruments when moved onto an occupied position, repacks when the shelf shrinks', () => {
    const s = createDefaultState();
    const box = s.boxes[0];
    const extra = addConnection(s, box)!; // goes in position 0
    expect(extra.shelfPosition).toBe(0);
    moveConnection(box, extra.id, 2);
    expect(extra.shelfPosition).toBe(2);
    expect(box.connections[0].shelfPosition).toBe(0);
    setShelfPositions(box, 2);
    expect(layoutShelf(box).every((c) => c !== null)).toBe(true);
    expect(Math.max(...box.connections.map((c) => c.shelfPosition))).toBe(1);
  });

  it('deletes a box but never the last one', () => {
    const s = createDefaultState();
    expect(deleteBox(s, 'becton')).toBe(false);
    const nb = addBox(s);
    s.roster[0].location = { kind: 'atBox', boxId: nb.id };
    expect(deleteBox(s, nb.id)).toBe(true);
    expect(s.boxes).toHaveLength(1);
    expect(s.roster[0].location.kind).toBe('offLayout');
  });

  it('a line to a place puts arriving departures on the chosen road; a line with no place sends them to the roster', () => {
    const sch = new FakeScheduler();
    const run = (farPlaceId: string) => {
      const [a, b] = createLinkPair();
      const moved: Location[] = [];
      const ctl = new SectionController({
        link: a, scheduler: sch, boxId: 'x', connectionId: 'c', farPlaceId, mode: 'ab', lineType: 'single',
        neighbourName: 'Tansley Spa', neighbourShort: 'TS', localShort: 'BEC', codeSet: () => DEFAULT_CODE_SETS[0], trainTypes: () => DEFAULT_TRAIN_TYPES,
      });
      ctl.events.on('locoMoved', ({ location }) => moved.push(location));
      b.send({ type: 'movementComplete', direction: 'outgoing', locoId: 'ex1', roadId: 'r2' });
      return moved;
    };
    expect(run('tansley')).toEqual([{ kind: 'place', placeId: 'tansley', roadId: 'r2' }]);
    expect(run('')).toEqual([{ kind: 'offLayout' }]);
  });

  it('offers trains standing in the place at the far end of a line, or from the roster when it has none', () => {
    const s = createDefaultState();
    const box = s.boxes[0];
    const conn = addConnection(s, box)!;
    const ts = addPlace(s, 'layout1', 'station', { name: 'Tansley Spa' })!;
    setConnectionPlace(s, box, conn, ts.id);
    expect(ts.workedBy).toEqual([{ kind: 'remote', boxId: box.id, connectionId: conn.id }]);
    // It ran to the fiddle yard when it was added: its far box no longer works the yard.
    expect(s.layouts[0].places[0].workedBy.some((w) => w.kind === 'remote' && w.connectionId === conn.id)).toBe(false);
    s.roster[0].location = { kind: 'place', placeId: ts.id, roadId: '' };
    expect(incomingCandidates(s, conn).map((l) => l.id)).toEqual([s.roster[0].id]);
    expect(incomingCandidates(s, box.connections[0]).some((l) => l.id === s.roster[0].id)).toBe(false);
    setConnectionPlace(s, box, conn, '');
    s.roster[1].location = { kind: 'offLayout' };
    expect(incomingCandidates(s, conn).map((l) => l.id)).toEqual([s.roster[1].id]);
  });

  it('removing a connection stops its far box working places; removing a place sends its trains off the layout', () => {
    const s = createDefaultState();
    const box = s.boxes[0];
    const conn = addConnection(s, box)!;
    const ts = addPlace(s, 'layout1', 'station', { name: 'Tansley Spa' })!;
    setConnectionPlace(s, box, conn, ts.id);
    s.roster[0].location = { kind: 'place', placeId: ts.id, roadId: ts.roads[0].id };
    removeConnection(s, box.id, conn.id);
    expect(ts.workedBy).toEqual([]);
    expect(s.roster[0].location.kind).toBe('place');
    expect(removePlace(s, ts.id)).toBe(1);
    expect(s.roster[0].location.kind).toBe('offLayout');
  });
});

describe('places', () => {
  it('a station can be worked by two boxes; a junction box works none', () => {
    const s = createDefaultState();
    const york = addPlace(s, 'layout1', 'station', { name: 'York', roads: 3 })!;
    const north = addBox(s, 'layout1');
    const south = addBox(s, 'layout1');
    const junction = addBox(s, 'layout1');
    setWorker(york, { kind: 'box', boxId: north.id }, true);
    setWorker(york, { kind: 'box', boxId: south.id }, true);
    expect(placesWorkedBy(s, north.id).map((p) => p.name)).toEqual(['York']);
    expect(placesWorkedBy(s, south.id).map((p) => p.name)).toEqual(['York']);
    expect(placesWorkedBy(s, junction.id)).toEqual([]);
    expect(arrivalChoices(s, north.id).map((c) => c.label)).toEqual(['York · P1', 'York · P2', 'York · P3']);
    s.roster[0].location = { kind: 'place', placeId: york.id, roadId: york.roads[1].id };
    expect(boxLocos(s, north.id).map((l) => l.id)).toEqual([s.roster[0].id]);
    expect(boxLocos(s, south.id).map((l) => l.id)).toEqual([s.roster[0].id]);
    s.roster[1].location = { kind: 'atBox', boxId: junction.id };
    expect(boxLocos(s, junction.id).map((l) => l.id)).toEqual([s.roster[1].id]);
  });

  it('names places and roads uniquely, and keeps trains in the place when a road goes', () => {
    const s = createDefaultState();
    const layout = s.layouts[0];
    const p = addPlace(s, 'layout1', 'sidings')!;
    expect(p.name).toBe('New sidings');
    expect(checkPlaceName(layout, 'becton', p.id)).toMatch(/already/);
    expect(checkPlaceShort(layout, 'fy', p.id)).toMatch(/already/);
    expect(checkPlaceShort(layout, '', p.id)).toBeNull();
    const r2 = addRoad(p)!;
    expect(r2.name).toBe('Road 2');
    expect(checkRoadName(p, 'road 2', p.roads[0].id)).toMatch(/already/);
    s.roster[0].location = { kind: 'place', placeId: p.id, roadId: r2.id };
    expect(removeRoad(s, p.id, r2.id)).toBe(1);
    expect(s.roster[0].location).toEqual({ kind: 'place', placeId: p.id, roadId: '' });
    expect(setRoadCount(s, 'fy1', 0)).toMatch(/at least one/);
    expect(setRoadCount(s, p.id, 4)).toBeNull();
    expect(p.roads.map((r) => r.name)).toEqual(['Road 1', 'Road 2', 'Road 3', 'Road 4']);
  });

  it('ties a road to one track circuit at a time, and unties it when the track goes', () => {
    const s = createDefaultState();
    const layout = s.layouts[0];
    layout.trackPlan.circuits.push({ id: 'c1', code: 'T1', name: '', owner: { kind: 'none' }, ends: [{ kind: 'open', x: 0, y: 0 }, { kind: 'open', x: 4, y: 0 }] });
    tieRoad(layout, 'becton-station', 'becton-p1', 'c1');
    tieRoad(layout, 'becton-station', 'becton-p2', 'c1');
    expect(roadOfCircuit(layout, 'c1')?.road.name).toBe('P2');
    expect(layout.places[1].roads[0].circuitId).toBeUndefined();
    layout.trackPlan.circuits = [];
    sanitisePlaces(s);
    expect(layout.places[1].roads[1].circuitId).toBeUndefined();
  });

  it('migrates a save from before places: yards, each box\'s station (platforms from its notes) and far-box locations', () => {
    const old = {
      schemaVersion: 2,
      settings: { activeLayoutId: 'layout1' },
      boxes: [
        {
          id: 'becton', name: 'Becton', shortName: 'BEC', layoutId: 'layout1', description: '', shelfPositions: 3,
          stationNotes: 'P1: longest, loco release.\nP2: shorter.\nP3: bay.\nCoal siding: not used for arrivals.',
          connections: [
            { id: 'becton-fy', neighbourName: 'Fiddle Yard', neighbourShort: 'FY', lineType: 'single', fiddleYardId: 'fy1', defaultWorking: 'ab', shelfPosition: 2 },
            { id: 'c2', neighbourName: 'Tansley Spa', neighbourShort: 'TS', lineType: 'single', fiddleYardId: '', defaultWorking: 'ab', shelfPosition: 0 },
          ],
        },
      ],
      layouts: [
        {
          id: 'layout1', name: 'BTS', running: 'left',
          fiddleYards: [{ id: 'fy1', name: 'Fiddle Yard', roads: [{ id: 'road1', name: 'Road 1', notes: '' }] }],
          trackPlan: { circuits: [{ id: 'x', code: 'T1', name: '', owner: { kind: 'none' }, ends: [{ kind: 'exit', x: 0, y: 0, to: { kind: 'fiddleYard', yardId: 'fy1' } }, { kind: 'open', x: 5, y: 0 }] }], junctions: [] },
        },
      ],
      roster: [
        { id: 'a', number: '1', name: '', locoClass: '', powerType: '', dccAddress: '', notes: '', working: { trainTypeId: 'light_engine', consist: '', headcode: '' }, location: { kind: 'fiddleYard', yardId: 'fy1', roadId: 'road1' } },
        { id: 'b', number: '2', name: '', locoClass: '', powerType: '', dccAddress: '', notes: '', working: { trainTypeId: 'light_engine', consist: '', headcode: '' }, location: { kind: 'station', boxId: 'becton', note: 'Platform 2' } },
        { id: 'c', number: '3', name: '', locoClass: '', powerType: '', dccAddress: '', notes: '', working: { trainTypeId: 'light_engine', consist: '', headcode: '' }, location: { kind: 'station', boxId: 'becton', note: 'Pilot' } },
        { id: 'd', number: '4', name: '', locoClass: '', powerType: '', dccAddress: '', notes: '', working: { trainTypeId: 'light_engine', consist: '', headcode: '' }, location: { kind: 'farBox', boxId: 'becton', connectionId: 'c2', note: '' } },
      ],
    };
    const s = migrate(old);
    const places = s.layouts[0].places;
    expect(places.map((p) => `${p.kind}:${p.name}`)).toEqual(['fiddleYard:Fiddle Yard', 'station:Becton', 'station:Tansley Spa']);
    const becton = places[1];
    expect(becton.roads.map((r) => r.name)).toEqual(['P1', 'P2', 'P3']);
    expect(becton.roads[0].notes).toBe('Longest, loco release.');
    expect(becton.notes).toBe('Coal siding: not used for arrivals.');
    expect(becton.workedBy).toEqual([{ kind: 'box', boxId: 'becton' }]);
    expect(places[0].workedBy).toEqual([{ kind: 'remote', boxId: 'becton', connectionId: 'becton-fy' }]);
    expect(s.boxes[0].connections.map((c) => c.placeId)).toEqual(['fy1', places[2].id]);
    expect(s.roster.map((l) => l.location)).toEqual([
      { kind: 'place', placeId: 'fy1', roadId: 'road1' },
      { kind: 'place', placeId: becton.id, roadId: becton.roads[1].id },
      { kind: 'place', placeId: becton.id, roadId: '' },
      { kind: 'place', placeId: places[2].id, roadId: '' },
    ]);
    expect(s.layouts[0].trackPlan.circuits[0].ends[0]).toMatchObject({ kind: 'exit', to: { kind: 'place', placeId: 'fy1' } });
    expect('stationNotes' in s.boxes[0]).toBe(false);
    expect('fiddleYards' in s.layouts[0]).toBe(false);
    // Loading it again changes nothing.
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('trains on layout register', () => {
  it('lists the places the box works, the places at the far end of its lines, then the rest of the layout', () => {
    const s = createDefaultState();
    const becton = s.boxes[0];
    const far = addConnection(s, becton)!;
    const sid = addPlace(s, 'layout1', 'sidings', { name: 'Exchange sidings' })!;
    setConnectionPlace(s, becton, far, sid.id);
    const goods = addPlace(s, 'layout1', 'goods', { name: 'Goods shed' })!;
    const junction = addBox(s, 'layout1');
    addBox(s); // not on the layout: not listed
    s.roster[0].location = { kind: 'place', placeId: sid.id, roadId: '' };
    s.roster[1].location = { kind: 'section', connectionId: 'becton-fy' };
    s.roster[2].location = { kind: 'atBox', boxId: junction.id };
    const reg = trainsOnLayout(s, becton.id);
    expect(reg.map((r) => r.kind + ':' + r.name)).toEqual([
      'place:Becton',
      'place:Becton sidings',
      'place:Exchange sidings',
      'place:Fiddle Yard',
      `place:${goods.name}`,
      `atBox:At ${junction.name}`,
      'section:On the line',
    ]);
    const yard = reg[3];
    expect(yard.kind === 'place' && yard.roads.length).toBe(6);
    const ex = reg[2];
    expect(ex.kind === 'place' && ex.loose.map((l) => l.id)).toEqual([s.roster[0].id]);
    expect(reg[0].kind === 'place' && reg[0].mine).toBe(true);
    // A box that works no place lists itself first, where its arrivals stand.
    expect(trainsOnLayout(s, junction.id)[0].name).toBe(`At ${junction.name}`);
  });
});
