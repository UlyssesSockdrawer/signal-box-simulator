import rakeTypesGeneric from './stockData/rakeTypes-generic.json';
import { sanitiseRakeType } from './stockSanitise';
import { GENERIC_ORIGIN, KG_PER_TON, stockEraOf, stockParams, type StockParams, type TrainLimit } from './stockLibrary';
import {
  emptyRollingStock,
  fallbackClassId,
  fittedBrakeVanFor,
  fromEngine,
  headcodeClass,
  isCoaching,
  isGoods,
  mintVehicle,
  rakeKind,
  rakeLength,
  rakeVehicles,
  resolveVehicle,
  stockLibrary,
  vehiclesDescription,
  type StockLibrary,
} from './stock';
import type { RakeSlot, RakeType, RollingStock, Vehicle } from './stockTypes';

export { sanitiseRakeType };
import type { AppState, Layout, Timetable, TimetableTrain, TrainStock } from './types';

/*
 * TIMETABLE TRAINS AND THEIR STOCK (v0.3.40, Stage 2 of the rakes feature).
 *
 * A train chooses (D10) any suitable rake (the default for new trains), a rake type, a specific saved
 * rake, or a text consist (D14a: best for model railway mode; in play mode its vehicles are minted from
 * the text, D19). "Any suitable" looks at the layout's saved rakes first in model railway mode (one that
 * suits the train and is not in use by another, D20), then rake types; in play mode it uses a rake type
 * (vehicles minted, D1).
 *
 * RAKE GENERATION (v0.3.41, Stage 3): rake types are generic recipes shipped as data
 * (core/stockData/rakeTypes-generic.json) plus a layout's own (D27). The layout's company (D25) and era
 * pick the goods mix that mix slots are filled from (D9), the block-train weight and the train limits
 * (D13; overridden per train type, D26). Generated rakes fit the train limit and the road, and are
 * marshalled (D5, D5a). The timetable generator keeps what it made on the train as its formation, so a
 * kept timetable runs the same rakes again. Company and era are only ever data: nothing here names one.
 */

// ---------------------------------------------------------------------------- rake types

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The built-in rake types (generic recipes). */
export const RAKE_TYPES: RakeType[] = (rakeTypesGeneric as { types: unknown[] }).types.map((x) => sanitiseRakeType(x, true)).filter((x): x is RakeType => !!x);

/** A layout's company and stock era (v0.3.41, D25): the company from its Stock tab setting, the era from its headcode era. */
export function layoutStock(layout: Layout | undefined): { company: string; era: string } {
  return { company: layout?.stockCompany || GENERIC_ORIGIN, era: stockEraOf(layout?.headcodeEra) };
}

const sameName = (a: string | undefined, b: string | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** Does a rake type belong with a layout's company and era (generic ones belong with every company)? */
export function rakeTypeFitsLayout(rt: RakeType, layout: Layout | undefined): boolean {
  const { company, era } = layoutStock(layout);
  const originOk = !rt.origin || sameName(rt.origin, GENERIC_ORIGIN) || sameName(rt.origin, company);
  return originOk && (!rt.eras?.length || rt.eras.includes(era));
}

/**
 * The rake types a layout offers (v0.3.41): its own types first, then built-ins it has not hidden, for its
 * company and era. These are what the editor lists, "any suitable" draws from and the generator uses.
 */
export function rakeTypesOf(layout: Layout | undefined): RakeType[] {
  const rs = layout?.rollingStock;
  const hidden = new Set(rs?.hiddenRakeTypes ?? []);
  const own = rs?.rakeTypes ?? [];
  const ownIds = new Set(own.map((t) => t.id));
  return [...own, ...RAKE_TYPES.filter((t) => !hidden.has(t.id) && !ownIds.has(t.id))].filter((t) => rakeTypeFitsLayout(t, layout));
}

/** A rake type by id: the layout's own, else a built-in (hidden ones still found, so trains naming them keep working). */
export function findRakeType(id: string | undefined, layout?: Layout): RakeType | undefined {
  if (!id) return undefined;
  return layout?.rollingStock?.rakeTypes?.find((t) => t.id === id) ?? RAKE_TYPES.find((t) => t.id === id);
}

/** Working types that carry coaching stock, and ones that have no stock of their own. */
const COACHING = new Set(['express_passenger', 'ordinary_passenger', 'branch_passenger', 'parcels', 'ecs']);
const NO_STOCK = new Set(['light_engine', 'engine_brake_van', 'railcar']);

/** What kind of rake a working wants: coaching stock, goods stock, or none (light engine, railcar). */
export function stockKindFor(trainTypeId: string): 'coaching' | 'goods' | 'none' {
  if (NO_STOCK.has(trainTypeId)) return 'none';
  return COACHING.has(trainTypeId) ? 'coaching' : 'goods';
}

/** Rake types for a working: those naming it, else those for its kind (any coaching set, any goods recipe). */
export function rakeTypesFor(trainTypeId: string, types: RakeType[] = RAKE_TYPES): RakeType[] {
  const named = types.filter((t) => t.trainTypeIds.includes(trainTypeId));
  if (named.length) return named;
  const kind = stockKindFor(trainTypeId);
  if (kind === 'none') return [];
  return types.filter((t) => t.trainTypeIds.some((x) => stockKindFor(x) === kind));
}

/** How often the generator picks a rake type: its weight, times the company's block-train weight for the era for a block train (D9). */
export function rakeTypeWeight(rt: RakeType, params: StockParams, era: string): number {
  return rt.weight * (rt.block ? (params.blockWeight[era] ?? 1) : 1);
}

/** Does a rake type fit the limits at its minimum counts (so it need not be cut short)? */
export function rakeTypeFits(rt: RakeType, lib: StockLibrary, limits: RakeLimits): boolean {
  const n = rt.slots.reduce((m, s) => m + s.min, 0);
  if (limits.maxVehicles !== undefined && n > limits.maxVehicles) return false;
  if (limits.maxMetres === undefined) return true;
  const shortest = (s: RakeSlot) => Math.min(...(s.classIds.length ? s.classIds : ['generic-open-7plank-12t']).map((c) => resolveVehicle({ id: '', classId: c }, lib).metres));
  return rt.slots.reduce((m, s) => m + s.min * shortest(s), 0) <= limits.maxMetres;
}

/** One rake type from several, by weight. */
export function pickRakeType(types: RakeType[], params: StockParams, era: string, rng: () => number): RakeType | undefined {
  if (!types.length) return undefined;
  const w = types.map((t) => rakeTypeWeight(t, params, era));
  const total = w.reduce((m, x) => m + x, 0);
  let x = rng() * total;
  return types.find((_, i) => (x -= w[i]) < 0) ?? types[types.length - 1];
}

/**
 * The limits on a train of a working (D13, v0.3.41): the train type's own maximum vehicles and tons where
 * set (Settings, Train limits), else the layout company's figures for its era (the LMS 1939 table for LMS
 * and, as the generic default, for any other).
 */
export function trainLimit(state: Pick<AppState, 'trainTypes'>, layout: Layout | undefined, trainTypeId: string): TrainLimit {
  const { company, era } = layoutStock(layout);
  const base = stockParams(company, [era]).trainLimits[trainTypeId] ?? {};
  const tt = state.trainTypes.find((t) => t.id === trainTypeId);
  return {
    ...(tt?.maxVehicles ?? base.maxVehicles ? { maxVehicles: tt?.maxVehicles ?? base.maxVehicles } : {}),
    ...(tt?.maxTons ?? base.maxTons ? { maxTons: tt?.maxTons ?? base.maxTons } : {}),
  };
}

/** A small seeded random number generator (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number from a string (to seed a train's choices). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface RakeLimits {
  /** Longest it may be (the road or platform it is to stand in), metres. */
  maxMetres?: number;
  maxVehicles?: number;
  /** Heaviest it may be, tons (counted over vehicles whose weight is known). */
  maxTons?: number;
}

export interface ResolveOptions {
  /** The parameters giving the goods mix (default: the generic ones). */
  params?: StockParams;
  /** Pick-up and branch goods are made up unfitted (D5): mix slots take no fitted vehicles, and other slots prefer unfitted ones. */
  unfitted?: boolean;
}

/** What a slot may be filled with, and how often each. */
function slotCandidates(slot: RakeSlot, lib: StockLibrary, opts: ResolveOptions): Array<{ classId: string; weight: number }> {
  if (slot.mix) {
    const mix = (opts.params ?? lib.params()).goodsMix.filter((m) => {
      const c = lib.cls(m.classId);
      return !!c && isGoods(c) && c.category !== 'brakeVan' && m.weight > 0 && (slot.fitted === undefined || c.fitted === slot.fitted) && !(opts.unfitted && c.fitted);
    });
    if (mix.length) return mix;
  }
  let ids = slot.classIds.filter((c) => !!lib.cls(c));
  if (!ids.length) ids = slot.classIds;
  if (opts.unfitted) {
    const plain = ids.filter((c) => !lib.cls(c)?.fitted || lib.cls(c)?.category === 'brakeVan');
    if (plain.length) ids = plain;
  }
  return ids.map((classId) => ({ classId, weight: 1 }));
}

/**
 * A rake type made into vehicles: a count within each slot's range (the middle when no random source
 * is given), shortened to fit the limits (down to each slot's minimum first, then below it, keeping one
 * of each slot that must have one), vehicles minted in order. Goods-mix slots (D9) are drawn from the
 * company's goods mix by weight.
 */
export function resolveRakeType(rt: RakeType, lib: StockLibrary, rng?: () => number, limits: RakeLimits = {}, opts: ResolveOptions = {}): Vehicle[] {
  const cands = rt.slots.map((s) => slotCandidates(s, lib, opts));
  const pick = (xs: Array<{ classId: string; weight: number }>) => {
    if (!rng) return xs.reduce((a, b) => (b.weight > a.weight ? b : a)).classId;
    const total = xs.reduce((m, x) => m + x.weight, 0);
    let x = rng() * total;
    return (xs.find((c) => (x -= c.weight) < 0) ?? xs[xs.length - 1]).classId;
  };
  const counts = rt.slots.map((s) => (rng ? s.min + Math.floor(rng() * (s.max - s.min + 1)) : Math.round((s.min + s.max) / 2)));
  const weighted = (xs: Array<{ classId: string; weight: number }>, f: (classId: string) => number) => {
    const total = xs.reduce((m, x) => m + x.weight, 0) || 1;
    return xs.reduce((m, x) => m + (f(x.classId) * x.weight) / total, 0);
  };
  const metresOf = (classId: string) => resolveVehicle({ id: '', classId }, lib).metres;
  const tonsOf = (classId: string, loaded?: boolean) => (resolveVehicle({ id: '', classId, ...(loaded ? { loaded: true } : {}) }, lib).kg ?? 0) / KG_PER_TON;
  const avg = cands.map((xs) => weighted(xs, metresOf));
  const avgTons = cands.map((xs, i) => weighted(xs, (c) => tonsOf(c, rt.slots[i].loaded)));
  const sum = (f: (n: number, i: number) => number) => counts.reduce((m, n, i) => m + f(n, i), 0);
  const tooBig = () =>
    (limits.maxMetres !== undefined && sum((n, i) => n * avg[i]) > limits.maxMetres) ||
    (limits.maxVehicles !== undefined && sum((n) => n) > limits.maxVehicles) ||
    (limits.maxTons !== undefined && sum((n, i) => n * avgTons[i]) > limits.maxTons);
  while (tooBig()) {
    // Take one off the slot with most to spare above its minimum.
    let best = -1;
    rt.slots.forEach((s, i) => {
      if (counts[i] > s.min && (best < 0 || counts[i] - s.min > counts[best] - rt.slots[best].min)) best = i;
    });
    if (best < 0) break;
    counts[best]--;
  }
  // Still too big at every minimum: the road and the train limit win over the recipe. Take from the
  // biggest slot, keeping one of each slot that must have one (a brake van, a set's brakes).
  while (tooBig()) {
    let best = -1;
    rt.slots.forEach((s, i) => {
      if (counts[i] > (s.min > 0 ? 1 : 0) && (best < 0 || counts[i] > counts[best])) best = i;
    });
    if (best < 0) break;
    counts[best]--;
  }
  const out: Vehicle[] = [];
  rt.slots.forEach((s, i) => {
    for (let k = 0; k < counts[i]; k++) {
      const v = mintVehicle(pick(cands[i]));
      if (s.loaded) v.loaded = true;
      out.push(v);
    }
  });
  return out;
}

/**
 * Marshals a train's vehicles (D5, D5a, v0.3.41). Coaching stock is left in the order given (a set's
 * brakes are at its ends) and goes first in a mixed train. Goods vehicles follow, fitted ones first (the
 * fitted head, next the engine); brake vans go at the tail. A goods train with no guard's vehicle gets a
 * brake van, and one with a fitted head has its brake van fitted (or piped): an unfitted van is swapped
 * for the company's fitted van. The list is from the engine end.
 */
export function marshal(vehicles: Vehicle[], lib: StockLibrary, company?: string, era?: string): Vehicle[] {
  const cls = (v: Vehicle) => lib.cls(v.classId);
  const fittedOf = (v: Vehicle) => v.fitted ?? cls(v)?.fitted ?? false;
  const coaching = vehicles.filter((v) => isCoaching(cls(v)));
  const goods = vehicles.filter((v) => !isCoaching(cls(v)) && cls(v)?.category !== 'brakeVan');
  let vans = vehicles.filter((v) => !isCoaching(cls(v)) && cls(v)?.category === 'brakeVan');
  if (!goods.length) return [...coaching, ...vans];
  const fitted = goods.filter(fittedOf);
  const plain = goods.filter((v) => !fittedOf(v));
  const guarded = coaching.some((v) => cls(v)?.guard);
  if (!vans.length && !guarded) vans = [mintVehicle(fitted.length && !coaching.length ? (fittedBrakeVanFor(lib, company, era)?.id ?? 'generic-brake-van-20t-fitted') : fallbackClassId({ category: 'brakeVan' }))];
  if (fitted.length && !coaching.length) {
    const fv = fittedBrakeVanFor(lib, company, era);
    if (fv) vans = vans.map((v) => (fittedOf(v) ? v : { ...mintVehicle(fv.id), ...(v.identity ? { identity: v.identity } : {}) }));
  }
  return [...coaching, ...fitted, ...plain, ...vans];
}

// ---------------------------------------------------------------------------- a train's stock

/** How a train gets its stock: its own choice, else (trains from before rakes) its text consist. */
export function trainStockOf(t: TimetableTrain): TrainStock {
  return t.stock ?? { mode: 'text' };
}

/** A train's stock, cleaned on load: an unknown mode is dropped (the text consist then applies). */
export function sanitiseTrainStock(t: TimetableTrain): void {
  const s = t.stock as unknown;
  if (s === undefined) return;
  if (!isObj(s) || !['any', 'type', 'rake', 'text'].includes(s.mode as string)) {
    delete t.stock;
    return;
  }
  const clean: TrainStock = { mode: s.mode as TrainStock['mode'] };
  if (clean.mode === 'type' && typeof s.rakeTypeId === 'string') clean.rakeTypeId = s.rakeTypeId;
  if (clean.mode === 'type' && Array.isArray(s.formation)) {
    const f = s.formation
      .filter(isObj)
      .filter((x) => typeof x.classId === 'string' && !!x.classId)
      .slice(0, 200)
      .map((x) => ({ classId: x.classId as string, ...(x.loaded === true ? { loaded: true } : {}) }));
    if (f.length) clean.formation = f;
  }
  if (clean.mode === 'rake' && typeof s.rakeId === 'string') clean.rakeId = s.rakeId;
  t.stock = clean;
}

/** Does a saved rake suit a working (coaching stock for passenger, parcels and empty stock; goods stock for goods)? */
export function rakeSuits(rake: { vehicleIds: string[] }, rs: RollingStock, lib: StockLibrary, trainTypeId: string): boolean {
  const kind = stockKindFor(trainTypeId);
  if (kind === 'none') return false;
  const rv = rakeVehicles({ id: '', identity: '', vehicleIds: rake.vehicleIds, engineEnd: 'A', notes: '' }, rs.fleet).map((v) => resolveVehicle(v, lib));
  if (!rv.length) return false;
  const k = rakeKind(rv);
  return kind === 'coaching' ? k === 'passenger' : k === 'freight';
}

export interface StockChoice {
  vehicles: Vehicle[];
  /** The saved rake used, if any. */
  rakeId?: string;
  /** The rake type used, if any. */
  rakeTypeId?: string;
  /** Words for the consist ("4 coaches + a brake van"), kept on the working. */
  text: string;
}

export interface StockContext {
  /** How the box runs: play mode mints vehicles; model railway mode uses the fleet. */
  mode: 'model' | 'play';
  /** The working (train type) of the move it is for. */
  trainTypeId: string;
  rng?: () => number;
  limits?: RakeLimits;
  /** Vehicles in use by other trains on the layout now (D20): saved rakes sharing them are not chosen. */
  inUse?: Set<string>;
}

/** Vehicles minted from a generated formation (v0.3.41): the exact make-up the generator chose. */
export function formationVehicles(formation: Array<{ classId: string; loaded?: boolean }>): Vehicle[] {
  return formation.map((f) => ({ ...mintVehicle(f.classId), ...(f.loaded ? { loaded: true } : {}) }));
}

/** A formation to keep on a train, from its vehicles. */
export function formationOf(vehicles: Vehicle[]): Array<{ classId: string; loaded?: boolean }> {
  return vehicles.map((v) => ({ classId: v.classId, ...(v.loaded ? { loaded: true } : {}) }));
}

/**
 * A rake type made into a marshalled train for a working (v0.3.41): the goods mix of the layout's
 * company, unfitted for pick-up and branch goods (D5), within the limits, then marshalled (D5a).
 */
export function generateRake(rt: RakeType, layout: Layout | undefined, lib: StockLibrary, trainTypeId: string, rng?: () => number, limits: RakeLimits = {}): Vehicle[] {
  const { company, era } = layoutStock(layout);
  const params = stockParams(company, [era], lib.files);
  const opts: ResolveOptions = { params, unfitted: params.unfittedTrainTypes.includes(trainTypeId) };
  const make = () => marshal(resolveRakeType(rt, lib, rng, limits, opts), lib, company, era);
  let vehicles = make();
  // A freight class goes by its fitted head (D21): draw again (from the same seeded source) until the
  // rake's fitted head gives the working's class, keeping the first draw if none does.
  const classed = params.unfittedClass === trainTypeId || params.fittedClasses.some((c) => c.trainTypeId === trainTypeId);
  const fits = (vs: Vehicle[]) => headcodeClass(vs.map((v) => resolveVehicle(v, lib)), params) === trainTypeId;
  if (rng && classed && !fits(vehicles)) {
    for (let i = 0; i < 40; i++) {
      const again = make();
      if (fits(again)) {
        vehicles = again;
        break;
      }
    }
  }
  return vehicles;
}

/**
 * A rake for a new train of a working, made by the timetable generator (v0.3.41): a rake type the layout
 * offers for the working (preferring ones that fit at their minimum), resolved with the seeded random
 * source within the train limit and the room given, and marshalled. Null when the working has no stock
 * or no rake type suits it.
 */
export function generateTrainStock(state: Pick<AppState, 'trainTypes'>, layout: Layout, trainTypeId: string, rng: () => number, maxMetres?: number): StockChoice | null {
  if (stockKindFor(trainTypeId) === 'none') return null;
  const lib = stockLibrary(layout.rollingStock);
  const { company, era } = layoutStock(layout);
  const tl = trainLimit(state, layout, trainTypeId);
  const limits: RakeLimits = { ...(tl.maxVehicles ? { maxVehicles: tl.maxVehicles } : {}), ...(tl.maxTons ? { maxTons: tl.maxTons } : {}), ...(maxMetres !== undefined && maxMetres > 0 ? { maxMetres } : {}) };
  const types = rakeTypesFor(trainTypeId, rakeTypesOf(layout));
  const fitting = types.filter((x) => rakeTypeFits(x, lib, limits));
  const rt = pickRakeType(fitting.length ? fitting : types, stockParams(company, [era], lib.files), era, rng);
  if (!rt) return null;
  const vehicles = generateRake(rt, layout, lib, trainTypeId, rng, limits);
  return { vehicles, rakeTypeId: rt.id, text: vehiclesDescription(vehicles, lib) };
}

/**
 * The stock a train runs with, for a move: null when it uses its text consist (or has no stock: a light
 * engine). A specific rake gives the fleet's own vehicles in model railway mode and minted copies in
 * play mode (D1); a missing rake or type falls back to any suitable. A rake type with a formation the
 * generator chose runs with exactly that formation.
 */
export function resolveTrainStock(state: AppState, layout: Layout, t: TimetableTrain, ctx: StockContext): StockChoice | null {
  if (stockKindFor(ctx.trainTypeId) === 'none') return null;
  const s = trainStockOf(t);
  if (s.mode === 'text') return null;
  const rs = layout.rollingStock ?? emptyRollingStock();
  const lib = stockLibrary(rs);
  const done = (vehicles: Vehicle[], extra: Partial<StockChoice>): StockChoice => ({ vehicles, text: vehiclesDescription(vehicles, lib), ...extra });
  const tl = trainLimit(state, layout, ctx.trainTypeId);
  const limits: RakeLimits = { ...(tl.maxVehicles ? { maxVehicles: tl.maxVehicles } : {}), ...(tl.maxTons ? { maxTons: tl.maxTons } : {}), ...(ctx.limits ?? {}) };
  const { company, era } = layoutStock(layout);
  const params = stockParams(company, [era], lib.files);
  const fromRake = (rakeId: string) => {
    const rake = rs.rakes.find((r) => r.id === rakeId);
    if (!rake) return null;
    const own = rakeVehicles(rake, rs.fleet);
    if (!own.length) return null;
    const vehicles = ctx.mode === 'play' ? own.map((v) => ({ ...mintVehicle(v.classId), ...(v.loaded ? { loaded: true } : {}), ...(v.identity ? { identity: v.identity } : {}) })) : own.map((v) => ({ ...v }));
    return done(vehicles, { rakeId });
  };
  const fromType = (types: RakeType[]) => {
    const r = ctx.rng ?? Math.random;
    const fitting = types.filter((x) => rakeTypeFits(x, lib, limits));
    const rt = pickRakeType(fitting.length ? fitting : types, params, era, r);
    if (!rt) return null;
    return done(generateRake(rt, layout, lib, ctx.trainTypeId, r, limits), { rakeTypeId: rt.id });
  };
  if (s.mode === 'rake' && s.rakeId) {
    const c = fromRake(s.rakeId);
    if (c) return c;
  }
  if (s.mode === 'type') {
    // A generated formation runs as kept, even if its rake type has since gone (it is the instance).
    if (s.formation?.length) return done(formationVehicles(s.formation), { rakeTypeId: s.rakeTypeId });
    const rt = findRakeType(s.rakeTypeId, layout);
    if (rt) return fromType([rt]);
  }
  // Any suitable: in model railway mode a saved rake that suits, fits and is free; else a rake type.
  if (ctx.mode === 'model') {
    const free = rs.rakes.filter((r) => rakeSuits(r, rs, lib, ctx.trainTypeId) && !r.vehicleIds.some((id) => ctx.inUse?.has(id)));
    const fits = free.filter((r) => {
      const rv = rakeVehicles(r, rs.fleet).map((v) => resolveVehicle(v, lib));
      return (limits.maxMetres === undefined || rakeLength(rv).metres <= limits.maxMetres) && (limits.maxVehicles === undefined || rv.length <= limits.maxVehicles);
    });
    const pool = fits.length ? fits : [];
    if (pool.length) return fromRake(pool[Math.floor((ctx.rng ?? Math.random)() * pool.length)].id);
  }
  return fromType(rakeTypesFor(ctx.trainTypeId, rakeTypesOf(layout)));
}

/** A preview of what a train will run with (for the editor): its rake, or a rake type at its middle counts. Null for text or "any suitable". */
export function previewTrainStock(layout: Layout, t: TimetableTrain): { vehicles: Vehicle[]; lib: StockLibrary; label: string } | null {
  const s = trainStockOf(t);
  const rs = layout.rollingStock ?? emptyRollingStock();
  const lib = stockLibrary(rs);
  if (s.mode === 'rake') {
    const rake = rs.rakes.find((r) => r.id === s.rakeId);
    return rake ? { vehicles: rakeVehicles(rake, rs.fleet), lib, label: rake.identity } : null;
  }
  if (s.mode === 'type') {
    const rt = findRakeType(s.rakeTypeId, layout);
    if (s.formation?.length) return { vehicles: formationVehicles(s.formation), lib, label: `${rt?.name ?? 'Rake type'} (as generated)` };
    if (!rt) return null;
    const w = rt.trainTypeIds[0] ?? '';
    return { vehicles: generateRake(rt, layout, lib, w), lib, label: `${rt.name} (a typical one)` };
  }
  return null;
}

export interface StockIssue {
  level: 'error' | 'warn';
  code: string;
  text: string;
}

const typeName = (state: AppState, id: string) => state.trainTypes.find((x) => x.id === id)?.name ?? id;

/**
 * The editor's checks on trains' stock (v0.3.40): a rake or rake type that has gone; a rake whose fitted
 * head gives a different freight class from the train's working (a warning, not an error); coaching stock
 * on a goods working or the other way round; two trains whose specific rakes share vehicles (D20).
 */
export function stockIssues(state: AppState, layout: Layout, tt: Timetable): Map<string, StockIssue[]> {
  const out = new Map<string, StockIssue[]>();
  const add = (id: string, i: StockIssue) => (out.get(id) ?? out.set(id, []).get(id)!).push(i);
  const rs = layout.rollingStock ?? emptyRollingStock();
  const lib = stockLibrary(rs);
  const { company, era } = layoutStock(layout);
  const params = lib.params(company, [era]);
  const freightClasses = new Set([...params.fittedClasses.map((c) => c.trainTypeId), params.unfittedClass]);
  for (const t of tt.trains) {
    const s = trainStockOf(t);
    if (s.mode === 'rake' && !rs.rakes.some((r) => r.id === s.rakeId)) add(t.id, { level: 'warn', code: 'rakeMissing', text: 'Its rake is no longer saved on this layout: it runs with any suitable rake.' });
    if (s.mode === 'type' && !s.formation?.length && !findRakeType(s.rakeTypeId, layout)) add(t.id, { level: 'warn', code: 'rakeTypeMissing', text: 'Its rake type is no longer available: it runs with any suitable rake.' });
    const p = previewTrainStock(layout, t);
    if (!p?.vehicles.length) continue;
    const rv = p.vehicles.map((v) => resolveVehicle(v, lib));
    const kind = rakeKind(rv);
    const workings = [...new Set(tt.entries.filter((e) => e.trainId === t.id && (e.kind === 'run' || e.kind === 'enter')).map((e) => e.trainTypeId))];
    for (const w of workings) {
      const want = stockKindFor(w);
      if (want === 'coaching' && kind !== 'passenger' && kind !== 'mixed') add(t.id, { level: 'warn', code: 'stockKind', text: `It works ${typeName(state, w).toLowerCase()}, but its rake is goods stock.` });
      if (want === 'goods' && kind === 'passenger') add(t.id, { level: 'warn', code: 'stockKind', text: `It works ${typeName(state, w).toLowerCase()}, but its rake is coaching stock.` });
      if (freightClasses.has(w) && kind !== 'passenger') {
        const cls = headcodeClass(fromEngine(rv, 'A'), params);
        if (cls !== w) add(t.id, { level: 'warn', code: 'stockClass', text: `Its rake’s fitted head (from the engine end) makes it ${typeName(state, cls).toLowerCase()}, not ${typeName(state, w).toLowerCase()}.` });
      }
    }
  }
  // Specific rakes sharing vehicles (D20): fine for variations, but not on the layout at once.
  const withRake = tt.trains.filter((t) => trainStockOf(t).mode === 'rake');
  for (const a of withRake)
    for (const b of withRake) {
      if (a === b) continue;
      const ra = rs.rakes.find((r) => r.id === a.stock?.rakeId);
      const rb = rs.rakes.find((r) => r.id === b.stock?.rakeId);
      if (!ra || !rb) continue;
      if (ra.id === rb.id || ra.vehicleIds.some((id) => rb.vehicleIds.includes(id)))
        add(a.id, { level: 'warn', code: 'stockShared', text: `Its rake shares vehicles with ${b.name}’s (${ra.id === rb.id ? 'the same rake' : rb.identity}): they cannot both be on the layout at once.` });
    }
  return out;
}
