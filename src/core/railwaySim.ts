import { newId } from './store';
import { MARKED, type OccupancyBoard } from './occupancy';
import { arrivalChoices } from './places';
import { DEFAULT_DIVERGING_SPEED, circuitLength, layoutClearingPoint, circuitLineSpeed, consistVehicles, locoMaxSpeed, trainLength, vehiclesText, workingVehicles } from './railway';
import { boxSignals, findPath, leavesScene, lineCircuits, lineEntries, nextSteps, type Dir, type Passing, type SignalDef, type Step } from './routing';
import { Emitter, type Scheduler } from './scheduler';
import type { SectionSession } from './session';
import type { ThroughWorkings } from './throughTrains';
import { findCircuit, findJunction, straightOn } from './trackPlan';
import { clearingPointCircuits, lineOf } from './stationLimits';
import type { ScoreRuleId } from './score';
import { boxInterlocking, Frame, type Release } from './interlocking';
import { postKey, signalsOf, SIGNAL_KINDS } from './signals';
import type { TrainEventSource } from './trainEvents';
import type { AppState, Layout, Loco, PlaceRef, PlanSignal, StockRake } from './types';

/*
 * THE SIMULATED RAILWAY (signaller play mode, v0.3.28).
 *
 * One per layout. Signal boxes being worked in play mode attach to it. It runs virtual trains
 * through the layout's track plan, one track circuit after another, at the speed set in Settings
 * (never above line speed or the loco's maximum; shunts at most 15 mph), using the circuit lengths
 * worked out in core/railway.ts. It is the railway's "detector": every circuit a train or a rake of
 * stock occupies or clears is reported through an attached box's source of train events
 * (enteredCircuit / clearedCircuit), which the router puts on the layout's occupancy board. When a
 * train reaches the far end of a line, the railway reports it arrived there (arrivedFar).
 *
 * Signals and points have no levers yet. An AUTOMATIC SIGNALLER clears them when a real signaller
 * would (absolute block practice):
 *  - SECTION (starting) signal: only once Line Clear has been obtained from the box in advance (in
 *    token working: once the token has been withdrawn), with the route to it set and locked;
 *  - HOME signal: with the route set and locked to where the train is to stop, once the train is
 *    close to it (in the last circuit of the section, so it can be brought to a stand under
 *    control), or as soon as it is on the line when it has a clear run through (the box in advance
 *    has given Line Clear for it);
 *  - each signal goes back to danger as the train passes it, and a route's circuits and points are
 *    freed as the train's tail clears them.
 * The lever frame (a later stage) will replace the automatic signaller; the rules stay.
 *
 * SIGNALS PLACED ON THE PLAN (v0.3.31): when a box's layout has signals of its own, trains obey them.
 * A train stops at the first signal at danger facing it on its path (running trains the stop signals,
 * shunts the shunt signals, else whatever stands there; distants are passed at caution). Once a running
 * train has met a stop signal, the shunt signals on the route it gives are not for it (v0.3.34): they
 * stay on. A train starting from a siding with no stop signal behind it obeys the discs out. Once the
 * rules above have set a route (the path runs on past a signal), the automatic signaller sets the
 * points and FPLs and pulls the signal off through the box's lever FRAME, which allows it only as the
 * interlocking does (core/interlocking.ts); a distant comes off once every stop signal it needs is
 * off. Each goes back to danger as the head passes it, and points no route needs go back to normal.
 * A post none of whose arms reads a route for the movement does not apply to it.
 *
 * STATION LIMITS (v0.3.32, core/stationLimits.ts): shunting (a shunt move, or a train on a leg before
 * it sets back, or where it stood to set back) over a line's clearing point waits until the line is
 * blocked back (2-4); any movement out on to a line other than a train's own run waits for 3-3-2 (or
 * a token, or 3-3 when it goes out past the home signal from behind). A train sets back only where it
 * fits clear of the points behind it, drawing forward beyond a short road first (into the section
 * as far as the limit of shunt, or the clearing point, if need be). The railway scores a movement on
 * the line after its permission was given back, and Line Clear given with the clearing point obstructed.
 *
 * ROUTES are worked out when the train is given its orders (accepted, sent away, or shunted) and
 * again every moment until they are locked: a train goes round a road that has become occupied, to
 * the road the timetable or the signaller chose, else the first suitable free road. With no clear
 * road the train waits at the home signal.
 *
 * Trains move with no braking curves yet (they stop at the end of the circuit they may run to).
 * A train standing in a road is taken to be drawn up to the end it next leaves by.
 *
 * ROLLING STOCK: a train's vehicles come from its working's consist. A loco that sets off as a light
 * engine (or engine and brake van) from a road leaves its other vehicles there as a rake of stock
 * (saved on the layout), which keeps the circuit occupied; a loco setting off as a train from a road
 * where a rake stands takes the rake with it.
 */

const PASSENGER = new Set(['express_passenger', 'ordinary_passenger', 'branch_passenger', 'railcar', 'parcels', 'ecs']);
const GOODS = new Set(['freight_fitted_half', 'freight_fitted_third', 'freight_fitted_four', 'freight_unfitted', 'through_freight', 'mineral', 'pickup_goods', 'branch_freight']);
/** Real time between moves of the trains (ms). */
const TICK_MS = 250;
/** A driver's reaction when the signal clears, in simulated ms. */
const DRIVER_MS = 3000;
/** How far clear of the points a train setting back draws up beyond them (metres). */
const CLEAR_OF_POINTS = 10;

export interface SimBox {
  boxId: string;
  sessions: SectionSession[];
  workings: ThroughWorkings;
  source: TrainEventSource;
}

export interface RailwaySimOptions {
  getState: () => AppState;
  scheduler: Scheduler;
  layoutId: string;
  board: OccupancyBoard;
  /** Change saved data (rakes left standing, a loco's consist when it leaves or takes a rake). */
  update: (fn: (s: AppState) => void) => void;
  /** What the timetable wants: the road an arriving train is to go to, the road at the far end of a line. */
  hints?: {
    arrival?: (boxId: string, connId: string, locoId: string) => PlaceRef | null;
    farRoad?: (boxId: string, connId: string, locoId: string) => string;
  };
  tickMs?: number;
}

/** Where a train is going. */
type Dest =
  | { kind: 'road'; placeId: string; roadId: string; circuitId: string }
  /** On along a line (through train, or outgoing): to its section signal, then out over the line. */
  | { kind: 'line'; boxId: string; connId: string }
  /** Stand at the box (a box that works no place). */
  | { kind: 'circuit'; circuitId: string };

type Purpose =
  | { kind: 'incoming'; boxId: string; connId: string }
  | { kind: 'outgoing'; boxId: string; connId: string }
  | { kind: 'shunt'; boxId: string; to: PlaceRef; onDone: (ok: boolean) => void };

interface Part {
  /** null: off the plan (beyond an exit, or the part of a long train that does not fit its road). */
  circuitId: string | null;
  toward: 0 | 1;
  metres: number;
  start: number;
  via: Passing | null;
  /** A signal at the end of this part (for trains running this way). */
  signalId?: string;
  /**
   * Part of a circuit only (v0.3.32): the part starts `offset` metres in from the end it is entered by,
   * in a circuit `full` metres long (a train drawn forward into a section, then setting back).
   */
  offset?: number;
  full?: number;
  /** Where the train stood when it set back (it is shunting here, whatever its leg is for). */
  setBack?: boolean;
  /** Where the train stood when it set off (it needs no permission to be there). */
  origin?: boolean;
}

/** Permission a movement needs from the box at the far end of a line, and why (v0.3.32). */
interface Need {
  boxId: string;
  connId: string;
  /** rear: blocking back (2-4 inside the home signal, 3-3 outside it); forward: into the section ahead (3-3-2, or a token). */
  kind: 'inside' | 'outside' | 'forward';
  pos: number;
  circuitId: string;
}

interface SimTrain {
  id: string;
  locoId: string;
  purpose: Purpose;
  parts: Part[];
  head: number;
  length: number;
  /** May not move before this (scheduler time): a driver reacting to a signal clearing. */
  readyAt: number;
  dest: Dest | null;
  /** The route to its destination is set and locked (the home signal is off, or it has been sent on). */
  locked: boolean;
  /** It runs off the plan at the end of its path (leaving over an exit). */
  leaving: boolean;
  /** Stopped where it was going (end of its path, which is its destination). */
  arrived: boolean;
  /** Has been reported arrived at the far end of its line. */
  reported: boolean;
  circuitsLocked: Set<string>;
  junctionsLocked: Set<string>;
  status: string;
  /** The line it came in on (incoming): the circuits its tail must clear before it has arrived complete. */
  fromLine: Set<string>;
  /** Legs still to run after reversing (each starts with the circuit it sets back along). */
  pending: PathStep[][];
  /** Stopped to set back: when the driver will have changed ends (scheduler time). */
  changeEndsAt: number | null;
  /** Waiting for permission to use a line (what to ring), or ''. */
  permWait: string;
  /** Lines on which it has already been found out on the line without permission (scored once each). */
  penalised: Set<string>;
}

/** A step of a path to be run: a circuit (or null: off the plan), maybe with a signal at its end. */
type PathStep = { circuitId: string | null; toward: 0 | 1; metres: number; via: Passing | null; reverse?: boolean; signalId?: string; offset?: number; full?: number };

export interface SimIncomingView {
  locoId: string;
  /** Where the train's head is: circuit code, or '' off the plan. */
  where: string;
  /** The road it is to go to (the app's or your choice), or null (on through / no road clear). */
  dest: PlaceRef | null;
  destText: string;
  /** The road you chose (null = the app chooses). */
  chosen: PlaceRef | null;
  /** The route is set and the home signal is off: the road can no longer be changed. */
  locked: boolean;
  /** Track circuits show it arrived complete (stopped, clear of the section): it may be reported arrived. */
  arrivedDetected: boolean;
  /** Track circuits show a through train has passed complete. */
  passedDetected: boolean;
  /** Where it arrived (the road), for the arrival report. */
  at: PlaceRef | null;
  status: string;
}

export interface SimEvents extends Record<string, unknown> {
  change: void;
}

export class RailwaySim {
  readonly events = new Emitter<SimEvents>();
  private boxes: SimBox[] = [];
  private trains: SimTrain[] = [];
  private signalState = new Map<string, 'clear' | 'danger'>();
  private lie = new Map<string, Passing>();
  private choice = new Map<string, PlaceRef | null>();
  /** Occupancy last reported (circuit → occupants). */
  private reportedOcc = new Map<string, Set<string>>();
  private timer: number | null = null;
  private ticking = false;
  private lastTick = 0;
  private outgoingStatus = new Map<string, string>();
  /** Each box's lever frame, when its layout has signals placed on the plan (v0.3.31). */
  private frames = new Map<string, { key: string; frame: Frame }>();
  /** Circuits within each line's clearing point (box|line), for the plan as it was when worked out. */
  private cpCache = new Map<string, { plan: unknown; cp: number; set: Set<string> }>();
  /** Each line's instrument as last seen (to catch Line Clear given with the clearing point obstructed). */
  private lastInstrument = new Map<string, string>();

  constructor(private o: RailwaySimOptions) {}

  private get state(): AppState {
    return this.o.getState();
  }
  private get layout(): Layout | undefined {
    return this.state.layouts.find((l) => l.id === this.o.layoutId);
  }
  private get now(): number {
    return this.o.scheduler.now();
  }

  // ------------------------------------------------------------------------------ boxes

  /** A box in play mode joins the railway. Returns a function that detaches it. */
  attach(box: SimBox): () => void {
    this.boxes.push(box);
    this.start();
    this.tick();
    return () => {
      this.boxes = this.boxes.filter((b) => b !== box);
      this.trains = this.trains.filter((t) => this.boxes.some((b) => b.boxId === t.purpose.boxId));
      if (!this.boxes.length) this.stop();
      this.emit();
    };
  }

  get running(): boolean {
    return this.boxes.length > 0;
  }

  private start(): void {
    if (this.timer !== null) return;
    this.lastTick = this.now;
    const loop = () => {
      this.timer = this.o.scheduler.setTimeout(loop, this.o.tickMs ?? TICK_MS);
      this.tick();
    };
    this.timer = this.o.scheduler.setTimeout(loop, this.o.tickMs ?? TICK_MS);
  }

  /** Stop the railway: trains vanish and everything they occupied is reported clear. */
  stop(): void {
    if (this.timer !== null) this.o.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.trains = [];
    this.signalState.clear();
    this.lie.clear();
    this.frames.clear();
    this.o.board.forget((id) => id !== MARKED);
    this.reportedOcc.clear();
  }

  dispose(): void {
    this.boxes = [];
    this.stop();
  }

  private box(boxId: string): SimBox | undefined {
    return this.boxes.find((b) => b.boxId === boxId);
  }
  private session(boxId: string, connId: string): SectionSession | undefined {
    return this.box(boxId)?.sessions.find((s) => s.connection.id === connId);
  }

  // ------------------------------------------------------------------------------ the clock

  /** Move the railway on. Called every tick (and by tests). */
  tick(): void {
    if (this.ticking) return;
    const layout = this.layout;
    if (!layout || !this.boxes.length) return;
    this.ticking = true;
    try {
      const now = this.now;
      const secs = (Math.max(0, now - this.lastTick) / 1000) * Math.max(1, Math.min(10, this.state.settings.timeScale || 1));
      this.lastTick = now;
      this.dropFinished(layout);
      this.spawnIncoming(layout);
      this.startOutgoing(layout);
      this.signaller(layout);
      this.placedSignaller(layout);
      for (const t of [...this.trains]) this.move(layout, t, secs);
      this.watchPermissions(layout);
      this.tidyFrames(layout);
      this.reportOccupancy(layout);
      this.reportArrivals(layout);
    } finally {
      this.ticking = false;
    }
    this.emit();
  }

  private emit(): void {
    this.events.emit('change', undefined);
  }

  // ------------------------------------------------------------------------------ trains

  private loco(id: string): Loco | undefined {
    return this.state.roster.find((l) => l.id === id);
  }

  private trainOf(locoId: string): SimTrain | undefined {
    return this.trains.find((t) => t.locoId === locoId);
  }

  /** The circuit a loco stands on (a road of a place tied to a circuit on this layout), or null. */
  private standingCircuit(layout: Layout, l: Loco): string | null {
    const loc = l.location;
    if (loc.kind !== 'place') return null;
    const p = layout.places.find((x) => x.id === loc.placeId);
    const c = p?.roads.find((r) => r.id === loc.roadId)?.circuitId;
    return c && findCircuit(layout.trackPlan, c) ? c : null;
  }

  private partsTotal(t: SimTrain): number {
    const last = t.parts[t.parts.length - 1];
    return last ? last.start + last.metres : 0;
  }

  /**
   * Add steps to a train's path. A reversal starts a new leg, kept until the train has stopped at the
   * end of the leg before (then it sets back: see nextLeg). `signalAtEnd` marks a signal at the end of the last step.
   */
  private append(t: SimTrain, steps: PathStep[], signalAtEnd?: string): void {
    for (const s of steps) {
      if (s.reverse) t.pending.push([{ ...s }]);
      else if (t.pending.length) t.pending[t.pending.length - 1].push({ ...s });
      else {
        t.parts.push({ circuitId: s.circuitId, toward: s.toward, metres: s.metres, start: this.partsTotal(t), via: s.via, signalId: s.signalId, offset: s.offset, full: s.full });
      }
    }
    if (!signalAtEnd) return;
    const leg = t.pending[t.pending.length - 1];
    if (leg) leg[leg.length - 1].signalId = signalAtEnd;
    else if (t.parts.length) t.parts[t.parts.length - 1].signalId = signalAtEnd;
  }

  /** The end of the train's path: where the last leg (after any reversals) ends. */
  private finalStep(t: SimTrain): PathStep | Part | undefined {
    const leg = t.pending[t.pending.length - 1];
    return leg ? leg[leg.length - 1] : t.parts[t.parts.length - 1];
  }

  /**
   * Stopped at the end of a leg: set back along the next one. The train stays where it stands: its new
   * head is where its tail was (the leg starts in the circuit the old head is in, the other way).
   */
  private nextLeg(layout: Layout, t: SimTrain): void {
    const leg = t.pending.shift()!;
    const first = leg[0];
    const hp = this.headPart(t);
    const full = this.lengthOf(layout, first.circuitId!);
    // How far the old head stood from the end it entered by: that is how far there is to run back to it.
    const inFrom = hp && hp.circuitId === first.circuitId ? Math.min(full, (hp.offset ?? 0) + (t.head - hp.start)) : full;
    const body = new Set(this.footprint(t));
    t.parts = [];
    t.parts.push({ circuitId: first.circuitId, toward: first.toward, metres: inFrom, start: this.partsTotal(t), via: null, signalId: first.signalId, offset: full - inFrom > 0.01 ? full - inFrom : undefined, full: full - inFrom > 0.01 ? full : undefined });
    for (const s of leg.slice(1)) {
      t.parts.push({ circuitId: s.circuitId, toward: s.toward, metres: s.metres, start: this.partsTotal(t), via: s.via, signalId: s.signalId, offset: s.offset, full: s.full });
      if (s.via) this.lie.set(s.via.junctionId, s.via);
    }
    t.head = Math.min(this.partsTotal(t), t.length);
    // Where it stood to set back: shunting there until clear of it.
    for (const p of t.parts) {
      if (!p.circuitId || !body.has(p.circuitId)) break;
      p.setBack = true;
    }
    t.readyAt = this.now + DRIVER_MS / this.scale();
  }

  /**
   * Room for a train to draw forward beyond a circuit's end before setting back, clear of the points
   * behind it: on along the straight road, over box track and at most a little way into the section
   * ahead (to the limit of shunt, or the clearing point), `need` metres. The steps (the last maybe part
   * of a circuit), or null when there is not room.
   */
  private drawForward(layout: Layout, t: SimTrain, from: Dir, need: number, blocked: (c: string) => boolean): Step[] | null {
    const out: Step[] = [];
    let cur: Dir = from;
    let left = need;
    while (left > 0.01) {
      const ahead = nextSteps(this.state, layout, cur, { anyWay: t.purpose.kind === 'shunt' });
      let n = ahead[0];
      if (ahead.length > 1) {
        const j = ahead[0].via ? findJunction(layout.trackPlan, ahead[0].via.junctionId) : undefined;
        const straight = j && ahead[0].via ? straightOn(j, ahead[0].via.from) : null;
        n = ahead.find((x) => x.via?.to === straight) ?? ahead[0];
      }
      if (!n || blocked(n.circuitId) || (n.via && !this.junctionFree(t, n.via.junctionId))) return null;
      const c = findCircuit(layout.trackPlan, n.circuitId)!;
      if (c.owner.kind === 'line') {
        // Into the section ahead: no further than the limit of shunt (else the clearing point), and only one circuit.
        if (c.owner.boxId !== t.purpose.boxId || out.some((x) => findCircuit(layout.trackPlan, x.circuitId)?.owner.kind === 'line')) return null;
        const los = signalsOf(layout).find((x) => x.kind === 'limitOfShunt' && x.circuitId === c.id && x.end === n.toward);
        const max = los ? Math.max(0, n.metres - los.back) : Math.min(n.metres, layoutClearingPoint(layout));
        if (max < left) return null;
        out.push({ ...n, metres: left, full: n.metres } as Step);
        return out;
      }
      if (n.metres >= left) {
        out.push(n.metres - left > 0.01 ? ({ ...n, metres: left, full: n.metres } as Step) : n);
        return out;
      }
      out.push(n);
      left -= n.metres;
      cur = n;
    }
    return out;
  }

  /** Can a train set back in this circuit (having run into it towards `toward`): box track, with room to draw up clear of the points? */
  private reverseRoom(layout: Layout, t: SimTrain, circuitId: string, toward: 0 | 1, blocked: (c: string) => boolean): boolean {
    if (!this.mayReverse(layout, circuitId)) return false;
    const need = t.length + CLEAR_OF_POINTS - this.lengthOf(layout, circuitId);
    return need <= 0 || !!this.drawForward(layout, t, { circuitId, toward }, need, blocked);
  }

  /**
   * Where a path sets back in a circuit too short for the train, it draws forward beyond it first (see
   * drawForward), and sets back from there. Returns the path with those steps put in.
   */
  private fitReversals(layout: Layout, t: SimTrain, steps: Step[], blocked: (c: string) => boolean): PathStep[] {
    const out: PathStep[] = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.reverse || i === 0) {
        out.push(s);
        continue;
      }
      const prev = steps[i - 1];
      const need = t.length + CLEAR_OF_POINTS - this.lengthOf(layout, prev.circuitId);
      const ext = need > 0 ? this.drawForward(layout, t, { circuitId: prev.circuitId, toward: prev.toward }, need, blocked) : null;
      if (!ext?.length) {
        out.push(s);
        continue;
      }
      out.push(...ext);
      // Back the same way: the last (maybe partial) circuit first, from where the train stands.
      const back: PathStep[] = [];
      for (let k = ext.length - 1; k >= 0; k--) {
        const e = ext[k] as PathStep;
        const full = e.full ?? e.metres;
        const via = k < ext.length - 1 ? ext[k + 1].via : null;
        back.push({ circuitId: e.circuitId, toward: (1 - e.toward) as 0 | 1, metres: e.metres, via: via ? { junctionId: via.junctionId, from: via.to, to: via.from } : null, reverse: k === ext.length - 1, offset: full - e.metres > 0.01 ? full - e.metres : undefined, full: full - e.metres > 0.01 ? full : undefined });
      }
      const v = ext[0].via;
      back.push({ ...s, reverse: false, via: v ? { junctionId: v.junctionId, from: v.to, to: v.from } : null });
      out.push(...back);
    }
    return out;
  }

  /** A new train standing in a circuit, about to run towards `toward`: drawn up to that end. */
  private standingTrain(layout: Layout, l: Loco, circuitId: string, toward: 0 | 1, purpose: Purpose): SimTrain {
    const length = trainLength(l);
    const c = findCircuit(layout.trackPlan, circuitId)!;
    const t = this.blank(l, purpose, length);
    const metres = this.lengthOf(layout, c.id);
    if (length > metres) this.append(t, [{ circuitId: null, toward, metres: length - metres, via: null }]);
    this.append(t, [{ circuitId, toward, metres, via: null }]);
    for (const p of t.parts) p.origin = true;
    t.head = this.partsTotal(t);
    return t;
  }

  private blank(l: Loco, purpose: Purpose, length: number): SimTrain {
    return {
      id: newId('simtrain'),
      locoId: l.id,
      purpose,
      parts: [],
      head: 0,
      length,
      readyAt: this.now,
      dest: null,
      locked: false,
      leaving: false,
      arrived: false,
      reported: false,
      circuitsLocked: new Set(),
      junctionsLocked: new Set(),
      status: '',
      fromLine: new Set(),
      pending: [],
      changeEndsAt: null,
      permWait: '',
      penalised: new Set(),
    };
  }

  private lengthOf(layout: Layout, circuitId: string): number {
    return circuitLength(this.state, layout, circuitId).metres;
  }

  /** Circuits the train occupies now (head back to tail). */
  footprint(t: SimTrain): string[] {
    const tail = t.head - t.length;
    const out: string[] = [];
    for (const p of t.parts) if (p.circuitId && p.start < t.head && p.start + p.metres > tail) out.push(p.circuitId);
    return out;
  }

  private headPart(t: SimTrain): Part | undefined {
    return [...t.parts].reverse().find((p) => p.start < t.head) ?? t.parts[0];
  }

  // ------------------------------------------------------------------------------ incoming trains

  /** Trains despatched by the far box (Train entering section) come on to the plan. */
  private spawnIncoming(layout: Layout): void {
    for (const b of this.boxes)
      for (const s of b.sessions) {
        const inc = s.controller.view.incoming;
        if (!inc || !inc.departed || inc.arrived || this.trainOf(inc.locoId)) continue;
        const l = this.loco(inc.locoId);
        if (!l) continue;
        const homes = boxSignals(this.state, layout, this.boxDef(b.boxId)!).filter((x) => x.connectionId === s.connection.id && x.kind === 'home');
        const atHome = (d: Dir) => homes.find((h) => h.circuitId === d.circuitId && h.end === d.toward);
        const line = new Set(lineCircuits(layout, b.boxId, s.connection.id).map((c) => c.id));
        let path: Step[] | null = null;
        for (const entry of lineEntries(layout, b.boxId, s.connection.id)) {
          path = findPath(this.state, layout, entry, (d) => !!atHome(d), { blocked: (c) => !line.has(c) });
          if (path) break;
        }
        const t = this.blank(l, { kind: 'incoming', boxId: b.boxId, connId: s.connection.id }, trainLength(l));
        t.fromLine = line;
        if (!path) {
          t.status = 'Cannot find a way from the far end of the line to the home signal on the track plan.';
          this.trains.push(t);
          continue;
        }
        // The tail starts off the plan, beyond the exit.
        this.append(t, [{ circuitId: null, toward: path[0].toward, metres: t.length, via: null }]);
        this.append(t, path, atHome(path[path.length - 1])?.id);
        t.head = t.length;
        t.status = `On the line from ${s.connection.neighbourName}.`;
        this.trains.push(t);
      }
  }

  private boxDef(boxId: string) {
    return this.state.boxes.find((b) => b.id === boxId);
  }

  /** The road an incoming train is to go to, in order of preference, with how to get there from the home signal. */
  private planIncoming(layout: Layout, t: SimTrain): { dest: Dest; steps: Step[]; through: boolean } | null {
    const p = t.purpose;
    if (p.kind !== 'incoming') return null;
    const b = this.box(p.boxId);
    if (!b) return null;
    const last = t.parts[t.parts.length - 1];
    const berth: Dir = { circuitId: last.circuitId!, toward: last.toward };
    const blocked = (c: string) => this.blockedFor(t, c);
    const junctionFree = (j: string) => this.junctionFree(t, j);
    const thr = b.workings.through(p.connId);
    if (thr) {
      const secs = this.sectionSignals(layout, p.boxId, thr.toConnId);
      const steps = findPath(this.state, layout, berth, (d) => secs.some((x) => x.circuitId === d.circuitId && x.end === d.toward) && d.circuitId !== berth.circuitId, { blocked, junctionFree });
      return steps ? { dest: { kind: 'line', boxId: p.boxId, connId: thr.toConnId }, steps: steps.slice(1), through: true } : null;
    }
    const choices = arrivalChoices(this.state, p.boxId);
    if (!choices.length) {
      // A box that works no place: the train stands just inside the home signal.
      const first = nextSteps(this.state, layout, berth).find((n) => !t.fromLine.has(n.circuitId) && !blocked(n.circuitId));
      return first ? { dest: { kind: 'circuit', circuitId: first.circuitId }, steps: [first], through: false } : null;
    }
    for (const ref of this.candidateRoads(layout, t, p.boxId, p.connId)) {
      const circuitId = this.roadCircuit(layout, ref);
      if (!circuitId || blocked(circuitId)) continue;
      const steps = findPath(this.state, layout, berth, (d) => d.circuitId === circuitId, { blocked, junctionFree });
      if (steps) return { dest: { kind: 'road', placeId: ref.placeId, roadId: ref.roadId, circuitId }, steps: steps.slice(1), through: false };
    }
    return null;
  }

  private roadCircuit(layout: Layout, ref: PlaceRef): string | null {
    const c = layout.places.find((p) => p.id === ref.placeId)?.roads.find((r) => r.id === ref.roadId)?.circuitId;
    return c && findCircuit(layout.trackPlan, c) ? c : null;
  }

  /** Roads an arriving train could go to: your choice, the timetable's, then the ones that suit it (platforms for passenger trains, goods roads for goods). */
  private candidateRoads(layout: Layout, t: SimTrain, boxId: string, connId: string): PlaceRef[] {
    const chosen = this.choice.get(`${boxId}|${connId}`);
    if (chosen) return [chosen];
    const all = arrivalChoices(this.state, boxId).filter((c) => c.roadId && this.roadCircuit(layout, c));
    const hint = this.o.hints?.arrival?.(boxId, connId, t.locoId);
    const type = this.loco(t.locoId)?.working.trainTypeId ?? '';
    const kindOf = (r: PlaceRef) => layout.places.find((p) => p.id === r.placeId)?.kind ?? 'other';
    const rank = (r: PlaceRef) => {
      const k = kindOf(r);
      const c = this.roadCircuit(layout, r);
      const plat = c ? !!findCircuit(layout.trackPlan, c)?.platform : false;
      if (PASSENGER.has(type)) return k === 'station' ? (plat ? 0 : 1) : 3;
      if (GOODS.has(type)) return k === 'goods' || k === 'sidings' ? 0 : k === 'station' ? (plat ? 2 : 1) : 3;
      return k === 'depot' || k === 'sidings' ? 0 : k === 'goods' ? 1 : k === 'station' ? 2 : 3;
    };
    const fits = (r: PlaceRef) => {
      const c = this.roadCircuit(layout, r);
      return c ? this.lengthOf(layout, c) >= t.length : false;
    };
    const ordered = all
      .map((r, i) => ({ r: { placeId: r.placeId, roadId: r.roadId }, i }))
      .sort((a, b) => rank(a.r) - rank(b.r) || Number(fits(b.r)) - Number(fits(a.r)) || a.i - b.i)
      .map((x) => x.r);
    if (hint && all.some((c) => c.placeId === hint.placeId && c.roadId === hint.roadId)) return [hint, ...ordered.filter((r) => r.placeId !== hint.placeId || r.roadId !== hint.roadId)];
    return ordered;
  }

  /** Is a circuit unavailable to this train: occupied by anything else, or locked for another train's route? */
  private blockedFor(t: SimTrain, circuitId: string): boolean {
    if (this.trains.some((x) => x !== t && x.circuitsLocked.has(circuitId))) return true;
    return this.o.board.occupiedBesides(circuitId, (id) => id === t.locoId);
  }

  private junctionFree(t: SimTrain, junctionId: string): boolean {
    return !this.trains.some((x) => x !== t && x.junctionsLocked.has(junctionId));
  }

  /** Lock the circuits (those not on a line) and points of some steps for a train, and set the points. */
  private lock(layout: Layout, t: SimTrain, steps: PathStep[]): void {
    for (const s of steps) {
      if (!s.circuitId) continue;
      const c = findCircuit(layout.trackPlan, s.circuitId);
      if (c && c.owner.kind !== 'line') t.circuitsLocked.add(s.circuitId);
      if (s.via) {
        t.junctionsLocked.add(s.via.junctionId);
        this.lie.set(s.via.junctionId, s.via);
      }
    }
  }

  /** Shunts may set back in the box's own track, never on a running line. */
  private mayReverse(layout: Layout, circuitId: string): boolean {
    const c = findCircuit(layout.trackPlan, circuitId);
    return !!c && c.owner.kind !== 'line';
  }

  private sectionSignals(layout: Layout, boxId: string, connId: string): SignalDef[] {
    const b = this.boxDef(boxId);
    return b ? boxSignals(this.state, layout, b).filter((x) => x.connectionId === connId && x.kind === 'section') : [];
  }

  /** Line Clear (or the token) obtained on a line for this loco: the section signal may be cleared. */
  private lineClearFor(boxId: string, connId: string, locoId: string): boolean {
    const v = this.session(boxId, connId)?.controller.view;
    if (!v?.outgoing || (v.outgoing.locoId && v.outgoing.locoId !== locoId) || v.outgoing.arrived) return false;
    return v.mode === 'ab' ? v.remoteInstrument !== 'LB' : v.tokenWithdrawnHere || !!v.outgoing.departed;
  }

  // ------------------------------------------------------------------------------ outgoing trains

  /** A departure with Line Clear: set the route to the section signal, clear it, and send the train away. */
  private startOutgoing(layout: Layout): void {
    for (const b of this.boxes)
      for (const s of b.sessions) {
        const key = `${b.boxId}|${s.connection.id}`;
        const out = s.controller.view.outgoing;
        if (!out?.locoId || out.arrived) {
          this.outgoingStatus.delete(key);
          continue;
        }
        const l = this.loco(out.locoId);
        if (!l) continue;
        const existing = this.trainOf(l.id);
        // A through train (running, or standing at the box) is sent on by the signaller() below;
        // a train that stopped at the box (a box that works no place) sets off from where it stands.
        const standingAtBox = existing && existing.arrived && existing.purpose.kind === 'incoming' && existing.dest?.kind === 'circuit';
        if (existing && !standingAtBox) continue;
        if (!this.lineClearFor(b.boxId, s.connection.id, l.id)) {
          this.outgoingStatus.set(key, `The section signal stays at danger until ${s.connection.neighbourName} gives Line Clear.`);
          continue;
        }
        const from = standingAtBox ? this.headPart(existing!)?.circuitId ?? null : this.standingCircuit(layout, l);
        if (!from) {
          this.outgoingStatus.set(key, `${this.name(l)} is not standing on a road on the track plan, so it cannot be run.`);
          continue;
        }
        const secs = this.sectionSignals(layout, b.boxId, s.connection.id);
        const probe = this.blank(l, { kind: 'outgoing', boxId: b.boxId, connId: s.connection.id }, trainLength(l));
        let steps: Step[] | null = null;
        const blocked = (c: string) => c !== from && this.blockedFor(probe, c);
        for (const toward of [0, 1] as const) {
          steps = findPath(this.state, layout, { circuitId: from, toward }, (d) => secs.some((x) => x.circuitId === d.circuitId && x.end === d.toward), {
            blocked,
            junctionFree: (j) => this.junctionFree(probe, j),
            reverseIn: (c, tw) => this.reverseRoom(layout, probe, c, tw, blocked),
          });
          if (steps) break;
        }
        if (!steps) {
          this.outgoingStatus.set(key, `No clear route from ${this.circuitName(layout, from)} to the line to ${s.connection.neighbourName} yet.`);
          continue;
        }
        const onward = this.lineOnward(layout, probe, b.boxId, s.connection.id, steps[steps.length - 1]);
        if (!onward) {
          this.outgoingStatus.set(key, `Cannot find the way along the line to ${s.connection.neighbourName} on the track plan.`);
          continue;
        }
        if (standingAtBox) this.trains = this.trains.filter((x) => x !== existing);
        this.takeOrLeaveStock(layout, l, from);
        const t = this.standingTrain(layout, this.loco(l.id)!, from, steps[0].toward, probe.purpose);
        const sig = secs.find((x) => x.circuitId === steps![steps!.length - 1].circuitId && x.end === steps![steps!.length - 1].toward);
        const path = this.fitReversals(layout, probe, steps, blocked);
        this.append(t, path.slice(1), sig?.id);
        if (steps.length === 1 && sig) t.parts[t.parts.length - 1].signalId = sig.id;
        this.lock(layout, t, path);
        if (sig) this.signalState.set(sig.id, 'clear');
        this.append(t, onward.steps);
        if (onward.leaves) {
          this.append(t, [{ circuitId: null, toward: 0, metres: t.length + 1, via: null }]);
          t.leaving = true;
        }
        t.dest = { kind: 'line', boxId: b.boxId, connId: s.connection.id };
        t.locked = true;
        t.readyAt = this.now + DRIVER_MS / this.scale();
        t.status = `Section signal off: departing for ${s.connection.neighbourName}.`;
        this.outgoingStatus.delete(key);
        this.trains.push(t);
      }
  }

  /** From a section signal, out along the line: to the far place's road if it is on the plan, else over the line's exit. */
  private lineOnward(layout: Layout, t: SimTrain, boxId: string, connId: string, from: Dir): { steps: Step[]; leaves: boolean } | null {
    const line = new Set(lineCircuits(layout, boxId, connId).map((c) => c.id));
    const conn = this.boxDef(boxId)?.connections.find((c) => c.id === connId);
    const place = layout.places.find((p) => p.id === conn?.placeId);
    const farRoad = this.o.hints?.farRoad?.(boxId, connId, t.locoId) ?? '';
    const roadCircuits = new Set(place?.roads.filter((r) => !farRoad || r.id === farRoad).map((r) => r.circuitId ?? '').filter(Boolean));
    // To a road of the far place drawn on the plan (worked by the far box)?
    if (roadCircuits.size) {
      const steps = findPath(this.state, layout, from, (d) => roadCircuits.has(d.circuitId) && !this.blockedFor(t, d.circuitId), { blocked: (c) => !line.has(c) && !roadCircuits.has(c) && this.blockedFor(t, c) });
      if (steps && steps.length > 1) return { steps: steps.slice(1), leaves: false };
    }
    const steps = findPath(this.state, layout, from, (d) => line.has(d.circuitId) && leavesScene(layout, d), { blocked: (c) => !line.has(c) });
    if (!steps || steps.length < 2) return null;
    return { steps: steps.slice(1), leaves: true };
  }

  // ------------------------------------------------------------------------------ the automatic signaller

  private scale(): number {
    return Math.max(1, Math.min(10, this.state.settings.timeScale || 1));
  }

  private signaller(layout: Layout): void {
    for (const t of this.trains) {
      const p = t.purpose;
      if (p.kind !== 'incoming') continue;
      const b = this.box(p.boxId);
      if (!b) continue;
      if (!t.locked) {
        if (!t.parts.length) continue;
        const plan = this.planIncoming(layout, t);
        const last = t.parts[t.parts.length - 1];
        const inBerth = t.head > last.start;
        const onwardClear = !!plan?.through && plan.dest.kind === 'line' && this.lineClearFor(p.boxId, plan.dest.connId, t.locoId);
        if (!plan) {
          t.dest = null;
          const name = this.boxDef(p.boxId)?.name ?? 'the box';
          t.status = t.head >= last.start + last.metres - 0.01 ? `Held at the home signal: no clear road into ${name} yet.` : `On the line: no clear road into ${name} yet (it will wait at the home signal).`;
          continue;
        }
        t.dest = plan.dest;
        if (!inBerth && !onwardClear) {
          t.status = `On the line: approaching the home signal${plan.dest.kind === 'road' ? ` (to ${this.refName(layout, plan.dest)})` : ''}.`;
          continue;
        }
        // Clear the home signal: set and lock the route, and let the train run to its end.
        this.lock(layout, t, plan.steps);
        if (last.signalId) this.signalState.set(last.signalId, 'clear');
        const end = plan.steps[plan.steps.length - 1];
        const sec = plan.dest.kind === 'line' ? this.sectionSignals(layout, p.boxId, plan.dest.connId).find((x) => x.circuitId === end.circuitId && x.end === end.toward) : undefined;
        this.append(t, plan.steps, sec?.id);
        t.locked = true;
        t.status = plan.dest.kind === 'road' ? `Home signal off: running in to ${this.refName(layout, plan.dest)}.` : plan.through ? 'Home signal off: running through.' : 'Home signal off.';
        if (t.head >= last.start + last.metres) t.readyAt = this.now + DRIVER_MS / this.scale();
      }
      // A through train: send it on once the box in advance has given Line Clear.
      if (t.locked && t.dest?.kind === 'line' && !t.leaving) {
        const dest = t.dest;
        const end = t.parts[t.parts.length - 1];
        if (!end.signalId || this.signalState.get(end.signalId) === 'clear') continue;
        if (!this.lineClearFor(p.boxId, dest.connId, t.locoId)) {
          if (t.head >= end.start + end.metres - 0.01) t.status = `Standing at the section signal for ${this.connName(dest.boxId, dest.connId)}: waiting for Line Clear.`;
          continue;
        }
        const onward = this.lineOnward(layout, t, dest.boxId, dest.connId, { circuitId: end.circuitId!, toward: end.toward });
        if (!onward) continue;
        this.signalState.set(end.signalId, 'clear');
        this.append(t, onward.steps);
        if (onward.leaves) {
          this.append(t, [{ circuitId: null, toward: 0, metres: t.length + 1, via: null }]);
          t.leaving = true;
        }
        if (t.head >= end.start + end.metres - 0.01) t.readyAt = this.now + DRIVER_MS / this.scale();
        t.arrived = false;
        t.status = `Section signal off: on to ${this.connName(dest.boxId, dest.connId)}.`;
      }
    }
  }

  // ------------------------------------------------------------------------------ signals placed on the plan

  /** The box's lever frame (null when the layout has no signals of this box's on the plan). */
  frameOf(boxId: string, layout: Layout | undefined = this.layout): Frame | null {
    if (!layout || !signalsOf(layout).some((s) => s.boxId === boxId)) return null;
    const p = layout.trackPlan;
    const key = JSON.stringify([p.signals, p.interlocking, p.junctions.map((j) => [j.id, j.kind, j.number, j.fplNumber, j.lock, j.boxId])]);
    const f = this.frames.get(boxId);
    if (f && f.key === key) return f.frame;
    const il = boxInterlocking(this.state, layout, boxId);
    if (f) {
      f.frame.update(il);
      f.key = key;
      return f.frame;
    }
    const frame = new Frame(il);
    this.frames.set(boxId, { key, frame });
    return frame;
  }

  /** Where a signal standing `back` metres before the far end of a part's circuit is along the path, or null when not within the part (only part of the circuit is run). */
  private posIn(p: Part, back: number): number | null {
    const full = p.full ?? p.metres;
    const x = Math.max(0, full - back) - (p.offset ?? 0);
    if (x < -0.01 || x > p.metres + 0.01) return null;
    return p.start + Math.min(p.metres, Math.max(0, x));
  }

  /** Signals that apply to this train's movement, where they stand along its path (metres), post by post. */
  private postsAhead(layout: Layout, t: SimTrain, opts: { behind?: boolean } = {}): Array<{ pos: number; arms: PlanSignal[]; part: number; passable: boolean; frame: Frame }> {
    const end = this.partsTotal(t);
    const shuntMove = t.purpose.kind === 'shunt';
    const all = signalsOf(layout);
    if (!all.length) return [];
    const out: Array<{ pos: number; arms: PlanSignal[]; part: number; passable: boolean; frame: Frame }> = [];
    const postsOn = (p: Part) => {
      const here = all.filter((s) => s.circuitId === p.circuitId && s.end === p.toward && s.kind !== 'distant' && s.kind !== 'shuntAhead' && s.kind !== 'limitOfShunt' && this.box(s.boxId));
      const posts = new Map<string, PlanSignal[]>();
      for (const s of here) posts.set(postKey(s), [...(posts.get(postKey(s)) ?? []), s]);
      return [...posts.values()];
    };
    // Where the movement first meets a stop signal (passed or not): beyond it, a running train is on the
    // route that signal gives it, and shunt signals standing on that route do not apply to it.
    let firstMain = Infinity;
    t.parts.forEach((p) => {
      if (!p.circuitId) return;
      for (const arms of postsOn(p)) {
        if (!arms.some((s) => SIGNAL_KINDS[s.kind].cls === 'main')) continue;
        const pos = this.posIn(p, arms[0].back);
        if (pos !== null && pos < firstMain) firstMain = pos;
      }
    });
    t.parts.forEach((p, i) => {
      if (!p.circuitId) return;
      // Shunting here: a shunt move, a leg before the train sets back, or where it stood to set back.
      const shunt = shuntMove || t.pending.length > 0 || !!p.setBack;
      for (const arms of postsOn(p)) {
        const frame = this.frameOf(arms[0].boxId, layout);
        if (!frame) continue;
        const pos = this.posIn(p, arms[0].back);
        if (pos === null) continue;
        // A running train already signalled by a stop signal passes the shunt signals on its route.
        if (!shunt && pos > firstMain + 0.5 && !arms.some((s) => SIGNAL_KINDS[s.kind].cls === 'main')) continue;
        // Signals at the very end of the path are not passed (the train stops there anyway).
        if (pos >= end - 0.5) continue;
        if (opts.behind ? pos >= t.head - 0.5 : pos < t.head - 0.01) continue;
        // The arms for this kind of movement: running trains the stop signals, shunts the shunt signals (else whatever is there).
        const main = arms.filter((s) => SIGNAL_KINDS[s.kind].cls === 'main');
        const sh = arms.filter((s) => SIGNAL_KINDS[s.kind].cls === 'shunt');
        const mine = (shunt ? (sh.length ? sh : main) : main.length ? main : sh).filter((s) => frame.has(`sig:${s.id}`));
        if (!mine.length) continue;
        const off = mine.some((s) => frame.reversed(`sig:${s.id}`));
        // A post whose arms read no route for this movement does not apply to it (rather than hold the train for ever).
        const applies = mine.some((s) => (frame.il.releases.get(s.id) ?? []).some((r) => this.releaseFits(t, i, s, r)));
        out.push({ pos, arms: mine, part: i, passable: off || !applies, frame });
      }
    });
    return out.sort((a, b) => a.pos - b.pos);
  }

  /** Does a signal's route match the way the train is going from it? */
  private releaseFits(t: SimTrain, partIndex: number, s: PlanSignal, r: Release): boolean {
    const from = s.back > 0 ? partIndex : partIndex + 1;
    const seq = t.parts.slice(from).filter((p) => p.circuitId);
    const n = Math.min(seq.length, r.steps.length);
    if (!n) return false;
    for (let k = 0; k < n; k++) if (seq[k].circuitId !== r.steps[k].circuitId || seq[k].toward !== r.steps[k].toward) return false;
    return true;
  }

  /**
   * The automatic signaller, with signals on the plan: once a train's route is set (its path runs on
   * past a signal), set the points and pull the signal off through the box's frame, as the locking
   * allows; then the distant, once the stop signals ahead are off.
   */
  private placedSignaller(layout: Layout): void {
    for (const t of this.trains) {
      if (t.arrived) continue;
      const perm = this.permissionStop(layout, t);
      for (const x of this.postsAhead(layout, t)) {
        if (x.passable) continue;
        // Not off for a movement that may not go on past it yet (no permission for the line beyond).
        if (perm && x.pos >= perm.pos - 1) continue;
        let why = '';
        for (const s of x.arms) {
          why = x.frame.setRoute(s.id, (r) => this.releaseFits(t, x.part, s, r));
          if (!why) break;
        }
        if (why && t.head >= x.pos - 1) {
          const num = x.arms.map((s) => s.number).join('/');
          t.status = `Waiting at signal ${num}: ${why}.`;
        }
      }
      // Distants ahead: off once every stop signal they need is off.
      const end = this.partsTotal(t);
      for (const p of t.parts) {
        if (!p.circuitId) continue;
        for (const d of signalsOf(layout).filter((s) => s.kind === 'distant' && s.circuitId === p.circuitId && s.end === p.toward && this.box(s.boxId))) {
          const pos = this.posIn(p, d.back);
          if (pos === null || pos < t.head - 0.01 || pos >= end) continue;
          this.frameOf(d.boxId, layout)?.setRoute(d.id);
        }
      }
    }
  }

  /** Placed signals (and distants) the train's head has passed go back to danger. */
  private replaceBehind(layout: Layout, t: SimTrain): void {
    const all = signalsOf(layout);
    if (!all.length) return;
    for (const p of t.parts) {
      if (!p.circuitId || p.start >= t.head) continue;
      for (const s of all) {
        if (s.circuitId !== p.circuitId || s.end !== p.toward || !this.box(s.boxId)) continue;
        const pos = this.posIn(p, s.back);
        if (pos === null || pos > t.head - 0.5) continue;
        const f = this.frameOf(s.boxId, layout);
        if (f?.reversed(`sig:${s.id}`)) f.replace(s.id);
      }
    }
  }

  /** Points and FPLs no train's route needs go back to normal. */
  private tidyFrames(layout: Layout): void {
    for (const b of this.boxes) {
      const f = this.frameOf(b.boxId, layout);
      if (!f) continue;
      f.normalise((j) => this.trains.some((t) => t.junctionsLocked.has(j)));
    }
  }

  /** Signals of a box now off (placed signals), for the diagram. */
  signalsOff(boxId: string): string[] {
    return this.frameOf(boxId)?.offSignals() ?? [];
  }

  /** Each junction's lie by its points lever (placed signals), for the diagram. */
  pointsLies(boxId: string): Map<string, 'normal' | 'reverse'> {
    const f = this.frameOf(boxId);
    const out = new Map<string, 'normal' | 'reverse'>();
    if (!f) return out;
    for (const l of f.il.levers) if (l.kind === 'points') out.set(l.id, f.pointsLie(l.id));
    return out;
  }

  // ------------------------------------------------------------------------------ station limits (v0.3.32)

  /** Circuits within the clearing point inside the home signals of one of a box's lines. */
  private cpOf(layout: Layout, boxId: string, connId: string): Set<string> {
    const key = `${boxId}|${connId}`;
    const cp = layoutClearingPoint(layout);
    const hit = this.cpCache.get(key);
    if (hit && hit.plan === layout.trackPlan && hit.cp === cp) return hit.set;
    const box = this.boxDef(boxId);
    const set = box ? clearingPointCircuits(this.state, layout, box, connId) : new Set<string>();
    this.cpCache.set(key, { plan: layout.trackPlan, cp, set });
    return set;
  }

  /** Is this the train's own signalled run on a line (arriving off it, or leaving on to it with Line Clear)? It needs no permission there. */
  private ownRun(t: SimTrain, connId: string): boolean {
    const p = t.purpose;
    if (t.pending.length || p.kind === 'shunt') return false;
    return p.connId === connId || (t.dest?.kind === 'line' && t.dest.connId === connId);
  }

  /** What permission a part of the train's path needs (null: none). */
  private needFor(layout: Layout, t: SimTrain, i: number): Need | null {
    const p = t.parts[i];
    const boxId = t.purpose.boxId;
    if (!p?.circuitId || p.origin) return null;
    const line = lineOf(layout, boxId, p.circuitId);
    if (line) {
      if (this.ownRun(t, line)) return null;
      // Out past the section signal (forward), or past the home signal from behind (setting back outside it).
      const prev = t.parts[i - 1];
      const passesSection = !!prev?.circuitId && this.sectionSignals(layout, boxId, line).some((x) => x.circuitId === prev.circuitId && x.end === prev.toward);
      return { boxId, connId: line, kind: passesSection ? 'forward' : 'outside', pos: p.start, circuitId: p.circuitId };
    }
    // Over the clearing point: only shunting needs it blocked back (not a train's own run in or out).
    const shunting = t.purpose.kind === 'shunt' || t.pending.length > 0 || !!p.setBack;
    if (!shunting) return null;
    for (const s of this.box(boxId)?.sessions ?? []) {
      const conn = s.connection.id;
      if (this.cpOf(layout, boxId, conn).has(p.circuitId) && !this.ownRun(t, conn)) return { boxId, connId: conn, kind: 'inside', pos: p.start, circuitId: p.circuitId };
    }
    return null;
  }

  /** Has the box the permission it needs from the box at the far end of the line? */
  private holds(boxId: string, n: Need): boolean {
    const v = this.session(boxId, n.connId)?.controller.view;
    if (!v) return true;
    const pm = v.permission;
    if (n.kind === 'inside') return pm.rear !== null || (v.lineType === 'single' && pm.forward !== null);
    return pm.forward !== null || pm.rear === 'outside';
  }

  /** The first place ahead the train may not pass for want of permission to use the line, or null. */
  private permissionStop(layout: Layout, t: SimTrain): Need | null {
    const unmet: Need[] = [];
    for (let i = 0; i < t.parts.length; i++) {
      const p = t.parts[i];
      if (p.start < t.head - 0.01) continue;
      const n = this.needFor(layout, t, i);
      if (n && !this.holds(t.purpose.boxId, n)) unmet.push(n);
    }
    const first = unmet[0];
    if (!first) return null;
    // Going on out on to the line too: ask for that (on a single line it covers the clearing point as well).
    const out = unmet.find((n) => n.connId === first.connId && n.kind !== 'inside');
    return out ? { ...first, kind: out.kind } : first;
  }

  /** In words: what the train is waiting for, and what to ring. */
  private needText(n: Need): string {
    const who = this.connName(n.boxId, n.connId);
    const token = this.session(n.boxId, n.connId)?.controller.view.mode === 'token';
    if (n.kind === 'inside') return `Waiting to shunt inside the home signal from ${who}, over the clearing point: block back first (1, then 2-4 to ${who}).`;
    if (token) return `Waiting for a token to go out on to the line to ${who} (1, then 5-2 to ${who}, and withdraw the token).`;
    if (n.kind === 'forward') return `Waiting to draw forward into the section to ${who} (1, then 3-3-2 to ${who}).`;
    return `Waiting to set back past the home signal on to the line from ${who} (1, then 3-3 to ${who}).`;
  }

  /**
   * Movements waiting for permission to use a line, and lines blocked for shunting that are clear again
   * (so the permission can be given back): for the box's next step guidance.
   */
  permissions(boxId: string): { waiting: Array<{ locoId: string; connId: string; kind: Need['kind']; text: string }>; inUse: Set<string> } {
    const layout = this.layout;
    const waiting: Array<{ locoId: string; connId: string; kind: Need['kind']; text: string }> = [];
    const inUse = new Set<string>();
    if (!layout) return { waiting, inUse };
    for (const t of this.trains) {
      if (t.purpose.boxId !== boxId) continue;
      const n = this.permissionStop(layout, t);
      if (n) {
        waiting.push({ locoId: t.locoId, connId: n.connId, kind: n.kind, text: this.needText(n) });
      }
      // Lines the train is on, or still to use, that need permission.
      const tail = t.head - t.length;
      t.parts.forEach((p, i) => {
        if (p.start + p.metres <= tail) return;
        const need = this.needFor(layout, t, i);
        if (need) inUse.add(need.connId);
      });
      // Legs still to run: all shunting but the last of a train's (its own run out on to its line).
      t.pending.forEach((leg, k) => {
        const last = k === t.pending.length - 1 && t.purpose.kind !== 'shunt';
        const pp = t.purpose;
        const own = (conn: string) => last && pp.kind !== 'shunt' && (pp.connId === conn || (t.dest?.kind === 'line' && t.dest.connId === conn));
        const before = new Set((k ? t.pending[k - 1] : t.parts).map((x) => x.circuitId ?? ''));
        let setBack = true;
        for (const s of leg) {
          if (!s.circuitId) continue;
          setBack &&= before.has(s.circuitId);
          const line = lineOf(layout, boxId, s.circuitId);
          if (line) {
            if (!own(line)) inUse.add(line);
          } else if (!last || setBack) for (const ss of this.box(boxId)?.sessions ?? []) if (this.cpOf(layout, boxId, ss.connection.id).has(s.circuitId) && !own(ss.connection.id)) inUse.add(ss.connection.id);
        }
      });
    }
    return { waiting, inUse };
  }

  /**
   * Scoring what the railway sees: a movement out on the line (or over the clearing point) without
   * permission (it was given back too soon); Line Clear given with the clearing point obstructed.
   */
  private watchPermissions(layout: Layout): void {
    for (const t of this.trains) {
      const tail = t.head - t.length;
      t.parts.forEach((p, i) => {
        if (!p.circuitId || p.start >= t.head - 0.01 || p.start + p.metres <= tail + 0.01) return;
        const n = this.needFor(layout, t, i);
        if (!n || this.holds(t.purpose.boxId, n) || t.penalised.has(n.connId)) return;
        t.penalised.add(n.connId);
        const c = this.session(t.purpose.boxId, n.connId)?.controller;
        c?.penalise('shunt_without_permission', `${this.name(this.loco(t.locoId)!)} was on the line ${n.kind === 'inside' ? 'inside the home signal, over the clearing point,' : 'out past the signals'} without the line blocked for it (given back too soon?).`, t.locoId);
      });
    }
    const occ = this.occupancy(layout);
    for (const b of this.boxes)
      for (const s of b.sessions) {
        const key = `${b.boxId}|${s.connection.id}`;
        const now = s.controller.view.myInstrument;
        const was = this.lastInstrument.get(key);
        this.lastInstrument.set(key, now);
        if (now !== 'LC' || was === 'LC' || was === undefined || s.controller.view.mode !== 'ab') continue;
        const blocked = [...this.cpOf(layout, b.boxId, s.connection.id)].filter((c) => occ.get(c)?.size);
        if (!blocked.length) continue;
        const rule: ScoreRuleId = 'lc_clearing_point';
        s.controller.penalise(rule, `Line Clear given to ${s.connection.neighbourName} with the line inside the home signal obstructed (${blocked.map((c) => this.circuitName(layout, c)).join(', ')} occupied, within the clearing point).`);
      }
  }

  // ------------------------------------------------------------------------------ moving

  private move(layout: Layout, t: SimTrain, secs: number): void {
    const end = this.partsTotal(t);
    if (!t.parts.length) return;
    if (t.head < end - 1e-6 && this.now >= t.readyAt && secs > 0) {
      const hp = this.headPart(t);
      const c = hp?.circuitId ? findCircuit(layout.trackPlan, hp.circuitId) : undefined;
      const l = this.loco(t.locoId);
      let v = this.state.settings.simSpeed || 13.4;
      if (c) v = Math.min(v, circuitLineSpeed(layout, c));
      const lm = l ? locoMaxSpeed(l) : null;
      if (lm) v = Math.min(v, lm);
      if (t.purpose.kind === 'shunt') v = Math.min(v, DEFAULT_DIVERGING_SPEED);
      // Signals placed on the plan: stop at the first one at danger ahead (the end of its authority).
      const stopAt = this.postsAhead(layout, t).find((x) => !x.passable)?.pos ?? Infinity;
      // Station limits: no further than the line may be used without permission from the box beyond.
      const perm = this.permissionStop(layout, t);
      t.head = Math.max(t.head, Math.min(end, stopAt, perm?.pos ?? Infinity, t.head + v * secs));
      t.permWait = perm && t.head >= perm.pos - 1 ? this.needText(perm) : '';
    }
    // Placed signals go back to danger as the head passes them.
    this.replaceBehind(layout, t);
    // Signals go back to danger behind the head of the train.
    for (const p of t.parts) if (p.signalId && t.head > p.start + p.metres + 0.5 && this.signalState.get(p.signalId) === 'clear') this.signalState.set(p.signalId, 'danger');
    // Circuits and points are freed as the tail clears them (not those it comes back over after reversing).
    const tail = t.head - t.length;
    const later = new Set(t.pending.flat().flatMap((x) => [x.circuitId ?? '', x.via?.junctionId ?? '']));
    for (const p of t.parts) {
      if (p.circuitId && tail >= p.start + p.metres && !later.has(p.circuitId)) t.circuitsLocked.delete(p.circuitId);
      if (p.via && tail > p.start && !later.has(p.via.junctionId)) t.junctionsLocked.delete(p.via.junctionId);
    }
    // At the end of a leg, after the driver has changed ends: set back.
    if (t.pending.length && t.head >= end - 1e-6) {
      if (t.changeEndsAt === null) t.changeEndsAt = this.now + DRIVER_MS / this.scale();
      else if (this.now >= t.changeEndsAt) {
        t.changeEndsAt = null;
        for (const p of t.parts) if (p.circuitId && p.circuitId !== t.pending[0][0].circuitId && !later.has(p.circuitId)) t.circuitsLocked.delete(p.circuitId);
        this.nextLeg(layout, t);
      }
      return;
    }
    if (t.leaving && tail >= this.lastOnPlanEnd(t)) {
      // Gone: off the plan over the exit.
      this.gone(t);
      return;
    }
    const stopped = t.head >= end - 1e-6;
    if (!stopped || !t.locked || t.leaving || t.arrived) return;
    const d = t.dest;
    const lastCircuit = t.parts[t.parts.length - 1].circuitId;
    if (t.purpose.kind === 'shunt') {
      const done = t.purpose.onDone;
      this.trains = this.trains.filter((x) => x !== t);
      this.forgetTrain(t);
      done(true);
      return;
    }
    const atDest = (d?.kind === 'road' || d?.kind === 'circuit') && lastCircuit === d.circuitId;
    // An outgoing train that ran to a road of the far place drawn on the plan has arrived there.
    const atFar = d?.kind === 'line' && t.purpose.kind === 'outgoing';
    if (atDest || atFar) {
      t.arrived = true;
      for (const p of t.parts) if (p.circuitId) t.circuitsLocked.delete(p.circuitId);
      t.junctionsLocked.clear();
      t.status = d?.kind === 'road' ? `Stopped in ${this.refName(layout, d)}.` : 'Stopped.';
    }
  }

  /** Where the last part on the plan ends (the exit). */
  private lastOnPlanEnd(t: SimTrain): number {
    for (let i = t.parts.length - 1; i >= 0; i--) if (t.parts[i].circuitId) return t.parts[i].start + t.parts[i].metres;
    return 0;
  }

  /** A train has left the plan over an exit: the far end sees it arrive. */
  private gone(t: SimTrain): void {
    this.trains = this.trains.filter((x) => x !== t);
    this.forgetTrain(t);
    const d = t.dest;
    if (d?.kind === 'line') this.reportFar(d.boxId, d.connId, t.locoId);
  }

  private forgetTrain(t: SimTrain): void {
    t.circuitsLocked.clear();
    t.junctionsLocked.clear();
  }

  private reportFar(boxId: string, connId: string, locoId: string): void {
    const b = this.box(boxId);
    const layout = this.layout;
    if (!b || !layout) return;
    const conn = b.sessions.find((s) => s.connection.id === connId)?.connection;
    const place = layout.places.find((p) => p.id === conn?.placeId);
    let road = this.o.hints?.farRoad?.(boxId, connId, locoId) ?? '';
    if (place?.roads.length) {
      const taken = new Set(this.state.roster.flatMap((l) => (l.location.kind === 'place' && l.location.placeId === place.id ? [l.location.roadId] : [])));
      if (!road || !place.roads.some((r) => r.id === road) || taken.has(road)) road = place.roads.find((r) => !taken.has(r.id))?.id ?? place.roads[0].id;
    } else road = '';
    b.source.report({ type: 'arrivedFar', connectionId: connId, locoId, roadId: road, by: 'railway' });
  }

  /** Outgoing trains that stopped on a far road on the plan are reported arrived there. */
  private reportArrivals(layout: Layout): void {
    void layout;
    for (const t of this.trains) {
      if (t.purpose.kind !== 'outgoing' || !t.arrived || t.reported || t.dest?.kind !== 'line') continue;
      t.reported = true;
      this.reportFar(t.dest.boxId, t.dest.connId, t.locoId);
    }
  }

  /** Trains that have been reported arrived (and are now in their road), or whose movement was cancelled, become standing again. */
  private dropFinished(layout: Layout): void {
    this.trains = this.trains.filter((t) => {
      const l = this.loco(t.locoId);
      if (!l) return false;
      const p = t.purpose;
      if (p.kind === 'incoming') {
        const inc = this.session(p.boxId, p.connId)?.controller.view.incoming;
        // Reported arrived into a road: it stands there now (the roster says where).
        if (t.arrived && l.location.kind === 'place' && this.standingCircuit(layout, l)) return false;
        // Still the line's incoming train, or a through train sent on (now the onward line's outgoing train).
        if (inc && inc.locoId === t.locoId) return true;
        if (t.dest?.kind === 'line' && this.session(t.dest.boxId, t.dest.connId)?.controller.view.outgoing?.locoId === t.locoId) return true;
        if (l.location.kind === 'section' || l.location.kind === 'atBox') return true;
        return false;
      }
      if (p.kind === 'outgoing') {
        if (t.arrived && l.location.kind === 'place') return false;
        return true;
      }
      return true;
    });
  }

  // ------------------------------------------------------------------------------ stock

  /**
   * A loco setting off from a road: as a light engine (or engine and brake van) it leaves its other
   * vehicles there as a rake; as a train it takes a rake standing there.
   */
  private takeOrLeaveStock(layout: Layout, l: Loco, circuitId: string): void {
    const loc = l.location;
    if (loc.kind !== 'place') return;
    const keep = workingVehicles(l.working);
    const all = consistVehicles(l.working.consist ?? '');
    const light = l.working.trainTypeId === 'light_engine' || l.working.trainTypeId === 'engine_brake_van';
    if (light) {
      const keptKinds = new Set(keep.map((v) => v.kind));
      const left = all.filter((v) => !keptKinds.has(v.kind));
      if (!left.length) return;
      const rake: StockRake = { id: newId('rake'), description: vehiclesText(left), vehicles: left.map((v) => ({ kind: v.kind, count: v.count, metres: v.metres })), placeId: loc.placeId, roadId: loc.roadId, circuitId };
      this.o.update((s) => {
        const lay = s.layouts.find((x) => x.id === layout.id);
        const loco = s.roster.find((x) => x.id === l.id);
        if (!lay || !loco) return;
        (lay.stock ??= []).push(rake);
        loco.working.consist = keep.length ? vehiclesText(keep) : '';
      });
      return;
    }
    const rake = (layout.stock ?? []).find((r) => r.placeId === loc.placeId && r.roadId === loc.roadId);
    if (!rake) return;
    this.o.update((s) => {
      const lay = s.layouts.find((x) => x.id === layout.id);
      const loco = s.roster.find((x) => x.id === l.id);
      if (!lay || !loco) return;
      lay.stock = (lay.stock ?? []).filter((r) => r.id !== rake.id);
      if (!lay.stock.length) delete lay.stock;
      loco.working.consist = rake.description;
    });
  }

  // ------------------------------------------------------------------------------ occupancy

  /** What occupies each circuit: moving trains' footprints, locos standing in roads, rakes. */
  occupancy(layout: Layout | undefined = this.layout): Map<string, Set<string>> {
    const occ = new Map<string, Set<string>>();
    if (!layout) return occ;
    const add = (c: string, who: string) => {
      let s = occ.get(c);
      if (!s) occ.set(c, (s = new Set()));
      s.add(who);
    };
    const moving = new Set(this.trains.map((t) => t.locoId));
    for (const t of this.trains) for (const c of this.footprint(t)) add(c, t.locoId);
    for (const l of this.state.roster) {
      if (moving.has(l.id)) continue;
      const c = this.standingCircuit(layout, l);
      if (c) add(c, l.id);
    }
    for (const r of layout.stock ?? []) if (r.circuitId && findCircuit(layout.trackPlan, r.circuitId)) add(r.circuitId, `rake:${r.id}`);
    return occ;
  }

  /** Report every change of occupancy through a box's source of train events (the board follows). */
  private reportOccupancy(layout: Layout): void {
    const src = this.boxes[0]?.source;
    if (!src) return;
    const now = this.occupancy(layout);
    const ev = (type: 'enteredCircuit' | 'clearedCircuit', circuitId: string, who: string) =>
      src.report(who.startsWith('rake:') ? { type, circuitId, locoId: null, stockId: who.slice(5), by: 'railway' } : { type, circuitId, locoId: who, by: 'railway' });
    for (const [c, was] of this.reportedOcc) for (const who of was) if (!now.get(c)?.has(who)) ev('clearedCircuit', c, who);
    for (const [c, is] of now) for (const who of is) if (!this.reportedOcc.get(c)?.has(who)) ev('enteredCircuit', c, who);
    this.reportedOcc = now;
  }

  // ------------------------------------------------------------------------------ shunting

  /**
   * Shunt a loco (light engine, or with its train) from where it stands to a road in a box's area
   * (a timetable shunt move). The route is set and locked at once; `onDone` is called when it has
   * stopped there. Returns why it cannot be done (then the timetable falls back to a card), or null.
   */
  shunt(boxId: string, locoId: string, to: PlaceRef, onDone: (ok: boolean, at: PlaceRef) => void): string | null {
    const layout = this.layout;
    const l = this.loco(locoId);
    if (!layout || !l || !this.box(boxId)) return 'No railway running.';
    if (this.trainOf(locoId)) return 'It is already moving.';
    const from = this.standingCircuit(layout, l);
    if (!from) return 'It is not standing on a road drawn on the track plan.';
    // Any road of the place ('' road): the first one with a clear way in.
    const place = layout.places.find((p) => p.id === to.placeId);
    const roads = to.roadId ? [to] : (place?.roads ?? []).map((r) => ({ placeId: to.placeId, roadId: r.id }));
    const probe = this.blank(l, { kind: 'shunt', boxId, to, onDone: () => {} }, trainLength(l));
    // Into a road with only stock in it (to couple up) is allowed; anything else must be clear.
    const onlyStock = (c: string) => this.o.board.occupants(c).every((x) => x.startsWith('rake:') || x === locoId);
    let found: { steps: PathStep[]; ref: PlaceRef; target: string } | null = null;
    for (const ref of roads) {
      const target = this.roadCircuit(layout, ref);
      if (!target) continue;
      if (target === from) {
        // A change of working where it stands (e.g. now a light engine: its coaches stay here).
        this.takeOrLeaveStock(layout, l, from);
        this.o.scheduler.setTimeout(() => onDone(true, ref), 0);
        return null;
      }
      const blocked = (c: string) => c !== from && (c === target ? !onlyStock(c) || this.trains.some((x) => x.circuitsLocked.has(c)) : this.blockedFor(probe, c));
      for (const toward of [0, 1] as const) {
        const steps = findPath(this.state, layout, { circuitId: from, toward }, (d) => d.circuitId === target, { blocked, junctionFree: (j) => this.junctionFree(probe, j), anyWay: true, reverseIn: (c, tw) => this.reverseRoom(layout, probe, c, tw, blocked) });
        if (steps) {
          found = { steps: this.fitReversals(layout, probe, steps, blocked), ref, target };
          break;
        }
      }
      if (found) break;
    }
    if (!found) return roads.some((r) => this.roadCircuit(layout, r)) ? `No clear route to ${this.refName(layout, roads[0])} yet.` : 'Not on a road drawn on the track plan.';
    const { steps, ref, target } = found;
    this.takeOrLeaveStock(layout, l, from);
    const t = this.standingTrain(layout, this.loco(locoId)!, from, steps[0].toward, { kind: 'shunt', boxId, to: ref, onDone: (ok) => onDone(ok, ref) });
    this.append(t, steps.slice(1));
    this.lock(layout, t, steps);
    t.dest = { kind: 'road', placeId: ref.placeId, roadId: ref.roadId, circuitId: target };
    t.locked = true;
    t.readyAt = this.now + DRIVER_MS / this.scale();
    t.status = `Shunting to ${this.refName(layout, ref)}.`;
    this.trains.push(t);
    this.emit();
    return null;
  }

  // ------------------------------------------------------------------------------ for the box

  /** Choose the road for the train arriving on a line (null: let the app choose). Refused once its route is set. */
  setDestination(boxId: string, connId: string, ref: PlaceRef | null): string | null {
    const inc = this.session(boxId, connId)?.controller.view.incoming;
    const t = inc ? this.trainOf(inc.locoId) : undefined;
    if (t?.locked) return 'The route is set and the home signal is off: the road can no longer be changed.';
    this.choice.set(`${boxId}|${connId}`, ref);
    this.tick();
    return null;
  }

  /** The road chosen for a line's arriving trains (null = the app chooses). */
  chosen(boxId: string, connId: string): PlaceRef | null {
    return this.choice.get(`${boxId}|${connId}`) ?? null;
  }

  /** The arriving train on a line as the railway sees it, or null when none is on the plan. */
  incoming(boxId: string, connId: string): SimIncomingView | null {
    const layout = this.layout;
    const inc = this.session(boxId, connId)?.controller.view.incoming;
    if (!layout || !inc) return null;
    const t = this.trainOf(inc.locoId);
    if (!t) return null;
    const fp = this.footprint(t);
    const clearOfLine = !fp.some((c) => t.fromLine.has(c));
    const hp = this.headPart(t);
    const where = hp?.circuitId ? (findCircuit(layout.trackPlan, hp.circuitId)?.code ?? '') : '';
    const d = t.dest;
    const dest = d?.kind === 'road' ? { placeId: d.placeId, roadId: d.roadId } : null;
    const stoppedAtDest = t.arrived || (t.locked && t.head >= this.partsTotal(t) - 1e-6 && !t.leaving);
    const arrivedDetected = stoppedAtDest && clearOfLine;
    const onward = d?.kind === 'line' ? new Set(lineCircuits(layout, d.boxId, d.connId).map((c) => c.id)) : null;
    const passedDetected = !!onward && clearOfLine && (fp.length === 0 || fp.every((c) => onward.has(c)));
    return {
      locoId: t.locoId,
      where,
      dest,
      destText: d ? (d.kind === 'road' ? this.refName(layout, d) : d.kind === 'line' ? `on to ${this.connName(d.boxId, d.connId)}` : 'at the box') : '',
      chosen: this.chosen(boxId, connId),
      locked: t.locked,
      arrivedDetected,
      passedDetected,
      at: dest,
      status: t.permWait || t.status,
    };
  }

  /** What is happening to a line's departure, in words ('' when nothing to say). */
  outgoingText(boxId: string, connId: string): string {
    const out = this.session(boxId, connId)?.controller.view.outgoing;
    const t = out?.locoId ? this.trainOf(out.locoId) : undefined;
    const layout = this.layout;
    if (t && layout && (t.purpose.kind === 'outgoing' || (t.dest?.kind === 'line' && t.dest.connId === connId))) {
      const hp = this.headPart(t);
      const code = hp?.circuitId ? findCircuit(layout.trackPlan, hp.circuitId)?.code : '';
      return `${t.permWait || t.status}${code ? ` Head of the train at ${code}.` : ''}`;
    }
    return this.outgoingStatus.get(`${boxId}|${connId}`) ?? '';
  }

  /** The state of a box's signals (for the diagram). */
  signals(boxId: string): Array<SignalDef & { clear: boolean }> {
    const layout = this.layout;
    const b = this.boxDef(boxId);
    if (!layout || !b) return [];
    return boxSignals(this.state, layout, b).map((s) => ({ ...s, clear: this.signalState.get(s.id) === 'clear' }));
  }

  /** Circuits locked in a set route, and how points lie in them (for the diagram). */
  routes(): { circuits: string[]; junctions: Passing[] } {
    const circuits = new Set<string>();
    const js = new Set<string>();
    for (const t of this.trains) {
      for (const c of t.circuitsLocked) circuits.add(c);
      for (const j of t.junctionsLocked) js.add(j);
    }
    return { circuits: [...circuits], junctions: [...js].map((j) => this.lie.get(j)!).filter(Boolean) };
  }

  /** Trains on the plan, for labels on the diagram: the circuit their head is in. */
  trainLabels(): Array<{ locoId: string; circuitId: string }> {
    return this.trains.flatMap((t) => {
      const hp = this.headPart(t);
      return hp?.circuitId && this.footprint(t).includes(hp.circuitId) ? [{ locoId: t.locoId, circuitId: hp.circuitId }] : [];
    });
  }

  // ------------------------------------------------------------------------------ words

  private name(l: Loco): string {
    return [l.number, l.name ? `"${l.name}"` : ''].filter(Boolean).join(' ') || 'the train';
  }
  private connName(boxId: string, connId: string): string {
    return this.boxDef(boxId)?.connections.find((c) => c.id === connId)?.neighbourName ?? 'the next box';
  }
  private circuitName(layout: Layout, id: string): string {
    const c = findCircuit(layout.trackPlan, id);
    return c ? c.name || c.code : 'its road';
  }
  private refName(layout: Layout, d: { placeId: string; roadId: string }): string {
    const p = layout.places.find((x) => x.id === d.placeId);
    const r = p?.roads.find((x) => x.id === d.roadId);
    return r ? (/^(p\d|platform)/i.test(r.name) ? r.name : `${r.name} (${p?.name})`) : (p?.name ?? "its road");
  }
}
