// Core domain types. Nothing in /core touches the DOM, so it can be reused
// unchanged by a future Android wrapper, a networked peer, or tests.

/** A bell code written as beat groups separated by dashes, e.g. "3-1", "2-2-1", "16". */
export type BellCode = string;

export type InstrumentState = 'LB' | 'LC' | 'TOL'; // Line Blocked / Line Clear / Train On Line
export type WorkingMode = 'ab' | 'token'; // simplified absolute block, or electric key token
export type LineType = 'single' | 'double';
export type Strictness = 'learner' | 'strict';
export type SelectionMode = 'manual' | 'random';
/** Colour theme: follow the device, or one of the Big Four's 1930s liveries. */
export type ThemeId = 'device' | 'gwr' | 'lms' | 'lner' | 'sr';

/** A kind of train, independent of any particular bell code set. */
export interface TrainType {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
}

/** Regulation (non train-description) signal, e.g. Train Entering Section. */
export interface RegulationSignalDef {
  id: string;
  name: string;
  description: string;
  /** True if Call Attention (1) must be sent and acknowledged first. */
  needsCallAttention: boolean;
}

export interface TrainCodeEntry {
  code: BellCode;
  classLabel: string; // e.g. "Class B" or "Class 2"
  note?: string;
  /**
   * Regulating priority of this class of train: higher goes first when two trains are offered at
   * once (class A above class B, and so on). Ties allowed; absent = not judged.
   */
  rank?: number;
}

export interface CodeSet {
  id: string;
  name: string;
  notes: string;
  builtIn: boolean;
  /** Is Line Clear codes, keyed by TrainType.id */
  trainCodes: Record<string, TrainCodeEntry>;
  /** Regulation signals, keyed by RegulationSignalDef.id */
  signals: Record<string, BellCode>;
}

export interface Working {
  trainTypeId: string;
  consist: string; // free text, e.g. "4 coaches", "auto-coach"
  headcode: string; // optional reporting number / lamp code
  /** Length of the whole train in metres, when stated; absent = worked out from the loco and its consist (core/railway.ts). */
  length?: number;
}

/*
 * REAL-RAILWAY DATA (v0.3.27, for signaller play mode): optional lengths and speeds, all with
 * defaults (core/railway.ts), so no save needs them. Stored in SI units: lengths in METRES,
 * speeds in METRES PER SECOND. Shown in the units chosen in Settings (imperial or metric).
 */

/** How lengths and speeds are shown: imperial (miles and chains, yards, mph) or metric (km, m, km/h). */
export type UnitSystem = 'imperial' | 'metric';

/** Where a train stands. */
export type Location =
  /** In a place on a layout (station, sidings, goods yard, depot, fiddle yard…), on one of its roads or ('' ) somewhere in it. */
  | { kind: 'place'; placeId: string; roadId: string }
  /** At a signal box that works no place (e.g. a junction box), or one not on a layout. */
  | { kind: 'atBox'; boxId: string }
  | { kind: 'section'; connectionId: string }
  | { kind: 'offLayout' };

export interface Loco {
  id: string;
  number: string;
  name: string;
  locoClass: string;
  powerType: string; // e.g. "Steam (tender)", "Steam (tank)", "Diesel", "DMU"
  dccAddress: string;
  notes: string;
  working: Working;
  location: Location;
  /** Target timetable jobs: the kinds of work this loco is given in timetables (and by the timetable generator). */
  jobs?: LocoJob[];
  /** Where it stables between jobs ('' or absent = wherever it is). */
  homePlaceId?: string;
  /** Its maximum permitted speed in metres per second; absent = no limit of its own (the line speed rules). */
  maxSpeed?: number;
}

/** The kinds of work a loco is given in timetables (v0.3.26). See core/duties.ts. */
export type DutyId = 'express' | 'stopping' | 'parcels' | 'expressGoods' | 'goods' | 'pickup' | 'pilot' | 'railcar' | 'other';

/**
 * A target timetable job for a loco: a duty (express passenger, express goods, station pilot…)
 * between the places listed (where it shunts, for a pilot). Used to find "any loco for …" in a
 * timetable and by the timetable generator. Light engine moves need no job: any engine makes them.
 */
export interface LocoJob {
  id: string;
  duty: DutyId;
  /** One working within the duty (TrainType id), or '' for any of them (the generator chooses). */
  trainTypeId: string;
  /** Places it runs to and from on this job (or shunts, for a pilot). Empty = anywhere. */
  placeIds: string[];
  /** How often it gets this job: 1 sometimes, 2 often, 3 mostly. */
  weight: 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Timetables (v0.3.24)
// ---------------------------------------------------------------------------
// A timetable belongs to one layout (it names that layout's places and roads). It is a list of
// ENTRIES in order, each one move or action, and each entry belongs to a TRAIN: a chain of moves
// worked by one loco (e.g. ordinary passenger into a terminus platform, then light engine to the
// sidings, light engine back on to its coaches, then ordinary passenger to the fiddle yard).

/**
 * How a timetable runs: an operations SEQUENCE (no times: each move is released when the one before
 * it has finished), REAL time (by the system clock), or a SESSION clock (started when the session
 * starts, optionally from a chosen time and as a fast clock).
 */
export type TimetableTiming = 'sequence' | 'clock' | 'session';

/**
 * run: a signalled move from one place to another (over the lines between boxes);
 * enter: comes on to the layout from off layout (e.g. into a fiddle yard road);
 * leave: goes off the layout (back to storage);
 * shunt: a move (or a change of working where it stands) within a box's area, no block signalling;
 * note: an instruction or reminder, no move.
 */
export type TimetableEntryKind = 'run' | 'enter' | 'leave' | 'shunt' | 'note';

/** A place on a layout and one of its roads ('' = any road, the signaller's choice). */
export interface PlaceRef {
  placeId: string;
  roadId: string;
}

/** A place a run calls at (stops) or passes on its way. Times in minutes on the timetable's clock, or null. */
export interface TimetableCall extends PlaceRef {
  stop: boolean;
  arr: number | null;
  dep: number | null;
}

export interface TimetableEntry {
  id: string;
  /** The train it belongs to ('' for a note that is not about one train). */
  trainId: string;
  kind: TimetableEntryKind;
  /** When the move starts (departs), in minutes on the timetable's clock; null when not timed. */
  dep: number | null;
  /** When it arrives at `to`, in minutes; null when not given. */
  arr: number | null;
  /** Sequence timetables: released together with the entry before it, not after it has finished. */
  withPrevious: boolean;
  /** What the train runs as for this move (TrainType id): sets its description and bell code. */
  trainTypeId: string;
  /** Reporting number, e.g. 2B05 (optional). */
  headcode: string;
  /** Where the move starts (not used by 'enter'). */
  from: PlaceRef;
  /** Where it ends (not used by 'leave'). */
  to: PlaceRef;
  /** Places it calls at or passes on the way (runs only). */
  calls: TimetableCall[];
  notes: string;
}

export interface TimetableTrain {
  id: string;
  /** e.g. "Train 3", or a name such as "The Mid-day Scot". */
  name: string;
  /** The roster loco that works it; '' = any loco with the duty for `anyWorking`, chosen when it runs. */
  locoId: string;
  anyWorking: string;
  /** e.g. "4 coaches". */
  consist: string;
  notes: string;
}

export interface Timetable {
  id: string;
  name: string;
  timing: TimetableTiming;
  /** Session clock: the time shown when the session starts (minutes after midnight). */
  startAt: number;
  /** Session clock: show times as minutes after the start (+0:05) instead of clock times. */
  elapsed: boolean;
  /** Session clock speed: 1 = real time, 2–12 = a fast clock. */
  speed: number;
  /** Line under the poster's title, e.g. "Weekdays" or "Gala weekend". */
  validity: string;
  notes: string;
  trains: TimetableTrain[];
  entries: TimetableEntry[];
  /** Set when the timetable was made by the generator: what it was asked for, so it can be generated again. */
  generated?: GeneratorOptions;
}

/** How busy a generated timetable is: the usual gap between trains. */
export type Busyness = 'quiet' | 'steady' | 'busy';

/** What the timetable generator is asked for (v0.3.26). */
export interface GeneratorOptions {
  timing: TimetableTiming;
  /** Session clock start (minutes after midnight); real time: the first train (minutes after midnight). */
  startAt: number;
  speed: number;
  /** How long: a number of moves (operations sequence), or minutes of timetable (timed). */
  length: number;
  busyness: Busyness;
  /** Locos taking part; [] = every loco on the layout with timetable jobs. */
  locoIds: string[];
  /** Traffic mix, on top of each loco's own how-often: 0 none, 1 a little, 2 normal, 3 lots. */
  mix: { passenger: number; goods: number; shunting: number };
  seed: number;
}

/*
 * PLACES: everywhere on a layout that trains stand or are worked: stations, sidings, goods
 * yards and sheds, loco depots and fiddle yards. A place belongs to one layout; it can be worked
 * by several signal boxes (e.g. York North and York South), and a box may work no place at all
 * (a junction box). Each place has roads (platforms, siding roads, shed roads, yard roads),
 * which may be tied to a track circuit on the layout's track plan.
 */
export type PlaceKind = 'station' | 'sidings' | 'goods' | 'depot' | 'fiddleYard' | 'other';

export interface PlaceRoad {
  id: string;
  /** e.g. "P1", "Bay", "Coal road", "Road 3". */
  name: string;
  notes: string;
  /** The track circuit this road is on the track plan, if tied to one. */
  circuitId?: string;
}

/** A signal box that works a place: one you work, or the far (simulated) box of one of its connections. */
export type PlaceWorker = { kind: 'box'; boxId: string } | { kind: 'remote'; boxId: string; connectionId: string };

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  /** Optional short name for tight spaces (e.g. "BEC"). */
  shortName: string;
  notes: string;
  roads: PlaceRoad[];
  workedBy: PlaceWorker[];
}

/** A fiddle yard is a place of kind 'fiddleYard'. */
export type FiddleYard = Place;
export type FiddleYardRoad = PlaceRoad;

export interface ConnectionDef {
  id: string;
  /** Name of the box at the other end (simulated). */
  neighbourName: string;
  /** Short name used in logs, e.g. "FY". */
  neighbourShort: string;
  lineType: LineType;
  /**
   * The place trains run to and come from over this line: a fiddle yard, or a place on the layout
   * worked by the far box. '' = none: trains come from, and go back to, the roster (off the layout).
   */
  placeId: string;
  defaultWorking: WorkingMode;
  /** Where this connection's instrument group sits on the block shelf (0 = leftmost). */
  shelfPosition: number;
  /** Length of the block section in metres; absent = the default (2 miles). Its line's track circuits share it. */
  sectionLength?: number;
}

export interface BoxDef {
  id: string;
  name: string;
  /** The layout this box stands on, or '' when it is not on a layout yet. A box is on one layout at most. */
  layoutId: string;
  shortName: string;
  description: string;
  /** Number of positions on this box's block shelf, left to right. */
  shelfPositions: number;
  connections: ConnectionDef[];
}

export interface TapSettings {
  /** Silence between beats longer than this starts a new group (ms). */
  groupGapMs: number;
  /** Silence after the last beat longer than this ends the code (ms). */
  codeEndMs: number;
  /** A last beat held at least this long counts as "holding the last beat" (ms). */
  holdMs: number;
}

export interface Settings {
  /** The layout being worked: its boxes are the ones offered under Open a signal box. '' when none is chosen. */
  activeLayoutId: string;
  theme: ThemeId;
  strictness: Strictness;
  codeSetId: string;
  workingModes: Record<string, WorkingMode>; // keyed by ConnectionDef.id
  selectionMode: SelectionMode;
  tap: TapSettings;
  volume: number; // 0..1
  tapperClick: boolean;
  vibrate: boolean;
  showReceivedCodeText: boolean;
  /** Simulated signaller reaction time range (ms). */
  responseDelayMs: [number, number];
  /** Delay between line clear and the simulated box despatching the train (ms). */
  despatchDelayMs: [number, number];
  /** How long the simulated box waits for a reply before repeating (ms). */
  repeatAfterMs: number;
  /** An offer (Is line clear) not repeated within this time after it has rung counts as refused (ms). */
  offerRefusedAfterMs: number;
  /** How long the simulated box holds a refused train before offering it again (ms). */
  reofferAfterMs: number;
  /** When a train is offered on one line, another line may offer one at about the same time (practice in regulating). */
  coincidingOffers: boolean;
  /** Beat spacing when bells are played (ms). */
  bellBeatMs: number;
  bellGroupPauseMs: number;
  /** User supplied bell sound as a data: URL, or '' to use the built-in recording. */
  bellSoundDataUrl: string;
  /** Use the synthesised bell instead of a recording. */
  bellSynth: boolean;
  /** Score the signaller as trains are worked (have-a-go sessions at shows). */
  scoring: boolean;
  /** Show the layout's track plan as a diagram board above the block shelf. */
  boxDiagram: boolean;
  /** How lengths and speeds are shown (they are stored in metres and metres per second). */
  units: UnitSystem;
  /** Signaller play mode: the speed every simulated train runs at (metres per second), never above line speed or the loco's maximum. */
  simSpeed: number;
  /** Signaller play mode: simulated time runs this many times faster than real time (1–10), for shows. */
  timeScale: number;
  /** Model railway mode: show track occupancy on the diagram board (from what you report, and circuits you tap). */
  modelOccupancy: boolean;
  /** What the diagram board labels its track circuits with. */
  diagramLabels: 'none' | 'codes' | 'names';
  /** Show set routes (lit up along the track) on the box's diagram board, in signaller play mode. */
  showRoutes: boolean;
}

// ---------------------------------------------------------------------------
// Track plan (layout configurator)
// ---------------------------------------------------------------------------
// The plan is a graph: track circuits are the edges, junctions (points, slips,
// crossings, plain joints) are the nodes. A circuit has no length or capacity.
// Positions are in grid units and are only used to draw the plan.
// Live state (which circuits are occupied, which way points lie) is NOT part
// of the plan: it belongs to a future "layout-free" runtime.

export type JunctionKind =
  | 'joint'
  | 'pointsRight'
  | 'pointsLeft'
  | 'pointsY'
  | 'threeWay'
  | 'diamond'
  | 'singleSlip'
  | 'doubleSlip'
  | 'scissors'
  | 'catchPoints'
  | 'turntable';

/**
 * Who a track circuit belongs to: a signal box you work, the line between two boxes (a block section),
 * the box at the far end of a connection (worked by the simulated signaller, e.g. sidings it controls), or nobody yet.
 */
export type TrackOwner =
  | { kind: 'none' }
  | { kind: 'box'; boxId: string }
  | { kind: 'line'; boxId: string; connectionId: string }
  | { kind: 'remote'; boxId: string; connectionId: string };

/** A signal box drawn on the plan: one you work, or the far box of one of its connections. */
export type MarkerBox = { kind: 'box'; boxId: string } | { kind: 'remote'; boxId: string; connectionId: string };

/** Where a signal box stands on the plan. */
export interface BoxMarker {
  id: string;
  box: MarkerBox;
  /** Position when not attached to a track circuit (grid units). */
  x: number;
  y: number;
  /** The track circuit it stands beside, or ''. When attached it follows that track. */
  circuitId: string;
  /** Offset from the middle of the attached track circuit (grid units). */
  dx: number;
  dy: number;
}

/** Where a track that leaves the scene goes. */
export type ExitTarget =
  | { kind: 'offScene' }
  | { kind: 'place'; placeId: string }
  | { kind: 'connection'; boxId: string; connectionId: string };

export type CircuitEnd =
  /** Not finished yet. */
  | { kind: 'open'; x: number; y: number }
  /** The track terminates here (bay, terminus road, siding). */
  | { kind: 'bufferStops'; x: number; y: number }
  /** The track continues off the scene. */
  | { kind: 'exit'; x: number; y: number; to: ExitTarget }
  /** The track continues through a junction. */
  | { kind: 'joined'; junctionId: string; port: string };

export interface TrackCircuit {
  id: string;
  /** Short code shown on the diagram, e.g. "T3". Unique in the plan. */
  code: string;
  name: string;
  owner: TrackOwner;
  ends: [CircuitEnd, CircuitEnd];
  /** Bend points between the ends, in order (grid units). Drawn with rounded corners: curves. */
  via?: Array<{ x: number; y: number }>;
  /**
   * Set when this track is a platform road: its platform number (e.g. "1", "2", "3 bay") and which
   * side the platform face is on (the same sides as Lay a parallel track). Used later by the box to
   * say where an arriving train stands.
   */
  platform?: { number: string; side: 1 | -1 };
  /**
   * Traffic on this track: which running line it is part of and the way trains run along it
   * (towards end 0 or end 1). Absent = both ways (single lines, sidings, loops worked both ways).
   */
  traffic?: { line: RunningLine; toward: 0 | 1 };
  /** Its length in metres, when stated; absent = worked out (core/railway.ts circuitLength). */
  length?: number;
  /** Its line speed in metres per second, when it differs from the layout's. */
  lineSpeed?: number;
}

export interface Junction {
  id: string;
  /** Number shown on the diagram, e.g. the lever number. */
  number: string;
  kind: JunctionKind;
  /** The signal box that works it, or '' if not assigned yet. */
  boxId: string;
  /** Set when the far box of this connection (of box `boxId`) works it instead: the simulated signaller. */
  connectionId?: string;
  x: number;
  y: number;
  /** Turned round (rotated half a turn): the toe faces right instead of left. Keeps its hand. */
  rotate: boolean;
  /** Mirrored top to bottom. Only crossings, slips, scissors and catch points use it; points change hand instead. */
  mirror: boolean;
  /** An extra quarter turn clockwise, for junctions on tracks that run up and down the plan. */
  quarter?: boolean;
  /** Turntables only: which of the eight roads round the deck are in use. */
  roads?: string[];
  /** v0.3.6 saves only: a left-right mirror. Converted to rotate + mirror when loaded. */
  flip?: boolean;
  /** Points: speed over the diverging road in metres per second; absent = the default (15 mph). */
  divergingSpeed?: number;
  /**
   * Points: whether they have a facing point lock (FPL). Absent = worked out (points that are facing
   * for a running move between running roads); 'fpl' / 'none' = set by hand.
   */
  lock?: 'fpl' | 'none';
  /** The lever number of its facing point lock, once the levers have been numbered ('' or absent = none). */
  fplNumber?: string;
}

// ---------------------------------------------------------------------------
// Signals (v0.3.29)
// ---------------------------------------------------------------------------

/**
 * home / starter: stop signals for running moves (a starter at the line is the section signal);
 * distant: caution signal, repeats the stop signals ahead; shunt: ground signal (disc or position
 * light) for shunting; shuntYellow: yellow ground signal, which may be passed at danger for a move it
 * does not apply to (e.g. into a headshunt); shuntAhead: a shunt-ahead arm or light on a starter's post,
 * to shunt past it into the section; limitOfShunt: a board or two red lights where shunting must stop.
 */
export type SignalKind = 'home' | 'starter' | 'distant' | 'shunt' | 'shuntYellow' | 'shuntAhead' | 'limitOfShunt';
/** Semaphore (arms and discs, boards) or electric colour light (lamps and position lights). */
export type SignalStyle = 'semaphore' | 'colourLight';

/**
 * A signal on the track plan. It stands beside a track circuit, `back` metres before the circuit's
 * end `end`, and applies to trains running towards that end. Its routes are worked out from the plan
 * (core/signals.ts); several signals at one place (arms on a bracket) share the routes between them.
 */
export interface PlanSignal {
  id: string;
  kind: SignalKind;
  style: SignalStyle;
  /** Lever number in its box's frame, e.g. "2" ('' = not numbered; limits of shunt have no lever). */
  number: string;
  /** e.g. "Down Home to P1". */
  name: string;
  /** The box whose frame works it. */
  boxId: string;
  circuitId: string;
  end: 0 | 1;
  /** Metres before the end of the circuit (0 = at the end). */
  back: number;
  /**
   * The routes it reads to (route keys, see core/signals.ts). Absent = every route from its place not
   * read by another signal there, so new track is picked up by itself.
   */
  reads?: string[];
  /** Placed or changed by hand: kept when signals are generated again. */
  manual: boolean;
}

/** How signals are generated for a layout (remembered for the next time). */
/**
 * Adjustments to the generated interlocking (v0.3.31). Keys of `routes` are "<signal id>|<route
 * key>" (the route's key from core/signals.ts), each mapping a junction to the way it must lie, or
 * 'free' (not locked by that route). Locks are pairs of signal ids.
 */
export interface InterlockingOverrides {
  routes?: Record<string, Record<string, 'normal' | 'reverse' | 'free'>>;
  extraLocks?: Array<[string, string]>;
  removedLocks?: Array<[string, string]>;
}

export interface SignallingOptions {
  style: SignalStyle | 'mixed';
  /** Ground signals for shunting moves (exits from sidings and goods yards, setting back). */
  shunt: boolean;
  /** Shunt-ahead arms on section signals, with a limit of shunt on the line beyond. */
  shuntAhead: boolean;
}

export interface TrackPlan {
  circuits: TrackCircuit[];
  junctions: Junction[];
  /** Signal boxes placed on the plan. */
  markers?: BoxMarker[];
  /** Signals (v0.3.29). */
  signals?: PlanSignal[];
  /** How signals were last generated. */
  signalling?: SignallingOptions;
  interlocking?: InterlockingOverrides;
}

/** A running line on double track: the up line or the down line. */
export type RunningLine = 'up' | 'down';

/** Which side of a double line trains keep to: left-hand running (British practice) or right-hand. */
export type RunningSide = 'left' | 'right';

/** One model railway: its name, fiddle yards and track plan. Boxes join a layout through BoxDef.layoutId. */
export interface Layout {
  id: string;
  name: string;
  /** Stations, sidings, goods yards, depots and fiddle yards on this layout. */
  places: Place[];
  /** Drawn in the layout configurator. Empty until the user builds one. */
  trackPlan: TrackPlan;
  /** Which side of a double line trains keep to (default left, as in Britain). */
  running?: RunningSide;
  /** Timetables for this layout (v0.3.24; filled in when loading older saves). */
  timetables?: Timetable[];
  /** How its trains show what they are (v0.3.26): lamp headcodes and reporting numbers, or 1960 headcodes. Absent = 'br1960'. */
  headcodeEra?: HeadcodeEra;
  /** Line speed in metres per second for its track (circuits may differ); absent = the default (60 mph). */
  lineSpeed?: number;
  /** Rolling stock standing on its own (uncoupled from a loco): rakes left in roads (signaller play mode, v0.3.28). */
  stock?: StockRake[];
}

/** One kind of vehicle in a rake: e.g. 4 × coach (20 m each). Kept as a list so numbered stock can be added later. */
export interface StockVehicles {
  kind: string;
  count: number;
  /** Length of each vehicle over buffers, in metres. */
  metres: number;
}

/**
 * An anonymous rake of rolling stock (coaches, wagons, vans) standing without a loco, e.g. the
 * coaches of a terminating train left in the platform while its engine runs round. It keeps the
 * track circuit it stands on occupied until a loco takes it away.
 */
export interface StockRake {
  id: string;
  /** What it is, as written in the consist it came from, e.g. "4 coaches". */
  description: string;
  vehicles: StockVehicles[];
  /** Where it stands: a road of a place (and the track circuit the road is on). */
  placeId: string;
  roadId: string;
  circuitId: string;
}

/** grouping: lamp codes 1923–47 + reporting number; brLamps: BR lamp codes 1948–60 + reporting number; br1960: four-character headcodes. */
export type HeadcodeEra = 'grouping' | 'brLamps' | 'br1960';

export interface AppState {
  schemaVersion: number;
  settings: Settings;
  trainTypes: TrainType[];
  codeSets: CodeSet[];
  roster: Loco[];
  boxes: BoxDef[];
  /** The model railways set up in this app. The roster is shared by all of them. */
  layouts: Layout[];
}
