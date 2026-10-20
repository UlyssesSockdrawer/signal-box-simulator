// LOCO DUTIES (v0.3.26): what a loco is given to do in timetables, by kind of work rather than by
// every kind of train. A duty covers several workings (Express goods covers all the fitted and
// express freights); a job can be pinned to one of them, or left to "any", and the generator picks
// a suitable one. Light engine and engine-and-brake-van moves are not duties: any engine makes them
// (positioning, going home, fetching a goods train). Railcars (DMUs) are special: they work railcar
// services only, run empty instead of light, and change ends at a terminus instead of running round.

import type { AppState, DutyId, Loco, LocoJob, TrainType } from './types';

export type { DutyId };
export type MixCategory = 'passenger' | 'goods' | 'shunting';

export interface DutyInfo {
  id: DutyId;
  name: string;
  help: string;
  /** The workings (built-in train types) it covers, in order of how usual they are. */
  types: string[];
  /** How likely each of `types` is when the job says "any" (same order). */
  odds: number[];
  category: MixCategory;
}

export const DUTIES: DutyInfo[] = [
  { id: 'express', name: 'Express passenger', help: 'Express passenger trains.', types: ['express_passenger'], odds: [1], category: 'passenger' },
  { id: 'stopping', name: 'Stopping passenger', help: 'Ordinary (stopping) and branch passenger trains.', types: ['ordinary_passenger', 'branch_passenger'], odds: [1, 0], category: 'passenger' },
  { id: 'parcels', name: 'Parcels and empty stock', help: 'Parcels, milk and perishables made up of coaching stock, and empty coaching stock.', types: ['parcels', 'ecs'], odds: [3, 2], category: 'passenger' },
  { id: 'expressGoods', name: 'Express goods', help: 'Fitted and express freights.', types: ['freight_fitted_half', 'freight_fitted_third', 'freight_fitted_four', 'freight_unfitted'], odds: [4, 3, 2, 2], category: 'goods' },
  { id: 'goods', name: 'Through goods and mineral', help: 'Through freights, coal and other mineral trains (and their empties).', types: ['through_freight', 'mineral'], odds: [1, 1], category: 'goods' },
  { id: 'pickup', name: 'Pick-up and branch goods', help: 'Goods trains that call to pick up and set down wagons.', types: ['pickup_goods', 'branch_freight'], odds: [1, 0], category: 'goods' },
  { id: 'pilot', name: 'Station pilot / shunter', help: 'Shunts the places ticked (as a light engine).', types: [], odds: [], category: 'shunting' },
  { id: 'railcar', name: 'Railcar service', help: 'Diesel railcar or railbus services. Railcars run empty rather than light and change ends instead of running round.', types: ['railcar'], odds: [1], category: 'passenger' },
  { id: 'other', name: 'Other trains', help: 'Kinds of train you have added yourself.', types: [], odds: [], category: 'passenger' },
];

export const dutyInfo = (id: DutyId): DutyInfo => DUTIES.find((d) => d.id === id) ?? DUTIES[0];

/** Workings any engine makes, needing no duty. */
export const ANY_ENGINE = new Set(['light_engine', 'engine_brake_van']);

/** The workings a duty covers, with the user's own kinds of train under Other. */
export function dutyTypes(state: AppState, id: DutyId): string[] {
  if (id === 'other') return state.trainTypes.filter((t) => !t.builtIn).map((t) => t.id);
  return dutyInfo(id).types;
}

/** The duty a working belongs to (null for light engines, engine and brake van, and unknown kinds). */
export function dutyOf(state: AppState, trainTypeId: string): DutyId | null {
  if (ANY_ENGINE.has(trainTypeId)) return null;
  const d = DUTIES.find((x) => x.types.includes(trainTypeId));
  if (d) return d.id;
  return state.trainTypes.some((t) => t.id === trainTypeId && !t.builtIn) ? 'other' : null;
}

/** Mix category of a job (for the generator's traffic mix). Other trains count as goods if they say so. */
export function jobCategory(state: AppState | null, j: Pick<LocoJob, 'duty' | 'trainTypeId'>): MixCategory {
  if (j.duty === 'other' && state) {
    const t: TrainType | undefined = state.trainTypes.find((x) => x.id === j.trainTypeId);
    return t && /goods|freight|mineral|coal/i.test(t.name) ? 'goods' : 'passenger';
  }
  return dutyInfo(j.duty).category;
}

/** A railcar or DMU: it works railcar services only and never runs as a light engine. */
export function isRailcar(l: Loco): boolean {
  return /dmu|railcar|railbus/i.test(l.powerType) || l.working.trainTypeId === 'railcar' || !!l.jobs?.some((j) => j.duty === 'railcar');
}

/** How a loco moves without its train: light engine, or (a railcar) empty. */
export function runsLight(l: Loco | undefined): string {
  return l && isRailcar(l) ? 'ecs' : 'light_engine';
}

/** Duties a loco can be given (a railcar: railcar services only). */
export function dutiesFor(state: AppState, l: Loco): DutyInfo[] {
  if (isRailcar(l)) return DUTIES.filter((d) => d.id === 'railcar');
  return DUTIES.filter((d) => d.id !== 'railcar' && (d.id !== 'other' || state.trainTypes.some((t) => !t.builtIn)));
}

/** Whether a loco can work a kind of train: by its duties, or (with none) its working now. Any engine runs light. */
export function canWork(state: AppState, l: Loco, trainTypeId: string): boolean {
  if (ANY_ENGINE.has(trainTypeId)) return !isRailcar(l);
  if (!l.jobs?.length) return l.working.trainTypeId === trainTypeId;
  return l.jobs.some((j) => (j.trainTypeId ? j.trainTypeId === trainTypeId : dutyTypes(state, j.duty).includes(trainTypeId)));
}

/** The working a job runs as: its pinned one, or one of its duty's (chosen with `rng`). '' for a pilot. */
export function pickWorking(state: AppState, j: Pick<LocoJob, 'duty' | 'trainTypeId'>, rng: () => number): string {
  if (j.duty === 'pilot') return 'light_engine';
  if (j.trainTypeId) return j.trainTypeId;
  const info = dutyInfo(j.duty);
  const types = dutyTypes(state, j.duty);
  if (!types.length) return '';
  const odds = j.duty === 'other' ? types.map(() => 1) : info.odds;
  const total = odds.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < types.length; i++) {
    r -= odds[i];
    if (r < 0 && odds[i] > 0) return types[i];
  }
  return types[0];
}

/** "Express goods (any)", "Through goods and mineral: mineral / empties only". */
export function jobText(state: AppState, j: LocoJob): string {
  const d = dutyInfo(j.duty);
  if (!j.trainTypeId || j.duty === 'pilot') return d.name;
  const t = state.trainTypes.find((x) => x.id === j.trainTypeId);
  return `${d.name}: ${t ? t.name.toLowerCase() : j.trainTypeId} only`;
}

let jobSeq = 0;
export function newJob(duty: DutyId, weight: LocoJob['weight'] = 2, placeIds: string[] = [], trainTypeId = ''): LocoJob {
  return { id: `job_${Date.now().toString(36)}${(jobSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`, duty, trainTypeId, placeIds, weight };
}

// ---------------------------------------------------------------------------
// Roles: one click to give a loco a sensible set of duties
// ---------------------------------------------------------------------------

export interface RoleInfo {
  id: string;
  name: string;
  help: string;
  jobs: Array<[DutyId, LocoJob['weight']]>;
  railcar?: boolean;
}

export const ROLES: RoleInfo[] = [
  { id: 'express', name: 'Express passenger', help: 'Expresses mostly, sometimes parcels.', jobs: [['express', 3], ['parcels', 1]] },
  { id: 'mixed', name: 'Mixed traffic', help: 'Anything: passenger and goods (a Black Five, a Crab).', jobs: [['stopping', 2], ['express', 1], ['parcels', 1], ['expressGoods', 2], ['goods', 2]] },
  { id: 'local', name: 'Local passenger', help: 'Stopping and branch trains, some parcels and pick-up goods.', jobs: [['stopping', 3], ['parcels', 1], ['pickup', 1]] },
  { id: 'goods', name: 'Goods', help: 'Freight of all kinds, mostly through goods and coal.', jobs: [['goods', 3], ['expressGoods', 1], ['pickup', 2]] },
  { id: 'shunter', name: 'Shunter / pilot', help: 'Station pilot, and the odd pick-up goods.', jobs: [['pilot', 3], ['pickup', 1]] },
  { id: 'railcar', name: 'Railcar / DMU', help: 'Railcar services only.', jobs: [['railcar', 3]], railcar: true },
];

/** The roles offered for a loco (a railcar only gets the railcar role; other locos all but it). */
export function rolesFor(l: Loco): RoleInfo[] {
  return isRailcar(l) ? ROLES.filter((r) => r.railcar) : ROLES.filter((r) => !r.railcar);
}

/** Give a loco a role's duties (replacing its jobs; places left as anywhere). */
export function applyRole(l: Loco, roleId: string): void {
  const r = ROLES.find((x) => x.id === roleId);
  if (!r) return;
  l.jobs = r.jobs.map(([duty, weight]) => newJob(duty, weight));
  if (r.railcar) l.working.trainTypeId = 'railcar';
}

/** Bring a job from before duties (v0.3.24–25: a kind of train, or pilot) up to date. Null = drop it. */
export function migrateJob(state: AppState, raw: Partial<LocoJob> & { kind?: string }): LocoJob | null {
  const weight = ([1, 2, 3] as const).includes(raw.weight as 1 | 2 | 3) ? (raw.weight as LocoJob['weight']) : 2;
  const placeIds = Array.isArray(raw.placeIds) ? raw.placeIds.filter((x) => typeof x === 'string') : [];
  const id = typeof raw.id === 'string' ? raw.id : newJob('stopping').id;
  if (raw.duty && DUTIES.some((d) => d.id === raw.duty)) {
    const types = raw.duty === 'pilot' ? [] : dutyTypes(state, raw.duty);
    const tt = raw.trainTypeId && types.includes(raw.trainTypeId) ? raw.trainTypeId : '';
    return { id, duty: raw.duty, trainTypeId: tt, placeIds, weight };
  }
  if (raw.kind === 'pilot') return { id, duty: 'pilot', trainTypeId: '', placeIds, weight };
  const t = raw.trainTypeId ?? '';
  const duty = dutyOf(state, t);
  if (!duty) return null; // light engine "jobs": any engine runs light now
  // Any working of its duty, unless it was one only ever worked by being asked for (branch trains) or one of your own.
  const info = dutyInfo(duty);
  const i = info.types.indexOf(t);
  const pinned = duty === 'other' || (i >= 0 && info.odds[i] === 0) ? t : '';
  return { id, duty, trainTypeId: pinned, placeIds, weight };
}
