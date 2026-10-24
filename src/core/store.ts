import { createDefaultState, DEFAULT_SETTINGS, FALLBACK_LAYOUT_NAME, SCHEMA_VERSION } from './defaults';
import { COMMON_SIGNALS } from './bellcodes';
import { sanitiseTrackPlan } from './trackPlan';
import { sanitisePlaces } from './places';
import { sanitiseTimetables } from './timetables';
import { sanitiseRailwayData } from './railway';
import { builtInClasses, stockCompanies } from './stockLibrary';
import { RAKE_TYPES } from './trainStock';
import { sanitiseRollingStock } from './stockSanitise';
import type { AppState, BoxDef, ConnectionDef, Layout, Place, PlaceRoad, TrackPlan } from './types';

/** Shapes saved by earlier versions (before places, v0.3.13 and earlier). */
interface OldYard {
  id: string;
  name: string;
  roads: Array<{ id: string; name: string; notes?: string }>;
}
type OldLayout = Omit<Layout, 'places'> & { places?: Place[]; fiddleYards?: OldYard[] };
type OldBox = BoxDef & { stationNotes?: string };
type OldConn = ConnectionDef & { fiddleYardId?: string };
type OldLocation =
  | { kind: 'fiddleYard'; yardId: string; roadId: string }
  | { kind: 'station'; boxId: string; note: string }
  | { kind: 'farBox'; boxId: string; connectionId: string; note: string };

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const KEY = 'signal-box-simulator-state';
/** Key used before the app was renamed; read once so existing data carries over. */
const OLD_KEY = 'bts-signalbox-state';

/** Fill in anything missing from older saved data so new features never crash on old saves. */
export function migrate(raw: unknown): AppState {
  const def = createDefaultState();
  if (!raw || typeof raw !== 'object') return def;
  // Saves from before layouts (v0.3.11 and earlier) kept one layout's name in settings, and its
  // fiddle yards and track plan at the top level.
  const s = raw as Partial<AppState> & { fiddleYards?: OldYard[]; trackPlan?: TrackPlan; settings?: { layoutName?: string } };
  const oldSettings = (s.settings ?? {}) as Partial<AppState['settings']> & { layoutName?: string };
  const { layoutName: oldLayoutName, ...keptSettings } = oldSettings;
  const preLayouts = !Array.isArray(s.layouts);
  let layouts: OldLayout[];
  if (!preLayouts) layouts = s.layouts as OldLayout[];
  else
    layouts = [
      {
        id: 'layout1',
        name: (typeof oldLayoutName === 'string' && oldLayoutName.trim()) || FALLBACK_LAYOUT_NAME,
        fiddleYards: Array.isArray(s.fiddleYards) ? s.fiddleYards : structuredClone(def.layouts[0].places.filter((p) => p.kind === 'fiddleYard')),
        // Older saves have no track plan: start with an empty one.
        trackPlan: s.trackPlan && typeof s.trackPlan === 'object' ? s.trackPlan : { circuits: [], junctions: [] },
      },
    ];
  const state: AppState = {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS, ...keptSettings, tap: { ...DEFAULT_SETTINGS.tap, ...(oldSettings.tap ?? {}) } },
    trainTypes: Array.isArray(s.trainTypes) && s.trainTypes.length ? s.trainTypes : def.trainTypes,
    codeSets: Array.isArray(s.codeSets) && s.codeSets.length ? s.codeSets : def.codeSets,
    roster: Array.isArray(s.roster) ? s.roster : def.roster,
    boxes: Array.isArray(s.boxes) && s.boxes.length ? s.boxes : def.boxes,
    layouts: layouts as Layout[],
  };
  if (preLayouts) {
    // Everything in an old save belonged to its one layout, which is the one being worked.
    for (const b of state.boxes) b.layoutId = 'layout1';
    state.settings.activeLayoutId = 'layout1';
  }
  state.layouts = state.layouts.filter((l) => l && typeof l === 'object' && typeof l.id === 'string');
  for (const l of state.layouts) {
    l.name = String(l.name ?? '').trim() || FALLBACK_LAYOUT_NAME;
    const old = l as OldLayout;
    // Fiddle yards became places of kind 'fiddleYard' (v0.3.14).
    if (!Array.isArray(old.places)) {
      l.places = (Array.isArray(old.fiddleYards) ? old.fiddleYards : [])
        .filter((y) => y && Array.isArray(y.roads))
        .map((y) => ({ id: y.id, kind: 'fiddleYard', name: y.name || 'Fiddle yard', shortName: '', notes: '', roads: y.roads.map((r) => ({ id: r.id, name: r.name, notes: r.notes ?? '' })), workedBy: [] }));
    }
    delete old.fiddleYards;
    if (!l.trackPlan || typeof l.trackPlan !== 'object') l.trackPlan = { circuits: [], junctions: [] };
    if (l.running !== 'right') l.running = 'left';
  }
  const layoutIds = new Set(state.layouts.map((l) => l.id));
  if (!layoutIds.has(state.settings.activeLayoutId)) state.settings.activeLayoutId = state.layouts[0]?.id ?? '';
  // New built-in train types / code sets added in later versions get merged in.
  for (const tt of def.trainTypes) if (!state.trainTypes.some((t) => t.id === tt.id)) state.trainTypes.push(tt);
  for (const cs of def.codeSets) if (!state.codeSets.some((c) => c.id === cs.id)) state.codeSets.push(cs);
  // Regulating ranks (v0.3.17): saved copies of the built-in code sets get the built-in ranks.
  for (const cs of state.codeSets) {
    const d = def.codeSets.find((x) => x.id === cs.id);
    if (!d || !cs.trainCodes) continue;
    for (const [id, e] of Object.entries(cs.trainCodes)) {
      const r = d.trainCodes[id]?.rank;
      if (e && typeof e.rank !== 'number' && typeof r === 'number') e.rank = r;
    }
  }
  // Signals added in later versions (v0.3.32: blocking back inside the home, shunting into the forward
  // section and shunt withdrawn) join every saved code set, unless that set already uses the code.
  for (const cs of state.codeSets) {
    if (!cs.signals || typeof cs.signals !== 'object') continue;
    const used = new Set<string>([...Object.values(cs.signals), ...Object.values(cs.trainCodes ?? {}).map((e) => e?.code)]);
    for (const id of ['blocking_back_inside', 'shunt_into_forward', 'shunt_withdrawn']) {
      const code = COMMON_SIGNALS[id];
      if (id in cs.signals || used.has(code)) continue;
      cs.signals[id] = code;
      used.add(code);
    }
  }
  if (!state.codeSets.some((c) => c.id === state.settings.codeSetId)) state.settings.codeSetId = state.codeSets[0].id;
  // Before places (v0.3.13 and earlier) every box had an implied station with free-text notes, and a
  // line with no fiddle yard ran to "the location its far box serves". Both become places.
  const stationOf = new Map<string, Place>();
  const farOf = new Map<string, Place>();
  for (const b of state.boxes as OldBox[]) {
    b.shelfPositions = Math.max(1, Math.min(8, Math.round(b.shelfPositions ?? Math.max(3, b.connections.length))));
    if (typeof b.layoutId !== 'string' || !layoutIds.has(b.layoutId)) b.layoutId = '';
    const layout = state.layouts.find((l) => l.id === b.layoutId);
    const legacyBox = typeof b.stationNotes === 'string';
    if (legacyBox && layout) {
      const st = stationFromNotes(b, layout);
      layout.places.push(st);
      stationOf.set(b.id, st);
    }
    delete b.stationNotes;
    (b.connections as OldConn[]).forEach((c, i) => {
      if (typeof c.placeId !== 'string') {
        const yard = c.fiddleYardId && layout?.places.find((p) => p.id === c.fiddleYardId);
        if (yard) c.placeId = yard.id;
        else if (layout) {
          const far: Place = { id: `far_${c.id}`, kind: 'station', name: uniquePlaceName(layout, c.neighbourName || 'Far box'), shortName: '', notes: '', roads: [], workedBy: [] };
          layout.places.push(far);
          farOf.set(c.id, far);
          c.placeId = far.id;
        } else c.placeId = '';
        const p = layout?.places.find((x) => x.id === c.placeId);
        if (p) p.workedBy.push({ kind: 'remote', boxId: b.id, connectionId: c.id });
      }
      delete c.fiddleYardId;
      if (typeof c.shelfPosition !== 'number') c.shelfPosition = b.id === 'becton' && c.id === 'becton-fy' ? 2 : i;
    });
  }
  for (const l of state.roster) {
    l.working ??= { trainTypeId: 'light_engine', consist: '', headcode: '' };
    l.location ??= { kind: 'offLayout' };
    // A loco left "in section" when the app closed is put back where it came from is unknown: park it off layout.
    if (l.location.kind === 'section') l.location = { kind: 'offLayout' };
    const old = l.location as unknown as OldLocation;
    if (old.kind === 'fiddleYard') l.location = { kind: 'place', placeId: old.yardId, roadId: old.roadId ?? '' };
    else if (old.kind === 'station') {
      const st = stationOf.get(old.boxId);
      if (st) l.location = { kind: 'place', placeId: st.id, roadId: matchRoad(st.roads, old.note)?.id ?? '' };
      else l.location = state.boxes.some((b) => b.id === old.boxId) ? { kind: 'atBox', boxId: old.boxId } : { kind: 'offLayout' };
    } else if (old.kind === 'farBox') {
      const far = farOf.get(old.connectionId);
      l.location = far ? { kind: 'place', placeId: far.id, roadId: '' } : { kind: 'offLayout' };
    }
  }
  // Track leaving the scene "to a fiddle yard" now leads to a place.
  for (const lay of state.layouts) {
    for (const c of lay.trackPlan.circuits ?? []) {
      for (const e of c.ends ?? []) {
        const to = (e as { to?: { kind: string; yardId?: string } }).to;
        if (e.kind === 'exit' && to?.kind === 'fiddleYard') e.to = { kind: 'place', placeId: to.yardId ?? '' };
      }
    }
  }
  sanitiseTrackPlan(state);
  sanitisePlaces(state);
  // Timetables and loco jobs (v0.3.24): older saves have none.
  sanitiseTimetables(state);
  // Real-railway lengths and speeds (v0.3.27): all optional; unusable values are dropped so the defaults apply.
  sanitiseRailwayData(state);
  // Rolling stock (v0.3.38, schema 8): the library types, fleet and rakes of each layout.
  const builtInIds = new Set(builtInClasses().map((c) => c.id));
  const builtInRakeTypeIds = new Set(RAKE_TYPES.map((t) => t.id));
  for (const l of state.layouts) {
    const rs = sanitiseRollingStock(l.rollingStock, builtInIds, new Set(l.places.map((p) => p.id)), builtInRakeTypeIds);
    if (rs) l.rollingStock = rs;
    else delete l.rollingStock;
  }
  // The layout's railway company (v0.3.41, schema 10): one the library has data for, else generic. The
  // example layout, Sigsim Central, is set to LMS when an older save is first loaded.
  const companies = stockCompanies();
  const oldSchema = typeof s.schemaVersion === 'number' ? s.schemaVersion : 0;
  for (const l of state.layouts) {
    if (oldSchema < 10 && l.id === 'layout1' && l.name === 'Sigsim Central' && l.stockCompany === undefined) l.stockCompany = def.layouts[0].stockCompany;
    const c = companies.find((x) => typeof l.stockCompany === 'string' && x.toLowerCase() === l.stockCompany.toLowerCase());
    if (c) l.stockCompany = c;
    else delete l.stockCompany;
  }
  // Train limits (v0.3.41, D13): whole numbers above nought, else the company/era default applies.
  for (const tt of state.trainTypes) {
    for (const k of ['maxVehicles', 'maxTons'] as const) {
      const v = tt[k];
      if (v === undefined) continue;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 1) tt[k] = Math.min(k === 'maxVehicles' ? 500 : 10000, Math.round(v));
      else delete tt[k];
    }
  }
  return state;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function uniquePlaceName(layout: Layout, base: string): string {
  const used = new Set(layout.places.map((p) => norm(p.name)));
  if (!used.has(norm(base))) return base;
  for (let n = 2; ; n++) if (!used.has(norm(`${base} ${n}`))) return `${base} ${n}`;
}

/** A road name as people write it: "P1", "Platform 1", "plat 1" and "1" all match the road "P1". */
const roadKey = (s: string) => norm(s).replace(/^(platform|plat\.?|p)\s*(?=\d)/, 'p').replace(/^(\d)/, 'p$1');

export function matchRoad(roads: PlaceRoad[], text: string): PlaceRoad | undefined {
  if (!text.trim()) return undefined;
  return roads.find((r) => roadKey(r.name) === roadKey(text));
}

/**
 * The station an old box implied, made into a place worked by the box. Lines of its station notes
 * that begin with a platform ("P1: …", "Platform 2 - …", "Bay: …") become roads with those notes;
 * the rest stay as the station's notes.
 */
export function stationFromNotes(box: { id: string; name: string; stationNotes?: string }, layout: Layout): Place {
  const roads: PlaceRoad[] = [];
  const rest: string[] = [];
  for (const line of (box.stationNotes ?? '').split(/\r?\n/)) {
    const m = /^\s*(P\d+[a-z]?|Platform\s+\d+[a-z]?|Bay)\s*[:\-–]\s*(.*)$/i.exec(line);
    if (m && !roads.some((r) => norm(r.name) === norm(m[1]))) {
      const note = m[2].trim();
      roads.push({ id: `${box.id}_road${roads.length + 1}`, name: m[1].replace(/^p(?=\d)/, 'P'), notes: note ? note[0].toUpperCase() + note.slice(1) : '' });
    } else if (line.trim()) rest.push(line.trim());
  }
  return {
    id: `stn_${box.id}`,
    kind: 'station',
    name: uniquePlaceName(layout, box.name),
    shortName: '',
    notes: rest.join('\n'),
    roads,
    workedBy: [{ kind: 'box', boxId: box.id }],
  };
}

export class Store {
  private listeners = new Set<(s: AppState) => void>();
  state: AppState;

  constructor(private storage: KeyValueStorage | null) {
    let raw: unknown = null;
    let fromOldKey = false;
    try {
      let txt = storage?.getItem(KEY) ?? null;
      if (!txt) {
        txt = storage?.getItem(OLD_KEY) ?? null;
        fromOldKey = !!txt;
      }
      raw = txt ? JSON.parse(txt) : null;
    } catch {
      raw = null;
    }
    this.state = migrate(raw);
    if (!raw || fromOldKey) this.save();
  }

  subscribe(fn: (s: AppState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(fn: (s: AppState) => void): void {
    fn(this.state);
    this.save();
    for (const l of this.listeners) l(this.state);
  }

  save(): string | null {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.state));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not save';
    }
  }

  exportJson(): string {
    return JSON.stringify(this.state, null, 2);
  }

  importJson(text: string): void {
    const parsed = JSON.parse(text);
    this.state = migrate(parsed);
    this.save();
    for (const l of this.listeners) l(this.state);
  }

  /** Erase everything saved (layouts, boxes, places, track plans, roster, settings) and start again from the app's starting data. */
  reset(): void {
    try {
      this.storage?.removeItem?.(KEY);
      this.storage?.removeItem?.(OLD_KEY);
    } catch {
      /* storage unavailable: the save below still replaces it */
    }
    this.state = createDefaultState();
    this.save();
    for (const l of this.listeners) l(this.state);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
