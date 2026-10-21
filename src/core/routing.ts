import { circuitLength } from './railway';
import { findCircuit, findJunction, JUNCTIONS, portsOf, portUse, straightOn } from './trackPlan';
import type { AppState, BoxDef, CircuitEnd, Junction, Layout, TrackCircuit } from './types';

/*
 * ROUTING over a layout's track plan, for simulated running (signaller play mode).
 *
 * The plan is a graph: track circuits are edges, junctions are nodes, and each junction kind lists
 * the routes between its ports (core/trackPlan.ts JUNCTIONS; a turntable's deck joins any road to
 * any other). A train moves along a circuit TOWARDS one of its ends, so the search runs over
 * directed circuits { circuitId, toward }. Up and down lines may only be run along in their own
 * direction (TrackCircuit.traffic); circuits with no traffic set can be run either way.
 *
 * SIGNALS (implicit until signals can be placed on the plan): where a block section's line circuits
 * meet the box's own track there is a HOME signal for trains coming off the line, and a SECTION
 * (starting) signal on each road that leads on to the line, for trains leaving. A signal stands at
 * the end of the circuit it protects the way out of, facing trains running towards that end.
 */

/** A track circuit and the end a train on it is running towards. */
export interface Dir {
  circuitId: string;
  toward: 0 | 1;
}

/** A junction passed between two circuits: entered by one port, left by another. */
export interface Passing {
  junctionId: string;
  from: string;
  to: string;
}

/**
 * One circuit of a path: run towards `toward`, entered through `via` (null for the first). `reverse`:
 * the train stops at the end of the circuit it is in and comes back along it the other way (a shunt
 * setting back, e.g. out of a goods yard into a neck and back on to the main line).
 */
export interface Step extends Dir {
  metres: number;
  via: Passing | null;
  reverse?: boolean;
}

/** What a reversal costs in a route search (metres): taken only when there is no way round. */
const REVERSE_COST = 400;
/** What taking the diverging road of points costs (metres): through trains keep to the main line. */
const DIVERGE_COST = 150;

/** The ports a train can leave a junction by, having entered by `port`. */
export function portsFrom(j: Junction, port: string): string[] {
  if (j.kind === 'turntable') return portsOf(j).map((p) => p.id).filter((id) => id !== port);
  return JUNCTIONS[j.kind].routes.flatMap((r) => (r.a === port ? [r.b] : r.b === port ? [r.a] : []));
}

/** May a train run along this circuit towards this end? (Up and down lines only one way.) */
export function canRun(c: TrackCircuit, toward: 0 | 1): boolean {
  return !c.traffic || c.traffic.toward === toward;
}

/** The end a train running along a circuit is heading for. */
export function endAhead(layout: Layout, d: Dir): CircuitEnd | undefined {
  return findCircuit(layout.trackPlan, d.circuitId)?.ends[d.toward];
}

/** Where a train can go next from the end of a circuit it is running along. */
export function nextSteps(state: AppState, layout: Layout, d: Dir, opts: { anyWay?: boolean } = {}): Step[] {
  const plan = layout.trackPlan;
  const e = endAhead(layout, d);
  if (!e || e.kind !== 'joined') return [];
  const j = findJunction(plan, e.junctionId);
  if (!j) return [];
  const out: Step[] = [];
  for (const to of portsFrom(j, e.port)) {
    const u = portUse(plan, j.id, to);
    if (!u || u.circuit.id === d.circuitId) continue;
    const toward = (1 - u.end) as 0 | 1;
    if (!opts.anyWay && !canRun(u.circuit, toward)) continue;
    out.push({ circuitId: u.circuit.id, toward, metres: circuitLength(state, layout, u.circuit).metres, via: { junctionId: j.id, from: e.port, to } });
  }
  return out;
}

/**
 * The shortest path (by length) from a directed circuit to one the goal accepts. The path includes
 * the start. `blocked` circuits are not entered (the start is never blocked). Returns null if none.
 */
export function findPath(
  state: AppState,
  layout: Layout,
  start: Dir,
  goal: (d: Dir) => boolean,
  opts: {
    blocked?: (circuitId: string) => boolean;
    anyWay?: boolean;
    junctionFree?: (junctionId: string) => boolean;
    /** Circuits a train may reverse in (none unless given). */
    reverseIn?: (circuitId: string) => boolean;
  } = {},
): Step[] | null {
  const key = (d: Dir) => `${d.circuitId}|${d.toward}`;
  const c0 = findCircuit(layout.trackPlan, start.circuitId);
  if (!c0) return null;
  const first: Step = { ...start, metres: circuitLength(state, layout, c0).metres, via: null };
  const dist = new Map<string, number>([[key(start), 0]]);
  const prev = new Map<string, { from: string; step: Step }>();
  const steps = new Map<string, Step>([[key(start), first]]);
  const open: string[] = [key(start)];
  const done = new Set<string>();
  while (open.length) {
    open.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const k = open.shift()!;
    if (done.has(k)) continue;
    done.add(k);
    const s = steps.get(k)!;
    if (goal(s)) {
      const path: Step[] = [s];
      let cur = k;
      while (prev.has(cur)) {
        cur = prev.get(cur)!.from;
        path.unshift(steps.get(cur)!);
      }
      return path;
    }
    const around: Step[] = nextSteps(state, layout, s, { anyWay: opts.anyWay });
    if (opts.reverseIn?.(s.circuitId) && prev.has(k)) {
      const c = findCircuit(layout.trackPlan, s.circuitId)!;
      const back = (1 - s.toward) as 0 | 1;
      if (opts.anyWay || canRun(c, back)) around.push({ circuitId: s.circuitId, toward: back, metres: s.metres, via: null, reverse: true });
    }
    for (const n of around) {
      if (opts.blocked?.(n.circuitId)) continue;
      if (n.via && opts.junctionFree && !opts.junctionFree(n.via.junctionId)) continue;
      const nk = key(n);
      // A little extra for every junction passed, so the straighter of two equal routes is taken.
      const j = n.via ? findJunction(layout.trackPlan, n.via.junctionId) : undefined;
      const diverging = !!j && j.kind !== 'joint' && straightOn(j, n.via!.from) !== n.via!.to;
      const nd = dist.get(k)! + s.metres + 1 + (n.reverse ? REVERSE_COST : 0) + (diverging ? DIVERGE_COST : 0);
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { from: k, step: n });
        steps.set(nk, n);
        open.push(nk);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------- lines and signals

/** A block section's line circuits on the plan (owner: that line of that box). */
export function lineCircuits(layout: Layout, boxId: string, connId: string): TrackCircuit[] {
  return layout.trackPlan.circuits.filter((c) => c.owner.kind === 'line' && c.owner.boxId === boxId && c.owner.connectionId === connId);
}

/** Where trains come on to the plan from the far end of a line: its line circuits' exits, facing in. */
export function lineEntries(layout: Layout, boxId: string, connId: string): Dir[] {
  const out: Dir[] = [];
  for (const c of lineCircuits(layout, boxId, connId))
    c.ends.forEach((e, i) => {
      const toward = (1 - i) as 0 | 1;
      if (e.kind === 'exit' && canRun(c, toward)) out.push({ circuitId: c.id, toward });
    });
  return out;
}

/** Does a train running along this circuit leave the scene at its end (over an exit)? */
export function leavesScene(layout: Layout, d: Dir): boolean {
  return endAhead(layout, d)?.kind === 'exit';
}

export interface SignalDef {
  id: string;
  boxId: string;
  connectionId: string;
  /** home: protects the box's track from trains off the line; section: lets trains on to the line. */
  kind: 'home' | 'section';
  /** It stands at this end of this circuit, for trains running towards that end. */
  circuitId: string;
  end: 0 | 1;
  /** e.g. "Home from Fiddle Yard West", "Section signal to Fiddle Yard East (P1)". */
  name: string;
}

/**
 * The implicit signals of a box on its layout's plan: a home signal where each line's circuits
 * meet the box's track, and a section signal on each of the box's roads leading on to a line.
 */
export function boxSignals(state: AppState, layout: Layout, box: BoxDef): SignalDef[] {
  const out: SignalDef[] = [];
  const seen = new Set<string>();
  const plan = layout.trackPlan;
  for (const conn of box.connections) {
    const line = new Set(lineCircuits(layout, box.id, conn.id).map((c) => c.id));
    for (const id of line) {
      const l = findCircuit(plan, id)!;
      for (const end of [0, 1] as const) {
        const toward = end;
        if (!canRun(l, toward)) continue;
        // Trains off the line into the box's track at this end?
        const ahead = nextSteps(state, layout, { circuitId: l.id, toward }).filter((n) => !line.has(n.circuitId));
        const into = ahead.filter((n) => findCircuit(plan, n.circuitId)?.owner.kind !== 'line');
        if (into.length) {
          const hid = `home:${conn.id}:${l.id}:${end}`;
          if (!seen.has(hid)) {
            seen.add(hid);
            out.push({ id: hid, boxId: box.id, connectionId: conn.id, kind: 'home', circuitId: l.id, end, name: `Home from ${conn.neighbourName}` });
          }
        }
      }
      // Roads that lead on to the line at either end: a section signal at their end.
      for (const end of [0, 1] as const) {
        const e = l.ends[end];
        if (e.kind !== 'joined') continue;
        const j = findJunction(plan, e.junctionId);
        if (!j) continue;
        for (const port of portsFrom(j, e.port)) {
          const u = portUse(plan, j.id, port);
          if (!u || line.has(u.circuit.id) || u.circuit.owner.kind === 'line') continue;
          const n = u.circuit;
          const toward = u.end;
          if (!canRun(n, toward) || !canRun(l, (1 - end) as 0 | 1)) continue;
          const sid = `sec:${conn.id}:${n.id}:${toward}`;
          if (seen.has(sid)) continue;
          seen.add(sid);
          out.push({ id: sid, boxId: box.id, connectionId: conn.id, kind: 'section', circuitId: n.id, end: toward, name: `Section signal to ${conn.neighbourName} (${n.name || n.code})` });
        }
      }
    }
  }
  return out;
}

/**
 * What stops a layout and box being run in signaller play mode, in words ([] = ready): the box must
 * be on a layout with a plan; every line must have its circuits drawn, coming on to the plan over an
 * exit and meeting the box's track; and a box that works places needs their roads tied to circuits.
 */
export function playReadiness(state: AppState, box: BoxDef): string[] {
  const layout = state.layouts.find((l) => l.id === box.layoutId);
  if (!layout) return [`${box.name} is not on a layout.`];
  if (!layout.trackPlan.circuits.length) return [`No track has been drawn for ${layout.name} yet.`];
  const out: string[] = [];
  const signals = boxSignals(state, layout, box);
  for (const conn of box.connections) {
    const line = lineCircuits(layout, box.id, conn.id);
    if (!line.length) {
      out.push(`The line to ${conn.neighbourName} has no track circuits on the plan (give them to that line in Box areas).`);
      continue;
    }
    if (!lineEntries(layout, box.id, conn.id).length) out.push(`The line to ${conn.neighbourName} does not leave the plan over an exit.`);
    if (!signals.some((s) => s.connectionId === conn.id && s.kind === 'home')) out.push(`The line to ${conn.neighbourName} does not meet ${box.name}'s track.`);
  }
  const worked = layout.places.filter((p) => p.workedBy.some((w) => w.kind === 'box' && w.boxId === box.id));
  if (worked.length && !worked.some((p) => p.roads.some((r) => r.circuitId && findCircuit(layout.trackPlan, r.circuitId))))
    out.push(`None of the roads of the places ${box.name} works is tied to a track circuit (Places tab, or the circuit's "Road of a place").`);
  return out;
}

/**
 * Model railway mode: the track circuits occupied by what you have reported, with no detection: a
 * loco standing on a road tied to a circuit, and a train in a block section on that line's circuits.
 */
export function reportedOccupancy(state: AppState, layoutId: string): string[] {
  const layout = state.layouts.find((l) => l.id === layoutId);
  if (!layout) return [];
  const out = new Set<string>();
  for (const l of state.roster) {
    const loc = l.location;
    if (loc.kind === 'place') {
      const c = layout.places.find((p) => p.id === loc.placeId)?.roads.find((r) => r.id === loc.roadId)?.circuitId;
      if (c && findCircuit(layout.trackPlan, c)) out.add(c);
    } else if (loc.kind === 'section') {
      const box = state.boxes.find((b) => b.layoutId === layoutId && b.connections.some((c) => c.id === loc.connectionId));
      if (box) for (const c of lineCircuits(layout, box.id, loc.connectionId)) out.add(c.id);
    }
  }
  return [...out];
}
