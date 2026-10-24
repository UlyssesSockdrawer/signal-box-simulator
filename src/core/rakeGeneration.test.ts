import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { migrate } from './store';
import { emptyRollingStock, fittedHead, fromEngine, mintVehicle, resolveVehicle, stockLibrary } from './stock';
import { stockCompanies, stockEraOf, stockParams } from './stockLibrary';
import {
  findRakeType,
  generateRake,
  layoutStock,
  marshal,
  pickRakeType,
  previewTrainStock,
  RAKE_TYPES,
  rakeTypesFor,
  rakeTypesOf,
  rakeTypeWeight,
  resolveRakeType,
  resolveTrainStock,
  seededRandom,
  stockKindFor,
  trainLimit,
} from './trainStock';
import { defaultGeneratorOptions, generateTimetable, MIX_PRESETS } from './timetableGenerator';
import { circuitLength, locoLength } from './railway';
import { addTimetable, addTrain } from './timetables';
import type { RakeType } from './stockTypes';

const lib = stockLibrary();
const rt = (id: string) => RAKE_TYPES.find((x) => x.id === id)!;
const classes = (vs: { classId: string }[]) => vs.map((v) => v.classId);

describe('the layout’s company and era (v0.3.41, D25)', () => {
  it('ships Sigsim Central set to LMS, with the era from its headcode era', () => {
    const s = createDefaultState();
    expect(stockCompanies()).toContain('LMS');
    expect(layoutStock(s.layouts[0]).company).toBe('LMS');
    s.layouts[0].headcodeEra = 'grouping';
    expect(layoutStock(s.layouts[0]).era).toBe('grouping');
    expect(stockEraOf('brLamps')).toBe('postwar');
    expect(layoutStock(undefined)).toEqual({ company: 'generic', era: 'br1960' });
  });

  it('sets an older save’s Sigsim Central to LMS once, and drops a company it has no data for', () => {
    const old = createDefaultState() as unknown as Record<string, unknown> & { layouts: Array<Record<string, unknown>> };
    old.schemaVersion = 9;
    delete old.layouts[0].stockCompany;
    expect(migrate(structuredClone(old)).layouts[0].stockCompany).toBe('LMS');
    // A current save keeps the user's choice of generic.
    const cur = createDefaultState();
    delete cur.layouts[0].stockCompany;
    expect(migrate(structuredClone(cur)).layouts[0].stockCompany).toBeUndefined();
    cur.layouts[0].stockCompany = 'lms';
    expect(migrate(structuredClone(cur)).layouts[0].stockCompany).toBe('LMS');
    cur.layouts[0].stockCompany = 'Southern Railway';
    expect(migrate(structuredClone(cur)).layouts[0].stockCompany).toBeUndefined();
  });
});

describe('train limits (D13)', () => {
  it('default to the company’s table and can be overridden per train type', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    expect(trainLimit(s, l, 'mineral').maxVehicles).toBe(90);
    expect(trainLimit(s, l, 'express_passenger')).toEqual({ maxVehicles: 15, maxTons: 500 });
    s.trainTypes.find((t) => t.id === 'mineral')!.maxVehicles = 12;
    expect(trainLimit(s, l, 'mineral').maxVehicles).toBe(12);
    expect(trainLimit(s, l, 'light_engine')).toEqual({});
  });

  it('are cleaned on load: whole numbers above nought, else the default', () => {
    const s = createDefaultState();
    Object.assign(s.trainTypes[0], { maxVehicles: 12.4, maxTons: -3 });
    const m = migrate(structuredClone(s));
    expect(m.trainTypes[0].maxVehicles).toBe(12);
    expect(m.trainTypes[0].maxTons).toBeUndefined();
  });

  it('cap a generated rake', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    s.trainTypes.find((t) => t.id === 'mineral')!.maxVehicles = 10;
    const tt = addTimetable(s, l.id)!;
    const a = addTrain(s, l, tt, { locoId: 'lms5025' })!;
    a.train.stock = { mode: 'type', rakeTypeId: 'rt-mineral' };
    for (let seed = 1; seed < 20; seed++) {
      const c = resolveTrainStock(s, l, a.train, { mode: 'play', trainTypeId: 'mineral', rng: seededRandom(seed) })!;
      expect(c.vehicles.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('goods mix and block trains (D9)', () => {
  it('fills mix slots from the company’s goods mix, respecting the slot’s brake', () => {
    const lms = stockParams('LMS', ['grouping']);
    const got = new Set<string>();
    for (let seed = 1; seed < 30; seed++) for (const v of resolveRakeType(rt('rt-unfitted-goods'), lib, seededRandom(seed), {}, { params: lms })) got.add(v.classId);
    const mixIds = new Set(lms.goodsMix.map((m) => m.classId));
    const wagons = [...got].filter((c) => lib.cls(c)?.category !== 'brakeVan');
    expect(wagons.length).toBeGreaterThan(2);
    for (const c of wagons) {
      expect(mixIds.has(c), c).toBe(true);
      expect(lib.cls(c)!.fitted, c).toBe(false);
    }
  });

  it('falls back to the slot’s own types when the mix has nothing that fits', () => {
    const p = { ...stockParams(), goodsMix: [{ classId: 'generic-vent-van-12t-fitted', weight: 1 }] };
    const vs = resolveRakeType(rt('rt-pickup-goods'), lib, seededRandom(1), {}, { params: p });
    expect(vs.filter((v) => lib.cls(v.classId)?.category !== 'brakeVan').every((v) => rt('rt-pickup-goods').slots[0].classIds.includes(v.classId))).toBe(true);
  });

  it('makes block trains rarer in the grouping era for LMS', () => {
    const lms = stockParams('LMS', ['grouping']);
    expect(rakeTypeWeight(rt('rt-mineral'), lms, 'grouping')).toBeCloseTo(rt('rt-mineral').weight * 0.3);
    expect(rakeTypeWeight(rt('rt-mineral'), lms, 'br1960')).toBe(rt('rt-mineral').weight);
    expect(rakeTypeWeight(rt('rt-unfitted-goods'), lms, 'grouping')).toBe(rt('rt-unfitted-goods').weight);
    const types = [rt('rt-fitted-goods'), { ...rt('rt-fitted-goods'), id: 'x', block: false }];
    const r = seededRandom(5);
    let block = 0;
    for (let i = 0; i < 1000; i++) if (pickRakeType(types, lms, 'grouping', r)!.id === 'rt-fitted-goods') block++;
    expect(block).toBeLessThan(350);
    expect(block).toBeGreaterThan(130);
  });
});

describe('marshalling (D5, D5a)', () => {
  it('puts fitted goods vehicles next the engine and the brake van at the tail', () => {
    const vs = ['generic-open-7plank-12t', 'generic-brake-van-20t-fitted', 'generic-vent-van-12t-fitted', 'generic-open-7plank-12t', 'generic-vent-van-12t-fitted'].map(mintVehicle);
    expect(classes(marshal(vs, lib))).toEqual(['generic-vent-van-12t-fitted', 'generic-vent-van-12t-fitted', 'generic-open-7plank-12t', 'generic-open-7plank-12t', 'generic-brake-van-20t-fitted']);
  });

  it('gives a goods train with no guard’s vehicle a brake van, fitted when it has a fitted head', () => {
    const plain = marshal(['generic-open-7plank-12t', 'generic-open-7plank-12t'].map(mintVehicle), lib);
    expect(lib.cls(plain[plain.length - 1].classId)).toMatchObject({ category: 'brakeVan', fitted: false });
    const headed = marshal(['generic-vent-van-12t-fitted', 'generic-open-7plank-12t', 'generic-brake-van-20t'].map(mintVehicle), lib, 'LMS', 'grouping');
    expect(headed[headed.length - 1].classId).toBe('LMS-bv-20t-1934-fitted');
    expect(headed.filter((v) => lib.cls(v.classId)?.category === 'brakeVan').length).toBe(1);
  });

  it('puts coaching stock first in a mixed train and leaves a passenger set’s order alone', () => {
    const set = ['generic-passenger-brake-57', 'generic-coach-57', 'generic-passenger-brake-57'].map(mintVehicle);
    expect(marshal(set, lib)).toEqual(set);
    const mixed = marshal([mintVehicle('generic-open-7plank-12t'), ...set, mintVehicle('generic-brake-van-20t')], lib);
    expect(classes(mixed).slice(0, 3)).toEqual(classes(set));
    expect(mixed[mixed.length - 1].classId).toBe('generic-brake-van-20t');
  });

  it('gives every generated goods rake a brake van, and pick-up and branch goods no fitted vehicles', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    l.headcodeEra = 'grouping';
    for (const id of ['freight_fitted_half', 'freight_fitted_third', 'freight_unfitted', 'mineral', 'pickup_goods', 'branch_freight'])
      for (const t of rakeTypesFor(id, rakeTypesOf(l)))
        for (let seed = 1; seed < 8; seed++) {
          const vs = generateRake(t, l, lib, id, seededRandom(seed));
          const rv = vs.map((v) => resolveVehicle(v, lib));
          expect(rv[rv.length - 1].cls?.category, `${id} ${t.id}`).toBe('brakeVan');
          if (fittedHead(fromEngine(rv, 'A')) > 0) expect(rv[rv.length - 1].fitted, `${id} ${t.id}`).toBe(true);
          if (id === 'pickup_goods' || id === 'branch_freight') expect(rv.filter((v) => v.cls?.category !== 'brakeVan').every((v) => !v.fitted), t.id).toBe(true);
        }
  });
});

describe('generation within the road (v0.3.41)', () => {
  it('is reproducible from its seed', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    const a = classes(generateRake(rt('rt-unfitted-goods'), l, lib, 'freight_unfitted', seededRandom(99)));
    const b = classes(generateRake(rt('rt-unfitted-goods'), l, lib, 'freight_unfitted', seededRandom(99)));
    expect(a).toEqual(b);
  });

  it('fits the road it is to stand in: a short platform gives a shorter rake', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    const long = generateRake(rt('rt-express'), l, lib, 'express_passenger', undefined, { maxMetres: 400 });
    const short = generateRake(rt('rt-express'), l, lib, 'express_passenger', undefined, { maxMetres: 170 });
    const metres = (vs: typeof long) => vs.reduce((m, v) => m + resolveVehicle(v, lib).metres, 0);
    expect(short.length).toBeLessThan(long.length);
    expect(metres(short)).toBeLessThanOrEqual(170);
  });
});

describe('a layout’s own rake types (D27)', () => {
  const own: RakeType = { id: 'my-type', name: 'My branch set', trainTypeIds: ['branch_passenger'], weight: 5, origin: 'generic', slots: [{ classIds: ['generic-passenger-brake-57'], min: 2, max: 2 }] };

  it('are offered first, with hidden built-ins left out of lists but still found by id', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    l.rollingStock = { ...emptyRollingStock(), rakeTypes: [own], hiddenRakeTypes: ['rt-local'] };
    const list = rakeTypesOf(l);
    expect(list[0].id).toBe('my-type');
    expect(list.some((t) => t.id === 'rt-local')).toBe(false);
    expect(findRakeType('rt-local', l)?.id).toBe('rt-local');
    expect(findRakeType('my-type', l)?.name).toBe('My branch set');
    expect(rakeTypesFor('branch_passenger', list).map((t) => t.id)).toEqual(['my-type', 'rt-push-pull']);
  });

  it('are used by "any suitable"', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    l.rollingStock = { ...emptyRollingStock(), rakeTypes: [own], hiddenRakeTypes: ['rt-local', 'rt-push-pull'] };
    const tt = addTimetable(s, l.id)!;
    const a = addTrain(s, l, tt, { locoId: 'lms5025' })!;
    expect(resolveTrainStock(s, l, a.train, { mode: 'play', trainTypeId: 'branch_passenger', rng: seededRandom(1) })!.rakeTypeId).toBe('my-type');
  });

  it('are kept on load, and a copy may not take a built-in’s id', () => {
    const s = createDefaultState();
    s.layouts[0].rollingStock = { ...emptyRollingStock(), rakeTypes: [own, { ...own, id: 'rt-local' }, { ...own, id: 'bad', slots: [] }], hiddenRakeTypes: ['rt-express', 'nope'] };
    const rs = migrate(structuredClone(s)).layouts[0].rollingStock!;
    expect(rs.rakeTypes!.map((t) => t.id)).toEqual(['my-type']);
    expect(rs.hiddenRakeTypes).toEqual(['rt-express']);
  });
});

describe('generated formations', () => {
  it('run as kept, and are cleaned on load', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    const tt = addTimetable(s, l.id)!;
    const ttId = tt.id;
    const a = addTrain(s, l, tt, { locoId: 'lms5025' })!;
    const formation = [{ classId: 'generic-open-7plank-12t', loaded: true }, { classId: 'generic-brake-van-20t' }];
    a.train.stock = { mode: 'type', rakeTypeId: 'rt-pickup-goods', formation: structuredClone(formation) };
    const c = resolveTrainStock(s, l, a.train, { mode: 'play', trainTypeId: 'pickup_goods', rng: seededRandom(1) })!;
    expect(classes(c.vehicles)).toEqual(['generic-open-7plank-12t', 'generic-brake-van-20t']);
    expect(c.vehicles[0].loaded).toBe(true);
    expect(previewTrainStock(l, a.train)!.label).toMatch(/as generated/);
    (a.train.stock as unknown as { formation: unknown[] }).formation.push({ classId: 7 }, 'x');
    const m = migrate(structuredClone(s));
    expect(m.layouts[0].timetables!.find((x) => x.id === ttId)!.trains[0]!.stock!.formation).toEqual(formation);
  });
});

describe('the timetable generator’s rakes (v0.3.41)', () => {
  const gen = (s: ReturnType<typeof createDefaultState>, seed: number) =>
    generateTimetable(s, s.layouts[0], { ...defaultGeneratorOptions('sequence'), seed, length: 40, mix: MIX_PRESETS[seed % MIX_PRESETS.length].mix }, 'G').tt;

  it('gives trains a rake type and formation, the same for the same seed', () => {
    const a = gen(createDefaultState(), 11);
    const b = gen(createDefaultState(), 11);
    const withStock = a.trains.filter((t) => t.stock?.formation?.length);
    expect(withStock.length).toBeGreaterThan(2);
    expect(a.trains.map((t) => t.stock)).toEqual(b.trains.map((t) => t.stock));
    for (const t of withStock) expect(t.consist).toBeTruthy();
  });

  it('leaves the timetable itself the same as it was without rakes (the rakes have their own seeded stream)', () => {
    const s = createDefaultState();
    s.layouts[0].rollingStock = { ...emptyRollingStock(), hiddenRakeTypes: RAKE_TYPES.map((t) => t.id) };
    const bare = gen(s, 5);
    const full = gen(createDefaultState(), 5);
    expect(bare.trains.every((t) => !t.stock)).toBe(true);
    expect(full.entries.map((e) => [e.dep, e.trainTypeId, e.to.roadId])).toEqual(bare.entries.map((e) => [e.dep, e.trainTypeId, e.to.roadId]));
  });

  it('puts a brake van on every goods rake, within the train limit and the roads it stands in', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = createDefaultState();
      const l = s.layouts[0];
      for (const t of s.trainTypes) if (stockKindFor(t.id) === 'goods') t.maxVehicles = 12;
      const tt = gen(s, seed);
      for (const t of tt.trains) {
        const f = t.stock?.formation;
        if (!f?.length) continue;
        const rv = f.map((x) => resolveVehicle({ id: '', classId: x.classId }, lib));
        const working = t.anyWorking ?? '';
        if (stockKindFor(working) === 'goods') {
          expect(rv[rv.length - 1].cls?.category, `${seed} ${t.name}`).toBe('brakeVan');
          expect(rv.length).toBeLessThanOrEqual(12);
        }
        const loco = s.roster.find((x) => x.id === t.locoId)!;
        const metres = rv.reduce((m, v) => m + v.metres, 0);
        for (const e of tt.entries.filter((x) => x.trainId === t.id && x.to.roadId && !x.runRound && stockKindFor(x.trainTypeId) !== 'none')) {
          const place = l.places.find((p) => p.id === e.to.placeId);
          const road = place?.roads.find((r) => r.id === e.to.roadId);
          if (!place || place.kind === 'fiddleYard' || !road?.circuitId) continue;
          const room = circuitLength(s, l, road.circuitId).metres - locoLength(loco);
          // A slot's minimum of one (a brake van, a set's brakes) is never cut, so allow for those.
          if (rv.length > 3) expect(metres, `${seed} ${t.name} in ${road.name}`).toBeLessThanOrEqual(room + 1e-6);
        }
      }
    }
  });

  it('makes a shorter rake for a short platform', () => {
    const count = (short: boolean) => {
      let n = 0;
      for (let seed = 1; seed <= 15; seed++) {
        const s = createDefaultState();
        if (short) for (const c of s.layouts[0].trackPlan.circuits) if (c.platform) c.length = 90;
        for (const t of gen(s, seed).trains) if (stockKindFor(t.anyWorking ?? '') === 'coaching') n += t.stock?.formation?.length ?? 0;
      }
      return n;
    };
    expect(count(true)).toBeLessThan(count(false));
  });
});
