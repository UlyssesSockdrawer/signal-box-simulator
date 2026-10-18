import type { AppState, ConnectionDef, Loco, SelectionMode } from './types';

/**
 * Strategies for choosing the next incoming train from the fiddle yard.
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

/** Locos standing in the fiddle yard served by a connection. */
export function fiddleYardCandidates(state: AppState, yardId: string): Loco[] {
  return state.roster.filter((l) => l.location.kind === 'fiddleYard' && l.location.yardId === yardId);
}

/** Locos standing at the layout location served by the far box of a connection with no fiddle yard. */
export function farBoxLocos(state: AppState, connectionId: string): Loco[] {
  return state.roster.filter((l) => l.location.kind === 'farBox' && l.location.connectionId === connectionId);
}

/** Trains that could be offered in over a connection: from its fiddle yard, or from the location its far box serves. */
export function incomingCandidates(state: AppState, conn: ConnectionDef): Loco[] {
  return conn.fiddleYardId ? fiddleYardCandidates(state, conn.fiddleYardId) : farBoxLocos(state, conn.id);
}

export function stationLocos(state: AppState, boxId: string): Loco[] {
  return state.roster.filter((l) => l.location.kind === 'station' && l.location.boxId === boxId);
}
