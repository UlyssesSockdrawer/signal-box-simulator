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
}

export type Location =
  | { kind: 'fiddleYard'; yardId: string; roadId: string }
  | { kind: 'station'; boxId: string; note: string }
  | { kind: 'section'; connectionId: string }
  /**
   * The location on the layout served by the far box of a connection that has no fiddle yard
   * (e.g. another station scene). A stand-in until the layout configurator defines locations.
   */
  | { kind: 'farBox'; boxId: string; connectionId: string; note: string }
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
}

export interface FiddleYardRoad {
  id: string;
  name: string;
  notes: string;
}

export interface FiddleYard {
  id: string;
  name: string;
  roads: FiddleYardRoad[];
}

export interface ConnectionDef {
  id: string;
  /** Name of the box at the other end (simulated). */
  neighbourName: string;
  /** Short name used in logs, e.g. "FY". */
  neighbourShort: string;
  lineType: LineType;
  /** Fiddle yard at the far end, or '' when the far box serves a location on the layout instead. */
  fiddleYardId: string;
  defaultWorking: WorkingMode;
  /** Where this connection's instrument group sits on the block shelf (0 = leftmost). */
  shelfPosition: number;
}

export interface BoxDef {
  id: string;
  name: string;
  /** The layout this box stands on, or '' when it is not on a layout yet. A box is on one layout at most. */
  layoutId: string;
  shortName: string;
  description: string;
  /** Free-text notes about station roads/platforms (informational only). */
  stationNotes: string;
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
  /** Beat spacing when bells are played (ms). */
  bellBeatMs: number;
  bellGroupPauseMs: number;
  /** User supplied bell sound as a data: URL, or '' to use the built-in recording. */
  bellSoundDataUrl: string;
  /** Use the synthesised bell instead of a recording. */
  bellSynth: boolean;
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
  | { kind: 'fiddleYard'; yardId: string }
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
}

export interface TrackPlan {
  circuits: TrackCircuit[];
  junctions: Junction[];
  /** Signal boxes placed on the plan. */
  markers?: BoxMarker[];
}

/** A running line on double track: the up line or the down line. */
export type RunningLine = 'up' | 'down';

/** Which side of a double line trains keep to: left-hand running (British practice) or right-hand. */
export type RunningSide = 'left' | 'right';

/** One model railway: its name, fiddle yards and track plan. Boxes join a layout through BoxDef.layoutId. */
export interface Layout {
  id: string;
  name: string;
  fiddleYards: FiddleYard[];
  /** Drawn in the layout configurator. Empty until the user builds one. */
  trackPlan: TrackPlan;
  /** Which side of a double line trains keep to (default left, as in Britain). */
  running?: RunningSide;
}

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
