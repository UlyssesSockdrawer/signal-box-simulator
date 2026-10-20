import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { applyRole, canWork, dutiesFor, isRailcar, migrateJob, pickWorking, rolesFor, runsLight } from './duties';
import { migrate } from './store';
import { defaultGeneratorOptions, generateTimetable } from './timetableGenerator';
import { locosFor, walkTimetable } from './timetables';
import type { Loco } from './types';

const dmu = (): Loco => ({
  id: 'dmu1',
  number: 'M79900',
  name: '',
  locoClass: 'BR Derby lightweight railcar',
  powerType: 'DMU',
  dccAddress: '79',
  notes: '',
  working: { trainTypeId: 'railcar', consist: '', headcode: '' },
  location: { kind: 'place', placeId: 'fy-east', roadId: 'fye-road4' },
  jobs: [{ id: 'j', duty: 'railcar', trainTypeId: '', placeIds: ['fy-east', 'sgc-station'], weight: 3 }],
  homePlaceId: 'fy-east',
});

describe('loco duties', () => {
  it('turns jobs by kind of train (v0.3.24–25) into duties, dropping light engine jobs', () => {
    const s = createDefaultState();
    const l = s.roster[0];
    (l as unknown as { jobs: unknown[] }).jobs = [
      { id: 'a', kind: 'working', trainTypeId: 'mineral', placeIds: ['fy-west'], weight: 3 },
      { id: 'b', kind: 'working', trainTypeId: 'branch_passenger', placeIds: [], weight: 1 },
      { id: 'c', kind: 'pilot', trainTypeId: 'light_engine', placeIds: ['sgc-goods'], weight: 2 },
      { id: 'd', kind: 'working', trainTypeId: 'light_engine', placeIds: [], weight: 2 },
    ];
    const m = migrate(JSON.parse(JSON.stringify(s)));
    expect(m.roster[0].jobs).toEqual([
      { id: 'a', duty: 'goods', trainTypeId: '', placeIds: ['fy-west'], weight: 3 },
      { id: 'b', duty: 'stopping', trainTypeId: 'branch_passenger', placeIds: [], weight: 1 },
      { id: 'c', duty: 'pilot', trainTypeId: '', placeIds: ['sgc-goods'], weight: 2 },
    ]);
    expect(migrateJob(s, { id: 'x', duty: 'expressGoods', trainTypeId: 'mineral', placeIds: [], weight: 2 })?.trainTypeId).toBe('');
  });

  it('lets any engine run light, a duty cover its workings, and keeps railcars to railcar work', () => {
    const s = createDefaultState();
    expect(locosFor(s, 'light_engine').length).toBe(s.roster.length);
    expect(locosFor(s, 'engine_brake_van').length).toBe(s.roster.length);
    // The Black Five does anything; the Coronation only expresses.
    const b5 = s.roster.find((l) => l.id === 'lms5025')!;
    const coronation = s.roster.find((l) => l.id === 'lms6233')!;
    for (const t of ['ordinary_passenger', 'express_passenger', 'parcels', 'ecs', 'freight_fitted_half', 'through_freight', 'mineral']) expect(canWork(s, b5, t)).toBe(true);
    expect(canWork(s, coronation, 'mineral')).toBe(false);
    const d = dmu();
    s.roster.push(d);
    expect(isRailcar(d)).toBe(true);
    expect(runsLight(d)).toBe('ecs');
    expect(canWork(s, d, 'light_engine')).toBe(false);
    expect(canWork(s, d, 'railcar')).toBe(true);
    expect(dutiesFor(s, d).map((x) => x.id)).toEqual(['railcar']);
    expect(rolesFor(d).map((r) => r.id)).toEqual(['railcar']);
    expect(rolesFor(b5).some((r) => r.id === 'railcar')).toBe(false);
  });

  it('picks a working within a duty, or the one a job is pinned to', () => {
    const s = createDefaultState();
    let n = 0;
    const rng = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(pickWorking(s, { duty: 'expressGoods', trainTypeId: '' }, rng));
    expect([...seen].sort()).toEqual(['freight_fitted_four', 'freight_fitted_half', 'freight_fitted_third', 'freight_unfitted']);
    expect(pickWorking(s, { duty: 'stopping', trainTypeId: '' }, rng)).toBe('ordinary_passenger');
    expect(pickWorking(s, { duty: 'stopping', trainTypeId: 'branch_passenger' }, rng)).toBe('branch_passenger');
    expect(pickWorking(s, { duty: 'pilot', trainTypeId: '' }, rng)).toBe('light_engine');
  });

  it('gives a loco a role', () => {
    const s = createDefaultState();
    const l = s.roster.find((x) => x.id === 'lms6233')!;
    applyRole(l, 'mixed');
    expect(l.jobs!.map((j) => j.duty).sort()).toEqual(['express', 'expressGoods', 'goods', 'parcels', 'stopping']);
    expect(canWork(s, l, 'mineral')).toBe(true);
  });

  it('generates railcar services that change ends and run empty, and goods engines that fetch their trains with a brake van', () => {
    let brakeVans = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const s = createDefaultState();
      s.roster.push(dmu());
      const l = s.layouts[0];
      const r = generateTimetable(s, l, { ...defaultGeneratorOptions('session'), seed, length: 180 }, 'G').tt;
      const w = walkTimetable(s, l, r);
      expect({ seed, errors: w.errors, warnings: w.warnings }).toEqual({ seed, errors: 0, warnings: 0 });
      const railcarTrains = new Set(r.trains.filter((t) => t.locoId === 'dmu1').map((t) => t.id));
      const mine = r.entries.filter((e) => railcarTrains.has(e.trainId));
      expect(mine.some((e) => e.trainTypeId === 'light_engine' || e.kind === 'shunt')).toBe(false);
      expect(mine.every((e) => e.trainTypeId === 'railcar' || e.trainTypeId === 'ecs')).toBe(true);
      // Into the station and straight back out again.
      for (const e of mine.filter((x) => x.to.placeId === 'sgc-station')) {
        const next = mine[mine.indexOf(e) + 1];
        if (next) expect(next.kind).toBe('run');
      }
      brakeVans += r.entries.filter((e) => e.trainTypeId === 'engine_brake_van').length;
    }
    expect(brakeVans).toBeGreaterThan(0);
  });
});
