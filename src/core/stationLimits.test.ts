import { mintFromConsist } from './stock';
import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { accept, play } from './simHarness';
import { clearingPointCircuits, clearingPointZones, stretchFouls } from './stationLimits';
import { addTimetable, addTrain } from './timetables';

describe('station limits and the clearing point', () => {
  it('Sigsim Central: the clearing point (440 yd in) lies within the 600 yd inner circuits, measured exactly; more of the station with a longer one', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    expect([...clearingPointCircuits(s, l, s.boxes[0], 'sgc-west')]).toEqual(['sgc-twi']);
    expect([...clearingPointCircuits(s, l, s.boxes[0], 'sgc-east')]).toEqual(['sgc-tei']);
    const twi = l.trackPlan.circuits.find((c) => c.id === 'sgc-twi')!;
    expect(twi.length).toBeCloseTo(600 * 0.9144, 6);
    const zones = clearingPointZones(s, l, s.boxes[0], 'sgc-west').get('sgc-twi')!;
    expect(zones).toHaveLength(1);
    expect(zones[0].metres).toBeCloseTo(402.336, 3);
    // An engine drawn 30 m clear of the points (at the inner end) does not foul it; one running the whole circuit does.
    const fromPoints = (1 - zones[0].end) as 0 | 1; // entered from the points end, it runs towards the home signal
    expect(stretchFouls(zones, { toward: (1 - fromPoints) as 0 | 1, metres: 30 }, twi.length!)).toBe(false);
    expect(stretchFouls(zones, { toward: (1 - fromPoints) as 0 | 1, metres: 200 }, twi.length!)).toBe(true);
    expect(stretchFouls(zones, { toward: zones[0].end === 0 ? 1 : 0, metres: twi.length! }, twi.length!)).toBe(true);
    l.clearingPoint = 700;
    expect([...clearingPointCircuits(s, l, s.boxes[0], 'sgc-west')].sort()).toEqual(['sgc-t3', 'sgc-t4', 'sgc-t5', 'sgc-t6', 'sgc-t7', 'sgc-twi']);
  });

  it('a long goods train leaving the yard draws forward over the clearing point to set back: it waits for 2-4, and the line is given back with 2-1', () => {
    const t = play();
    const goods = t.loco('lms8233');
    goods.location = { kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-siding' };
    // Long enough (about 400 m) that drawing forward clear of the points takes it over the clearing point.
    goods.working.consist = '60 wagons + brake van';
    t.east.setOutgoing('lms8233', 'mineral');
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('4-1');
    t.tick(8000);
    // Too long for the West end (it must be clear of the points to set back): it runs on into the West inner, far enough to foul the clearing point, which needs 2-4.
    expect(t.until(() => t.sim.permissions('sigsim-central').waiting.length > 0, 120_000)).toBe(true);
    expect(t.sim.permissions('sigsim-central').waiting[0]).toMatchObject({ locoId: 'lms8233', connId: 'sgc-west', kind: 'inside' });
    t.tick(20_000);
    expect(t.occupied()).not.toContain('T3');
    expect(t.sim.outgoingText('sigsim-central', 'sgc-east')).toMatch(/2-4/);
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('2-4');
    const seen = new Set<string>();
    expect(t.until(() => (t.occupied().forEach((c) => seen.add(c)), t.west.view.permission.rear === 'inside'))).toBe(true);
    t.west.setInstrument('TOL');
    expect(t.until(() => (t.occupied().forEach((c) => seen.add(c)), !t.sim.permissions('sigsim-central').inUse.has('sgc-west')), 300_000)).toBe(true);
    expect(seen).toContain('T3');
    // Clear of the West inner: give the line back.
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('2-1');
    t.tick(6000);
    t.west.setInstrument('LB');
    expect(t.west.view.permission.rear).toBeNull();
    t.east.sendBell('2');
    expect(t.until(() => !!t.east.view.outgoing?.arrived)).toBe(true);
    expect(t.west.irregularities).toEqual([]);
    expect(t.east.irregularities).toEqual([]);
  });

  it('a train too long to set back inside the station limits draws forward into the section: 3-3-2, then 8 once it is back', () => {
    const t = play();
    t.state.layouts[0].trackPlan.circuits.find((c) => c.id === 'sgc-twi')!.length = 60;
    t.loco('lms6233').location = { kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-siding' };
    t.east.setOutgoing('lms6233', 'express_passenger');
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('4');
    t.tick(8000);
    expect(t.until(() => t.sim.permissions('sigsim-central').waiting.length > 0, 120_000)).toBe(true);
    expect(t.sim.permissions('sigsim-central').waiting[0]).toMatchObject({ connId: 'sgc-west', kind: 'forward' });
    expect(t.sim.outgoingText('sigsim-central', 'sgc-east')).toMatch(/3-3-2/);
    t.tick(20_000);
    expect(t.occupied()).not.toContain('T2');
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('3-3-2');
    const seen = new Set<string>();
    expect(t.until(() => (t.occupied().forEach((c) => seen.add(c)), !t.sim.permissions('sigsim-central').inUse.has('sgc-west')), 300_000)).toBe(true);
    // Out on to the line past the advanced starter, and back.
    expect(seen).toContain('T2');
    expect(t.west.view.remoteInstrument).toBe('TOL');
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('8');
    t.tick(6000);
    expect(t.west.view.remoteInstrument).toBe('LB');
    expect(t.west.view.permission.forward).toBeNull();
    t.east.sendBell('2');
    expect(t.until(() => !!t.east.view.outgoing?.arrived)).toBe(true);
    expect([...t.west.irregularities, ...t.east.irregularities]).toEqual([]);
  });

  it('Line Clear given with the clearing point obstructed is scored', () => {
    const t = play();
    t.loco('lms7298').location = { kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-siding' };
    const scored: string[] = [];
    t.west.events.on('score', (e) => scored.push(e.rule));
    // A shunt standing in the West inner (blocked back), then a train accepted from the west.
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('2-4');
    t.tick(6000);
    t.west.setInstrument('TOL');
    t.state.layouts[0].stock = [{ id: 'r1', vehicles: mintFromConsist('4 wagons'), placeId: '', roadId: '', circuitId: 'sgc-twi' }];
    t.tick(1000);
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('2-1');
    t.tick(6000);
    t.west.setInstrument('LB');
    t.west.requestIncoming('lms6233', 'express_passenger');
    accept(t, t.west, '4');
    expect(scored).toContain('lc_clearing_point');
  });

  it('a timetabled shunt that fits where it sets back needs no permission', () => {
    const t = play();
    const tt = addTimetable(t.state, t.state.layouts[0].id, 'sequence')!;
    const { entry } = addTrain(t.state, t.state.layouts[0], tt, { locoId: 'lms7298' })!;
    entry.kind = 'shunt';
    entry.trainTypeId = 'light_engine';
    entry.to = { placeId: 'sgc-station', roadId: '' };
    t.runner.load(tt);
    t.runner.start();
    expect(t.until(() => t.runner.items[0].state === 'done')).toBe(true);
    expect(t.west.view.permission.rear).toBeNull();
  });
});
