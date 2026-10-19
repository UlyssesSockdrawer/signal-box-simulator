import { describe, expect, it } from 'vitest';
import { addConnection } from './boxes';
import { createDefaultState } from './defaults';
import { addPlace, placesWorkedBy, setConnectionPlace, setWorker } from './places';
import { FakeScheduler } from './scheduler';
import { createBoxSession } from './session';
import { ThroughWorkings } from './throughTrains';
import type { AppState } from './types';

/** Box A (Fiddle Yard, simulated) ── Becton (you) ── C (Tansley Spa, simulated). */
function setup(opts: { worksPlaces?: boolean } = {}) {
  const state: AppState = createDefaultState();
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  const box = state.boxes[0];
  const toC = addConnection(state, box)!;
  toC.neighbourName = 'Tansley Spa';
  toC.neighbourShort = 'TS';
  const ts = addPlace(state, 'layout1', 'station', { name: 'Tansley Spa', roads: 2 })!;
  setConnectionPlace(state, box, toC, ts.id);
  if (!opts.worksPlaces) for (const p of placesWorkedBy(state, box.id)) setWorker(p, { kind: 'box', boxId: box.id }, false);
  const sched = new FakeScheduler();
  const sessions = createBoxSession(box, () => state, sched);
  const [sa, sc] = sessions;
  const bells: Record<string, string[]> = { a: [], c: [] };
  sa.controller.events.on('bellIn', (b) => bells.a.push(b.code));
  sc.controller.events.on('bellIn', (b) => bells.c.push(b.code));
  for (const s of sessions) {
    s.controller.events.on('locoMoved', (m) => {
      const l = state.roster.find((x) => x.id === m.locoId);
      if (l) l.location = m.location;
    });
    s.neighbour!.start();
  }
  const tick = (ms = 4000) => sched.advance(ms);
  const w = new ThroughWorkings(sessions, {
    worksPlaces: () => placesWorkedBy(state, box.id).length > 0,
    codeSet: () => state.codeSets[0],
    trainTypes: () => state.trainTypes,
    locoLabel: (id) => state.roster.find((l) => l.id === id)?.number ?? id,
  });
  // Open the box with both neighbours.
  for (const s of sessions) {
    s.controller.sendBell('1');
    tick();
    s.controller.sendBell('5-5-5');
    tick(8000);
  }
  bells.a.length = 0;
  bells.c.length = 0;
  return { state, a: sa.controller, c: sc.controller, w, bells, tick, ts, sessions };
}

describe('through trains (offering on)', () => {
  it('a junction box sends trains on by default; a box with a station keeps them', () => {
    expect(setup().w.defaultRoute('becton-fy')).not.toBe('');
    expect(setup({ worksPlaces: true }).w.defaultRoute('becton-fy')).toBe('');
  });

  it('accepts a train from A, offers it on to C, sends it on and clears back to A', () => {
    const t = setup();
    const toC = t.sessions[1].connection.id;
    expect(t.w.route('becton-fy')).toBe(toC);
    expect(t.a.requestIncoming('ex1', 'express_passenger')).toBeNull();
    t.tick();
    t.a.sendBell('1');
    t.tick();
    expect(t.bells.a).toEqual(['1', '4']);
    expect(t.w.through('becton-fy')?.stage).toBe('offered');
    // Accept from A: repeat 4, Line Clear.
    t.a.sendBell('4');
    t.a.setInstrument('LC');
    t.tick(500);
    expect(t.w.through('becton-fy')?.stage).toBe('offerOn');
    // The train is declared on the line to C, and the next step says to offer it on.
    expect(t.c.view.outgoing).toMatchObject({ locoId: 'ex1', trainTypeId: 'express_passenger', departed: false });
    expect(t.w.guidance()?.text).toMatch(/Offer 7812 on to Tansley Spa/);
    expect(t.w.guidance()?.connId).toBe(toC);
    // Offer on to C: 1, then 4. C accepts.
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('4');
    t.tick();
    expect(t.bells.c).toEqual(['1', '4']);
    expect(t.c.view.remoteInstrument).toBe('LC');
    expect(t.w.through('becton-fy')?.stage).toBe('acceptedOn');
    // A despatches: acknowledge 2, Train On Line.
    t.tick(8000);
    expect(t.bells.a.at(-1)).toBe('2');
    t.a.sendBell('2');
    t.a.setInstrument('TOL');
    t.tick();
    expect(t.w.guidance()?.text).toMatch(/As it passes your box, send 2/);
    // It passes: 2 to C. The loco is now in the section ahead.
    t.c.sendBell('2');
    t.tick();
    expect(t.w.through('becton-fy')?.stage).toBe('sentOn');
    expect(t.state.roster[0].location).toEqual({ kind: 'section', connectionId: toC });
    expect(t.w.guidance()?.text).toMatch(/passed complete/);
    // Tail lamp seen: report it, and send 2-1 to A. The loco stays in the section ahead.
    expect(t.w.keepLocoWhereItIs('becton-fy')).toBe(true);
    t.a.confirmIncomingArrived(null, { moveLoco: false });
    expect(t.state.roster[0].location.kind).toBe('section');
    t.a.sendBell('1');
    t.tick();
    t.a.sendBell('2-1');
    t.tick();
    t.a.setInstrument('LB');
    t.tick();
    expect(t.a.view.incoming).toBeNull();
    // It arrives at Tansley Spa: C clears back with 2-1.
    t.c.confirmOutgoingArrived(t.ts.roads[1].id, 'ex1');
    t.tick(5000);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.c.view.outgoing).toBeNull();
    expect(t.state.roster[0].location).toEqual({ kind: 'place', placeId: t.ts.id, roadId: t.ts.roads[1].id });
    expect(t.a.irregularities).toEqual([]);
    expect(t.c.irregularities).toEqual([]);
    expect(t.w.guidance()).toBeNull();
  });

  it('a train stopped at the box can still go on later; re-routing to stop here withdraws it from the line ahead', () => {
    const t = setup();
    t.a.requestIncoming('ex1', 'express_passenger');
    t.tick();
    t.a.sendBell('1');
    t.tick();
    t.a.sendBell('4');
    t.a.setInstrument('LC');
    t.tick(500);
    expect(t.c.view.outgoing?.locoId).toBe('ex1');
    expect(t.w.setRoute('becton-fy', '')).toBeNull();
    expect(t.c.view.outgoing).toBeNull();
    expect(t.w.through('becton-fy')).toBeNull();
    // Route it on again; it arrives and stands at the box before being sent on.
    t.w.setRoute('becton-fy', t.sessions[1].connection.id);
    expect(t.c.view.outgoing?.locoId).toBe('ex1');
    t.tick(8000);
    t.a.sendBell('2');
    t.a.setInstrument('TOL');
    t.tick();
    t.a.confirmIncomingArrived(null);
    expect(t.state.roster[0].location).toEqual({ kind: 'atBox', boxId: 'becton' });
    expect(t.w.through('becton-fy')?.stage).toBe('standing');
    expect(t.w.guidance()?.text).toMatch(/standing at your box/);
    t.a.sendBell('1');
    t.tick();
    t.a.sendBell('2-1');
    t.tick();
    // A's part is finished; the departure to C is still declared, ready to offer.
    expect(t.c.view.outgoing?.locoId).toBe('ex1');
  });

  it('does not take over a departure already chosen for the line ahead', () => {
    const t = setup();
    t.c.setOutgoing('ex4', 'light_engine');
    t.a.requestIncoming('ex1', 'express_passenger');
    t.tick();
    expect(t.w.through('becton-fy')?.blocked).toBe(true);
    expect(t.c.view.outgoing?.locoId).toBe('ex4');
    expect(t.w.guidance()?.text).toMatch(/another train is chosen/);
  });
});
