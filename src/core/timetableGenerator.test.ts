import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { createBectonState } from './testState';
import { defaultGeneratorOptions, generateTimetable, MIX_PRESETS, TimetableGenerator, jobCategory } from './timetableGenerator';
import { walkTimetable } from './timetables';
import type { AppState, GeneratorOptions } from './types';

const opts = (o: Partial<GeneratorOptions>): GeneratorOptions => ({ ...defaultGeneratorOptions(o.timing ?? 'sequence'), seed: 7, ...o });

/** Becton (a terminus with one fiddle yard) with jobs: a passenger loco, a goods loco and a pilot. */
function becton(): AppState {
  const s = createBectonState();
  const [a, b, c, d] = s.roster;
  a.jobs = [{ id: 'j1', kind: 'working', trainTypeId: 'ordinary_passenger', placeIds: ['fy1', 'becton-station'], weight: 3 }];
  b.jobs = [{ id: 'j2', kind: 'working', trainTypeId: 'branch_passenger', placeIds: [], weight: 2 }];
  c.jobs = [{ id: 'j3', kind: 'working', trainTypeId: 'pickup_goods', placeIds: ['fy1', 'becton-sidings'], weight: 2 }];
  d.jobs = [{ id: 'j4', kind: 'pilot', trainTypeId: 'light_engine', placeIds: ['becton-sidings', 'becton-station'], weight: 2 }];
  d.homePlaceId = 'becton-sidings';
  return s;
}

describe('timetable generator', () => {
  it('makes Sigsim Central timetables that pass the editor’s checks', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const timing of ['sequence', 'session', 'clock'] as const) {
        const s = createDefaultState();
        const l = s.layouts[0];
        const r = generateTimetable(s, l, opts({ timing, seed, busyness: seed % 2 ? 'busy' : 'quiet', mix: MIX_PRESETS[seed % MIX_PRESETS.length].mix }), 'Generated');
        const w = walkTimetable(s, l, r.tt);
        expect(r.tt.entries.length).toBeGreaterThan(3);
        expect({ seed, timing, errors: w.errors, warnings: w.warnings }).toEqual({ seed, timing, errors: 0, warnings: 0 });
      }
    }
  });

  it('works a terminus: trains turn round and the engine is released', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = becton();
      const l = s.layouts[0];
      const r = generateTimetable(s, l, opts({ timing: 'session', seed, length: 150 }), 'Becton');
      const w = walkTimetable(s, l, r.tt);
      expect({ seed, errors: w.errors, warnings: w.warnings }).toEqual({ seed, errors: 0, warnings: 0 });
      // Into the station as a passenger train, then a light engine move (release or running round).
      const arrivals = r.tt.entries.filter((e) => e.kind === 'run' && e.to.placeId === 'becton-station' && e.trainTypeId.endsWith('passenger'));
      for (const a of arrivals) {
        const mine = r.tt.entries.filter((e) => e.trainId === a.trainId);
        const next = mine[mine.indexOf(a) + 1];
        if (next) expect(next.trainTypeId).toBe('light_engine');
      }
    }
  });

  it('is the same for the same seed, and different for another', () => {
    const run = (seed: number) => {
      const s = createDefaultState();
      return generateTimetable(s, s.layouts[0], opts({ timing: 'session', seed }), 'G').tt.entries.map((e) => [e.trainId, e.kind, e.dep, e.from.roadId, e.to.roadId, e.headcode]);
    };
    expect(run(11)).toEqual(run(11));
    expect(run(11)).not.toEqual(run(12));
  });

  it('keeps to the length asked for', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    for (const length of [8, 20, 40]) {
      const n = generateTimetable(s, l, opts({ timing: 'sequence', length }), 'G').tt.entries.length;
      expect(n).toBeGreaterThanOrEqual(length - 2);
      expect(n).toBeLessThanOrEqual(length + 8);
    }
    const r = generateTimetable(s, l, opts({ timing: 'session', length: 90, startAt: 600 }), 'G').tt;
    expect(Math.min(...r.entries.map((e) => e.dep!))).toBeGreaterThanOrEqual(600);
    // Trains start within the 90 minutes (the last ones finish, and locos go home, after it).
    expect(r.trains.length).toBeGreaterThan(4);
    expect(Math.max(...r.entries.map((e) => e.dep!))).toBeLessThan(600 + 90 + 60);
  });

  it('follows the traffic mix', () => {
    const count = (mix: GeneratorOptions['mix']) => {
      const tally = { passenger: 0, goods: 0, shunting: 0 };
      for (let seed = 1; seed <= 20; seed++) {
        const s = createDefaultState();
        const r = generateTimetable(s, s.layouts[0], opts({ seed, mix, length: 30 }), 'G').tt;
        for (const t of r.trains) tally[jobCategory({ kind: t.name.startsWith('Pilot') ? 'pilot' : 'working', trainTypeId: t.anyWorking })]++;
      }
      return tally;
    };
    const pOnly = count({ passenger: 3, goods: 0, shunting: 0 });
    expect(pOnly.goods).toBe(0);
    const goods = count({ passenger: 1, goods: 3, shunting: 1 });
    const pass = count({ passenger: 3, goods: 1, shunting: 1 });
    expect(goods.goods).toBeGreaterThan(pass.goods);
    expect(pass.passenger).toBeGreaterThan(goods.passenger);
  });

  it('fills in headcodes for the layout’s era, and ends with locos at home or in a fiddle yard', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    l.headcodeEra = 'grouping';
    const r = generateTimetable(s, l, opts({ timing: 'sequence', length: 30 }), 'G').tt;
    const numbered = r.entries.filter((e) => e.headcode);
    expect(numbered.length).toBeGreaterThan(0);
    for (const e of numbered) expect(e.headcode).toMatch(/^[15]\d\d$/);
    expect(r.entries.filter((e) => e.trainTypeId === 'light_engine').every((e) => !e.headcode)).toBe(true);
    const w = walkTimetable(s, l, r);
    const last = w.steps[w.steps.length - 1].after;
    for (const u of w.units) {
      const p = last.get(u.key)!;
      const loco = s.roster.find((x) => x.id === u.locoId)!;
      expect(p.kind).toBe('place');
      if (p.kind === 'place') expect(p.placeId === loco.homePlaceId || l.places.find((x) => x.id === p.placeId)?.kind === 'fiddleYard').toBe(true);
    }
    expect(r.generated?.seed).toBe(7);
  });

  it('brings a loco on from off the layout when it is needed', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    s.roster[1].location = { kind: 'offLayout' };
    const r = generateTimetable(s, l, opts({ timing: 'sequence', length: 30, locoIds: s.roster.map((x) => x.id) }), 'G').tt;
    const first = r.entries.find((e) => r.trains.find((t) => t.id === e.trainId)?.locoId === s.roster[1].id);
    expect(first?.kind).toBe('enter');
    expect(walkTimetable(s, l, r).errors).toBe(0);
  });

  it('says so when no loco can take part', () => {
    const s = createDefaultState();
    for (const l of s.roster) delete l.jobs;
    const r = generateTimetable(s, s.layouts[0], opts({}), 'G');
    expect(r.tt.entries).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/No locos/);
    // A generator with locos chosen by hand uses their current working.
    const g = new TimetableGenerator(s, s.layouts[0], opts({ locoIds: [s.roster[0].id] }));
    expect(g.units.length).toBe(1);
  });
});
