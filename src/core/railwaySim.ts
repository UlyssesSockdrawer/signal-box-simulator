import { newId } from './store';
import { MARKED, type OccupancyBoard } from './occupancy';
import { arrivalChoices, CARRIAGE_PLACES, ENGINE_PLACES, roadsOfCircuit } from './places';
import { DEFAULT_DIVERGING_SPEED, facingWords, hasFacing, circuitLength, layoutClearingPoint, circuitLineSpeed, consistVehicles, locoLength, locoMaxSpeed, needsEngineLeading, trainLength, vehiclesText, workingVehicles } from './railway';
import { boxSignals, findPath, leavesScene, lineCircuits, lineEntries, nextSteps, type Dir, type Passing, type SignalDef, type Step } from './routing';
import { Emitter, type Scheduler } from './scheduler';
import type { SectionSession } from './session';
import type { ThroughWorkings } from './throughTrains';
import { findCircuit, findJunction, straightOn } from './trackPlan';
import { clearingPointZones, lineOf, stretchFouls, type ClearingZone } from './stationLimits';
import type { ScoreRuleId } from './score';
import { boxInterlocking, Frame, type Release } from './interlocking';
import { postKey, signalsOf, SIGNAL_KINDS } from './signals';
import type { TrainEventSource } from './trainEvents';
import type { AppState, Layout, Loco, PlaceKind, PlaceRef, PlanSignal } from './types';
import type { Vehicle } from './stockTypes';
import { consistKind, splitVehicleList, stockLibrary, vehicleGroups, vehiclesMetres, mintFromConsist, type StockLibrary } from './stock';

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
 * where a rake stands takes the rake with it. A timetabled shunt can say what it moves with ("2 vans"):
 * it takes those and leaves the rest, so trains can be broken up into several roads. Since v0.3.38 (D19)
 * standing stock is individual vehicles: minted from the generic library types for a text consist, carried
 * by the train that takes them (Working.vehicles, while they match its consist), discarded off the layout.
 *
 * THE ENGINE'S END OF ITS TRAIN (v0.3.35): the railway remembers which end of its train each loco is at
 * (Working.locoEnd: the end of the circuit it stands on). A train arrives engine first; an engine that
 * runs on to stock couples up at the end it came in by. A loco hauled train goes out on to a line with
 * its engine leading (setting back and propelling within the station is fine: the search counts the
 * reversals). One standing with its engine at the wrong end RUNS ROUND first, by itself, when its
 * departure is set (or earlier, when the timetable asks): uncouple, light engine round by a loop or
 * release crossover (asking for blocking back where it goes over a clearing point), couple up at the
 * other end. An engine that cannot run round (buffer stops, no release, or the release blocked by
 * standing stock) is released by the STATION PILOT, ECS-style: the pilot couples to the outer end and
 * draws the stock off to a free road, the engine goes out of the way, the pilot puts the stock back
 * into the platform, and the engine backs on at the outer end. Railcars, push-pull trains and light
 * engines need none of this.
 */

const PASSENGER = new Set(['express_passenger', 'ordinary_passenger', 'branch_passenger', 'railcar', 'parcels', 'ecs']);
const GOODS = new Set(['freight_fitted_half', 'freight_fitted_third', 'freight_fitted_four', 'freight_unfitted', 'through_freight', 'mineral', 'pickup_goods', 'branch_freight']);
/** Real time between moves of the trains (ms). */
const TICK_MS = 250;
/** A driver's reaction when the signal clears, in simulated ms. */
const DRIVER_MS = 3000;
/** How far clear of the points a train setting back draws up beyond them (metres). */
const CLEAR_OF_POINTS = 10;
/** Uncoupling an engine from its train, and coupling one up (simulated ms). */
const UNCOUPLE_MS = 30_000;
const COUPLE_MS = 45_000;
/** Turning an engine on a turntable (simulated ms). */
const TURN_MS = 90_000;

/** Do these vehicles still match the consist text (same kinds and counts)? Else the text has changed since. */
function matchesConsist(vehicles: Vehicle[], consist: string, lib: StockLibrary): boolean {
  const a = vehicleGroups(vehicles, lib);
  const b = consistVehicles(consist);
  return a.length === b.length && a.every((g) => b.some((x) => x.kind === g.kind && x.count === g.count));
}

/**
 * The vehicles behind a loco, one by one (v0.3.38, D19): those it carries while they still match its
 * consist, else minted from the generic library for the consist text. A light engine has none; an
 * engine and brake van its brake van(s).
 */
export function ownVehicles(l: Loco, lib: StockLibrary): Vehicle[] {
  const w = l.working;
  if (w.trainTypeId === 'light_engine') return [];
  const all = consistStock(l, lib);
  if (w.trainTypeId === 'engine_brake_van') return all.filter((v) => consistKind(lib.cls(v.classId)) === 'brake van');
  return all;
}

/** Every vehicle its consist names, whatever its working (a light engine about to leave them, a pilot moving some). */
function consistStock(l: Loco, lib: StockLibrary): Vehicle[] {
  const w = l.working;
  return w.vehicles?.length && matchesConsist(w.vehicles, w.consist ?? '', lib) ? w.vehicles : mintFromConsist(w.consist ?? '');
}

/** Some vehicles as consist text ("4 coaches + a brake van"). */
const describe = (vehicles: Vehicle[], lib: StockLibrary) => vehiclesText(vehicleGroups(vehicles, lib));

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
  /** The engine is at the front of its train on the leg it is running (it changes with every reversal). */
  leads: boolean;
  /** The engine runs smokebox (No. 1 end) first on this leg; null = not known (v0.3.36). Flips with every reversal. */
  smoke: boolean | null;
  /** Stopped on a turntable: when it will have been turned (scheduler time). */
  turnAt: number | null;
}

/**
 * Work the railway does by itself to get an engine to the right end of its train (v0.3.35): running
 * round, or the station pilot releasing a trapped engine. A list of steps, each tried every tick until
 * it starts (it may have to wait for a clear way); a step that moves a loco finishes when it stops.
 */
interface Job {
  id: string;
  kind: 'runRound' | 'pilot';
  boxId: string;
  /** The train's engine. */
  locoId: string;
  pilotId?: string;
  steps: Array<() => 'started' | 'done' | string>;
  i: number;
  busy: boolean;
  status: string;
  onDone?: (ok: boolean) => void;
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
  /** How the engine is running: "smokebox first", "tender first"… ('' when not known or it does not matter). */
  facing: string;
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
  private cpCache = new Map<string, { plan: unknown; cp: number; sig: string; zones: Map<string, ClearingZone[]> }>();
  /** Each line's instrument as last seen (to catch Line Clear given with the clearing point obstructed). */
  private lastInstrument = new Map<string, string>();
  /** Running round and pilot releases under way, by the train's engine (v0.3.35). */
  private jobs = new Map<string, Job>();

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
      for (const [k, j] of this.jobs) if (!this.boxes.some((b) => b.boxId === j.boxId)) this.jobs.delete(k);
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
    for (const j of this.jobs.values()) j.onDone?.(false);
    this.jobs.clear();
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
      this.runJobs();
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
    // Setting back: the other end of the train leads now.
    t.leads = !t.leads;
    if (t.smoke !== null) t.smoke = !t.smoke;
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
      const len = this.lengthOf(layout, prev.circuitId);
      const need = t.length + CLEAR_OF_POINTS - len;
      if (need <= 0) {
        // Room in the circuit itself (v0.3.39): run in only as far as it must, just clear of the points
        // behind it, not to the far end (which may be over the clearing point, or at the home signal).
        const last = out[out.length - 1];
        if (i - 1 > 0 && !prev.reverse && last && last.circuitId === prev.circuitId && last.offset === undefined && last.full === undefined && this.mayReverse(layout, prev.circuitId))
          out[out.length - 1] = { ...last, metres: t.length + CLEAR_OF_POINTS, full: len };
        out.push(s);
        continue;
      }
      const ext = this.drawForward(layout, t, { circuitId: prev.circuitId, toward: prev.toward }, need, blocked);
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
  private standingTrain(layout: Layout, l: Loco, circuitId: string, toward: 0 | 1, purpose: Purpose, lengthOf?: number): SimTrain {
    const length = lengthOf ?? this.trainLen(l);
    // Which end of the train the engine is at (as far as is known): it leads when it is at the end it sets off towards.
    const end = this.locoEndIn(l, circuitId);
    const c = findCircuit(layout.trackPlan, circuitId)!;
    const t = this.blank(l, purpose, length);
    const metres = this.lengthOf(layout, c.id);
    if (length > metres) this.append(t, [{ circuitId: null, toward, metres: length - metres, via: null }]);
    this.append(t, [{ circuitId, toward, metres, via: null }]);
    for (const p of t.parts) p.origin = true;
    t.head = this.partsTotal(t);
    t.leads = end === null || end === toward;
    // Which way it faces (as far as is known): smokebox first if its smokebox points the way it sets off.
    // Turned "as needed" (a turntable, or off the layout): not settled until its next run on a line.
    const f = l.working.facing;
    t.smoke = !l.working.facingFree && f && f.circuitId === circuitId ? f.end === toward : null;
    return t;
  }

  /** The end of a circuit a loco standing on it is at (its end of its train), or null when not known. */
  private locoEndIn(l: Loco, circuitId: string): 0 | 1 | null {
    const e = l.working.locoEnd;
    return e && e.circuitId === circuitId ? e.end : null;
  }

  /** Is stock (a rake) standing on a circuit? */
  private stockOn(layout: Layout, circuitId: string): boolean {
    return (layout.stock ?? []).some((r) => r.circuitId === circuitId);
  }

  /**
   * A train has stopped: remember which end of its train the engine is at. Leading into an empty road it
   * is at the end it ran towards; pushing its train in, or running on to stock to couple up, at the end it came in by.
   */
  private recordEnd(layout: Layout, t: SimTrain, turned = false): void {
    const last = [...t.parts].reverse().find((p) => p.circuitId && p.start < t.head);
    if (!last?.circuitId) return;
    const end = (t.leads && !this.stockOn(layout, last.circuitId) ? last.toward : 1 - last.toward) as 0 | 1;
    const circuitId = last.circuitId;
    // Which way the engine faces: its smokebox the way it ran, if it ran smokebox first.
    const facing = t.smoke === null ? null : ((t.smoke ? last.toward : 1 - last.toward) as 0 | 1);
    this.o.update((s) => {
      const loco = s.roster.find((x) => x.id === t.locoId);
      if (!loco) return;
      loco.working.locoEnd = { circuitId, end };
      if (facing !== null) loco.working.facing = { circuitId, end: facing };
      if (turned) loco.working.facingFree = true;
    });
  }

  /**
   * Settle the facing of an engine turned "as needed" for the run it is setting off on: smokebox first on
   * the last leg (the one out on to the line), so on the first leg smokebox first if it sets back an even
   * number of times on the way. Remembered where it stands.
   */
  private settleFacing(t: SimTrain, path: PathStep[], from: string): void {
    const l = this.loco(t.locoId);
    if (!l?.working.facingFree || !hasFacing(l)) return;
    const flips = path.filter((p) => p.reverse).length % 2 === 1;
    t.smoke = !flips;
    const toward = path[0]?.toward ?? 0;
    const end = (t.smoke ? toward : 1 - toward) as 0 | 1;
    this.o.update((s) => {
      const loco = s.roster.find((x) => x.id === t.locoId);
      if (!loco) return;
      delete loco.working.facingFree;
      loco.working.facing = { circuitId: from, end };
    });
  }

  /** Does a train stopping on this circuit stop on a turntable (a road of a place that is a turntable)? */
  private onTurntable(layout: Layout, circuitId: string | null): boolean {
    return !!circuitId && roadsOfCircuit(layout, circuitId).some((x) => x.place.kind === 'turntable');
  }

  /** Words for how a loco is running ('' when it does not matter or is not known): "tender first", "smokebox first"… */
  private facingNote(t: SimTrain): string {
    const l = this.loco(t.locoId);
    return l && t.smoke !== null && hasFacing(l) ? facingWords(l, t.smoke) : '';
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
      leads: true,
      smoke: null,
      turnAt: null,
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
        const t = this.blank(l, { kind: 'incoming', boxId: b.boxId, connId: s.connection.id }, this.trainLen(l));
        t.fromLine = line;
        // Which way it faces coming on (v0.3.37): off the layout (a fiddle yard, the box beyond) engines and
        // trains are turned as an operator would, ready for their next journey, whatever the line (single or
        // double, out and back or round). A train comes on engine and smokebox first; a light engine faces
        // whichever way the train it goes to work wants (settled when that train sets off).
        const light = !workingVehicles(l.working).length;
        t.smoke = !hasFacing(l) || light ? null : true;
        this.o.update((st) => {
          const loco = st.roster.find((x) => x.id === l.id);
          if (!loco) return;
          delete loco.working.facing;
          if (light && hasFacing(l)) loco.working.facingFree = true;
          else delete loco.working.facingFree;
        });
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
      // Parcels and vans: a dock (a goods or other place's road on a platform, often the same track as a station road) first.
      // Empty stock: to the carriage sidings or shed; light engines to the shed, turntable or servicing.
      if (type === 'ecs') return CARRIAGE_PLACES.has(k) ? 0 : k === 'station' ? (plat ? 1 : 2) : k === 'sidings' ? 2 : 3;
      if (type === 'parcels') return (k === 'goods' || k === 'other') && plat ? 0 : k === 'station' ? (plat ? 1 : 2) : k === 'goods' || k === 'sidings' ? 2 : 3;
      if (PASSENGER.has(type)) return k === 'station' ? (plat ? 0 : 1) : 3;
      if (GOODS.has(type)) return k === 'goods' || k === 'sidings' ? 0 : k === 'station' ? (plat ? 2 : 1) : 3;
      return ENGINE_PLACES.has(k) || k === 'sidings' ? 0 : k === 'goods' ? 1 : k === 'station' ? 2 : 3;
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
        // Running round (or being released by the station pilot) first: wait for it.
        const job = this.jobs.get(l.id);
        if (job) {
          this.outgoingStatus.set(key, job.status);
          continue;
        }
        const from = standingAtBox ? this.headPart(existing!)?.circuitId ?? null : this.standingCircuit(layout, l);
        if (!from) {
          this.outgoingStatus.set(key, `${this.name(l)} is not standing on a road on the track plan, so it cannot be run.`);
          continue;
        }
        // A loco hauled train goes out with its engine leading: one at the wrong end runs round first,
        // as soon as its departure is set (it needs no Line Clear for that).
        if (!standingAtBox && this.ensureLeading(layout, b.boxId, l, from, s.connection.id, key)) continue;
        if (!this.lineClearFor(b.boxId, s.connection.id, l.id)) {
          this.outgoingStatus.set(key, `The section signal stays at danger until ${s.connection.neighbourName} gives Line Clear.`);
          continue;
        }
        const steps = this.departurePath(layout, b.boxId, s.connection.id, this.loco(l.id)!, from, !standingAtBox);
        if (!steps) {
          this.outgoingStatus.set(key, `No clear route from ${this.circuitName(layout, from)} to the line to ${s.connection.neighbourName} yet.`);
          continue;
        }
        const secs = this.sectionSignals(layout, b.boxId, s.connection.id);
        const probe = this.blank(l, { kind: 'outgoing', boxId: b.boxId, connId: s.connection.id }, this.trainLen(l));
        const blocked = (c: string) => c !== from && this.blockedFor(probe, c);
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
        // An engine turned "as needed" faces the way this train wants: smokebox first out on to the line
        // (counting the times it sets back on the way, it faces this way where it stands now).
        this.settleFacing(t, path, from);
        const fn = this.facingNote(t);
        t.status = `Section signal off: departing for ${s.connection.neighbourName}${fn ? ` (${fn})` : ''}.`;
        this.outgoingStatus.delete(key);
        this.trains.push(t);
      }
  }

  /**
   * The way from where a departing train stands to one of its line's section signals. With `lead`, a
   * loco hauled train must reach it with its engine leading (it may set back and propel on the way, in
   * the station); otherwise any way will do. Null when there is none clear now.
   */
  private departurePath(layout: Layout, boxId: string, connId: string, l: Loco, from: string, lead: boolean, opts: { ignoreOccupancy?: boolean } = {}): Step[] | null {
    const secs = this.sectionSignals(layout, boxId, connId);
    const probe = this.blank(l, { kind: 'outgoing', boxId, connId }, this.departLength(layout, l, from));
    const blocked = (c: string) => c !== from && !opts.ignoreOccupancy && this.blockedFor(probe, c);
    const end = lead && this.mustLead(layout, l, from) ? this.locoEndIn(l, from) : null;
    // Setting off either way: the better of the two (fewest reversals, then the shortest).
    let best: { steps: Step[]; cost: number } | null = null;
    for (const toward of [0, 1] as const) {
      const leads0 = end === null || end === toward;
      const steps = findPath(this.state, layout, { circuitId: from, toward }, (d, flipped) => secs.some((x) => x.circuitId === d.circuitId && x.end === d.toward) && (end === null || leads0 !== flipped), {
        blocked,
        junctionFree: (j) => opts.ignoreOccupancy || this.junctionFree(probe, j),
        reverseIn: (c, tw) => this.reverseRoom(layout, probe, c, tw, blocked),
        parity: end !== null,
      });
      if (!steps) continue;
      const cost = steps.reduce((m, x) => m + x.metres + (x.reverse ? 100_000 : 0), 0);
      if (!best || cost < best.cost) best = { steps, cost };
    }
    return best?.steps ?? null;
  }

  /** The vehicles a loco sets off with from a road: its own, and (unless it runs light) any rake standing there. */
  private departVehicles(layout: Layout, l: Loco, circuitId: string): Vehicle[] {
    const lib = stockLibrary(layout.rollingStock);
    const own = ownVehicles(l, lib);
    if (l.working.trainTypeId === 'light_engine' || l.working.trainTypeId === 'engine_brake_van') return own;
    const loc = l.location;
    const rake = loc.kind === 'place' ? (layout.stock ?? []).find((r) => r.placeId === loc.placeId && r.roadId === loc.roadId) ?? (layout.stock ?? []).find((r) => r.circuitId === circuitId) : undefined;
    return rake ? rake.vehicles : own;
  }

  /**
   * A train's length (v0.3.40): its stated length, else the loco plus its vehicles one by one (a rake's
   * real lengths; a text consist's vehicles are the generic types), or a multiple unit's cars.
   */
  private trainLen(l: Loco): number {
    if (l.working.length || /\b(dmu|emu|railcar|multiple unit|unit)\b/i.test(l.powerType)) return trainLength(l);
    const lib = stockLibrary(this.layout?.rollingStock);
    return locoLength(l) + vehiclesMetres(ownVehicles(l, lib), lib);
  }

  private departLength(layout: Layout, l: Loco, circuitId: string): number {
    if (l.working.length) return trainLength(l);
    return locoLength(l) + vehiclesMetres(this.departVehicles(layout, l, circuitId), stockLibrary(layout.rollingStock));
  }

  /** Must this loco lead its train out (a loco hauled train with vehicles, and we know which end it is at)? */
  private mustLead(layout: Layout, l: Loco, circuitId: string): boolean {
    return this.locoEndIn(l, circuitId) !== null && needsEngineLeading(l, vehicleGroups(this.departVehicles(layout, l, circuitId), stockLibrary(layout.rollingStock)));
  }

  /**
   * Before a departure: is the engine at the right end? When it is not (no way out with it leading, but
   * there is one with it at the back), it runs round first, or the station pilot releases it. Returns
   * true while the departure must wait for that (the status says why).
   */
  private ensureLeading(layout: Layout, boxId: string, l: Loco, from: string, connId: string, statusKey: string | null): boolean {
    if (!this.mustLead(layout, l, from)) return false;
    // A way out with the engine leading, even if not clear yet: nothing to do (the departure waits for it as usual).
    if (this.departurePath(layout, boxId, connId, l, from, true, { ignoreOccupancy: true })) return false;
    // No way out at all, however it is worked: nothing running round can fix (the usual status follows).
    if (!this.departurePath(layout, boxId, connId, l, from, false, { ignoreOccupancy: true })) return false;
    const r = this.reEnd(layout, boxId, l.id, null);
    if (statusKey) this.outgoingStatus.set(statusKey, r ?? this.jobs.get(l.id)?.status ?? '');
    return true;
  }

  // ------------------------------------------------------------------------------ running round and the station pilot (v0.3.35)

  /** Run the jobs under way: each step is tried until it starts; a step that moves a loco finishes when it stops. */
  private runJobs(): void {
    for (const [k, j] of [...this.jobs]) {
      while (!j.busy && j.i < j.steps.length) {
        const r = j.steps[j.i]();
        if (r === 'done') {
          j.i++;
          continue;
        }
        if (r !== 'started') j.status = r;
        break;
      }
      if (!j.busy && j.i >= j.steps.length) {
        this.jobs.delete(k);
        j.onDone?.(true);
      }
    }
  }

  /** A job step that waits a while (uncoupling, coupling up). */
  private waitStep(j: Job, ms: number, text: string): () => 'done' | string {
    let until: number | null = null;
    return () => {
      until ??= this.now + ms / this.scale();
      j.status = text;
      return this.now >= until ? 'done' : text;
    };
  }

  /**
   * Get a loco to the other end of its train where it stands: run round if it can, else have the station
   * pilot release it. `want` = the end it must end up at (null: the other end from where it is). Returns
   * null when a job has been set going (or one is under way), else why not.
   */
  private reEnd(layout: Layout, boxId: string, locoId: string, want: 0 | 1 | null, onDone?: (ok: boolean) => void): string | null {
    if (this.jobs.has(locoId)) return null;
    const l = this.loco(locoId);
    const c = l ? this.standingCircuit(layout, l) : null;
    if (!l || !c) return 'It is not standing on a road on the track plan.';
    const known = this.locoEndIn(l, c);
    const e = (known ?? (want === null ? null : 1 - want)) as 0 | 1 | null;
    // Not known which end it is at: whichever end it can run round from.
    const ends: Array<0 | 1> = e === null ? [0, 1] : [e];
    if (want !== null && e === want) return null;
    const ref = l.location.kind === 'place' ? { placeId: l.location.placeId, roadId: l.location.roadId } : null;
    for (const end of ends) {
      if (this.runRoundPath(layout, boxId, l, c, end, false)) {
        this.startRunRound(layout, boxId, l, c, end, ref, onDone);
        return null;
      }
    }
    // In the way only of trains on the move (or routes set for them): wait for them to go by.
    for (const end of ends)
      if (this.runRoundPath(layout, boxId, l, c, end, true)) return `${this.name(l)} is to run round its train: waiting for the way round to clear.`;
    // Trapped: buffer stops, no loop or release crossover, or the release blocked by standing stock or engines.
    const end = ends[0];
    const pilot = this.findPilot(layout, boxId, l, c, end);
    if (!pilot) {
      const place = ref ? layout.places.find((p) => p.id === ref.placeId)?.name ?? 'here' : 'here';
      return `${this.name(l)} is trapped at the wrong end of its train (it cannot run round from ${this.circuitName(layout, c)}). A station pilot could release it: give a loco the Shunter / pilot duty for ${place} in the roster, and have it stand in a road nearby.`;
    }
    this.startPilotRelease(layout, boxId, l, c, end, ref, pilot, onDone);
    return null;
  }

  /** Circuits a loco may run through on its own in the box's area (no lines; points and roads as given). */
  private shuntBlocked(layout: Layout, t: SimTrain, opts: { through?: string; into?: string; standingOnly?: boolean }): (c: string) => boolean {
    const moving = new Set(this.trains.map((o) => o.locoId));
    return (c: string) => {
      if (c === opts.through || c === opts.into) return false;
      const x = findCircuit(layout.trackPlan, c);
      if (!x || x.owner.kind === 'line') return true;
      // Only what stands still counts (stock, engines standing): trains on the move will go by.
      if (opts.standingOnly) return this.o.board.occupants(c).some((id) => id !== t.locoId && !moving.has(id));
      return this.blockedFor(t, c);
    };
  }

  /**
   * The way for a light engine standing at end `end` of its train in circuit `c` to run round it: out by
   * that end, round by a loop or release crossover (setting back where it must), and back into `c` from
   * its other end. `standingOnly`: only what stands still is in the way (trains on the move will go by:
   * to tell "wait for the way round" from "trapped").
   */
  private runRoundPath(layout: Layout, boxId: string, l: Loco, c: string, end: 0 | 1, standingOnly: boolean): Step[] | null {
    const probe = this.blank(l, { kind: 'shunt', boxId, to: { placeId: '', roadId: '' }, onDone: () => {} }, locoLength(l));
    const blocked = this.shuntBlocked(layout, probe, { into: c, standingOnly });
    const moving = new Set(this.trains.map((o) => o.locoId));
    const anyBlocked = (x: string) => x !== c && (standingOnly ? this.o.board.occupants(x).some((id) => id !== l.id && !moving.has(id)) : this.blockedFor(probe, x));
    return findPath(this.state, layout, { circuitId: c, toward: end }, (d) => d.circuitId === c && d.toward === end, {
      blocked,
      anyWay: true,
      notStart: true,
      // Back into its train's road only from the far end (not back the way it went).
      enter: (d) => d.circuitId !== c || d.toward === end,
      junctionFree: (j) => standingOnly || this.junctionFree(probe, j),
      reverseIn: (x, tw) => x !== c && this.reverseRoom(layout, probe, x, tw, anyBlocked),
    });
  }

  /**
   * Move a loco by itself (a job step): from where it stands to a circuit, as a shunt in the box's area.
   * `length`: the loco and what it has with it. `startToward`: the way it must set off. `enterToward`: the
   * way it must run into the target (to come in at the right end). `into`: the target may hold stock or an
   * engine (to couple up, or the engine at the far end). Returns 'started', or why it cannot go yet.
   */
  private jobMove(layout: Layout, j: Job, locoId: string, target: { circuitId: string; ref: PlaceRef | null } | (() => { circuitId: string; ref: PlaceRef | null } | null), opts: { length: number; startToward?: 0 | 1; enterToward?: 0 | 1; into?: boolean; text: string; then?: (at: string) => void }): 'started' | string {
    const l = this.loco(locoId);
    if (!l) return 'The loco is no longer on the roster.';
    if (this.trainOf(locoId)) return opts.text;
    const from = this.standingCircuit(layout, l);
    if (!from) return `${this.name(l)} is not standing on a road on the track plan.`;
    const tgt = typeof target === 'function' ? target() : target;
    if (!tgt) return `${opts.text} Waiting for a free road.`;
    const probe = this.blank(l, { kind: 'shunt', boxId: j.boxId, to: tgt.ref ?? { placeId: '', roadId: '' }, onDone: () => {} }, opts.length);
    const blocked = this.shuntBlocked(layout, probe, { through: from, into: opts.into ? tgt.circuitId : undefined });
    const anyBlocked = (x: string) => x !== from && x !== tgt.circuitId && this.blockedFor(probe, x);
    let steps: Step[] | null = null;
    for (const toward of opts.startToward === undefined ? ([0, 1] as const) : [opts.startToward]) {
      steps = findPath(this.state, layout, { circuitId: from, toward }, (d) => d.circuitId === tgt.circuitId && (opts.enterToward === undefined || d.toward === opts.enterToward), {
        blocked,
        anyWay: true,
        notStart: true,
        enter: (d) => d.circuitId !== tgt.circuitId || opts.enterToward === undefined || d.toward === opts.enterToward,
        junctionFree: (x) => this.junctionFree(probe, x),
        reverseIn: (x, tw) => x !== tgt.circuitId && this.reverseRoom(layout, probe, x, tw, anyBlocked),
      });
      if (steps) break;
    }
    if (!steps) return `${opts.text} Waiting for a clear way.`;
    const path = this.fitReversals(layout, probe, steps, anyBlocked);
    const t = this.standingTrain(layout, l, from, steps[0].toward, {
      kind: 'shunt',
      boxId: j.boxId,
      to: tgt.ref ?? { placeId: '', roadId: '' },
      onDone: () => {
        // It stands on the target's road now.
        const ref = tgt.ref ?? this.roadRefOf(layout, tgt.circuitId, j.boxId);
        if (ref)
          this.o.update((s) => {
            const loco = s.roster.find((x) => x.id === locoId);
            if (loco) loco.location = { kind: 'place', placeId: ref.placeId, roadId: ref.roadId };
          });
        opts.then?.(tgt.circuitId);
        j.busy = false;
        j.i++;
      },
    }, opts.length);
    this.append(t, path.slice(1));
    this.lock(layout, t, path);
    t.dest = { kind: 'road', placeId: tgt.ref?.placeId ?? '', roadId: tgt.ref?.roadId ?? '', circuitId: tgt.circuitId };
    t.locked = true;
    t.readyAt = this.now + DRIVER_MS / this.scale();
    t.status = opts.text;
    this.trains.push(t);
    j.busy = true;
    j.status = opts.text;
    return 'started';
  }

  /** A road (of a place, preferably one the box works) a circuit is. */
  private roadRefOf(layout: Layout, circuitId: string, boxId: string): PlaceRef | null {
    const all = roadsOfCircuit(layout, circuitId);
    const mine = all.find((x) => x.place.workedBy.some((w) => w.kind === 'box' && w.boxId === boxId)) ?? all[0];
    return mine ? { placeId: mine.place.id, roadId: mine.road.id } : null;
  }

  /**
   * A free road in the box's area for a loco (and what it has with it), to get out of the way or to stand
   * stock on: tied to a circuit nothing stands on or is routed over, long enough, not one of `avoid`.
   * `prefer` orders the kinds of place.
   */
  private freeRoad(layout: Layout, boxId: string, length: number, avoid: Set<string>, prefer: PlaceKind[]): { circuitId: string; ref: PlaceRef } | null {
    const out: Array<{ circuitId: string; ref: PlaceRef; rank: number; plat: boolean }> = [];
    for (const p of layout.places) {
      if (p.kind === 'fiddleYard' || !p.workedBy.some((w) => w.kind === 'box' && w.boxId === boxId)) continue;
      for (const r of p.roads) {
        const c = r.circuitId;
        if (!c || avoid.has(c) || !findCircuit(layout.trackPlan, c)) continue;
        if (this.o.board.occupants(c).length || this.trains.some((t) => t.circuitsLocked.has(c) || this.footprint(t).includes(c))) continue;
        if (this.lengthOf(layout, c) < length) continue;
        const k = prefer.indexOf(p.kind);
        out.push({ circuitId: c, ref: { placeId: p.id, roadId: r.id }, rank: k < 0 ? prefer.length : k, plat: !!findCircuit(layout.trackPlan, c)?.platform });
      }
    }
    out.sort((a, b) => a.rank - b.rank);
    return out[0] ? { circuitId: out[0].circuitId, ref: out[0].ref } : null;
  }

  /** Uncouple a loco from its train where it stands: its vehicles become a rake on the road. */
  private uncouple(layout: Layout, locoId: string, circuitId: string): void {
    const l = this.loco(locoId);
    if (!l || l.location.kind !== 'place') return;
    const vehicles = consistStock(l, stockLibrary(layout.rollingStock));
    if (!vehicles.length) return;
    const loc = l.location;
    this.o.update((s) => {
      const lay = s.layouts.find((x) => x.id === layout.id);
      const loco = s.roster.find((x) => x.id === locoId);
      if (!lay || !loco) return;
      const here = (lay.stock ?? []).find((r) => r.circuitId === circuitId);
      if (here) here.vehicles.push(...structuredClone(vehicles));
      else (lay.stock ??= []).push({ id: newId('rake'), vehicles: structuredClone(vehicles), placeId: loc.placeId, roadId: loc.roadId, circuitId });
      loco.working.consist = '';
      delete loco.working.vehicles;
    });
  }

  /** Couple a loco up to the stock standing on its circuit: the stock becomes its train. */
  private coupleUp(layout: Layout, locoId: string, circuitId: string): void {
    this.o.update((s) => {
      const lay = s.layouts.find((x) => x.id === layout.id);
      const loco = s.roster.find((x) => x.id === locoId);
      if (!lay || !loco) return;
      const rakes = (lay.stock ?? []).filter((r) => r.circuitId === circuitId);
      if (!rakes.length) return;
      const lib = stockLibrary(lay.rollingStock);
      const all = [...consistStock(loco, lib), ...rakes.flatMap((r) => r.vehicles)];
      lay.stock = (lay.stock ?? []).filter((r) => r.circuitId !== circuitId);
      if (!lay.stock.length) delete lay.stock;
      loco.working.consist = describe(all, lib);
      loco.working.vehicles = all;
    });
  }

  /** The vehicles a loco has with it now (its consist), as a length behind it. */
  private stockLength(locoId: string): number {
    const l = this.loco(locoId);
    const lib = stockLibrary(this.layout?.rollingStock);
    return l ? locoLength(l) + vehiclesMetres(consistStock(l, lib), lib) : 0;
  }

  private startRunRound(layout: Layout, boxId: string, l: Loco, c: string, end: 0 | 1, ref: PlaceRef | null, onDone?: (ok: boolean) => void): void {
    const j: Job = { id: newId('job'), kind: 'runRound', boxId, locoId: l.id, steps: [], i: 0, busy: false, status: `${this.name(l)} is running round its train.`, onDone };
    const who = this.name(l);
    j.steps = [
      this.waitStep(j, UNCOUPLE_MS, `${who} is uncoupling to run round its train.`),
      () => {
        this.uncouple(layout, l.id, c);
        return 'done';
      },
      () => this.jobMove(layout, j, l.id, { circuitId: c, ref }, { length: locoLength(l), startToward: end, enterToward: end, into: true, text: `${who} is running round its train.` }),
      this.waitStep(j, COUPLE_MS, `${who} is coupling up at the other end of its train.`),
      () => {
        this.coupleUp(layout, l.id, c);
        this.setEnd(l.id, c, (1 - end) as 0 | 1);
        return 'done';
      },
    ];
    this.jobs.set(l.id, j);
    this.runJobs();
  }

  private setEnd(locoId: string, circuitId: string, end: 0 | 1): void {
    this.o.update((s) => {
      const loco = s.roster.find((x) => x.id === locoId);
      if (loco) loco.working.locoEnd = { circuitId, end };
    });
  }

  /**
   * A station pilot to release an engine trapped at end `end` of its train in `c`: a loco with the pilot
   * duty for the place (or anywhere), standing light on a road of the box's area, not moving or wanted on
   * a line, that can get to the far end of the train. The nearest such.
   */
  private findPilot(layout: Layout, boxId: string, l: Loco, c: string, end: 0 | 1): Loco | null {
    const placeId = l.location.kind === 'place' ? l.location.placeId : '';
    const wanted = new Set<string>();
    for (const b of this.boxes)
      for (const s of b.sessions) {
        const v = s.controller.view;
        if (v.outgoing?.locoId) wanted.add(v.outgoing.locoId);
        if (v.incoming?.locoId) wanted.add(v.incoming.locoId);
      }
    const busy = new Set([...this.jobs.values()].flatMap((j) => [j.locoId, j.pilotId ?? '']));
    let best: { l: Loco; d: number } | null = null;
    for (const p of this.state.roster) {
      if (p.id === l.id || wanted.has(p.id) || busy.has(p.id) || this.trainOf(p.id)) continue;
      if (!(p.jobs ?? []).some((jb) => jb.duty === 'pilot' && (!jb.placeIds.length || jb.placeIds.includes(placeId)))) continue;
      if (consistVehicles(p.working.consist ?? '').length && p.working.trainTypeId !== 'light_engine') continue;
      const at = this.standingCircuit(layout, p);
      if (!at || at === c) continue;
      const probe = this.blank(p, { kind: 'shunt', boxId, to: { placeId: '', roadId: '' }, onDone: () => {} }, locoLength(p));
      const steps = findPath(this.state, layout, { circuitId: at, toward: 0 }, (d) => d.circuitId === c && d.toward === end, {
        blocked: this.shuntBlocked(layout, probe, { through: at, into: c, standingOnly: true }),
        anyWay: true,
        enter: (d) => d.circuitId !== c || d.toward === end,
        reverseIn: (x) => x !== c && this.mayReverse(layout, x),
      }) ?? findPath(this.state, layout, { circuitId: at, toward: 1 }, (d) => d.circuitId === c && d.toward === end, {
        blocked: this.shuntBlocked(layout, probe, { through: at, into: c, standingOnly: true }),
        anyWay: true,
        enter: (d) => d.circuitId !== c || d.toward === end,
        reverseIn: (x) => x !== c && this.mayReverse(layout, x),
      });
      if (!steps) continue;
      const d = steps.reduce((m, x) => m + x.metres, 0);
      if (!best || d < best.d) best = { l: p, d };
    }
    return best?.l ?? null;
  }

  /**
   * The station pilot releases an engine trapped at end `end` of its train in `c`, ECS-style: it couples to
   * the outer end and draws the stock off to a free road; the engine goes out of the way; the pilot puts
   * the stock back and gets clear (unless it is left at the buffer-stop end, where it waits for the train
   * to go); the engine backs on at the outer end.
   */
  private startPilotRelease(layout: Layout, boxId: string, l: Loco, c: string, end: 0 | 1, ref: PlaceRef | null, pilot: Loco, onDone?: (ok: boolean) => void): void {
    const j: Job = { id: newId('job'), kind: 'pilot', boxId, locoId: l.id, pilotId: pilot.id, steps: [], i: 0, busy: false, status: '', onDone };
    const who = this.name(l);
    const pn = `The station pilot (${this.name(pilot)})`;
    const outer = (1 - end) as 0 | 1;
    const lay = () => this.layout ?? layout;
    let stockAt: { circuitId: string; ref: PlaceRef } | null = null;
    let engineAt: { circuitId: string; ref: PlaceRef } | null = null;
    let pilotEnd: 0 | 1 | null = null;
    const pilotHome = pilot.location.kind === 'place' ? { placeId: pilot.location.placeId, roadId: pilot.location.roadId } : null;
    const homeCircuit = this.standingCircuit(layout, pilot);
    j.status = `${who} cannot run round: ${pn.toLowerCase()} is coming to release it.`;
    j.steps = [
      this.waitStep(j, UNCOUPLE_MS, `${who} is trapped at the wrong end of its train: uncoupling for the station pilot.`),
      () => {
        this.uncouple(lay(), l.id, c);
        return 'done';
      },
      // 1. The pilot runs on to the outer end of the stock.
      () => this.jobMove(lay(), j, pilot.id, { circuitId: c, ref }, { length: locoLength(pilot), enterToward: end, into: true, text: `${pn} is coming on to the outer end of ${who}'s train to release it.` }),
      this.waitStep(j, COUPLE_MS, `${pn} is coupling up to the stock.`),
      () => {
        this.coupleUp(lay(), pilot.id, c);
        this.setEnd(pilot.id, c, outer);
        return 'done';
      },
      // 2. It draws the stock off to a free road.
      () =>
        this.jobMove(lay(), j, pilot.id, () => (stockAt ??= this.freeRoad(lay(), boxId, this.stockLength(pilot.id), new Set([c]), ['carriageSidings', 'carriageShed', 'sidings', 'station', 'other', 'goods', 'depot'])), {
          length: this.stockLength(pilot.id),
          startToward: outer,
          text: `${pn} is drawing the stock off ${this.circuitName(layout, c)}, releasing ${who}.`,
        }),
      // 3. The engine, released, goes out of the way.
      () =>
        this.jobMove(lay(), j, l.id, () => (engineAt ??= this.freeRoad(lay(), boxId, locoLength(l), new Set([c, stockAt?.circuitId ?? '']), ['depot', 'turntable', 'coaling', 'water', 'fuel', 'sidings', 'goods', 'station', 'other'])), {
          length: locoLength(l),
          startToward: outer,
          text: `${who} is released: out of the way while the pilot puts the stock back.`,
        }),
      // 4. The pilot puts the stock back into the road.
      () =>
        this.jobMove(lay(), j, pilot.id, { circuitId: c, ref }, {
          length: this.stockLength(pilot.id),
          text: `${pn} is putting the stock back into ${this.circuitName(layout, c)}.`,
          then: () => {
            pilotEnd = this.locoEndIn(this.loco(pilot.id)!, c);
          },
        }),
      this.waitStep(j, UNCOUPLE_MS, `${pn} is uncoupling from the stock.`),
      () => {
        this.uncouple(lay(), pilot.id, c);
        return 'done';
      },
      // 5. A pilot left at the outer end gets clear (one at the buffer stops waits there until the train has gone).
      () => {
        if (pilotEnd !== outer) return 'done';
        const back = homeCircuit && pilotHome && !this.o.board.occupants(homeCircuit).length ? { circuitId: homeCircuit, ref: pilotHome } : null;
        return this.jobMove(lay(), j, pilot.id, () => back ?? this.freeRoad(lay(), boxId, locoLength(pilot), new Set([c]), ['depot', 'turntable', 'coaling', 'water', 'fuel', 'sidings', 'goods', 'station', 'other']), {
          length: locoLength(pilot),
          startToward: outer,
          text: `${pn} is getting clear of the outer end.`,
        });
      },
      // 6. The engine backs on at the outer end.
      () => this.jobMove(lay(), j, l.id, { circuitId: c, ref }, { length: locoLength(l), enterToward: end, into: true, text: `${who} is backing on to its train at the outer end.` }),
      this.waitStep(j, COUPLE_MS, `${who} is coupling up to its train.`),
      () => {
        this.coupleUp(lay(), l.id, c);
        this.setEnd(l.id, c, outer);
        return 'done';
      },
    ];
    this.jobs.set(l.id, j);
    this.runJobs();
  }

  /**
   * Get a departure ready early (the timetable asks, when the train has nothing else to do): if its engine
   * is at the wrong end for its line, it runs round (or is released by the pilot) now. Returns what is
   * happening in words ('' when nothing needs doing).
   */
  prepareDeparture(boxId: string, locoId: string, connId: string): string {
    const layout = this.layout;
    const l = this.loco(locoId);
    if (!layout || !l || !this.box(boxId) || this.trainOf(locoId)) return '';
    const job = this.jobs.get(locoId);
    if (job) return job.status;
    const from = this.standingCircuit(layout, l);
    if (!from) return '';
    return this.ensureLeading(layout, boxId, l, from, connId, null) ? (this.jobs.get(locoId)?.status ?? `${this.name(l)} is to run round its train.`) : '';
  }

  /**
   * Run a loco round its train where it stands (a timetabled run round): it ends at the other end. Returns
   * why it cannot be done (the timetable falls back to a card), or null.
   */
  runRound(boxId: string, locoId: string, onDone: (ok: boolean) => void): string | null {
    const layout = this.layout;
    const l = this.loco(locoId);
    if (!layout || !l || !this.box(boxId)) return 'No railway running.';
    if (this.trainOf(locoId)) return 'It is already moving.';
    const c = this.standingCircuit(layout, l);
    if (!c) return 'It is not standing on a road drawn on the track plan.';
    if (!consistVehicles(l.working.consist ?? '').length && !this.stockOn(layout, c)) {
      this.o.scheduler.setTimeout(() => onDone(true), 0);
      return null;
    }
    const known = this.locoEndIn(l, c);
    const err = this.reEnd(layout, boxId, locoId, known === null ? null : ((1 - known) as 0 | 1), onDone);
    if (err && !this.jobs.has(locoId)) return err;
    return null;
  }

  /** What the railway is doing by itself in a box's area (running round, pilot releases), in words. */
  jobsText(boxId: string): string[] {
    return [...this.jobs.values()].filter((j) => j.boxId === boxId).map((j) => j.status);
  }

  /** Is a loco busy with a run round or a pilot release (as the engine or the pilot)? */
  busyWithJob(locoId: string): boolean {
    return [...this.jobs.values()].some((j) => j.locoId === locoId || j.pilotId === locoId);
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
  /** The clearing point inside the home signals of a line: circuit → the stretches of it within the clearing point. */
  private cpOf(layout: Layout, boxId: string, connId: string): Map<string, ClearingZone[]> {
    const key = `${boxId}|${connId}`;
    const cp = layoutClearingPoint(layout);
    const sig = layout.trackPlan.circuits.map((c) => c.length ?? '').join(',');
    const hit = this.cpCache.get(key);
    if (hit && hit.plan === layout.trackPlan && hit.cp === cp && hit.sig === sig) return hit.zones;
    const box = this.boxDef(boxId);
    const zones = box ? clearingPointZones(this.state, layout, box, connId) : new Map<string, ClearingZone[]>();
    this.cpCache.set(key, { plan: layout.trackPlan, cp, sig, zones });
    return zones;
  }

  /** Does this stretch of a circuit (a part of a path) foul the clearing point inside the home signal of a line? */
  private foulsCp(layout: Layout, boxId: string, connId: string, p: { circuitId: string | null; toward: 0 | 1; metres: number; offset?: number; full?: number }): boolean {
    if (!p.circuitId) return false;
    return stretchFouls(this.cpOf(layout, boxId, connId).get(p.circuitId), p, p.full ?? this.lengthOf(layout, p.circuitId));
  }

  /**
   * Is the clearing point obstructed in this circuit? Anything standing in it counts (where it stands in
   * the circuit is not known); a train on the move only where its footprint lies within the clearing point.
   */
  private cpOccupied(layout: Layout, boxId: string, connId: string, circuitId: string, occ: Map<string, Set<string>>): boolean {
    const who = occ.get(circuitId);
    if (!who?.size) return false;
    for (const id of who) {
      const t = this.trains.find((x) => x.locoId === id);
      if (!t) return true;
      const tail = t.head - t.length;
      for (const p of t.parts) {
        if (p.circuitId !== circuitId) continue;
        const from = Math.max(tail, p.start);
        const to = Math.min(t.head, p.start + p.metres);
        if (to <= from + 0.01) continue;
        if (this.foulsCp(layout, boxId, connId, { circuitId, toward: p.toward, metres: to - from, offset: (p.offset ?? 0) + (from - p.start), full: p.full })) return true;
      }
    }
    return false;
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
      if (this.foulsCp(layout, boxId, conn, p) && !this.ownRun(t, conn)) return { boxId, connId: conn, kind: 'inside', pos: p.start, circuitId: p.circuitId };
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
          } else if (!last || setBack) for (const ss of this.box(boxId)?.sessions ?? []) if (this.foulsCp(layout, boxId, ss.connection.id, s) && !own(ss.connection.id)) inUse.add(ss.connection.id);
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
        const blocked = [...this.cpOf(layout, b.boxId, s.connection.id).keys()].filter((c) => this.cpOccupied(layout, b.boxId, s.connection.id, c, occ));
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
      // On a turntable: turned before it is done (it faces the other way now).
      if (this.onTurntable(layout, lastCircuit) && t.length <= locoLength(this.loco(t.locoId) ?? ({ powerType: '' } as Loco)) + 1) {
        if (t.turnAt === null) {
          t.turnAt = this.now + TURN_MS / this.scale();
          t.status = 'Being turned on the turntable.';
          return;
        }
        if (this.now < t.turnAt) return;
        // Turned to face whichever way its next train needs (settled when that train sets off on a line):
        // it may well run back to its train tender first, to leave with it smokebox first.
        t.smoke = null;
        t.turnAt = Infinity;
      }
      const done = t.purpose.onDone;
      this.trains = this.trains.filter((x) => x !== t);
      this.forgetTrain(t);
      this.recordEnd(layout, t, t.turnAt === Infinity);
      done(true);
      return;
    }
    const atDest = (d?.kind === 'road' || d?.kind === 'circuit') && lastCircuit === d.circuitId;
    // An outgoing train that ran to a road of the far place drawn on the plan has arrived there.
    const atFar = d?.kind === 'line' && t.purpose.kind === 'outgoing';
    if (atDest || atFar) {
      this.recordEnd(layout, t);
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
    // Off the layout: how it faces there is up to the operators (it is turned as needed for its next journey).
    if (d?.kind === 'line')
      this.o.update((s) => {
        const loco = s.roster.find((x) => x.id === t.locoId);
        if (!loco) return;
        delete loco.working.facing;
        // Vehicles minted for the train are discarded when it leaves the layout (D1a).
        delete loco.working.vehicles;
      });
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
  private takeOrLeaveStock(layout: Layout, l: Loco, circuitId: string, movesWith?: string): void {
    const loc = l.location;
    if (loc.kind !== 'place') return;
    const lib = stockLibrary(layout.rollingStock);
    if (movesWith?.trim()) {
      // A shunt that says what it moves with (v0.3.35): take those from its own train and the stock here, leave the rest.
      const rakes = (layout.stock ?? []).filter((r) => r.circuitId === circuitId || (r.placeId === loc.placeId && r.roadId === loc.roadId));
      const pool = [...consistStock(l, lib), ...rakes.flatMap((r) => r.vehicles)];
      const { taken, left } = splitVehicleList(pool, movesWith, lib);
      this.o.update((s) => {
        const lay = s.layouts.find((x) => x.id === layout.id);
        const loco = s.roster.find((x) => x.id === l.id);
        if (!lay || !loco) return;
        const gone = new Set(rakes.map((r) => r.id));
        lay.stock = (lay.stock ?? []).filter((r) => !gone.has(r.id));
        if (left.length) lay.stock.push({ id: newId('rake'), vehicles: structuredClone(left), placeId: loc.placeId, roadId: loc.roadId, circuitId });
        if (!lay.stock.length) delete lay.stock;
        loco.working.consist = describe(taken, lib);
        if (taken.length) loco.working.vehicles = structuredClone(taken);
        else delete loco.working.vehicles;
      });
      return;
    }
    const light = l.working.trainTypeId === 'light_engine' || l.working.trainTypeId === 'engine_brake_van';
    if (light) {
      // Every vehicle behind it (whatever the working says), less the brake vans an engine and brake van keeps.
      const all = consistStock(l, lib);
      const keepVans = l.working.trainTypeId === 'engine_brake_van';
      const keep = keepVans ? all.filter((v) => consistKind(lib.cls(v.classId)) === 'brake van') : [];
      const left = all.filter((v) => !keep.includes(v));
      if (!left.length) return;
      const keepText = keep.length ? describe(keep, lib) : keepVans ? vehiclesText(workingVehicles(l.working)) : '';
      this.o.update((s) => {
        const lay = s.layouts.find((x) => x.id === layout.id);
        const loco = s.roster.find((x) => x.id === l.id);
        if (!lay || !loco) return;
        (lay.stock ??= []).push({ id: newId('rake'), vehicles: structuredClone(left), placeId: loc.placeId, roadId: loc.roadId, circuitId });
        loco.working.consist = keepText;
        if (keep.length) loco.working.vehicles = structuredClone(keep);
        else delete loco.working.vehicles;
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
      loco.working.consist = describe(rake.vehicles, lib);
      loco.working.vehicles = structuredClone(rake.vehicles);
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
  shunt(boxId: string, locoId: string, to: PlaceRef, onDone: (ok: boolean, at: PlaceRef) => void, opts: { vehicles?: string } = {}): string | null {
    const layout = this.layout;
    const l = this.loco(locoId);
    if (!layout || !l || !this.box(boxId)) return 'No railway running.';
    if (this.trainOf(locoId)) return 'It is already moving.';
    const from = this.standingCircuit(layout, l);
    if (!from) return 'It is not standing on a road drawn on the track plan.';
    // Any road of the place ('' road): the first one with a clear way in.
    const place = layout.places.find((p) => p.id === to.placeId);
    const roads = to.roadId ? [to] : (place?.roads ?? []).map((r) => ({ placeId: to.placeId, roadId: r.id }));
    const probe = this.blank(l, { kind: 'shunt', boxId, to, onDone: () => {} }, this.trainLen(l));
    // Into a road with only stock in it (to couple up) is allowed; anything else must be clear.
    const onlyStock = (c: string) => this.o.board.occupants(c).every((x) => x.startsWith('rake:') || x === locoId);
    let found: { steps: PathStep[]; ref: PlaceRef; target: string } | null = null;
    for (const ref of roads) {
      const target = this.roadCircuit(layout, ref);
      if (!target) continue;
      if (target === from) {
        // A change of working where it stands (e.g. now a light engine: its coaches stay here).
        this.takeOrLeaveStock(layout, l, from, opts.vehicles);
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
    this.takeOrLeaveStock(layout, l, from, opts.vehicles);
    const now = this.loco(locoId)!;
    // Moving with some vehicles whatever its working says (a pilot drawing stock off as a light engine): their length counts.
    const len = opts.vehicles?.trim() ? this.stockLength(locoId) : undefined;
    const t = this.standingTrain(layout, now, from, steps[0].toward, { kind: 'shunt', boxId, to: ref, onDone: (ok) => onDone(ok, ref) }, len);
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
      facing: this.facingNote(t),
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
