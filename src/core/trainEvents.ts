import type { SectionSession } from './session';
import type { ThroughWorkings } from './throughTrains';
import { MARKED, type OccupancyBoard } from './occupancy';
import type { PlaceRef } from './types';

/*
 * THE SOURCE OF TRAIN EVENTS: the seam between the signalling and the trains.
 *
 * LinkEnd is the seam between two signal boxes (bells, instruments, tokens). This is the seam
 * between a box and the railway it signals: what the trains PHYSICALLY did (arrived, passed
 * complete, entered a track circuit…). The signalling core (SectionController and, through its
 * link, SimulatedNeighbour, BoxReferee, BoxRegulator, ThroughWorkings and the TimetableRunner)
 * learns of train movements only through a TrainEventSource, applied by a TrainEventRouter.
 *
 *   person's buttons ───────────┐
 *   simulated fiddle yard op. ──┤ ReportedMovements ──▶ TrainEventRouter ──▶ SectionController…
 *   (later) simulated railway ──┤   (a TrainEventSource)
 *   (later) occupancy detection ┘
 *
 * Today's MODEL RAILWAY MODE: real trains on a real layout that the app neither drives nor
 * detects, so movements are REPORTED: by the person (Train arrived complete, Arrived in <place>,
 * passed complete) or by the timetable runner's simulated fiddle yard operator. Both report
 * through ReportedMovements.
 *
 * Requests go the other way (release a train into a section, set points, clear a signal). They
 * are declared now for SIGNALLER PLAY MODE; a source that cannot carry one out says so
 * ('unsupported'). In model railway mode the person drives the trains, so nothing is supported.
 *
 * Offering, cancelling and declaring trains (requestIncoming, cancelIncoming, setOutgoing) are not
 * train movements: they are what the operator/timetable plans to run, and stay as they are.
 */

/**
 * How a signal box session is run. Chosen each time a box is opened (it belongs to the box's
 * running state, never to the layout or the box's definition): any layout can be run either way.
 *  - model: a model railway. Real trains; movements are reported by the person or a simulated operator.
 *  - play: signaller play mode. The layout's plan is treated as a real railway, run virtually.
 */
export type RunningMode = 'model' | 'play';

export const RUNNING_MODES: ReadonlyArray<{ id: RunningMode; name: string; description: string }> = [
  { id: 'model', name: 'Model railway', description: 'Real trains on your layout. You (or the simulated fiddle yard operator) report where they get to.' },
  { id: 'play', name: 'Signaller play', description: 'The layout is run as a real railway, with simulated trains.' },
];

export const DEFAULT_RUNNING_MODE: RunningMode = 'model';

/** Who or what told the box about a movement. */
export type ReportedBy =
  /** The person at the box (or the model railway operator beside them) pressed a button. */
  | 'person'
  /** The timetable runner's simulated fiddle yard operator. */
  | 'fiddleYardOperator'
  /** A simulated railway (signaller play mode; later). */
  | 'railway'
  /** Train detection on a real layout (not planned; nothing here should block it). */
  | 'detection';

/** Something a train physically did, on one of a box's lines or on the layout's track. */
export type TrainEvent =
  /**
   * The incoming train on `connectionId` has arrived complete (tail lamp seen) and come to a stand at
   * this box: on a road of a place the box works (`at`), or at the box itself (null: a junction box,
   * or a through train standing before it is sent on).
   */
  | { type: 'arrived'; connectionId: string; locoId: string | null; at: PlaceRef | null; by: ReportedBy }
  /** The through train on `connectionId` has passed this box complete, already sent on into the section ahead. */
  | { type: 'passed'; connectionId: string; locoId: string | null; by: ReportedBy }
  /** The outgoing train on `connectionId` has arrived complete at the far end (on a road of the line's place, '' for none). */
  | { type: 'arrivedFar'; connectionId: string; locoId: string | null; roadId: string; by: ReportedBy }
  // ---- Track circuits (v0.3.28): applied to the layout's occupancy board ----
  /**
   * A train (locoId), a rake of stock standing on its own (stockId), or something unknown (neither:
   * a circuit marked occupied by hand, or a detection section showing occupied) has entered a track circuit.
   */
  | { type: 'enteredCircuit'; circuitId: string; locoId: string | null; stockId?: string; by: ReportedBy }
  /** The same has cleared it (neither id from detection: the section shows clear of everything). */
  | { type: 'clearedCircuit'; circuitId: string; locoId: string | null; stockId?: string; by: ReportedBy }
  // ---- Declared for later stages, not yet acted on ----
  /** A train has come to a stand (on a track circuit, if known). */
  | { type: 'stopped'; locoId: string | null; circuitId: string | null; by: ReportedBy };

export type TrainEventType = TrainEvent['type'];

/** Asked of the railway by the box (signaller play mode). Declared now; not carried out yet. */
export type TrainRequest =
  /** Let the train standing ready go forward into the block section on `connectionId`. */
  | { type: 'releaseIntoSection'; connectionId: string; locoId: string | null }
  /** Set a set of points (junction on the track plan) normal or reverse. */
  | { type: 'setPoints'; junctionId: string; lie: 'normal' | 'reverse' }
  /** Clear (or put back to danger) a signal. Signals are not on the plan yet. */
  | { type: 'clearSignal'; signalId: string; clear: boolean };

export type RequestResult = { ok: true } | { ok: false; reason: 'unsupported' | 'refused'; text: string };

/** What the router made of an event. */
export type TrainEventOutcome =
  /** The signalling has been told. */
  | 'applied'
  /** Already reported, or no train is waiting for it on that line (arrival reports count once only). */
  | 'ignored'
  /** No line of this box has that connection id. */
  | 'unknownLine'
  /** A later-stage event (stopping), or track circuits with no occupancy board: nothing listens to it yet. */
  | 'notUsed'
  /** Refused: in signaller play mode a movement is reported only once the track circuits show it (or the railway reports it itself). */
  | 'notDetected';

/** Where the signalling learns what trains physically did. */
export interface TrainEventSource {
  /** Hear every event (the router returns what it made of it). Returns a function that stops listening. */
  onEvent(fn: (e: TrainEvent) => TrainEventOutcome | void): () => void;
  /** Ask the railway to do something. Sources that cannot answer 'unsupported'. */
  request(r: TrainRequest): RequestResult;
  /**
   * Report a movement (a person's button, a simulated operator). Sources that work things out for
   * themselves (a simulated railway, detection) may refuse reports, returning null.
   */
  report(e: TrainEvent): TrainEventOutcome | null;
  dispose(): void;
}

/**
 * Model railway mode: movements are reported by the person and by the simulated fiddle yard operator.
 * `report` passes the event to every listener (the router) and returns the router's outcome.
 */
export class ReportedMovements implements TrainEventSource {
  private listeners = new Set<(e: TrainEvent) => TrainEventOutcome | void>();
  private disposed = false;

  /**
   * `gate` (signaller play mode): looks at each report first and may refuse it with an outcome
   * (e.g. 'notDetected' for an arrival the track circuits do not show yet); null lets it through.
   */
  constructor(private gate?: (e: TrainEvent) => TrainEventOutcome | null) {}

  onEvent(fn: (e: TrainEvent) => TrainEventOutcome | void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  report(e: TrainEvent): TrainEventOutcome {
    if (this.disposed) return 'ignored';
    const refused = this.gate?.(e);
    if (refused) return refused;
    let outcome: TrainEventOutcome = 'notUsed';
    for (const fn of [...this.listeners]) {
      const r = fn(e);
      if (r && rank(r) > rank(outcome)) outcome = r;
    }
    return outcome;
  }

  request(r: TrainRequest): RequestResult {
    void r;
    return { ok: false, reason: 'unsupported', text: 'The trains are driven on the layout: the app cannot move them, set points or clear signals.' };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

const rank = (o: TrainEventOutcome) => ({ notUsed: 0, unknownLine: 1, notDetected: 1, ignored: 2, applied: 3 })[o];

/**
 * In signaller play mode, what the simulated railway's track circuits show for a line's train: may the
 * person report it arrived complete / passed complete yet?
 */
export interface Detection {
  arrived(connectionId: string): boolean;
  passed(connectionId: string): boolean;
}

/**
 * The source of train events for a box session in this mode. Model railway mode takes reported
 * movements as they come. Signaller play mode takes the simulated railway's reports (by 'railway'),
 * and lets the person report a train arrived or passed complete only once the track circuits show it
 * (`detection`); the far end and the track circuits are the railway's to report.
 */
export function createTrainSource(mode: RunningMode, detection?: Detection): TrainEventSource {
  if (mode === 'model' || !detection) return new ReportedMovements();
  return new ReportedMovements((e) => {
    if (e.by === 'railway') return null;
    if (e.type === 'arrived') return detection.arrived(e.connectionId) ? null : 'notDetected';
    if (e.type === 'passed') return detection.passed(e.connectionId) || detection.arrived(e.connectionId) ? null : 'notDetected';
    return 'notDetected';
  });
}

/**
 * Applies train events to a box's signalling. The one place where the signalling core is told what
 * trains did. Rules carried over from the buttons (v0.3.26):
 *  - arrival reports count once only (repeats and reports with no train waiting are ignored);
 *  - a train routed on through the box arrives/passes AT THE BOX (no road), and one already sent on
 *    into the section ahead stays where it is (the loco is not moved back to the box);
 *  - any other incoming train goes on the road reported (null = at the box).
 */
export class TrainEventRouter {
  private listeners = new Set<(e: TrainEvent, outcome: TrainEventOutcome) => void>();
  private off: () => void;

  constructor(
    private sessions: SectionSession[],
    private workings: ThroughWorkings | null,
    readonly source: TrainEventSource,
    /** The layout's track occupancy, which track circuit events go on. */
    private board: OccupancyBoard | null = null,
  ) {
    this.off = source.onEvent((e) => this.apply(e));
  }

  /** Hear what happened to each event after it was applied (later stages: occupancy, scoring). */
  onApplied(fn: (e: TrainEvent, outcome: TrainEventOutcome) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.off();
    this.listeners.clear();
  }

  /** Apply one event. Used by the source; exposed for tests. */
  apply(e: TrainEvent): TrainEventOutcome {
    const outcome = this.applyToLine(e);
    for (const fn of [...this.listeners]) fn(e, outcome);
    return outcome;
  }

  private applyToLine(e: TrainEvent): TrainEventOutcome {
    if (e.type === 'stopped') return 'notUsed';
    if (e.type === 'enteredCircuit' || e.type === 'clearedCircuit') {
      if (!this.board) return 'notUsed';
      const who = e.stockId ? `rake:${e.stockId}` : (e.locoId ?? (e.by === 'detection' && e.type === 'clearedCircuit' ? undefined : MARKED));
      if (e.type === 'enteredCircuit') this.board.enter(e.circuitId, who ?? MARKED);
      else this.board.clear(e.circuitId, who);
      return 'applied';
    }
    const s = this.sessions.find((x) => x.connection.id === e.connectionId);
    if (!s) return 'unknownLine';
    const c = s.controller;
    if (e.type === 'arrivedFar') {
      const out = c.view.outgoing;
      if (!out || out.arrived) return 'ignored';
      c.confirmOutgoingArrived(e.roadId, e.locoId);
      return 'applied';
    }
    const inc = c.view.incoming;
    if (!inc || inc.arrived) return 'ignored';
    if (this.workings?.through(e.connectionId)) {
      c.confirmIncomingArrived(null, { moveLoco: !this.workings.keepLocoWhereItIs(e.connectionId) });
    } else {
      c.confirmIncomingArrived(e.type === 'arrived' ? e.at : null);
    }
    return 'applied';
  }
}

/** A box's train events: its running mode, its source and the router into its signalling. */
export interface BoxTrains {
  mode: RunningMode;
  source: TrainEventSource;
  router: TrainEventRouter;
  dispose(): void;
}

/**
 * Wire a box session's signalling to a new source of train events for its running mode. `board`: the
 * layout's occupancy board (track circuit events go on it); `detection`: signaller play mode's
 * simulated railway, which says when a train may be reported arrived or passed.
 */
export function connectTrainEvents(
  mode: RunningMode,
  sessions: SectionSession[],
  workings: ThroughWorkings | null,
  opts: { board?: OccupancyBoard; detection?: Detection } = {},
): BoxTrains {
  const source = createTrainSource(mode, opts.detection);
  const router = new TrainEventRouter(sessions, workings, source, opts.board ?? null);
  return {
    mode,
    source,
    router,
    dispose: () => {
      router.dispose();
      source.dispose();
    },
  };
}
