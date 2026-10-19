// Track plan: the layout drawn as abstract track circuits joined by junctions.
// Pure logic (no DOM): geometry for drawing, editing operations, checks.
//
// Graph: circuits are edges, junctions are nodes. Each junction kind has named
// ports and a set of routes (which ports a train can run between). Every port
// is joined to at most one circuit end. A port with nothing joined, and a
// circuit end of kind 'open', are unfinished ends: the editor shows a + there.

import type { AppState, BoxMarker, CircuitEnd, ExitTarget, Junction, JunctionKind, Layout, MarkerBox, RunningLine, RunningSide, TrackCircuit, TrackOwner, TrackPlan } from './types';

// ---------------------------------------------------------------- catalogue

export interface PortDef {
  id: string;
  label: string;
  /** Position relative to the junction, in grid units, with the toe facing left. */
  x: number;
  y: number;
  /** Direction the track leaves the junction from this port (unit steps). */
  dx: number;
  dy: number;
}

export interface RouteDef {
  a: string;
  b: string;
  /** Drawn path in local units (toe facing left). */
  path: Array<[number, number]>;
  /** A slip road: drawn as a curve between its two ports. */
  slip?: boolean;
}

export interface JunctionDef {
  kind: JunctionKind;
  name: string;
  /** Short description for menus. */
  sub: string;
  ports: PortDef[];
  routes: RouteDef[];
  /** The port that joins on when the junction is added to the end of a track. */
  entry: string;
  /** Ports in line with the entry, used when the junction is put into the middle of a track. */
  through?: string;
  /** Extra drawing only (local units), e.g. the trap blade of catch points. */
  stubs?: Array<Array<[number, number]>>;
}

const toe: PortDef = { id: 'toe', label: 'Toe', x: 0, y: 0, dx: -1, dy: 0 };

export const JUNCTIONS: Record<JunctionKind, JunctionDef> = {
  joint: {
    kind: 'joint',
    name: 'Joint',
    sub: 'Two track circuits meet end to end',
    ports: [
      { id: 'a', label: 'One side', x: 0, y: 0, dx: -1, dy: 0 },
      { id: 'b', label: 'Other side', x: 0, y: 0, dx: 1, dy: 0 },
    ],
    routes: [{ a: 'a', b: 'b', path: [[0, 0], [0, 0]] }],
    entry: 'a',
    through: 'b',
  },
  pointsRight: {
    kind: 'pointsRight',
    name: 'Right-hand points',
    sub: 'Turnout to the right',
    ports: [toe, { id: 'normal', label: 'Normal (straight)', x: 1, y: 0, dx: 1, dy: 0 }, { id: 'reverse', label: 'Reverse (turnout)', x: 1, y: 1, dx: 1, dy: 1 }],
    routes: [
      { a: 'toe', b: 'normal', path: [[0, 0], [1, 0]] },
      { a: 'toe', b: 'reverse', path: [[0, 0], [1, 1]] },
    ],
    entry: 'toe',
    through: 'normal',
  },
  pointsLeft: {
    kind: 'pointsLeft',
    name: 'Left-hand points',
    sub: 'Turnout to the left',
    ports: [toe, { id: 'normal', label: 'Normal (straight)', x: 1, y: 0, dx: 1, dy: 0 }, { id: 'reverse', label: 'Reverse (turnout)', x: 1, y: -1, dx: 1, dy: -1 }],
    routes: [
      { a: 'toe', b: 'normal', path: [[0, 0], [1, 0]] },
      { a: 'toe', b: 'reverse', path: [[0, 0], [1, -1]] },
    ],
    entry: 'toe',
    through: 'normal',
  },
  pointsY: {
    kind: 'pointsY',
    name: 'Y points',
    sub: 'Both roads diverge',
    ports: [toe, { id: 'left', label: 'Left road', x: 1, y: -1, dx: 1, dy: -1 }, { id: 'right', label: 'Right road', x: 1, y: 1, dx: 1, dy: 1 }],
    routes: [
      { a: 'toe', b: 'left', path: [[0, 0], [1, -1]] },
      { a: 'toe', b: 'right', path: [[0, 0], [1, 1]] },
    ],
    entry: 'toe',
  },
  threeWay: {
    kind: 'threeWay',
    name: 'Three-way points',
    sub: 'One toe, three roads',
    ports: [
      toe,
      { id: 'left', label: 'Left road', x: 1, y: -1, dx: 1, dy: -1 },
      { id: 'straight', label: 'Straight road', x: 1, y: 0, dx: 1, dy: 0 },
      { id: 'right', label: 'Right road', x: 1, y: 1, dx: 1, dy: 1 },
    ],
    routes: [
      { a: 'toe', b: 'left', path: [[0, 0], [1, -1]] },
      { a: 'toe', b: 'straight', path: [[0, 0], [1, 0]] },
      { a: 'toe', b: 'right', path: [[0, 0], [1, 1]] },
    ],
    entry: 'toe',
    through: 'straight',
  },
  diamond: {
    kind: 'diamond',
    name: 'Diamond crossing',
    sub: 'Two lines cross',
    ports: crossingPorts(),
    routes: crossingRoutes(0),
    entry: 'a',
    through: 'c',
  },
  singleSlip: {
    kind: 'singleSlip',
    name: 'Single slip',
    sub: 'Diamond with one slip road',
    ports: crossingPorts(),
    routes: crossingRoutes(1),
    entry: 'a',
    through: 'c',
  },
  doubleSlip: {
    kind: 'doubleSlip',
    name: 'Double slip',
    sub: 'Diamond with both slip roads',
    ports: crossingPorts(),
    routes: crossingRoutes(2),
    entry: 'a',
    through: 'c',
  },
  scissors: {
    kind: 'scissors',
    name: 'Scissors crossover',
    sub: 'Crossovers both ways between two lines',
    ports: [
      { id: 'a', label: 'A (upper left)', x: -2, y: 0, dx: -1, dy: 0 },
      { id: 'b', label: 'B (upper right)', x: 2, y: 0, dx: 1, dy: 0 },
      { id: 'c', label: 'C (lower left)', x: -2, y: 3, dx: -1, dy: 0 },
      { id: 'd', label: 'D (lower right)', x: 2, y: 3, dx: 1, dy: 0 },
    ],
    routes: [
      { a: 'a', b: 'b', path: [[-2, 0], [2, 0]] },
      { a: 'c', b: 'd', path: [[-2, 3], [2, 3]] },
      { a: 'a', b: 'd', path: [[-2, 0], [-1.5, 0], [1.5, 3], [2, 3]] },
      { a: 'c', b: 'b', path: [[-2, 3], [-1.5, 3], [1.5, 0], [2, 0]] },
    ],
    entry: 'a',
    through: 'b',
  },
  catchPoints: {
    kind: 'catchPoints',
    name: 'Catch points',
    sub: 'Trap points: derail a runaway',
    ports: [
      { id: 'a', label: 'One side', x: 0, y: 0, dx: -1, dy: 0 },
      { id: 'b', label: 'Other side', x: 2, y: 0, dx: 1, dy: 0 },
    ],
    routes: [{ a: 'a', b: 'b', path: [[0, 0], [2, 0]] }],
    entry: 'a',
    through: 'b',
    stubs: [[[0.5, 0], [1.4, 0.7]]],
  },
  turntable: {
    kind: 'turntable',
    name: 'Turntable',
    sub: 'Up to eight roads round the deck',
    // Roads numbered clockwise from the entry road (on the left).
    ports: [
      { id: 'r4', label: 'Road 1 (entry)', x: -3, y: 0, dx: -1, dy: 0 },
      { id: 'r5', label: 'Road 2', x: -2, y: -2, dx: -1, dy: -1 },
      { id: 'r6', label: 'Road 3', x: 0, y: -3, dx: 0, dy: -1 },
      { id: 'r7', label: 'Road 4', x: 2, y: -2, dx: 1, dy: -1 },
      { id: 'r0', label: 'Road 5 (opposite)', x: 3, y: 0, dx: 1, dy: 0 },
      { id: 'r1', label: 'Road 6', x: 2, y: 2, dx: 1, dy: 1 },
      { id: 'r2', label: 'Road 7', x: 0, y: 3, dx: 0, dy: 1 },
      { id: 'r3', label: 'Road 8', x: -2, y: 2, dx: -1, dy: 1 },
    ],
    // The deck turns, so any road can lead to any other.
    routes: [],
    entry: 'r4',
    through: 'r0',
  },
};

/** Roads a new turntable starts with: entry, opposite, and one either side of the opposite road. */
export const TURNTABLE_DEFAULT_ROADS = ['r4', 'r0', 'r7', 'r1'];
/** The deck's radius in grid units (roads run from its edge to their ends). */
export const TURNTABLE_RADIUS = 2.3;

function crossingPorts(): PortDef[] {
  return [
    { id: 'a', label: 'A', x: -1, y: 0, dx: -1, dy: 0 },
    { id: 'c', label: 'C', x: 1, y: 0, dx: 1, dy: 0 },
    { id: 'b', label: 'B', x: -1, y: 1, dx: -1, dy: 1 },
    { id: 'd', label: 'D', x: 1, y: -1, dx: 1, dy: -1 },
  ];
}

function crossingRoutes(slips: 0 | 1 | 2): RouteDef[] {
  const r: RouteDef[] = [
    { a: 'a', b: 'c', path: [[-1, 0], [1, 0]] },
    { a: 'b', b: 'd', path: [[-1, 1], [1, -1]] },
  ];
  if (slips >= 1) r.push({ a: 'a', b: 'd', path: [[-1, 0], [0, 0], [1, -1]], slip: true });
  if (slips >= 2) r.push({ a: 'b', b: 'c', path: [[-1, 1], [0, 0], [1, 0]], slip: true });
  return r;
}

/** Junction kinds offered when growing the plan, in menu order. */
export const GROW_JUNCTIONS: JunctionKind[] = ['pointsRight', 'pointsLeft', 'pointsY', 'threeWay', 'singleSlip', 'doubleSlip', 'diamond', 'scissors', 'catchPoints', 'turntable'];
/** Junction kinds that can be put into the middle of an existing track. */
export const INSERT_JUNCTIONS: JunctionKind[] = ['pointsRight', 'pointsLeft', 'threeWay', 'diamond', 'singleSlip', 'doubleSlip', 'catchPoints', 'turntable'];
/** Kinds whose top-to-bottom mirror image is a different layout of the same kind (points change hand instead). */
export const MIRRORABLE: JunctionKind[] = ['diamond', 'singleSlip', 'doubleSlip', 'scissors', 'catchPoints'];

export function junctionName(j: Junction): string {
  const def = JUNCTIONS[j.kind];
  if (j.kind === 'joint') return 'Joint';
  if (j.kind === 'pointsRight' || j.kind === 'pointsLeft' || j.kind === 'pointsY' || j.kind === 'threeWay') return `Points ${j.number}`;
  return `${def.name} ${j.number}`;
}

export function circuitLabel(c: TrackCircuit): string {
  return c.name ? `${c.code} ${c.name}` : c.code;
}

// ---------------------------------------------------------------- geometry

export interface Pt {
  x: number;
  y: number;
}
export interface Anchor extends Pt {
  /** Direction the track leaves the anchor (0,0 for a free end). */
  dx: number;
  dy: number;
}

export function emptyPlan(): TrackPlan {
  return { circuits: [], junctions: [], markers: [] };
}

/** Apply a junction's mirror, quarter turn and half turn to a local offset or direction. */
export function orient(j: { rotate: boolean; mirror: boolean; quarter?: boolean }, x: number, y: number): Pt {
  let X = x;
  let Y = j.mirror ? -y : y;
  if (j.quarter) {
    // A quarter turn clockwise on the plan (y points down): east becomes south.
    const t = X;
    X = -Y;
    Y = t;
  }
  if (j.rotate) {
    X = -X;
    Y = -Y;
  }
  return { x: X + 0, y: Y + 0 };
}

export function localToWorld(j: Junction, x: number, y: number): Pt {
  const o = orient(j, x, y);
  return { x: j.x + o.x, y: j.y + o.y };
}

export function portDef(kind: JunctionKind, port: string): PortDef | undefined {
  return JUNCTIONS[kind].ports.find((p) => p.id === port);
}

/** The ports a particular junction has (a turntable only has the roads in use). */
export function portsOf(j: Junction): PortDef[] {
  const all = JUNCTIONS[j.kind].ports;
  if (j.kind !== 'turntable') return all;
  const roads = j.roads ?? TURNTABLE_DEFAULT_ROADS;
  return all.filter((p) => roads.includes(p.id));
}

export function portAnchor(j: Junction, port: string): Anchor | null {
  const p = portDef(j.kind, port);
  if (!p) return null;
  const w = localToWorld(j, p.x, p.y);
  const d = orient(j, p.dx, p.dy);
  return { ...w, dx: d.x, dy: d.y };
}

export function findJunction(plan: TrackPlan, id: string): Junction | undefined {
  return plan.junctions.find((j) => j.id === id);
}
export function findCircuit(plan: TrackPlan, id: string): TrackCircuit | undefined {
  return plan.circuits.find((c) => c.id === id);
}

export function endAnchor(plan: TrackPlan, end: CircuitEnd): Anchor | null {
  if (end.kind === 'joined') {
    const j = findJunction(plan, end.junctionId);
    return j ? portAnchor(j, end.port) : null;
  }
  return { x: end.x, y: end.y, dx: 0, dy: 0 };
}

/**
 * The drawn route of a circuit: straight if level, otherwise a horizontal run
 * with one 45° section. The 45° section goes at the end that leaves a
 * junction on a diagonal (a turnout road), else at the far end.
 */
export function circuitPath(plan: TrackPlan, c: TrackCircuit): Pt[] {
  const a = endAnchor(plan, c.ends[0]);
  const b = endAnchor(plan, c.ends[1]);
  if (!a || !b) return [];
  const keys: Pt[] = [pt(a), ...(c.via ?? []).map(pt), pt(b)];
  const out: Pt[] = [keys[0]];
  for (let i = 1; i < keys.length; i++) {
    const from = i === 1 ? a : null;
    const to = i === keys.length - 1 ? b : null;
    for (const q of leg(keys[i - 1], from, keys[i], to)) {
      const last = out[out.length - 1];
      if (last.x !== q.x || last.y !== q.y) out.push(q);
    }
  }
  if (out.length === 1) out.push(pt(b));
  return out;
}

/**
 * One stretch between two key points, drawn level/upright with one 45° section.
 * The 45° section goes where a road leads into it the right way; otherwise at the far end.
 */
function leg(p: Pt, pd: Anchor | null, q: Pt, qd: Anchor | null): Pt[] {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) return [q];
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (Math.abs(dx) > Math.abs(dy)) {
    const ady = Math.abs(dy);
    if (pd && pd.dy !== 0 && Math.sign(pd.dy) === sy) return [{ x: p.x + sx * ady, y: q.y }, q];
    return [{ x: q.x - sx * ady, y: p.y }, q];
  }
  const adx = Math.abs(dx);
  // Mostly up or down: leave a level or diagonal road at 45°, an upright one straight on.
  const atP = pd ? pd.dx !== 0 && Math.sign(pd.dx) === sx : !!qd && qd.dx === 0 && qd.dy !== 0;
  if (atP) return [{ x: q.x, y: p.y + sy * adx }, q];
  return [{ x: p.x, y: q.y - sy * adx }, q];
}

function pt(p: Pt): Pt {
  return { x: p.x, y: p.y };
}

/** Horizontal stretches of a circuit's drawn route. */
export function levelRuns(plan: TrackPlan, c: TrackCircuit): Array<{ y: number; x1: number; x2: number }> {
  const path = circuitPath(plan, c);
  const runs: Array<{ y: number; x1: number; x2: number }> = [];
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    if (p.y === q.y && p.x !== q.x) runs.push({ y: p.y, x1: Math.min(p.x, q.x), x2: Math.max(p.x, q.x) });
  }
  return runs;
}

/** Which circuit end (if any) is joined to a junction port. */
export function portUse(plan: TrackPlan, junctionId: string, port: string): { circuit: TrackCircuit; end: 0 | 1 } | null {
  for (const c of plan.circuits) {
    for (const e of [0, 1] as const) {
      const ce = c.ends[e];
      if (ce.kind === 'joined' && ce.junctionId === junctionId && ce.port === port) return { circuit: c, end: e };
    }
  }
  return null;
}

/** Junction ports with nothing joined to them. */
export function freePorts(plan: TrackPlan, j: Junction): PortDef[] {
  return portsOf(j).filter((p) => !portUse(plan, j.id, p.id));
}

/** The horizontal direction a free end points in (away from the rest of its circuit). */
export function endHeading(plan: TrackPlan, c: TrackCircuit, end: 0 | 1): Anchor | null {
  const path = circuitPath(plan, c);
  if (path.length < 2) return null;
  const p = end === 0 ? path[0] : path[path.length - 1];
  const q = end === 0 ? path[1] : path[path.length - 2];
  const dx = Math.sign(p.x - q.x);
  const dy = Math.sign(p.y - q.y);
  return { x: p.x, y: p.y, dx: dx || (dy ? 0 : 1), dy };
}

export function planBounds(plan: TrackPlan): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (p: Pt) => {
    xs.push(p.x);
    ys.push(p.y);
  };
  for (const c of plan.circuits) for (const p of circuitPath(plan, c)) add(p);
  for (const j of plan.junctions) {
    add(j);
    for (const p of portsOf(j)) add(localToWorld(j, p.x, p.y));
  }
  // Signal boxes drawn on the plan (the icon stands a little above its point).
  for (const m of plan.markers ?? []) {
    const p = markerPos(plan, m);
    add({ x: p.x - 1, y: p.y - 1.5 });
    add({ x: p.x + 1, y: p.y + 1 });
  }
  if (!xs.length) return null;
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// ---------------------------------------------------------------- naming

export function nextCode(plan: TrackPlan): string {
  let n = 0;
  for (const c of plan.circuits) {
    const m = /^T(\d+)$/i.exec(c.code.trim());
    if (m) n = Math.max(n, Number(m[1]));
  }
  let code = `T${n + 1}`;
  while (plan.circuits.some((c) => c.code.toUpperCase() === code)) code = `T${++n + 1}`;
  return code;
}

export function nextJunctionNumber(plan: TrackPlan): string {
  let n = 0;
  for (const j of plan.junctions) {
    if (j.kind === 'joint') continue;
    const v = Number(j.number);
    if (Number.isInteger(v)) n = Math.max(n, v);
  }
  return String(n + 1);
}

export const CODE_MAX = 8;

export function checkCircuitCode(plan: TrackPlan, code: string, circuitId: string | null): string | null {
  const v = code.trim();
  if (!v) return 'Give the track circuit a code, e.g. T3.';
  if (v.length > CODE_MAX) return `Keep it to ${CODE_MAX} characters.`;
  if (plan.circuits.some((c) => c.id !== circuitId && c.code.trim().toUpperCase() === v.toUpperCase())) return `${v} is already used by another track circuit.`;
  return null;
}

export function checkJunctionNumber(number: string): string | null {
  const v = number.trim();
  if (!v) return 'Give it a number, e.g. its lever number.';
  if (v.length > 6) return 'Keep it to 6 characters.';
  return null;
}

// ---------------------------------------------------------------- building

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function makeCircuit(plan: TrackPlan, a: CircuitEnd, b: CircuitEnd, owner: TrackOwner): TrackCircuit {
  const c: TrackCircuit = { id: newId('tc'), code: nextCode(plan), name: '', owner: structuredClone(owner), ends: [a, b] };
  plan.circuits.push(c);
  return c;
}

function makeJunction(plan: TrackPlan, kind: JunctionKind, x: number, y: number, rotate: boolean, w: Worker, quarter = false): Junction {
  const j: Junction = { id: newId('jn'), number: kind === 'joint' ? '' : nextJunctionNumber(plan), kind, boxId: w.boxId, x, y, rotate, mirror: false, quarter };
  if (w.boxId && w.connectionId) j.connectionId = w.connectionId;
  if (kind === 'turntable') j.roads = [...TURNTABLE_DEFAULT_ROADS];
  plan.junctions.push(j);
  return j;
}

/** Who works a junction: a box you work, or (with connectionId) the far box of one of its connections. */
export interface Worker {
  boxId: string;
  connectionId?: string;
}

/** The worker for junctions on track with this owner (track on a line between boxes gives none). */
export function workerOf(owner: TrackOwner): Worker {
  if (owner.kind === 'box') return { boxId: owner.boxId };
  if (owner.kind === 'remote') return { boxId: owner.boxId, connectionId: owner.connectionId };
  return { boxId: '' };
}

export function junctionWorker(j: Junction): Worker {
  return j.boxId && j.connectionId ? { boxId: j.boxId, connectionId: j.connectionId } : { boxId: j.boxId };
}

/** The owner for new track grown from a junction: whoever works the junction. */
export function ownerOfJunction(j: Junction): TrackOwner {
  if (j.boxId && j.connectionId) return { kind: 'remote', boxId: j.boxId, connectionId: j.connectionId };
  return j.boxId ? { kind: 'box', boxId: j.boxId } : { kind: 'none' };
}

/** A key for comparing owners and workers: '' for nobody, 'box|id', 'remote|box|conn', 'line|box|conn'. */
export function ownerKey(o: TrackOwner | Worker): string {
  if ('kind' in o) {
    if (o.kind === 'box') return `box|${o.boxId}`;
    if (o.kind === 'remote') return `remote|${o.boxId}|${o.connectionId}`;
    if (o.kind === 'line') return `line|${o.boxId}|${o.connectionId}`;
    return '';
  }
  if (!o.boxId) return '';
  return o.connectionId ? `remote|${o.boxId}|${o.connectionId}` : `box|${o.boxId}`;
}

export function setJunctionWorker(j: Junction, w: Worker): void {
  j.boxId = w.boxId;
  if (w.boxId && w.connectionId) j.connectionId = w.connectionId;
  else delete j.connectionId;
}

/** Lay a new, unconnected track circuit below everything else (or the first one on an empty plan). */
export function addTrack(plan: TrackPlan, owner: TrackOwner = { kind: 'none' }): TrackCircuit {
  const b = planBounds(plan);
  const x = b ? b.minX : 2;
  const y = b ? b.maxY + 3 : 4;
  return makeCircuit(plan, { kind: 'open', x, y }, { kind: 'open', x: x + 12, y }, owner);
}

/** What can be added at an unfinished end. */
export type GrowPiece = 'track' | 'curveLeft' | 'curveRight' | 'bufferStops' | 'exit' | JunctionKind;

export type OpenEndRef = { kind: 'end'; circuitId: string; end: 0 | 1 } | { kind: 'port'; junctionId: string; port: string };

/** Where an unfinished end is, and which way the track is heading there. */
export function openEndAnchor(plan: TrackPlan, ref: OpenEndRef): Anchor | null {
  if (ref.kind === 'port') {
    const j = findJunction(plan, ref.junctionId);
    return j ? portAnchor(j, ref.port) : null;
  }
  const c = findCircuit(plan, ref.circuitId);
  return c ? endHeading(plan, c, ref.end) : null;
}

export function isOpenEnd(plan: TrackPlan, ref: OpenEndRef): boolean {
  if (ref.kind === 'port') {
    const j = findJunction(plan, ref.junctionId);
    return !!j && portsOf(j).some((p) => p.id === ref.port) && !portUse(plan, j.id, ref.port);
  }
  const c = findCircuit(plan, ref.circuitId);
  return !!c && c.ends[ref.end].kind === 'open';
}

/** All unfinished ends in the plan. */
export function openEnds(plan: TrackPlan): OpenEndRef[] {
  const out: OpenEndRef[] = [];
  for (const c of plan.circuits) for (const e of [0, 1] as const) if (c.ends[e].kind === 'open') out.push({ kind: 'end', circuitId: c.id, end: e });
  for (const j of plan.junctions) for (const p of freePorts(plan, j)) out.push({ kind: 'port', junctionId: j.id, port: p.id });
  return out;
}

/** Step from an anchor along its heading, levelling out after the first diagonal step. */
function stepOut(a: Anchor, len: number, rise = 0): Pt {
  if (a.dx === 0 && a.dy !== 0) return { x: a.x, y: a.y + a.dy * len };
  const sx = a.dx || 1;
  return { x: a.x + sx * len, y: a.y + (a.dy ? a.dy * rise : 0) };
}

/**
 * Is a row of the grid clear between x1 and x2? Not clear if a track already runs
 * along it there, a junction sits on it there, or an unfinished level end on that
 * row points into the stretch (that line is going to carry on through it).
 */
function rowFree(plan: TrackPlan, y: number, x1: number, x2: number, skipJunction: string): boolean {
  for (const c of plan.circuits) for (const r of levelRuns(plan, c)) if (r.y === y && r.x2 > x1 - 1 && r.x1 < x2 + 1) return false;
  for (const j of plan.junctions) {
    if (j.id === skipJunction) continue;
    for (const p of portsOf(j)) {
      const w = localToWorld(j, p.x, p.y);
      if (w.y === y && w.x >= x1 - 1 && w.x <= x2 + 1) return false;
    }
  }
  for (const ref of openEnds(plan)) {
    if (ref.kind === 'port' && ref.junctionId === skipJunction) continue;
    const a = openEndAnchor(plan, ref);
    if (!a || a.dy !== 0 || a.y !== y) continue;
    if ((a.dx > 0 && a.x <= x2) || (a.dx < 0 && a.x >= x1)) return false;
  }
  return true;
}

/**
 * Where a new track off a junction road should end. Off a turnout road it climbs (or
 * drops) to one track spacing from the junction, unless that row is taken (for example
 * the left road of Y points on a branch would land back on the main line); then it
 * levels out sooner, on a clear row.
 */
function landFrom(plan: TrackPlan, junctionId: string, a: Anchor, len: number, kind?: JunctionKind): Pt {
  // Y and three-way points split both ways from one line, so their roads take half a
  // spacing each (a narrower fan, like an ordinary turnout's two roads).
  const fan = kind === 'pointsY' || kind === 'threeWay';
  const preferred = stepOut(a, len, fan ? 1 : 2);
  if (!a.dy || !a.dx) return preferred;
  const rises = fan ? [1, 0] : [2, 1, 0];
  const clear = (rise: number, margin: boolean) => {
    const far = stepOut(a, len, rise);
    const levelFrom = a.x + (a.dx || 1) * rise;
    const x1 = Math.min(levelFrom, far.x);
    const x2 = Math.max(levelFrom, far.x);
    const rows = margin ? [far.y - 1, far.y, far.y + 1] : [far.y];
    return rows.every((y) => rowFree(plan, y, x1, x2, junctionId)) ? far : null;
  };
  // Best: a row with a clear row either side. Then: any clear row. Else the usual spacing.
  for (const margin of [true, false]) for (const rise of rises) {
    const far = clear(rise, margin);
    if (far) return far;
  }
  return preferred;
}

/** Put a junction so that its entry port sits at `at`, facing along `heading`. */
function placeJunction(plan: TrackPlan, kind: JunctionKind, at: Pt, heading: { dx: number; dy: number }, w: Worker): Junction {
  const def = JUNCTIONS[kind];
  const entry = def.ports.find((p) => p.id === def.entry)!;
  // Turned to face the way the track is heading, so right-hand points still turn to the right.
  const o0 = orientFor(heading);
  const o = orient({ ...o0, mirror: false }, entry.x, entry.y);
  return makeJunction(plan, kind, at.x - o.x, at.y - o.y, o0.rotate, w, o0.quarter);
}

/** The turn that makes a junction's toe face back along a track heading this way. */
function orientFor(h: { dx: number; dy: number }): { rotate: boolean; quarter: boolean } {
  if (h.dx !== 0) return { rotate: h.dx < 0, quarter: false };
  if (h.dy > 0) return { rotate: false, quarter: true };
  if (h.dy < 0) return { rotate: true, quarter: true };
  return { rotate: false, quarter: false };
}

/**
 * Add a piece at an unfinished end. Returns the new item to select, or null if
 * the end was not unfinished.
 */
export function grow(plan: TrackPlan, ref: OpenEndRef, piece: GrowPiece, opts: { trailing?: boolean } = {}): { circuitId?: string; junctionId?: string } | null {
  const r = growFacing(plan, ref, piece);
  // Trailing: the track you grew from joins one of the junction's roads, and its toe faces onward.
  if (r?.junctionId && opts.trailing) turnRound(plan, r.junctionId);
  return r;
}

function growFacing(plan: TrackPlan, ref: OpenEndRef, piece: GrowPiece): { circuitId?: string; junctionId?: string } | null {
  if (!isOpenEnd(plan, ref)) return null;
  const a = openEndAnchor(plan, ref);
  if (!a) return null;

  if (ref.kind === 'end') {
    const c = findCircuit(plan, ref.circuitId)!;
    if (piece === 'bufferStops') {
      c.ends[ref.end] = { kind: 'bufferStops', x: a.x, y: a.y };
      return { circuitId: c.id };
    }
    if (piece === 'exit') {
      c.ends[ref.end] = { kind: 'exit', x: a.x, y: a.y, to: { kind: 'offScene' } };
      return { circuitId: c.id };
    }
    if (piece === 'curveLeft' || piece === 'curveRight') {
      // A curve must keep clear of other track: on the inside of a double-track curve the
      // line has to turn sooner, so pull this unfinished end back until it fits.
      const hd = { dx: Math.sign(a.dx), dy: a.dx === 0 ? Math.sign(a.dy) : 0 };
      const side = piece === 'curveLeft' ? 'left' : 'right';
      const e = c.ends[ref.end] as Extract<CircuitEnd, { kind: 'open' }>;
      const path = circuitPath(plan, c);
      const lastLen = path.length >= 2 ? Math.hypot(path[path.length - 1].x - path[path.length - 2].x, path[path.length - 1].y - path[path.length - 2].y) : 0;
      for (const back of [0, TRACK_SPACING, 2 * TRACK_SPACING]) {
        if (back && back > lastLen - 2) break;
        const st = { x: a.x - hd.dx * back, y: a.y - hd.dy * back };
        const pts = curvePoints({ ...st, ...hd }, side);
        if (!pathConflicts(plan, [st, ...pts], [c.id])) {
          if (back) {
            e.x = st.x;
            e.y = st.y;
            a.x = st.x;
            a.y = st.y;
          }
          break;
        }
      }
    }
    if (piece === 'track' || piece === 'curveLeft' || piece === 'curveRight') {
      // The line continues as a new circuit beyond a joint.
      const heading = { dx: Math.sign(a.dx), dy: a.dx === 0 ? Math.sign(a.dy) : 0 };
      const j = placeJunction(plan, 'joint', a, heading, workerOf(c.owner));
      c.ends[ref.end] = { kind: 'joined', junctionId: j.id, port: 'a' };
      const start: Anchor = { x: a.x, y: a.y, ...heading };
      const n =
        piece === 'track'
          ? makeCircuit(plan, { kind: 'joined', junctionId: j.id, port: 'b' }, { kind: 'open', ...stepOut(start, 8) }, c.owner)
          : curveFrom(plan, { kind: 'joined', junctionId: j.id, port: 'b' }, start, piece === 'curveLeft' ? 'left' : 'right', c.owner);
      return { circuitId: n.id };
    }
    const j = placeJunction(plan, piece, a, { dx: Math.sign(a.dx), dy: Math.sign(a.dy) }, workerOf(c.owner));
    c.ends[ref.end] = { kind: 'joined', junctionId: j.id, port: JUNCTIONS[piece].entry };
    return { junctionId: j.id };
  }

  // From a junction port: there must be a track circuit between the port and anything else.
  const j0 = findJunction(plan, ref.junctionId)!;
  const owner: TrackOwner = ownerOfJunction(j0);
  const from: CircuitEnd = { kind: 'joined', junctionId: j0.id, port: ref.port };
  if (piece === 'curveLeft' || piece === 'curveRight') return { circuitId: curveFrom(plan, from, a, piece === 'curveLeft' ? 'left' : 'right', owner).id };
  if (piece === 'track' || piece === 'bufferStops' || piece === 'exit') {
    const far = landFrom(plan, j0.id, a, piece === 'track' ? 8 : 6, j0.kind);
    const end: CircuitEnd =
      piece === 'track' ? { kind: 'open', ...far } : piece === 'bufferStops' ? { kind: 'bufferStops', ...far } : { kind: 'exit', ...far, to: { kind: 'offScene' } };
    const n = makeCircuit(plan, from, end, owner);
    return { circuitId: n.id };
  }
  const far = landFrom(plan, j0.id, a, 4, j0.kind);
  const n = makeCircuit(plan, from, { kind: 'open', ...far }, owner);
  const j = placeJunction(plan, piece, far, a.dx === 0 ? { dx: 0, dy: Math.sign(a.dy) } : { dx: Math.sign(a.dx), dy: 0 }, junctionWorker(j0));
  n.ends[1] = { kind: 'joined', junctionId: j.id, port: JUNCTIONS[piece].entry };
  return { junctionId: j.id };
}

/**
 * A track that turns a quarter turn to the left or right of the way it is heading:
 * a short straight, a bend (drawn as a curve), then on in the new direction.
 */
function curveFrom(plan: TrackPlan, from: CircuitEnd, a: Anchor, side: 'left' | 'right', owner: TrackOwner): TrackCircuit {
  const [bend, far] = curvePoints(a, side);
  const c = makeCircuit(plan, from, { kind: 'open', ...far }, owner);
  c.via = [bend];
  return c;
}

/** The bend and far end of a quarter-turn curve starting at an anchor. */
function curvePoints(a: Anchor, side: 'left' | 'right'): [Pt, Pt] {
  const hx = Math.sign(a.dx);
  const hy = Math.sign(a.dy);
  // Left of the direction of travel, on a plan whose y runs down the page.
  const n = side === 'left' ? { x: hy, y: -hx } : { x: -hy, y: hx };
  const run = hx !== 0 && hy !== 0 ? 2 : TRACK_SPACING;
  const bend = { x: a.x + hx * run, y: a.y + hy * run };
  return [bend, { x: bend.x + n.x * 5, y: bend.y + n.y * 5 }];
}

/** Would a new run of track (corner points, straight between) touch or cross existing track? */
function pathConflicts(plan: TrackPlan, pts: Pt[], ignore: string[]): boolean {
  const segs: Array<[Pt, Pt]> = [];
  for (const c of plan.circuits) {
    if (ignore.includes(c.id)) continue;
    const p = circuitPath(plan, c);
    for (let i = 1; i < p.length; i++) segs.push([p[i - 1], p[i]]);
  }
  const near = (q: Pt, [a, b]: [Pt, Pt]) => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / l2));
    return Math.hypot(a.x + vx * t - q.x, a.y + vy * t - q.y) < 0.3;
  };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let s = 0; s <= len; s += 0.25) {
      if (i === 1 && s < 0.6) continue;
      const q = { x: a.x + ((b.x - a.x) * s) / (len || 1), y: a.y + ((b.y - a.y) * s) / (len || 1) };
      if (segs.some((sg) => near(q, sg))) return true;
    }
  }
  return false;
}

/**
 * Join two unfinished ends together.
 * - two circuit ends: a joint where the first one is (the second circuit's end moves to it);
 * - a circuit end and a port: the circuit end joins the port;
 * - two ports: a new track circuit between them.
 */
export function joinOpenEnds(plan: TrackPlan, a: OpenEndRef, b: OpenEndRef): { error?: string; circuitId?: string } {
  if (!isOpenEnd(plan, a) || !isOpenEnd(plan, b)) return { error: 'Both ends must be unfinished.' };
  if (a.kind === 'end' && b.kind === 'end') {
    if (a.circuitId === b.circuitId) return { error: 'Those are the two ends of the same track circuit.' };
    const ca = findCircuit(plan, a.circuitId)!;
    const cb = findCircuit(plan, b.circuitId)!;
    const ha = endHeading(plan, ca, a.end)!;
    // The joint faces the way the first track is heading: it joins port 'a', the second track 'b'.
    const j = placeJunction(plan, 'joint', ha, { dx: Math.sign(ha.dx), dy: ha.dx === 0 ? Math.sign(ha.dy) : 0 }, workerOf(ca.owner));
    ca.ends[a.end] = { kind: 'joined', junctionId: j.id, port: 'a' };
    cb.ends[b.end] = { kind: 'joined', junctionId: j.id, port: 'b' };
    return { circuitId: cb.id };
  }
  if (a.kind === 'port' && b.kind === 'port') {
    if (a.junctionId === b.junctionId && a.port === b.port) return { error: 'Choose a different end.' };
    const ja = findJunction(plan, a.junctionId)!;
    const owner: TrackOwner = ownerOfJunction(ja);
    const n = makeCircuit(plan, { kind: 'joined', junctionId: a.junctionId, port: a.port }, { kind: 'joined', junctionId: b.junctionId, port: b.port }, owner);
    return { circuitId: n.id };
  }
  const end = (a.kind === 'end' ? a : b) as Extract<OpenEndRef, { kind: 'end' }>;
  const port = (a.kind === 'port' ? a : b) as Extract<OpenEndRef, { kind: 'port' }>;
  const c = findCircuit(plan, end.circuitId)!;
  if (c.ends[1 - end.end].kind === 'joined') {
    const other = c.ends[1 - end.end] as Extract<CircuitEnd, { kind: 'joined' }>;
    if (other.junctionId === port.junctionId && other.port === port.port) return { error: 'Choose a different end.' };
  }
  c.ends[end.end] = { kind: 'joined', junctionId: port.junctionId, port: port.port };
  return { circuitId: c.id };
}

/** Change a free (not joined) end between unfinished, buffer stops and leaving the scene. */
export function setEndKind(plan: TrackPlan, circuitId: string, end: 0 | 1, kind: 'open' | 'bufferStops' | 'exit'): void {
  const c = findCircuit(plan, circuitId);
  if (!c) return;
  const e = c.ends[end];
  if (e.kind === 'joined' || e.kind === kind) return;
  if (kind === 'exit') c.ends[end] = { kind: 'exit', x: e.x, y: e.y, to: { kind: 'offScene' } };
  else c.ends[end] = { kind, x: e.x, y: e.y };
}

export function setExitTarget(plan: TrackPlan, circuitId: string, end: 0 | 1, to: ExitTarget): void {
  const e = findCircuit(plan, circuitId)?.ends[end];
  if (e?.kind === 'exit') e.to = to;
}

/** Undo a join: the circuit end becomes unfinished where the port was. */
export function detachEnd(plan: TrackPlan, circuitId: string, end: 0 | 1): void {
  const c = findCircuit(plan, circuitId);
  if (!c) return;
  const e = c.ends[end];
  if (e.kind !== 'joined') return;
  const a = endAnchor(plan, e);
  const off = a ? { x: a.x + (a.dx || 0), y: a.y + (a.dy || 0) } : { x: 0, y: 0 };
  c.ends[end] = { kind: 'open', ...off };
  pruneJoints(plan);
}

/**
 * Merge the two track circuits either side of a joint into one, removing the joint.
 * `keep` (if given) is the circuit whose code, name and box are kept.
 */
export function mergeAtJoint(plan: TrackPlan, jointId: string, keep?: string): { error?: string; circuitId?: string } {
  const j = findJunction(plan, jointId);
  if (!j || j.kind !== 'joint') return { error: 'Only track circuits meeting at a joint can be merged.' };
  const ua = portUse(plan, j.id, 'a');
  const ub = portUse(plan, j.id, 'b');
  if (!ua || !ub) return { error: 'There is only one track circuit at this joint.' };
  if (ua.circuit.id === ub.circuit.id) return { error: 'That is the same track circuit on both sides.' };
  const [k, o] = keep === ub.circuit.id ? [ub, ua] : [ua, ub];
  // Keep the drawn shape: bends of both, and the joint's place if the line turns there.
  const jp = portAnchor(j, 'a')!;
  const kPath = circuitPath(plan, k.circuit);
  const oPath = circuitPath(plan, o.circuit);
  const kIn = k.end === 1 ? [...(k.circuit.via ?? [])] : [...(k.circuit.via ?? [])].reverse(); // from keep's far end to the joint
  const oOut = o.end === 0 ? [...(o.circuit.via ?? [])] : [...(o.circuit.via ?? [])].reverse(); // from the joint to the other's far end
  const prev = k.end === 1 ? kPath[kPath.length - 2] : kPath[1];
  const next = o.end === 0 ? oPath[1] : oPath[oPath.length - 2];
  const dir = (p: Pt, q: Pt) => ({ x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) });
  const turns = !prev || !next || dir(prev, jp).x !== dir(jp, next).x || dir(prev, jp).y !== dir(jp, next).y;
  const seq = [...kIn, ...(turns || kIn.length || oOut.length ? [{ x: jp.x, y: jp.y }] : []), ...oOut];
  k.circuit.ends[k.end] = structuredClone(o.circuit.ends[1 - o.end]);
  if (seq.length) k.circuit.via = k.end === 1 ? seq : seq.reverse();
  else delete k.circuit.via;
  tidyBends(plan, k.circuit);
  if (!k.circuit.name) k.circuit.name = o.circuit.name;
  if (!k.circuit.platform && o.circuit.platform) k.circuit.platform = structuredClone(o.circuit.platform);
  if (!k.circuit.traffic && o.circuit.traffic) {
    // The other circuit's trains run away from the joint (towards its far end): in the merged circuit, towards the end it brought.
    const away = o.circuit.traffic.toward !== o.end;
    k.circuit.traffic = { line: o.circuit.traffic.line, toward: (away ? k.end : 1 - k.end) as 0 | 1 };
  }
  if (k.circuit.owner.kind === 'none') k.circuit.owner = structuredClone(o.circuit.owner);
  releaseMarkers(plan, o.circuit.id, k.circuit.id);
  plan.circuits = plan.circuits.filter((c) => c.id !== o.circuit.id);
  plan.junctions = plan.junctions.filter((x) => x.id !== j.id);
  return { circuitId: k.circuit.id };
}

/** The circuit on the other side of a joint at one end of a circuit, if any. */
export function acrossJoint(plan: TrackPlan, circuitId: string, end: 0 | 1): { joint: Junction; circuit: TrackCircuit } | null {
  const c = findCircuit(plan, circuitId);
  const e = c?.ends[end];
  if (!e || e.kind !== 'joined') return null;
  const j = findJunction(plan, e.junctionId);
  if (!j || j.kind !== 'joint') return null;
  const u = portUse(plan, j.id, e.port === 'a' ? 'b' : 'a');
  return u && u.circuit.id !== circuitId ? { joint: j, circuit: u.circuit } : null;
}

export function deleteCircuit(plan: TrackPlan, circuitId: string): void {
  releaseMarkers(plan, circuitId);
  plan.circuits = plan.circuits.filter((c) => c.id !== circuitId);
  pruneJoints(plan);
}

/**
 * Remove plain joints that no longer join any track (left behind when the tracks either
 * side were deleted or unjoined). A joint with track on one side stays: it is an unfinished end.
 */
export function pruneJoints(plan: TrackPlan): number {
  const used = new Set<string>();
  for (const c of plan.circuits) for (const e of c.ends) if (e.kind === 'joined') used.add(e.junctionId);
  const before = plan.junctions.length;
  plan.junctions = plan.junctions.filter((j) => j.kind !== 'joint' || used.has(j.id));
  return before - plan.junctions.length;
}

export function deleteJunction(plan: TrackPlan, junctionId: string): void {
  const j = findJunction(plan, junctionId);
  if (!j) return;
  for (const c of plan.circuits) {
    for (const e of [0, 1] as const) {
      const ce = c.ends[e];
      if (ce.kind === 'joined' && ce.junctionId === junctionId) {
        const a = portAnchor(j, ce.port);
        c.ends[e] = { kind: 'open', x: a?.x ?? j.x, y: a?.y ?? j.y };
      }
    }
  }
  plan.junctions = plan.junctions.filter((x) => x.id !== junctionId);
}

/** Change a junction's type. Ports the new type has keep their tracks; the others become unfinished. */
export function setJunctionKind(plan: TrackPlan, junctionId: string, kind: JunctionKind): void {
  const j = findJunction(plan, junctionId);
  if (!j || j.kind === kind) return;
  const keep = new Set(JUNCTIONS[kind].ports.map((p) => p.id));
  for (const c of plan.circuits) {
    for (const e of [0, 1] as const) {
      const ce = c.ends[e];
      if (ce.kind === 'joined' && ce.junctionId === junctionId && !keep.has(ce.port)) {
        const a = portAnchor(j, ce.port);
        c.ends[e] = { kind: 'open', x: (a?.x ?? j.x) + (a?.dx ?? 0), y: (a?.y ?? j.y) + (a?.dy ?? 0) };
      }
    }
  }
  j.kind = kind;
  if (!MIRRORABLE.includes(kind)) j.mirror = false;
  if (kind === 'turntable') j.roads = [...TURNTABLE_DEFAULT_ROADS];
  else delete j.roads;
}

/**
 * Turn a junction a quarter turn clockwise (for tracks that run up and down the plan).
 * With one road joined, that road stays where it is; otherwise it turns about its middle.
 */
export function rotateQuarter(plan: TrackPlan, junctionId: string): void {
  const j = findJunction(plan, junctionId);
  if (!j) return;
  const joined = portsOf(j).filter((p) => portUse(plan, j.id, p.id));
  const keep = joined.length === 1 ? joined[0] : null;
  const before = keep ? portAnchor(j, keep.id)! : null;
  if (j.quarter) {
    j.quarter = false;
    j.rotate = !j.rotate;
  } else j.quarter = true;
  if (keep && before) {
    const after = portAnchor(j, keep.id)!;
    j.x += before.x - after.x;
    j.y += before.y - after.y;
  }
}

/** Choose which roads a turntable has. A road taken away leaves its track unfinished. */
export function setTurntableRoads(plan: TrackPlan, junctionId: string, roads: string[]): void {
  const j = findJunction(plan, junctionId);
  if (!j || j.kind !== 'turntable') return;
  const valid = JUNCTIONS.turntable.ports.map((p) => p.id).filter((id) => roads.includes(id));
  for (const p of portsOf(j)) {
    if (valid.includes(p.id)) continue;
    const u = portUse(plan, j.id, p.id);
    if (u) detachEnd(plan, u.circuit.id, u.end);
  }
  j.roads = valid;
}

/** Unit vector along the first stretch of a circuit, leaving the given end. */
function leaving(plan: TrackPlan, c: TrackCircuit, end: 0 | 1): Pt {
  const path = circuitPath(plan, c);
  if (path.length < 2) return { x: 0, y: 0 };
  const p = end === 0 ? path[0] : path[path.length - 1];
  const q = end === 0 ? path[1] : path[path.length - 2];
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
}

/**
 * Turn a junction round (half a turn), keeping its hand.
 * - Nothing joined: it simply faces the other way.
 * - One road joined: that track stays where it is and moves to whichever of the
 *   junction's roads now faces it, so facing points become trailing points and back.
 * - Two or more joined: refused (unjoin the others first), as turning it would
 *   tangle the tracks.
 */
export function turnRound(plan: TrackPlan, junctionId: string): { error?: string } {
  const j = findJunction(plan, junctionId);
  if (!j) return { error: 'Not found.' };
  const def = JUNCTIONS[j.kind];
  const ports = portsOf(j);
  const joined = ports.map((p) => ({ p, use: portUse(plan, j.id, p.id) })).filter((x) => x.use);
  if (joined.length >= 2) return { error: 'Turn round only works with one road joined. Unjoin the others first.' };
  if (!joined.length) {
    j.rotate = !j.rotate;
    return {};
  }
  const { p, use } = joined[0];
  const at = portAnchor(j, p.id)!;
  const wasLevel = at.dy === 0;
  const c = use!.circuit;
  const farEnd = endAnchor(plan, c.ends[1 - use!.end]);
  // Judge the way the joined track runs by where it comes from (its far end), not just
  // its last stretch: a track off a turnout road levels out before it gets here, but it
  // still belongs on this junction's turnout road.
  let toward = farEnd ? { x: farEnd.x - at.x, y: farEnd.y - at.y } : leaving(plan, c, use!.end);
  // A track that leaves another junction on a turnout road and climbs or drops to here
  // is one side of a crossover: it belongs on a diagonal road.
  if (farEnd && farEnd.dy !== 0 && farEnd.y !== at.y) toward = { x: Math.sign(farEnd.x - at.x), y: Math.sign(farEnd.y - at.y) };
  const tl = Math.hypot(toward.x, toward.y);
  toward = tl ? { x: toward.x / tl, y: toward.y / tl } : leaving(plan, c, use!.end);
  j.rotate = !j.rotate;
  // The road whose direction best matches the way the joined track runs.
  let best = ports[0];
  let bestScore = -Infinity;
  const order = [def.through, ...ports.map((x) => x.id)].filter((x): x is string => !!x && ports.some((p) => p.id === x));
  for (const id of [...new Set(order)]) {
    const q = ports.find((x) => x.id === id)!;
    const d = orient(j, q.dx, q.dy);
    const score = (d.x * toward.x + d.y * toward.y) / (Math.hypot(d.x, d.y) || 1);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = q;
    }
  }
  const o = orient(j, best.x, best.y);
  j.x = at.x - o.x;
  j.y = at.y - o.y;
  // Moving from a level road onto a diagonal one: keep the junction on the same line and
  // slide it along, so the joined track runs straight in at 45° (a tidy crossover).
  const dq = orient(j, best.dx, best.dy);
  if (wasLevel && dq.y !== 0 && farEnd) {
    const qy = at.y + o.y;
    const t = (farEnd.y - qy) / dq.y;
    if (Number.isInteger(t) && t >= 1) {
      const qx = farEnd.x - dq.x * t;
      j.x = qx - o.x;
      j.y = qy - o.y;
    }
  }
  const e = c.ends[use!.end];
  if (e.kind === 'joined') e.port = best.id;
  return {};
}

/**
 * Crossover from an unfinished end to a new (or existing) track alongside.
 * From a turnout road: a short 45° track and opposing points of the same hand on the
 * track alongside, turned round so their toe faces onward. From a level end: facing
 * points of the given hand first, then the same.
 * If a track already runs where the second points go, they are put into it.
 */
export function crossoverFrom(plan: TrackPlan, ref: OpenEndRef, hand: 'pointsRight' | 'pointsLeft' = 'pointsRight'): { error?: string; junctionId?: string; circuitId?: string } {
  if (!isOpenEnd(plan, ref)) return { error: 'That end is already finished.' };
  let from: Extract<OpenEndRef, { kind: 'port' }>;
  const a0 = openEndAnchor(plan, ref);
  if (!a0) return { error: 'Not found.' };
  if (ref.kind === 'port' && a0.dy !== 0 && a0.dx !== 0) from = ref;
  else {
    const g = growFacing(plan, ref, hand);
    if (!g?.junctionId) return { error: 'Could not add points here.' };
    from = { kind: 'port', junctionId: g.junctionId, port: 'reverse' };
  }
  const j1 = findJunction(plan, from.junctionId)!;
  const a = portAnchor(j1, from.port)!;
  const sx = Math.sign(a.dx);
  const sy = Math.sign(a.dy);
  // Turning down the plan while travelling right (or up while travelling left) is a right-hand turn.
  const right = (sx > 0 && sy > 0) || (sx < 0 && sy < 0);
  const kind: JunctionKind = right ? 'pointsRight' : 'pointsLeft';
  const rotate = sx > 0;
  const rev = portDef(kind, 'reverse')!;
  const o = orient({ rotate, mirror: false }, rev.x, rev.y);
  const revAt = { x: a.x + sx, y: a.y + sy };
  const jx = revAt.x - o.x;
  const jy = revAt.y - o.y;
  const nrm = orient({ rotate, mirror: false }, 1, 0);
  const lo = Math.min(jx, jx + nrm.x);
  const hi = Math.max(jx, jx + nrm.x);
  let j2: Junction | undefined;
  const existing = plan.circuits.find((c) => levelRuns(plan, c).some((r) => r.y === jy && r.x1 < lo && r.x2 > hi));
  if (existing) j2 = insertJunction(plan, existing.id, kind, jx, jy, rotate).junction;
  if (!j2) j2 = makeJunction(plan, kind, jx, jy, rotate, junctionWorker(j1));
  const owner: TrackOwner = ownerOfJunction(j1);
  const x = makeCircuit(plan, { kind: 'joined', junctionId: j1.id, port: from.port }, { kind: 'joined', junctionId: j2.id, port: 'reverse' }, owner);
  return { junctionId: j2.id, circuitId: x.id };
}

/** Mirror a crossing, slip, scissors or catch points top to bottom. Joined tracks stay on the same roads. */
export function mirrorJunction(plan: TrackPlan, junctionId: string): void {
  const j = findJunction(plan, junctionId);
  if (j && MIRRORABLE.includes(j.kind)) j.mirror = !j.mirror;
}

/**
 * Points have a hand, so a mirrored set is stored as the other hand instead
 * (and Y or three-way points swap their left and right roads).
 */
function normaliseMirror(plan: TrackPlan, j: Junction): void {
  if (!j.mirror || MIRRORABLE.includes(j.kind)) return;
  j.mirror = false;
  if (j.kind === 'pointsRight') j.kind = 'pointsLeft';
  else if (j.kind === 'pointsLeft') j.kind = 'pointsRight';
  else if (j.kind === 'pointsY' || j.kind === 'threeWay') {
    for (const c of plan.circuits)
      for (const e of c.ends)
        if (e.kind === 'joined' && e.junctionId === j.id && (e.port === 'left' || e.port === 'right')) e.port = e.port === 'left' ? 'right' : 'left';
  }
}

export function moveJunction(plan: TrackPlan, junctionId: string, x: number, y: number): void {
  const j = findJunction(plan, junctionId);
  if (j) {
    j.x = x;
    j.y = y;
  }
}

export function moveEnd(plan: TrackPlan, circuitId: string, end: 0 | 1, x: number, y: number): void {
  const e = findCircuit(plan, circuitId)?.ends[end];
  if (e && e.kind !== 'joined') {
    e.x = x;
    e.y = y;
  }
}

/** Move a circuit's free ends by an offset (joined ends stay with their junctions). */
export function shiftCircuit(plan: TrackPlan, circuitId: string, dx: number, dy: number): void {
  const c = findCircuit(plan, circuitId);
  if (!c) return;
  for (const e of c.ends) {
    if (e.kind !== 'joined') {
      e.x += dx;
      e.y += dy;
    }
  }
  for (const v of c.via ?? []) {
    v.x += dx;
    v.y += dy;
  }
}

// ---------------------------------------------------------------- bends (curves)

/** Add a bend in the middle of a circuit's longest stretch, ready to be dragged into a curve. */
export function addBend(plan: TrackPlan, circuitId: string): { error?: string; index?: number } {
  const c = findCircuit(plan, circuitId);
  if (!c) return { error: 'Track circuit not found.' };
  const a = endAnchor(plan, c.ends[0]);
  const b = endAnchor(plan, c.ends[1]);
  if (!a || !b) return { error: 'Track circuit not found.' };
  const keys: Pt[] = [a, ...(c.via ?? []), b];
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const l = Math.hypot(keys[i + 1].x - keys[i].x, keys[i + 1].y - keys[i].y);
    if (l > bestLen) {
      bestLen = l;
      best = i;
    }
  }
  if (best < 0 || bestLen < 2) return { error: 'This track circuit is too short for a bend. Lengthen it first.' };
  const m = { x: Math.round((keys[best].x + keys[best + 1].x) / 2), y: Math.round((keys[best].y + keys[best + 1].y) / 2) };
  c.via = [...(c.via ?? [])];
  c.via.splice(best, 0, m);
  return { index: best };
}

export function moveBend(plan: TrackPlan, circuitId: string, index: number, x: number, y: number): void {
  const v = findCircuit(plan, circuitId)?.via?.[index];
  if (v) {
    v.x = x;
    v.y = y;
  }
}

export function removeBend(plan: TrackPlan, circuitId: string, index?: number): void {
  const c = findCircuit(plan, circuitId);
  if (!c?.via) return;
  if (index === undefined) c.via = [];
  else c.via.splice(index, 1);
  if (!c.via.length) delete c.via;
}

// ---------------------------------------------------------------- parallel and double track

export const TRACK_SPACING = 3;

/** Offsets of each drawn corner of a circuit for a parallel track on one side (+1: left of the way it runs). */
function parallelPoints(path: Pt[], side: 1 | -1, spacing: number): Pt[] {
  const dirs = path.slice(1).map((q, i) => ({ x: Math.sign(q.x - path[i].x), y: Math.sign(q.y - path[i].y) }));
  return path.map((p, i) => {
    const adj = [dirs[i - 1], dirs[i]].filter(Boolean) as Pt[];
    let ox: number | null = null;
    let oy: number | null = null;
    for (const d of adj) {
      // Left of travel on a plan with y downwards: (dy, -dx).
      const n = { x: side * d.y, y: -side * d.x };
      if (d.y === 0) oy = n.y * spacing;
      else if (d.x === 0) ox = n.x * spacing;
    }
    if (ox === null && oy === null) {
      // Only diagonal stretches meet here: move straight up or down, as the level parts do.
      const d = adj[0];
      oy = -side * d.x * spacing;
    }
    return { x: p.x + (ox ?? 0), y: p.y + (oy ?? 0) };
  });
}

// ---------------------------------------------------------------- platforms

export const PLATFORM_MAX = 8;
/** How far the platform face is drawn from the track centre line (grid units). */
export const PLATFORM_OFFSET = 0.8;

export function checkPlatformNumber(number: string): string | null {
  if (!number.trim()) return 'Enter the platform number, e.g. 1.';
  if (number.trim().length > PLATFORM_MAX) return `Keep it to ${PLATFORM_MAX} characters or fewer.`;
  return null;
}

/** Make a track circuit a platform road (null: not a platform). A new platform gets the next free number for its box. */
export function setPlatform(plan: TrackPlan, circuitId: string, platform: { number?: string; side?: 1 | -1 } | null): void {
  const c = findCircuit(plan, circuitId);
  if (!c) return;
  if (!platform) {
    delete c.platform;
    return;
  }
  const number = platform.number?.trim() || c.platform?.number || nextPlatformNumber(plan, c);
  c.platform = { number, side: platform.side ?? c.platform?.side ?? 1 };
}

/** The lowest whole platform number not yet used by track belonging to the same box. */
export function nextPlatformNumber(plan: TrackPlan, c: TrackCircuit): string {
  const key = ownerKey(c.owner);
  const used = new Set(plan.circuits.filter((x) => x.id !== c.id && x.platform && ownerKey(x.owner) === key).map((x) => x.platform!.number.trim().toUpperCase()));
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}

/**
 * The platform face, drawn alongside the longest straight (level or upright) stretch of the
 * track on its side: a platform road reached through a turnout has no platform on the turnout road.
 */
export function platformPath(plan: TrackPlan, c: TrackCircuit): Pt[] {
  const path = circuitPath(plan, c);
  if (!c.platform || path.length < 2) return [];
  const off = parallelPoints(path, c.platform.side, PLATFORM_OFFSET);
  let best = -1;
  let bi = 1;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    const l = p.x === q.x || p.y === q.y ? Math.hypot(q.x - p.x, q.y - p.y) : -1;
    if (l > best) {
      best = l;
      bi = i;
    }
  }
  return best > 0 ? [off[bi - 1], off[bi]] : off;
}

/** Platform roads on a plan, optionally only those belonging to one owner (an ownerKey, e.g. 'box|becton'). */
export function platformsOf(plan: TrackPlan, key?: string): Array<{ circuit: TrackCircuit; number: string }> {
  return plan.circuits
    .filter((c) => c.platform && (key === undefined || ownerKey(c.owner) === key))
    .map((c) => ({ circuit: c, number: c.platform!.number }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/** Which way each side of a circuit is, for labelling: 'above', 'below', 'left' or 'right'. */
export function parallelSideNames(plan: TrackPlan, circuitId: string): Array<{ side: 1 | -1; name: string }> {
  const c = findCircuit(plan, circuitId);
  const path = c ? circuitPath(plan, c) : [];
  if (path.length < 2) return [];
  let best = 0;
  let bi = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    const l = p.x === q.x || p.y === q.y ? Math.hypot(q.x - p.x, q.y - p.y) : 0;
    if (l > best) {
      best = l;
      bi = i;
    }
  }
  const d = best ? { x: Math.sign(path[bi].x - path[bi - 1].x), y: Math.sign(path[bi].y - path[bi - 1].y) } : { x: 1, y: 0 };
  return ([1, -1] as const).map((side) => {
    const n = { x: side * d.y, y: -side * d.x };
    const name = n.y < 0 ? 'above' : n.y > 0 ? 'below' : n.x < 0 ? 'left' : 'right';
    return { side, name };
  });
}

/** Lay a new track alongside an existing one, one track spacing away, the same shape. Its ends are left unfinished. */
export function parallelTrack(plan: TrackPlan, circuitId: string, side: 1 | -1): { error?: string; circuitId?: string } {
  const c = findCircuit(plan, circuitId);
  if (!c) return { error: 'Track circuit not found.' };
  const path = circuitPath(plan, c);
  if (path.length < 2) return { error: 'This track circuit has no length.' };
  const pts = parallelPoints(path, side, TRACK_SPACING);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const n = makeCircuit(plan, { kind: 'open', ...first }, { kind: 'open', ...last }, c.owner);
  if (pts.length > 2) n.via = pts.slice(1, -1);
  // Drop bends that the plain route would draw anyway.
  tidyBends(plan, n);
  return { circuitId: n.id };
}

/** Remove bends that lie straight on the line between their neighbours. */
function tidyBends(plan: TrackPlan, c: TrackCircuit): void {
  if (!c.via?.length) return;
  const a = endAnchor(plan, c.ends[0]);
  const b = endAnchor(plan, c.ends[1]);
  if (!a || !b) return;
  const keys: Pt[] = [a, ...c.via, b];
  const keep: Pt[] = [];
  for (let i = 1; i < keys.length - 1; i++) {
    const p = keys[i - 1];
    const v = keys[i];
    const q = keys[i + 1];
    const d1 = { x: Math.sign(v.x - p.x), y: Math.sign(v.y - p.y) };
    const d2 = { x: Math.sign(q.x - v.x), y: Math.sign(q.y - v.y) };
    const straight1 = v.x === p.x || v.y === p.y || Math.abs(v.x - p.x) === Math.abs(v.y - p.y);
    const straight2 = q.x === v.x || q.y === v.y || Math.abs(q.x - v.x) === Math.abs(q.y - v.y);
    if (straight1 && straight2 && d1.x === d2.x && d1.y === d2.y) continue;
    keep.push(v);
  }
  // The plain route (level with one 45°) needs no bends where it already passes through them.
  const plain = circuitPath(plan, { ...c, via: undefined });
  if (keep.every((v) => plain.some((p) => p.x === v.x && p.y === v.y))) {
    const withBends = circuitPath(plan, { ...c, via: keep });
    if (withBends.length === plain.length && withBends.every((p, i) => p.x === plain[i].x && p.y === plain[i].y)) {
      delete c.via;
      return;
    }
  }
  if (keep.length) c.via = keep;
  else delete c.via;
}

/** Lay two parallel tracks at once, below everything else. */
export function addDoubleTrack(plan: TrackPlan, owner: TrackOwner = { kind: 'none' }): { circuitIds: [string, string] } {
  const a = addTrack(plan, owner);
  const b = parallelTrack(plan, a.id, -1);
  return { circuitIds: [a.id, b.circuitId!] };
}

/**
 * Put a junction into the middle of a track circuit, splitting it in two.
 * `x` is the junction's position; the level run of the circuit at `y` must hold
 * the junction's entry and through ports with room to spare.
 */
export function insertJunction(plan: TrackPlan, circuitId: string, kind: JunctionKind, x: number, y: number, rotate: boolean): { error?: string; junction?: Junction; newCircuit?: TrackCircuit } {
  const c = findCircuit(plan, circuitId);
  if (!c) return { error: 'Track circuit not found.' };
  const def = JUNCTIONS[kind];
  if (!def.through) return { error: `${def.name} cannot go in the middle of a track.` };
  const entry = portDef(kind, def.entry)!;
  const through = portDef(kind, def.through)!;
  const ex = x + (rotate ? -entry.x : entry.x);
  const tx = x + (rotate ? -through.x : through.x);
  if (entry.y !== 0 || through.y !== 0) return { error: 'That junction does not sit on a straight track.' };
  const lo = Math.min(ex, tx);
  const hi = Math.max(ex, tx);
  const run = levelRuns(plan, c).find((r) => r.y === y && r.x1 < lo && r.x2 > hi);
  if (!run) return { error: 'There is not enough straight track there.' };
  // Which circuit end lies to the left of the junction?
  const path = circuitPath(plan, c);
  const leftEnd: 0 | 1 = path[0].x < path[path.length - 1].x ? 0 : 1;
  const rightEnd = (1 - leftEnd) as 0 | 1;
  const leftPort = rotate ? def.through : def.entry;
  const rightPort = rotate ? def.entry : def.through;
  const j = makeJunction(plan, kind, x, y, rotate, workerOf(c.owner));
  const oldRight = c.ends[rightEnd];
  c.ends[rightEnd] = { kind: 'joined', junctionId: j.id, port: leftPort };
  const n = makeCircuit(plan, { kind: 'joined', junctionId: j.id, port: rightPort }, oldRight, c.owner);
  return { junction: j, newCircuit: n };
}

/** The middle of a circuit's longest level run, as a whole grid position. */
export function middleOf(plan: TrackPlan, c: TrackCircuit): Pt | null {
  const runs = levelRuns(plan, c).sort((a, b) => b.x2 - b.x1 - (a.x2 - a.x1));
  const r = runs[0];
  if (!r) return null;
  return { x: Math.round((r.x1 + r.x2) / 2), y: r.y };
}

/** Split a circuit in two at a joint in its middle. */
export function splitCircuit(plan: TrackPlan, circuitId: string): { error?: string; newCircuit?: TrackCircuit } {
  const c = findCircuit(plan, circuitId);
  if (!c) return { error: 'Track circuit not found.' };
  const m = middleOf(plan, c);
  if (!m) return { error: 'This track circuit has no straight part to split.' };
  const r = insertJunction(plan, circuitId, 'joint', m.x, m.y, false);
  return r.error ? { error: 'This track circuit is too short to split.' } : { newCircuit: r.newCircuit };
}

/** Add points (or another junction) into the middle of a circuit. */
export function addJunctionInTrack(plan: TrackPlan, circuitId: string, kind: JunctionKind, rotate: boolean): { error?: string; junction?: Junction } {
  const c = findCircuit(plan, circuitId);
  if (!c) return { error: 'Track circuit not found.' };
  const m = middleOf(plan, c);
  if (!m) return { error: 'This track circuit has no straight part.' };
  // Try the middle first, then nearby positions.
  for (const off of [0, -1, 1, -2, 2, -3, 3]) {
    const r = insertJunction(plan, circuitId, kind, m.x + off, m.y, rotate);
    if (!r.error) return { junction: r.junction };
  }
  return { error: 'This track circuit is too short. Lengthen it first.' };
}

export type CrossoverLean = 'rising' | 'falling';

/**
 * Connect two parallel tracks with a crossover: points in each track and a
 * track circuit between them. 'rising' climbs from the lower track to the
 * upper one going left to right (/); 'falling' drops (\).
 */
export function connectParallel(plan: TrackPlan, circuitA: string, circuitB: string, lean: CrossoverLean): { error?: string; circuitId?: string } {
  if (circuitA === circuitB) return { error: 'Choose a different track to connect to.' };
  const ca = findCircuit(plan, circuitA);
  const cb = findCircuit(plan, circuitB);
  if (!ca || !cb) return { error: 'Track circuit not found.' };
  const runsA = levelRuns(plan, ca);
  const runsB = levelRuns(plan, cb);
  type Cand = { x0: number; d: number; upper: TrackCircuit; lower: TrackCircuit; yu: number; yl: number; score: number };
  let best: Cand | null = null;
  let closest = Infinity;
  for (const ra of runsA) {
    for (const rb of runsB) {
      if (ra.y === rb.y) continue;
      const [ru, rl, upper, lower] = ra.y < rb.y ? [ra, rb, ca, cb] : [rb, ra, cb, ca];
      const d = rl.y - ru.y;
      closest = Math.min(closest, d);
      if (d < 2) continue;
      // Rising (/): lower points at x0 (toe left), upper points at x0+d (toe right).
      // Falling (\): upper points at x0 (toe left), lower points at x0+d (toe right).
      const [first, second] = lean === 'rising' ? [rl, ru] : [ru, rl];
      // first needs x0-? : toe at x0, normal at x0+1 strictly inside; second: normal at x0+d-1, toe at x0+d strictly inside.
      const lo = Math.max(first.x1 + 1, second.x1 + 2 - d);
      const hi = Math.min(first.x2 - 2, second.x2 - 1 - d);
      if (lo > hi) continue;
      const mid = (Math.max(first.x1, second.x1 - d) + Math.min(first.x2, second.x2 - d)) / 2;
      const x0 = Math.max(lo, Math.min(hi, Math.round(mid - 0.5)));
      const score = d * 1000 - (hi - lo);
      if (!best || score < best.score) best = { x0, d, upper, lower, yu: ru.y, yl: rl.y, score };
    }
  }
  if (!best) {
    if (closest === Infinity) return { error: 'These tracks are not side by side. Move one so that it runs alongside the other.' };
    if (closest < 2) return { error: 'These tracks are too close together for a crossover. Move one further away.' };
    return { error: 'These tracks do not run side by side for long enough. Lengthen them or move one along.' };
  }
  const { x0, d, upper, lower, yu, yl } = best;
  let pFirst: { error?: string; junction?: Junction };
  let pSecond: { error?: string; junction?: Junction };
  if (lean === 'rising') {
    pFirst = insertJunction(plan, lower.id, 'pointsLeft', x0, yl, false);
    if (pFirst.error) return { error: pFirst.error };
    // A crossover is two points of the same hand: the second one is turned round.
    pSecond = insertJunction(plan, upper.id, 'pointsLeft', x0 + d, yu, true);
  } else {
    pFirst = insertJunction(plan, upper.id, 'pointsRight', x0, yu, false);
    if (pFirst.error) return { error: pFirst.error };
    pSecond = insertJunction(plan, lower.id, 'pointsRight', x0 + d, yl, true);
  }
  if (pSecond.error || !pSecond.junction || !pFirst.junction) return { error: pSecond.error ?? 'Could not add the crossover.' };
  const owner = sameOwner(ca.owner, cb.owner) ? ca.owner : ca.owner.kind === 'box' ? ca.owner : cb.owner;
  const x = makeCircuit(plan, { kind: 'joined', junctionId: pFirst.junction.id, port: 'reverse' }, { kind: 'joined', junctionId: pSecond.junction.id, port: 'reverse' }, owner);
  return { circuitId: x.id };
}

// ---------------------------------------------------------------- traffic (up and down lines)

/** The port a train runs straight on to through a junction (joints, points' normal road, crossings), or null (Y points, turntables). */
export function straightOn(j: Junction, port: string): string | null {
  const def = JUNCTIONS[j.kind];
  if (j.kind === 'turntable') return null;
  const p = def.ports.find((x) => x.id === port);
  if (!p) return null;
  let best: string | null = null;
  let bestDot = -0.99;
  for (const r of def.routes) {
    if (r.slip || (r.a !== port && r.b !== port)) continue;
    const other = def.ports.find((x) => x.id === (r.a === port ? r.b : r.a));
    if (!other) continue;
    const len = Math.hypot(p.dx, p.dy) * Math.hypot(other.dx, other.dy) || 1;
    const dot = (p.dx * other.dx + p.dy * other.dy) / len;
    if (dot <= bestDot) {
      bestDot = dot;
      best = other.id;
    }
  }
  return best;
}

/** The track circuit a train runs on to from one end of a circuit, going straight on, and the end it enters by. */
export function runOn(plan: TrackPlan, c: TrackCircuit, end: 0 | 1): { circuit: TrackCircuit; end: 0 | 1; via: Junction } | null {
  const e = c.ends[end];
  if (e.kind !== 'joined') return null;
  const j = findJunction(plan, e.junctionId);
  if (!j) return null;
  const q = straightOn(j, e.port);
  const u = q ? portUse(plan, j.id, q) : null;
  return u && u.circuit.id !== c.id ? { circuit: u.circuit, end: u.end, via: j } : null;
}

/** The circuits of a running line: this one and those straight on from it through joints, points and crossings. */
export function lineRun(plan: TrackPlan, circuitId: string): TrackCircuit[] {
  const start = findCircuit(plan, circuitId);
  if (!start) return [];
  const seen = new Set([start.id]);
  const out = [start];
  const queue = [start];
  while (queue.length) {
    const c = queue.shift()!;
    for (const end of [0, 1] as const) {
      const n = runOn(plan, c, end);
      if (n && !seen.has(n.circuit.id)) {
        seen.add(n.circuit.id);
        out.push(n.circuit);
        queue.push(n.circuit);
      }
    }
  }
  return out;
}

/**
 * Set the traffic on a track circuit (null: both ways). With `wholeLine`, the same line and
 * direction carry on along the whole running line (see lineRun), each circuit facing the way
 * the trains go. Returns how many circuits were set.
 */
export function setTraffic(plan: TrackPlan, circuitId: string, traffic: { line: RunningLine; toward: 0 | 1 } | null, wholeLine = false): number {
  const start = findCircuit(plan, circuitId);
  if (!start) return 0;
  const apply = (c: TrackCircuit, t: { line: RunningLine; toward: 0 | 1 } | null) => {
    if (t) c.traffic = { line: t.line, toward: t.toward };
    else delete c.traffic;
  };
  apply(start, traffic);
  if (!wholeLine) return 1;
  const seen = new Set([start.id]);
  const queue: Array<{ c: TrackCircuit; t: { line: RunningLine; toward: 0 | 1 } | null }> = [{ c: start, t: traffic }];
  let n = 1;
  while (queue.length) {
    const { c, t } = queue.shift()!;
    for (const end of [0, 1] as const) {
      const r = runOn(plan, c, end);
      if (!r || seen.has(r.circuit.id)) continue;
      seen.add(r.circuit.id);
      // Leaving by this end: the next track runs away from the junction. Arriving by it: towards it.
      const nt = t ? { line: t.line, toward: (end === t.toward ? 1 - r.end : r.end) as 0 | 1 } : null;
      apply(r.circuit, nt);
      n++;
      queue.push({ c: r.circuit, t: nt });
    }
  }
  return n;
}

/** The longest level or upright stretch of a circuit: its two points (in end 0 → end 1 order) and unit direction. */
function mainStretch(plan: TrackPlan, c: TrackCircuit): { a: Pt; b: Pt; d: Pt } | null {
  const path = circuitPath(plan, c);
  let best = 0;
  let bi = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    const l = p.x === q.x || p.y === q.y ? Math.hypot(q.x - p.x, q.y - p.y) : 0;
    if (l > best) {
      best = l;
      bi = i;
    }
  }
  if (!best) return null;
  const a = path[bi - 1];
  const b = path[bi];
  return { a, b, d: { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) } };
}

/** Tracks running alongside a circuit (parallel, overlapping, up to two track spacings away), nearest first, with the side they are on. */
export function tracksAlongside(plan: TrackPlan, circuitId: string): Array<{ circuit: TrackCircuit; side: 1 | -1; distance: number }> {
  const c = findCircuit(plan, circuitId);
  const m = c ? mainStretch(plan, c) : null;
  if (!c || !m) return [];
  const along = (p: Pt) => p.x * m.d.x + p.y * m.d.y;
  // Left of travel on a plan with y downwards: (dy, -dx), as in parallelPoints.
  const left = { x: m.d.y, y: -m.d.x };
  const lo = Math.min(along(m.a), along(m.b));
  const hi = Math.max(along(m.a), along(m.b));
  const out: Array<{ circuit: TrackCircuit; side: 1 | -1; distance: number }> = [];
  for (const o of plan.circuits) {
    if (o.id === c.id) continue;
    const path = circuitPath(plan, o);
    let found: { side: 1 | -1; distance: number } | null = null;
    for (let i = 1; i < path.length; i++) {
      const p = path[i - 1];
      const q = path[i];
      const dd = { x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) };
      if (Math.abs(dd.x * m.d.x + dd.y * m.d.y) !== 1 || (dd.x !== 0 && dd.y !== 0)) continue;
      const off = (p.x - m.a.x) * left.x + (p.y - m.a.y) * left.y;
      const dist = Math.abs(off);
      if (dist < 1 || dist > 2 * TRACK_SPACING) continue;
      const olo = Math.min(along(p), along(q));
      const ohi = Math.max(along(p), along(q));
      if (Math.min(hi, ohi) - Math.max(lo, olo) < 2) continue;
      if (!found || dist < found.distance) found = { side: off > 0 ? 1 : -1, distance: dist };
    }
    if (found) out.push({ circuit: o, ...found });
  }
  return out.sort((x, y) => x.distance - y.distance);
}

/**
 * Make two tracks alongside each other a double line: this one the `line` (up or down), the other
 * the opposite line. Which way each runs follows from the running side: with left-hand running a
 * train has the other line on its right. Both lines are set along their whole length.
 */
export function setDoubleLine(plan: TrackPlan, circuitId: string, partnerId: string, line: RunningLine, running: RunningSide = 'left'): { error?: string; set?: number } {
  const c = findCircuit(plan, circuitId);
  const o = findCircuit(plan, partnerId);
  const m = c ? mainStretch(plan, c) : null;
  const mo = o ? mainStretch(plan, o) : null;
  const pair = tracksAlongside(plan, circuitId).find((x) => x.circuit.id === partnerId);
  if (!c || !o || !m || !mo || !pair) return { error: 'Those two tracks do not run alongside each other.' };
  // Travelling along c from end 0 to end 1, the other line is on side `pair.side` (1 = left).
  // Left-hand running wants the other line on the right (-1), right-hand running on the left.
  const want = running === 'left' ? -1 : 1;
  const toward: 0 | 1 = pair.side === want ? 1 : 0;
  const travel = toward === 1 ? m.d : { x: -m.d.x, y: -m.d.y };
  // The other line runs the opposite way.
  const same = mo.d.x * travel.x + mo.d.y * travel.y > 0;
  const otherToward: 0 | 1 = same ? 0 : 1;
  const other: RunningLine = line === 'up' ? 'down' : 'up';
  let n = setTraffic(plan, c.id, { line, toward }, true);
  if (!o.traffic || o.traffic.line !== other || o.traffic.toward !== otherToward || !lineRun(plan, c.id).some((x) => x.id === o.id)) n += setTraffic(plan, o.id, { line: other, toward: otherToward }, true);
  return { set: n };
}

export function sameOwner(a: TrackOwner, b: TrackOwner): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'box' && b.kind === 'box') return a.boxId === b.boxId;
  return ownerKey(a) === ownerKey(b);
}

// ---------------------------------------------------------------- graph

/** Circuits joined to a circuit through any junction it touches. */
export function neighbours(plan: TrackPlan, c: TrackCircuit): Array<{ circuit: TrackCircuit; via: Junction }> {
  const out: Array<{ circuit: TrackCircuit; via: Junction }> = [];
  for (const e of c.ends) {
    if (e.kind !== 'joined') continue;
    const j = findJunction(plan, e.junctionId);
    if (!j) continue;
    for (const p of portsOf(j)) {
      if (p.id === e.port) continue;
      const u = portUse(plan, j.id, p.id);
      if (u && u.circuit.id !== c.id) out.push({ circuit: u.circuit, via: j });
    }
  }
  return out;
}

/**
 * "Give this branch to a box": the circuit and everything joined to it, stopping
 * at lines between boxes and at track that already belongs to a different box.
 */
export function branchFrom(plan: TrackPlan, circuitId: string): { circuits: TrackCircuit[]; junctions: Junction[] } {
  const start = findCircuit(plan, circuitId);
  if (!start || start.owner.kind === 'line') return { circuits: start ? [start] : [], junctions: [] };
  const startKey = ownerKey(start.owner);
  const canTake = (c: TrackCircuit) => c.owner.kind === 'none' || ownerKey(c.owner) === startKey;
  const canWork = (j: Junction) => !j.boxId || ownerKey(junctionWorker(j)) === startKey;
  const seen = new Set<string>([start.id]);
  const circuits: TrackCircuit[] = [start];
  const junctions = new Map<string, Junction>();
  const queue = [start];
  while (queue.length) {
    const c = queue.shift()!;
    for (const e of c.ends) {
      if (e.kind !== 'joined') continue;
      const j = findJunction(plan, e.junctionId);
      if (j && canWork(j)) junctions.set(j.id, j);
    }
    for (const n of neighbours(plan, c)) {
      if (seen.has(n.circuit.id) || !canTake(n.circuit)) continue;
      if (!canWork(n.via)) continue;
      seen.add(n.circuit.id);
      circuits.push(n.circuit);
      queue.push(n.circuit);
    }
  }
  return { circuits, junctions: [...junctions.values()] };
}

/** Give a branch to a box you work (a box id) or to the far box of a connection (a 'remote' owner). */
export function giveBranch(plan: TrackPlan, circuitId: string, to: string | Extract<TrackOwner, { kind: 'box' | 'remote' }>): number {
  const owner: TrackOwner = typeof to === 'string' ? { kind: 'box', boxId: to } : to;
  const { circuits, junctions } = branchFrom(plan, circuitId);
  for (const c of circuits) c.owner = structuredClone(owner);
  for (const j of junctions) setJunctionWorker(j, workerOf(owner));
  return circuits.length + junctions.length;
}

// ---------------------------------------------------------------- signal boxes on the plan

export function markerKey(b: MarkerBox): string {
  return b.kind === 'box' ? `box|${b.boxId}` : `remote|${b.boxId}|${b.connectionId}`;
}

export function findMarker(plan: TrackPlan, id: string): BoxMarker | undefined {
  return (plan.markers ?? []).find((m) => m.id === id);
}

/** The point halfway along a track circuit's drawn route. */
export function circuitMiddle(plan: TrackPlan, c: TrackCircuit): (Pt & { level: boolean }) | null {
  const path = circuitPath(plan, c);
  if (path.length < 2) return null;
  const lens = path.slice(1).map((p, i) => Math.hypot(p.x - path[i].x, p.y - path[i].y));
  let half = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? Math.min(1, half / lens[i]) : 0;
      const a = path[i];
      const b = path[i + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, level: Math.abs(b.y - a.y) < Math.abs(b.x - a.x) };
    }
    half -= lens[i];
  }
  return null;
}

/** Where the attached track's middle is, if the marker is attached to a track that still exists. */
export function markerAnchor(plan: TrackPlan, m: BoxMarker): Pt | null {
  if (!m.circuitId) return null;
  const c = findCircuit(plan, m.circuitId);
  return c ? circuitMiddle(plan, c) : null;
}

/** Where a signal box marker is drawn. */
export function markerPos(plan: TrackPlan, m: BoxMarker): Pt {
  const a = markerAnchor(plan, m);
  return a ? { x: a.x + m.dx, y: a.y + m.dy } : { x: m.x, y: m.y };
}

/** The usual place for a box beside a track: above a level track (clear of its label), or to the right of an upright one. */
function besideOffset(plan: TrackPlan, c: TrackCircuit): Pt {
  const mid = circuitMiddle(plan, c);
  return mid && !mid.level ? { x: 3, y: 0 } : { x: 0, y: -3 };
}

/**
 * Put a signal box on the plan, beside a track circuit (attached: it follows the track)
 * or on its own below the plan. A box appears on the plan once: placing it again moves it.
 */
export function placeMarker(plan: TrackPlan, box: MarkerBox, circuitId = ''): BoxMarker {
  plan.markers ??= [];
  const key = markerKey(box);
  let m = plan.markers.find((x) => markerKey(x.box) === key);
  if (!m) {
    m = { id: newId('sb'), box: structuredClone(box), x: 0, y: 0, circuitId: '', dx: 0, dy: -2 };
    plan.markers.push(m);
  }
  const c = circuitId ? findCircuit(plan, circuitId) : undefined;
  if (c) {
    const off = besideOffset(plan, c);
    m.circuitId = c.id;
    m.dx = off.x;
    m.dy = off.y;
    const p = markerPos(plan, m);
    m.x = Math.round(p.x);
    m.y = Math.round(p.y);
  } else {
    const b = planBounds(plan);
    m.circuitId = '';
    m.x = b ? b.minX : 2;
    m.y = b ? b.maxY + 3 : 4;
  }
  return m;
}

/** Move a marker so it is drawn at (x, y). An attached marker stays attached, at a new offset from its track. */
export function moveMarker(plan: TrackPlan, id: string, x: number, y: number): void {
  const m = findMarker(plan, id);
  if (!m) return;
  const a = markerAnchor(plan, m);
  if (a) {
    m.dx = Math.round((x - a.x) * 2) / 2;
    m.dy = Math.round((y - a.y) * 2) / 2;
  }
  m.x = Math.round(x);
  m.y = Math.round(y);
}

/** Attach a marker to a track circuit ('' to let it stand on its own where it is). */
export function attachMarker(plan: TrackPlan, id: string, circuitId: string): void {
  const m = findMarker(plan, id);
  if (!m) return;
  const here = markerPos(plan, m);
  m.x = Math.round(here.x);
  m.y = Math.round(here.y);
  const c = circuitId ? findCircuit(plan, circuitId) : undefined;
  if (!c) {
    m.circuitId = '';
    return;
  }
  m.circuitId = c.id;
  const mid = circuitMiddle(plan, c)!;
  const dx = here.x - mid.x;
  const dy = here.y - mid.y;
  // Already close by: keep it where it is. Otherwise put it beside the track.
  if (Math.hypot(dx, dy) <= 4) {
    m.dx = Math.round(dx * 2) / 2;
    m.dy = Math.round(dy * 2) / 2;
  } else {
    const off = besideOffset(plan, c);
    m.dx = off.x;
    m.dy = off.y;
  }
}

export function deleteMarker(plan: TrackPlan, id: string): void {
  plan.markers = (plan.markers ?? []).filter((m) => m.id !== id);
}

/** Before a track circuit goes: markers attached to it stay where they are drawn (moved to `to`, if given). */
function releaseMarkers(plan: TrackPlan, circuitId: string, to?: string): void {
  for (const m of plan.markers ?? []) {
    if (m.circuitId !== circuitId) continue;
    const p = markerPos(plan, m);
    m.x = Math.round(p.x);
    m.y = Math.round(p.y);
    m.circuitId = '';
    if (to) {
      m.circuitId = to;
      const c = findCircuit(plan, to);
      const mid = c ? circuitMiddle(plan, c) : null;
      if (mid) {
        m.dx = Math.round((p.x - mid.x) * 2) / 2;
        m.dy = Math.round((p.y - mid.y) * 2) / 2;
      } else m.circuitId = '';
    }
  }
}

// ---------------------------------------------------------------- checks

export type PlanIssue =
  | { kind: 'openEnd'; ref: OpenEndRef; text: string }
  | { kind: 'unassignedCircuit'; circuitId: string; text: string }
  | { kind: 'unassignedJunction'; junctionId: string; text: string }
  | { kind: 'offLayoutCircuit'; circuitId: string; text: string }
  | { kind: 'offLayoutJunction'; junctionId: string; text: string }
  | { kind: 'duplicateNumber'; junctionId: string; text: string }
  | { kind: 'duplicatePlatform'; circuitId: string; text: string }
  | { kind: 'flowClash'; circuitId: string; text: string };

export function planIssues(state: AppState, layout: Layout): PlanIssue[] {
  const plan = layout.trackPlan;
  const issues: PlanIssue[] = [];
  const onLayout = (boxId: string) => state.boxes.some((b) => b.id === boxId && b.layoutId === layout.id);
  const boxName = (boxId: string) => state.boxes.find((b) => b.id === boxId)?.name ?? 'a box';
  for (const ref of openEnds(plan)) {
    if (ref.kind === 'end') {
      const c = findCircuit(plan, ref.circuitId)!;
      issues.push({ kind: 'openEnd', ref, text: `${circuitLabel(c)}: one end is not finished.` });
    } else {
      const j = findJunction(plan, ref.junctionId)!;
      const p = portDef(j.kind, ref.port)!;
      issues.push({ kind: 'openEnd', ref, text: `${junctionName(j)}: ${p.label.toLowerCase()} is not finished.` });
    }
  }
  for (const c of plan.circuits) {
    if (c.owner.kind === 'none') issues.push({ kind: 'unassignedCircuit', circuitId: c.id, text: `${circuitLabel(c)} is not given to a signal box or line.` });
    else if (!onLayout(c.owner.boxId)) issues.push({ kind: 'offLayoutCircuit', circuitId: c.id, text: `${circuitLabel(c)} belongs to ${boxName(c.owner.boxId)}, which is not on this layout.` });
  }
  for (const j of plan.junctions) {
    if (j.kind === 'joint') continue;
    if (!j.boxId) {
      if (j.kind !== 'turntable') issues.push({ kind: 'unassignedJunction', junctionId: j.id, text: `${junctionName(j)} is not worked by a signal box.` });
    } else if (!onLayout(j.boxId)) issues.push({ kind: 'offLayoutJunction', junctionId: j.id, text: `${junctionName(j)} is worked from ${boxName(j.boxId)}, which is not on this layout.` });
  }
  const seen = new Map<string, Junction>();
  for (const j of plan.junctions) {
    if (j.kind === 'joint') continue;
    const key = `${ownerKey(junctionWorker(j))}|${j.number.trim().toUpperCase()}`;
    if (seen.has(key)) issues.push({ kind: 'duplicateNumber', junctionId: j.id, text: `${junctionName(j)}: number ${j.number} is used twice${j.boxId ? ` in ${boxName(j.boxId)}` : ''}.` });
    else seen.set(key, j);
  }
  // Traffic: trains running straight on from one track to the next must keep going the same way.
  const clashSeen = new Set<string>();
  for (const c of plan.circuits) {
    if (!c.traffic) continue;
    for (const end of [0, 1] as const) {
      const r = runOn(plan, c, end);
      if (!r || !r.circuit.traffic) continue;
      const key = [c.id, r.circuit.id].sort().join('|');
      if (clashSeen.has(key)) continue;
      clashSeen.add(key);
      const outHere = c.traffic.toward === end; // c's trains leave by this end
      const inThere = r.circuit.traffic.toward !== r.end; // the next track's trains leave by the far end
      if (outHere !== inThere) issues.push({ kind: 'flowClash', circuitId: c.id, text: `${circuitLabel(c)} and ${circuitLabel(r.circuit)} have trains running towards each other (or away from each other) at ${r.via.kind === 'joint' ? 'the joint between them' : junctionName(r.via)}.` });
    }
  }
  const plats = new Map<string, TrackCircuit>();
  for (const c of plan.circuits) {
    if (!c.platform || c.owner.kind === 'none') continue;
    const key = `${ownerKey(c.owner)}|${c.platform.number.trim().toUpperCase()}`;
    const first = plats.get(key);
    if (first) issues.push({ kind: 'duplicatePlatform', circuitId: c.id, text: `${circuitLabel(c)}: platform ${c.platform.number} is also ${circuitLabel(first)}${c.owner.kind === 'box' ? ` in ${boxName(c.owner.boxId)}` : ''}.` });
    else plats.set(key, c);
  }
  return issues;
}

// ---------------------------------------------------------------- tidy-up

/** Tidy every layout's track plan (see sanitisePlan). */
export function sanitiseTrackPlan(state: AppState): void {
  for (const l of state.layouts) sanitisePlan(state, l);
}

/** Drop references to boxes, connections and fiddle yards that no longer exist, and repair damaged data. */
export function sanitisePlan(state: AppState, layout: Layout): void {
  const raw = layout.trackPlan as Partial<TrackPlan> | undefined;
  const plan: TrackPlan = {
    circuits: Array.isArray(raw?.circuits) ? raw!.circuits : [],
    junctions: Array.isArray(raw?.junctions) ? raw!.junctions : [],
    markers: Array.isArray(raw?.markers) ? raw!.markers : [],
  };
  layout.trackPlan = plan;
  const boxIds = new Set(state.boxes.map((b) => b.id));
  const connOk = (boxId: string, connId: string) => state.boxes.some((b) => b.id === boxId && b.connections.some((c) => c.id === connId));
  plan.junctions = plan.junctions.filter((j) => j && JUNCTIONS[j.kind]);
  for (const j of plan.junctions) {
    if (j.boxId && !boxIds.has(j.boxId)) j.boxId = '';
    if (j.connectionId !== undefined && (!j.boxId || !connOk(j.boxId, j.connectionId))) delete j.connectionId;
    j.number = String(j.number ?? '');
    if (typeof j.rotate !== 'boolean') {
      // v0.3.6 'flip' mirrored left to right, which is a half turn of the top-to-bottom mirror image.
      const f = !!j.flip;
      j.rotate = f;
      j.mirror = f;
    }
    j.mirror = !!j.mirror;
    j.quarter = !!j.quarter;
    delete j.flip;
    if (j.kind === 'turntable') {
      const ids = JUNCTIONS.turntable.ports.map((p) => p.id);
      j.roads = Array.isArray(j.roads) ? j.roads.filter((r) => ids.includes(r)) : [...TURNTABLE_DEFAULT_ROADS];
    } else delete j.roads;
  }
  plan.circuits = plan.circuits.filter((c) => c && Array.isArray(c.ends) && c.ends.length === 2);
  for (const c of plan.circuits) {
    c.name ??= '';
    c.code = String(c.code ?? '');
    if (c.via !== undefined) {
      c.via = Array.isArray(c.via) ? c.via.filter((v) => v && Number.isFinite(v.x) && Number.isFinite(v.y)).map((v) => ({ x: Math.round(v.x), y: Math.round(v.y) })) : [];
      if (!c.via.length) delete c.via;
    }
    if (c.traffic !== undefined) {
      const t = c.traffic as Partial<NonNullable<TrackCircuit['traffic']>> | null;
      if (!t || (t.line !== 'up' && t.line !== 'down')) delete c.traffic;
      else c.traffic = { line: t.line, toward: t.toward === 0 ? 0 : 1 };
    }
    if (c.platform !== undefined) {
      const pl = c.platform as Partial<NonNullable<TrackCircuit['platform']>> | null;
      if (!pl || typeof pl !== 'object') delete c.platform;
      else c.platform = { number: String(pl.number ?? '').trim() || '1', side: pl.side === -1 ? -1 : 1 };
    }
    const o = c.owner;
    if (!o || (o.kind === 'box' && !boxIds.has(o.boxId)) || ((o.kind === 'line' || o.kind === 'remote') && !connOk(o.boxId, o.connectionId))) c.owner = { kind: 'none' };
    c.ends.forEach((e, i) => {
      if (e.kind === 'joined') {
        const j = findJunction(plan, e.junctionId);
        if (!j || !portsOf(j).some((p) => p.id === e.port)) c.ends[i] = { kind: 'open', x: 0, y: 0 };
      } else if (e.kind === 'exit') {
        const t = e.to;
        if (!t || (t.kind === 'place' && !layout.places.some((y) => y.id === t.placeId)) || (t.kind === 'connection' && !connOk(t.boxId, t.connectionId))) e.to = { kind: 'offScene' };
      }
    });
  }
  for (const j of plan.junctions) normaliseMirror(plan, j);
  pruneJoints(plan);
  // A port may only be joined once: later duplicates become unfinished.
  const used = new Set<string>();
  for (const c of plan.circuits) {
    c.ends.forEach((e, i) => {
      if (e.kind !== 'joined') return;
      const key = `${e.junctionId}|${e.port}`;
      if (used.has(key)) {
        const j = findJunction(plan, e.junctionId)!;
        const a = portAnchor(j, e.port);
        c.ends[i] = { kind: 'open', x: (a?.x ?? 0) + 1, y: (a?.y ?? 0) + 1 };
      } else used.add(key);
    });
  }
  // Signal boxes on the plan: one marker per box, for boxes and connections that still exist.
  const seenBox = new Set<string>();
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  plan.markers = plan.markers!.filter((m) => {
    if (!m || !m.box || typeof m.id !== 'string') return false;
    const ok = m.box.kind === 'box' ? boxIds.has(m.box.boxId) : m.box.kind === 'remote' && connOk(m.box.boxId, m.box.connectionId);
    if (!ok) return false;
    const key = markerKey(m.box);
    if (seenBox.has(key)) return false;
    seenBox.add(key);
    return true;
  });
  for (const m of plan.markers) {
    m.x = num(m.x);
    m.y = num(m.y);
    m.dx = num(m.dx);
    m.dy = num(m.dy, -2);
    if (typeof m.circuitId !== 'string' || (m.circuitId && !findCircuit(plan, m.circuitId))) m.circuitId = '';
  }
}
