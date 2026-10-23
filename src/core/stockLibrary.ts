import generic from './stockData/generic.json';
import lmsGrouping from './stockData/lms-grouping.json';
import { parseLength } from './railway';
import type { LengthBasis, StockCategory, VehicleClass } from './stockTypes';
import { sanitiseVehicleClass } from './stockSanitise';

/*
 * The built-in stock library (v0.3.38): JSON data files, one per company and era, read through a typed
 * import and checked by the same sanitiser as the user's own types (D4). The files also carry the
 * parameters that differ by company or era (the buffer allowance, train limits, fitted classes), with
 * the generic file giving the defaults. No company or era appears in code.
 */

/** A row of a data file, with lengths as the source quotes them ("60 ft 8 in", "7137 mm"). */
export interface StockDataRow {
  key: string;
  name: string;
  code?: string;
  category: string;
  coachType?: string;
  corridor?: boolean;
  guard: boolean;
  shape?: string;
  overHeadstocks?: string;
  overBuffers?: string;
  lengthBasis?: string;
  fitted: boolean;
  tareKg?: number;
  loadedKg?: number;
  origin?: string;
  eras?: string[];
  diagram?: string;
  source?: string;
}

export interface TrainLimit {
  maxVehicles?: number;
  maxTons?: number;
}

export interface FittedClassRule {
  trainTypeId: string;
  /** At least this proportion of the vehicles in the fitted head. */
  minProportion?: number;
  /** At least this many vehicles in the fitted head. */
  minFittedHead?: number;
}

/** Parameters as written in a data file (any of them may be left out to take the generic default). */
export interface StockDataParams {
  bufferAllowance?: { coaching?: string; freight?: string };
  trainLimits?: Record<string, TrainLimit>;
  fittedClasses?: FittedClassRule[];
  unfittedClass?: string;
  unfittedTrainTypes?: string[];
  [note: string]: unknown;
}

export interface StockDataFile {
  id: string;
  name: string;
  /** The company the file is for ('generic' for the fallbacks). */
  origin: string;
  /** The eras it covers (empty = any). */
  eras: string[];
  note?: string;
  params?: StockDataParams;
  classes: StockDataRow[];
}

/** Parameters with every value filled in (lengths in metres). */
export interface StockParams {
  bufferAllowance: { coaching: number; freight: number };
  trainLimits: Record<string, TrainLimit>;
  fittedClasses: FittedClassRule[];
  unfittedClass: string;
  unfittedTrainTypes: string[];
}

/** The data files shipped with the app. The generic file comes first and gives the default parameters. */
export const STOCK_DATA_FILES: StockDataFile[] = [generic as StockDataFile, lmsGrouping as StockDataFile];

export const GENERIC_ORIGIN = 'generic';

const len = (t: string | undefined): number | undefined => (t ? parseLength(t, 'ft') ?? undefined : undefined);

/** The generic default parameters (from the generic data file). */
function genericParams(files: StockDataFile[]): StockParams {
  const g = files.find((f) => f.origin === GENERIC_ORIGIN)?.params ?? {};
  return {
    bufferAllowance: { coaching: len(g.bufferAllowance?.coaching) ?? 0, freight: len(g.bufferAllowance?.freight) ?? 0 },
    trainLimits: { ...(g.trainLimits ?? {}) },
    fittedClasses: [...(g.fittedClasses ?? [])],
    unfittedClass: g.unfittedClass ?? 'freight_unfitted',
    unfittedTrainTypes: [...(g.unfittedTrainTypes ?? [])],
  };
}

const sameName = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The parameters for a company (and era): that company's data file values over the generic defaults.
 * A company with no file of its own (or no origin) gets the generic defaults.
 */
export function stockParams(origin?: string, eras?: string[], files: StockDataFile[] = STOCK_DATA_FILES): StockParams {
  const out = genericParams(files);
  const file =
    files.find((f) => sameName(f.origin, origin) && f.origin !== GENERIC_ORIGIN && (!eras?.length || !f.eras.length || f.eras.some((e) => eras.includes(e)))) ??
    files.find((f) => sameName(f.origin, origin) && f.origin !== GENERIC_ORIGIN);
  const p = file?.params;
  if (!p) return out;
  if (p.bufferAllowance?.coaching) out.bufferAllowance.coaching = len(p.bufferAllowance.coaching) ?? out.bufferAllowance.coaching;
  if (p.bufferAllowance?.freight) out.bufferAllowance.freight = len(p.bufferAllowance.freight) ?? out.bufferAllowance.freight;
  if (p.trainLimits) out.trainLimits = { ...out.trainLimits, ...p.trainLimits };
  if (p.fittedClasses?.length) out.fittedClasses = [...p.fittedClasses];
  if (p.unfittedClass) out.unfittedClass = p.unfittedClass;
  if (p.unfittedTrainTypes) out.unfittedTrainTypes = [...p.unfittedTrainTypes];
  return out;
}

/** Coaching stock (anything with a coach type) uses the coaching allowance; goods stock the freight one. */
export function allowanceKind(category: StockCategory, coachType?: string): 'coaching' | 'freight' {
  return coachType || category === 'coach' ? 'coaching' : 'freight';
}

/**
 * Length over buffers worked out from over headstocks with the buffer allowance for the company (and
 * era) and kind of vehicle, falling back to the generic default.
 */
export function overBuffersFromHeadstocks(metresOverHeadstocks: number, category: StockCategory, coachType: string | undefined, origin?: string, eras?: string[], files: StockDataFile[] = STOCK_DATA_FILES): number {
  const p = stockParams(origin, eras, files);
  return metresOverHeadstocks + p.bufferAllowance[allowanceKind(category, coachType)];
}

/** A data file's rows as library types, with any problems found (a row that does not pass the sanitiser is a problem). */
export function readDataFile(file: StockDataFile, files: StockDataFile[] = STOCK_DATA_FILES): { classes: VehicleClass[]; problems: string[] } {
  const classes: VehicleClass[] = [];
  const problems: string[] = [];
  for (const row of file.classes) {
    const origin = row.origin ?? file.origin;
    const eras = row.eras ?? file.eras;
    const headstocks = len(row.overHeadstocks);
    let buffers = len(row.overBuffers);
    if (row.overHeadstocks && headstocks === undefined) problems.push(`${row.key}: over headstocks "${row.overHeadstocks}" cannot be read`);
    if (row.overBuffers && buffers === undefined) problems.push(`${row.key}: over buffers "${row.overBuffers}" cannot be read`);
    if (buffers === undefined && headstocks !== undefined) {
      if (row.lengthBasis !== 'estimated') problems.push(`${row.key}: over buffers worked out from headstocks must be marked estimated`);
      buffers = overBuffersFromHeadstocks(headstocks, row.category as StockCategory, row.coachType, origin, eras, files);
    }
    const raw: Record<string, unknown> = {
      id: row.key,
      name: row.name,
      code: row.code,
      category: row.category,
      coachType: row.coachType,
      corridor: row.corridor,
      guard: row.guard,
      metresOverBuffers: buffers,
      metresOverHeadstocks: headstocks,
      lengthBasis: buffers !== undefined ? (row.lengthBasis as LengthBasis | undefined) : undefined,
      fitted: row.fitted,
      tareKg: row.tareKg,
      loadedKg: row.loadedKg,
      shape: row.shape,
      origin,
      eras: [...eras],
      diagram: row.diagram,
      quoted: row.overBuffers,
      source: row.source,
    };
    const cls = sanitiseVehicleClass(raw, true);
    if (!cls) {
      problems.push(`${row.key}: does not pass the sanitiser`);
      continue;
    }
    for (const k of ['category', 'coachType', 'corridor', 'lengthBasis', 'shape', 'metresOverHeadstocks'] as const)
      if (raw[k] !== undefined && cls[k] !== raw[k]) problems.push(`${row.key}: ${k} "${String(raw[k])}" not accepted`);
    if (buffers !== undefined && !row.lengthBasis) problems.push(`${row.key}: a length with no basis`);
    if (buffers === undefined && row.lengthBasis) problems.push(`${row.key}: a basis with no length`);
    classes.push(cls);
  }
  return { classes, problems };
}

let cache: VehicleClass[] | null = null;

/** Every built-in type from the shipped data files (or from the files given, e.g. a test fixture). */
export function builtInClasses(files?: StockDataFile[]): VehicleClass[] {
  if (files) return files.flatMap((f) => readDataFile(f, files).classes);
  cache ??= STOCK_DATA_FILES.flatMap((f) => readDataFile(f).classes);
  return cache;
}
