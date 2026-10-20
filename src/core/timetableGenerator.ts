// THE TIMETABLE GENERATOR (v0.3.26). Builds a timetable for a layout from what it knows: the
// layout's places and roads, the signal boxes that work them and the lines between, and the locos
// on the roster with their target jobs (the kinds of train they work, between which places, and how
// often). Used two ways:
//   - Generate: a whole timetable at once, saved like any other and editable afterwards.
//   - Endless: the runner asks for a little more at a time while a session runs (see extend()).
//
// It works through the session minute by minute, as a controller would: every so often (the
// busyness) it picks a free loco and one of its jobs, weighted by how often the loco gets that job
// and by the traffic mix, and plans a chain of moves for it:
//   - a through run from one fiddle yard to another, passing or calling at the stations between;
//   - a train into a station or goods yard that turns round: passenger engines are released (to a
//     siding the same box works, or by running round) and work their coaches back; goods trains
//     shunt the yard and go back (with the empties);
//   - a pilot's shunt between the places it works;
//   - first, when needed, a light engine move to where the job starts, or a move on to the layout.
// Every road holds one train at a time, and a single line one train at a time, so a timed
// timetable never sends two trains at each other. At the end, locos go home (or to a fiddle yard).
// The result walks through the editor's checks with no problems.

import { HeadcodeAllocator, destinationOf, eraOf } from './headcodes';
import { routeBetween, type RouteLeg, type TtPos } from './timetables';
import type { AppState, Busyness, GeneratorOptions, Layout, Loco, LocoJob, Place, PlaceRef, Timetable, TimetableCall, TimetableEntry, TimetableTrain } from './types';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type MixCategory = 'passenger' | 'goods' | 'shunting';

export const MIX_PRESETS: Array<{ id: string; name: string; mix: GeneratorOptions['mix'] }> = [
  { id: 'balanced', name: 'A bit of everything', mix: { passenger: 2, goods: 2, shunting: 2 } },
  { id: 'passenger', name: 'Busy passenger', mix: { passenger: 3, goods: 1, shunting: 1 } },
  { id: 'goods', name: 'Mostly goods', mix: { passenger: 1, goods: 3, shunting: 2 } },
  { id: 'shunting', name: 'Plenty of shunting', mix: { passenger: 1, goods: 2, shunting: 3 } },
  { id: 'passengerOnly', name: 'Passenger only', mix: { passenger: 3, goods: 0, shunting: 0 } },
];

export const MIX_LEVELS = ['None', 'A little', 'Normal', 'Lots'];

export const BUSYNESS: Array<{ id: Busyness; name: string; gap: number; help: string }> = [
  { id: 'quiet', name: 'Quiet', gap: 15, help: 'A train about every quarter of an hour.' },
  { id: 'steady', name: 'Steady', gap: 8, help: 'A train every eight minutes or so.' },
  { id: 'busy', name: 'Busy', gap: 4, help: 'Something on the move most of the time.' },
];

/** Coaching stock trains: counted as passenger traffic in the mix. */
const COACHING = new Set(['express_passenger', 'ordinary_passenger', 'branch_passenger', 'railcar', 'parcels', 'ecs']);
const STOPPING = new Set(['ordinary_passenger', 'branch_passenger', 'railcar', 'pickup_goods', 'branch_freight']);

export function jobCategory(j: Pick<LocoJob, 'kind' | 'trainTypeId'>): MixCategory {
  if (j.kind === 'pilot' || j.trainTypeId === 'light_engine' || j.trainTypeId === 'engine_brake_van') return 'shunting';
  return COACHING.has(j.trainTypeId) ? 'passenger' : 'goods';
}

/** Whether a loco is on this layout (in one of its places, at or between its boxes). */
export function onLayout(state: AppState, layout: Layout, l: Loco): boolean {
  const loc = l.location;
  if (loc.kind === 'place') return layout.places.some((p) => p.id === loc.placeId);
  if (loc.kind === 'atBox') return state.boxes.some((b) => b.id === loc.boxId && b.layoutId === layout.id);
  if (loc.kind === 'section') return state.boxes.some((b) => b.layoutId === layout.id && b.connections.some((c) => c.id === loc.connectionId));
  return false;
}

/** The locos taking part by default: those on the layout with timetable jobs. */
export function defaultLocos(state: AppState, layout: Layout): Loco[] {
  return state.roster.filter((l) => onLayout(state, layout, l) && l.jobs?.length);
}

export function defaultGeneratorOptions(timing: GeneratorOptions['timing'] = 'sequence'): GeneratorOptions {
  return {
    timing,
    startAt: 9 * 60,
    speed: 1,
    length: timing === 'sequence' ? 24 : 120,
    busyness: 'steady',
    locoIds: [],
    mix: { ...MIX_PRESETS[0].mix },
    seed: newSeed(),
  };
}

export const newSeed = () => Math.floor(Math.random() * 1_000_000) + 1;

/** A small fast seeded random number generator (mulberry32): the same seed gives the same timetable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The world as the generator plans it
// ---------------------------------------------------------------------------

const LINE_MIN = 6; // minutes along a line between boxes
const LOCAL_MIN = 3; // a move within a box's area
const STOP_MIN = 1; // standing at a station it calls at
const INF = Number.POSITIVE_INFINITY;

interface Interval {
  from: number;
  to: number;
  owner: string;
}

interface Unit {
  loco: Loco;
  jobs: LocoJob[];
  home: string;
  pos: TtPos;
  freeAt: number;
  /** The road it stands on (its hold ends when it leaves). */
  hold: Interval | null;
  holdKey: string;
  /** Chains given so far (spreads the work). */
  chains: number;
}

/** One move as planned, with the roads and lines it uses. */
interface Move {
  kind: TimetableEntry['kind'];
  trainTypeId: string;
  from: PlaceRef;
  to: PlaceRef;
  dep: number;
  arr: number;
  calls: TimetableCall[];
  notes: string;
}

interface Draft {
  moves: Move[];
  roads: Array<{ key: string; iv: Interval }>;
  lines: Array<{ key: string; iv: Interval }>;
  /** Where the unit ends, the road it holds there, and when it is free again. */
  end: TtPos;
  endKey: string;
  endHold: Interval | null;
  freeAt: number;
  name: string;
  notes: string;
  /** The working of the chain (for the train's "any loco" kind and naming). */
  working: string;
}

/** A line or road is booked until `until`: try the chain again from then. */
class Conflict {
  constructor(readonly until: number) {}
}

/** The way is blocked with no end in sight (every road through a station is taken for good). */
class Blocked {}

const roadKey = (r: PlaceRef) => `${r.placeId}|${r.roadId}`;

/** Short train names by working, e.g. "Express 2". */
const TRAIN_NAMES: Record<string, string> = {
  express_passenger: 'Express',
  ordinary_passenger: 'Stopping train',
  branch_passenger: 'Branch train',
  railcar: 'Railcar',
  parcels: 'Parcels',
  ecs: 'Empty stock',
  freight_fitted_half: 'Express goods',
  freight_fitted_third: 'Express goods',
  freight_fitted_four: 'Express goods',
  freight_unfitted: 'Express goods',
  through_freight: 'Through goods',
  mineral: 'Mineral',
  pickup_goods: 'Pick-up goods',
  branch_freight: 'Branch goods',
  light_engine: 'Light engine',
  engine_brake_van: 'Engine and van',
};

export interface GenerateResult {
  tt: Timetable;
  /** Things worth telling the user (locos with nothing to do, jobs with no route…). */
  notes: string[];
}

/**
 * The generator itself. `generateTimetable` uses it once; Endless keeps one and calls extend() as the
 * session runs.
 */
export class TimetableGenerator {
  readonly rng: () => number;
  readonly units: Unit[] = [];
  readonly trains: TimetableTrain[] = [];
  /** Moves planned so far, with the train they belong to, in the order they were planned. */
  readonly planned: Array<{ move: Move; trainId: string; unit: string; seq: number }> = [];
  readonly notes: string[] = [];
  /** When the next chain may start (minutes on the timetable's clock). */
  now: number;
  /** When the last chain started. */
  lastStart: number;
  private roads = new Map<string, Interval[]>();
  private lines = new Map<string, Interval[]>();
  private names = new Map<string, number>();
  private seq = 0;
  private trainNo = 0;
  readonly t0: number;
  private gap: number;
  private placeMap: Map<string, Place>;

  constructor(
    readonly state: AppState,
    readonly layout: Layout,
    readonly opts: GeneratorOptions,
    /** Where some locos will be, and from when, instead of where the roster has them (Endless, switching to it while moves finish). */
    start?: Map<string, { pos: TtPos; freeAt: number }>,
  ) {
    this.rng = mulberry32(opts.seed || 1);
    this.t0 = opts.timing === 'sequence' ? 0 : opts.startAt;
    this.now = this.t0;
    this.lastStart = this.t0 - 1;
    this.gap = BUSYNESS.find((b) => b.id === opts.busyness)?.gap ?? 8;
    this.placeMap = new Map(layout.places.map((p) => [p.id, p]));
    const chosen = opts.locoIds.length ? state.roster.filter((l) => opts.locoIds.includes(l.id)) : defaultLocos(state, layout);
    for (const loco of chosen) this.addUnit(loco, start?.get(loco.id));
    if (!this.units.length) this.notes.push('No locos are taking part: give some locos on the layout timetable jobs in the roster, or choose locos.');
  }

  private addUnit(loco: Loco, at?: { pos: TtPos; freeAt: number }): void {
    const jobs: LocoJob[] = (loco.jobs?.length ? loco.jobs : [{ id: 'job-now', kind: 'working', trainTypeId: loco.working.trainTypeId, placeIds: [], weight: 2 } as LocoJob])
      // Jobs between places on other layouts are not for this one.
      .filter((j) => !j.placeIds.length || j.placeIds.some((id) => this.placeMap.has(id)))
      .map((j) => ({ ...j, placeIds: j.placeIds.filter((id) => this.placeMap.has(id)) }))
      .filter((j) => this.mixWeight(j) > 0);
    let pos: TtPos = { kind: 'off' };
    const loc = loco.location;
    if (loc.kind === 'place' && this.placeMap.has(loc.placeId)) pos = { kind: 'place', placeId: loc.placeId, roadId: loc.roadId };
    if (at && (at.pos.kind === 'off' || this.placeMap.has(at.pos.placeId))) pos = at.pos;
    // A loco at a box or in a section is treated as off the layout (it comes on when first needed).
    const home = loco.homePlaceId && this.placeMap.has(loco.homePlaceId) ? loco.homePlaceId : pos.kind === 'place' ? pos.placeId : '';
    const u: Unit = { loco, jobs, home, pos, freeAt: Math.max(this.t0, at?.freeAt ?? this.t0), hold: null, holdKey: '', chains: 0 };
    if (!jobs.length) {
      this.notes.push(`${locoLabel(loco)} has no jobs in the traffic mix chosen, so it stays where it is.`);
      return;
    }
    if (pos.kind === 'place') {
      // Give a loco standing "somewhere in" a place a road of its own.
      if (!pos.roadId) {
        const p = this.placeMap.get(pos.placeId)!;
        const free = p.roads.find((r) => this.roadFree(roadKey({ placeId: p.id, roadId: r.id }), -INF, INF, ''));
        if (free) pos = { ...pos, roadId: free.id };
        u.pos = pos;
      }
      if (pos.roadId) {
        const key = roadKey(pos);
        if (!this.roadFree(key, -INF, INF, '')) {
          this.notes.push(`${locoLabel(loco)} stands on a road another loco taking part is already on (${this.placeName(pos.placeId)}), so it is left out.`);
          return;
        }
        u.hold = { from: -INF, to: INF, owner: loco.id };
        u.holdKey = key;
        this.addIv(this.roads, key, u.hold);
      }
    }
    this.units.push(u);
  }

  private placeName(id: string): string {
    return this.placeMap.get(id)?.name ?? 'a place';
  }

  private mixWeight(j: Pick<LocoJob, 'kind' | 'trainTypeId'>): number {
    return this.opts.mix[jobCategory(j)] ?? 0;
  }

  // ------------------------------------------------------------------ intervals

  private addIv(map: Map<string, Interval[]>, key: string, iv: Interval): void {
    (map.get(key) ?? map.set(key, []).get(key)!).push(iv);
  }

  private clash(list: Interval[] | undefined, from: number, to: number, owner: string): Interval | null {
    for (const iv of list ?? []) if (iv.owner !== owner && iv.from < to && from < iv.to) return iv;
    return null;
  }

  private roadFree(key: string, from: number, to: number, owner: string, draft?: Draft): boolean {
    if (key.endsWith('|')) return true; // a place with no roads: no limit
    if (this.clash(this.roads.get(key), from, to, owner)) return false;
    return !draft?.roads.some((r) => r.key === key && r.iv.owner !== owner && r.iv.from < to && from < r.iv.to);
  }

  /** The key a line is booked under: a single line both ways, a double line each way. */
  private lineKey(leg: Extract<RouteLeg, { kind: 'line' }>): string {
    const c = this.state.boxes.find((b) => b.id === leg.boxId)?.connections.find((x) => x.id === leg.connectionId);
    return c?.lineType === 'double' ? `${leg.connectionId}|${leg.dir}` : `${leg.connectionId}|both`;
  }

  // ------------------------------------------------------------------ places

  private isYard = (id: string) => this.placeMap.get(id)?.kind === 'fiddleYard';
  private yards = () => this.layout.places.filter((p) => p.kind === 'fiddleYard');

  /** The boxes a place is worked by (boxes you work). */
  private boxesOf(id: string): string[] {
    return (this.placeMap.get(id)?.workedBy ?? []).filter((w) => w.kind === 'box').map((w) => w.boxId);
  }

  /** A free road at a place for a stay from `from` to `to` (Infinity: stays put), or null. '' for a place without roads. */
  private freeRoad(placeId: string, from: number, to: number, owner: string, draft: Draft, prefer = ''): string | null {
    const p = this.placeMap.get(placeId);
    if (!p) return null;
    if (!p.roads.length) return '';
    const roads = [...p.roads];
    // Prefer the road asked for, else shuffle a little so trains do not all use road 1.
    roads.sort((a, b) => (a.id === prefer ? -1 : b.id === prefer ? 1 : 0));
    if (!prefer && this.rng() < 0.5) roads.reverse();
    for (const r of roads) if (this.roadFree(roadKey({ placeId, roadId: r.id }), from, to, owner, draft)) return r.id;
    return null;
  }

  // ------------------------------------------------------------------ planning moves

  /** Minutes a route takes, and the lines it books, from `dep`. Calls are the places it passes or stops at. */
  private timeRoute(legs: RouteLeg[], dep: number, stopping: boolean, draft: Draft, owner: string): { arr: number; calls: TimetableCall[] } {
    let t = dep;
    const calls: TimetableCall[] = [];
    if (legs.length === 1 && legs[0].kind === 'local') return { arr: t + LOCAL_MIN, calls };
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (l.kind === 'local') {
        t += 1;
        continue;
      }
      const key = this.lineKey(l);
      const from = t;
      const to = t + LINE_MIN;
      const c = this.clash(this.lines.get(key), from, to, owner) ?? draft.lines.find((x) => x.key === key && x.iv.owner !== owner && x.iv.from < to && from < x.iv.to)?.iv ?? null;
      if (c) throw new Conflict(c.to);
      draft.lines.push({ key, iv: { from, to, owner } });
      t = to;
      // Through a box: in on one line, out on the next. It passes (or calls at) the box's station.
      const next = legs[i + 1];
      if (l.dir === 'in' && next?.kind === 'line' && next.dir === 'out' && next.boxId === l.boxId) {
        const station = this.layout.places.find((p) => p.kind === 'station' && p.workedBy.some((w) => w.kind === 'box' && w.boxId === l.boxId));
        if (station) {
          // It needs a road through the station (a platform or the loop) while it passes or calls.
          const a = t - LINE_MIN;
          const b = t + STOP_MIN + (stopping ? STOP_MIN : 0);
          if (station.roads.length) {
            const road = station.roads.find((r) => this.roadFree(roadKey({ placeId: station.id, roadId: r.id }), a, b, owner, draft));
            if (!road) {
              // Every road is taken: try again once the first of them is free (or give up if none will be).
              let until = INF;
              for (const r of station.roads) {
                const k = roadKey({ placeId: station.id, roadId: r.id });
                const ends = [...(this.roads.get(k) ?? []), ...draft.roads.filter((x) => x.key === k).map((x) => x.iv)].filter((iv) => iv.owner !== owner && iv.from < b && a < iv.to).map((iv) => iv.to);
                until = Math.min(until, Math.max(...ends));
              }
              if (!Number.isFinite(until)) throw new Blocked();
              throw new Conflict(until - (t - dep) + LINE_MIN);
            }
            draft.roads.push({ key: roadKey({ placeId: station.id, roadId: road.id }), iv: { from: a, to: b, owner } });
          }
          calls.push({ placeId: station.id, roadId: '', stop: stopping, arr: stopping ? t : null, dep: t + (stopping ? STOP_MIN : 0) });
          if (stopping) t += STOP_MIN;
        }
      }
    }
    return { arr: t, calls };
  }

  /** Plan one move of the draft: from where the unit is (in the draft) to a place, choosing a road. */
  private move(draft: Draft, u: Unit, kind: Move['kind'], trainTypeId: string, toPlace: string, dep: number, stayUntil: number, notes = '', preferRoad = ''): Move | null {
    const from = draft.end;
    if (from.kind !== 'place') return null;
    const legs = from.placeId === toPlace ? [] : routeBetween(this.state, this.layout, from.placeId, toPlace);
    if (!legs) return null;
    const signalled = legs.some((l) => l.kind === 'line');
    if (kind === 'shunt' && signalled) kind = 'run';
    if (kind === 'run' && !signalled && legs.length) kind = 'shunt';
    let timed: { arr: number; calls: TimetableCall[] };
    try {
      timed = legs.length ? this.timeRoute(legs, dep, STOPPING.has(trainTypeId), draft, u.loco.id) : { arr: dep + LOCAL_MIN + 2, calls: [] };
    } catch (e) {
      if (e instanceof Blocked) return null;
      throw e;
    }
    const { arr, calls } = timed;
    const sameRoad = from.placeId === toPlace && !legs.length;
    // A road is booked from when the train sets off for it, so that in the timetable's order nobody
    // is still standing on it when the move comes up.
    const roadId = sameRoad ? from.roadId : this.freeRoad(toPlace, dep - 0.5, stayUntil, u.loco.id, draft, preferRoad);
    if (roadId === null) return null;
    const to: PlaceRef = { placeId: toPlace, roadId };
    // Leaving the road it stood on (unless the coaches stay: the caller keeps that hold).
    if (draft.endHold) draft.endHold.to = Math.min(draft.endHold.to, dep);
    const hold: Interval = { from: dep - 0.5, to: stayUntil, owner: u.loco.id };
    if (!sameRoad) draft.roads.push({ key: roadKey(to), iv: hold });
    const m: Move = { kind, trainTypeId, from: { placeId: from.placeId, roadId: from.roadId }, to, dep, arr, calls, notes };
    draft.moves.push(m);
    draft.end = { kind: 'place', placeId: toPlace, roadId };
    draft.endKey = roadKey(to);
    draft.endHold = sameRoad ? draft.endHold : hold;
    if (sameRoad && draft.endHold) draft.endHold.to = stayUntil;
    draft.freeAt = arr;
    return m;
  }

  /** The nearest place (fewest stages) among `ids` from `from`, with a route. */
  private nearest(from: string, ids: string[]): string | null {
    let best: string | null = null;
    let bestLen = INF;
    for (const id of ids) {
      if (id === from) return id;
      const legs = routeBetween(this.state, this.layout, from, id);
      if (legs && legs.length < bestLen) {
        best = id;
        bestLen = legs.length;
      }
    }
    return best;
  }

  private pick<T>(list: T[]): T | undefined {
    return list.length ? list[Math.floor(this.rng() * list.length)] : undefined;
  }

  /** Where a job can go: its places, else every fiddle yard and the places that suit the work. */
  private jobPlaces(j: LocoJob): string[] {
    if (j.placeIds.length) return j.placeIds;
    const cat = jobCategory(j);
    return this.layout.places
      .filter((p) => (cat === 'passenger' ? p.kind === 'fiddleYard' || p.kind === 'station' : cat === 'goods' ? p.kind === 'fiddleYard' || p.kind === 'goods' || p.kind === 'sidings' : p.kind !== 'fiddleYard'))
      .map((p) => p.id);
  }

  /** Remember a draft as it is, to go back to if a try does not work out. */
  private snap(d: Draft) {
    return { m: d.moves.length, r: d.roads.length, l: d.lines.length, end: d.end, endKey: d.endKey, endHold: d.endHold, holdTo: d.endHold?.to ?? 0, freeAt: d.freeAt, notes: d.notes };
  }

  private restore(d: Draft, s: ReturnType<TimetableGenerator['snap']>): void {
    d.moves.length = s.m;
    d.roads.length = s.r;
    d.lines.length = s.l;
    d.end = s.end;
    d.endKey = s.endKey;
    d.endHold = s.endHold;
    if (s.endHold) s.endHold.to = s.holdTo;
    d.freeAt = s.freeAt;
    d.notes = s.notes;
  }

  private newDraft(u: Unit, working: string): Draft {
    // The hold on the road it stands on is the real one: a draft that is thrown away puts it back (planWithRetry).
    return { moves: [], roads: [], lines: [], end: u.pos, endKey: u.holdKey, endHold: u.hold, freeAt: u.freeAt, name: '', notes: '', working };
  }

  /**
   * Plan a chain for a loco and one of its jobs, starting at `t`. Null when the job cannot be worked
   * from here (no route, no free road); throws Conflict when a line is booked (try later).
   */
  private planChain(u: Unit, j: LocoJob, t: number): Draft | null {
    const draft = this.newDraft(u, j.kind === 'pilot' ? 'light_engine' : j.trainTypeId);
    const places = this.jobPlaces(j).filter((id) => this.placeMap.has(id));
    if (!places.length) return null;
    // On to the layout first, into a fiddle yard.
    if (draft.end.kind === 'off') {
      const yards = places.filter(this.isYard).concat(this.yards().map((p) => p.id));
      const yard = yards[0];
      if (!yard) return null;
      const roadId = this.freeRoad(yard, t - 0.5, INF, u.loco.id, draft);
      if (roadId === null) return null;
      const to = { placeId: yard, roadId };
      const hold = { from: t - 0.5, to: INF, owner: u.loco.id };
      draft.roads.push({ key: roadKey(to), iv: hold });
      draft.moves.push({ kind: 'enter', trainTypeId: j.kind === 'pilot' ? 'light_engine' : j.trainTypeId, from: { placeId: '', roadId: '' }, to, dep: t, arr: t + 2, calls: [], notes: 'Comes on to the layout from storage.' });
      draft.end = { kind: 'place', ...to };
      draft.endKey = roadKey(to);
      draft.endHold = hold;
      t += 4;
    }
    const here = () => (draft.end as { placeId: string }).placeId;
    // Positioning: a light engine to where the job starts.
    if (!places.includes(here())) {
      const target = this.nearest(here(), places);
      if (!target) return null;
      const m = this.move(draft, u, 'run', 'light_engine', target, t, INF, `Light engine to ${this.placeName(target)} for its next job.`);
      if (!m) return null;
      t = m.arr + 3;
    }
    if (j.kind === 'pilot') return this.pilotChain(u, draft, places, t);
    return this.workingChain(u, j, draft, places, t);
  }

  private pilotChain(u: Unit, draft: Draft, places: string[], t: number): Draft | null {
    const p = (draft.end as { placeId: string }).placeId;
    // Another place it works that it can reach without block signalling.
    const others = places.filter((id) => id !== p && (routeBetween(this.state, this.layout, p, id) ?? [{ kind: 'line' }]).every((l) => l.kind === 'local'));
    const q = this.pick(others);
    const dwell = 6 + Math.floor(this.rng() * 6);
    draft.name = 'Pilot';
    if (q) {
      const m1 = this.move(draft, u, 'shunt', 'light_engine', q, t, INF, `Pilot: shunts ${this.placeName(q)}.`);
      if (m1) {
        draft.notes = `Pilot moves between ${this.placeName(p)} and ${this.placeName(q)}.`;
        if (this.placeMap.get(q)?.kind === 'station' || this.rng() < 0.6) {
          const m2 = this.move(draft, u, 'shunt', 'light_engine', p, m1.arr + dwell, INF, `Pilot: back to ${this.placeName(p)}.`);
          if (!m2) draft.freeAt = m1.arr + dwell;
        } else draft.freeAt = m1.arr + dwell;
        return draft;
      }
    }
    // Shunts where it stands.
    const m = this.move(draft, u, 'shunt', 'light_engine', p, t, INF, `Pilot: shunts ${this.placeName(p)} (sorting wagons, moving vans).`);
    if (!m) return null;
    m.arr = m.dep + dwell;
    draft.freeAt = m.arr;
    draft.notes = `Pilot at ${this.placeName(p)}.`;
    return draft;
  }

  private workingChain(u: Unit, j: LocoJob, draft: Draft, places: string[], t: number): Draft | null {
    const o = (draft.end as { placeId: string }).placeId;
    const type = j.trainTypeId;
    const cands = places.filter((id) => id !== o && routeBetween(this.state, this.layout, o, id)?.some((l) => l.kind === 'line'));
    // Prefer fiddle yard to fiddle yard for through trains; otherwise anywhere it can go.
    const dests = cands.map((id) => ({ id, k: this.rng() })).sort((a, b) => a.k - b.k).map((x) => x.id);
    const s = this.snap(draft);
    for (const d of dests) {
      if (this.tryWorking(u, draft, o, d, type, t, places)) return draft;
      this.restore(draft, s);
    }
    return null;
  }

  private tryWorking(u: Unit, draft: Draft, o: string, d: string, type: string, t: number, places: string[]): boolean {
    const oName = this.placeName(o);
    const dName = this.placeName(d);
    const pd = this.placeMap.get(d)!;
    if (this.isYard(d) || pd.kind === 'other') {
      // A through run (or a run to a yard), ending there.
      const m = this.move(draft, u, 'run', type, d, t, INF);
      if (!m) return false;
      draft.notes = `${oName} to ${dName}.`;
      return true;
    }
    // Into a station or goods yard, then back.
    const back = this.isYard(o) ? (this.rng() < 0.7 ? o : (this.pick(places.filter((id) => this.isYard(id) && id !== d)) ?? o)) : o;
    const passenger = COACHING.has(type) && pd.kind === 'station';
    if (passenger) {
      // The coaches stand in the platform until the train leaves again (we do not know when yet).
      const m1 = this.move(draft, u, 'run', type, d, t, INF);
      if (!m1) return false;
      const platform: PlaceRef = { ...m1.to };
      const coaches = draft.endHold!; // stays until the train leaves
      // Engine release: to a siding, goods yard or depot the same box works, or run round.
      const boxes = this.boxesOf(d);
      const release = this.layout.places.filter((p) => p.id !== d && p.kind !== 'fiddleYard' && p.kind !== 'station' && p.workedBy.some((w) => w.kind === 'box' && boxes.includes(w.boxId)) && (routeBetween(this.state, this.layout, d, p.id) ?? [{ kind: 'line' }]).every((l) => l.kind === 'local'));
      release.sort((a, b) => rank(a) - rank(b));
      let leaveAt = m1.arr + 12 + Math.floor(this.rng() * 6);
      let released = false;
      for (const r of release) {
        const save = this.snap(draft);
        const out = this.move(draft, u, 'shunt', 'light_engine', r.id, m1.arr + 3, m1.arr + 10, `Uncouple and leave the coaches in ${this.roadName(platform)}. Light engine to ${r.name}.`);
        if (!out) {
          this.restore(draft, save);
          continue;
        }
        // The coaches keep the platform while the engine is away.
        coaches.to = INF;
        const backOn = this.move(draft, u, 'shunt', 'light_engine', d, m1.arr + 10, INF, `Back on to the coaches in ${this.roadName(platform)}, ready to work them to ${this.placeName(back)}.`, platform.roadId);
        if (!backOn || backOn.to.roadId !== platform.roadId) {
          this.restore(draft, save);
          continue;
        }
        leaveAt = Math.max(leaveAt, backOn.arr + 4);
        released = true;
        draft.notes = `Terminates at ${dName}. The engine is released to ${r.name} and works the coaches back to ${this.placeName(back)}.`;
        break;
      }
      if (!released) {
        const rr = this.move(draft, u, 'shunt', 'light_engine', d, m1.arr + 3, INF, `Run round the coaches in ${this.roadName(platform)}.`);
        if (!rr) return false;
        rr.arr = rr.dep + 6;
        leaveAt = Math.max(leaveAt, rr.arr + 3);
        draft.notes = `Terminates at ${dName}, runs round and works back to ${this.placeName(back)}.`;
      }
      const m4 = this.move(draft, u, 'run', type, back, leaveAt, INF);
      if (!m4) return false;
      // The coaches' hold on the platform ends as the train leaves.
      coaches.to = Math.min(coaches.to, leaveAt);
      return true;
    }
    // Goods (or anything else) into a yard: it shunts the yard, then goes back. A train to the loco's
    // own home yard (a pick-up goods coming home) stays there.
    const m1 = this.move(draft, u, 'run', type, d, t, INF);
    if (!m1) return false;
    if (d === u.home) {
      draft.notes = `${oName} to ${dName}, where it stays.`;
      return true;
    }
    const dwell = 10 + Math.floor(this.rng() * 8);
    const goods = !COACHING.has(type);
    const m2 = this.move(draft, u, 'run', type, back, m1.arr + dwell, INF, goods ? (type === 'mineral' ? 'Empties back.' : 'Takes the outgoing wagons back.') : '');
    if (!m2) return false;
    draft.notes = goods ? `To ${dName}, shunts the yard, and back to ${this.placeName(back)}${type === 'mineral' ? ' with the empties' : ''}.` : `To ${dName} and back to ${this.placeName(back)}.`;
    return true;
  }

  private roadName(r: PlaceRef): string {
    const p = this.placeMap.get(r.placeId);
    const road = p?.roads.find((x) => x.id === r.roadId);
    return road ? `${p!.name} ${road.name}` : (p?.name ?? 'the platform');
  }

  // ------------------------------------------------------------------ choosing work

  /** Plan and commit one chain. False when nothing more can be found for now. */
  addChain(): boolean {
    for (let tries = 0; tries < 12; tries++) {
      const free = this.units.filter((u) => u.freeAt <= this.now + 1e-9);
      if (!free.length) {
        const next = Math.min(...this.units.map((u) => u.freeAt));
        if (!Number.isFinite(next)) return false;
        this.now = Math.max(this.now, next);
        continue;
      }
      const cands: Array<{ u: Unit; j: LocoJob; w: number }> = [];
      for (const u of free) for (const j of u.jobs) cands.push({ u, j, w: (j.weight * this.mixWeight(j)) / (1 + u.chains * 0.3) });
      while (cands.length) {
        const total = cands.reduce((n, c) => n + c.w, 0);
        let r = this.rng() * total;
        let k = 0;
        for (; k < cands.length - 1; k++) {
          r -= cands[k].w;
          if (r < 0) break;
        }
        const c = cands.splice(k, 1)[0];
        const draft = this.planWithRetry(c.u, c.j, Math.max(this.now, c.u.freeAt));
        if (draft) {
          this.commit(c.u, c.j, draft);
          return true;
        }
      }
      // Nothing fits just now: try a little later.
      this.now += Math.max(2, Math.round(this.gap / 2));
    }
    return false;
  }

  private planWithRetry(u: Unit, j: LocoJob, t: number): Draft | null {
    const keep = u.hold?.to ?? 0;
    const putBack = () => {
      if (u.hold) u.hold.to = keep;
    };
    for (let i = 0; i < 8; i++) {
      let d: Draft | null = null;
      try {
        d = this.planChain(u, j, t);
      } catch (e) {
        putBack();
        if (!(e instanceof Conflict)) throw e;
        t = Math.max(t + 1, Math.ceil(e.until) + 1);
        continue;
      }
      if (d) return d;
      break;
    }
    putBack();
    return null;
  }

  private commit(u: Unit, j: LocoJob, d: Draft): void {
    if (!d.moves.length) return;
    const first = d.moves[0];
    for (const r of d.roads) this.addIv(this.roads, r.key, r.iv);
    for (const l of d.lines) this.addIv(this.lines, l.key, l.iv);
    // The road it ends on: held until its next move (the planning already ended its hold where it started).
    u.hold = d.endHold && d.endHold.to === INF ? d.endHold : null;
    u.holdKey = u.hold ? d.endKey : '';
    u.pos = d.end;
    u.freeAt = Math.max(d.freeAt, d.moves[d.moves.length - 1].arr) + 2;
    u.chains++;
    const working = j.kind === 'pilot' ? 'light_engine' : j.trainTypeId;
    const base = j.kind === 'pilot' ? 'Pilot' : (TRAIN_NAMES[working] ?? this.state.trainTypes.find((x) => x.id === working)?.name ?? 'Train');
    const n = (this.names.get(base) ?? 0) + 1;
    this.names.set(base, n);
    const train: TimetableTrain = {
      id: `gtr_${this.opts.seed.toString(36)}_${++this.trainNo}`,
      name: `${base} ${n}`,
      locoId: u.loco.id,
      anyWorking: working,
      consist: u.loco.working.trainTypeId === working ? u.loco.working.consist : '',
      notes: d.notes,
    };
    this.trains.push(train);
    for (const m of d.moves) this.planned.push({ move: m, trainId: train.id, unit: u.loco.id, seq: this.seq++ });
    this.lastStart = Math.max(this.lastStart, first.dep);
    // The next train starts a gap after this one (a little more or less).
    this.now = Math.max(this.now, first.dep) + Math.max(1, Math.round(this.gap * (0.7 + this.rng() * 0.6)));
  }

  /** Locos home at the end: a light engine to its home place, or to a fiddle yard. */
  finish(): void {
    const t = Math.max(this.now, ...this.units.map((u) => u.freeAt));
    for (const u of this.units) {
      if (u.pos.kind !== 'place') continue;
      const at = u.pos.placeId;
      if (at === u.home || this.isYard(at)) continue;
      const targets = [u.home, ...this.yards().map((p) => p.id)].filter(Boolean);
      for (const target of targets) {
        let draft = this.newDraft(u, 'light_engine');
        let m: Move | null = null;
        let at = Math.max(t, u.freeAt);
        for (let i = 0; i < 6; i++) {
          draft = this.newDraft(u, 'light_engine');
          try {
            m = this.move(draft, u, 'run', 'light_engine', target, at, INF, target === u.home ? 'Home at the end of the session.' : 'Away to the fiddle yard at the end of the session.');
            break;
          } catch (e) {
            if (!(e instanceof Conflict)) throw e;
            at = Math.ceil(e.until) + 1;
          }
        }
        if (!m) continue;
        draft.notes = 'Light engine home at the end of the session.';
        this.commit(u, { id: 'home', kind: 'working', trainTypeId: 'light_engine', placeIds: [], weight: 1 }, draft);
        break;
      }
    }
  }

  /** Line a loco up with where it really is (Endless: a loco with nothing booked). */
  resync(locoId: string, pos: TtPos, at: number): void {
    const u = this.units.find((x) => x.loco.id === locoId);
    if (!u) return;
    u.freeAt = Math.max(u.freeAt, at);
    if (pos.kind === u.pos.kind && (pos.kind === 'off' || (u.pos.kind === 'place' && pos.placeId === u.pos.placeId && pos.roadId === u.pos.roadId))) return;
    if (u.hold) u.hold.to = Math.min(u.hold.to, at);
    u.hold = null;
    u.holdKey = '';
    u.pos = pos;
    if (pos.kind === 'place' && pos.roadId) {
      u.hold = { from: at, to: INF, owner: u.loco.id };
      u.holdKey = roadKey(pos);
      this.addIv(this.roads, u.holdKey, u.hold);
    }
  }

  /** Moves planned and not yet handed out. */
  private taken = new Set<number>();

  /**
   * Hand out the planned moves that start before `before` (and before the next chain could start, so
   * nothing still to be planned should come earlier), in time order, as timetable entries.
   */
  take(before: number, alloc: HeadcodeAllocator): TimetableEntry[] {
    const limit = Math.min(before, this.now);
    const list = this.planned.filter((p) => !this.taken.has(p.seq) && p.move.dep < limit).sort((a, b) => a.move.dep - b.move.dep || a.seq - b.seq);
    for (const p of list) this.taken.add(p.seq);
    return list.map(({ move: m, trainId }) => this.entryOf(m, trainId, alloc));
  }

  /** Planned moves not handed out yet. */
  pending(): number {
    return this.planned.length - this.taken.size;
  }

  /** Whether a loco has planned moves not handed out yet. */
  hasPending(locoId: string): boolean {
    return this.planned.some((p) => p.unit === locoId && !this.taken.has(p.seq));
  }

  /** Every planned move, in time order (Generate: the whole timetable at once). */
  takeAll(alloc: HeadcodeAllocator): TimetableEntry[] {
    const list = this.planned.filter((p) => !this.taken.has(p.seq)).sort((a, b) => a.move.dep - b.move.dep || a.seq - b.seq);
    for (const p of list) this.taken.add(p.seq);
    return list.map(({ move: m, trainId }) => this.entryOf(m, trainId, alloc));
  }

  private entryOf(m: Move, trainId: string, alloc: HeadcodeAllocator): TimetableEntry {
    const e: TimetableEntry = {
      id: `gte_${this.opts.seed.toString(36)}_${this.seqId++}`,
      trainId,
      kind: m.kind,
      dep: Math.round(m.dep),
      arr: m.kind === 'shunt' && m.from.placeId === m.to.placeId && m.from.roadId === m.to.roadId ? null : Math.round(m.arr),
      withPrevious: false,
      trainTypeId: m.trainTypeId,
      headcode: '',
      from: m.kind === 'enter' ? { placeId: '', roadId: '' } : m.from,
      to: m.kind === 'leave' ? { placeId: '', roadId: '' } : m.to,
      calls: m.calls.map((c) => ({ ...c, arr: c.arr === null ? null : Math.round(c.arr), dep: c.dep === null ? null : Math.round(c.dep) })),
      notes: m.notes,
    };
    e.headcode = alloc.next(e.trainTypeId, destinationOf(e), e.kind);
    return e;
  }

  private seqId = 1;
}

/** Ranking of release places: an engine shed first, then sidings, then the goods yard. */
function rank(p: Place): number {
  return p.kind === 'depot' ? 0 : p.kind === 'sidings' ? 1 : p.kind === 'goods' ? 2 : 3;
}

function locoLabel(l: Loco): string {
  return [l.number, l.name].filter(Boolean).join(' ') || 'A loco';
}

/** Turn timed entries into an operations sequence: no times; moves of different trains due together are released together. */
export function toSequence(entries: TimetableEntry[], unitOf: (e: TimetableEntry) => string): void {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const p = entries[i - 1];
    e.withPrevious = !!p && p.dep !== null && e.dep !== null && e.dep - p.dep <= 1 && unitOf(p) !== unitOf(e) && !p.withPrevious;
  }
  for (const e of entries) {
    e.dep = null;
    e.arr = null;
    e.calls = e.calls.map((c) => ({ ...c, arr: null, dep: null }));
  }
}

/** Generate a whole timetable. */
export function generateTimetable(state: AppState, layout: Layout, opts: GeneratorOptions, name: string): GenerateResult {
  const gen = new TimetableGenerator(state, layout, opts);
  const seq = opts.timing === 'sequence';
  const homeMoves = () => gen.units.filter((u) => u.pos.kind === 'place' && u.pos.placeId !== u.home && !(layout.places.find((p) => p.id === (u.pos as { placeId: string }).placeId)?.kind === 'fiddleYard')).length;
  let guard = 0;
  while (guard++ < 400 && gen.units.length) {
    if (seq ? gen.planned.length + homeMoves() >= opts.length : gen.now >= gen.t0 + opts.length) break;
    if (!gen.addChain()) break;
  }
  gen.finish();
  const tt: Timetable = {
    id: `tt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    timing: opts.timing,
    startAt: opts.timing === 'sequence' ? 9 * 60 : opts.startAt,
    elapsed: false,
    speed: opts.timing === 'session' ? opts.speed : 1,
    validity: 'Generated',
    notes: `Made by the timetable generator (pattern ${opts.seed}).`,
    trains: gen.trains,
    entries: [],
    generated: structuredClone(opts),
  };
  const alloc = new HeadcodeAllocator(eraOf(layout), layout);
  tt.entries = gen.takeAll(alloc);
  if (seq) {
    const unit = new Map(gen.trains.map((t) => [t.id, t.locoId]));
    toSequence(tt.entries, (e) => unit.get(e.trainId) ?? e.trainId);
  }
  const notes = [...gen.notes];
  if (gen.units.length && !tt.entries.length) notes.push('No moves could be found: check the locos’ jobs name places on this layout that signal boxes connect.');
  return { tt, notes };
}
