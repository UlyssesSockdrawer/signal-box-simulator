import { needsFpl, isPoints, postKey, routesFrom, signalRoutes, signalsOf, SIGNAL_KINDS } from './signals';
import { findCircuit, findJunction, JUNCTIONS } from './trackPlan';
import type { Passing, Step } from './routing';
import type { AppState, InterlockingOverrides, Junction, Layout, PlanSignal } from './types';

/*
 * THE INTERLOCKING (v0.3.31).
 *
 * Worked out from the signals placed on the plan and the routes they read, the way a signalling
 * engineer draws up a locking table:
 *  - LEVERS: every numbered signal, every set of points, and every facing point lock (FPL).
 *  - A signal may be pulled off for one of its ROUTES when the points on that route lie the right way
 *    (the through road is "normal", the turnout "reverse"; catch points must be closed, i.e.
 *    reversed, to pass) and are bolted by their FPL where the route meets them facing.
 *  - Two signals whose routes share a track circuit LOCK each other at danger (normal), unless one
 *    stands on the other's route facing the same way (one after the other: a home and the starter
 *    beyond it, a disc a train passes on its way).
 *  - A DISTANT is released only by the stop signals ahead of it for a clear run on to the line.
 *  - Points can only be moved with their FPL out (normal), and not while a signal off over them holds
 *    them; an FPL can't be taken out while a signal off needs it.
 * You can adjust it route by route (overrides on the plan): which way points must lie (or leave them
 * free), and add or remove a lock between two signals. The locking table is generated from that.
 */

export type Lie = 'normal' | 'reverse';
export type LeverKind = 'signal' | 'points' | 'fpl';

export interface Lever {
  /** 'sig:<signal id>', 'pts:<junction id>', 'fpl:<junction id>'. */
  key: string;
  number: string;
  kind: LeverKind;
  /** The signal or the junction. */
  id: string;
  name: string;
}

/** One way a signal can be cleared: for one of its routes (a distant: for a clear run). */
export interface Release {
  /** The route's key and label (for a distant: the signals' numbers). */
  key: string;
  group: string;
  label: string;
  points: Map<string, Lie>;
  /** Junctions whose FPL must be in (lever reversed). */
  fpls: Set<string>;
  /** Signals that must be off first (a distant's stop signals). */
  signals: Set<string>;
  /** The route's track, beyond the signal. */
  steps: Step[];
  /** The track a movement under it uses (the signal's own circuit, where it stands, and the route), for conflicts. */
  track: Array<{ circuitId: string; toward: 0 | 1 }>;
  /** Points lies changed from the generated ones by an override. */
  overridden: boolean;
}

export interface BoxInterlocking {
  boxId: string;
  levers: Lever[];
  /** Signal id → the ways it can be cleared (none: it can't be cleared). */
  releases: Map<string, Release[]>;
  /** Signal id → signals it locks at danger while it is off (both ways round). */
  locks: Map<string, Set<string>>;
  /** Locks that came from an override (added). */
  added: Set<string>;
}

export const lockKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The way a junction is set for a route through it. */
export function lieFor(j: Junction, via: Passing): Lie | null {
  if (!isPoints(j)) return null;
  if (j.kind === 'catchPoints') return 'reverse';
  const def = JUNCTIONS[j.kind];
  const same = (r: { a: string; b: string }, x: string, y: string) => (r.a === x && r.b === y) || (r.a === y && r.b === x);
  const used = def.routes.findIndex((r) => same(r, via.from, via.to));
  if (used < 0) return null;
  const through = def.through ? def.routes.findIndex((r) => same(r, def.entry, def.through!)) : 0;
  return used === (through < 0 ? 0 : through) ? 'normal' : 'reverse';
}

/** Does a route meet these points facing (from the toe, where the road divides)? */
function facing(j: Junction, via: Passing): boolean {
  const def = JUNCTIONS[j.kind];
  return def.routes.filter((r) => r.a === via.from || r.b === via.from).length > 1;
}

function overridesOf(layout: Layout): InterlockingOverrides {
  return layout.trackPlan.interlocking ?? {};
}

/** The way each set of points must lie for a route, as generated (before any override). */
export function generatedLies(layout: Layout, sg: PlanSignal, steps: Step[]): Map<string, Lie> {
  const out = new Map<string, Lie>();
  for (const st of steps) {
    if (!st.via) continue;
    const j = findJunction(layout.trackPlan, st.via.junctionId);
    if (!j || j.boxId !== sg.boxId) continue;
    const lie = lieFor(j, st.via);
    if (lie) out.set(j.id, lie);
  }
  return out;
}

/** The release for one route of a signal: its points and FPLs, with any override for it applied. */
function releaseFor(state: AppState, layout: Layout, sg: PlanSignal, key: string, group: string, label: string, steps: Step[]): Release {
  const plan = layout.trackPlan;
  const points = new Map<string, Lie>();
  const fpls = new Set<string>();
  for (const st of steps) {
    if (!st.via) continue;
    const j = findJunction(plan, st.via.junctionId);
    if (!j || j.boxId !== sg.boxId) continue;
    const lie = lieFor(j, st.via);
    if (!lie) continue;
    points.set(j.id, lie);
    if (facing(j, st.via) && needsFpl(state, layout, j)) fpls.add(j.id);
  }
  const ov = overridesOf(layout).routes?.[`${sg.id}|${key}`];
  let overridden = false;
  if (ov) {
    for (const [jid, v] of Object.entries(ov)) {
      if (!findJunction(plan, jid)) continue;
      overridden = true;
      if (v === 'free') {
        points.delete(jid);
        fpls.delete(jid);
      } else points.set(jid, v);
    }
  }
  const track = [{ circuitId: sg.circuitId, toward: sg.end }, ...steps.map((x) => ({ circuitId: x.circuitId, toward: x.toward }))];
  return { key, group, label, points, fpls, signals: new Set(), steps, track, overridden };
}

/** Does signal b stand on route r (of another signal), facing the same way? */
function standsOn(b: PlanSignal, r: Release): boolean {
  return r.track.some((s) => s.circuitId === b.circuitId && s.toward === b.end);
}

function compatible(a: Release, b: Release): boolean {
  for (const [j, lie] of a.points) if (b.points.has(j) && b.points.get(j) !== lie) return false;
  return true;
}

function shareTrack(a: Release, b: Release): boolean {
  const ids = new Set(a.track.map((s) => s.circuitId));
  return b.track.some((s) => ids.has(s.circuitId));
}

/** Distant: each clear run on to the line through the stop signals ahead (in this box). */
function distantRuns(state: AppState, layout: Layout, d: PlanSignal, releases: Map<string, Release[]>): Release[] {
  const sigs = signalsOf(layout).filter((s) => s.boxId === d.boxId);
  const out: Release[] = [];
  const first = routesFrom(state, layout, d, 'main');
  const chain = (post: string, through: PlanSignal[], depth: number) => {
    if (depth > 6 || out.length > 12) return;
    const arms = sigs.filter((s) => postKey(s) === post && SIGNAL_KINDS[s.kind].cls === 'main');
    for (const a of arms) {
      for (const r of releases.get(a.id) ?? []) {
        const run = [...through, a];
        const route = signalRoutes(state, layout, a).find((x) => x.key === r.key);
        if (!route) continue;
        if (route.to.kind === 'exit') {
          out.push({ key: run.map((x) => x.id).join('.'), group: '', label: run.map((x) => x.number).join('.'), points: new Map(), fpls: new Set(), signals: new Set(run.map((x) => x.id)), steps: [], track: [], overridden: false });
        } else if (route.to.kind === 'signal') chain(route.to.post, run, depth + 1);
      }
    }
  };
  for (const r of first) if (r.to.kind === 'signal') chain(r.to.post, [], 0);
  return out;
}

/** The interlocking of one box. */
export function boxInterlocking(state: AppState, layout: Layout, boxId: string): BoxInterlocking {
  const plan = layout.trackPlan;
  const sigs = signalsOf(layout).filter((s) => s.boxId === boxId);
  const levers: Lever[] = [];
  for (const s of sigs) if (SIGNAL_KINDS[s.kind].lever && s.number) levers.push({ key: `sig:${s.id}`, number: s.number, kind: 'signal', id: s.id, name: s.name });
  for (const j of plan.junctions) {
    if (j.boxId !== boxId || j.connectionId || !isPoints(j)) continue;
    const label = j.kind === 'catchPoints' ? 'Catch points' : 'Points';
    levers.push({ key: `pts:${j.id}`, number: j.number, kind: 'points', id: j.id, name: `${label} ${j.number}`.trim() });
    if (needsFpl(state, layout, j)) levers.push({ key: `fpl:${j.id}`, number: j.fplNumber ?? '', kind: 'fpl', id: j.id, name: `FPL on points ${j.number}`.trim() });
  }
  levers.sort((a, b) => (Number(a.number) || 9999) - (Number(b.number) || 9999) || a.key.localeCompare(b.key));

  // Routes of the stop and shunt signals.
  const releases = new Map<string, Release[]>();
  for (const s of sigs) {
    const cls = SIGNAL_KINDS[s.kind].cls;
    if (cls === 'distant' || cls === 'los') continue;
    releases.set(
      s.id,
      signalRoutes(state, layout, s).map((r) => releaseFor(state, layout, s, r.key, r.group, r.label, r.steps)),
    );
  }
  for (const s of sigs) if (s.kind === 'distant') releases.set(s.id, distantRuns(state, layout, s, releases));

  // Conflicts.
  const ov = overridesOf(layout);
  const removed = new Set((ov.removedLocks ?? []).map(([a, b]) => lockKey(a, b)));
  const added = new Set((ov.extraLocks ?? []).map(([a, b]) => lockKey(a, b)));
  const locks = new Map<string, Set<string>>();
  const lock = (a: string, b: string) => {
    if (!locks.has(a)) locks.set(a, new Set());
    if (!locks.has(b)) locks.set(b, new Set());
    locks.get(a)!.add(b);
    locks.get(b)!.add(a);
  };
  const stop = sigs.filter((s) => releases.has(s.id) && s.kind !== 'distant');
  for (let i = 0; i < stop.length; i++) {
    for (let k = i + 1; k < stop.length; k++) {
      const a = stop[i];
      const b = stop[k];
      if (removed.has(lockKey(a.id, b.id))) continue;
      const ra = releases.get(a.id)!;
      const rb = releases.get(b.id)!;
      const clash = ra.some((x) => rb.some((y) => compatible(x, y) && shareTrack(x, y) && !standsOn(b, x) && !standsOn(a, y)));
      if (clash) lock(a.id, b.id);
    }
  }
  for (const k of added) {
    const [a, b] = k.split('|');
    if (sigs.some((s) => s.id === a) && sigs.some((s) => s.id === b)) lock(a, b);
  }
  return { boxId, levers, releases, locks, added };
}

// ---------------------------------------------------------------------------- the locking table

export interface TableRow {
  lever: Lever;
  /** Levers that must be pulled first ("released by"): numbers, with alternatives as "(5 or 6)". */
  releasedBy: string[];
  /** Levers it locks at danger / normal. */
  locks: string[];
  /** Points it holds whichever way they lie (its routes need them different ways). */
  bothWays: string[];
  note: string;
}

/** The classic locking table, lever by lever. */
export function lockingTable(state: AppState, layout: Layout, il: BoxInterlocking): TableRow[] {
  const num = (key: string) => il.levers.find((l) => l.key === key)?.number || '?';
  const sigNum = (id: string) => num(`sig:${id}`);
  const rows: TableRow[] = [];
  for (const lever of il.levers) {
    const row: TableRow = { lever, releasedBy: [], locks: [], bothWays: [], note: '' };
    if (lever.kind === 'signal') {
      const rel = il.releases.get(lever.id) ?? [];
      if (!rel.length) row.note = 'No route: it cannot be cleared.';
      // Points and FPLs every route needs reversed; the rest as alternatives.
      const all = <T,>(f: (r: Release) => T[]) => (rel.length ? f(rel[0]).filter((x) => rel.every((r) => f(r).includes(x))) : []);
      const pullAll = all((r) => [...[...r.points].filter(([, l]) => l === 'reverse').map(([j]) => `pts:${j}`), ...[...r.fpls].map((j) => `fpl:${j}`), ...[...r.signals].map((s) => `sig:${s}`)]);
      row.releasedBy.push(...pullAll.map(num).sort((a, b) => (Number(a) || 9999) - (Number(b) || 9999)));
      const alts = rel.map((r) => [...[...r.points].filter(([, l]) => l === 'reverse').map(([j]) => `pts:${j}`), ...[...r.fpls].map((j) => `fpl:${j}`), ...[...r.signals].map((s) => `sig:${s}`)].filter((k) => !pullAll.includes(k)));
      if (alts.some((a) => a.length)) row.releasedBy.push(`(${alts.map((a) => (a.length ? a.map(num).join('.') : '–')).join(' or ')})`);
      // Points it holds normal on every route; points held either way.
      const lies = new Map<string, Set<Lie>>();
      for (const r of rel) for (const [j, l] of r.points) (lies.get(j) ?? lies.set(j, new Set()).get(j)!).add(l);
      for (const [j, set] of lies) {
        if (set.size > 1 || (rel.some((r) => !r.points.has(j)) && set.size)) row.bothWays.push(num(`pts:${j}`));
        else if (set.has('normal')) row.locks.push(num(`pts:${j}`));
      }
      for (const o of il.locks.get(lever.id) ?? []) row.locks.push(sigNum(o));
    } else if (lever.kind === 'fpl') {
      row.bothWays.push(num(`pts:${lever.id}`));
      row.note = 'Bolts the points: pull it after setting them, before the signal.';
    } else {
      const fpl = il.levers.find((l) => l.kind === 'fpl' && l.id === lever.id);
      if (fpl) row.note = `Only moves with ${fpl.number || 'its FPL'} normal.`;
    }
    const byNum = (a: string, b: string) => (Number(a) || 9999) - (Number(b) || 9999);
    row.locks = [...new Set(row.locks)].sort(byNum);
    row.bothWays = [...new Set(row.bothWays)].sort(byNum);
    rows.push(row);
  }
  return rows;
}

/** Every box on the layout that has signals. */
export function layoutInterlockings(state: AppState, layout: Layout): BoxInterlocking[] {
  const boxes = [...new Set(signalsOf(layout).map((s) => s.boxId).filter(Boolean))];
  return boxes.map((b) => boxInterlocking(state, layout, b));
}

/** Drop overrides that point at signals or junctions no longer on the plan. */
export function pruneInterlocking(layout: Layout): void {
  const ov = layout.trackPlan.interlocking;
  if (!ov) return;
  const sigs = new Set(signalsOf(layout).map((s) => s.id));
  const js = new Set(layout.trackPlan.junctions.map((j) => j.id));
  if (ov.routes) {
    for (const k of Object.keys(ov.routes)) {
      if (!sigs.has(k.split('|')[0])) delete ov.routes[k];
      else for (const j of Object.keys(ov.routes[k])) if (!js.has(j)) delete ov.routes[k][j];
    }
  }
  const keep = (p: [string, string]) => sigs.has(p[0]) && sigs.has(p[1]);
  if (ov.extraLocks) ov.extraLocks = ov.extraLocks.filter(keep);
  if (ov.removedLocks) ov.removedLocks = ov.removedLocks.filter(keep);
  if (ov.routes && !Object.keys(ov.routes).length) delete ov.routes;
  if (!ov.extraLocks?.length) delete ov.extraLocks;
  if (!ov.removedLocks?.length) delete ov.removedLocks;
  if (!Object.keys(ov.routes ?? {}).length && !ov.extraLocks?.length && !ov.removedLocks?.length) delete layout.trackPlan.interlocking;
}

/** The circuit a release's route starts on (for messages). */
export function routeStart(layout: Layout, r: Release): string {
  const c = r.steps[0] ? findCircuit(layout.trackPlan, r.steps[0].circuitId) : undefined;
  return c?.code ?? '';
}

// ---------------------------------------------------------------------------- the frame

export type LeverState = 'N' | 'R';

/**
 * A box's levers and their states, moved only as the locking allows. The automatic signaller (and,
 * later, you at the lever frame) works the railway through it: points lie as their levers do.
 */
export class Frame {
  private states = new Map<string, LeverState>();
  /** Lever movements, oldest first (the last 200): for the box's log and for tests. */
  readonly log: Array<{ key: string; to: LeverState }> = [];
  /** The release each signal now off was pulled for. */
  private active = new Map<string, Release>();

  constructor(public il: BoxInterlocking) {}

  /** Keep lever states when the interlocking is worked out again (plan changed). */
  update(il: BoxInterlocking): void {
    this.il = il;
    for (const k of [...this.states.keys()]) if (!il.levers.some((l) => l.key === k)) this.states.delete(k);
    for (const id of [...this.active.keys()]) {
      const r = il.releases.get(id)?.find((x) => x.key === this.active.get(id)!.key);
      if (r) this.active.set(id, r);
      else this.active.delete(id);
    }
  }

  has(key: string): boolean {
    return this.il.levers.some((l) => l.key === key);
  }
  state(key: string): LeverState {
    return this.states.get(key) ?? 'N';
  }
  reversed(key: string): boolean {
    return this.state(key) === 'R';
  }
  /** Signals now off. */
  offSignals(): string[] {
    return this.il.levers.filter((l) => l.kind === 'signal' && this.reversed(l.key)).map((l) => l.id);
  }
  pointsLie(junctionId: string): Lie {
    return this.reversed(`pts:${junctionId}`) ? 'reverse' : 'normal';
  }
  /** Points with no FPL lever count as bolted. */
  fplIn(junctionId: string): boolean {
    return !this.has(`fpl:${junctionId}`) || this.reversed(`fpl:${junctionId}`);
  }

  private num(key: string): string {
    return this.il.levers.find((l) => l.key === key)?.number || '?';
  }

  /** Whether this release's conditions are met now; '' if so, else why not. */
  private unmet(signalId: string, r: Release): string {
    for (const [j, lie] of r.points) if (this.has(`pts:${j}`) && this.pointsLie(j) !== lie) return `points ${this.num(`pts:${j}`)} must be ${lie}`;
    for (const j of r.fpls) if (!this.fplIn(j)) return `FPL ${this.num(`fpl:${j}`)} must be in`;
    for (const s of r.signals) if (!this.reversed(`sig:${s}`)) return `${this.num(`sig:${s}`)} must be off first`;
    for (const o of this.il.locks.get(signalId) ?? []) if (this.reversed(`sig:${o}`)) return `locked by ${this.num(`sig:${o}`)}`;
    return '';
  }

  /** Why a lever can't be moved to `to` now ('' if it can). For a signal, `release` picks the route. */
  why(key: string, to: LeverState, release?: Release): string {
    const lever = this.il.levers.find((l) => l.key === key);
    if (!lever) return 'no such lever';
    if (this.state(key) === to) return '';
    const holders = (pred: (r: Release) => boolean) =>
      [...this.active].filter(([id, r]) => this.reversed(`sig:${id}`) && pred(r)).map(([id]) => this.num(`sig:${id}`));
    if (lever.kind === 'signal') {
      if (to === 'N') {
        const h = holders((r) => r.signals.has(lever.id));
        return h.length ? `held off by ${h.join(', ')}` : '';
      }
      const rel = release ? [release] : (this.il.releases.get(lever.id) ?? []);
      if (!rel.length) return 'it has no route';
      const reasons = rel.map((r) => this.unmet(lever.id, r));
      return reasons.includes('') ? '' : reasons[0];
    }
    if (lever.kind === 'points') {
      if (this.has(`fpl:${lever.id}`) && this.reversed(`fpl:${lever.id}`)) return `FPL ${this.num(`fpl:${lever.id}`)} is in`;
      const h = holders((r) => r.points.has(lever.id));
      return h.length ? `held by ${h.join(', ')}` : '';
    }
    if (to === 'N') {
      const h = holders((r) => r.fpls.has(lever.id));
      return h.length ? `held by ${h.join(', ')}` : '';
    }
    return '';
  }

  /** Move a lever if the locking allows; returns why not ('' when moved). */
  move(key: string, to: LeverState, release?: Release): string {
    const w = this.why(key, to, release);
    if (w) return w;
    this.states.set(key, to);
    this.log.push({ key, to });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    const lever = this.il.levers.find((l) => l.key === key)!;
    if (lever.kind === 'signal') {
      if (to === 'N') this.active.delete(lever.id);
      else this.active.set(lever.id, release ?? (this.il.releases.get(lever.id) ?? []).find((r) => !this.unmet(lever.id, r))!);
    }
    return '';
  }

  /**
   * The automatic signaller: set the route (FPLs out, points over, FPLs in) and pull the signal off.
   * `pick` chooses among the signal's routes (the one the train is to take). Returns '' when it is off.
   */
  setRoute(signalId: string, pick: (r: Release) => boolean = () => true): string {
    const key = `sig:${signalId}`;
    if (!this.has(key)) return '';
    if (this.reversed(key)) return '';
    const rel = (this.il.releases.get(signalId) ?? []).filter(pick);
    if (!rel.length) return 'no route for this movement';
    let reason = '';
    for (const r of rel) {
      // Only try if no conflicting signal is off and no needed points are held the other way.
      const blocked = [...(this.il.locks.get(signalId) ?? [])].find((o) => this.reversed(`sig:${o}`));
      if (blocked) {
        reason = `locked by ${this.num(`sig:${blocked}`)}`;
        continue;
      }
      let ok = true;
      for (const [j, lie] of r.points) {
        if (!this.has(`pts:${j}`) || this.pointsLie(j) === lie) continue;
        if (this.has(`fpl:${j}`) && this.reversed(`fpl:${j}`) && this.move(`fpl:${j}`, 'N')) {
          ok = false;
          reason = `FPL ${this.num(`fpl:${j}`)} is held`;
          break;
        }
        const w = this.move(`pts:${j}`, lie === 'reverse' ? 'R' : 'N');
        if (w) {
          ok = false;
          reason = `points ${this.num(`pts:${j}`)}: ${w}`;
          break;
        }
      }
      if (!ok) continue;
      for (const j of r.fpls) if (this.has(`fpl:${j}`)) this.move(`fpl:${j}`, 'R');
      const w = this.move(key, 'R', r);
      if (!w) return '';
      reason = w;
    }
    return reason;
  }

  /** Put a signal back to danger (and a distant that needs it first). */
  replace(signalId: string): void {
    for (const [id, r] of [...this.active]) if (r.signals.has(signalId)) this.move(`sig:${id}`, 'N');
    this.move(`sig:${signalId}`, 'N');
  }

  /** Points and FPLs no signal off needs go back to normal (the signaller tidies the frame). */
  normalise(keep: (junctionId: string) => boolean = () => false): void {
    for (const l of this.il.levers) {
      if (l.kind === 'signal' || keep(l.id) || !this.reversed(l.key)) continue;
      if (l.kind === 'fpl') this.move(l.key, 'N');
    }
    for (const l of this.il.levers) {
      if (l.kind !== 'points' || keep(l.id) || !this.reversed(l.key)) continue;
      this.move(l.key, 'N');
    }
  }
}
