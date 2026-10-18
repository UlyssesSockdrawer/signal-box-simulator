import type { BellCode, CodeSet, RegulationSignalDef, TrainType } from './types';

// ---------------------------------------------------------------------------
// Code helpers
// ---------------------------------------------------------------------------

/** Normalise user text such as "3 1", "3-1 ", "3–1" into "3-1". Returns '' if invalid. */
export function normaliseCode(text: string): BellCode {
  const groups = text
    .trim()
    .split(/[\s\-–—,.]+/)
    .filter(Boolean)
    .map((g) => Number(g));
  if (groups.length === 0 || groups.some((g) => !Number.isInteger(g) || g < 1 || g > 30)) return '';
  return groups.join('-');
}

export function codeToGroups(code: BellCode): number[] {
  return code.split('-').map((g) => Number(g));
}

export function totalBeats(code: BellCode): number {
  return codeToGroups(code).reduce((a, b) => a + b, 0);
}

/** Rough time a code takes to ring out, used to space the simulated signaller's replies. */
export function ringDurationMs(code: BellCode, beatMs: number, groupPauseMs: number): number {
  const groups = codeToGroups(code);
  const beats = groups.reduce((a, b) => a + b, 0);
  return beats * beatMs + (groups.length - 1) * groupPauseMs;
}

// ---------------------------------------------------------------------------
// Train types (independent of code set)
// ---------------------------------------------------------------------------

export const DEFAULT_TRAIN_TYPES: TrainType[] = [
  { id: 'express_passenger', name: 'Express passenger', description: 'Express passenger train, newspaper train, or breakdown train going to clear the line.', builtIn: true },
  { id: 'ordinary_passenger', name: 'Ordinary passenger', description: 'Ordinary (stopping) passenger train or mixed train.', builtIn: true },
  { id: 'branch_passenger', name: 'Branch passenger', description: 'Branch passenger train (where authorised by local instructions).', builtIn: true },
  { id: 'railcar', name: 'Railcar / railbus', description: 'Single unit diesel railcar or railbus (where authorised).', builtIn: true },
  { id: 'parcels', name: 'Parcels / perishables', description: 'Parcels, fish, fruit, milk, livestock or other perishable train made up of coaching stock.', builtIn: true },
  { id: 'ecs', name: 'Empty coaching stock', description: 'Empty coaching stock train.', builtIn: true },
  { id: 'freight_fitted_half', name: 'Express freight (½ fitted)', description: 'Express freight, livestock, perishable or ballast train with the automatic brake working on at least half the vehicles.', builtIn: true },
  { id: 'freight_fitted_third', name: 'Express freight (⅓ fitted)', description: 'Express freight, livestock, perishable or ballast train with the automatic brake working on at least one third of the vehicles.', builtIn: true },
  { id: 'freight_fitted_four', name: 'Express freight (4 braked vehicles)', description: 'Express freight with at least four vacuum braked vehicles connected to the engine.', builtIn: true },
  { id: 'freight_unfitted', name: 'Express freight (unfitted)', description: 'Express freight, livestock, perishable or ballast train not fitted with a continuous brake.', builtIn: true },
  { id: 'through_freight', name: 'Through freight', description: 'Through freight or ballast train.', builtIn: true },
  { id: 'mineral', name: 'Mineral / empties', description: 'Mineral or empty wagon train.', builtIn: true },
  { id: 'pickup_goods', name: 'Pick-up goods', description: 'Freight, mineral or ballast train stopping at intermediate stations.', builtIn: true },
  { id: 'branch_freight', name: 'Branch freight', description: 'Branch freight train (where authorised).', builtIn: true },
  { id: 'light_engine', name: 'Light engine', description: 'Light engine, or light engines coupled together.', builtIn: true },
  { id: 'engine_brake_van', name: 'Engine and brake van', description: 'Engine with not more than two brake vans.', builtIn: true },
];

// ---------------------------------------------------------------------------
// Regulation signals
// ---------------------------------------------------------------------------

export const REGULATION_SIGNALS: RegulationSignalDef[] = [
  { id: 'call_attention', name: 'Call attention', description: 'Sent before most signals so the other signaller is ready to receive. Acknowledged by repeating 1 beat.', needsCallAttention: false },
  { id: 'train_entering_section', name: 'Train entering section', description: 'Sent as the train passes (or leaves) the box in rear, once line clear has been obtained. Sent WITHOUT call attention. Acknowledged by repeating it; the box in advance then turns its instrument to Train On Line.', needsCallAttention: false },
  { id: 'train_out_of_section', name: 'Train out of section', description: 'Sent by the box in advance once the train has arrived complete with its tail lamp (and, in token working, the token has been replaced). Also used for "obstruction removed". The box in advance returns its instrument to Line Blocked.', needsCallAttention: true },
  { id: 'cancelling', name: 'Cancelling', description: 'Cancels an "Is line clear" that has been accepted, when the train will not now run. In token working the token must be replaced first.', needsCallAttention: true },
  { id: 'incorrectly_described', name: 'Last train signalled incorrectly described', description: 'The last train was offered with the wrong description. Followed by the correct Is line clear signal.', needsCallAttention: true },
  { id: 'obstruction_danger', name: 'Obstruction danger', description: 'Emergency: stop all trains. Sent WITHOUT call attention.', needsCallAttention: false },
  { id: 'stop_and_examine', name: 'Stop and examine train', description: 'Something seems wrong with a train in the section; stop it and examine it.', needsCallAttention: true },
  { id: 'tail_lamp_to_advance', name: 'Train passed without tail lamp (to box in advance)', description: 'The train sent to you passed without a tail lamp: it may be divided.', needsCallAttention: true },
  { id: 'tail_lamp_to_rear', name: 'Train passed without tail lamp (to box in rear)', description: 'The train received from you arrived without a tail lamp.', needsCallAttention: true },
  { id: 'train_divided', name: 'Train divided', description: 'The train has become divided.', needsCallAttention: true },
  { id: 'long_time_in_section', name: 'Train an unusually long time in section', description: 'A train has not arrived in a reasonable time.', needsCallAttention: true },
  { id: 'blocking_back', name: 'Blocking back', description: 'The line is blocked for shunting at the box sending it.', needsCallAttention: true },
  { id: 'token_replaced', name: 'Train withdrawn / token replaced', description: 'On single lines: a shunting token has been replaced and the line is clear again.', needsCallAttention: true },
  { id: 'release_token', name: 'Release token for shunting', description: 'Single line: request a token to allow a shunt into the section.', needsCallAttention: true },
  { id: 'runaway_wrong', name: 'Vehicles running away (wrong direction / single line)', description: 'Emergency: vehicles running away towards you.', needsCallAttention: false },
  { id: 'runaway_right', name: 'Vehicles running away (right direction)', description: 'Emergency: vehicles running away in the proper direction.', needsCallAttention: false },
  { id: 'opening', name: 'Opening of signal box', description: 'The box is opening; acknowledged by repeating.', needsCallAttention: true },
  { id: 'closing', name: 'Closing of signal box', description: 'The box is closing; acknowledged by repeating.', needsCallAttention: true },
  { id: 'closing_locked', name: 'Closing (section signal locked by block)', description: 'Closing of signal box where the section signal is locked by the block.', needsCallAttention: true },
  { id: 'testing', name: 'Testing bells and instruments', description: 'Testing. Acknowledged by repeating.', needsCallAttention: true },
];

const COMMON_SIGNALS: Record<string, BellCode> = {
  call_attention: '1',
  train_entering_section: '2',
  train_out_of_section: '2-1',
  cancelling: '3-5',
  incorrectly_described: '5-3',
  obstruction_danger: '6',
  stop_and_examine: '7',
  tail_lamp_to_advance: '9',
  tail_lamp_to_rear: '4-5',
  train_divided: '5-5',
  long_time_in_section: '6-2',
  blocking_back: '3-3',
  token_replaced: '2-5',
  release_token: '5-2',
  runaway_wrong: '2-5-5',
  runaway_right: '4-5-5',
  opening: '5-5-5',
  closing: '7-5-5',
  closing_locked: '5-5-7',
  testing: '16',
};

// ---------------------------------------------------------------------------
// Built-in code sets
// ---------------------------------------------------------------------------

/**
 * British Railways standard codes as in the Regulations for Train Signalling
 * of 1960 (lettered train classes A–K). Regional variations existed; check
 * against your own railway's appendix and edit as needed.
 */
export const BR_1960: CodeSet = {
  id: 'br1960',
  name: 'BR 1960 (steam era, classes A–K)',
  notes:
    'British Railways standard bell signals from the 1960 Regulations for Train Signalling. Regions (especially the Southern) had local variations, so edit to match your own railway.',
  builtIn: true,
  trainCodes: {
    express_passenger: { code: '4', classLabel: 'Class A' },
    ordinary_passenger: { code: '3-1', classLabel: 'Class B' },
    branch_passenger: { code: '1-3', classLabel: 'Class B', note: 'Where authorised' },
    railcar: { code: '3-1-3', classLabel: 'Class B', note: 'Where authorised' },
    parcels: { code: '1-3-1', classLabel: 'Class C' },
    ecs: { code: '2-2-1', classLabel: 'Class C' },
    freight_fitted_half: { code: '3-1-1', classLabel: 'Class C' },
    freight_fitted_third: { code: '5', classLabel: 'Class D' },
    freight_fitted_four: { code: '1-2-2', classLabel: 'Class E' },
    freight_unfitted: { code: '3-2', classLabel: 'Class F' },
    light_engine: { code: '2-3', classLabel: 'Class G' },
    engine_brake_van: { code: '1-1-3', classLabel: 'Class G' },
    through_freight: { code: '1-4', classLabel: 'Class H' },
    mineral: { code: '4-1', classLabel: 'Class J' },
    pickup_goods: { code: '3', classLabel: 'Class K' },
    branch_freight: { code: '1-2', classLabel: 'Class K', note: 'Where authorised' },
  },
  signals: { ...COMMON_SIGNALS },
};

/** Later BR / Rule Book codes (numbered classes 0–9). */
export const BR_MODERN: CodeSet = {
  id: 'brmodern',
  name: 'BR / Rule Book (numbered classes 0–9)',
  notes:
    'Later BR and Rule Book bell signals using the numbered train classes. Some descriptions (branch, pick-up goods) no longer exist and are mapped to the nearest current class.',
  builtIn: true,
  trainCodes: {
    express_passenger: { code: '4', classLabel: 'Class 1' },
    ordinary_passenger: { code: '3-1', classLabel: 'Class 2' },
    branch_passenger: { code: '3-1', classLabel: 'Class 2' },
    railcar: { code: '3-1', classLabel: 'Class 2' },
    parcels: { code: '1-3-1', classLabel: 'Class 3' },
    ecs: { code: '2-2-1', classLabel: 'Class 5' },
    freight_fitted_half: { code: '3-1-1', classLabel: 'Class 4' },
    freight_fitted_third: { code: '5', classLabel: 'Class 6' },
    freight_fitted_four: { code: '4-1', classLabel: 'Class 7' },
    freight_unfitted: { code: '3-2', classLabel: 'Class 8' },
    light_engine: { code: '2-3', classLabel: 'Class 0' },
    engine_brake_van: { code: '2-3', classLabel: 'Class 0' },
    through_freight: { code: '3-2', classLabel: 'Class 8' },
    mineral: { code: '4-1', classLabel: 'Class 7' },
    pickup_goods: { code: '3-2', classLabel: 'Class 8' },
    branch_freight: { code: '3-2', classLabel: 'Class 8' },
  },
  signals: { ...COMMON_SIGNALS },
};

export const DEFAULT_CODE_SETS: CodeSet[] = [BR_1960, BR_MODERN];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export interface CodeMeaning {
  kind: 'train' | 'signal';
  id: string;
  name: string;
  description: string;
}

/** Everything a received code could mean in a code set (several train types can share one code). */
export function meaningsOf(code: BellCode, set: CodeSet, trainTypes: TrainType[]): CodeMeaning[] {
  const out: CodeMeaning[] = [];
  for (const sig of REGULATION_SIGNALS) {
    if (set.signals[sig.id] === code) out.push({ kind: 'signal', id: sig.id, name: sig.name, description: sig.description });
  }
  for (const tt of trainTypes) {
    const e = set.trainCodes[tt.id];
    if (e && e.code === code) {
      out.push({ kind: 'train', id: tt.id, name: `Is line clear for ${tt.name.toLowerCase()} (${e.classLabel})`, description: tt.description });
    }
  }
  return out;
}

export function isTrainDescription(code: BellCode, set: CodeSet): boolean {
  return Object.values(set.trainCodes).some((e) => e.code === code);
}

export function trainCode(set: CodeSet, trainTypeId: string): BellCode {
  return set.trainCodes[trainTypeId]?.code ?? '';
}

export function signalCode(set: CodeSet, signalId: string): BellCode {
  return set.signals[signalId] ?? COMMON_SIGNALS[signalId] ?? '';
}

export function describeCode(code: BellCode, set: CodeSet, trainTypes: TrainType[]): string {
  const m = meaningsOf(code, set, trainTypes);
  if (m.length === 0) return 'Unrecognised code';
  return m.map((x) => x.name).join(' / ');
}
