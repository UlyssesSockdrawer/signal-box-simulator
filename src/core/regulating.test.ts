import { describe, expect, it } from 'vitest';
import { addConnection } from './boxes';
import { BR_1960 } from './bellcodes';
import { createBectonState as createDefaultState } from './testState';
import { addPlace, setConnectionPlace } from './places';
import { BoxReferee } from './referee';
import { BoxRegulator } from './regulating';
import { FakeScheduler } from './scheduler';
import { Scorecard } from './score';
import { createBoxSession } from './session';
import { migrate } from './store';
import type { AppState, LineType } from './types';

/**
 * Becton (you) with its single line to the Fiddle Yard (FY), and optionally a second line to
 * Tansley Spa (TS). Simulated signallers at the far ends; reaction 1 s, despatch 5 s,
 * an offer counts as refused 15 s after it has rung, a held train is offered again after 60 s.
 */
function setup(opts: { twoLines?: boolean; tsLine?: LineType; coincide?: boolean; reofferMs?: number; random?: () => number } = {}) {
  const state: AppState = createDefaultState();
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  state.settings.offerRefusedAfterMs = 15000;
  state.settings.reofferAfterMs = opts.reofferMs ?? 60000;
  state.settings.coincidingOffers = !!opts.coincide;
  const box = state.boxes[0];
  if (opts.twoLines) {
    const toC = addConnection(state, box)!;
    toC.neighbourName = 'Tansley Spa';
    toC.neighbourShort = 'TS';
    toC.lineType = opts.tsLine ?? 'double';
    const ts = addPlace(state, 'layout1', 'station', { name: 'Tansley Spa', roads: 2 })!;
    setConnectionPlace(state, box, toC, ts.id);
    // A train waiting at Tansley Spa, for coinciding offers.
    state.roster.find((l) => l.id === 'ex3')!.location = { kind: 'place', placeId: ts.id, roadId: ts.roads[0].id };
  }
  const sched = new FakeScheduler();
  const sessions = createBoxSession(box, () => state, sched);
  const bells: Record<string, string[]> = { fy: [], ts: [] };
  const hints: string[] = [];
  sessions[0].controller.events.on('bellIn', (b) => bells.fy.push(b.code));
  sessions[1]?.controller.events.on('bellIn', (b) => bells.ts.push(b.code));
  for (const s of sessions) {
    s.controller.events.on('hint', (h) => hints.push(h.text));
    s.controller.events.on('locoMoved', (m) => {
      const l = state.roster.find((x) => x.id === m.locoId);
      if (l) l.location = m.location;
    });
    s.neighbour!.start();
  }
  const tick = (ms = 4000) => sched.advance(ms);
  const card = new Scorecard(() => sched.now());
  const referee = new BoxReferee(sessions, card);
  const reg = new BoxRegulator(sessions, {
    scheduler: sched,
    codeSet: () => state.codeSets[0],
    trainTypes: () => state.trainTypes,
    settings: () => state.settings,
    locoLabel: (id) => id ?? 'train',
    candidates: (conn) =>
      state.roster.filter((l) => l.location.kind === 'place' && l.location.placeId === conn.placeId).map((l) => ({ id: l.id, trainTypeId: l.working.trainTypeId })),
    score: (s, rule, detail, locoId) => referee.score(s, rule, detail, locoId),
    random: opts.random ?? (() => 0),
  });
  for (const s of sessions) {
    s.controller.sendBell('1');
    tick();
    s.controller.sendBell('5-5-5');
    tick(8000);
  }
  bells.fy.length = 0;
  bells.ts.length = 0;
  card.reset();
  const fy = sessions[0].controller;
  const ts = sessions[1]?.controller;
  const rules = () => card.entries.map((e) => e.rule);
  const register = (c = fy) => c.log.filter((e) => e.kind === 'register').map((e) => e.text);
  return { state, sched, sessions, fy, ts: ts!, bells, hints, tick, card, reg, rules, register };
}

/** The far box calls attention and offers the train; the signaller answers the 1 only. */
function offerAndAnswerOne(t: ReturnType<typeof setup>, c = t.fy, loco = 'ex1', tt = 'ordinary_passenger') {
  expect(c.requestIncoming(loco, tt)).toBeNull();
  t.tick();
  c.sendBell('1');
  t.tick();
}

/** Accept, receive and clear an incoming train (absolute block) on a line whose offer has just rung. */
function acceptAndClear(t: ReturnType<typeof setup>, c: typeof t.fy, code: string) {
  c.sendBell(code);
  t.tick(1000);
  c.setInstrument('LC');
  t.tick(9000);
  c.sendBell('2');
  t.tick(1000);
  c.setInstrument('TOL');
  t.tick(3000);
  c.confirmIncomingArrived();
  c.sendBell('1');
  t.tick();
  c.sendBell('2-1');
  t.tick(3000);
  c.setInstrument('LB');
  t.tick(1000);
}

describe('refusing a train (silent refusal)', () => {
  it('an offer not repeated is refused and held; it is not scored as slow, and is offered again later', () => {
    const t = setup();
    offerAndAnswerOne(t);
    expect(t.bells.fy).toEqual(['1', '3-1']);
    t.tick(20000); // no reply to 3-1
    const inc = t.fy.view.incoming!;
    expect(inc.held).toBe(true);
    expect(inc.offeredAt).not.toBeNull();
    expect(t.bells.fy).toEqual(['1', '3-1']); // not rung again: no reply is a refusal
    expect(t.rules()).not.toContain('no_reply');
    expect(t.fy.irregularities).toEqual([]);
    expect(t.hints.join(' ')).toMatch(/refusal/);
    expect(t.reg.held()).toEqual([expect.objectContaining({ connId: 'becton-fy', locoId: 'ex1', reoffers: 0, firstOfferedAt: inc.offeredAt })]);

    t.tick(60000); // ~60 s after the refusal the far box calls attention again
    expect(t.bells.fy).toEqual(['1', '3-1', '1']);
    t.fy.sendBell('1');
    t.tick();
    expect(t.bells.fy).toEqual(['1', '3-1', '1', '3-1']);
    expect(t.fy.view.incoming!.held).toBe(false);
    expect(t.fy.view.incoming!.reoffers).toBe(1);
    expect(t.fy.view.incoming!.offeredAt).toBe(inc.offeredAt); // first offered time kept
    t.fy.sendBell('3-1');
    t.tick(1000);
    expect(t.fy.view.incoming!.acceptedAt).not.toBeNull();
    expect(t.reg.held()).toEqual([]); // cleared on acceptance
    expect(t.rules()).toEqual(['in_accepted']);

    const reg = t.register();
    expect(reg[0]).toMatch(/^Offered 3-1: 7812 "Erlestoke Manor", ordinary passenger$/);
    expect(reg[1]).toMatch(/^Not accepted: .* held at Fiddle Yard$/);
    expect(reg[2]).toMatch(/^Offered again \(2nd time\) 3-1/);
    expect(reg[3]).toMatch(/^Accepted 3-1: 7812 "Erlestoke Manor", ordinary passenger · offered \d\d:\d\d:\d\d · accepted \d\d:\d\d:\d\d · waited 1 min · offered 2 times$/);
  });

  it('an unacknowledged call attention is still scored as slow; a withdrawn held train clears the tracker', () => {
    const t = setup();
    t.fy.requestIncoming('ex1', 'ordinary_passenger');
    t.tick(30000); // 1 not answered: rung again
    expect(t.rules()).toEqual(['no_reply']);
    t.fy.sendBell('1');
    t.tick(25000);
    expect(t.reg.held()).toHaveLength(1);
    t.fy.cancelIncoming();
    expect(t.reg.held()).toEqual([]);
    t.tick(70000);
    expect(t.bells.fy.filter((b) => b === '3-1')).toHaveLength(1); // not offered again
  });

  it('a wrong reply is still an irregularity, and the offer rings again', () => {
    const t = setup();
    offerAndAnswerOne(t);
    t.fy.sendBell('3-2');
    t.tick(6000);
    expect(t.bells.fy).toEqual(['1', '3-1', '3-1']);
    expect(t.rules()).toEqual(['wrong_reply']);
  });

  it('repeating the held code late asks the far box to offer it again now, without a penalty', () => {
    const t = setup();
    offerAndAnswerOne(t);
    t.tick(20000);
    t.fy.sendBell('3-1');
    t.tick(4000);
    expect(t.bells.fy.at(-1)).toBe('1');
    expect(t.rules()).toEqual([]);
  });

  it('on a single line a refused train lets the signaller send one the other way first, then is offered again', () => {
    const t = setup();
    offerAndAnswerOne(t);
    t.tick(20000);
    expect(t.fy.view.incoming!.held).toBe(true);
    // Send the station pilot to the fiddle yard while the incoming train is held.
    t.fy.setOutgoing('ex4', 'light_engine');
    t.fy.sendBell('1');
    t.tick();
    t.fy.sendBell('2-3');
    t.tick();
    expect(t.fy.view.remoteInstrument).toBe('LC');
    t.fy.sendBell('2');
    t.tick();
    t.fy.confirmOutgoingArrived('road4', 'ex4');
    t.tick();
    t.fy.sendBell('1');
    t.tick();
    t.fy.sendBell('2-1');
    t.tick(1000);
    expect(t.fy.view.outgoing).toBeNull();
    expect(t.rules()).not.toContain('offered_section_busy');
    const before = t.bells.fy.length;
    t.tick(8000); // offered again soon after the line is clear, not a minute later
    expect(t.bells.fy.slice(before)).toEqual(['1']);
    t.fy.sendBell('1');
    t.tick();
    expect(t.bells.fy.at(-1)).toBe('3-1');
  });

  it('offers a held train again soon after the signaller sends 2-1 on another line', () => {
    const t = setup({ twoLines: true, reofferMs: 600_000 });
    offerAndAnswerOne(t, t.fy, 'ex1', 'ordinary_passenger');
    t.tick(20000);
    expect(t.fy.view.incoming!.held).toBe(true);
    // Meanwhile take a train of the same class from Tansley Spa.
    offerAndAnswerOne(t, t.ts, 'ex2', 'ordinary_passenger');
    acceptAndClear(t, t.ts, '3-1');
    expect(t.ts.view.incoming).toBeNull();
    const before = t.bells.fy.length;
    t.tick(8000);
    expect(t.bells.fy.slice(before)).toEqual(['1']);
  });
});

describe('regulating', () => {
  it('accepting the higher class while a lower one is held scores regulated_ok', () => {
    const t = setup({ twoLines: true });
    offerAndAnswerOne(t, t.fy, 'ex1', 'mineral'); // 4-1, class J
    offerAndAnswerOne(t, t.ts, 'ex2', 'express_passenger'); // 4, class A
    expect(t.reg.outstanding()).toHaveLength(2);
    const advice = t.reg.advice()!;
    expect(advice.connId).toBe(t.sessions[1].connection.id);
    expect(advice.text).toMatch(/Tansley Spa is offering 4 .*accept it first/);
    t.ts.sendBell('4');
    t.tick(1000);
    expect(t.rules()).toEqual(['in_accepted', 'regulated_ok']);
    expect(t.reg.advice()).toBeNull();
  });

  it('accepting a lower class while a higher one is waiting scores regulated_wrong (procedure), and costs that train its bonus', () => {
    const t = setup({ twoLines: true });
    offerAndAnswerOne(t, t.ts, 'ex2', 'express_passenger');
    t.tick(20000); // TS's express is refused and held
    offerAndAnswerOne(t, t.fy, 'ex1', 'mineral');
    expect(t.reg.advice()!.text).toMatch(/Tansley Spa is holding 4/);
    acceptAndClear(t, t.fy, '4-1');
    expect(t.rules()).toContain('regulated_wrong');
    const e = t.card.entries.find((x) => x.rule === 'regulated_wrong')!;
    expect(e.category).toBe('procedure');
    expect(e.points).toBe(-10);
    expect(e.detail).toMatch(/accepted 4-1 from Fiddle Yard while 4 \(Class A\) from Tansley Spa was waiting/);
    expect(t.rules()).not.toContain('clean_working');
    expect(t.fy.irregularities.join(' ')).toMatch(/Regulating/);
  });

  it('equal ranks are not judged; a higher class offered after an acceptance is no fault', () => {
    const t = setup({ twoLines: true });
    offerAndAnswerOne(t, t.fy, 'ex1', 'ordinary_passenger'); // class B
    offerAndAnswerOne(t, t.ts, 'ex2', 'branch_passenger'); // class B too
    expect(t.reg.advice()).toBeNull();
    t.fy.sendBell('3-1');
    t.tick(1000);
    expect(t.rules()).toEqual(['in_accepted']);

    const u = setup({ twoLines: true });
    offerAndAnswerOne(u, u.fy, 'ex1', 'mineral');
    u.fy.sendBell('4-1'); // accepted before anything else was offered
    u.tick(1000);
    offerAndAnswerOne(u, u.ts, 'ex2', 'express_passenger');
    u.ts.sendBell('4');
    u.tick(1000);
    expect(u.rules()).toEqual(['in_accepted', 'in_accepted']);
  });

  it('"Offers can coincide": asking for a train on one line brings an offer on another, of a different class', () => {
    const t = setup({ twoLines: true, coincide: true });
    t.fy.requestIncoming('ex1', 'ordinary_passenger');
    t.tick(6000);
    expect(t.ts.view.incoming).toEqual(expect.objectContaining({ locoId: 'ex3' })); // the railcar standing at Tansley Spa
    expect(t.bells.ts).toEqual(['1']);

    const off = setup({ twoLines: true });
    off.fy.requestIncoming('ex1', 'ordinary_passenger');
    off.tick(6000);
    expect(off.ts.view.incoming).toBeNull();
  });
});

describe('code set ranks', () => {
  it('built-in code sets rank the classes, and old saves get the ranks', () => {
    expect(BR_1960.trainCodes.express_passenger.rank).toBeGreaterThan(BR_1960.trainCodes.ordinary_passenger.rank!);
    expect(BR_1960.trainCodes.ordinary_passenger.rank).toBe(BR_1960.trainCodes.branch_passenger.rank);
    const old = createDefaultState();
    for (const cs of old.codeSets) for (const e of Object.values(cs.trainCodes)) delete e.rank;
    const s = migrate(JSON.parse(JSON.stringify(old)));
    expect(s.codeSets[0].trainCodes.mineral.rank).toBe(BR_1960.trainCodes.mineral.rank);
    expect(s.settings.offerRefusedAfterMs).toBe(15000);
    expect(s.settings.coincidingOffers).toBe(false);
  });
});
