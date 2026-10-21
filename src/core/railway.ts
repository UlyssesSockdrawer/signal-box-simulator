import type { AppState, ConnectionDef, Junction, Layout, Loco, TrackCircuit, UnitSystem, Working } from './types';

/*
 * REAL-RAILWAY DATA: lengths and speeds for signaller play mode (v0.3.27, Stage 0 groundwork).
 *
 * Everything is optional in saved data and has a default here, so no existing save (nor the shipped
 * Sigsim Central) needs editing. Stored in SI units: lengths in metres, speeds in metres per second.
 * Shown in the units chosen in settings (imperial: miles and chains for block sections, yards for
 * station track circuits, mph; metric: km and m, km/h).
 *
 * TRACK CIRCUIT LENGTHS (circuitLength), in order:
 *  1. Stated: the circuit's own length, if given.
 *  2. Line (block section) circuits share their section's length (ConnectionDef.sectionLength,
 *     default 2 miles) equally, after taking off the circuits on that line with a stated length.
 *     Circuits of one running line share it: on a double line the up and the down line each run
 *     the whole section (grouped by traffic.line; single lines and lines with no traffic set are
 *     one group). A share is never less than a short circuit (55 yards).
 *  3. Short circuits: 55 yards (2½ chains, about 50 m). See isShortCircuit for the rule.
 *  4. Any other circuit in a box's area (platform, loop, siding, yard road): 220 yards (10 chains,
 *     about 200 m).
 */

// ---------------------------------------------------------------------------- units
export const METRES_PER_MILE = 1609.344;
export const METRES_PER_CHAIN = 20.1168;
export const METRES_PER_YARD = 0.9144;
export const METRES_PER_FOOT = 0.3048;
/** Metres per second in one mph / one km/h. */
export const MPS_PER_MPH = 0.44704;
export const MPS_PER_KMH = 1 / 3.6;

// ---------------------------------------------------------------------------- defaults
/** A block section with no length given: 2 miles. */
export const DEFAULT_SECTION_LENGTH = 2 * METRES_PER_MILE;
/** An ordinary track circuit in a box's area (platform, loop, siding): 220 yards (10 chains, about 200 m). */
export const STATION_CIRCUIT_LENGTH = 220 * METRES_PER_YARD;
/** A short track circuit (points, a neck, a loco release): 55 yards (2½ chains, about 50 m). */
export const SHORT_CIRCUIT_LENGTH = 55 * METRES_PER_YARD;
/** A layout with no line speed given: 60 mph. */
export const DEFAULT_LINE_SPEED = 60 * MPS_PER_MPH;
/** Points with no diverging speed given: 15 mph. */
export const DEFAULT_DIVERGING_SPEED = 15 * MPS_PER_MPH;

export const UNIT_SYSTEMS: ReadonlyArray<{ id: UnitSystem; name: string }> = [
  { id: 'imperial', name: 'Imperial (miles and chains, yards, mph)' },
  { id: 'metric', name: 'Metric (km, m, km/h)' },
];

// ---------------------------------------------------------------------------- track circuits

/** The block section a connection's line runs over, in metres. */
export function sectionLength(conn: ConnectionDef | undefined): number {
  return positive(conn?.sectionLength) ?? DEFAULT_SECTION_LENGTH;
}

/** A plain joint between two circuits is not point-work; every other junction is (points, slips, crossings, catch points, turntables). */
function isPointWork(j: Junction | undefined): boolean {
  return !!j && j.kind !== 'joint';
}

/** Names that say a circuit is a short piece of track: a neck, a throat, a loco release, a crossover, points. */
const SHORT_NAME = /\b(neck|throat|release|crossover|x-?over|points?)\b/i;

/**
 * Is this a SHORT track circuit (55 yards)? The rule, for circuits in a box's area (not a block
 * section's line circuits):
 *  - a road of a place (tied to a place's road) or a platform road is never short: trains stand there;
 *  - otherwise it is short when BOTH its ends join point-work (any junction but a plain joint): the
 *    track between or through points, e.g. a crossover, the piece between two sets of points at a
 *    station throat, or a neck between a turnout and catch points;
 *  - or when its name says it is a neck, throat, (loco) release, crossover or points.
 */
export function isShortCircuit(layout: Layout, c: TrackCircuit): boolean {
  if (c.owner.kind === 'line') return false;
  if (c.platform) return false;
  if (layout.places.some((p) => p.roads.some((r) => r.circuitId === c.id))) return false;
  const junction = (id: string) => layout.trackPlan.junctions.find((j) => j.id === id);
  const bothPoints = c.ends.every((e) => e.kind === 'joined' && isPointWork(junction(e.junctionId)));
  return bothPoints || SHORT_NAME.test(c.name);
}

export type LengthBasis = 'stated' | 'section' | 'short' | 'ordinary';

/** Which running line a line circuit belongs to, for sharing its section's length. */
const lineGroup = (c: TrackCircuit) => c.traffic?.line ?? 'both';

/** The length of a track circuit in metres, and how it was arrived at (see the rule at the top of this file). */
export function circuitLength(state: AppState, layout: Layout, circuitOrId: TrackCircuit | string): { metres: number; basis: LengthBasis } {
  const c = typeof circuitOrId === 'string' ? layout.trackPlan.circuits.find((x) => x.id === circuitOrId) : circuitOrId;
  if (!c) return { metres: STATION_CIRCUIT_LENGTH, basis: 'ordinary' };
  const stated = positive(c.length);
  if (stated !== undefined) return { metres: stated, basis: 'stated' };
  const owner = c.owner;
  if (owner.kind === 'line') {
    const conn = state.boxes.find((b) => b.id === owner.boxId)?.connections.find((x) => x.id === owner.connectionId);
    const siblings = layout.trackPlan.circuits.filter(
      (x) => x.owner.kind === 'line' && x.owner.boxId === owner.boxId && x.owner.connectionId === owner.connectionId && lineGroup(x) === lineGroup(c),
    );
    const statedTotal = siblings.reduce((sum, x) => sum + (positive(x.length) ?? 0), 0);
    const sharing = siblings.filter((x) => positive(x.length) === undefined).length || 1;
    return { metres: Math.max(SHORT_CIRCUIT_LENGTH, (sectionLength(conn) - statedTotal) / sharing), basis: 'section' };
  }
  return isShortCircuit(layout, c) ? { metres: SHORT_CIRCUIT_LENGTH, basis: 'short' } : { metres: STATION_CIRCUIT_LENGTH, basis: 'ordinary' };
}

// ---------------------------------------------------------------------------- speeds

/** The layout's line speed in metres per second. */
export function layoutLineSpeed(layout: Layout | undefined): number {
  return positive(layout?.lineSpeed) ?? DEFAULT_LINE_SPEED;
}

/** A track circuit's line speed (its own, else the layout's), in metres per second. */
export function circuitLineSpeed(layout: Layout, c: TrackCircuit): number {
  return positive(c.lineSpeed) ?? layoutLineSpeed(layout);
}

/** The speed over a set of points' diverging road, in metres per second. */
export function divergingSpeed(j: Junction): number {
  return positive(j.divergingSpeed) ?? DEFAULT_DIVERGING_SPEED;
}

/** A loco's maximum speed in metres per second, or null when it has no limit of its own. */
export function locoMaxSpeed(l: Loco): number | null {
  return positive(l.maxSpeed) ?? null;
}

/** A track circuit's effective length and line speed (metres, metres per second). */
export function circuitRunning(state: AppState, layout: Layout, c: TrackCircuit): { metres: number; basis: LengthBasis; speed: number } {
  return { ...circuitLength(state, layout, c), speed: circuitLineSpeed(layout, c) };
}

// ---------------------------------------------------------------------------- train lengths

/** Rough lengths over buffers (metres) for working out a train's length from its consist. */
const VEHICLES: Array<{ re: RegExp; metres: number; kind: string }> = [
  { re: /^auto[- ]?(coach|trailer)s?$/, metres: 19, kind: 'auto-coach' },
  { re: /^(brake ?vans?|guards? vans?)$/, metres: 8, kind: 'brake van' },
  { re: /^(coach(es)?|carriages?|trailers?|corridors?|non-corridors?)$/, metres: 20, kind: 'coach' },
  { re: /^(cars?)$/, metres: 20, kind: 'car' },
  { re: /^(vans?|parcels? vans?|bogie vans?)$/, metres: 17, kind: 'van' },
  { re: /^(wagons?|trucks?|tankers?|tanks?|hoppers?|opens?|minerals?|vehicles?|flats?|bolsters?)$/, metres: 6, kind: 'wagon' },
];
/** How many there usually are when a consist names them in the plural with no number ("Coal wagons", "Vans"). */
const TYPICAL: Record<string, number> = { coach: 4, car: 2, van: 6, wagon: 12, 'auto-coach': 1, 'brake van': 1 };
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** The vehicles a consist names, e.g. "4 coaches + brake van" → 4 coach, 1 brake van. Words it does not know are left out. */
export function consistVehicles(consist: string): Array<{ count: number; kind: string; metres: number }> {
  const out: Array<{ count: number; kind: string; metres: number }> = [];
  for (const raw of consist.toLowerCase().split(/,|\+|&|\band\b|\bwith\b|;/)) {
    const part = raw.trim().replace(/\s+/g, ' ');
    if (!part) continue;
    // "4 coaches", "4-coach", "six wagons", "a brake van", "brake van", "2-car"
    const m = /^(\d+|[a-z]+)?[ -]?(.*)$/.exec(part);
    if (!m) continue;
    let count: number | null = null;
    let rest = part;
    if (m[1] && /^\d+$/.test(m[1])) {
      count = Number(m[1]);
      rest = m[2];
    } else if (m[1] && WORDS[m[1]] !== undefined) {
      count = WORDS[m[1]];
      rest = m[2];
    }
    // Find the longest run of words that names a vehicle, anywhere ("coaches" in "coaches (corridor)",
    // "wagons" in "coal wagons").
    const words = rest.trim().split(/[ -]/).map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean);
    let found: { v: (typeof VEHICLES)[number]; plural: boolean } | null = null;
    for (let n = words.length; n > 0 && !found; n--)
      for (let i = 0; i + n <= words.length && !found; i++) {
        const name = words.slice(i, i + n).join(' ');
        const v = VEHICLES.find((x) => x.re.test(name));
        if (v) found = { v, plural: /s$/.test(words[i + n - 1]) && !/^(brake ?vans?|guards? vans?)$/.test(name) ? /s$/.test(name) : false };
      }
    if (!found) continue;
    // No number given: one of a thing named in the singular, a typical rake of a thing named in the plural.
    const n = count ?? (found.plural ? (TYPICAL[found.v.kind] ?? 4) : 1);
    if (n > 0) out.push({ count: Math.min(n, 200), kind: found.v.kind, metres: found.v.metres });
  }
  return out;
}

/** Is this loco a multiple unit / railcar (its consist counts cars, itself included)? */
const isUnit = (l: Loco) => /\b(dmu|emu|railcar|multiple unit|unit)\b/i.test(l.powerType);

/** A loco's own length over buffers (metres), roughly, from its power type. */
export function locoLength(l: Loco): number {
  const p = l.powerType.toLowerCase();
  if (isUnit(l)) return 20;
  if (/tank/.test(p)) return 11;
  if (/steam|tender/.test(p)) return 20;
  if (/diesel|electric/.test(p)) return 17;
  return 18;
}

/**
 * The length of the train a loco is working, in metres: the working's stated length, else the loco
 * plus the vehicles its consist names (for a multiple unit, "2-car" means two cars in all).
 */
export function trainLength(l: Loco): number {
  const stated = positive(l.working.length);
  if (stated !== undefined) return stated;
  const vehicles = workingVehicles(l.working);
  if (isUnit(l)) {
    const cars = vehicles.filter((v) => v.kind === 'car').reduce((n, v) => n + v.count, 0);
    const others = vehicles.filter((v) => v.kind !== 'car').reduce((m, v) => m + v.count * v.metres, 0);
    return Math.max(1, cars) * 20 + others;
  }
  return locoLength(l) + vehicles.reduce((m, v) => m + v.count * v.metres, 0);
}

/**
 * The vehicles a loco is working with: its consist's, except that a light engine has none (whatever
 * its consist still says) and an engine and brake van has its brake van. Multiple units count their cars.
 */
export function workingVehicles(w: Working): Array<{ count: number; kind: string; metres: number }> {
  if (w.trainTypeId === 'light_engine') return [];
  const vehicles = consistVehicles(w.consist ?? '');
  if (w.trainTypeId === 'engine_brake_van') {
    const vans = vehicles.filter((v) => v.kind === 'brake van');
    return vans.length ? vans : [{ count: 1, kind: 'brake van', metres: 8 }];
  }
  return vehicles;
}

/** A short description of some vehicles: "4 coach, 1 brake van" → "4 coaches + brake van". */
export function vehiclesText(vehicles: Array<{ count: number; kind: string }>): string {
  const plural = (k: string, n: number) => (n === 1 ? k : k === 'coach' ? 'coaches' : `${k}s`);
  return vehicles.map((v) => (v.count === 1 ? `${/^[aeiou]/.test(v.kind) ? 'an' : 'a'} ${v.kind}` : `${v.count} ${plural(v.kind, v.count)}`)).join(' + ');
}

// ---------------------------------------------------------------------------- typing and showing values

const LENGTH_UNITS: Array<{ re: RegExp; unit: 'mi' | 'ch' | 'yd' | 'ft' | 'm' | 'km' }> = [
  { re: /^(mi|mile|miles|mls?)$/, unit: 'mi' },
  { re: /^(ch|chs|chain|chains)$/, unit: 'ch' },
  { re: /^(yd|yds|yard|yards)$/, unit: 'yd' },
  { re: /^(ft|foot|feet|')$/, unit: 'ft' },
  { re: /^(m|metre|metres|meter|meters)$/, unit: 'm' },
  { re: /^(km|kms|kilometre|kilometres|kilometer|kilometers)$/, unit: 'km' },
];
const METRES: Record<'mi' | 'ch' | 'yd' | 'ft' | 'm' | 'km', number> = { mi: METRES_PER_MILE, ch: METRES_PER_CHAIN, yd: METRES_PER_YARD, ft: METRES_PER_FOOT, m: 1, km: 1000 };

/** "2½", "2 1/2", "1.25", "¾" → a number, else NaN. */
function parseNumber(s: string): number {
  const t = s.trim().replace(/½/g, ' 1/2').replace(/¼/g, ' 1/4').replace(/¾/g, ' 3/4').trim();
  let m = /^(\d+(?:\.\d+)?)$/.exec(t) ?? /^(\.\d+)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[1]) / Number(m[2]);
  return NaN;
}

/**
 * A length typed in either system, in metres; null if it cannot be read (or is not more than zero).
 * Accepts "2 mi 40 ch", "2 miles 40 chains", "10 ch", "2½ ch", "220 yd", "200 m", "1.2 km", "660 ft",
 * and railway mileage "12m 40ch" (with chains, "m" means miles). A number on its own is in `bare`.
 */
export function parseLength(text: string, bare: 'mi' | 'ch' | 'yd' | 'm' | 'km' = 'm'): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, '');
  if (!t) return null;
  // Number-and-unit parts, which must make up the whole text ("2 mi 40 ch", "2½ ch", "1.2 km").
  const part = /\s*(\d+\/\d+|\d+(?:\.\d+)?(?:\s+\d+\/\d+|[½¼¾])?|\.\d+|[½¼¾])\s*([a-z']+)?\.?\s*/y;
  const parts: RegExpExecArray[] = [];
  for (let i = 0; i < t.length; ) {
    part.lastIndex = i;
    const m = part.exec(t);
    if (!m || !m[0].length) return null;
    parts.push(m);
    i = part.lastIndex;
  }
  const hasChains = parts.some((p) => p[2] && /^ch/.test(p[2]));
  let metres = 0;
  for (const p of parts) {
    const n = parseNumber(p[1]);
    if (!Number.isFinite(n)) return null;
    let unit: keyof typeof METRES;
    if (!p[2]) {
      if (parts.length > 1) return null;
      unit = bare;
    } else if (p[2] === 'm' && hasChains) unit = 'mi';
    else {
      const u = LENGTH_UNITS.find((x) => x.re.test(p[2]!));
      if (!u) return null;
      unit = u.unit;
    }
    metres += n * METRES[unit];
  }
  return metres > 0 && Number.isFinite(metres) ? metres : null;
}

/** A speed typed in either system, in metres per second: "25 mph", "40 km/h", "40 kph", "11 m/s"; a number on its own is in `bare`. */
export function parseSpeed(text: string, bare: 'mph' | 'km/h' = 'mph'): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*(mph|mi\/h|miles per hour|km\/h|km\/hr|kmh|kph|kmph|m\/s)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? bare;
  const mps = /^(mph|mi\/h|miles per hour)$/.test(unit) ? n * MPS_PER_MPH : unit === 'm/s' ? n : n * MPS_PER_KMH;
  return mps > 0 ? mps : null;
}

/**
 * A length for showing. `scale`: 'section' for block sections (imperial: miles and chains,
 * "2 mi 40 ch"; metric: km, or m under 1 km), 'station' for track circuits in a box's area
 * (imperial: yards; metric: metres).
 */
export function formatLength(metres: number, units: UnitSystem, scale: 'section' | 'station' = 'station'): string {
  if (units === 'metric') {
    if (scale === 'section' && metres >= 1000) return `${trim((metres / 1000).toFixed(2))} km`;
    return `${Math.round(metres)} m`;
  }
  if (scale === 'station') return `${Math.round(metres / METRES_PER_YARD)} yd`;
  const chains = Math.round(metres / METRES_PER_CHAIN);
  const mi = Math.floor(chains / 80);
  const ch = chains % 80;
  if (!mi) return `${ch} ch`;
  return ch ? `${mi} mi ${ch} ch` : `${mi} mi`;
}

/** A speed for showing: "60 mph" or "97 km/h". */
export function formatSpeed(mps: number, units: UnitSystem): string {
  return units === 'metric' ? `${Math.round(mps / MPS_PER_KMH)} km/h` : `${Math.round(mps / MPS_PER_MPH)} mph`;
}

const trim = (s: string) => s.replace(/\.?0+$/, '');

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------- saved data

/** Remove real-railway values that are not usable (not a number, zero or less) so the defaults apply; fix the units setting. */
export function sanitiseRailwayData(state: AppState): void {
  const clean = <T extends object>(o: T, key: keyof T) => {
    if (o[key] !== undefined && positive(o[key]) === undefined) delete o[key];
  };
  if (state.settings.units !== 'metric') state.settings.units = 'imperial';
  const st = state.settings;
  if (positive(st.simSpeed) === undefined) st.simSpeed = 30 * MPS_PER_MPH;
  st.timeScale = Number.isFinite(st.timeScale) ? Math.min(10, Math.max(1, Math.round(st.timeScale))) : 1;
  st.modelOccupancy = st.modelOccupancy === true;
  for (const b of state.boxes) for (const c of b.connections) clean(c, 'sectionLength');
  for (const l of state.layouts) {
    clean(l, 'lineSpeed');
    for (const c of l.trackPlan.circuits) {
      clean(c, 'length');
      clean(c, 'lineSpeed');
    }
    for (const j of l.trackPlan.junctions) clean(j, 'divergingSpeed');
    // Rakes left standing (v0.3.28): keep those on a road of this layout, with sensible vehicles.
    if (l.stock !== undefined) {
      const roads = new Set(l.places.flatMap((p) => p.roads.map((r) => `${p.id}|${r.id}`)));
      l.stock = (Array.isArray(l.stock) ? l.stock : []).filter(
        (r) => r && typeof r.id === 'string' && Array.isArray(r.vehicles) && roads.has(`${r.placeId}|${r.roadId}`),
      );
      for (const r of l.stock) {
        r.description = String(r.description ?? '');
        r.vehicles = r.vehicles.filter((v) => v && typeof v.kind === 'string' && positive(v.count) !== undefined && positive(v.metres) !== undefined);
        r.circuitId = l.places.find((p) => p.id === r.placeId)?.roads.find((x) => x.id === r.roadId)?.circuitId ?? '';
      }
      if (!l.stock.length) delete l.stock;
    }
  }
  for (const l of state.roster) {
    clean(l, 'maxSpeed');
    if (l.working) clean(l.working, 'length');
  }
}
