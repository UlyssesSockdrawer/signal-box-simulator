import { consistVehicles, splitVehicles, vehiclesText } from './railway';
import { builtInClasses, GENERIC_ORIGIN, STOCK_DATA_FILES, stockParams, type StockDataFile, type StockParams, type TrainLimit } from './stockLibrary';
import type { CoachType, LengthBasis, Rake, RakeEnd, RollingStock, StockCategory, Vehicle, VehicleClass } from './stockTypes';

/*
 * ROLLING STOCK (v0.3.38): the stock library, fleet and rakes, and everything worked out from them.
 * Pure logic, no UI. Generic throughout: a company, era, diagram number, buffer allowance or train
 * limit is data (core/stockData/*.json via core/stockLibrary.ts), never a branch here.
 *
 * Words used: a CLASS is a library type ("57 ft corridor third"); a VEHICLE is one of them in a fleet
 * (with a GUID that never changes and an optional display identity); a RAKE is an ordered list of
 * vehicles with ends A (first) and B (last). The engine end is assumed in the builder (D7).
 */

// ---------------------------------------------------------------------------- the library

/** The library a layout sees: built-in types (shipped data files) and its own types. */
export interface StockLibrary {
  /** Find a type by id (own types first, then built-ins, hidden or not). */
  cls(id: string): VehicleClass | undefined;
  /** Types to offer in lists: own types, then built-ins not hidden. */
  list(): VehicleClass[];
  /** Built-in types, hidden or not. */
  builtIns(): VehicleClass[];
  hidden(id: string): boolean;
  /** Parameters for a company and era (generic defaults where it has none). */
  params(origin?: string, eras?: string[]): StockParams;
  files: StockDataFile[];
}

export function stockLibrary(rs?: RollingStock, files?: StockDataFile[]): StockLibrary {
  const built = builtInClasses(files);
  const fs = files ?? STOCK_DATA_FILES;
  const own = rs?.classes ?? [];
  const hidden = new Set(rs?.hidden ?? []);
  const byId = new Map<string, VehicleClass>();
  for (const c of built) byId.set(c.id, c);
  for (const c of own) byId.set(c.id, c);
  return {
    cls: (id) => byId.get(id),
    list: () => [...own, ...built.filter((c) => !hidden.has(c.id))],
    builtIns: () => built,
    hidden: (id) => hidden.has(id),
    params: (origin, eras) => stockParams(origin, eras, fs),
    files: fs,
  };
}

/** An empty rolling stock record for a layout. */
export function emptyRollingStock(): RollingStock {
  return { classes: [], hidden: [], fleet: [], rakes: [] };
}

export const CATEGORY_NAMES: Record<StockCategory, string> = { coach: 'Coaches', van: 'Vans', wagon: 'Wagons', brakeVan: 'Brake vans', other: 'Other' };
export const COACH_TYPE_NAMES: Record<CoachType, string> = {
  ordinary: 'Passenger coach',
  passengerBrake: 'Passenger brake',
  fullBrake: 'Full brake',
  drivingTrailer: 'Driving trailer (push-pull)',
  tpo: 'TPO (Post Office)',
  catering: 'Kitchen or dining',
  sleeping: 'Sleeping car',
  van: 'Parcels or luggage van',
};
export const BASIS_NAMES: Record<LengthBasis, string> = { measured: 'measured', estimated: 'estimated', nominal: 'nominal', generic: 'generic' };

/** Is it coaching stock (runs in passenger, parcels and mail trains)? */
export const isCoaching = (c: VehicleClass | undefined): boolean => !!c?.coachType;
/** Is it goods stock (wagons, goods vans, brake vans)? */
export const isGoods = (c: VehicleClass | undefined): boolean => !!c && !c.coachType && c.category !== 'other';
/** Can it be loaded (wagons and goods vans)? */
export const canLoad = (c: VehicleClass | undefined): boolean => !!c && !c.coachType && (c.category === 'wagon' || c.category === 'van');

/**
 * The generic type standing in for a type whose length is not known, by what it is (also used to
 * mint vehicles from a text consist).
 */
export function fallbackClassId(c: Pick<VehicleClass, 'category' | 'coachType'> | undefined): string {
  if (!c) return 'generic-open-7plank-12t';
  switch (c.coachType) {
    case 'passengerBrake':
      return 'generic-passenger-brake-57';
    case 'drivingTrailer':
      return 'generic-driving-trailer-57';
    case 'tpo':
      return 'generic-tpo-60';
    case 'fullBrake':
      return 'generic-full-brake-50';
    case 'van':
      return 'generic-van-50';
    case undefined:
      break;
    default:
      return 'generic-coach-57';
  }
  if (c.category === 'coach') return 'generic-coach-57';
  if (c.category === 'brakeVan') return 'generic-brake-van-20t';
  if (c.category === 'van') return 'generic-vent-van-12t';
  return 'generic-open-7plank-12t';
}

/**
 * A fitted brake van for a train (D5, D5a): one of the same company and era if the library has it,
 * else the generic fitted van, which serves every company and era. Never an unfitted van.
 */
export function fittedBrakeVanFor(lib: StockLibrary, origin?: string, era?: string): VehicleClass | undefined {
  const vans = lib.list().filter((c) => c.category === 'brakeVan' && c.fitted);
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  return (
    vans.find((c) => same(c.origin, origin) && (!era || !c.eras?.length || c.eras.includes(era))) ??
    vans.find((c) => c.origin === GENERIC_ORIGIN) ??
    lib.builtIns().find((c) => c.category === 'brakeVan' && c.fitted && c.origin === GENERIC_ORIGIN) ??
    vans[0]
  );
}

// ---------------------------------------------------------------------------- identity

/** A new vehicle id: a GUID (D3). */
export function newVehicleId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** A short class code for identities: its code, else built from its name. */
export function classCode(c: VehicleClass | undefined): string {
  if (c?.code) return c.code.toUpperCase();
  if (!c) return 'VEH';
  const letters = c.name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase();
  return letters.slice(0, 5) || 'VEH';
}

/** The system identity (D3): class code plus six characters of the GUID, e.g. "BTK-3f9a1c". */
export function systemIdentity(v: Vehicle, c: VehicleClass | undefined): string {
  return `${classCode(c)}-${v.id.replace(/[^0-9a-z]/gi, '').slice(0, 6).toLowerCase()}`;
}

/** What a vehicle is called wherever it is named: its own identity, else the system identity. */
export function vehicleName(v: Vehicle, lib: StockLibrary): string {
  return v.identity?.trim() || systemIdentity(v, lib.cls(v.classId));
}

/** Display identities used by more than one vehicle in a fleet (a warning, never a block): identity → vehicle ids. */
export function duplicateIdentities(fleet: Vehicle[], lib: StockLibrary): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const v of fleet) {
    const k = vehicleName(v, lib).trim().toLowerCase();
    by.set(k, [...(by.get(k) ?? []), v.id]);
  }
  for (const [k, ids] of by) if (ids.length < 2) by.delete(k);
  return by;
}

/** A new vehicle of a type (identity empty: the system identity shows). */
export function mintVehicle(classId: string): Vehicle {
  return { id: newVehicleId(), classId };
}

// ---------------------------------------------------------------------------- one vehicle, resolved

/** A vehicle with its type's values applied (its own overrides first). */
export interface ResolvedVehicle {
  vehicle: Vehicle;
  cls: VehicleClass | undefined;
  /** Length over buffers used (its own, its type's, else the generic stand-in's). */
  metres: number;
  /** The length is not a measured one (shown as "about"). */
  approx: boolean;
  /** No length was known: the generic stand-in's length is used. */
  unknownLength: boolean;
  fitted: boolean;
  guard: boolean;
  coachType?: CoachType;
  category: StockCategory;
  corridor?: boolean;
  loaded: boolean;
  /** Weight in kg if known (loaded weight when loaded and known, else tare). */
  kg: number | null;
}

export function resolveVehicle(v: Vehicle, lib: StockLibrary): ResolvedVehicle {
  const c = lib.cls(v.classId);
  let metres = v.metresOverBuffers ?? c?.metresOverBuffers;
  let approx = v.metresOverBuffers !== undefined ? false : c?.lengthBasis !== 'measured';
  let unknownLength = false;
  if (metres === undefined) {
    const stand = lib.cls(fallbackClassId(c));
    metres = stand?.metresOverBuffers ?? 6.25;
    approx = true;
    unknownLength = true;
  }
  const loaded = v.loaded === true && canLoad(c);
  const kg = loaded ? (c?.loadedKg ?? null) : (c?.tareKg ?? null);
  return {
    vehicle: v,
    cls: c,
    metres,
    approx,
    unknownLength,
    fitted: v.fitted ?? c?.fitted ?? false,
    guard: c?.guard ?? false,
    coachType: c?.coachType,
    category: c?.category ?? 'other',
    corridor: c?.corridor,
    loaded,
    kg,
  };
}

// ---------------------------------------------------------------------------- rakes

/** A rake's vehicles in order (end A first), skipping any no longer in the fleet. */
export function rakeVehicles(rake: Rake, fleet: Vehicle[]): Vehicle[] {
  const by = new Map(fleet.map((v) => [v.id, v]));
  return rake.vehicleIds.map((id) => by.get(id)).filter((v): v is Vehicle => !!v);
}

/** The vehicles from the engine end outwards. */
export function fromEngine<T>(list: T[], engineEnd: RakeEnd): T[] {
  return engineEnd === 'B' ? [...list].reverse() : [...list];
}

/** Total length over buffers; `approx` when any length is approximate (D15: say "about"). */
export function rakeLength(rv: ResolvedVehicle[]): { metres: number; approx: boolean; unknown: number } {
  return { metres: rv.reduce((m, v) => m + v.metres, 0), approx: rv.some((v) => v.approx), unknown: rv.filter((v) => v.unknownLength).length };
}

/** Weight (tare, or loaded where loaded), tolerating missing weights: `missing` vehicles had none. */
export function rakeWeight(rv: ResolvedVehicle[]): { kg: number | null; missing: number } {
  const known = rv.filter((v) => v.kg !== null);
  return { kg: known.length ? known.reduce((m, v) => m + (v.kg ?? 0), 0) : null, missing: rv.length - known.length };
}

/** The fitted head: the unbroken run of fitted vehicles from the engine end (an unfitted vehicle breaks it). */
export function fittedHead(fromEngineList: ResolvedVehicle[]): number {
  let n = 0;
  for (const v of fromEngineList) {
    if (!v.fitted) break;
    n++;
  }
  return n;
}

/** The share of the vehicles in the fitted head (0 for an empty rake). */
export function fittedProportion(fromEngineList: ResolvedVehicle[]): number {
  return fromEngineList.length ? fittedHead(fromEngineList) / fromEngineList.length : 0;
}

/**
 * The freight train class a rake's fitted head gives (a train type id), from the fitted-class rules in
 * the parameter data: e.g. at least half fitted → ½ fitted (3-1-1, Class C; a fully fitted train counts here, D21).
 */
export function headcodeClass(fromEngineList: ResolvedVehicle[], params: StockParams): string {
  const head = fittedHead(fromEngineList);
  const share = fittedProportion(fromEngineList);
  for (const r of params.fittedClasses) {
    if (r.minProportion !== undefined && head > 0 && share + 1e-9 >= r.minProportion) return r.trainTypeId;
    if (r.minFittedHead !== undefined && head >= r.minFittedHead) return r.trainTypeId;
  }
  return params.unfittedClass;
}

/** Push-pull capable: a driving trailer at the far end from the engine. */
export function pushPullCapable(fromEngineList: ResolvedVehicle[]): boolean {
  const last = fromEngineList[fromEngineList.length - 1];
  return fromEngineList.length > 0 && last.coachType === 'drivingTrailer';
}

/** Positions (0 = end A) of vehicles with a guard's compartment. */
export function guardPositions(rv: ResolvedVehicle[]): number[] {
  return rv.flatMap((v, i) => (v.guard ? [i] : []));
}

/** What sort of train the rake makes: passenger (coaching stock only), freight, mixed, or empty. */
export function rakeKind(rv: ResolvedVehicle[]): 'passenger' | 'freight' | 'mixed' | 'empty' {
  const coaching = rv.some((v) => !!v.coachType);
  const goods = rv.some((v) => !v.coachType && v.category !== 'other');
  if (!rv.length) return 'empty';
  if (coaching && goods) return 'mixed';
  return goods ? 'freight' : 'passenger';
}

export type NoteCode =
  | 'freightNoBrakeVan'
  | 'passengerNoGuard'
  | 'brakeVanNotAtTail'
  | 'guardNotAtEnd'
  | 'drivingTrailerNotAtEnd'
  | 'nonCorridorBreak'
  | 'unfittedAheadOfFitted'
  | 'unfittedVanOnFittedTrain'
  | 'tooLong'
  | 'overVehicleLimit'
  | 'overTonsLimit'
  | 'unknownLength'
  | 'sharedVehicles';

/** A validity note (never blocks a build). 'safety' notes are things to avoid (D5). */
export interface StockNote {
  code: NoteCode;
  severity: 'note' | 'safety';
  vehicleIds: string[];
  /** Values for the wording (UI). */
  data?: Record<string, string | number>;
}

export interface NoteContext {
  /** A train type to check against (limits; pick-up and branch goods are treated as unfitted). */
  trainTypeId?: string;
  limit?: TrainLimit;
  /** Length of the road or platform it is to stand in, metres. */
  roadMetres?: number;
  params?: StockParams;
}

/**
 * Validity notes for a rake (rakes plan 3.5), as data. `rv` is in rake order (end A first); the engine
 * is at `engineEnd`.
 */
export function rakeNotes(rv: ResolvedVehicle[], engineEnd: RakeEnd, ctx: NoteContext = {}): StockNote[] {
  const notes: StockNote[] = [];
  if (!rv.length) return notes;
  const fe = fromEngine(rv, engineEnd);
  const kind = rakeKind(rv);
  const ids = (xs: ResolvedVehicle[]) => xs.map((v) => v.vehicle.id);
  const vans = fe.filter((v) => v.category === 'brakeVan');
  const tail = fe[fe.length - 1];
  const head = fe[0];
  if ((kind === 'freight' || kind === 'mixed') && !vans.length) notes.push({ code: 'freightNoBrakeVan', severity: 'note', vehicleIds: [] });
  if (kind === 'freight' && vans.length && tail.category !== 'brakeVan') notes.push({ code: 'brakeVanNotAtTail', severity: 'note', vehicleIds: ids(vans) });
  if (kind === 'passenger') {
    const guards = fe.filter((v) => v.guard);
    if (!guards.length) notes.push({ code: 'passengerNoGuard', severity: 'note', vehicleIds: [] });
    else if (!head.guard && !tail.guard) notes.push({ code: 'guardNotAtEnd', severity: 'note', vehicleIds: ids(guards) });
  }
  rv.forEach((v, i) => {
    if (v.coachType === 'drivingTrailer' && i !== 0 && i !== rv.length - 1) notes.push({ code: 'drivingTrailerNotAtEnd', severity: 'note', vehicleIds: [v.vehicle.id] });
  });
  // A non-corridor vehicle with corridor vehicles on both sides breaks the corridor.
  rv.forEach((v, i) => {
    if (v.corridor !== false) return;
    const before = rv.slice(0, i).some((x) => x.corridor === true);
    const after = rv.slice(i + 1).some((x) => x.corridor === true);
    if (before && after) notes.push({ code: 'nonCorridorBreak', severity: 'note', vehicleIds: [v.vehicle.id] });
  });
  // Unfitted ahead of fitted: a fitted vehicle beyond the first unfitted one (counted from the engine).
  const firstUnfitted = fe.findIndex((v) => !v.fitted);
  if (firstUnfitted >= 0 && fe.slice(firstUnfitted + 1).some((v) => v.fitted) && kind !== 'passenger')
    notes.push({ code: 'unfittedAheadOfFitted', severity: 'note', vehicleIds: ids(fe.slice(firstUnfitted + 1).filter((v) => v.fitted)) });
  // An unfitted brake van on a train with a fitted head (D5): to be avoided. Pick-up and branch goods count as unfitted.
  const unfittedTrain = !!ctx.trainTypeId && (ctx.params?.unfittedTrainTypes ?? ['pickup_goods', 'branch_freight']).includes(ctx.trainTypeId);
  if (!unfittedTrain && fittedHead(fe) > 0 && kind !== 'passenger') {
    const bad = vans.filter((v) => !v.fitted);
    if (bad.length) notes.push({ code: 'unfittedVanOnFittedTrain', severity: 'safety', vehicleIds: ids(bad) });
  }
  const len = rakeLength(rv);
  if (ctx.roadMetres !== undefined && len.metres > ctx.roadMetres) notes.push({ code: 'tooLong', severity: 'note', vehicleIds: [], data: { metres: len.metres, road: ctx.roadMetres, approx: len.approx ? 1 : 0 } });
  if (ctx.limit?.maxVehicles !== undefined && rv.length > ctx.limit.maxVehicles) notes.push({ code: 'overVehicleLimit', severity: 'note', vehicleIds: [], data: { count: rv.length, max: ctx.limit.maxVehicles } });
  const w = rakeWeight(rv);
  if (ctx.limit?.maxTons !== undefined && w.kg !== null && w.kg / 1016.047 > ctx.limit.maxTons) notes.push({ code: 'overTonsLimit', severity: 'note', vehicleIds: [], data: { tons: Math.round(w.kg / 1016.047), max: ctx.limit.maxTons } });
  const unknown = rv.filter((v) => v.unknownLength);
  if (unknown.length) notes.push({ code: 'unknownLength', severity: 'note', vehicleIds: ids(unknown) });
  return notes;
}

/** Other saved rakes that share vehicles with this one (D20: allowed; noted). */
export function rakesSharing(rs: RollingStock, rake: Rake): Array<{ rake: Rake; vehicleIds: string[] }> {
  const mine = new Set(rake.vehicleIds);
  return rs.rakes.filter((r) => r.id !== rake.id).map((r) => ({ rake: r, vehicleIds: r.vehicleIds.filter((id) => mine.has(id)) })).filter((x) => x.vehicleIds.length > 0);
}

/** Everything the builder shows about a rake. */
export interface RakeSummary {
  vehicles: ResolvedVehicle[];
  count: number;
  length: { metres: number; approx: boolean; unknown: number };
  weight: { kg: number | null; missing: number };
  fittedHead: number;
  fittedProportion: number;
  headcodeClass: string;
  pushPull: boolean;
  guards: number[];
  kind: ReturnType<typeof rakeKind>;
  notes: StockNote[];
}

export function summariseRake(rake: Rake, rs: RollingStock, lib: StockLibrary, ctx: NoteContext = {}): RakeSummary {
  const rv = rakeVehicles(rake, rs.fleet).map((v) => resolveVehicle(v, lib));
  const fe = fromEngine(rv, rake.engineEnd);
  const origins = rv.map((v) => v.vehicle.origin ?? v.cls?.origin).filter((o): o is string => !!o && o !== GENERIC_ORIGIN);
  const params = ctx.params ?? lib.params(origins[0]);
  const notes = rakeNotes(rv, rake.engineEnd, { ...ctx, params });
  const shared = rakesSharing(rs, rake);
  if (shared.length) notes.push({ code: 'sharedVehicles', severity: 'note', vehicleIds: [...new Set(shared.flatMap((s) => s.vehicleIds))], data: { rakes: shared.map((s) => s.rake.identity).join(', ') } });
  return {
    vehicles: rv,
    count: rv.length,
    length: rakeLength(rv),
    weight: rakeWeight(rv),
    fittedHead: fittedHead(fe),
    fittedProportion: fittedProportion(fe),
    headcodeClass: headcodeClass(fe, params),
    pushPull: pushPullCapable(fe),
    guards: guardPositions(rv),
    kind: rakeKind(rv),
    notes,
  };
}

// ---------------------------------------------------------------------------- vehicles in play mode (D19)

/**
 * The word the text consists use for a vehicle ("coach", "van", "brake van", "wagon", "auto-coach"), so
 * vehicles and the text consist of a working stay in step until timetables carry rakes (Stage 2).
 */
export function consistKind(c: VehicleClass | undefined): string {
  if (!c) return 'wagon';
  if (c.coachType === 'drivingTrailer') return 'auto-coach';
  if (c.coachType === 'fullBrake' || c.coachType === 'van' || c.coachType === 'tpo') return 'van';
  if (c.coachType || c.category === 'coach') return 'coach';
  if (c.category === 'brakeVan') return 'brake van';
  if (c.category === 'van') return 'van';
  return 'wagon';
}

/** The generic type minted for a word of a text consist. */
const KIND_CLASS: Record<string, string> = {
  coach: 'generic-coach-57',
  car: 'generic-coach-57',
  'auto-coach': 'generic-driving-trailer-57',
  van: 'generic-van-50',
  'brake van': 'generic-brake-van-20t',
  wagon: 'generic-open-7plank-12t',
};

/** Vehicles minted from the generic library for a text consist ("4 coaches + brake van"), in the order it names them (D1). */
export function mintFromConsist(consist: string): Vehicle[] {
  return consistVehicles(consist).flatMap((g) => Array.from({ length: g.count }, () => mintVehicle(KIND_CLASS[g.kind] ?? 'generic-open-7plank-12t')));
}

/** Vehicles as counts of consist words, in order of first appearance: [{kind, count, metres}]. */
export function vehicleGroups(vehicles: Vehicle[], lib: StockLibrary): Array<{ kind: string; count: number; metres: number }> {
  const out: Array<{ kind: string; count: number; metres: number }> = [];
  for (const v of vehicles) {
    const r = resolveVehicle(v, lib);
    const kind = consistKind(r.cls);
    const g = out.find((x) => x.kind === kind);
    if (g) {
      g.metres = (g.metres * g.count + r.metres) / (g.count + 1);
      g.count++;
    } else out.push({ kind, count: 1, metres: r.metres });
  }
  return out;
}

/** Some vehicles as consist text: "4 coaches + a brake van". */
export function vehiclesDescription(vehicles: Vehicle[], lib: StockLibrary): string {
  return vehiclesText(vehicleGroups(vehicles, lib));
}

/** Total length of some vehicles, metres. */
export function vehiclesMetres(vehicles: Vehicle[], lib: StockLibrary): number {
  return vehicles.reduce((m, v) => m + resolveVehicle(v, lib).metres, 0);
}

/**
 * Take the vehicles a shunt "moves with" ("2 vans", "4 coaches + a brake van"; a kind named in the
 * plural with no number = all of that kind) out of a list, keeping the order of both parts. The first
 * matching vehicles in the list are taken.
 */
export function splitVehicleList(vehicles: Vehicle[], want: string, lib: StockLibrary): { taken: Vehicle[]; left: Vehicle[] } {
  const groups = vehicleGroups(vehicles, lib);
  const { taken } = splitVehicles(groups, want);
  const need = new Map(taken.map((g) => [g.kind, g.count]));
  const out: Vehicle[] = [];
  const left: Vehicle[] = [];
  for (const v of vehicles) {
    const k = consistKind(lib.cls(v.classId));
    const n = need.get(k) ?? 0;
    if (n > 0) {
      out.push(v);
      need.set(k, n - 1);
    } else left.push(v);
  }
  return { taken: out, left };
}
