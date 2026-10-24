import { circuitLength, layoutClearingPoint } from './railway';
import { boxSignals, lineCircuits, nextSteps, type Dir } from './routing';
import { findCircuit } from './trackPlan';
import type { AppState, BoxDef, Layout } from './types';

/*
 * STATION LIMITS (v0.3.32).
 *
 * A box's station limits are its own track: from its home signals out to its section (advanced
 * starting) signals. The block sections are the lines between. Inside the home signal the line must
 * be clear as far as the CLEARING POINT (440 yards in, editable per layout) before the box may accept
 * a train (give Line Clear). So:
 *  - shunting inside the station limits, over the clearing point (setting back, or drawing forward
 *    to clear points), needs the line blocked back first: 2-4 (Blocking back inside home signal) to
 *    the box in rear, then 2-1 (Obstruction removed) when clear again;
 *  - a movement out past the section signal on to the line ahead needs 3-3-2 (Shunt into forward
 *    section) to the box in advance, then 8 (Shunt withdrawn), or on a token line a token (5-2,
 *    then 2-5); out past the home signal on to the line in rear, 3-3 (Blocking back outside home signal).
 * A train's own signalled run (arriving off a line, or leaving on to the line it has Line Clear for)
 * needs none of these.
 */

/**
 * How much of a circuit lies within the clearing point (v0.3.39): the stretch within `metres` of its end
 * `end` (the end nearer the home signal). Measured to the metre, so a movement at the far end of a long
 * circuit inside the home signal does not foul the clearing point.
 */
export interface ClearingZone {
  end: 0 | 1;
  metres: number;
}

/** The clearing point inside the home signals of one line, circuit by circuit: circuit id → the stretches of it within the clearing point. */
export function clearingPointZones(state: AppState, layout: Layout, box: BoxDef, connId: string): Map<string, ClearingZone[]> {
  const cp = layoutClearingPoint(layout);
  const out = new Map<string, ClearingZone[]>();
  const homes = boxSignals(state, layout, box).filter((s) => s.kind === 'home' && s.connectionId === connId);
  for (const h of homes) {
    const open: Array<{ d: Dir; at: number }> = [{ d: { circuitId: h.circuitId, toward: h.end }, at: 0 }];
    const seen = new Set<string>();
    while (open.length) {
      const { d, at } = open.shift()!;
      for (const n of nextSteps(state, layout, d, { anyWay: true })) {
        const c = findCircuit(layout.trackPlan, n.circuitId);
        if (!c || c.owner.kind === 'line' || at >= cp - 0.5) continue;
        const k = `${n.circuitId}|${n.toward}`;
        if (seen.has(k)) continue;
        seen.add(k);
        // Entered from the home side towards n.toward: the clearing point reaches (cp - at) metres in from the end entered by.
        out.set(n.circuitId, [...(out.get(n.circuitId) ?? []), { end: (1 - n.toward) as 0 | 1, metres: cp - at }]);
        open.push({ d: n, at: at + circuitLength(state, layout, c).metres });
      }
    }
  }
  return out;
}

/** Box circuits within the clearing point inside the home signals of one line (wholly or in part). */
export function clearingPointCircuits(state: AppState, layout: Layout, box: BoxDef, connId: string): Set<string> {
  return new Set(clearingPointZones(state, layout, box, connId).keys());
}

/**
 * Does a stretch of a circuit foul the clearing point? The stretch is run towards `toward`, starting
 * `offset` metres in from the end it is entered by and `metres` long, in a circuit `full` metres long.
 */
export function stretchFouls(zones: ClearingZone[] | undefined, stretch: { toward: 0 | 1; metres: number; offset?: number }, full: number): boolean {
  if (!zones?.length) return false;
  const entry = (1 - stretch.toward) as 0 | 1;
  const a0 = stretch.offset ?? 0;
  const b0 = a0 + stretch.metres;
  return zones.some((z) => {
    const a = z.end === entry ? a0 : full - b0;
    return a < z.metres - 0.01;
  });
}

/** The line (connection) of a box that a circuit belongs to, or null. */
export function lineOf(layout: Layout, boxId: string, circuitId: string): string | null {
  const c = findCircuit(layout.trackPlan, circuitId);
  return c && c.owner.kind === 'line' && c.owner.boxId === boxId ? c.owner.connectionId : null;
}

/** Every line circuit of a box's connection, as a set. */
export function lineSet(layout: Layout, boxId: string, connId: string): Set<string> {
  return new Set(lineCircuits(layout, boxId, connId).map((c) => c.id));
}
