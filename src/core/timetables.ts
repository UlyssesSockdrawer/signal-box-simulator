import { findPlace, findRoad } from './places';
import type { AppState, Layout, Loco, LocoJob, Place, PlaceRef, Timetable, TimetableCall, TimetableEntry, TimetableEntryKind, TimetableTiming, TimetableTrain } from './types';

/*
 * TIMETABLES (v0.3.24). A timetable belongs to one layout and is a list of entries in order, each
 * one move or action of a TRAIN (a chain of moves worked by one loco). This module is pure logic:
 * creating and editing timetables, finding the route a move takes through the signal boxes, walking
 * through the timetable to check it (where each loco is after every step), the stock positions at
 * the start, and the tables for the public poster. Running a timetable in a box comes later.
 */

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const MAX_TIMETABLES = 30;
export const MAX_ENTRIES = 400;
export const MAX_SPEED = 12;

export const TIMINGS: Array<{ timing: TimetableTiming; name: string; short: string; help: string }> = [
  { timing: 'sequence', name: 'Operations sequence', short: 'Sequence', help: 'No times: each move is released when the one before it has finished (card order). Best for most model railway sessions.' },
  { timing: 'clock', name: 'Real time', short: 'Real time', help: 'Moves are due at clock times by the system clock, e.g. 15:00.' },
  { timing: 'session', name: 'Session clock', short: 'Session clock', help: 'A clock that starts when the session starts: from a time you choose (e.g. 09:00) or as minutes after the start, at real speed or as a fast clock.' },
];
export const timingInfo = (t: TimetableTiming) => TIMINGS.find((x) => x.timing === t) ?? TIMINGS[0];

export const ENTRY_KINDS: Array<{ kind: TimetableEntryKind; name: string; help: string }> = [
  { kind: 'run', name: 'Run', help: 'A train running from one place to another, signalled over the lines between the boxes.' },
  { kind: 'shunt', name: 'Shunt / change working', help: 'A move within one box’s area (no block signalling), or a change of working where the train stands, e.g. running round or becoming a light engine.' },
  { kind: 'enter', name: 'Enter from off layout', help: 'The train comes on to the layout, e.g. into a fiddle yard road.' },
  { kind: 'leave', name: 'Leave the layout', help: 'The train goes off the layout, back into storage.' },
  { kind: 'note', name: 'Note', help: 'An instruction or reminder for the operators. Nothing moves.' },
];
export const entryKindName = (k: TimetableEntryKind) => ENTRY_KINDS.find((x) => x.kind === k)?.name ?? k;

/** Train types shown in the public poster's main tables (the rest are "goods and other trains"). */
export const PASSENGER_TYPES = new Set(['express_passenger', 'ordinary_passenger', 'branch_passenger', 'railcar']);

// ---------------------------------------------------------------- times

/** Parse "15:00", "1500", "9.05", "9 05", "+5", "+0:05" (with `elapsed`, plain numbers are minutes after the start). Null when empty; NaN when not a time. */
export function parseTime(text: string, elapsed = false): number | null {
  const t = text.trim();
  if (!t) return null;
  const plus = t.startsWith('+');
  const body = plus ? t.slice(1).trim() : t;
  const hm = /^(\d{1,3})\s*[:.\s]\s*(\d{2})$/.exec(body);
  if (plus || elapsed) {
    // Minutes after the start: "+5", "90", "+1:30".
    if (/^\d{1,4}$/.test(body)) return Number(body);
    if (hm && Number(hm[2]) <= 59) return Number(hm[1]) * 60 + Number(hm[2]);
    return NaN;
  }
  const four = /^(\d{1,2})(\d{2})$/.exec(body);
  const parts = hm ?? four;
  if (parts) {
    const h = Number(parts[1]);
    const min = Number(parts[2]);
    return h > 23 || min > 59 ? NaN : h * 60 + min;
  }
  if (/^\d{1,2}$/.test(body)) return Number(body) <= 23 ? Number(body) * 60 : NaN;
  return NaN;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A time as the editor shows it: 09:05, or +0:05 for a session clock shown as minutes after the start. */
export function fmtTime(min: number | null, tt: Pick<Timetable, 'timing' | 'elapsed'>): string {
  if (min === null || !Number.isFinite(min)) return '';
  if (tt.timing === 'session' && tt.elapsed) return `+${Math.floor(min / 60)}:${pad(min % 60)}`;
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export const isTimed = (tt: Pick<Timetable, 'timing'>) => tt.timing !== 'sequence';

// ---------------------------------------------------------------- finding

export function timetablesOf(layout: Layout): Timetable[] {
  return (layout.timetables ??= []);
}

export function findTimetable(state: AppState, id: string | undefined): { layout: Layout; tt: Timetable } | null {
  if (!id) return null;
  for (const layout of state.layouts) {
    const tt = (layout.timetables ?? []).find((t) => t.id === id);
    if (tt) return { layout, tt };
  }
  return null;
}

export const findTrain = (tt: Timetable, id: string) => tt.trains.find((t) => t.id === id);
export const findEntry = (tt: Timetable, id: string) => tt.entries.find((e) => e.id === id);
export const entriesOfTrain = (tt: Timetable, trainId: string) => tt.entries.filter((e) => e.trainId === trainId);

/** The roster loco working a train, if it names one that exists. */
export function trainLoco(state: AppState, train: TimetableTrain | undefined): Loco | undefined {
  return train?.locoId ? state.roster.find((l) => l.id === train.locoId) : undefined;
}

/** Locos that can work a kind of train: those with a job for it, or (with no jobs set) those working as it now. */
export function locosFor(state: AppState, trainTypeId: string): Loco[] {
  return state.roster.filter((l) => (l.jobs?.length ? l.jobs.some((j) => j.kind === 'working' && j.trainTypeId === trainTypeId) : l.working.trainTypeId === trainTypeId));
}

/** "Train 3" style label with its loco: "Train 3 · 5025", or "Train 3 · any Ordinary passenger loco". */
export function trainLabel(state: AppState, train: TimetableTrain | undefined): string {
  if (!train) return 'No train';
  const loco = trainLoco(state, train);
  if (loco) return `${train.name} · ${[loco.number, loco.name].filter(Boolean).join(' ')}`;
  if (train.locoId) return `${train.name} · loco missing`;
  const tt = state.trainTypes.find((t) => t.id === train.anyWorking);
  return `${train.name} · any ${tt ? tt.name.toLowerCase() : ''} loco`.replace('any  loco', 'any loco');
}

/** "Fiddle Yard West · Road 1", "Sigsim Central (any road)". */
export function refText(state: AppState, ref: PlaceRef | undefined): string {
  if (!ref?.placeId) return 'Nowhere chosen';
  const p = findPlace(state, ref.placeId);
  if (!p) return 'A place that no longer exists';
  const r = findRoad(p, ref.roadId);
  return r ? `${p.name} · ${r.name}` : p.roads.length ? `${p.name} (any road)` : p.name;
}

/** Short form for tight spaces: "FYW 1", "SGC P2" (short names where set). */
export function refShort(state: AppState, ref: PlaceRef | undefined): string {
  if (!ref?.placeId) return '—';
  const p = findPlace(state, ref.placeId);
  if (!p) return '?';
  const r = findRoad(p, ref.roadId);
  const name = p.shortName || p.name;
  return r ? `${name} ${r.name.replace(/^Road\s+/i, 'Rd ')}` : name;
}

// ---------------------------------------------------------------- validation

export function checkTimetableName(layout: Layout, name: string, id: string | null): string | null {
  if (!name.trim()) return 'Enter a name for the timetable.';
  if (name.trim().length > 60) return 'Keep it to 60 characters or fewer.';
  if (timetablesOf(layout).some((t) => t.id !== id && norm(t.name) === norm(name))) return `${layout.name} already has a timetable called ${name.trim()}.`;
  return null;
}

export function checkTrainName(tt: Timetable, name: string, id: string | null): string | null {
  if (!name.trim()) return 'Enter a name for the train.';
  if (name.trim().length > 40) return 'Keep it to 40 characters or fewer.';
  if (tt.trains.some((t) => t.id !== id && norm(t.name) === norm(name))) return `${tt.name} already has a train called ${name.trim()}.`;
  return null;
}

function uniqueName(base: string, taken: string[], numberFirst = false): string {
  const used = new Set(taken.map(norm));
  if (!numberFirst && !used.has(norm(base))) return base;
  for (let n = numberFirst ? 1 : 2; ; n++) if (!used.has(norm(`${base} ${n}`))) return `${base} ${n}`;
}

// ---------------------------------------------------------------- creating and editing

export function blankTimetable(name: string, timing: TimetableTiming = 'sequence'): Timetable {
  return { id: newId('tt'), name, timing, startAt: 9 * 60, elapsed: false, speed: 1, validity: '', notes: '', trains: [], entries: [] };
}

/** Add a timetable to a layout (null when it has the most allowed). */
export function addTimetable(state: AppState, layoutId: string, timing: TimetableTiming = 'sequence', name?: string): Timetable | null {
  const layout = state.layouts.find((l) => l.id === layoutId);
  if (!layout || timetablesOf(layout).length >= MAX_TIMETABLES) return null;
  const base = timing === 'sequence' ? 'Operations sequence' : timing === 'clock' ? 'Timetable' : 'Session timetable';
  const tt = blankTimetable(name?.trim() || uniqueName(base, timetablesOf(layout).map((t) => t.name)), timing);
  timetablesOf(layout).push(tt);
  return tt;
}

/** A copy of a timetable (new ids throughout), added after it. */
export function duplicateTimetable(state: AppState, id: string): Timetable | null {
  const found = findTimetable(state, id);
  if (!found || timetablesOf(found.layout).length >= MAX_TIMETABLES) return null;
  const copy: Timetable = structuredClone(found.tt);
  copy.id = newId('tt');
  copy.name = uniqueName(`${found.tt.name} (copy)`, timetablesOf(found.layout).map((t) => t.name));
  const trainIds = new Map<string, string>();
  for (const t of copy.trains) {
    const nid = newId('ttr');
    trainIds.set(t.id, nid);
    t.id = nid;
  }
  for (const e of copy.entries) {
    e.id = newId('tte');
    e.trainId = trainIds.get(e.trainId) ?? '';
  }
  const list = timetablesOf(found.layout);
  list.splice(list.indexOf(found.tt) + 1, 0, copy);
  return copy;
}

export function deleteTimetable(state: AppState, id: string): void {
  const found = findTimetable(state, id);
  if (found) found.layout.timetables = timetablesOf(found.layout).filter((t) => t.id !== id);
}

export function blankEntry(trainId: string, kind: TimetableEntryKind = 'run'): TimetableEntry {
  return { id: newId('tte'), trainId, kind, dep: null, arr: null, withPrevious: false, trainTypeId: 'ordinary_passenger', headcode: '', from: { placeId: '', roadId: '' }, to: { placeId: '', roadId: '' }, calls: [], notes: '' };
}

/**
 * Add a train with its first move. The move starts where a loco would most likely come from (the
 * loco's place, else the first fiddle yard) and runs to the first other place, so the editor opens
 * on something sensible to change. Returns the train and its entry (null when the timetable is full).
 */
export function addTrain(state: AppState, layout: Layout, tt: Timetable, opts: { locoId?: string } = {}): { train: TimetableTrain; entry: TimetableEntry } | null {
  if (tt.entries.length >= MAX_ENTRIES) return null;
  const loco = opts.locoId ? state.roster.find((l) => l.id === opts.locoId) : undefined;
  const train: TimetableTrain = {
    id: newId('ttr'),
    name: uniqueName('Train', tt.trains.map((t) => t.name), true),
    locoId: loco?.id ?? '',
    anyWorking: loco?.working.trainTypeId ?? 'ordinary_passenger',
    consist: loco?.working.consist ?? '',
    notes: '',
  };
  tt.trains.push(train);
  const entry = blankEntry(train.id, 'run');
  entry.trainTypeId = loco?.working.trainTypeId ?? 'ordinary_passenger';
  const here = loco?.location.kind === 'place' && layout.places.some((p) => p.id === (loco.location as { placeId: string }).placeId) ? { placeId: loco.location.placeId, roadId: loco.location.roadId } : null;
  const yard = layout.places.find((p) => p.kind === 'fiddleYard') ?? layout.places[0];
  entry.from = here ?? (yard ? { placeId: yard.id, roadId: yard.roads[0]?.id ?? '' } : { placeId: '', roadId: '' });
  const dest = layout.places.find((p) => p.id !== entry.from.placeId && p.kind === 'station') ?? layout.places.find((p) => p.id !== entry.from.placeId);
  entry.to = dest ? { placeId: dest.id, roadId: '' } : { placeId: '', roadId: '' };
  if (isTimed(tt)) {
    const last = lastTime(tt);
    entry.dep = last === null ? (tt.timing === 'session' && tt.elapsed ? 0 : tt.startAt) : last + 5;
  }
  tt.entries.push(entry);
  return { train, entry };
}

/** The latest time used anywhere in the timetable. */
function lastTime(tt: Timetable): number | null {
  let t: number | null = null;
  for (const e of tt.entries) for (const x of [e.dep, e.arr]) if (x !== null && (t === null || x > t)) t = x;
  return t;
}

/** Where a train is after its last move so far ('off' when it has left the layout, null when it has no moves). */
function endOf(e: TimetableEntry | undefined): PlaceRef | 'off' | null {
  if (!e) return null;
  if (e.kind === 'leave') return 'off';
  if (e.kind === 'note') return null;
  if (e.kind === 'shunt' && !e.to.placeId) return e.from;
  return e.to;
}

/**
 * "+ Then this train…": the next move of a train, starting where its last move left it, placed
 * straight after that move. After a train move the next is usually a light engine (running round,
 * going to the shed); after a light engine, back to the train's own working.
 */
export function thenEntry(state: AppState, layout: Layout, tt: Timetable, trainId: string): TimetableEntry | null {
  const train = findTrain(tt, trainId);
  if (!train || tt.entries.length >= MAX_ENTRIES) return null;
  const mine = entriesOfTrain(tt, trainId).filter((e) => e.kind !== 'note');
  const last = mine[mine.length - 1];
  const e = blankEntry(trainId, 'shunt');
  const end = endOf(last);
  if (end === 'off') {
    e.kind = 'enter';
    const yard = layout.places.find((p) => p.kind === 'fiddleYard');
    e.to = yard ? { placeId: yard.id, roadId: '' } : { placeId: '', roadId: '' };
    e.trainTypeId = train.anyWorking || 'ordinary_passenger';
  } else if (end) {
    e.from = { ...end };
    const place = findPlace(state, end.placeId);
    const wasLight = last?.trainTypeId === 'light_engine' || last?.kind === 'shunt';
    // A train that has arrived somewhere other than a fiddle yard usually releases its engine (light
    // engine); an engine that has gone light to a siding or shed comes back light; once back at a
    // station or in a fiddle yard it works its train again.
    const lightNext = wasLight ? place?.kind !== 'station' && place?.kind !== 'fiddleYard' : place?.kind !== 'fiddleYard';
    e.trainTypeId = lightNext ? 'light_engine' : train.anyWorking || 'ordinary_passenger';
    e.kind = lightNext ? 'shunt' : 'run';
    const local = layout.places.filter((p) => p.id !== end.placeId && workedBySameBox(p, place));
    const other =
      e.kind === 'run'
        ? layout.places.find((p) => p.id !== end.placeId && p.kind === 'fiddleYard')
        : place?.kind === 'station'
          ? local.find((p) => p.kind !== 'station') ?? local[0]
          : local.find((p) => p.kind === 'station') ?? local[0];
    e.to = e.kind === 'shunt' && !other ? { ...end } : { placeId: other?.id ?? '', roadId: '' };
  } else {
    e.kind = 'run';
  }
  e.headcode = '';
  if (isTimed(tt)) {
    const t = last ? (last.arr ?? last.dep) : lastTime(tt);
    e.dep = t === null ? tt.startAt : t + 5;
  }
  const at = last ? tt.entries.indexOf(last) + 1 : tt.entries.length;
  tt.entries.splice(at, 0, e);
  return e;
}

function workedBySameBox(p: Place, q: Place | undefined): boolean {
  if (!q) return false;
  return p.workedBy.some((w) => w.kind === 'box' && q.workedBy.some((x) => x.kind === 'box' && x.boxId === w.boxId));
}

/** Move an entry up (-1) or down (+1) in the timetable's order. */
export function moveEntry(tt: Timetable, id: string, delta: -1 | 1): void {
  const i = tt.entries.findIndex((e) => e.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= tt.entries.length) return;
  [tt.entries[i], tt.entries[j]] = [tt.entries[j], tt.entries[i]];
}

export function removeEntry(tt: Timetable, id: string): void {
  tt.entries = tt.entries.filter((e) => e.id !== id);
}

/** Remove a train and all its moves. */
export function removeTrain(tt: Timetable, trainId: string): void {
  tt.trains = tt.trains.filter((t) => t.id !== trainId);
  tt.entries = tt.entries.filter((e) => e.trainId !== trainId);
}

/** Timed timetables keep their entries in time order (an entry with no time stays after the one before it). */
export function sortByTime(tt: Timetable): void {
  if (!isTimed(tt)) return;
  let last = -Infinity;
  const keyed = tt.entries.map((e, i) => {
    if (e.dep !== null) last = e.dep;
    else if (e.arr !== null) last = e.arr;
    return { e, k: last, i };
  });
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  tt.entries = keyed.map((x) => x.e);
}

/** Keep a timetable's data whole after loading or after places, trains or locos change. */
export function sanitiseTimetables(state: AppState): void {
  for (const layout of state.layouts) {
    layout.timetables = (Array.isArray(layout.timetables) ? layout.timetables : []).filter((t) => t && typeof t === 'object' && typeof t.id === 'string');
    if (layout.headcodeEra !== undefined && !['grouping', 'brLamps', 'br1960'].includes(layout.headcodeEra)) delete layout.headcodeEra;
    for (const tt of layout.timetables) {
      tt.name = String(tt.name ?? '').trim() || 'Timetable';
      if (!TIMINGS.some((x) => x.timing === tt.timing)) tt.timing = 'sequence';
      tt.startAt = Number.isFinite(tt.startAt) ? Math.max(0, Math.min(1439, Math.round(tt.startAt))) : 9 * 60;
      tt.elapsed = !!tt.elapsed;
      tt.speed = Number.isFinite(tt.speed) ? Math.max(1, Math.min(MAX_SPEED, Math.round(tt.speed))) : 1;
      tt.validity ??= '';
      tt.notes ??= '';
      if (tt.generated && (typeof tt.generated !== 'object' || !Number.isFinite(tt.generated.seed))) delete tt.generated;
      tt.trains = Array.isArray(tt.trains) ? tt.trains.filter((t) => t && typeof t.id === 'string') : [];
      for (const t of tt.trains) {
        t.name ??= 'Train';
        t.locoId ??= '';
        t.anyWorking ??= 'ordinary_passenger';
        t.consist ??= '';
        t.notes ??= '';
      }
      const trains = new Set(tt.trains.map((t) => t.id));
      tt.entries = Array.isArray(tt.entries) ? tt.entries.filter((e) => e && typeof e.id === 'string') : [];
      for (const e of tt.entries) {
        if (!ENTRY_KINDS.some((k) => k.kind === e.kind)) e.kind = 'run';
        if (!trains.has(e.trainId)) e.trainId = e.kind === 'note' ? '' : (e.trainId ?? '');
        e.dep = typeof e.dep === 'number' && Number.isFinite(e.dep) ? e.dep : null;
        e.arr = typeof e.arr === 'number' && Number.isFinite(e.arr) ? e.arr : null;
        e.withPrevious = !!e.withPrevious;
        e.trainTypeId ??= 'ordinary_passenger';
        e.headcode ??= '';
        e.from ??= { placeId: '', roadId: '' };
        e.to ??= { placeId: '', roadId: '' };
        e.calls = Array.isArray(e.calls) ? e.calls.filter((c) => c && typeof c.placeId === 'string') : [];
        e.notes ??= '';
      }
      // Moves of trains that no longer exist go (a note stays).
      tt.entries = tt.entries.filter((e) => e.kind === 'note' || trains.has(e.trainId));
    }
  }
  for (const l of state.roster) {
    if (!Array.isArray(l.jobs)) delete l.jobs;
    else l.jobs = l.jobs.filter((j) => j && typeof j.id === 'string').map((j) => ({ ...j, placeIds: Array.isArray(j.placeIds) ? j.placeIds : [], weight: ([1, 2, 3] as const).includes(j.weight) ? j.weight : 2, kind: j.kind === 'pilot' ? 'pilot' : 'working' }));
  }
}

export function blankJob(kind: LocoJob['kind'] = 'working', trainTypeId = 'ordinary_passenger'): LocoJob {
  return { id: newId('job'), kind, trainTypeId: kind === 'pilot' ? 'light_engine' : trainTypeId, placeIds: [], weight: 2 };
}

// ---------------------------------------------------------------- routes

/** One stage of a move: within a box's area, or along the line between a box and the far box of one of its connections. */
export type RouteLeg =
  | { kind: 'local'; boxId: string; fromPlaceId: string; toPlaceId: string }
  | { kind: 'line'; boxId: string; connectionId: string; /** 'out' = from the box to the far place; 'in' = from the far place to the box. */ dir: 'in' | 'out' };

/**
 * The route a move takes through the signal boxes, from one place to another: [] for a move within
 * one place, null when no boxes connect them. Places worked by a box you work are in that box's area;
 * the far place of a connection is reached along that line. Through running at a box (in on one
 * line, out on another) is part of a route.
 */
export function routeBetween(state: AppState, layout: Layout, fromPlaceId: string, toPlaceId: string): RouteLeg[] | null {
  if (!fromPlaceId || !toPlaceId) return null;
  if (fromPlaceId === toPlaceId) return layout.places.some((p) => p.id === fromPlaceId) ? [] : null;
  type Edge = { to: string; leg: (fromKey: string) => RouteLeg };
  const adj = new Map<string, Edge[]>();
  const add = (a: string, e: Edge) => (adj.get(a) ?? adj.set(a, []).get(a)!).push(e);
  const boxes = state.boxes.filter((b) => b.layoutId === layout.id);
  for (const p of layout.places) {
    for (const w of p.workedBy) {
      const box = boxes.find((b) => b.id === w.boxId);
      if (!box) continue;
      if (w.kind === 'box') {
        add(`p:${p.id}`, { to: `b:${box.id}`, leg: () => ({ kind: 'local', boxId: box.id, fromPlaceId: p.id, toPlaceId: '' }) });
        add(`b:${box.id}`, { to: `p:${p.id}`, leg: () => ({ kind: 'local', boxId: box.id, fromPlaceId: '', toPlaceId: p.id }) });
      }
    }
  }
  for (const box of boxes) {
    for (const c of box.connections) {
      const p = layout.places.find((x) => x.id === c.placeId);
      if (!p) continue;
      add(`p:${p.id}`, { to: `b:${box.id}`, leg: () => ({ kind: 'line', boxId: box.id, connectionId: c.id, dir: 'in' }) });
      add(`b:${box.id}`, { to: `p:${p.id}`, leg: () => ({ kind: 'line', boxId: box.id, connectionId: c.id, dir: 'out' }) });
    }
  }
  const start = `p:${fromPlaceId}`;
  const goal = `p:${toPlaceId}`;
  const prev = new Map<string, { from: string; edge: Edge }>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const k = queue.shift()!;
    if (k === goal) break;
    for (const e of adj.get(k) ?? []) {
      // Places are only passed through at boxes: a route does not run through another place.
      if (e.to.startsWith('p:') && e.to !== goal) continue;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: k, edge: e });
      queue.push(e.to);
    }
  }
  if (!seen.has(goal)) return null;
  const legs: RouteLeg[] = [];
  for (let k = goal; k !== start; ) {
    const p = prev.get(k)!;
    legs.unshift(p.edge.leg(p.from));
    k = p.from;
  }
  // Merge "place → box" + "box → place" local stages into one local move.
  const out: RouteLeg[] = [];
  for (const leg of legs) {
    const last = out[out.length - 1];
    if (leg.kind === 'local' && last?.kind === 'local' && last.boxId === leg.boxId && !last.toPlaceId) last.toPlaceId = leg.toPlaceId;
    else out.push({ ...leg });
  }
  return out;
}

/** True when a route goes along a line between boxes (so it is signalled). */
export const routeSignalled = (legs: RouteLeg[] | null) => !!legs?.some((l) => l.kind === 'line');

/** The route in words: "Fiddle Yard West line to Sigsim Central, then the Fiddle Yard East line". */
export function routeText(state: AppState, legs: RouteLeg[] | null): string {
  if (!legs) return 'No route: no signal boxes connect these places.';
  if (!legs.length) return 'Within the same place.';
  const parts: string[] = [];
  for (const leg of legs) {
    const box = state.boxes.find((b) => b.id === leg.boxId);
    if (leg.kind === 'local') {
      if (legs.length === 1) parts.push(`within ${box?.name ?? 'the box'}’s area (no block signalling)`);
      continue;
    }
    const c = box?.connections.find((x) => x.id === leg.connectionId);
    parts.push(leg.dir === 'in' ? `offered by ${c?.neighbourName ?? 'the far box'} to ${box?.name ?? 'the box'}` : `sent by ${box?.name ?? 'the box'} to ${c?.neighbourName ?? 'the far box'}`);
  }
  const s = parts.join(', then ');
  return s ? s[0].toUpperCase() + s.slice(1) + '.' : '';
}

// ---------------------------------------------------------------- walking through a timetable

export type TtPos = { kind: 'place'; placeId: string; roadId: string } | { kind: 'off' };

export interface TtIssue {
  /** 'error' = the move cannot run as written; 'warn' = worth a look. */
  level: 'error' | 'warn';
  code: string;
  text: string;
}

export interface TtStep {
  entry: TimetableEntry;
  index: number;
  /** Sequence step number (moves released together share one), from 1. */
  step: number;
  issues: TtIssue[];
  route: RouteLeg[] | null;
  /** Where each loco (unit) stands once this entry has been done. */
  after: Map<string, TtPos>;
}

export interface TtUnit {
  /** The loco's id, or `train:<id>` for a train worked by "any loco". */
  key: string;
  locoId: string;
  trainIds: string[];
  /** Where it must stand when the timetable starts (off = off the layout, comes on later). */
  start: TtPos;
}

export interface TtWalk {
  units: TtUnit[];
  steps: TtStep[];
  /** Problems with whole trains (loco missing, booked twice…), by train id. */
  trainIssues: Map<string, TtIssue[]>;
  /** Number of issues overall. */
  errors: number;
  warnings: number;
}

export const unitKey = (train: TimetableTrain) => train.locoId || `train:${train.id}`;

const sameRef = (a: TtPos, b: PlaceRef) => a.kind === 'place' && a.placeId === b.placeId;
const posText = (state: AppState, p: TtPos) => (p.kind === 'off' ? 'off the layout' : refText(state, p));
const toPos = (r: PlaceRef): TtPos => ({ kind: 'place', placeId: r.placeId, roadId: r.roadId });

/** Where a move starts and ends, as positions (null when the entry moves nothing). */
function moveEnds(e: TimetableEntry): { from: TtPos | null; to: TtPos | null } {
  switch (e.kind) {
    case 'enter':
      return { from: { kind: 'off' }, to: toPos(e.to) };
    case 'leave':
      return { from: toPos(e.from), to: { kind: 'off' } };
    case 'shunt':
      return { from: toPos(e.from), to: e.to.placeId ? toPos(e.to) : toPos(e.from) };
    case 'run':
      return { from: toPos(e.from), to: toPos(e.to) };
    default:
      return { from: null, to: null };
  }
}

/**
 * Walk through a timetable in order, as it would run: where every loco stands before the first move
 * (its stock position) and after each entry, and what looks wrong on the way — a train starting
 * somewhere its last move did not leave it, a place or road that no longer exists, no route between
 * two places, a loco booked on two trains at once, a road another train is still standing on,
 * missing or backwards times.
 */
export function walkTimetable(state: AppState, layout: Layout, tt: Timetable): TtWalk {
  const trainIssues = new Map<string, TtIssue[]>();
  const trainIssue = (id: string, i: TtIssue) => (trainIssues.get(id) ?? trainIssues.set(id, []).get(id)!).push(i);
  const units: TtUnit[] = [];
  const unitOf = new Map<string, TtUnit>();
  for (const train of tt.trains) {
    const key = unitKey(train);
    let u = unitOf.get(key);
    if (!u) {
      u = { key, locoId: train.locoId, trainIds: [], start: { kind: 'off' } };
      unitOf.set(key, u);
      units.push(u);
    }
    u.trainIds.push(train.id);
    if (train.locoId && !trainLoco(state, train)) trainIssue(train.id, { level: 'error', code: 'noLoco', text: 'Its loco is no longer in the roster. Choose another.' });
    if (!train.locoId && !locosFor(state, train.anyWorking).length) {
      const tn = state.trainTypes.find((t) => t.id === train.anyWorking)?.name ?? 'this kind of train';
      trainIssue(train.id, { level: 'error', code: 'noSuitableLoco', text: `No loco in the roster has a job for ${tn.toLowerCase()}. Give one that job in the roster, or choose a loco.` });
    }
  }
  // Starting positions: where each unit's first move begins.
  const started = new Set<string>();
  for (const e of tt.entries) {
    const train = findTrain(tt, e.trainId);
    if (!train) continue;
    const u = unitOf.get(unitKey(train))!;
    if (started.has(u.key)) continue;
    const { from } = moveEnds(e);
    if (!from) continue;
    started.add(u.key);
    u.start = from;
  }
  // A loco shared by two trains: their moves must not interleave.
  for (const u of units.filter((x) => x.trainIds.length > 1)) {
    const spans = u.trainIds.map((id) => {
      const idx = tt.entries.map((e, i) => (e.trainId === id ? i : -1)).filter((i) => i >= 0);
      return { id, a: Math.min(...idx), b: Math.max(...idx) };
    }).filter((s) => Number.isFinite(s.a));
    for (const s of spans) {
      const clash = spans.find((o) => o !== s && o.a < s.b && s.a < o.b);
      if (clash) trainIssue(s.id, { level: 'error', code: 'doubleBooked', text: `Its loco is also working ${findTrain(tt, clash.id)?.name ?? 'another train'} at the same time.` });
    }
  }

  const pos = new Map<string, TtPos>(units.map((u) => [u.key, u.start]));
  const lastTimeOf = new Map<string, number>();
  const steps: TtStep[] = [];
  let step = 0;
  tt.entries.forEach((e, index) => {
    if (!(index > 0 && e.withPrevious && !isTimed(tt))) step++;
    const issues: TtIssue[] = [];
    const train = findTrain(tt, e.trainId);
    let route: RouteLeg[] | null = null;
    if (e.kind !== 'note') {
      if (!train) issues.push({ level: 'error', code: 'noTrain', text: 'This move belongs to no train.' });
      const ends = moveEnds(e);
      const check = (ref: PlaceRef, what: string) => {
        if (!ref.placeId) return issues.push({ level: 'error', code: 'noPlace', text: `Choose where it ${what}.` });
        const p = layout.places.find((x) => x.id === ref.placeId);
        if (!p) return issues.push({ level: 'error', code: 'missingPlace', text: `The place it ${what} is no longer on ${layout.name}.` });
        if (ref.roadId && !p.roads.some((r) => r.id === ref.roadId)) issues.push({ level: 'error', code: 'missingRoad', text: `${p.name} no longer has the road it ${what}.` });
      };
      if (e.kind !== 'enter') check(e.from, e.kind === 'leave' ? 'leaves from' : 'starts from');
      if (e.kind === 'run' || e.kind === 'enter' || (e.kind === 'shunt' && e.to.placeId)) check(e.to, 'goes to');
      if (train && ends.from) {
        const key = unitKey(train);
        const here = pos.get(key) ?? { kind: 'off' as const };
        if (e.kind === 'enter') {
          if (here.kind !== 'off') issues.push({ level: 'error', code: 'alreadyOn', text: `${train.name} is already on the layout (${posText(state, here)}).` });
        } else if (e.from.placeId) {
          if (here.kind === 'off') issues.push({ level: 'error', code: 'notOn', text: `${train.name} is off the layout at this point. Add an Enter from off layout move first.` });
          else if (!sameRef(here, e.from)) issues.push({ level: 'error', code: 'continuity', text: `${train.name}’s loco is at ${posText(state, here)} by now, not ${refText(state, e.from)}.` });
          else if (here.kind === 'place' && here.roadId && e.from.roadId && here.roadId !== e.from.roadId) issues.push({ level: 'warn', code: 'roadContinuity', text: `${train.name}’s loco is on ${posText(state, here)} by now, not ${refText(state, e.from)}.` });
        }
      }
      if ((e.kind === 'run' || e.kind === 'shunt') && e.from.placeId && ends.to?.kind === 'place' && ends.to.placeId) {
        route = routeBetween(state, layout, e.from.placeId, ends.to.placeId);
        if (!route && layout.places.some((p) => p.id === e.from.placeId) && layout.places.some((p) => p.id === (ends.to as { placeId: string }).placeId)) issues.push({ level: 'error', code: 'noRoute', text: 'No signal boxes connect these places, so the train has no way there.' });
        if (e.kind === 'shunt' && routeSignalled(route)) issues.push({ level: 'warn', code: 'shuntOverLine', text: 'This goes along a line between signal boxes, so it needs block signalling: make it a Run.' });
        for (const c of e.calls) {
          if (!layout.places.some((p) => p.id === c.placeId)) issues.push({ level: 'error', code: 'missingCall', text: 'It calls at a place that is no longer on the layout.' });
        }
      }
      if (e.kind === 'enter' && ends.to?.kind === 'place') {
        const p = layout.places.find((x) => x.id === (ends.to as { placeId: string }).placeId);
        if (p && p.kind !== 'fiddleYard') issues.push({ level: 'warn', code: 'enterNotYard', text: `Trains usually come on to the layout in a fiddle yard; ${p.name} is not one.` });
      }
      if (isTimed(tt) && train) {
        if (e.dep === null) issues.push({ level: 'warn', code: 'noTime', text: 'No time given: it runs straight after the move before it.' });
        if (e.dep !== null && e.arr !== null && e.arr < e.dep) issues.push({ level: 'error', code: 'arrBeforeDep', text: 'It arrives before it departs.' });
        const t0 = lastTimeOf.get(train.id);
        if (e.dep !== null && t0 !== undefined && e.dep < t0) issues.push({ level: 'error', code: 'timeOrder', text: `It departs before ${train.name}’s move before it has finished.` });
        const tEnd = e.arr ?? e.dep;
        if (tEnd !== null) lastTimeOf.set(train.id, tEnd);
      }
      if (train && ends.to) {
        const key = unitKey(train);
        // A road someone else is still standing on (a warning: fitting trains in is the signaller's job).
        if (ends.to.kind === 'place' && ends.to.roadId) {
          const taken = [...pos.entries()].find(([k, p]) => k !== key && p.kind === 'place' && p.placeId === (ends.to as TtPos & { kind: 'place' }).placeId && p.roadId === (ends.to as TtPos & { kind: 'place' }).roadId);
          if (taken) {
            const other = units.find((u) => u.key === taken[0]);
            const name = other ? trainsName(tt, other) : 'another train';
            issues.push({ level: 'warn', code: 'roadTaken', text: `${refText(state, ends.to)} still has ${name} standing on it.` });
          }
        }
        pos.set(key, ends.to);
      }
    }
    steps.push({ entry: e, index, step, issues, route, after: new Map(pos) });
  });
  let errors = 0;
  let warnings = 0;
  for (const s of steps) for (const i of s.issues) i.level === 'error' ? errors++ : warnings++;
  for (const list of trainIssues.values()) for (const i of list) i.level === 'error' ? errors++ : warnings++;
  return { units, steps, trainIssues, errors, warnings };
}

function trainsName(tt: Timetable, u: TtUnit): string {
  return u.trainIds.map((id) => findTrain(tt, id)?.name).filter(Boolean).join(' / ') || 'another train';
}

/** "2 problems, 1 warning", or "No problems found". */
export function issuesSummary(w: Pick<TtWalk, 'errors' | 'warnings'>): string {
  if (!w.errors && !w.warnings) return 'No problems found';
  return [w.errors ? plural(w.errors, 'problem') : '', w.warnings ? plural(w.warnings, 'warning') : ''].filter(Boolean).join(', ');
}

/**
 * The stock positions at the start: where each loco must stand before the first move, and whether it
 * stands there now in the roster. Trains worked by "any loco" are listed with no loco.
 */
export function stockPositions(state: AppState, layout: Layout, tt: Timetable, w = walkTimetable(state, layout, tt)) {
  return w.units.map((u) => {
    const loco = u.locoId ? state.roster.find((l) => l.id === u.locoId) : undefined;
    const now = loco?.location;
    const there =
      !!loco &&
      (u.start.kind === 'off'
        ? now?.kind === 'offLayout'
        : now?.kind === 'place' && now.placeId === u.start.placeId && (!u.start.roadId || now.roadId === u.start.roadId));
    return { unit: u, loco, start: u.start, there, startText: posText(state, u.start), trains: u.trainIds.map((id) => findTrain(tt, id)!).filter(Boolean) };
  });
}

/** Put every named loco where the timetable starts it (in the app). Returns how many moved. */
export function applyStockPositions(state: AppState, layout: Layout, tt: Timetable): number {
  let n = 0;
  for (const s of stockPositions(state, layout, tt)) {
    if (!s.loco || s.there) continue;
    const l = state.roster.find((x) => x.id === s.loco!.id)!;
    l.location = s.start.kind === 'off' ? { kind: 'offLayout' } : { kind: 'place', placeId: s.start.placeId, roadId: s.start.roadId };
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- the public poster

export interface PosterCell {
  /** Departure / arrival times (minutes), when timed. */
  dep: number | null;
  arr: number | null;
  /** The train passes without stopping. */
  pass: boolean;
  /** It starts / ends here. */
  first: boolean;
  last: boolean;
}

export interface PosterColumn {
  entry: TimetableEntry;
  train: TimetableTrain | undefined;
  /** Position in the timetable (from 1): shown instead of times in a sequence timetable. */
  order: number;
  cells: Map<string, PosterCell>;
}

export interface PosterTable {
  /** Places down the side, in running order. */
  rows: Place[];
  cols: PosterColumn[];
  title: string;
}

/** The places a run serves, in order: where it starts, calls and passes, and ends. */
function runStops(e: TimetableEntry): Array<{ placeId: string; cell: PosterCell }> {
  const out: Array<{ placeId: string; cell: PosterCell }> = [];
  out.push({ placeId: e.from.placeId, cell: { dep: e.dep, arr: null, pass: false, first: true, last: false } });
  for (const c of e.calls) out.push({ placeId: c.placeId, cell: { dep: c.dep, arr: c.arr, pass: !c.stop, first: false, last: false } });
  out.push({ placeId: e.to.placeId, cell: { dep: null, arr: e.arr, pass: false, first: false, last: true } });
  // The same place twice in a row (a call at the start or end place) is one stop.
  return out.filter((s, i) => s.placeId && (i === 0 || s.placeId !== out[i - 1].placeId));
}

const isSubsequence = (small: string[], big: string[]) => {
  let i = 0;
  for (const x of big) if (x === small[i]) i++;
  return i === small.length;
};

/**
 * The poster's tables: runs grouped by the way they run, places down the side in running order, one
 * column per train. `which` picks passenger trains (the public timetable) or the rest (goods and
 * other trains). Columns are in time order (or the timetable's order for a sequence).
 */
export function posterTables(state: AppState, layout: Layout, tt: Timetable, which: 'passenger' | 'other'): PosterTable[] {
  const runs = tt.entries
    .map((e, i) => ({ e, order: i + 1 }))
    .filter(({ e }) => e.kind === 'run' && e.from.placeId && e.to.placeId && PASSENGER_TYPES.has(e.trainTypeId) === (which === 'passenger'));
  const withStops = runs.map((r) => ({ ...r, stops: runStops(r.e) })).filter((r) => r.stops.length >= 2 && r.stops.every((s) => layout.places.some((p) => p.id === s.placeId)));
  const tables: Array<{ rows: string[]; cols: PosterColumn[] }> = [];
  for (const r of [...withStops].sort((a, b) => b.stops.length - a.stops.length || a.order - b.order)) {
    const seq = r.stops.map((s) => s.placeId);
    let t = tables.find((x) => isSubsequence(seq, x.rows));
    if (!t) {
      t = { rows: seq, cols: [] };
      tables.push(t);
    }
    t.cols.push({ entry: r.e, train: findTrain(tt, r.e.trainId), order: r.order, cells: new Map(r.stops.map((s) => [s.placeId, s.cell])) });
  }
  const key = (c: PosterColumn) => (isTimed(tt) ? (c.entry.dep ?? c.entry.arr ?? 0) * 1000 + c.order : c.order);
  return tables.map((t) => {
    const rows = t.rows.map((id) => layout.places.find((p) => p.id === id)!);
    return { rows, cols: t.cols.sort((a, b) => key(a) - key(b)), title: `${rows[0].name} to ${rows[rows.length - 1].name}` };
  });
}

/** Poster times in the old style: "9.05", and whether it is morning ("a.m.") or afternoon ("p.m."). */
export function posterTime(min: number | null, tt: Pick<Timetable, 'timing' | 'elapsed'>): { text: string; half: 'am' | 'pm' | '' } {
  if (min === null) return { text: '', half: '' };
  if (tt.timing === 'session' && tt.elapsed) return { text: `${Math.floor(min / 60)}.${pad(min % 60)}`, half: '' };
  const m = ((min % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { text: `${h12}.${pad(m % 60)}`, half: h24 < 12 ? 'am' : 'pm' };
}

/** A call at a place, for the editor: "Sigsim Central (passes)". */
export function callText(state: AppState, c: TimetableCall): string {
  return `${refText(state, c)} (${c.stop ? 'stops' : 'passes'})`;
}
