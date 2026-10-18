import { findLayout, yardsForBox } from './layouts';
import { layoutShelf } from './shelf';
import { newId } from './store';
import { sanitiseTrackPlan } from './trackPlan';
import type { AppState, BoxDef, ConnectionDef } from './types';

/*
 * Adding, checking and removing user-operated signal boxes and their
 * connections to neighbouring boxes. Pure data: the configurator and box
 * list call these, and the tests exercise them directly.
 */

export const MAX_SHELF_POSITIONS = 8;
export const SHORT_NAME_MAX = 6;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** `base`, or `base 2`, `base 3`… (or BASE2 for short names) — whichever is not already taken. */
export function uniqueName(base: string, taken: string[], joiner = ' ', maxLen = Infinity): string {
  const used = new Set(taken.map(norm));
  if (!used.has(norm(base))) return base;
  for (let n = 2; ; n++) {
    const suffix = `${joiner}${n}`;
    const candidate = base.slice(0, Math.max(1, maxLen - suffix.length)) + suffix;
    if (!used.has(norm(candidate))) return candidate;
  }
}

/** True when a box connects to at least one other box, so it can be opened. */
export function canOpenBox(box: BoxDef): boolean {
  return box.connections.length > 0;
}

/** Does this connection run to a fiddle yard? ('' means its far box serves a location on the layout instead.) */
export function servesFiddleYard(c: ConnectionDef): boolean {
  return !!c.fiddleYardId;
}

/**
 * Layout locations served by far boxes: every connection with no fiddle yard, plus any
 * connection that still has trains standing at its location (e.g. after being switched to a yard).
 */
export function farBoxLocations(state: AppState): Array<{ box: BoxDef; conn: ConnectionDef }> {
  const out: Array<{ box: BoxDef; conn: ConnectionDef }> = [];
  for (const box of state.boxes) {
    for (const conn of box.connections) {
      const occupied = state.roster.some((l) => l.location.kind === 'farBox' && l.location.connectionId === conn.id);
      if (!servesFiddleYard(conn) || occupied) out.push({ box, conn });
    }
  }
  return out;
}

// ---------------------------------------------------------------- validation
// Each returns an error message, or null when the value is fine.

export function checkBoxName(state: AppState, name: string, boxId: string | null): string | null {
  if (!name.trim()) return 'Enter a name for the box.';
  if (state.boxes.some((b) => b.id !== boxId && norm(b.name) === norm(name))) return `There is already a box called ${name.trim()}.`;
  return null;
}

export function checkBoxShort(state: AppState, short: string, boxId: string | null): string | null {
  if (!short.trim()) return 'Enter a short name.';
  if (short.trim().length > SHORT_NAME_MAX) return `Keep it to ${SHORT_NAME_MAX} characters or fewer.`;
  if (state.boxes.some((b) => b.id !== boxId && norm(b.shortName) === norm(short))) return `${short.trim().toUpperCase()} is already used by another box.`;
  return null;
}

export function checkShelfPositions(box: BoxDef, raw: string): string | null {
  const v = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(v)) return 'Enter a number of positions.';
  if (!Number.isInteger(v)) return 'Use a whole number.';
  if (v < 1) return 'A box needs at least one shelf position.';
  if (v > MAX_SHELF_POSITIONS) return `No more than ${MAX_SHELF_POSITIONS} positions.`;
  if (v < box.connections.length) return `This box has ${box.connections.length} connected boxes, so it needs at least ${box.connections.length} positions.`;
  return null;
}

export function checkConnName(box: BoxDef, name: string, connId: string | null): string | null {
  if (!name.trim()) return 'Enter the name of the box at the other end.';
  if (norm(name) === norm(box.name)) return `${box.name} cannot be connected to itself.`;
  if (box.connections.some((c) => c.id !== connId && norm(c.neighbourName) === norm(name))) return `${box.name} is already connected to ${name.trim()}.`;
  return null;
}

export function checkConnShort(box: BoxDef, short: string, connId: string | null): string | null {
  if (!short.trim()) return 'Enter a short name.';
  if (short.trim().length > SHORT_NAME_MAX) return `Keep it to ${SHORT_NAME_MAX} characters or fewer.`;
  if (norm(short) === norm(box.shortName)) return `${short.trim().toUpperCase()} is this box's own short name.`;
  if (box.connections.some((c) => c.id !== connId && norm(c.neighbourShort) === norm(short))) return `${short.trim().toUpperCase()} is already used by another connection.`;
  return null;
}

// ---------------------------------------------------------------- changes

/** Add a new user-operated box with safe default names, on a layout ('' = none). Returns it. */
export function addBox(state: AppState, layoutId = ''): BoxDef {
  const box: BoxDef = {
    id: newId('box'),
    layoutId: findLayout(state, layoutId) ? layoutId : '',
    name: uniqueName('New box', state.boxes.map((b) => b.name)),
    shortName: uniqueName('NEW', state.boxes.map((b) => b.shortName), '', SHORT_NAME_MAX),
    description: '',
    stationNotes: '',
    shelfPositions: 3,
    connections: [],
  };
  state.boxes.push(box);
  return box;
}

/**
 * Add a connection to a neighbouring box, in the first free shelf position.
 * If the shelf is full it gains a position (up to the maximum). Returns the
 * connection, or null when the shelf is already at its maximum and full.
 */
export function addConnection(state: AppState, box: BoxDef): ConnectionDef | null {
  let slots = layoutShelf(box);
  let free = slots.indexOf(null);
  if (free < 0) {
    if (box.shelfPositions >= MAX_SHELF_POSITIONS) return null;
    box.shelfPositions = Math.max(box.shelfPositions, box.connections.length) + 1;
    slots = layoutShelf(box);
    free = slots.indexOf(null);
  }
  const conn: ConnectionDef = {
    id: newId('conn'),
    neighbourName: uniqueName('Connected box', [box.name, ...box.connections.map((c) => c.neighbourName)]),
    neighbourShort: uniqueName('CB', [box.shortName, ...box.connections.map((c) => c.neighbourShort)], '', SHORT_NAME_MAX),
    lineType: 'single',
    fiddleYardId: yardsForBox(state, box)[0]?.id ?? '',
    defaultWorking: 'ab',
    shelfPosition: free,
  };
  box.connections.push(conn);
  return conn;
}

export function removeConnection(state: AppState, boxId: string, connId: string): void {
  const box = state.boxes.find((b) => b.id === boxId);
  if (!box) return;
  box.connections = box.connections.filter((c) => c.id !== connId);
  delete state.settings.workingModes[connId];
  // Trains standing at the location that connection served have nowhere left on the layout.
  for (const l of state.roster) if (l.location.kind === 'farBox' && l.location.connectionId === connId) l.location = { kind: 'offLayout' };
  // Track that was the line to that box, or left the scene towards it, no longer has anywhere to go.
  sanitiseTrackPlan(state);
}

/** Remove a box. The last box cannot be removed. Locos in its station, or at locations only it connects to, go off the layout. */
export function deleteBox(state: AppState, boxId: string): boolean {
  if (state.boxes.length <= 1) return false;
  const box = state.boxes.find((b) => b.id === boxId);
  if (!box) return false;
  for (const c of box.connections) delete state.settings.workingModes[c.id];
  state.boxes = state.boxes.filter((b) => b.id !== boxId);
  for (const l of state.roster) {
    if ((l.location.kind === 'station' || l.location.kind === 'farBox') && l.location.boxId === boxId) l.location = { kind: 'offLayout' };
  }
  sanitiseTrackPlan(state);
  return true;
}

/** Change the number of shelf positions, moving any instrument beyond the end to the nearest free position. */
export function setShelfPositions(box: BoxDef, count: number): void {
  box.shelfPositions = Math.max(1, Math.min(MAX_SHELF_POSITIONS, Math.round(count)));
  box.shelfPositions = Math.max(box.shelfPositions, box.connections.length);
  layoutShelf(box).forEach((c, i) => {
    if (c) c.shelfPosition = i;
  });
}

/** Put a connection in a shelf position; whatever was there swaps into its old place. */
export function moveConnection(box: BoxDef, connId: string, position: number): void {
  const slots = layoutShelf(box);
  const from = slots.findIndex((c) => c?.id === connId);
  if (from < 0 || position < 0 || position >= slots.length) return;
  const other = slots[position];
  slots[position] = slots[from];
  slots[from] = other;
  slots.forEach((c, i) => {
    if (c) c.shelfPosition = i;
  });
}
