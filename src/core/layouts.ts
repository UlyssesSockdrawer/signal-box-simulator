import { placesForBox, sanitisePlaces, setConnectionPlace } from './places';
import { emptyPlan } from './trackPlan';
import type { AppState, BoxDef, Layout, TrackPlan } from './types';

/*
 * Layouts: each model railway set up in the app has its own name, places
 * (stations, sidings, goods yards, depots, fiddle yards: see places.ts) and track
 * plan. A signal box stands on one layout at most (BoxDef.layoutId).
 * One layout is active: its boxes are the ones offered under Open a signal box,
 * and its name is shown on the main menu. The loco roster is shared by every
 * layout; a loco's location says which layout it is on (through its place or box).
 */

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

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

// ---------------------------------------------------------------- changes

/** Add an empty layout with a safe default name. The first layout made becomes the active one. */
export function addLayout(state: AppState, name?: string): Layout {
  const layout: Layout = {
    id: newId('layout'),
    name: name?.trim() || uniqueName('New layout', state.layouts.map((l) => l.name)),
    places: [],
    trackPlan: emptyPlan(),
    running: 'left',
    timetables: [],
  };
  state.layouts.push(layout);
  if (!activeLayout(state)) state.settings.activeLayoutId = layout.id;
  return layout;
}

/**
 * Remove a layout. Its boxes stay (not on a layout); trains in its places go off the layout;
 * connections that ran to its places no longer have a place at the far end.
 */
export function deleteLayout(state: AppState, layoutId: string): void {
  const layout = findLayout(state, layoutId);
  if (!layout) return;
  const placeIds = new Set(layout.places.map((p) => p.id));
  for (const l of state.roster) if (l.location.kind === 'place' && placeIds.has(l.location.placeId)) l.location = { kind: 'offLayout' };
  for (const b of state.boxes) {
    if (b.layoutId === layoutId) b.layoutId = '';
    for (const c of b.connections) if (placeIds.has(c.placeId)) c.placeId = '';
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
 * wiped (the UI warns first, using moveBoxImpact), and it no longer works places there.
 * Connections that ran to a place on the old layout run to the new layout's first fiddle yard,
 * or have no place at the far end if it has none.
 */
export function setBoxLayout(state: AppState, boxId: string, layoutId: string): void {
  const box = state.boxes.find((b) => b.id === boxId);
  if (!box) return;
  const to = findLayout(state, layoutId) ? layoutId : '';
  if (box.layoutId === to) return;
  box.layoutId = to;
  for (const l of state.layouts) if (l.id !== to) clearBoxFromPlan(l.trackPlan, boxId);
  const places = placesForBox(state, box);
  for (const c of box.connections) {
    if (c.placeId && !places.some((p) => p.id === c.placeId)) c.placeId = '';
    if (!c.placeId) setConnectionPlace(state, box, c, places.find((p) => p.kind === 'fiddleYard')?.id ?? '');
  }
  // Trains standing at the box (it worked no place) stay with it; it stops working places on other layouts.
  sanitisePlaces(state);
}
