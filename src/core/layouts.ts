import { emptyPlan } from './trackPlan';
import type { AppState, BoxDef, FiddleYard, Layout, TrackPlan } from './types';

/*
 * Layouts: each model railway set up in the app has its own name, fiddle yards
 * and track plan. A signal box stands on one layout at most (BoxDef.layoutId).
 * One layout is active: its boxes are the ones offered under Open a signal box,
 * and its name is shown on the main menu. The loco roster is shared by every
 * layout; a loco's location says which layout it is on (through the yard or box).
 */

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export const MAX_YARDS = 8;
export const MAX_ROADS = 24;

export function findLayout(state: AppState, id: string | undefined | null): Layout | undefined {
  return id ? state.layouts.find((l) => l.id === id) : undefined;
}

/** The active layout, if one is chosen and still exists. */
export function activeLayout(state: AppState): Layout | undefined {
  return findLayout(state, state.settings.activeLayoutId);
}

/** The layout a box stands on, if any. */
export function layoutOfBox(state: AppState, box: BoxDef | undefined): Layout | undefined {
  return box ? findLayout(state, box.layoutId) : undefined;
}

export function boxesOn(state: AppState, layoutId: string): BoxDef[] {
  return state.boxes.filter((b) => b.layoutId === layoutId);
}

/** Boxes not on any layout yet. */
export function unassignedBoxes(state: AppState): BoxDef[] {
  return state.boxes.filter((b) => !findLayout(state, b.layoutId));
}

/** Every fiddle yard on every layout. */
export function allYards(state: AppState): FiddleYard[] {
  return state.layouts.flatMap((l) => l.fiddleYards);
}

export function findYard(state: AppState, yardId: string | undefined): FiddleYard | undefined {
  if (!yardId) return undefined;
  for (const l of state.layouts) {
    const y = l.fiddleYards.find((x) => x.id === yardId);
    if (y) return y;
  }
  return undefined;
}

export function layoutOfYard(state: AppState, yardId: string): Layout | undefined {
  return state.layouts.find((l) => l.fiddleYards.some((y) => y.id === yardId));
}

/** Yards a box's connections can run to: those on its layout (none when it is not on a layout). */
export function yardsForBox(state: AppState, box: BoxDef): FiddleYard[] {
  return layoutOfBox(state, box)?.fiddleYards ?? [];
}

/** `base`, or `base 2`, `base 3`… whichever is not already taken. */
function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map(norm));
  if (!used.has(norm(base))) return base;
  for (let n = 2; ; n++) if (!used.has(norm(`${base} ${n}`))) return `${base} ${n}`;
}

// ---------------------------------------------------------------- validation

export function checkLayoutName(state: AppState, name: string, layoutId: string | null): string | null {
  if (!name.trim()) return 'Enter a name for the layout.';
  if (name.trim().length > 60) return 'Keep it to 60 characters or fewer.';
  if (state.layouts.some((l) => l.id !== layoutId && norm(l.name) === norm(name))) return `There is already a layout called ${name.trim()}.`;
  return null;
}

export function checkYardName(layout: Layout, name: string, yardId: string | null): string | null {
  if (!name.trim()) return 'Enter a name for the fiddle yard.';
  if (layout.fiddleYards.some((y) => y.id !== yardId && norm(y.name) === norm(name))) return `${layout.name} already has a fiddle yard called ${name.trim()}.`;
  return null;
}

// ---------------------------------------------------------------- changes

/** Add an empty layout with a safe default name. The first layout made becomes the active one. */
export function addLayout(state: AppState, name?: string): Layout {
  const layout: Layout = {
    id: newId('layout'),
    name: name?.trim() || uniqueName('New layout', state.layouts.map((l) => l.name)),
    fiddleYards: [],
    trackPlan: emptyPlan(),
    running: 'left',
  };
  state.layouts.push(layout);
  if (!activeLayout(state)) state.settings.activeLayoutId = layout.id;
  return layout;
}

/**
 * Remove a layout. Its boxes stay (not on a layout); trains in its fiddle yards go off layout;
 * connections that ran to its yards now serve a location on the layout instead.
 */
export function deleteLayout(state: AppState, layoutId: string): void {
  const layout = findLayout(state, layoutId);
  if (!layout) return;
  const yardIds = new Set(layout.fiddleYards.map((y) => y.id));
  for (const l of state.roster) if (l.location.kind === 'fiddleYard' && yardIds.has(l.location.yardId)) l.location = { kind: 'offLayout' };
  for (const b of state.boxes) {
    if (b.layoutId === layoutId) b.layoutId = '';
    for (const c of b.connections) if (yardIds.has(c.fiddleYardId)) c.fiddleYardId = '';
  }
  state.layouts = state.layouts.filter((l) => l.id !== layoutId);
  if (state.settings.activeLayoutId === layoutId) state.settings.activeLayoutId = state.layouts[0]?.id ?? '';
}

export function setActiveLayout(state: AppState, layoutId: string): void {
  state.settings.activeLayoutId = findLayout(state, layoutId) ? layoutId : '';
}

/** What a box has on a track plan: track (its own, its lines, its connected boxes'), points, exits to its lines, and its signal boxes drawn on the plan. */
export interface PlanUsage {
  circuits: number;
  junctions: number;
  exits: number;
  markers: number;
}

const refersTo = (boxId: string) => (o: { boxId: string } | { kind: string }) => 'boxId' in o && o.boxId === boxId;

export function boxPlanUsage(plan: TrackPlan, boxId: string): PlanUsage {
  const mine = refersTo(boxId);
  return {
    circuits: plan.circuits.filter((c) => mine(c.owner)).length,
    // Plain joints are not counted (they are wiped too, but nobody thinks of them as the box's).
    junctions: plan.junctions.filter((j) => j.boxId === boxId && j.kind !== 'joint').length,
    exits: plan.circuits.reduce((n, c) => n + c.ends.filter((e) => e.kind === 'exit' && mine(e.to)).length, 0),
    markers: (plan.markers ?? []).filter((m) => m.box.boxId === boxId).length,
  };
}

export const usageCount = (u: PlanUsage) => u.circuits + u.junctions + u.exits + u.markers;

/** Wipe a box from a track plan: its track and points become unassigned, exits to its lines lead off the scene, its signal boxes leave the plan. */
export function clearBoxFromPlan(plan: TrackPlan, boxId: string): void {
  const mine = refersTo(boxId);
  for (const c of plan.circuits) {
    if (mine(c.owner)) c.owner = { kind: 'none' };
    for (const e of c.ends) if (e.kind === 'exit' && mine(e.to)) e.to = { kind: 'offScene' };
  }
  for (const j of plan.junctions) {
    if (j.boxId !== boxId) continue;
    j.boxId = '';
    delete j.connectionId;
  }
  if (plan.markers) plan.markers = plan.markers.filter((m) => m.box.boxId !== boxId);
}

/** What moving a box to `layoutId` would clear: its assignments on every other layout's plan. */
export function moveBoxImpact(state: AppState, boxId: string, layoutId: string): Array<{ layout: Layout; usage: PlanUsage }> {
  return state.layouts
    .filter((l) => l.id !== layoutId)
    .map((layout) => ({ layout, usage: boxPlanUsage(layout.trackPlan, boxId) }))
    .filter((x) => usageCount(x.usage) > 0);
}

/**
 * Put a box on a layout ('' = no layout). Its track assignments on any other layout's plan are
 * wiped (the UI warns first, using moveBoxImpact). Connections that ran to a yard on the old
 * layout run to the new layout's first yard, or serve a location on the layout if it has none.
 */
export function setBoxLayout(state: AppState, boxId: string, layoutId: string): void {
  const box = state.boxes.find((b) => b.id === boxId);
  if (!box) return;
  const to = findLayout(state, layoutId) ? layoutId : '';
  if (box.layoutId === to) return;
  box.layoutId = to;
  for (const l of state.layouts) if (l.id !== to) clearBoxFromPlan(l.trackPlan, boxId);
  const yards = yardsForBox(state, box);
  for (const c of box.connections) if (c.fiddleYardId && !yards.some((y) => y.id === c.fiddleYardId)) c.fiddleYardId = yards[0]?.id ?? '';
}

export function addYard(state: AppState, layoutId: string, roads = 4): FiddleYard | null {
  const layout = findLayout(state, layoutId);
  if (!layout || layout.fiddleYards.length >= MAX_YARDS) return null;
  const base = layout.fiddleYards.length ? 'Fiddle yard' : 'Fiddle Yard';
  const yard: FiddleYard = {
    id: newId('fy'),
    name: uniqueName(base, layout.fiddleYards.map((y) => y.name)),
    roads: Array.from({ length: Math.max(1, Math.min(MAX_ROADS, roads)) }, (_, i) => ({ id: newId('road'), name: `Road ${i + 1}`, notes: '' })),
  };
  layout.fiddleYards.push(yard);
  return yard;
}

/** Trains standing in a yard (or one of its roads). */
export function yardOccupants(state: AppState, yardId: string, roadId?: string) {
  return state.roster.filter((l) => l.location.kind === 'fiddleYard' && l.location.yardId === yardId && (!roadId || l.location.roadId === roadId));
}

/** Trains standing in a yard's roads beyond the first `count` (the ones a smaller yard would lose). */
export function trainsBeyondRoad(state: AppState, yardId: string, count: number) {
  const yard = findYard(state, yardId);
  const gone = new Set((yard?.roads ?? []).slice(Math.max(0, count)).map((r) => r.id));
  return state.roster.filter((l) => l.location.kind === 'fiddleYard' && l.location.yardId === yardId && gone.has(l.location.roadId));
}

/** Send trains standing on these roads (all roads of the yard if none given) off the layout. Returns how many. */
function clearRoads(state: AppState, yardId: string, roadIds?: Set<string>): number {
  let n = 0;
  for (const l of state.roster) {
    if (l.location.kind === 'fiddleYard' && l.location.yardId === yardId && (!roadIds || roadIds.has(l.location.roadId))) {
      l.location = { kind: 'offLayout' };
      n++;
    }
  }
  return n;
}

/**
 * Remove a fiddle yard. Trains standing in it go off the layout (back to the roster).
 * Connections that ran to it serve a location on the layout instead. Returns how many trains went.
 */
export function removeYard(state: AppState, yardId: string): number {
  const layout = layoutOfYard(state, yardId);
  if (!layout) return 0;
  const n = clearRoads(state, yardId);
  layout.fiddleYards = layout.fiddleYards.filter((y) => y.id !== yardId);
  for (const b of state.boxes) for (const c of b.connections) if (c.fiddleYardId === yardId) c.fiddleYardId = '';
  return n;
}

/** Remove one road. Trains standing on it go off the layout. A yard keeps at least one road. Returns how many trains went. */
export function removeRoad(state: AppState, yardId: string, roadId: string): number {
  const yard = findYard(state, yardId);
  if (!yard || yard.roads.length <= 1 || !yard.roads.some((r) => r.id === roadId)) return 0;
  const n = clearRoads(state, yardId, new Set([roadId]));
  yard.roads = yard.roads.filter((r) => r.id !== roadId);
  return n;
}

/**
 * Set how many roads a yard has. New roads are added at the end, and roads are taken
 * away from the end; trains standing on a removed road go off the layout (the UI asks
 * first, using trainsBeyondRoad). Returns an error, or null.
 */
export function setYardRoadCount(state: AppState, yardId: string, count: number): string | null {
  const yard = findYard(state, yardId);
  if (!yard) return null;
  const n = Math.round(count);
  if (!Number.isFinite(n) || n < 1) return 'A fiddle yard needs at least one road.';
  if (n > MAX_ROADS) return `No more than ${MAX_ROADS} roads.`;
  while (yard.roads.length < n) yard.roads.push({ id: newId('road'), name: `Road ${yard.roads.length + 1}`, notes: '' });
  if (yard.roads.length > n) {
    clearRoads(state, yardId, new Set(yard.roads.slice(n).map((r) => r.id)));
    yard.roads = yard.roads.slice(0, n);
  }
  return null;
}
