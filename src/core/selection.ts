import { boxLocos, placeOccupants } from './places';
import type { AppState, ConnectionDef, Loco, SelectionMode } from './types';

/**
 * Strategies for choosing the next incoming train from the place at the far end of a line.
 * Add a 'timetable' strategy here later (exhibition running plans): it only
 * needs to implement IncomingSelector.
 */
export interface IncomingSelector {
  id: SelectionMode | string;
  name: string;
  /** Suggest a loco id from the candidates, or null to let the user choose. */
  suggest(candidates: Loco[], state: AppState): string | null;
}

export const manualSelector: IncomingSelector = {
  id: 'manual',
  name: 'Manual (you choose)',
  suggest: () => null,
};

export const randomSelector = (random: () => number = Math.random): IncomingSelector => ({
  id: 'random',
  name: 'Random',
  suggest: (c) => (c.length ? c[Math.floor(random() * c.length)].id : null),
});

export const SELECTORS: Record<string, IncomingSelector> = {
  manual: manualSelector,
  random: randomSelector(),
};

/**
 * Trains that could be offered in over a connection: those in the place at its far end
 * (fiddle yard, or a place worked by the far box), or from the roster when the line has no place.
 */
export function incomingCandidates(state: AppState, conn: ConnectionDef): Loco[] {
  if (conn.placeId) return placeOccupants(state, conn.placeId);
  return state.roster.filter((l) => l.location.kind === 'offLayout');
}

/** Trains a box can send away: in the places it works, or standing at the box. */
export function stationLocos(state: AppState, boxId: string): Loco[] {
  return boxLocos(state, boxId);
}
