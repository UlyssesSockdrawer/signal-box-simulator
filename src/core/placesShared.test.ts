import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { addRoad, roadOfCircuit, roadsOfCircuit, roadTrackKey, sharedOccupants, sharedRoads, tieRoad } from './places';
import { circuitLength } from './railway';
import { mergeAtJoint, splitCircuit } from './trackPlan';
import { addTimetable, addTrain, walkTimetable } from './timetables';

describe('a track circuit as a road of several places (v0.3.35)', () => {
  it('a platform can also be the goods depot’s parcels dock; within one place it is one road only', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    const goods = l.places.find((p) => p.id === 'sgc-goods')!;
    const dock = addRoad(goods, 'Parcels dock')!;
    tieRoad(l, goods.id, dock.id, 'sgc-t5');
    // P2 (sgc-t5) is still P2 of the station as well.
    expect(roadsOfCircuit(l, 'sgc-t5').map((x) => `${x.place.id}:${x.road.name}`)).toEqual(['sgc-station:P2', 'sgc-goods:Parcels dock']);
    expect(roadOfCircuit(l, 'sgc-t5')?.road.name).toBe('P2');
    expect(sharedRoads(l, goods.id, dock.id).map((x) => x.road.name)).toEqual(['P2']);
    expect(roadTrackKey(l, { placeId: goods.id, roadId: dock.id })).toBe(roadTrackKey(l, { placeId: 'sgc-station', roadId: 'sgc-p2' }));
    // Tying another goods road to it unties the dock (one road per place).
    tieRoad(l, goods.id, 'sgc-siding', 'sgc-t5');
    expect(dock.circuitId).toBeUndefined();
    expect(roadsOfCircuit(l, 'sgc-t5')).toHaveLength(2);
  });

  it('a train on one of them occupies the others: shown in the place, and the timetable checks warn', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    const goods = l.places.find((p) => p.id === 'sgc-goods')!;
    const dock = addRoad(goods, 'Parcels dock')!;
    tieRoad(l, goods.id, dock.id, 'sgc-t5');
    const bf = s.roster.find((x) => x.id === 'lms5025')!;
    bf.location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p2' };
    expect(sharedOccupants(s, l, goods.id, dock.id).map((x) => x.loco.id)).toEqual(['lms5025']);
    const tt = addTimetable(s, l.id, 'sequence')!;
    const { entry } = addTrain(s, l, tt, { locoId: 'lms5690' })!;
    entry.kind = 'run';
    entry.from = { placeId: 'fy-east', roadId: '' };
    entry.to = { placeId: goods.id, roadId: dock.id };
    const { entry: e2 } = addTrain(s, l, tt, { locoId: 'lms5025' })!;
    e2.kind = 'shunt';
    e2.from = { placeId: 'sgc-station', roadId: 'sgc-p2' };
    e2.to = { placeId: 'sgc-station', roadId: 'sgc-p2' };
    tt.entries = [e2, entry];
    const w = walkTimetable(s, l, tt);
    expect(w.steps[1].issues.map((i) => i.code)).toContain('roadTaken');
  });
});

describe('track circuit lengths typed in (v0.3.35)', () => {
  it('are used as typed; split, the two parts share it; merged, two typed lengths add up', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    const p1 = l.trackPlan.circuits.find((c) => c.id === 'sgc-t4')!;
    p1.length = 300;
    expect(circuitLength(s, l, p1)).toEqual({ metres: 300, basis: 'stated' });
    const r = splitCircuit(l.trackPlan, p1.id);
    expect(r.error).toBeUndefined();
    const a = p1.length!;
    const b = r.newCircuit!.length!;
    expect(a + b).toBeCloseTo(300, 1);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    const joint = l.trackPlan.junctions.find((j) => j.kind === 'joint' && p1.ends.some((e) => e.kind === 'joined' && e.junctionId === j.id) && r.newCircuit!.ends.some((e) => e.kind === 'joined' && e.junctionId === j.id))!;
    const m = mergeAtJoint(l.trackPlan, joint.id, p1.id);
    expect(m.circuitId).toBe(p1.id);
    expect(p1.length).toBeCloseTo(300, 1);
  });
});
