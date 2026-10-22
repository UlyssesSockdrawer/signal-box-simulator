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

/** Box circuits within the clearing point inside the home signals of one line: those beginning less than the clearing point in. */
export function clearingPointCircuits(state: AppState, layout: Layout, box: BoxDef, connId: string): Set<string> {
  const cp = layoutClearingPoint(layout);
  const out = new Set<string>();
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
        out.add(n.circuitId);
        open.push({ d: n, at: at + circuitLength(state, layout, c).metres });
      }
    }
  }
  return out;
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
