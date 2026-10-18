// Track plan: the layout drawn as abstract track circuits joined by junctions.
// Pure logic (no DOM): geometry for drawing, editing operations, checks.
//
// Graph: circuits are edges, junctions are nodes. Each junction kind has named
// ports and a set of routes (which ports a train can run between). Every port
// is joined to at most one circuit end. A port with nothing joined, and a
// circuit end of kind 'open', are unfinished ends: the editor shows a + there.

import type { AppState, CircuitEnd, ExitTarget, Junction, JunctionKind, TrackCircuit, TrackOwner, TrackPlan } from './types';

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
  return { circuits: [], junctions: [] };
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

function makeJunction(plan: TrackPlan, kind: JunctionKind, x: number, y: number, rotate: boolean, boxId: string, quarter = false): Junction {
  const j: Junction = { id: newId('jn'), number: kind === 'joint' ? '' : nextJunctionNumber(plan), kind, boxId, x, y, rotate, mirror: false, quarter };
  if (kind === 'turntable') j.roads = [...TURNTABLE_DEFAULT_ROADS];
  plan.junctions.push(j);
  return j;
}

function ownerBox(owner: TrackOwner): string {
  return owner.kind === 'box' ? owner.boxId : '';
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
function placeJunction(plan: TrackPlan, kind: JunctionKind, at: Pt, heading: { dx: number; dy: number }, boxId: string): Junction {
  const def = JUNCTIONS[kind];
  const entry = def.ports.find((p) => p.id === def.entry)!;
  // Turned to face the way the track is heading, so right-hand points still turn to the right.
  const o0 = orientFor(heading);
  const o = orient({ ...o0, mirror: false }, entry.x, entry.y);
  return makeJunction(plan, kind, at.x - o.x, at.y - o.y, o0.rotate, boxId, o0.quarter);
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
      const j = placeJunction(plan, 'joint', a, heading, ownerBox(c.owner));
      c.ends[ref.end] = { kind: 'joined', junctionId: j.id, port: 'a' };
      const start: Anchor = { x: a.x, y: a.y, ...heading };
      const n =
        piece === 'track'
          ? makeCircuit(plan, { kind: 'joined', junctionId: j.id, port: 'b' }, { kind: 'open', ...stepOut(start, 8) }, c.owner)
          : curveFrom(plan, { kind: 'joined', junctionId: j.id, port: 'b' }, start, piece === 'curveLeft' ? 'left' : 'right', c.owner);
      return { circuitId: n.id };
    }
    const j = placeJunction(plan, piece, a, { dx: Math.sign(a.dx), dy: Math.sign(a.dy) }, ownerBox(c.owner));
    c.ends[ref.end] = { kind: 'joined', junctionId: j.id, port: JUNCTIONS[piece].entry };
    return { junctionId: j.id };
  }

  // From a junction port: there must be a track circuit between the port and anything else.
  const j0 = findJunction(plan, ref.junctionId)!;
  const owner: TrackOwner = j0.boxId ? { kind: 'box', boxId: j0.boxId } : { kind: 'none' };
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
  const j = placeJunction(plan, piece, far, a.dx === 0 ? { dx: 0, dy: Math.sign(a.dy) } : { dx: Math.sign(a.dx), dy: 0 }, j0.boxId);
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
    const j = placeJunction(plan, 'joint', ha, { dx: Math.sign(ha.dx), dy: ha.dx === 0 ? Math.sign(ha.dy) : 0 }, ownerBox(ca.owner));
    ca.ends[a.end] = { kind: 'joined', junctionId: j.id, port: 'a' };
    cb.ends[b.end] = { kind: 'joined', junctionId: j.id, port: 'b' };
    return { circuitId: cb.id };
  }
  if (a.kind === 'port' && b.kind === 'port') {
    if (a.junctionId === b.junctionId && a.port === b.port) return { error: 'Choose a different end.' };
    const ja = findJunction(plan, a.junctionId)!;
    const owner: TrackOwner = ja.boxId ? { kind: 'box', boxId: ja.boxId } : { kind: 'none' };
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
  if (k.circuit.owner.kind === 'none') k.circuit.owner = structuredClone(o.circuit.owner);
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
  plan.circuits = plan.circuits.filter((c) => c.id !== circuitId);
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
  if (!j2) j2 = makeJunction(plan, kind, jx, jy, rotate, j1.boxId);
  const owner: TrackOwner = j1.boxId ? { kind: 'box', boxId: j1.boxId } : { kind: 'none' };
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
  const j = makeJunction(plan, kind, x, y, rotate, ownerBox(c.owner));
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

export function sameOwner(a: TrackOwner, b: TrackOwner): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'box' && b.kind === 'box') return a.boxId === b.boxId;
  if (a.kind === 'line' && b.kind === 'line') return a.boxId === b.boxId && a.connectionId === b.connectionId;
  return true;
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
  const startBox = ownerBox(start.owner);
  const canTake = (c: TrackCircuit) => c.owner.kind === 'none' || (c.owner.kind === 'box' && c.owner.boxId === startBox);
  const seen = new Set<string>([start.id]);
  const circuits: TrackCircuit[] = [start];
  const junctions = new Map<string, Junction>();
  const queue = [start];
  while (queue.length) {
    const c = queue.shift()!;
    for (const e of c.ends) {
      if (e.kind !== 'joined') continue;
      const j = findJunction(plan, e.junctionId);
      if (j && (j.boxId === '' || j.boxId === startBox)) junctions.set(j.id, j);
    }
    for (const n of neighbours(plan, c)) {
      if (seen.has(n.circuit.id) || !canTake(n.circuit)) continue;
      if (n.via.boxId !== '' && n.via.boxId !== startBox) continue;
      seen.add(n.circuit.id);
      circuits.push(n.circuit);
      queue.push(n.circuit);
    }
  }
  return { circuits, junctions: [...junctions.values()] };
}

export function giveBranch(plan: TrackPlan, circuitId: string, boxId: string): number {
  const { circuits, junctions } = branchFrom(plan, circuitId);
  for (const c of circuits) c.owner = { kind: 'box', boxId };
  for (const j of junctions) j.boxId = boxId;
  return circuits.length + junctions.length;
}

// ---------------------------------------------------------------- checks

export type PlanIssue =
  | { kind: 'openEnd'; ref: OpenEndRef; text: string }
  | { kind: 'unassignedCircuit'; circuitId: string; text: string }
  | { kind: 'unassignedJunction'; junctionId: string; text: string }
  | { kind: 'duplicateNumber'; junctionId: string; text: string };

export function planIssues(state: AppState): PlanIssue[] {
  const plan = state.trackPlan;
  const issues: PlanIssue[] = [];
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
  for (const c of plan.circuits) if (c.owner.kind === 'none') issues.push({ kind: 'unassignedCircuit', circuitId: c.id, text: `${circuitLabel(c)} is not given to a signal box or line.` });
  for (const j of plan.junctions) if (!j.boxId && j.kind !== 'joint' && j.kind !== 'turntable') issues.push({ kind: 'unassignedJunction', junctionId: j.id, text: `${junctionName(j)} is not worked by a signal box.` });
  const seen = new Map<string, Junction>();
  for (const j of plan.junctions) {
    if (j.kind === 'joint') continue;
    const key = `${j.boxId}|${j.number.trim().toUpperCase()}`;
    if (seen.has(key)) issues.push({ kind: 'duplicateNumber', junctionId: j.id, text: `${junctionName(j)}: number ${j.number} is used twice${j.boxId ? ` in ${state.boxes.find((b) => b.id === j.boxId)?.name ?? 'that box'}` : ''}.` });
    else seen.set(key, j);
  }
  return issues;
}

// ---------------------------------------------------------------- tidy-up

/** Drop references to boxes, connections and fiddle yards that no longer exist, and repair damaged data. */
export function sanitiseTrackPlan(state: AppState): void {
  const raw = state.trackPlan as Partial<TrackPlan> | undefined;
  const plan: TrackPlan = {
    circuits: Array.isArray(raw?.circuits) ? raw!.circuits : [],
    junctions: Array.isArray(raw?.junctions) ? raw!.junctions : [],
  };
  state.trackPlan = plan;
  const boxIds = new Set(state.boxes.map((b) => b.id));
  const connOk = (boxId: string, connId: string) => state.boxes.some((b) => b.id === boxId && b.connections.some((c) => c.id === connId));
  plan.junctions = plan.junctions.filter((j) => j && JUNCTIONS[j.kind]);
  for (const j of plan.junctions) {
    if (j.boxId && !boxIds.has(j.boxId)) j.boxId = '';
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
    const o = c.owner;
    if (!o || (o.kind === 'box' && !boxIds.has(o.boxId)) || (o.kind === 'line' && !connOk(o.boxId, o.connectionId))) c.owner = { kind: 'none' };
    c.ends.forEach((e, i) => {
      if (e.kind === 'joined') {
        const j = findJunction(plan, e.junctionId);
        if (!j || !portsOf(j).some((p) => p.id === e.port)) c.ends[i] = { kind: 'open', x: 0, y: 0 };
      } else if (e.kind === 'exit') {
        const t = e.to;
        if (!t || (t.kind === 'fiddleYard' && !state.fiddleYards.some((y) => y.id === t.yardId)) || (t.kind === 'connection' && !connOk(t.boxId, t.connectionId))) e.to = { kind: 'offScene' };
      }
    });
  }
  for (const j of plan.junctions) normaliseMirror(plan, j);
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
}
