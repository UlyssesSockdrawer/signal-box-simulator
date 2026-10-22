import { boxesOn } from './layouts';
import { circuitLength } from './railway';
import { boxSignals, canRun, lineCircuits, nextSteps, portsFrom, type Dir, type Step } from './routing';
import { newId } from './store';

/** Box track this long between the last points and the line gets an advanced starter. */
const ADVANCED_STARTER_ROOM = 200;
import { circuitPath, findCircuit, findJunction, portUse } from './trackPlan';
import type { AppState, BoxDef, Junction, Layout, PlanSignal, SignalKind, SignallingOptions, SignalStyle, TrackCircuit } from './types';

/*
 * SIGNALS ON THE TRACK PLAN (v0.3.29).
 *
 * A signal stands beside a track circuit, `back` metres before one of its ends, and applies to trains
 * running towards that end. Several signals at one place form a POST (arms on a bracket, or colour
 * light signals with route indications), and share the routes from that place between them.
 *
 * ROUTES are worked out from the plan as it is, never stored, so a signal picks up new track by
 * itself: from the signal, forward along every way the points allow, until the next signal that
 * ends the route (for a running signal: the next home or starter; for a shunt signal: the next stop
 * signal or shunt signal or limit of shunt), buffer stops, or the edge of the plan. A route's KEY
 * names where it ends ("sig:<post>", "buffers:<circuit>", "exit:<circuit>", "end:<circuit>"). A
 * signal's `reads` can pin it to some routes (one arm per road on a bracket); unpinned signals read
 * whatever routes are left, including new ones.
 *
 * GENERATING (generateSignals) gives each box on the layout a complete arrangement, keeping every
 * signal placed or changed by hand. RUNNING ROADS are the block sections' line circuits, station roads
 * (platforms and roads of stations) and the circuits between them; sidings, goods and depot roads are
 * not running roads.
 *  - Starters: at the exit end of every station road that leads on to a line through running track
 *    only; an advanced starter (the section signal) at the line itself when trains from sidings also
 *    join in between, no station road leads there, or the box's track runs on 200 m or more past the
 *    last points (room for a train to stand between the starter and the advanced starter).
 *  - Homes: where a line meets the box's track, one per destination (each station road, each siding
 *    or goods place, on through to a line) as arms on one post; a single home if there is one.
 *  - Distants: on the last circuit of the line before each home, 1,000 yards out (less on a short circuit).
 *  - Shunt signals (option): where sidings join running track, and on running track between stations
 *    roads and points (for setting back); yellow where the signal stands at facing points one road of
 *    which stays in the sidings (it may be passed at danger for that road).
 *  - Shunt-ahead (option): on each section signal, with a limit of shunt on the line 200 m beyond it.
 * LEVERS are numbered west to east in each box's frame (numberLevers): signals, points (whose plan
 * numbers become their lever numbers) and facing point locks.
 */

export interface SignalKindInfo {
  name: string;
  /** main: home/starter; shunt: ground signals; shuntAhead; distant; los: limit of shunt. */
  cls: 'main' | 'distant' | 'shunt' | 'shuntAhead' | 'los';
  /** Worked by a lever. */
  lever: boolean;
  description: string;
}

export const SIGNAL_KINDS: Record<SignalKind, SignalKindInfo> = {
  home: { name: 'Home', cls: 'main', lever: true, description: 'Stop signal protecting the station from trains off the line. Trains must not pass it at danger.' },
  starter: { name: 'Starter', cls: 'main', lever: true, description: 'Stop signal at the end of a station road. The last one before a block section is the section signal: it may be cleared only with Line Clear.' },
  distant: { name: 'Distant', cls: 'distant', lever: true, description: 'Caution signal before the home. At caution, the driver must be ready to stop at the next stop signal; it is cleared only when the stop signals ahead are off.' },
  shunt: { name: 'Shunt', cls: 'shunt', lever: true, description: 'Ground signal (disc, or position light) for shunting moves. Not passed at danger.' },
  shuntYellow: { name: 'Shunt (yellow)', cls: 'shunt', lever: true, description: 'Yellow ground signal: may be passed at danger for a move it does not apply to, e.g. into a headshunt or siding; cleared for the move it controls.' },
  shuntAhead: { name: 'Shunt-ahead', cls: 'shuntAhead', lever: true, description: 'Small arm or light on a section signal’s post: lets a train pass the section signal at danger to shunt into the section, as far as the limit of shunt.' },
  limitOfShunt: { name: 'Limit of shunt', cls: 'los', lever: false, description: 'Board (or two red lights) where a shunting move must stop. No lever.' },
};

export const SIGNAL_KIND_ORDER: SignalKind[] = ['home', 'starter', 'distant', 'shunt', 'shuntYellow', 'shuntAhead', 'limitOfShunt'];

export const SIGNAL_STYLES: Record<SignalStyle, string> = { semaphore: 'Semaphore', colourLight: 'Colour light' };

export const DEFAULT_SIGNALLING: SignallingOptions = { style: 'semaphore', shunt: true, shuntAhead: false };

/** How far out a generated distant stands from its home (metres): about 1,000 yards. */
const DISTANT_BACK = 914;
/** How far into the section a generated limit of shunt stands (metres). */
const LOS_INTO_SECTION = 200;

export function signalsOf(layout: Layout | undefined): PlanSignal[] {
  return layout?.trackPlan.signals ?? [];
}

export function findSignal(layout: Layout | undefined, id: string): PlanSignal | undefined {
  return signalsOf(layout).find((s) => s.id === id);
}

/** Signals at one place (a post): same circuit, end and distance back. */
export function postKey(s: { circuitId: string; end: 0 | 1; back: number }): string {
  return `${s.circuitId}|${s.end}|${Math.round(s.back)}`;
}

const clsOf = (k: SignalKind) => SIGNAL_KINDS[k].cls;

// ---------------------------------------------------------------------------- routes

export type RouteEnd = { kind: 'signal'; post: string; circuitId: string } | { kind: 'buffers' | 'exit' | 'end'; circuitId: string };

export interface SignalRoute {
  key: string;
  /** e.g. "to P1", "to Goods shed", "to Fiddle Yard East". */
  label: string;
  /**
   * Where it leads, as a home arm sees it: a station road, a siding place, a line ("road:…", "place:…",
   * "exit:…"). Generated arms are pinned to this, so they still read the route when a signal is added
   * part way along it.
   */
  group: string;
  /** The circuits it runs over, from the one after the signal (or the signal's own, when it stands back from the end). */
  steps: Step[];
  to: RouteEnd;
}

/** The class of signals whose routes start at a post: what ends them. */
function ends(cls: SignalKindInfo['cls'], k: SignalKind): boolean {
  if (cls === 'main') return clsOf(k) === 'main';
  // Shunt and shunt-ahead moves stop at the next stop signal, shunt signal or limit of shunt.
  return clsOf(k) === 'main' || clsOf(k) === 'shunt' || clsOf(k) === 'los';
}

/** The name of a place on the plan: a road ("P1", "Goods shed"), else the circuit's name or code. */
export function circuitPlaceName(layout: Layout, circuitId: string): string {
  for (const p of layout.places) {
    const r = p.roads.find((x) => x.circuitId === circuitId);
    if (r) return /^(p\d|platform)/i.test(r.name) ? r.name : r.name || p.name;
  }
  const c = findCircuit(layout.trackPlan, circuitId);
  if (c?.platform) return `P${c.platform.number}`;
  return c ? c.name || c.code : 'the line';
}

function exitName(state: AppState, layout: Layout, c: TrackCircuit, end: 0 | 1): string {
  const e = c.ends[end];
  if (e.kind !== 'exit') return circuitPlaceName(layout, c.id);
  const t = e.to;
  if (t.kind === 'place') return layout.places.find((p) => p.id === t.placeId)?.name ?? 'off the plan';
  if (t.kind === 'connection') return state.boxes.find((b) => b.id === t.boxId)?.connections.find((x) => x.id === t.connectionId)?.neighbourName ?? 'off the plan';
  return 'off the plan';
}

/**
 * Every route from a place on the plan for a class of signal (ignoring the signals listed in
 * `except`, i.e. the post's own). Bounded: at most 60 routes of at most 80 circuits.
 */
export function routesFrom(state: AppState, layout: Layout, at: { circuitId: string; end: 0 | 1; back: number }, cls: SignalKindInfo['cls'], except: Set<string> = new Set()): SignalRoute[] {
  const plan = layout.trackPlan;
  const c0 = findCircuit(plan, at.circuitId);
  if (!c0 || cls === 'distant' || cls === 'los') return [];
  const anyWay = cls !== 'main';
  const sigs = signalsOf(layout).filter((s) => !except.has(s.id) && ends(cls, s.kind));
  /** The first signal met running along a circuit towards `toward`, from `fromBack` metres before its end (Infinity = from its start). */
  const metIn = (circuitId: string, toward: 0 | 1, fromBack: number) => {
    let best: PlanSignal | undefined;
    for (const s of sigs) if (s.circuitId === circuitId && s.end === toward && s.back < fromBack - 0.01 && (!best || s.back > best.back)) best = s;
    return best;
  };
  const out: SignalRoute[] = [];
  const len = (id: string) => circuitLength(state, layout, id).metres;
  const finish = (steps: Step[], to: RouteEnd) => {
    const last = steps[steps.length - 1];
    const lastC = findCircuit(plan, last.circuitId)!;
    const atLimit = to.kind === 'signal' && sigs.some((s) => s.kind === 'limitOfShunt' && postKey(s) === to.post);
    const label = to.kind === 'exit' ? `to ${exitName(state, layout, lastC, last.toward)}` : atLimit ? 'to the limit of shunt' : `to ${circuitPlaceName(layout, to.circuitId)}`;
    const key = to.kind === 'signal' ? `sig:${to.post}` : `${to.kind}:${to.circuitId}`;
    if (!out.some((r) => r.key === key)) out.push({ key, label, group: groupOf(layout, { steps, to }).key, steps, to });
  };
  const walk = (steps: Step[], seen: Set<string>) => {
    if (out.length >= 60 || steps.length > 80) return;
    const s = steps[steps.length - 1];
    const fromBack = steps.length === 1 && at.back > 0 && s.circuitId === at.circuitId ? at.back : Infinity;
    const met = metIn(s.circuitId, s.toward, fromBack);
    if (met) return finish(steps, { kind: 'signal', post: postKey(met), circuitId: met.circuitId });
    const c = findCircuit(plan, s.circuitId)!;
    const e = c.ends[s.toward];
    if (e.kind === 'bufferStops') return finish(steps, { kind: 'buffers', circuitId: c.id });
    if (e.kind === 'exit') return finish(steps, { kind: 'exit', circuitId: c.id });
    if (e.kind !== 'joined') return finish(steps, { kind: 'end', circuitId: c.id });
    const next = nextSteps(state, layout, s, { anyWay });
    if (!next.length) return finish(steps, { kind: 'end', circuitId: c.id });
    for (const n of next) {
      const k = `${n.circuitId}|${n.toward}`;
      if (seen.has(k)) continue;
      walk([...steps, n], new Set([...seen, k]));
    }
  };
  if (at.back > 0) {
    walk([{ circuitId: c0.id, toward: at.end, metres: len(c0.id), via: null }], new Set([`${c0.id}|${at.end}`]));
  } else {
    for (const n of nextSteps(state, layout, { circuitId: c0.id, toward: at.end }, { anyWay })) walk([n], new Set([`${n.circuitId}|${n.toward}`]));
  }
  return out;
}

/** The signals at a post of one class, and the routes each reads (pinned reads first; the rest go to the unpinned signal). */
export function postRoutes(state: AppState, layout: Layout, sig: PlanSignal): { routes: SignalRoute[]; reads: Map<string, SignalRoute[]>; unread: SignalRoute[] } {
  const cls = clsOf(sig.kind);
  const arms = signalsOf(layout).filter((s) => postKey(s) === postKey(sig) && clsOf(s.kind) === cls);
  const routes = routesFrom(state, layout, sig, cls, new Set(signalsOf(layout).filter((s) => postKey(s) === postKey(sig)).map((s) => s.id)));
  const reads = new Map<string, SignalRoute[]>();
  const taken = new Set<string>();
  for (const a of arms) {
    if (!a.reads) continue;
    const mine = routes.filter((r) => (a.reads!.includes(r.key) || a.reads!.includes(r.group)) && !taken.has(r.key));
    mine.forEach((r) => taken.add(r.key));
    reads.set(a.id, mine);
  }
  const free = arms.filter((a) => !a.reads);
  const left = routes.filter((r) => !taken.has(r.key));
  free.forEach((a, i) => reads.set(a.id, i === 0 ? left : []));
  return { routes, reads, unread: free.length ? [] : left };
}

/** The routes a signal reads to. Distants and limits of shunt have none. */
export function signalRoutes(state: AppState, layout: Layout, sig: PlanSignal): SignalRoute[] {
  return postRoutes(state, layout, sig).reads.get(sig.id) ?? [];
}

// ---------------------------------------------------------------------------- running roads

/** A circuit is a station road: a platform, or tied to a road of a station. */
function isStationRoad(layout: Layout, c: TrackCircuit): boolean {
  if (c.platform) return true;
  return layout.places.some((p) => p.kind === 'station' && p.roads.some((r) => r.circuitId === c.id));
}

/** A circuit tied to a road of a place that is not a station (sidings, goods, depot, fiddle yard…). */
function isSidingRoad(layout: Layout, c: TrackCircuit): boolean {
  return layout.places.some((p) => p.kind !== 'station' && p.roads.some((r) => r.circuitId === c.id));
}

/**
 * The running roads of a box's area and its lines: line circuits, station roads, and track that leads
 * both ways (without passing sidings) to station roads or lines.
 */
export function runningCircuits(state: AppState, layout: Layout, box: BoxDef): Set<string> {
  const plan = layout.trackPlan;
  const lines = new Set(box.connections.flatMap((x) => lineCircuits(layout, box.id, x.id).map((c) => c.id)));
  const mine = plan.circuits.filter((c) => (c.owner.kind === 'box' && c.owner.boxId === box.id) || lines.has(c.id));
  const out = new Set<string>(lines);
  for (const c of mine) if (isStationRoad(layout, c)) out.add(c.id);
  const anchor = (c: TrackCircuit) => lines.has(c.id) || isStationRoad(layout, c);
  const reaches = (start: Dir): boolean => {
    const seen = new Set<string>();
    const queue: Dir[] = [start];
    while (queue.length) {
      const d = queue.shift()!;
      for (const n of nextSteps(state, layout, d, { anyWay: true })) {
        const k = `${n.circuitId}|${n.toward}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const c = findCircuit(plan, n.circuitId)!;
        if (anchor(c)) return true;
        if (isSidingRoad(layout, c) || !mine.includes(c)) continue;
        queue.push(n);
      }
    }
    return false;
  };
  for (const c of mine) {
    if (out.has(c.id) || isSidingRoad(layout, c)) continue;
    if (reaches({ circuitId: c.id, toward: 0 }) && reaches({ circuitId: c.id, toward: 1 })) out.add(c.id);
  }
  return out;
}

/** Points worked by a box that need a facing point lock: facing for a move from running track to running track. */
export function needsFpl(state: AppState, layout: Layout, j: Junction): boolean {
  if (j.lock) return j.lock === 'fpl';
  if (!isPoints(j) || !j.boxId || j.connectionId) return false;
  const box = state.boxes.find((b) => b.id === j.boxId);
  if (!box) return false;
  const running = runningCircuits(state, layout, box);
  const plan = layout.trackPlan;
  for (const c of plan.circuits) {
    if (!running.has(c.id)) continue;
    for (const end of [0, 1] as const) {
      const e = c.ends[end];
      if (e.kind !== 'joined' || e.junctionId !== j.id || !canRun(c, end)) continue;
      const outs = portsFrom(j, e.port).filter((p) => {
        const u = portUse(plan, j.id, p);
        return u && running.has(u.circuit.id);
      });
      // Entering by a port with a choice of roads (facing), at least one of them running.
      if (portsFrom(j, e.port).length > 1 && outs.length) return true;
    }
  }
  return false;
}

/** Junctions worked by a lever: points of every kind, slips, crossings with switches, catch points (not plain joints, diamonds or turntables). */
export function isPoints(j: Junction): boolean {
  return j.kind !== 'joint' && j.kind !== 'diamond' && j.kind !== 'turntable';
}

// ---------------------------------------------------------------------------- where a signal is drawn

/**
 * Where a signal stands on the drawn plan (grid units) and the way trains run there. `extraUnits`
 * moves it further back along the track (the diagram does this to keep posts clear of labels).
 */
export function signalPoint(state: AppState, layout: Layout, s: { circuitId: string; end: 0 | 1; back: number }, minUnits = 0.7, extraUnits = 0): { x: number; y: number; dx: number; dy: number } | null {
  const plan = layout.trackPlan;
  const c = findCircuit(plan, s.circuitId);
  if (!c) return null;
  const path = circuitPath(plan, c);
  if (path.length < 2) return null;
  // Walk back from the end the signal faces.
  const pts = s.end === 1 ? [...path].reverse() : path;
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(l);
    total += l;
  }
  const metres = circuitLength(state, layout, c).metres || 1;
  let d = Math.min(total * (extraUnits ? 0.95 : 0.92), Math.max(Math.min(minUnits, total / 2), (s.back / metres) * total) + extraUnits);
  for (let i = 1; i < pts.length; i++) {
    const l = segs[i - 1];
    if (d <= l || i === pts.length - 1) {
      const f = l ? Math.min(1, d / l) : 0;
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f;
      const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
      // Trains run towards the end: from pts[i] back to pts[i-1].
      const dx = (pts[i - 1].x - pts[i].x) / (l || 1);
      const dy = (pts[i - 1].y - pts[i].y) / (l || 1);
      return { x, y, dx, dy };
    }
    d -= l;
  }
  return null;
}

// ---------------------------------------------------------------------------- editing

/** The box whose frame works signals on a circuit: its own track's box, or the box at the line's end. */
export function boxOfCircuit(layout: Layout, circuitId: string): string {
  const c = findCircuit(layout.trackPlan, circuitId);
  const o = c?.owner;
  return o && (o.kind === 'box' || o.kind === 'line') ? o.boxId : '';
}

/** Place a signal by hand. */
export function addSignal(state: AppState, layout: Layout, at: { circuitId: string; end: 0 | 1; back?: number }, kind: SignalKind, style: SignalStyle): PlanSignal {
  const plan = layout.trackPlan;
  const s: PlanSignal = {
    id: newId('sig'),
    kind,
    style,
    number: '',
    name: `${SIGNAL_KINDS[kind].name} at ${circuitPlaceName(layout, at.circuitId)}`,
    boxId: boxOfCircuit(layout, at.circuitId),
    circuitId: at.circuitId,
    end: at.end,
    back: Math.max(0, at.back ?? 0),
    manual: true,
  };
  if (SIGNAL_KINDS[kind].lever && s.boxId) s.number = nextFreeLever(state, layout, s.boxId);
  (plan.signals ??= []).push(s);
  void state;
  return s;
}

/** Change a signal by hand (it is then kept when signals are generated again). */
export function updateSignal(layout: Layout, id: string, patch: Partial<Omit<PlanSignal, 'id'>>): void {
  const s = findSignal(layout, id);
  if (!s) return;
  Object.assign(s, patch, { manual: true });
  if (patch.back !== undefined) s.back = Math.max(0, Number(patch.back) || 0);
  if (!SIGNAL_KINDS[s.kind].lever) s.number = '';
}

export function deleteSignal(layout: Layout, id: string): void {
  const plan = layout.trackPlan;
  plan.signals = (plan.signals ?? []).filter((s) => s.id !== id);
}

/** The lever numbers used in a box's frame: signals, points and facing point locks. */
export function leversUsed(layout: Layout, boxId: string): string[] {
  const out: string[] = [];
  for (const s of signalsOf(layout)) if (s.boxId === boxId && s.number) out.push(s.number);
  for (const j of layout.trackPlan.junctions) {
    if (j.boxId !== boxId || j.connectionId || !isPoints(j)) continue;
    if (j.number) out.push(j.number);
    if (j.fplNumber) out.push(j.fplNumber);
  }
  return out;
}

function nextFreeLever(state: AppState, layout: Layout, boxId: string): string {
  void state;
  const used = new Set(leversUsed(layout, boxId));
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

// ---------------------------------------------------------------------------- generating

/** Generate a signal arrangement for every box on the layout, keeping signals placed or changed by hand. Then number the levers. */
export function generateSignals(state: AppState, layout: Layout, opts: SignallingOptions = DEFAULT_SIGNALLING, random: () => number = Math.random): { added: number; kept: number } {
  const plan = layout.trackPlan;
  const kept = (plan.signals ?? []).filter((s) => s.manual);
  plan.signals = [...kept];
  plan.signalling = { ...opts };
  const styleFor = new Map<string, SignalStyle>();
  /** The style of a post: the one asked for, or at random per post for a mixed layout. */
  const style = (post: string): SignalStyle => {
    if (opts.style !== 'mixed') return opts.style;
    let s = styleFor.get(post);
    if (!s) styleFor.set(post, (s = random() < 0.5 ? 'semaphore' : 'colourLight'));
    return s;
  };
  let added = 0;
  const has = (at: { circuitId: string; end: 0 | 1; back: number }, cls: SignalKindInfo['cls']) =>
    (plan.signals ?? []).some((s) => postKey(s) === postKey(at) && clsOf(s.kind) === cls);
  const manualAt = (at: { circuitId: string; end: 0 | 1; back: number }, cls: SignalKindInfo['cls']) =>
    kept.some((s) => postKey(s) === postKey(at) && clsOf(s.kind) === cls);
  const put = (boxId: string, kind: SignalKind, at: { circuitId: string; end: 0 | 1; back: number }, name: string, reads?: string[]) => {
    const s: PlanSignal = { id: newId('sig'), kind, style: style(postKey(at)), number: '', name, boxId, circuitId: at.circuitId, end: at.end, back: Math.round(at.back), manual: false };
    if (reads) s.reads = reads;
    plan.signals!.push(s);
    added++;
    return s;
  };
  for (const box of boxesOn(state, layout.id)) {
    const defs = boxSignals(state, layout, box);
    const running = runningCircuits(state, layout, box);
    const conn = (id: string) => box.connections.find((x) => x.id === id);
    const circuit = (id: string) => findCircuit(plan, id)!;
    // ---- starters (section signals)
    const sectionAt: Array<{ circuitId: string; end: 0 | 1; connId: string }> = [];
    for (const d of defs.filter((x) => x.kind === 'section')) {
      const to = conn(d.connectionId)?.neighbourName ?? 'the line';
      const n = circuit(d.circuitId);
      const roads: Array<{ circuitId: string; end: 0 | 1 }> = [];
      let sidingsJoin = false;
      if (isStationRoad(layout, n)) roads.push({ circuitId: n.id, end: d.end });
      else {
        // Walk back from the line through running track to the station roads that lead here.
        const seen = new Set<string>([n.id]);
        const queue: Dir[] = [{ circuitId: n.id, toward: (1 - d.end) as 0 | 1 }];
        while (queue.length) {
          const q = queue.shift()!;
          for (const m of nextSteps(state, layout, q, { anyWay: true })) {
            if (seen.has(m.circuitId)) continue;
            seen.add(m.circuitId);
            const mc = circuit(m.circuitId);
            const exitEnd = (1 - m.toward) as 0 | 1;
            if (!canRun(mc, exitEnd)) continue;
            if (isStationRoad(layout, mc)) roads.push({ circuitId: mc.id, end: exitEnd });
            else if (running.has(mc.id) && mc.owner.kind !== 'line') queue.push(m);
            else sidingsJoin = true;
          }
        }
      }
      for (const r of roads) {
        const at = { ...r, back: 0 };
        sectionAt.push({ ...r, connId: d.connectionId });
        if (!has(at, 'main')) put(box.id, 'starter', at, `Starter to ${to} (${circuitPlaceName(layout, r.circuitId)})`);
      }
      // An advanced starter also where the box's own track runs on a fair way past the points (its
      // station limits stretch out along the line), so a train can stand clear of the station.
      const roomy = n.owner.kind !== 'line' && circuitLength(state, layout, n).metres >= ADVANCED_STARTER_ROOM;
      if (!isStationRoad(layout, n) && (sidingsJoin || !roads.length || roomy)) {
        const at = { circuitId: n.id, end: d.end, back: 0 };
        sectionAt.push({ circuitId: n.id, end: d.end, connId: d.connectionId });
        if (!has(at, 'main')) put(box.id, 'starter', at, `Advanced starter to ${to}`);
      }
    }
    // ---- homes, one arm per destination, and their distants
    for (const d of defs.filter((x) => x.kind === 'home')) {
      const from = conn(d.connectionId)?.neighbourName ?? 'the line';
      const at = { circuitId: d.circuitId, end: d.end, back: 0 };
      if (!manualAt(at, 'main')) {
        const routes = routesFrom(state, layout, at, 'main');
        const groups = new Map<string, { label: string; keys: string[] }>();
        for (const r of routes) {
          const g = groupOf(layout, r);
          groups.set(g.key, { label: g.label, keys: [g.key] });
        }
        const list = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        if (list.length <= 1) put(box.id, 'home', at, `Home from ${from}`);
        else for (const g of list) put(box.id, 'home', at, `Home from ${from} ${g.label}`, g.keys);
      }
      const l = circuit(d.circuitId);
      const metres = circuitLength(state, layout, l).metres;
      const dat = { circuitId: l.id, end: d.end, back: Math.round(Math.max(0, Math.min(DISTANT_BACK, metres - 50))) };
      if (!signalsOf(layout).some((s) => s.kind === 'distant' && s.circuitId === l.id && s.end === d.end)) put(box.id, 'distant', dat, `Distant from ${from}`);
    }
    // ---- shunt signals
    if (opts.shunt) {
      const mine = plan.circuits.filter((c) => c.owner.kind === 'box' && c.owner.boxId === box.id);
      /** Running the way it points along track off the running lines, does it reach a running line? */
      const reachesRunning = (start: Dir): boolean => {
        const seen = new Set<string>();
        const todo: Dir[] = [start];
        while (todo.length && seen.size < 200) {
          const d = todo.pop()!;
          const k = `${d.circuitId}|${d.toward}`;
          if (seen.has(k)) continue;
          seen.add(k);
          if (running.has(d.circuitId)) return true;
          todo.push(...nextSteps(state, layout, d, { anyWay: true }));
        }
        return false;
      };
      for (const c of mine) {
        for (const end of [0, 1] as const) {
          const e = c.ends[end];
          if (e.kind !== 'joined') continue;
          const j = findJunction(plan, e.junctionId);
          if (!j || j.kind === 'joint') continue;
          const at = { circuitId: c.id, end, back: 0 };
          if (has(at, 'main') || has(at, 'shunt')) continue;
          const outs = portsFrom(j, e.port).map((p) => portUse(plan, j.id, p)?.circuit).filter((x): x is TrackCircuit => !!x);
          const toRunning = outs.filter((x) => running.has(x.id));
          const toSidings = outs.filter((x) => !running.has(x.id));
          const here = circuitPlaceName(layout, c.id);
          if (!running.has(c.id)) {
            // Out of the sidings on to running track.
            if (toRunning.length) {
              put(box.id, toSidings.length ? 'shuntYellow' : 'shunt', at, `Shunt from ${here}`);
              continue;
            }
            // Further back, where these points choose between heading for the running line and staying
            // off it (a headshunt, or back into the yard): a yellow shunt signal, which a move into the
            // headshunt may pass at danger but a move towards the running line may not.
            if (!isPoints(j)) continue;
            const legs = portsFrom(j, e.port)
              .map((p) => portUse(plan, j.id, p))
              .filter((u): u is { circuit: TrackCircuit; end: 0 | 1 } => !!u && u.circuit.id !== c.id)
              .map((u) => ({ circuitId: u.circuit.id, toward: (1 - u.end) as 0 | 1 }));
            const toMain = legs.filter((d) => reachesRunning(d));
            if (toMain.length && toMain.length < legs.length) put(box.id, 'shuntYellow', at, `Shunt from ${here}`);
          } else if (c.owner.kind !== 'line') {
            // On running track, towards points with no running signal: for setting back.
            put(box.id, 'shunt', at, `Shunt from ${here}`);
          }
        }
      }
    }
    // ---- shunt-ahead on section signals, with a limit of shunt on the line beyond
    if (opts.shuntAhead) {
      for (const sa of sectionAt) {
        const at = { circuitId: sa.circuitId, end: sa.end, back: 0 };
        const to = conn(sa.connId)?.neighbourName ?? 'the line';
        if (!has(at, 'shuntAhead') && signalsOf(layout).some((s) => postKey(s) === postKey(at) && s.kind === 'starter')) {
          // Only on a starter that leads straight on to the line.
          const next = nextSteps(state, layout, { circuitId: sa.circuitId, toward: sa.end }).find((n) => circuit(n.circuitId).owner.kind === 'line');
          if (!next) continue;
          put(box.id, 'shuntAhead', at, `Shunt-ahead to ${to}`);
          const lc = circuit(next.circuitId);
          const m = circuitLength(state, layout, lc).metres;
          const los = { circuitId: lc.id, end: next.toward, back: Math.round(Math.max(0, m - LOS_INTO_SECTION)) };
          if (!signalsOf(layout).some((s) => s.kind === 'limitOfShunt' && s.circuitId === lc.id && s.end === next.toward)) put(box.id, 'limitOfShunt', los, `Limit of shunt (line to ${to})`);
        }
      }
    }
  }
  numberLevers(state, layout);
  return { added, kept: kept.length };
}

/** Which arm of a home a route belongs to: each station road on its own, each siding place together, each line. */
function groupOf(layout: Layout, r: Pick<SignalRoute, 'steps' | 'to'> & { label?: string }): { key: string; label: string } {
  const last = r.steps[r.steps.length - 1];
  const c = findCircuit(layout.trackPlan, r.to.circuitId) ?? findCircuit(layout.trackPlan, last.circuitId);
  if (r.to.kind === 'exit') return { key: `exit:${r.to.circuitId}`, label: r.label ?? '' };
  for (const p of layout.places) {
    const road = p.roads.find((x) => x.circuitId === c?.id);
    if (!road) continue;
    return p.kind === 'station' ? { key: `road:${p.id}|${road.id}`, label: `to ${circuitPlaceName(layout, c!.id)}` } : { key: `place:${p.id}`, label: `to ${p.name}` };
  }
  return { key: `c:${c?.id ?? last.circuitId}`, label: r.label ?? '' };
}

// ---------------------------------------------------------------------------- lever numbers

const ORDER: Record<string, number> = { distant: 0, home: 1, starter: 2, shuntAhead: 3, shunt: 4, shuntYellow: 4, fpl: 5, points: 6 };

/**
 * Number each box's levers west to east (by where they stand on the plan): signals, then at the same
 * place facing point locks before their points. Points take their lever numbers as their numbers on the
 * plan. Limits of shunt have no lever.
 */
export function numberLevers(state: AppState, layout: Layout): void {
  const plan = layout.trackPlan;
  for (const box of boxesOn(state, layout.id)) {
    const items: Array<{ x: number; y: number; order: number; set: (n: string) => void }> = [];
    for (const s of signalsOf(layout)) {
      if (s.boxId !== box.id) continue;
      if (!SIGNAL_KINDS[s.kind].lever) {
        s.number = '';
        continue;
      }
      const p = signalPoint(state, layout, s, 0);
      items.push({ x: p?.x ?? 0, y: p?.y ?? 0, order: ORDER[s.kind] ?? 4, set: (n) => (s.number = n) });
    }
    for (const j of plan.junctions) {
      if (j.boxId !== box.id || j.connectionId || !isPoints(j)) continue;
      if (needsFpl(state, layout, j)) items.push({ x: j.x, y: j.y, order: ORDER.fpl, set: (n) => (j.fplNumber = n) });
      else delete j.fplNumber;
      items.push({ x: j.x, y: j.y, order: ORDER.points, set: (n) => (j.number = n) });
    }
    items.sort((a, b) => a.x - b.x || a.order - b.order || a.y - b.y);
    items.forEach((it, i) => it.set(String(i + 1)));
  }
}

// ---------------------------------------------------------------------------- checks

export interface SignalIssue {
  signalId?: string;
  junctionId?: string;
  text: string;
}

/** Things worth a look in a layout's signalling. */
export function signalIssues(state: AppState, layout: Layout): SignalIssue[] {
  const out: SignalIssue[] = [];
  const sigs = signalsOf(layout);
  for (const box of boxesOn(state, layout.id)) {
    const seen = new Map<string, string>();
    const note = (n: string, what: string, ids: Omit<SignalIssue, 'text'>) => {
      if (!n) return;
      if (seen.has(n)) out.push({ ...ids, text: `Lever ${n} is used twice in ${box.name}'s frame (${seen.get(n)} and ${what}).` });
      else seen.set(n, what);
    };
    for (const s of sigs) if (s.boxId === box.id) note(s.number, s.name, { signalId: s.id });
    for (const j of layout.trackPlan.junctions) {
      if (j.boxId !== box.id || j.connectionId || !isPoints(j)) continue;
      note(j.number, `points ${j.number}`, { junctionId: j.id });
      if (j.fplNumber) note(j.fplNumber, `the lock on points ${j.number}`, { junctionId: j.id });
    }
  }
  const posts = new Set<string>();
  for (const s of sigs) {
    if (!s.boxId) out.push({ signalId: s.id, text: `${s.name} is on track no signal box works.` });
    const cls = clsOf(s.kind);
    if (cls === 'main' || cls === 'shunt' || cls === 'shuntAhead') {
      const pr = postRoutes(state, layout, s);
      if (!pr.routes.length) out.push({ signalId: s.id, text: `${s.name} has no route beyond it.` });
      else if (!(pr.reads.get(s.id) ?? []).length) out.push({ signalId: s.id, text: `${s.name} reads to no route: the others at its place read them all.` });
      const pk = `${postKey(s)}|${cls}`;
      if (!posts.has(pk)) {
        posts.add(pk);
        for (const r of pr.unread) out.push({ signalId: s.id, text: `No signal at ${s.name}'s place reads the route ${r.label}.` });
      }
    }
    if (s.kind === 'shuntAhead' && !sigs.some((x) => x.kind === 'starter' && postKey(x) === postKey(s))) out.push({ signalId: s.id, text: `${s.name} is not on a starter's post.` });
  }
  return out;
}

