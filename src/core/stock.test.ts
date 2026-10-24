import { describe, expect, it } from 'vitest';
import { migrate } from './store';
import { createDefaultState, SCHEMA_VERSION } from './defaults';
import { CONSIST_METRES, locoShape, parseLength } from './railway';
import {
  canLoad,
  duplicateIdentities,
  emptyRollingStock,
  fallbackClassId,
  fittedBrakeVanFor,
  fittedHead,
  fromEngine,
  headcodeClass,
  mintFromConsist,
  mintVehicle,
  pushPullCapable,
  rakeNotes,
  resolveVehicle,
  splitVehicleList,
  stockLibrary,
  summariseRake,
  systemIdentity,
  vehicleName,
  vehiclesDescription,
  type StockLibrary,
} from './stock';
import { builtInClasses, KG_PER_TON, overBuffersFromHeadstocks, readDataFile, STOCK_DATA_FILES, stockParams, type StockDataFile } from './stockLibrary';
import { LENGTH_BASES, sanitiseVehicleClass } from './stockSanitise';
import type { Rake, RollingStock, Vehicle } from './stockTypes';

const lib = stockLibrary();
const v = (classId: string, extra: Partial<Vehicle> = {}): Vehicle => ({ ...mintVehicle(classId), ...extra });
const resolved = (vs: Vehicle[], l: StockLibrary = lib) => vs.map((x) => resolveVehicle(x, l));
const codes = (vs: Vehicle[], end: 'A' | 'B' = 'A', ctx = {}) => rakeNotes(resolved(vs), end, ctx).map((n) => n.code);

/** A made-up company with its own buffer allowance, no diagram numbers and only generic types (rakes plan 1a). */
const FICTIONAL: StockDataFile = {
  id: 'fictional',
  name: 'Fictional Light Railway',
  origin: 'Fictional',
  eras: ['grouping'],
  params: { bufferAllowance: { coaching: '2 ft', freight: '1 ft 6 in' }, trainLimits: { ordinary_passenger: { maxVehicles: 3 } } },
  classes: [
    { key: 'fict-coach', name: 'Four-wheel coach', category: 'coach', coachType: 'ordinary', guard: false, overHeadstocks: '30 ft', lengthBasis: 'estimated', fitted: true },
    { key: 'fict-brake', name: 'Brake third', category: 'coach', coachType: 'passengerBrake', guard: true, overHeadstocks: '30 ft', lengthBasis: 'estimated', fitted: true },
  ],
};
const GENERIC_ONLY = STOCK_DATA_FILES.filter((f) => f.origin === 'generic');

describe('stock library data (v0.3.38)', () => {
  it('every shipped row reads cleanly, passes the sanitiser, and has an honest length basis', () => {
    for (const f of STOCK_DATA_FILES) expect(readDataFile(f).problems).toEqual([]);
    const all = builtInClasses();
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const c of all) {
      if (c.metresOverBuffers !== undefined) expect(LENGTH_BASES).toContain(c.lengthBasis);
      else expect(c.lengthBasis).toBeUndefined(); // a gap shown as "length not known", never invented
      if (c.metresOverHeadstocks !== undefined && c.metresOverBuffers !== undefined) expect(c.metresOverBuffers).toBeGreaterThanOrEqual(c.metresOverHeadstocks);
      // The same sanitiser as a user's own types accepts it unchanged.
      expect(sanitiseVehicleClass({ ...c }, true)).toEqual(c);
    }
  });

  it('keeps measured, estimated and nominal lengths exactly as the research gives them', () => {
    const c = (id: string) => lib.cls(id)!;
    expect(c('LMS-D1730')).toMatchObject({ lengthBasis: 'measured', diagram: 'D1730', origin: 'LMS' });
    expect(c('LMS-D1730').metresOverBuffers).toBeCloseTo(parseLength('60 ft 8 in')!, 6);
    expect(c('LMS-D1890').metresOverBuffers).toBeCloseTo(7.137, 6);
    expect(c('LMS-62-bck')).toMatchObject({ lengthBasis: 'estimated' });
    expect(c('LMS-62-bck').metresOverBuffers).toBeCloseTo(parseLength('65 ft 8 in')!, 6);
    expect(c('LMS-42-guv').lengthBasis).toBe('nominal');
    expect(c('LMS-po-7plank').lengthBasis).toBe('nominal');
    expect(c('LMS-bgz').metresOverBuffers).toBeUndefined();
    // The LMS 20-ton brake van comes unfitted and vacuum fitted (D5).
    expect(c('LMS-bv-20t-1934').fitted).toBe(false);
    expect(c('LMS-bv-20t-1934-fitted').fitted).toBe(true);
    // Corridor: open coaches count as corridor; non-corridor false; not recorded = absent.
    expect(c('LMS-D1742').corridor).toBe(true);
    expect(c('LMS-D1686').corridor).toBe(false);
    expect(c('LMS-D1697').corridor).toBeUndefined();
  });

  it('ships a generic fallback type for every category, including a generic 20-ton fitted brake van', () => {
    const generic = builtInClasses().filter((c) => c.origin === 'generic');
    expect(generic.every((c) => c.lengthBasis === 'generic' && c.metresOverBuffers! > 0)).toBe(true);
    for (const cat of ['coach', 'van', 'wagon', 'brakeVan']) expect(generic.some((c) => c.category === cat)).toBe(true);
    for (const t of ['ordinary', 'passengerBrake', 'fullBrake', 'drivingTrailer', 'tpo', 'van']) expect(generic.some((c) => c.coachType === t)).toBe(true);
    expect(generic.find((c) => c.id === 'generic-brake-van-20t-fitted')).toMatchObject({ category: 'brakeVan', fitted: true });
  });

  it('the text consist lengths are the generic library lengths (D18)', () => {
    expect(CONSIST_METRES.coach).toBeCloseTo(lib.cls('generic-coach-57')!.metresOverBuffers!, 3);
    expect(CONSIST_METRES['auto-coach']).toBeCloseTo(lib.cls('generic-driving-trailer-57')!.metresOverBuffers!, 3);
    expect(CONSIST_METRES.van).toBeCloseTo(lib.cls('generic-van-50')!.metresOverBuffers!, 3);
    expect(CONSIST_METRES['brake van']).toBeCloseTo(lib.cls('generic-brake-van-20t')!.metresOverBuffers!, 3);
    expect(CONSIST_METRES.wagon).toBeCloseTo(lib.cls('generic-open-7plank-12t')!.metresOverBuffers!, 3);
  });
});

describe('buffer allowance and parameters', () => {
  it('works over buffers out from over headstocks by company and kind, falling back to the generic default', () => {
    expect(overBuffersFromHeadstocks(parseLength('57 ft')!, 'coach', 'ordinary', 'LMS', ['grouping'])).toBeCloseTo(parseLength('60 ft 8 in')!, 6);
    expect(overBuffersFromHeadstocks(parseLength('17 ft 6 in')!, 'wagon', undefined, 'LMS')).toBeCloseTo(parseLength('20 ft 11 in')!, 6);
    // A company with no data of its own gets the generic default.
    expect(overBuffersFromHeadstocks(parseLength('57 ft')!, 'coach', 'ordinary', 'Nobody')).toBeCloseTo(parseLength('60 ft 8 in')!, 6);
    // A company with its own allowance uses it.
    const files = [...STOCK_DATA_FILES, FICTIONAL];
    expect(overBuffersFromHeadstocks(parseLength('30 ft')!, 'coach', 'ordinary', 'Fictional', ['grouping'], files)).toBeCloseTo(parseLength('32 ft')!, 6);
    expect(overBuffersFromHeadstocks(parseLength('10 ft')!, 'wagon', undefined, 'Fictional', [], files)).toBeCloseTo(parseLength('11 ft 6 in')!, 6);
    expect(stockParams('Fictional', ['grouping'], files).trainLimits.ordinary_passenger.maxVehicles).toBe(3);
    expect(stockParams('Fictional', ['grouping'], files).trainLimits.mineral.maxVehicles).toBe(90); // generic default
  });
});

describe('identity', () => {
  it('shows the system identity until overridden; an override can be cleared; the id never changes', () => {
    const x = v('LMS-D1730');
    expect(x.id).toMatch(/^[0-9a-f-]{36}$/);
    const sys = systemIdentity(x, lib.cls(x.classId));
    expect(sys).toMatch(/^BTK-[0-9a-f]{6}$/);
    expect(vehicleName(x, lib)).toBe(sys);
    const id = x.id;
    x.identity = '5844 Period II BTK';
    expect(vehicleName(x, lib)).toBe('5844 Period II BTK');
    x.identity = '  ';
    expect(vehicleName(x, lib)).toBe(sys);
    delete x.identity;
    expect(x.id).toBe(id);
  });

  it('warns about (never blocks) a duplicate identity in a fleet', () => {
    const a = v('generic-open-7plank-12t', { identity: 'PO Wagon - Birley Colliery 542' });
    const b = v('generic-open-7plank-12t', { identity: 'po wagon - birley colliery 542' });
    const c = v('generic-open-7plank-12t');
    expect([...duplicateIdentities([a, b, c], lib).values()]).toEqual([[a.id, b.id]]);
  });
});

describe('derived values', () => {
  const fittedWagon = () => v('generic-vent-van-12t-fitted');
  const unfittedWagon = () => v('generic-open-7plank-12t');

  it('the fitted head stops at the first unfitted vehicle, counted from the engine end', () => {
    const rake = [fittedWagon(), fittedWagon(), unfittedWagon(), fittedWagon(), v('generic-brake-van-20t-fitted')];
    expect(fittedHead(fromEngine(resolved(rake), 'A'))).toBe(2);
    expect(fittedHead(fromEngine(resolved(rake), 'B'))).toBe(2); // from end B: van, wagon, then the unfitted one
    expect(codes(rake)).toContain('unfittedAheadOfFitted');
  });

  it('gives the freight class from the fitted head (thresholds from the parameter data)', () => {
    const p = stockParams();
    const cls = (fitted: number, unfitted: number) => headcodeClass(resolved([...Array.from({ length: fitted }, fittedWagon), ...Array.from({ length: unfitted }, unfittedWagon)]), p);
    expect(cls(10, 0)).toBe('freight_fitted_half'); // fully fitted: at least half (3-1-1, D21)
    expect(cls(5, 5)).toBe('freight_fitted_half');
    expect(cls(4, 6)).toBe('freight_fitted_third');
    expect(cls(4, 12)).toBe('freight_fitted_four');
    expect(cls(3, 12)).toBe('freight_unfitted');
    expect(cls(0, 10)).toBe('freight_unfitted');
  });

  it('is push-pull capable with a driving trailer at the far end from the engine', () => {
    const rake = [v('generic-coach-57'), v('generic-driving-trailer-57')];
    expect(pushPullCapable(fromEngine(resolved(rake), 'A'))).toBe(true);
    expect(pushPullCapable(fromEngine(resolved(rake), 'B'))).toBe(false);
    expect(codes([v('generic-coach-57'), v('generic-driving-trailer-57'), v('generic-coach-57')])).toContain('drivingTrailerNotAtEnd');
  });

  it('notes, never blocks: missing brake van, guard, corridor break, length, limits', () => {
    expect(codes([unfittedWagon(), unfittedWagon()])).toContain('freightNoBrakeVan');
    expect(codes([v('generic-brake-van-20t'), unfittedWagon()])).toContain('brakeVanNotAtTail');
    expect(codes([unfittedWagon(), v('generic-brake-van-20t')])).toEqual([]);
    expect(codes([v('generic-coach-57'), v('generic-coach-57')])).toContain('passengerNoGuard');
    expect(codes([v('generic-coach-57'), v('generic-passenger-brake-57'), v('generic-coach-57')])).toContain('guardNotAtEnd');
    expect(codes([v('LMS-D1730'), v('LMS-D1686'), v('LMS-D1742')])).toContain('nonCorridorBreak');
    expect(codes([v('LMS-D1730'), v('LMS-D1686')])).not.toContain('nonCorridorBreak');
    const four = [v('generic-passenger-brake-57'), v('generic-coach-57'), v('generic-coach-57'), v('generic-passenger-brake-57')];
    expect(codes(four, 'A', { roadMetres: 70 })).toContain('tooLong');
    expect(codes(four, 'A', { roadMetres: 80 })).not.toContain('tooLong');
    expect(codes(four, 'A', { limit: { maxVehicles: 3 } })).toContain('overVehicleLimit');
  });

  it('flags an unfitted brake van on a fitted train as a safety note, except on pick-up and branch goods (D5)', () => {
    const rake = [fittedWagon(), unfittedWagon(), v('generic-brake-van-20t')];
    const notes = rakeNotes(resolved(rake), 'A');
    expect(notes.find((n) => n.code === 'unfittedVanOnFittedTrain')?.severity).toBe('safety');
    expect(codes(rake, 'A', { trainTypeId: 'pickup_goods' })).not.toContain('unfittedVanOnFittedTrain');
    expect(codes([fittedWagon(), v('generic-brake-van-20t-fitted')])).not.toContain('unfittedVanOnFittedTrain');
  });

  it('a fitted train can always be given a fitted brake van, for any company and era (D5a)', () => {
    for (const [origin, era] of [['LMS', 'grouping'], ['GWR', 'grouping'], ['BR', 'br1960'], [undefined, undefined], ['Fictional', 'postwar']] as const) {
      const van = fittedBrakeVanFor(lib, origin, era);
      expect(van).toMatchObject({ category: 'brakeVan', fitted: true });
    }
    expect(fittedBrakeVanFor(lib, 'LMS', 'grouping')!.origin).toBe('LMS');
    expect(fittedBrakeVanFor(lib, 'GWR', 'grouping')!.id).toBe('generic-brake-van-20t-fitted');
    // Even with every built-in fitted van hidden from the lists.
    const hidden = stockLibrary({ ...emptyRollingStock(), hidden: builtInClasses().filter((c) => c.category === 'brakeVan' && c.fitted).map((c) => c.id) });
    expect(fittedBrakeVanFor(hidden, 'LMS')).toMatchObject({ id: 'generic-brake-van-20t-fitted' });
  });

  it('tolerates missing lengths and weights: a generic stand-in, marked approximate', () => {
    const r = resolveVehicle(v('LMS-bgz'), lib);
    expect(r.unknownLength).toBe(true);
    expect(r.approx).toBe(true);
    expect(fallbackClassId(lib.cls('LMS-bgz'))).toBe('generic-full-brake-50');
    expect(r.metres).toBeCloseTo(lib.cls('generic-full-brake-50')!.metresOverBuffers!, 6);
    const rs: RollingStock = { ...emptyRollingStock(), fleet: [v('LMS-D1730'), v('LMS-bgz')] };
    const rake: Rake = { id: 'r', identity: 'Test', vehicleIds: rs.fleet.map((x) => x.id), engineEnd: 'A', notes: '' };
    const s = summariseRake(rake, rs, lib);
    expect(s.length.approx).toBe(true);
    // Weights (v0.3.41): neither has its own, so both take a generic stand-in's, marked approximate.
    expect(s.weight.missing).toBe(0);
    expect(s.weight.approx).toBe(true);
    expect(s.weight.kg).toBeGreaterThan(40 * KG_PER_TON);
    expect(s.notes.map((n) => n.code)).toContain('unknownLength');
  });

  it('gives every generic type a generic weight, loaded weights for wagons and vans, and stand-ins for the rest (v0.3.41)', () => {
    for (const c of lib.builtIns().filter((x) => x.origin === 'generic')) {
      expect(c.tareKg, c.id).toBeGreaterThan(0);
      expect(c.weightBasis, c.id).toBe('generic');
      if (canLoad(c)) expect(c.loadedKg!, c.id).toBeGreaterThan(c.tareKg!);
    }
    const open = resolveVehicle(v('generic-open-7plank-12t'), lib);
    const full = resolveVehicle({ ...v('generic-open-7plank-12t'), loaded: true }, lib);
    expect(open.kg! / KG_PER_TON).toBeCloseTo(6.5, 3);
    expect(full.kg! / KG_PER_TON).toBeCloseTo(18.5, 3);
    expect(open.weightApprox).toBe(true);
    // An LMS coach with no weight: the generic coach's, scaled by its length.
    const coach = lib.cls('generic-coach-57')!;
    const d1730 = resolveVehicle(v('LMS-D1730'), lib);
    expect(d1730.kg).toBeCloseTo((coach.tareKg! * d1730.metres) / coach.metresOverBuffers!, 3);
    // A weight typed on the user's own type is used as it is.
    const own = stockLibrary({ ...emptyRollingStock(), classes: [{ id: 'mine', name: 'Mine', category: 'wagon', guard: false, fitted: false, builtIn: false, tareKg: 5000 }] });
    expect(resolveVehicle(v('mine'), own)).toMatchObject({ kg: 5000, weightApprox: false });
  });

  it('notes vehicles shared with other saved rakes (allowed, D20)', () => {
    const a = v('generic-coach-57');
    const rs: RollingStock = { ...emptyRollingStock(), fleet: [a] };
    rs.rakes = [
      { id: 'r1', identity: 'Weekday set', vehicleIds: [a.id], engineEnd: 'A', notes: '' },
      { id: 'r2', identity: 'Saturday set', vehicleIds: [a.id], engineEnd: 'A', notes: '' },
    ];
    expect(summariseRake(rs.rakes[0], rs, lib).notes.find((n) => n.code === 'sharedVehicles')?.data?.rakes).toBe('Saturday set');
  });
});

describe('a company with no LMS data at all (non-LMS fixture)', () => {
  const files = [...GENERIC_ONLY, FICTIONAL];
  const flib = stockLibrary(undefined, files);

  it('validates its library and works out lengths with its own allowance', () => {
    expect(readDataFile(FICTIONAL, files).problems).toEqual([]);
    expect(flib.cls('LMS-D1730')).toBeUndefined();
    expect(flib.cls('fict-coach')!.metresOverBuffers).toBeCloseTo(parseLength('32 ft')!, 6);
    expect(flib.cls('fict-coach')!.diagram).toBeUndefined();
  });

  it('builds a rake, with derived values, notes and a fitted van from the generic types', () => {
    const rs: RollingStock = { ...emptyRollingStock(), fleet: [v('fict-brake'), v('fict-coach'), v('fict-coach'), v('fict-brake')] };
    const rake: Rake = { id: 'r', identity: 'Branch set', vehicleIds: rs.fleet.map((x) => x.id), engineEnd: 'A', notes: '' };
    const s = summariseRake(rake, rs, flib, { limit: flib.params('Fictional', ['grouping']).trainLimits.ordinary_passenger });
    expect(s.count).toBe(4);
    expect(s.length.metres).toBeCloseTo(4 * parseLength('32 ft')!, 6);
    expect(s.length.approx).toBe(true);
    expect(s.kind).toBe('passenger');
    expect(s.notes.map((n) => n.code)).toEqual(['overVehicleLimit']);
    expect(fittedBrakeVanFor(flib, 'Fictional', 'grouping')).toMatchObject({ id: 'generic-brake-van-20t-fitted' });
    const goods = [v('generic-vent-van-12t-fitted'), v('generic-open-7plank-12t'), v('generic-brake-van-20t')];
    expect(rakeNotes(resolved(goods, flib), 'A').map((n) => n.code)).toEqual(['unfittedVanOnFittedTrain']);
  });
});

describe('play mode vehicles (D19)', () => {
  it('mints vehicles from a text consist and describes them back the same way', () => {
    const vs = mintFromConsist('4 coaches + a brake van');
    expect(vs.map((x) => x.classId)).toEqual([...Array(4).fill('generic-coach-57'), 'generic-brake-van-20t']);
    expect(vehiclesDescription(vs, lib)).toBe('4 coaches + a brake van');
    expect(new Set(vs.map((x) => x.id)).size).toBe(5);
  });

  it('a shunt "moving with" some vehicles takes those, keeping the others in order', () => {
    const vs = mintFromConsist('4 coaches + 2 vans');
    const { taken, left } = splitVehicleList(vs, '2 vans', lib);
    expect(taken.map((x) => x.id)).toEqual(vs.slice(4).map((x) => x.id));
    expect(left.map((x) => x.id)).toEqual(vs.slice(0, 4).map((x) => x.id));
  });
});

describe('saved data (schema 8 on)', () => {
  it('an old save loads cleanly with its anonymous standing stock dropped (D14)', () => {
    const old = JSON.parse(JSON.stringify(createDefaultState())) as Record<string, unknown> & { layouts: Array<Record<string, unknown>> };
    old.schemaVersion = 7;
    old.layouts[0].stock = [{ id: 'rake_1', description: '4 coaches', vehicles: [{ kind: 'coach', count: 4, metres: 20 }], placeId: 'sgc-station', roadId: 'sgc-p1', circuitId: 'sgc-t5' }];
    const s = migrate(old);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect(s.layouts[0].stock).toBeUndefined();
    expect(s.layouts[0].rollingStock).toBeUndefined();
  });

  it('a corrupted save keeps the good values and drops the bad ones', () => {
    const st = JSON.parse(JSON.stringify(createDefaultState()));
    const good = mintVehicle('LMS-D1730');
    st.layouts[0].rollingStock = {
      classes: [
        { id: 'my-mink', name: 'GWR Mink', category: 'van', metresOverBuffers: 6.5, fitted: true, lengthBasis: 'bogus', shape: 'blob' },
        { id: 'LMS-D1730', name: 'Takes a built-in id' },
        { name: 'No id' },
        'junk',
      ],
      hidden: ['LMS-D1742', 'not-a-type', 7],
      fleet: [good, { id: 'x' }, { classId: 'y' }, { ...mintVehicle('my-mink'), loaded: 'yes', home: 'nowhere', metresOverBuffers: -3, identity: '  Mink 1  ' }],
      rakes: [{ id: 'r1', identity: 'Set', vehicleIds: [good.id, good.id, 'missing'], engineEnd: 'C' }, { identity: 'no id' }],
    };
    st.layouts[0].stock = [{ id: 's1', vehicles: [mintVehicle('generic-coach-57'), { kind: 'coach' }], placeId: 'sgc-station', roadId: 'sgc-p1', circuitId: 'wrong' }, { id: 's2', vehicles: [mintVehicle('generic-coach-57')], placeId: 'nowhere', roadId: '' }];
    st.roster[0].working.vehicles = [mintVehicle('generic-coach-57'), 'junk'];
    const s = migrate(st);
    const rs = s.layouts[0].rollingStock!;
    expect(rs.classes).toHaveLength(1);
    expect(rs.classes[0]).toMatchObject({ id: 'my-mink', category: 'van', lengthBasis: 'estimated', builtIn: false });
    expect(rs.classes[0].shape).toBeUndefined();
    expect(rs.hidden).toEqual(['LMS-D1742']);
    expect(rs.fleet).toHaveLength(2);
    expect(rs.fleet[1]).toMatchObject({ identity: 'Mink 1', classId: 'my-mink' });
    expect(rs.fleet[1].loaded).toBeUndefined();
    expect(rs.fleet[1].home).toBeUndefined();
    expect(rs.fleet[1].metresOverBuffers).toBeUndefined();
    expect(rs.rakes).toEqual([{ id: 'r1', identity: 'Set', vehicleIds: [good.id], engineEnd: 'A', notes: '' }]);
    expect(s.layouts[0].stock).toHaveLength(1);
    expect(s.layouts[0].stock![0].vehicles).toHaveLength(1);
    expect(s.layouts[0].stock![0].circuitId).toBe(s.layouts[0].places.find((p) => p.id === 'sgc-station')!.roads.find((r) => r.id === 'sgc-p1')!.circuitId);
    expect(s.roster[0].working.vehicles).toHaveLength(1);
  });

  it('new rolling stock data round-trips', () => {
    const st = createDefaultState();
    const a = mintVehicle('LMS-D1730');
    a.identity = '5844';
    const b = { ...mintVehicle('generic-open-7plank-12t'), loaded: true, load: 'Coal', home: 'sgc-goods' };
    st.layouts[0].rollingStock = {
      classes: [{ id: 'u1', name: 'My van', category: 'van', guard: false, fitted: true, metresOverBuffers: 6.4, lengthBasis: 'measured', builtIn: false }],
      hidden: ['LMS-D1742'],
      fleet: [a, b],
      rakes: [{ id: 'r1', identity: 'Pick-up', vehicleIds: [b.id, a.id], engineEnd: 'B', notes: 'try me' }],
    };
    const once = migrate(JSON.parse(JSON.stringify(st)));
    expect(once.layouts[0].rollingStock).toEqual(st.layouts[0].rollingStock);
    expect(migrate(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe('engine shapes for drawing (v0.3.42)', () => {
  it('draws each power type as its own kind of engine', () => {
    expect(locoShape({ powerType: 'Steam (tender)' })).toBe('tender');
    expect(locoShape({ powerType: 'Steam (tank)' })).toBe('tank');
    expect(locoShape({ powerType: 'Diesel' })).toBe('diesel');
    expect(locoShape({ powerType: 'Electric' })).toBe('electric');
    expect(locoShape({ powerType: 'DMU' })).toBe('unit');
    expect(locoShape({ powerType: 'Other' })).toBe('tender');
  });
});
