import { findPath, lineEntries, nextSteps } from './routing';
import { findCircuit } from './trackPlan';
import type { AppState, Layout, PlaceRef } from './types';

/*
 * ENGINE RELEASE ON THE PLAN (v0.3.35), for planning (the timetable generator): where the engine of a
 * train coming in off a line stands in the road it is put in, and whether it can get away from there
 * by itself. Worked out on the track plan with nothing else on it (the railway, when it runs, deals
 * with what is in the way: core/railwaySim.ts).
 *
 *  - canLeave: the engine can get out of the road by the end it stands at (it is not at buffer stops),
 *    e.g. over a release crossover to a siding or the shed;
 *  - canRunRound: it can run round its train: out by that end and back into the road at its other end,
 *    by a loop or release crossover, setting back in the box's own track where it must.
 *
 * A road not tied to the plan (or a box with no plan) is taken to be fine: nothing is known about it.
 */

export interface EngineRelease {
  /** The road is on the plan and the way in from the line was found. */
  known: boolean;
  canLeave: boolean;
  canRunRound: boolean;
}

export function engineRelease(state: AppState, layout: Layout, boxId: string, connId: string, road: PlaceRef): EngineRelease {
  const fine: EngineRelease = { known: false, canLeave: true, canRunRound: true };
  const c = layout.places.find((p) => p.id === road.placeId)?.roads.find((r) => r.id === road.roadId)?.circuitId;
  if (!c || !findCircuit(layout.trackPlan, c)) return fine;
  const line = (id: string) => findCircuit(layout.trackPlan, id)?.owner.kind === 'line';
  // The way in off the line: the engine ends up at the end of the road it ran towards, or, when the
  // train set back into it (an odd number of times), at the end it came in by.
  let end: 0 | 1 | null = null;
  for (const entry of lineEntries(layout, boxId, connId)) {
    const p = findPath(state, layout, entry, (d) => d.circuitId === c, { reverseIn: (x) => !line(x) && x !== c });
    if (p) {
      const flips = p.filter((x) => x.reverse).length % 2 === 1;
      const last = p[p.length - 1].toward;
      end = (flips ? 1 - last : last) as 0 | 1;
      break;
    }
  }
  if (end === null) return fine;
  const e = end;
  const out = nextSteps(state, layout, { circuitId: c, toward: e }, { anyWay: true }).filter((n) => !line(n.circuitId));
  const canLeave = out.length > 0;
  const round =
    canLeave &&
    !!findPath(state, layout, { circuitId: c, toward: e }, (d) => d.circuitId === c && d.toward === e, {
      anyWay: true,
      notStart: true,
      blocked: (x) => x !== c && line(x),
      enter: (d) => d.circuitId !== c || d.toward === e,
      reverseIn: (x) => x !== c && !line(x),
    });
  return { known: true, canLeave, canRunRound: round };
}
