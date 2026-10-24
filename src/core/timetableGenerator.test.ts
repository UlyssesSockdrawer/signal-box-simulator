import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { createBectonState } from './testState';
import { dutyOf } from './duties';
import { defaultGeneratorOptions, generateTimetable, MIX_PRESETS, TimetableGenerator, jobCategory } from './timetableGenerator';
import { walkTimetable } from './timetables';
import type { AppState, GeneratorOptions } from './types';

const opts = (o: Partial<GeneratorOptions>): GeneratorOptions => ({ ...defaultGeneratorOptions(o.timing ?? 'sequence'), seed: 7, ...o });

/** Becton (a terminus with one fiddle yard) with jobs: a passenger loco, a goods loco and a pilot. */
function becton(): AppState {
  const s = createBectonState();
  const [a, b, c, d] = s.roster;
  a.jobs = [{ id: 'j1', duty: 'stopping', trainTypeId: '', placeIds: ['fy1', 'becton-station'], weight: 3 }];
  b.jobs = [{ id: 'j2', duty: 'stopping', trainTypeId: 'branch_passenger', placeIds: [], weight: 2 }];
  c.jobs = [{ id: 'j3', duty: 'pickup', trainTypeId: '', placeIds: ['fy1', 'becton-sidings'], weight: 2 }];
  d.jobs = [{ id: 'j4', duty: 'pilot', trainTypeId: '', placeIds: ['becton-sidings', 'becton-station'], weight: 2 }];
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
        for (const t of r.trains) {
          if (t.name.startsWith('Light engine')) continue; // going home at the end
          tally[t.name.startsWith('Pilot') ? 'shunting' : jobCategory({ duty: dutyOf(s, t.anyWorking) ?? 'goods', trainTypeId: t.anyWorking }, s)]++;
        }
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

describe('engine release when generating (v0.3.35)', () => {
  it('knows from the plan where an engine stands and whether it can get away: P1 has a loop, the goods siding buffer stops', async () => {
    const { engineRelease } = await import('./runRound');
    const s = createDefaultState();
    const l = s.layouts[0];
    expect(engineRelease(s, l, 'sigsim-central', 'sgc-west', { placeId: 'sgc-station', roadId: 'sgc-p1' })).toEqual({ known: true, canLeave: true, canRunRound: true });
    expect(engineRelease(s, l, 'sigsim-central', 'sgc-west', { placeId: 'sgc-goods', roadId: 'sgc-siding' })).toMatchObject({ known: true, canLeave: false, canRunRound: false });
  });

  it('marks running round as a run round move', () => {
    let found = 0;
    for (let seed = 1; seed <= 40 && !found; seed++) {
      const s = createDefaultState();
      const r = generateTimetable(s, s.layouts[0], opts({ timing: 'session', seed, length: 180, mix: MIX_PRESETS[1].mix }), 'G');
      found += r.tt.entries.filter((e) => e.runRound && e.kind === 'shunt' && e.from.roadId === e.to.roadId && /Run round/.test(e.notes)).length;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('an engine trapped at buffer stops is released by the station pilot, with time for it before the train leaves', () => {
    let found = 0;
    for (let seed = 1; seed <= 60 && !found; seed++) {
      const s = createDefaultState();
      const l = s.layouts[0];
      // Treat the goods yard as a station: its roads end at buffer stops, with no way round.
      l.places.find((p) => p.id === 'sgc-goods')!.kind = 'station';
      for (const x of s.roster) if (x.id !== 'lms7298') x.jobs = x.id === 'lms5025' ? [{ id: 'j', duty: 'stopping', trainTypeId: 'ordinary_passenger', placeIds: ['fy-west', 'sgc-goods'], weight: 3 }] : [];
      const r = generateTimetable(s, l, opts({ timing: 'session', seed, length: 150, mix: { passenger: 3, goods: 0, shunting: 1 } }), 'G');
      const w = walkTimetable(s, l, r.tt);
      expect({ seed, errors: w.errors }).toEqual({ seed, errors: 0 });
      for (const e of r.tt.entries.filter((x) => x.runRound && /station pilot/.test(x.notes))) {
        found++;
        const mine = r.tt.entries.filter((x) => x.trainId === e.trainId);
        const next = mine[mine.indexOf(e) + 1];
        expect(next.kind).toBe('run');
        expect(next.dep! - e.dep!).toBeGreaterThanOrEqual(20);
        // The pilot is not given other work meanwhile.
        const pilotMoves = r.tt.entries.filter((x) => r.tt.trains.find((t) => t.id === x.trainId)?.locoId === 'lms7298');
        for (const p of pilotMoves) expect(p.dep! < e.dep! || p.dep! >= e.dep! + 22).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('sometimes changes engines: one goes on shed, another comes off and takes the train out', () => {
    let found = 0;
    for (let seed = 1; seed <= 60 && !found; seed++) {
      const s = becton();
      const l = s.layouts[0];
      l.places.push({ id: 'becton-shed', kind: 'depot', name: 'Becton shed', shortName: 'SHD', notes: '', roads: [{ id: 'shed1', name: 'Shed 1', notes: '' }, { id: 'shed2', name: 'Shed 2', notes: '' }], workedBy: [{ kind: 'box', boxId: 'becton' }] });
      const b = s.roster[1];
      b.location = { kind: 'place', placeId: 'becton-shed', roadId: 'shed1' };
      b.jobs = [{ id: 'jb', duty: 'stopping', trainTypeId: 'ordinary_passenger', placeIds: ['fy1', 'becton-station'], weight: 1 }];
      const r = generateTimetable(s, l, opts({ timing: 'session', seed, length: 150 }), 'G');
      const w = walkTimetable(s, l, r.tt);
      expect({ seed, errors: w.errors }).toEqual({ seed, errors: 0 });
      for (const t of r.tt.trains.filter((x) => x.notes.startsWith('Engine change'))) {
        found++;
        const mine = r.tt.entries.filter((x) => x.trainId === t.id);
        expect(mine[0].kind).toBe('shunt');
        expect(mine[0].to.placeId).toBe('becton-station');
        expect(mine[1]).toMatchObject({ kind: 'run', from: mine[0].to });
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('turntables, servicing and carriage sidings when generating (v0.3.36)', () => {
  const place = (id: string, kind: import('./types').PlaceKind, name: string, roads = 1) => ({ id, kind, name, shortName: '', notes: '', roads: Array.from({ length: roads }, (_, i) => ({ id: `${id}-r${i + 1}`, name: `Road ${i + 1}`, notes: '' })), workedBy: [{ kind: 'box' as const, boxId: 'becton' }] });
  /** Becton with only the tender engine working stopping trains in and out. */
  const terminus = () => {
    const s = becton();
    for (const l of s.roster) l.jobs = [];
    s.roster[0].jobs = [{ id: 'j1', duty: 'stopping', trainTypeId: 'ordinary_passenger', placeIds: ['fy1', 'becton-station'], weight: 3 }];
    return s;
  };
  const gen = (s: AppState, seed: number) => {
    const l = s.layouts[0];
    const r = generateTimetable(s, l, opts({ timing: 'session', seed, length: 150 }), 'G');
    const w = walkTimetable(s, l, r.tt);
    expect({ seed, errors: w.errors }).toEqual({ seed, errors: 0 });
    return r.tt;
  };

  it('turns a steam engine on the turntable before it works back, and coals or waters it', () => {
    let turned = 0;
    let serviced = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = terminus();
      s.layouts[0].places.push(place('tt', 'turntable', 'Becton turntable'), place('coal', 'coaling', 'Becton coal stage'), place('water', 'water', 'Becton water column'));
      const tt = gen(s, seed);
      const arrivals = tt.entries.filter((e) => e.kind === 'run' && e.to.placeId === 'becton-station');
      for (const a of arrivals) {
        const mine = tt.entries.filter((e) => e.trainId === a.trainId);
        const after = mine.slice(mine.indexOf(a) + 1);
        const out = after.findIndex((e) => e.kind === 'run');
        if (out < 0) continue;
        const between = after.slice(0, out);
        expect(between.some((e) => e.to.placeId === 'tt')).toBe(true);
        turned++;
        if (between.some((e) => e.to.placeId === 'coal' || e.to.placeId === 'water')) serviced++;
        expect(after[out].notes).not.toMatch(/tender first/);
      }
    }
    expect(turned).toBeGreaterThan(0);
    expect(serviced).toBeGreaterThan(0);
  });

  it('with no turntable it says the engine runs tender first', () => {
    let found = 0;
    for (let seed = 1; seed <= 10; seed++) found += gen(terminus(), seed).entries.filter((e) => /Runs tender first/.test(e.notes)).length;
    expect(found).toBeGreaterThan(0);
  });

  it('a box beyond with a turntable turns it: light engine there and back', () => {
    let found = 0;
    for (let seed = 1; seed <= 20 && !found; seed++) {
      const s = terminus();
      s.boxes[0].connections[0].turntable = true;
      const tt = gen(s, seed);
      for (const e of tt.entries.filter((x) => x.kind === 'run' && x.trainTypeId === 'light_engine' && x.to.placeId === 'fy1' && /to be turned/.test(x.notes))) {
        found++;
        const mine = tt.entries.filter((x) => x.trainId === e.trainId);
        const next = mine[mine.indexOf(e) + 1];
        expect(next).toMatchObject({ kind: 'run', trainTypeId: 'light_engine', from: { placeId: 'fy1' } });
        expect(next.notes).toMatch(/turned/);
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('empty stock to the carriage sidings and back into a platform for its next working', () => {
    let found = 0;
    for (let seed = 1; seed <= 30 && !found; seed++) {
      const s = terminus();
      s.layouts[0].places.push(place('cs', 'carriageSidings', 'Becton carriage sidings', 2));
      const tt = gen(s, seed);
      const out = tt.entries.filter((e) => e.kind === 'shunt' && e.trainTypeId === 'ecs' && e.from.placeId === 'becton-station' && e.to.placeId === 'cs');
      for (const e of out) {
        found++;
        const mine = tt.entries.filter((x) => x.trainId === e.trainId);
        const back = mine.slice(mine.indexOf(e) + 1).find((x) => x.trainTypeId === 'ecs');
        expect(back).toMatchObject({ kind: 'shunt', from: { placeId: 'cs' }, to: { placeId: 'becton-station' } });
        expect(mine[mine.indexOf(back!) + 1]).toMatchObject({ kind: 'run', from: back!.to });
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('run rounds in generated timetables (v0.3.39)', () => {
  it('plan a run round with time for it, and keep other trains off the lines into the station meanwhile; goods trains too', () => {
    let rounds = 0;
    let goodsRounds = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = createDefaultState();
      const l = s.layouts[0];
      const tt = generateTimetable(s, l, opts({ timing: 'session', seed, length: 240, busyness: 'busy' }), 'G').tt;
      for (const rr of tt.entries.filter((e) => e.runRound && e.dep !== null)) {
        rounds++;
        const train = tt.trains.find((x) => x.id === rr.trainId)!;
        const own = tt.entries.filter((e) => e.trainId === rr.trainId);
        const next = own[own.indexOf(rr) + 1];
        // Time for it: the train leaves at least 11 minutes after the run round starts (8 for the move, 3 to spare).
        if (next) expect(next.dep! - rr.dep!).toBeGreaterThanOrEqual(11);
        if (own.some((e) => !['ordinary_passenger', 'express_passenger', 'branch_passenger', 'parcels', 'ecs', 'light_engine'].includes(e.trainTypeId))) goodsRounds++;
        // No other train runs on a line (every run at Sigsim Central does) while it runs round.
        const until = rr.dep! + 8;
        const others = tt.entries.filter((e) => e.trainId !== rr.trainId && e.kind === 'run' && e.dep !== null && e.arr !== null && e.dep < until && rr.dep! < e.arr);
        expect(others.map((e) => `${e.headcode} ${e.dep}-${e.arr}`), `${train.name} runs round at ${rr.dep}`).toEqual([]);
      }
    }
    expect(rounds).toBeGreaterThan(0);
    expect(goodsRounds).toBeGreaterThan(0);
  });
});
