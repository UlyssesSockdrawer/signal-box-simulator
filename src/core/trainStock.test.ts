import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { migrate } from './store';
import { emptyRollingStock, fittedHead, fromEngine, mintVehicle, rakeKind, resolveVehicle, stockLibrary } from './stock';
import { stockParams } from './stockLibrary';
import { RAKE_TYPES, rakeTypesFor, resolveRakeType, resolveTrainStock, seededRandom, stockIssues, trainStockOf } from './trainStock';
import { addTimetable, addTrain, walkTimetable } from './timetables';
import { play } from './simHarness';
import type { AppState, Layout } from './types';

const lib = stockLibrary();

/** Sigsim Central with a fleet: an express set (BTK, 3 × CK, BTK) and a goods rake (fitted vans then opens, unfitted van). */
function withFleet(): { s: AppState; l: Layout } {
  const s = createDefaultState();
  const l = s.layouts[0];
  const exp = ['LMS-D1730', 'LMS-57-ck', 'LMS-57-ck', 'LMS-57-ck', 'LMS-D1730'].map(mintVehicle);
  const goods = ['generic-vent-van-12t-fitted', 'generic-vent-van-12t-fitted', 'generic-open-7plank-12t', 'generic-open-7plank-12t', 'generic-open-7plank-12t', 'generic-open-7plank-12t', 'generic-brake-van-20t'].map(mintVehicle);
  l.rollingStock = {
    ...emptyRollingStock(),
    fleet: [...exp, ...goods],
    rakes: [
      { id: 'r-exp', identity: 'Express set', vehicleIds: exp.map((v) => v.id), engineEnd: 'A', notes: '' },
      { id: 'r-goods', identity: 'Goods', vehicleIds: goods.map((v) => v.id), engineEnd: 'A', notes: '' },
      { id: 'r-exp2', identity: 'Express set, short', vehicleIds: [exp[0].id, exp[1].id, exp[4].id], engineEnd: 'A', notes: '' },
    ],
  };
  return { s, l };
}

describe('built-in rake types (v0.3.40)', () => {
  it('are made of library types, with guard’s vehicles where they belong and a fitted van on every fitted goods recipe', () => {
    expect(RAKE_TYPES.length).toBeGreaterThan(8);
    const p = stockParams();
    for (const rt of RAKE_TYPES) {
      for (const sl of rt.slots) for (const c of sl.classIds) expect(lib.cls(c), `${rt.id}: ${c}`).toBeDefined();
      const rv = resolveRakeType(rt, lib).map((v) => resolveVehicle(v, lib));
      const kind = rakeKind(rv);
      if (kind === 'freight') {
        expect(rv[rv.length - 1].category, rt.id).toBe('brakeVan');
        // A train with a fitted head never gets an unfitted van (D5); pick-up and branch goods are unfitted throughout.
        if (fittedHead(fromEngine(rv, 'A')) > 0) expect(rv[rv.length - 1].fitted, rt.id).toBe(true);
        if (rt.trainTypeIds.some((t) => t === 'pickup_goods' || t === 'branch_freight')) expect(rv.every((v) => !v.fitted), rt.id).toBe(true);
      } else expect(rv.some((v) => v.guard), rt.id).toBe(true);
      void p;
    }
    // Every working with stock has a recipe; a light engine has none.
    for (const t of ['express_passenger', 'ordinary_passenger', 'branch_passenger', 'parcels', 'ecs', 'freight_fitted_half', 'freight_fitted_third', 'freight_fitted_four', 'freight_unfitted', 'through_freight', 'mineral', 'pickup_goods', 'branch_freight'])
      expect(rakeTypesFor(t).length, t).toBeGreaterThan(0);
    expect(rakeTypesFor('light_engine')).toEqual([]);
  });

  it('resolve within each slot’s range, shorter to fit a road, and the same again from the same seed', () => {
    const rt = RAKE_TYPES.find((x) => x.id === 'rt-express')!;
    for (let seed = 1; seed < 30; seed++) {
      const n = resolveRakeType(rt, lib, seededRandom(seed)).length;
      expect(n).toBeGreaterThanOrEqual(8);
      expect(n).toBeLessThanOrEqual(12);
    }
    const short = resolveRakeType(rt, lib, seededRandom(3), { maxMetres: 170 });
    expect(short.length).toBe(8); // as short as it goes: a brake, 6 coaches, a brake
    const a = resolveRakeType(rt, lib, seededRandom(42)).map((v) => v.classId);
    const b = resolveRakeType(rt, lib, seededRandom(42)).map((v) => v.classId);
    expect(a).toEqual(b);
  });
});

describe('a timetable train’s stock (v0.3.40)', () => {
  it('trains from before rakes keep their text consist; new trains default to any suitable', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    for (const tt of l.timetables ?? []) for (const t of tt.trains) expect(trainStockOf(t).mode).toBe('text');
    const tt = addTimetable(s, l.id, 'sequence')!;
    const { train } = addTrain(s, l, tt)!;
    expect(train.stock).toEqual({ mode: 'any' });
    // A bad choice is dropped on load (the text consist then applies); a good one round-trips.
    tt.trains.push({ ...train, id: 'bad', name: 'Bad', stock: { mode: 'nonsense' } as never });
    tt.trains.push({ ...train, id: 'good', name: 'Good', stock: { mode: 'rake', rakeId: 'r1' } });
    const m = migrate(JSON.parse(JSON.stringify(s)));
    const tt2 = m.layouts[0].timetables!.find((x) => x.id === tt.id)!;
    expect(tt2.trains.find((x) => x.id === 'bad')!.stock).toBeUndefined();
    expect(tt2.trains.find((x) => x.id === 'good')!.stock).toEqual({ mode: 'rake', rakeId: 'r1' });
  });

  it('resolves: text → none; a saved rake (its own vehicles in model railway mode, minted copies in play mode); a rake type; any suitable', () => {
    const { s, l } = withFleet();
    const tt = addTimetable(s, l.id, 'sequence')!;
    const { train } = addTrain(s, l, tt)!;
    const ctx = { trainTypeId: 'express_passenger', rng: seededRandom(1) };
    train.stock = { mode: 'text' };
    expect(resolveTrainStock(s, l, train, { ...ctx, mode: 'model' })).toBeNull();
    train.stock = { mode: 'rake', rakeId: 'r-exp' };
    const own = resolveTrainStock(s, l, train, { ...ctx, mode: 'model' })!;
    expect(own.rakeId).toBe('r-exp');
    expect(own.vehicles.map((v) => v.id)).toEqual(l.rollingStock!.rakes[0].vehicleIds);
    expect(own.text).toBe('5 coaches');
    const minted = resolveTrainStock(s, l, train, { ...ctx, mode: 'play' })!;
    expect(minted.vehicles.map((v) => v.classId)).toEqual(own.vehicles.map((v) => v.classId));
    expect(minted.vehicles.some((v) => l.rollingStock!.fleet.some((f) => f.id === v.id))).toBe(false);
    train.stock = { mode: 'type', rakeTypeId: 'rt-local' };
    expect(resolveTrainStock(s, l, train, { ...ctx, mode: 'play' })!.rakeTypeId).toBe('rt-local');
    // Any suitable: a saved rake that suits (coaching stock for a passenger working) in model railway mode, not one in use (D20).
    train.stock = { mode: 'any' };
    const any = resolveTrainStock(s, l, train, { ...ctx, mode: 'model' })!;
    expect(['r-exp', 'r-exp2']).toContain(any.rakeId);
    const inUse = new Set(l.rollingStock!.rakes[0].vehicleIds.slice(0, 1));
    const other = resolveTrainStock(s, l, train, { ...ctx, mode: 'model', inUse })!;
    expect(other.rakeId).toBeUndefined(); // both coaching rakes share the first BTK: a rake type instead
    expect(other.rakeTypeId).toBeDefined();
    expect(resolveTrainStock(s, l, train, { ...ctx, trainTypeId: 'mineral', mode: 'model' })!.rakeId).toBe('r-goods');
    expect(resolveTrainStock(s, l, train, { ...ctx, mode: 'play' })!.rakeTypeId).toBeDefined();
    expect(resolveTrainStock(s, l, train, { ...ctx, trainTypeId: 'light_engine', mode: 'play' })).toBeNull();
    // A road too short for the saved rakes: any suitable takes a rake type, shortened.
    const short = resolveTrainStock(s, l, train, { ...ctx, mode: 'model', limits: { maxMetres: 40 } })!;
    expect(short.rakeId).toBeUndefined();
  });

  it('the editor warns (never errors) when a rake does not match the working, and when two trains’ rakes share vehicles', () => {
    const { s, l } = withFleet();
    const tt = addTimetable(s, l.id, 'sequence')!;
    const a = addTrain(s, l, tt)!;
    a.entry.trainTypeId = 'freight_fitted_half';
    a.train.stock = { mode: 'rake', rakeId: 'r-goods' };
    const b = addTrain(s, l, tt)!;
    b.entry.trainTypeId = 'express_passenger';
    b.train.stock = { mode: 'rake', rakeId: 'r-exp' };
    const c = addTrain(s, l, tt)!;
    c.entry.trainTypeId = 'ordinary_passenger';
    c.train.stock = { mode: 'rake', rakeId: 'r-exp2' };
    const d = addTrain(s, l, tt)!;
    d.entry.trainTypeId = 'mineral';
    d.train.stock = { mode: 'rake', rakeId: 'r-exp' };
    const iss = stockIssues(s, l, tt);
    // Two fitted vans of seven: a third? No: 2/7 is under a third, and fewer than four, so unfitted.
    expect(iss.get(a.train.id)!.map((x) => x.code)).toEqual(['stockClass']);
    expect(iss.get(a.train.id)![0].text).toMatch(/unfitted/);
    expect(iss.get(b.train.id)!.map((x) => x.code)).toEqual(['stockShared', 'stockShared']);
    expect(iss.get(d.train.id)!.map((x) => x.code)).toContain('stockKind');
    const w = walkTimetable(s, l, tt);
    expect(w.trainIssues.get(a.train.id)!.every((x) => x.level === 'warn')).toBe(true);
    // A rake that has gone.
    a.train.stock = { mode: 'rake', rakeId: 'gone' };
    expect(stockIssues(s, l, tt).get(a.train.id)!.map((x) => x.code)).toEqual(['rakeMissing']);
  });

  it('the shipped timetables are unchanged: no new things to check', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    for (const tt of l.timetables ?? []) expect(stockIssues(s, l, tt).size).toBe(0);
  });
});

describe('the runner gives a train its stock (v0.3.40)', () => {
  it('play mode: a train made up in a fiddle yard runs with a rake of its rake type, measured by its vehicles; a text train as before', () => {
    const t = play();
    const l = t.state.layouts[0];
    const tt = addTimetable(t.state, l.id, 'sequence')!;
    const bf = t.loco('lms5025');
    bf.location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r1' };
    const { train, entry } = addTrain(t.state, l, tt, { locoId: 'lms5025' })!;
    train.stock = { mode: 'type', rakeTypeId: 'rt-local' };
    Object.assign(entry, { kind: 'run', trainTypeId: 'ordinary_passenger', from: { placeId: 'fy-west', roadId: 'fy-west-r1' }, to: { placeId: 'sgc-station', roadId: 'sgc-p1' } });
    t.runner.load(tt);
    t.runner.start();
    t.tick(2000);
    expect(bf.working.vehicles?.length).toBeGreaterThanOrEqual(3);
    expect(bf.working.vehicles!.every((v) => v.classId.startsWith('generic-'))).toBe(true);
    expect(bf.working.consist).toMatch(/coaches/);
    expect(t.west.view.incoming?.locoId).toBe('lms5025');
    // A text train keeps its text.
    const t2 = play();
    const l2 = t2.state.layouts[0];
    const tt2 = addTimetable(t2.state, l2.id, 'sequence')!;
    t2.loco('lms5025').location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r1' };
    const x = addTrain(t2.state, l2, tt2, { locoId: 'lms5025' })!;
    x.train.stock = { mode: 'text' };
    x.train.consist = '3 coaches';
    Object.assign(x.entry, { kind: 'run', trainTypeId: 'ordinary_passenger', from: { placeId: 'fy-west', roadId: 'fy-west-r1' }, to: { placeId: 'sgc-station', roadId: 'sgc-p1' } });
    t2.runner.load(tt2);
    t2.runner.start();
    t2.tick(2000);
    expect(t2.loco('lms5025').working.consist).toBe('3 coaches');
    expect(t2.loco('lms5025').working.vehicles).toBeUndefined();
  });
});

describe('model railway mode: one rake on the layout at a time (D20)', () => {
  it('a train whose saved rake shares vehicles with one already on the layout waits until that train is done', () => {
    const { s, l } = withFleet();
    const t = play({ state: s, mode: 'model' });
    const tt = addTimetable(s, l.id, 'sequence')!;
    t.loco('lms5025').location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r1' };
    t.loco('lms2700').location = { kind: 'place', placeId: 'fy-east', roadId: 'fye-road1' };
    const a = addTrain(s, l, tt, { locoId: 'lms5025' })!;
    a.train.stock = { mode: 'rake', rakeId: 'r-exp' };
    Object.assign(a.entry, { kind: 'run', trainTypeId: 'express_passenger', from: { placeId: 'fy-west', roadId: 'fy-west-r1' }, to: { placeId: 'sgc-station', roadId: 'sgc-p1' } });
    const b = addTrain(s, l, tt, { locoId: 'lms2700' })!;
    b.train.stock = { mode: 'rake', rakeId: 'r-exp2' };
    Object.assign(b.entry, { kind: 'run', trainTypeId: 'ordinary_passenger', from: { placeId: 'fy-east', roadId: 'fye-road1' }, to: { placeId: 'sgc-station', roadId: 'sgc-p2' }, withPrevious: true });
    t.runner.load(tt);
    t.runner.start();
    t.tick(2000);
    const item = (e: typeof b.entry) => t.runner.items.find((x) => x.entry.id === e.id)!;
    expect(item(a.entry).state).toBe('active');
    expect(t.loco('lms5025').working.consist).toBe('5 coaches');
    expect(item(b.entry).state).toBe('waiting');
    expect(item(b.entry).status).toMatch(/shares vehicles with Train 1/);
    // Train 1 done (marked here): Train 2 may go.
    t.runner.markDone(item(a.entry).id);
    t.tick(2000);
    expect(item(b.entry).state).toBe('active');
  });
});
