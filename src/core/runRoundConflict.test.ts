import { describe, expect, it } from 'vitest';
import { play } from './simHarness';
import { addTimetable, addTrain } from './timetables';

/*
 * v0.3.39 (Matt's playtest): a train in P2 runs round to depart east while a through train is offered
 * from the west. The run round must not get stuck, and blocking back must be possible while the other
 * train is only offered (not accepted).
 */

function setUp(innerYards: number) {
  const t = play();
  if (innerYards !== 600) for (const id of ['sgc-twi', 'sgc-tei']) t.state.layouts[0].trackPlan.circuits.find((c) => c.id === id)!.length = innerYards * 0.9144;
  const g = t.loco('lms3436');
  g.location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p2' };
  // Its engine is at the west end of P2 (T6), so it must run round to leave east engine first.
  g.working = { trainTypeId: 'pickup_goods', consist: '6 wagons + brake van', headcode: '', locoEnd: { circuitId: 'sgc-t5', end: 0 } };
  t.tick(500);
  t.east.setOutgoing('lms3436', 'pickup_goods');
  t.tick(500);
  const p = t.loco('lms2700');
  p.location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r3' };
  expect(t.west.requestIncoming('lms2700', 'parcels')).toBeNull();
  t.workings.setRoute('sgc-west', 'sgc-east');
  return { t, g };
}

describe('running round while a train is offered from the other side (v0.3.39)', () => {
  it('with Sigsim Central’s 600 yd inner circuits the run round stays clear of the clearing points: no blocking back, nothing stuck', () => {
    const { t, g } = setUp(600);
    const asked: string[] = [];
    expect(
      t.until(() => {
        for (const w of t.sim.permissions('sigsim-central').waiting) asked.push(w.text);
        return g.working.locoEnd?.end === 1 && !t.sim.jobsText('sigsim-central').length;
      }, 900_000),
    ).toBe(true);
    expect(asked).toEqual([]);
    expect(t.west.irregularities).toEqual([]);
    // Away east once Line Clear is given.
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('3');
    t.tick(8000);
    expect(t.until(() => t.occupied().includes('T12'), 180_000)).toBe(true);
  });

  it('where it does foul the clearing point, the signaller can refuse the offered train (call attention instead of repeating it) and block back; the train is held', () => {
    const { t, g } = setUp(440);
    expect(t.until(() => t.sim.permissions('sigsim-central').waiting.some((w) => w.connId === 'sgc-west'), 60_000)).toBe(true);
    // The far box calls attention and, once answered, rings its offer; answer the offer with call attention and 2-4 instead.
    t.tick(3000);
    t.west.sendBell('1');
    expect(t.until(() => !!t.west.view.incoming?.offeredAt && !t.west.view.incoming.held, 120_000)).toBe(true);
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('2-4');
    expect(t.until(() => t.west.view.permission.rear === 'inside', 30_000)).toBe(true);
    t.west.setInstrument('TOL');
    expect(t.west.view.incoming?.held).toBe(true);
    expect(t.west.irregularities).toEqual([]);
    const blockedEast = { done: false };
    expect(
      t.until(() => {
        if (!blockedEast.done && t.sim.permissions('sigsim-central').waiting.some((w) => w.connId === 'sgc-east')) {
          t.east.sendBell('1');
          t.tick();
          t.east.sendBell('2-4');
          t.tick(8000);
          t.east.setInstrument('TOL');
          blockedEast.done = true;
        }
        return g.working.locoEnd?.end === 1 && !t.sim.jobsText('sigsim-central').length;
      }, 900_000),
    ).toBe(true);
  });
});

describe('the timetable runner leaves a run round its gap (v0.3.39)', () => {
  it('a train due to be offered into the station waits while an engine runs round there, then is offered', () => {
    const t = play();
    const bf = t.loco('lms5025');
    bf.location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' };
    bf.working = { trainTypeId: 'ordinary_passenger', consist: '4 coaches', headcode: '', locoEnd: { circuitId: 'sgc-t4', end: 1 } };
    t.loco('lms2700').location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r3' };
    t.tick(500);
    const l = t.state.layouts[0];
    const tt = addTimetable(t.state, l.id, 'sequence')!;
    const a = addTrain(t.state, l, tt, { locoId: 'lms5025' })!.entry;
    Object.assign(a, { kind: 'shunt', trainTypeId: 'light_engine', from: { placeId: 'sgc-station', roadId: 'sgc-p1' }, to: { placeId: 'sgc-station', roadId: 'sgc-p1' }, runRound: true });
    const b = addTrain(t.state, l, tt, { locoId: 'lms2700' })!.entry;
    Object.assign(b, { kind: 'run', trainTypeId: 'parcels', from: { placeId: 'fy-west', roadId: 'fy-west-r3' }, to: { placeId: 'fy-east', roadId: '' }, withPrevious: true });
    t.runner.load(tt);
    t.runner.start();
    t.tick(2000);
    const item = (e: typeof b) => t.runner.items.find((x) => x.entry.id === e.id)!;
    expect(t.sim.jobsText('sigsim-central').length).toBe(1);
    expect(item(b).status).toMatch(/Waiting until the move in the station is done/);
    expect(t.west.view.incoming).toBeNull();
    expect(t.until(() => item(a).state === 'done', 900_000)).toBe(true);
    expect(t.until(() => !!t.west.view.incoming, 60_000)).toBe(true);
    expect(t.west.view.incoming?.locoId).toBe('lms2700');
  });
});
