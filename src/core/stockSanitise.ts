import type { CoachType, LengthBasis, Rake, RakeSlot, RakeType, RollingStock, StandingRake, StockCategory, StockShape, Vehicle, VehicleClass } from './stockTypes';

/*
 * Sanitising rolling stock on load (v0.3.38): bad values are dropped, good ones kept, so an old or
 * damaged save always loads. The same class sanitiser checks the built-in library rows (D4).
 */

export const CATEGORIES: StockCategory[] = ['coach', 'van', 'wagon', 'brakeVan', 'other'];
export const COACH_TYPES: CoachType[] = ['ordinary', 'passengerBrake', 'fullBrake', 'drivingTrailer', 'tpo', 'catering', 'sleeping', 'van'];
export const LENGTH_BASES: LengthBasis[] = ['measured', 'estimated', 'nominal', 'generic'];
export const SHAPES: StockShape[] = ['coach', 'open', 'mineral', 'closed', 'cattle', 'tank', 'flat', 'brakeVan'];

/** Longest sensible vehicle (metres): anything longer is a typing slip. */
export const MAX_VEHICLE_METRES = 60;

const str = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, max);
  return t || undefined;
};
const posNum = (v: unknown, max = Infinity): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && !!c) : []);

/** A rake type (v0.3.41: built in, or the layout's own), cleaned; null when it has no id, name or slots. A goods-mix slot needs no class of its own. */
export function sanitiseRakeType(raw: unknown, builtIn = false): RakeType | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !Array.isArray(raw.slots)) return null;
  const slots: RakeSlot[] = raw.slots
    .filter(isObj)
    .map((x) => {
      const classIds = strList(x.classIds);
      const min = Number.isFinite(x.min) ? Math.max(0, Math.min(200, Math.round(x.min as number))) : 1;
      const max = Number.isFinite(x.max) ? Math.max(min, Math.min(200, Math.round(x.max as number))) : min;
      return {
        classIds,
        min,
        max,
        ...(typeof x.fitted === 'boolean' ? { fitted: x.fitted } : {}),
        ...(typeof x.loaded === 'boolean' ? { loaded: x.loaded } : {}),
        ...(x.mix === true ? { mix: true } : {}),
        ...(typeof x.group === 'string' && x.group ? { group: x.group } : {}),
      };
    })
    .filter((x) => (x.classIds.length || x.mix) && x.max > 0);
  if (!slots.length) return null;
  const eras = strList(raw.eras);
  return {
    id: raw.id,
    name: raw.name.trim() || 'Rake type',
    trainTypeIds: strList(raw.trainTypeIds),
    weight: Number.isFinite(raw.weight) && (raw.weight as number) > 0 ? Math.min(1000, raw.weight as number) : 1,
    origin: typeof raw.origin === 'string' && raw.origin ? raw.origin : 'generic',
    ...(eras.length ? { eras } : {}),
    slots,
    ...(raw.block === true ? { block: true } : {}),
    ...(builtIn ? { builtIn: true } : {}),
    ...(typeof raw.notes === 'string' && raw.notes ? { notes: raw.notes } : {}),
  };
}

/** A library type, cleaned; null when it has no id or name. */
export function sanitiseVehicleClass(raw: unknown, builtIn = false): VehicleClass | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 120);
  const name = str(raw.name, 120);
  if (!id || !name) return null;
  const category = CATEGORIES.includes(raw.category as StockCategory) ? (raw.category as StockCategory) : 'other';
  const c: VehicleClass = { id, name, category, guard: raw.guard === true, fitted: raw.fitted === true, builtIn };
  const code = str(raw.code, 12);
  if (code) c.code = code;
  if ((category === 'coach' || category === 'van') && COACH_TYPES.includes(raw.coachType as CoachType)) c.coachType = raw.coachType as CoachType;
  if (category === 'coach' && !c.coachType) c.coachType = 'ordinary';
  if (typeof raw.corridor === 'boolean') c.corridor = raw.corridor;
  const buffers = posNum(raw.metresOverBuffers, MAX_VEHICLE_METRES);
  const headstocks = posNum(raw.metresOverHeadstocks, MAX_VEHICLE_METRES);
  if (buffers !== undefined) {
    c.metresOverBuffers = buffers;
    c.lengthBasis = LENGTH_BASES.includes(raw.lengthBasis as LengthBasis) ? (raw.lengthBasis as LengthBasis) : 'estimated';
  }
  // Over headstocks can never be longer than over buffers.
  if (headstocks !== undefined && (buffers === undefined || headstocks <= buffers)) c.metresOverHeadstocks = headstocks;
  const tare = posNum(raw.tareKg, 500_000);
  const loaded = posNum(raw.loadedKg, 500_000);
  if (tare !== undefined) c.tareKg = tare;
  if (loaded !== undefined) c.loadedKg = loaded;
  if ((tare !== undefined || loaded !== undefined) && LENGTH_BASES.includes(raw.weightBasis as LengthBasis)) c.weightBasis = raw.weightBasis as LengthBasis;
  if (SHAPES.includes(raw.shape as StockShape)) c.shape = raw.shape as StockShape;
  const origin = str(raw.origin, 40);
  if (origin) c.origin = origin;
  if (Array.isArray(raw.eras)) {
    const eras = raw.eras.filter((e): e is string => typeof e === 'string' && !!e.trim()).map((e) => e.trim());
    if (eras.length) c.eras = [...new Set(eras)];
  }
  const diagram = str(raw.diagram, 40);
  if (diagram) c.diagram = diagram;
  const quoted = str(raw.quoted, 40);
  if (quoted) c.quoted = quoted;
  const source = str(raw.source, 400);
  if (source) c.source = source;
  const notes = str(raw.notes, 1000);
  if (notes) c.notes = notes;
  const copied = str(raw.copiedFrom, 120);
  if (copied && !builtIn) c.copiedFrom = copied;
  return c;
}

/** A vehicle, cleaned; null when it has no id or type. `places`: the ids of places it may call home. */
export function sanitiseVehicle(raw: unknown, places?: Set<string>): Vehicle | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 80);
  const classId = str(raw.classId, 120);
  if (!id || !classId) return null;
  const v: Vehicle = { id, classId };
  const identity = str(raw.identity, 120);
  if (identity) v.identity = identity;
  if (raw.loaded === true) v.loaded = true;
  const load = str(raw.load, 80);
  if (load) v.load = load;
  const home = str(raw.home, 120);
  if (home && (!places || places.has(home))) v.home = home;
  const metres = posNum(raw.metresOverBuffers, MAX_VEHICLE_METRES);
  if (metres !== undefined) v.metresOverBuffers = metres;
  if (typeof raw.fitted === 'boolean') v.fitted = raw.fitted;
  const origin = str(raw.origin, 40);
  if (origin) v.origin = origin;
  const notes = str(raw.notes, 1000);
  if (notes) v.notes = notes;
  return v;
}

/** A list of vehicles, cleaned, with no id twice. */
export function sanitiseVehicles(raw: unknown, places?: Set<string>): Vehicle[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Vehicle[] = [];
  for (const r of raw) {
    const v = sanitiseVehicle(r, places);
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      out.push(v);
    }
  }
  return out;
}

/** A saved rake, cleaned: only vehicles in the fleet, each once. Null when it has no id. */
export function sanitiseRake(raw: unknown, fleetIds: Set<string>): Rake | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 80);
  if (!id) return null;
  const ids = Array.isArray(raw.vehicleIds) ? raw.vehicleIds.filter((x): x is string => typeof x === 'string' && fleetIds.has(x)) : [];
  return {
    id,
    identity: str(raw.identity, 120) ?? 'Rake',
    vehicleIds: [...new Set(ids)],
    engineEnd: raw.engineEnd === 'B' ? 'B' : 'A',
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 2000) : '',
  };
}

/**
 * A layout's rolling stock, cleaned. `builtInIds`: the built-in library's ids (a hidden id must be one;
 * a user type may not take one). Returns undefined when there is nothing worth keeping.
 */
export function sanitiseRollingStock(raw: unknown, builtInIds: Set<string>, places?: Set<string>, builtInRakeTypeIds?: Set<string>): RollingStock | undefined {
  if (!isObj(raw)) return undefined;
  const classes: VehicleClass[] = [];
  const used = new Set<string>();
  for (const r of Array.isArray(raw.classes) ? raw.classes : []) {
    const c = sanitiseVehicleClass(r, false);
    if (c && !builtInIds.has(c.id) && !used.has(c.id)) {
      used.add(c.id);
      classes.push(c);
    }
  }
  const hidden = Array.isArray(raw.hidden) ? [...new Set(raw.hidden.filter((x): x is string => typeof x === 'string' && builtInIds.has(x)))] : [];
  const fleet = sanitiseVehicles(raw.fleet, places);
  const fleetIds = new Set(fleet.map((v) => v.id));
  const rakeIds = new Set<string>();
  const rakes: Rake[] = [];
  for (const r of Array.isArray(raw.rakes) ? raw.rakes : []) {
    const k = sanitiseRake(r, fleetIds);
    if (k && !rakeIds.has(k.id)) {
      rakeIds.add(k.id);
      rakes.push(k);
    }
  }
  // Rake types (v0.3.41): the layout's own (ids not shared with built-ins), and built-ins it hides.
  const rakeTypes: RakeType[] = [];
  for (const r of Array.isArray(raw.rakeTypes) ? raw.rakeTypes.slice(0, 500) : []) {
    const k = sanitiseRakeType(r, false);
    if (k && !builtInRakeTypeIds?.has(k.id) && !rakeTypes.some((x) => x.id === k.id)) rakeTypes.push(k);
  }
  const hiddenRakeTypes = [...new Set(strList(raw.hiddenRakeTypes).filter((x) => !builtInRakeTypeIds || builtInRakeTypeIds.has(x)))];
  if (!classes.length && !hidden.length && !fleet.length && !rakes.length && !rakeTypes.length && !hiddenRakeTypes.length) return undefined;
  return { classes, hidden, fleet, rakes, ...(rakeTypes.length ? { rakeTypes } : {}), ...(hiddenRakeTypes.length ? { hiddenRakeTypes } : {}) };
}

/**
 * Stock standing in roads (play mode), cleaned: on a road of the layout, with real vehicles. Saves from
 * before v0.3.38 held anonymous counts ({kind, count, metres}); those have no vehicles and are dropped (D14).
 */
export function sanitiseStanding(raw: unknown, roadCircuit: (placeId: string, roadId: string) => string | null): StandingRake[] {
  if (!Array.isArray(raw)) return [];
  const out: StandingRake[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.placeId !== 'string' || typeof r.roadId !== 'string') continue;
    const circuit = roadCircuit(r.placeId, r.roadId);
    if (circuit === null) continue;
    const vehicles = sanitiseVehicles(r.vehicles);
    if (!vehicles.length) continue;
    out.push({ id: r.id, vehicles, placeId: r.placeId, roadId: r.roadId, circuitId: circuit });
  }
  return out;
}
