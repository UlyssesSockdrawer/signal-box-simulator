import type { AppState, BoxDef, ConnectionDef, Layout, Location, Loco, Place, PlaceKind, PlaceRoad, PlaceWorker } from './types';

/*
 * Places: everywhere on a layout that trains stand or are worked — stations, sidings,
 * goods yards and sheds, loco depots and fiddle yards. A place belongs to one layout and
 * is worked by any number of signal boxes (boxes you work, or the simulated far box of a
 * connection). A box may work no place at all (a junction box): trains arriving there stand
 * "at the box". A connection names the place its trains run to and come from (its far end).
 * Each place has roads; a road may be tied to a track circuit on the layout's plan.
 */

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export const MAX_PLACES = 40;
export const MAX_ROADS = 24;
export const PLACE_SHORT_MAX = 6;

export const PLACE_KINDS: Array<{ kind: PlaceKind; name: string; plural: string; newName: string; firstRoad: (n: number) => string }> = [
  { kind: 'station', name: 'Station', plural: 'Stations', newName: 'New station', firstRoad: (n) => `P${n}` },
  { kind: 'sidings', name: 'Sidings', plural: 'Sidings', newName: 'New sidings', firstRoad: (n) => `Road ${n}` },
  { kind: 'goods', name: 'Goods yard or shed', plural: 'Goods yards and sheds', newName: 'Goods yard', firstRoad: (n) => (n === 1 ? 'Shed road' : `Road ${n}`) },
  { kind: 'depot', name: 'Loco shed or depot', plural: 'Loco sheds and depots', newName: 'Loco shed', firstRoad: (n) => (n === 1 ? 'Shed road' : `Road ${n}`) },
  { kind: 'fiddleYard', name: 'Fiddle yard', plural: 'Fiddle yards', newName: 'Fiddle yard', firstRoad: (n) => `Road ${n}` },
  { kind: 'other', name: 'Other place', plural: 'Other places', newName: 'New place', firstRoad: (n) => `Road ${n}` },
];
export const kindInfo = (k: PlaceKind) => PLACE_KINDS.find((x) => x.kind === k) ?? PLACE_KINDS[PLACE_KINDS.length - 1];

/** `base`, or `base 2`, `base 3`… whichever is not already taken. */
function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map(norm));
  if (!used.has(norm(base))) return base;
  for (let n = 2; ; n++) if (!used.has(norm(`${base} ${n}`))) return `${base} ${n}`;
}

// ---------------------------------------------------------------- finding

export function allPlaces(state: AppState): Place[] {
  return state.layouts.flatMap((l) => l.places);
}

export function findPlace(state: AppState, placeId: string | undefined | null): Place | undefined {
  if (!placeId) return undefined;
  for (const l of state.layouts) {
    const p = l.places.find((x) => x.id === placeId);
    if (p) return p;
  }
  return undefined;
}

export function layoutOfPlace(state: AppState, placeId: string): Layout | undefined {
  return state.layouts.find((l) => l.places.some((p) => p.id === placeId));
}

export const findRoad = (place: Place | undefined, roadId: string | undefined): PlaceRoad | undefined => (place && roadId ? place.roads.find((r) => r.id === roadId) : undefined);

/** Every fiddle yard on every layout. */
export function allYards(state: AppState): Place[] {
  return allPlaces(state).filter((p) => p.kind === 'fiddleYard');
}

export const isYard = (p: Place | undefined) => p?.kind === 'fiddleYard';

const workerKey = (w: PlaceWorker) => (w.kind === 'box' ? `box|${w.boxId}` : `remote|${w.boxId}|${w.connectionId}`);
export const sameWorker = (a: PlaceWorker, b: PlaceWorker) => workerKey(a) === workerKey(b);
export const worksPlace = (p: Place, w: PlaceWorker) => p.workedBy.some((x) => sameWorker(x, w));

/** Places a box's layout has (none when the box is not on a layout): the choices for its connections. */
export function placesForBox(state: AppState, box: BoxDef): Place[] {
  return state.layouts.find((l) => l.id === box.layoutId)?.places ?? [];
}

/** Places worked by a box you work (on its own layout), in the order they appear on the layout. */
export function placesWorkedBy(state: AppState, boxId: string): Place[] {
  const box = state.boxes.find((b) => b.id === boxId);
  if (!box) return [];
  return placesForBox(state, box).filter((p) => worksPlace(p, { kind: 'box', boxId }));
}

/** The place at the far end of a connection, if it has one on the box's layout. */
export function farPlace(state: AppState, box: BoxDef, conn: ConnectionDef): Place | undefined {
  return placesForBox(state, box).find((p) => p.id === conn.placeId);
}

/** Who works a place, in words: "Becton", "Fiddle Yard (simulated)". */
export function workerName(state: AppState, w: PlaceWorker): string {
  const box = state.boxes.find((b) => b.id === w.boxId);
  if (w.kind === 'box') return box?.name ?? 'Unknown box';
  const c = box?.connections.find((x) => x.id === w.connectionId);
  return `${c?.neighbourName ?? 'Unknown box'} (simulated)`;
}

// ---------------------------------------------------------------- trains in places

export function placeOccupants(state: AppState, placeId: string, roadId?: string): Loco[] {
  return state.roster.filter((l) => l.location.kind === 'place' && l.location.placeId === placeId && (roadId === undefined || l.location.roadId === roadId));
}

/** Trains a box can send away: those in the places it works, and any standing at the box itself. */
export function boxLocos(state: AppState, boxId: string): Loco[] {
  const ids = new Set(placesWorkedBy(state, boxId).map((p) => p.id));
  return state.roster.filter((l) => (l.location.kind === 'place' && ids.has(l.location.placeId)) || (l.location.kind === 'atBox' && l.location.boxId === boxId));
}

/** "Becton · P1", "Fiddle Yard · Road 3", "Becton" (somewhere in it). */
export function placeLocationText(state: AppState, loc: Extract<Location, { kind: 'place' }>): string {
  const p = findPlace(state, loc.placeId);
  const r = findRoad(p, loc.roadId);
  return `${p?.name ?? 'Unknown place'}${r ? ` · ${r.name}` : ''}`;
}

/** Where an arriving train can be put at a box: the roads of the places it works (or the place itself when it has no roads). */
export function arrivalChoices(state: AppState, boxId: string): Array<{ placeId: string; roadId: string; label: string }> {
  return placesWorkedBy(state, boxId).flatMap((p) =>
    p.roads.length ? p.roads.map((r) => ({ placeId: p.id, roadId: r.id, label: `${p.name} · ${r.name}` })) : [{ placeId: p.id, roadId: '', label: p.name }],
  );
}

/** The button the operator presses when a train sent along a line has arrived at its far end. */
export function arrivedLabel(place: Place | undefined, neighbourName: string): string {
  if (!place) return `Arrived at ${neighbourName}`;
  return place.kind === 'fiddleYard' ? `Arrived in ${place.name}` : `Arrived at ${place.name}`;
}

// ---------------------------------------------------------------- validation

export function checkPlaceName(layout: Layout, name: string, placeId: string | null): string | null {
  if (!name.trim()) return 'Enter a name for the place.';
  if (name.trim().length > 60) return 'Keep it to 60 characters or fewer.';
  if (layout.places.some((p) => p.id !== placeId && norm(p.name) === norm(name))) return `${layout.name} already has a place called ${name.trim()}.`;
  return null;
}

export function checkPlaceShort(layout: Layout, short: string, placeId: string | null): string | null {
  if (!short.trim()) return null; // optional
  if (short.trim().length > PLACE_SHORT_MAX) return `Keep it to ${PLACE_SHORT_MAX} characters or fewer.`;
  if (layout.places.some((p) => p.id !== placeId && p.shortName && norm(p.shortName) === norm(short))) return `${short.trim().toUpperCase()} is already used by another place.`;
  return null;
}

export function checkRoadName(place: Place, name: string, roadId: string | null): string | null {
  if (!name.trim()) return 'Enter a name for the road.';
  if (name.trim().length > 30) return 'Keep it to 30 characters or fewer.';
  if (place.roads.some((r) => r.id !== roadId && norm(r.name) === norm(name))) return `${place.name} already has a road called ${name.trim()}.`;
  return null;
}

// ---------------------------------------------------------------- changes

/** Add a place to a layout, with a safe default name and roads. Returns it, or null when the layout is full. */
export function addPlace(state: AppState, layoutId: string, kind: PlaceKind, opts: { name?: string; roads?: number } = {}): Place | null {
  const layout = state.layouts.find((l) => l.id === layoutId);
  if (!layout || layout.places.length >= MAX_PLACES) return null;
  const info = kindInfo(kind);
  const roads = Math.max(0, Math.min(MAX_ROADS, opts.roads ?? (kind === 'fiddleYard' ? 4 : kind === 'other' ? 0 : 1)));
  const place: Place = {
    id: newId(kind === 'fiddleYard' ? 'fy' : 'place'),
    kind,
    name: opts.name?.trim() || uniqueName(info.newName, layout.places.map((p) => p.name)),
    shortName: '',
    notes: '',
    roads: Array.from({ length: roads }, (_, i) => ({ id: newId('road'), name: info.firstRoad(i + 1), notes: '' })),
    workedBy: [],
  };
  layout.places.push(place);
  return place;
}

/** Add a road with the next free default name (or the name given). Returns it, or null when the place has the most roads allowed. */
export function addRoad(place: Place, name?: string, circuitId?: string): PlaceRoad | null {
  if (place.roads.length >= MAX_ROADS) return null;
  const info = kindInfo(place.kind);
  let n = place.roads.length + 1;
  let auto = info.firstRoad(n);
  while (place.roads.some((r) => norm(r.name) === norm(auto))) auto = info.firstRoad(++n);
  const road: PlaceRoad = { id: newId('road'), name: name?.trim() || auto, notes: '' };
  if (circuitId) road.circuitId = circuitId;
  place.roads.push(road);
  return road;
}

/** Remove a road. Trains standing on it stay in the place (no longer on a named road). Returns how many trains that was. */
export function removeRoad(state: AppState, placeId: string, roadId: string): number {
  const place = findPlace(state, placeId);
  if (!place || !place.roads.some((r) => r.id === roadId)) return 0;
  let n = 0;
  for (const l of state.roster) {
    if (l.location.kind === 'place' && l.location.placeId === placeId && l.location.roadId === roadId) {
      l.location = { kind: 'place', placeId, roadId: '' };
      n++;
    }
  }
  place.roads = place.roads.filter((r) => r.id !== roadId);
  return n;
}

/** Trains standing on the roads a smaller place would lose. */
export function trainsBeyondRoad(state: AppState, placeId: string, count: number): Loco[] {
  const place = findPlace(state, placeId);
  const gone = new Set((place?.roads ?? []).slice(Math.max(0, count)).map((r) => r.id));
  return state.roster.filter((l) => l.location.kind === 'place' && l.location.placeId === placeId && gone.has(l.location.roadId));
}

/** Set how many roads a place has: new ones at the end, extra ones removed from the end (their trains stay in the place). Returns an error, or null. */
export function setRoadCount(state: AppState, placeId: string, count: number): string | null {
  const place = findPlace(state, placeId);
  if (!place) return null;
  const n = Math.round(count);
  if (!Number.isFinite(n) || n < 0) return 'Enter a number of roads.';
  if (place.kind === 'fiddleYard' && n < 1) return 'A fiddle yard needs at least one road.';
  if (n > MAX_ROADS) return `No more than ${MAX_ROADS} roads.`;
  while (place.roads.length < n) addRoad(place);
  while (place.roads.length > n) removeRoad(state, placeId, place.roads[place.roads.length - 1].id);
  return null;
}

/**
 * Remove a place. Trains standing in it go off the layout (back to the roster); connections
 * that ran to it no longer have a place at the far end. Returns how many trains went.
 */
export function removePlace(state: AppState, placeId: string): number {
  const layout = layoutOfPlace(state, placeId);
  if (!layout) return 0;
  let n = 0;
  for (const l of state.roster) {
    if (l.location.kind === 'place' && l.location.placeId === placeId) {
      l.location = { kind: 'offLayout' };
      n++;
    }
  }
  layout.places = layout.places.filter((p) => p.id !== placeId);
  for (const b of state.boxes) for (const c of b.connections) if (c.placeId === placeId) c.placeId = '';
  return n;
}

/** Turn a box (or a connection's far box) working a place on or off. */
export function setWorker(place: Place, w: PlaceWorker, on: boolean): void {
  const has = worksPlace(place, w);
  if (on && !has) place.workedBy.push(structuredClone(w));
  if (!on && has) place.workedBy = place.workedBy.filter((x) => !sameWorker(x, w));
}

/**
 * The place a connection's trains run to and come from. The far box is recorded as working it.
 * '' = none (trains come from and go back to the roster).
 */
export function setConnectionPlace(state: AppState, box: BoxDef, conn: ConnectionDef, placeId: string): void {
  const place = placesForBox(state, box).find((p) => p.id === placeId);
  conn.placeId = place ? place.id : '';
  if (place) setWorker(place, { kind: 'remote', boxId: box.id, connectionId: conn.id }, true);
}

/** Tie a road to a track circuit ('' to untie). A circuit is one road at most: it is untied from any other road on the layout. */
export function tieRoad(layout: Layout, placeId: string, roadId: string, circuitId: string): void {
  if (circuitId) for (const p of layout.places) for (const r of p.roads) if (r.circuitId === circuitId) delete r.circuitId;
  const road = layout.places.find((p) => p.id === placeId)?.roads.find((r) => r.id === roadId);
  if (!road) return;
  if (circuitId) road.circuitId = circuitId;
  else delete road.circuitId;
}

/** The place road a track circuit is tied to, if any. */
export function roadOfCircuit(layout: Layout, circuitId: string): { place: Place; road: PlaceRoad } | null {
  for (const place of layout.places) for (const road of place.roads) if (road.circuitId === circuitId) return { place, road };
  return null;
}

/**
 * Keep places consistent with the rest of the data: workers must be boxes (or connections) on the
 * place's layout, tied track circuits must exist, trains must stand in places and roads that exist,
 * and connections must run to a place on their box's layout.
 */
export function sanitisePlaces(state: AppState): void {
  for (const layout of state.layouts) {
    layout.places ??= [];
    const circuits = new Set(layout.trackPlan.circuits.map((c) => c.id));
    for (const p of layout.places) {
      p.roads ??= [];
      p.workedBy ??= [];
      p.notes ??= '';
      p.shortName ??= '';
      p.workedBy = p.workedBy.filter((w) => {
        const b = state.boxes.find((x) => x.id === w.boxId);
        if (!b || b.layoutId !== layout.id) return false;
        return w.kind === 'box' || b.connections.some((c) => c.id === w.connectionId);
      });
      for (const r of p.roads) if (r.circuitId && !circuits.has(r.circuitId)) delete r.circuitId;
    }
  }
  for (const b of state.boxes) for (const c of b.connections) if (c.placeId && !placesForBox(state, b).some((p) => p.id === c.placeId)) c.placeId = '';
  for (const l of state.roster) {
    const loc = l.location;
    if (loc.kind === 'place') {
      const p = findPlace(state, loc.placeId);
      if (!p) l.location = { kind: 'offLayout' };
      else if (loc.roadId && !p.roads.some((r) => r.id === loc.roadId)) loc.roadId = '';
    } else if (loc.kind === 'atBox' && !state.boxes.some((b) => b.id === loc.boxId)) l.location = { kind: 'offLayout' };
  }
}
