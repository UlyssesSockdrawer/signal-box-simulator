import { OccupancyBoard } from '../core/occupancy';
import { RailwaySim } from '../core/railwaySim';
import { realScheduler } from '../core/scheduler';
import type { Ctx } from './app';
import { peekRunner } from './timetableRuntime';

/*
 * One railway per layout, kept for the app session (like the boxes' running state): its track
 * occupancy board, and the simulated railway that runs trains through its plan for boxes worked in
 * signaller play mode. The board is also where model railway mode's hand-marked circuits go.
 */
export interface LayoutRailway {
  layoutId: string;
  board: OccupancyBoard;
  sim: RailwaySim;
}

const railways = new Map<string, LayoutRailway>();

export function getLayoutRailway(ctx: Ctx, layoutId: string): LayoutRailway {
  let r = railways.get(layoutId);
  if (r) return r;
  const store = ctx.store;
  const board = new OccupancyBoard();
  const sim = new RailwaySim({
    getState: () => store.state,
    scheduler: realScheduler,
    layoutId,
    board,
    update: (fn) => store.update(fn),
    hints: {
      arrival: (boxId, connId, locoId) => peekRunner(layoutId)?.arrivalHint(boxId, connId, locoId) ?? null,
      farRoad: (boxId, connId, locoId) => peekRunner(layoutId)?.departureRoad(boxId, connId, locoId) ?? '',
    },
  });
  r = { layoutId, board, sim };
  railways.set(layoutId, r);
  return r;
}

export function peekLayoutRailway(layoutId: string | undefined): LayoutRailway | undefined {
  return layoutId ? railways.get(layoutId) : undefined;
}

/** Stop every railway (before all data is reset or replaced). */
export function disposeAllRailways(): void {
  for (const r of railways.values()) r.sim.dispose();
  railways.clear();
}
