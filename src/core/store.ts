import { createDefaultState, DEFAULT_SETTINGS, SCHEMA_VERSION } from './defaults';
import { sanitiseTrackPlan } from './trackPlan';
import type { AppState } from './types';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'signal-box-simulator-state';
/** Key used before the app was renamed; read once so existing data carries over. */
const OLD_KEY = 'bts-signalbox-state';

/** Fill in anything missing from older saved data so new features never crash on old saves. */
export function migrate(raw: unknown): AppState {
  const def = createDefaultState();
  if (!raw || typeof raw !== 'object') return def;
  const s = raw as Partial<AppState>;
  const state: AppState = {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}), tap: { ...DEFAULT_SETTINGS.tap, ...(s.settings?.tap ?? {}) } },
    trainTypes: Array.isArray(s.trainTypes) && s.trainTypes.length ? s.trainTypes : def.trainTypes,
    codeSets: Array.isArray(s.codeSets) && s.codeSets.length ? s.codeSets : def.codeSets,
    roster: Array.isArray(s.roster) ? s.roster : def.roster,
    fiddleYards: Array.isArray(s.fiddleYards) && s.fiddleYards.length ? s.fiddleYards : def.fiddleYards,
    boxes: Array.isArray(s.boxes) && s.boxes.length ? s.boxes : def.boxes,
    // Older saves have no track plan: start with an empty one.
    trackPlan: s.trackPlan && typeof s.trackPlan === 'object' ? s.trackPlan : def.trackPlan,
  };
  // New built-in train types / code sets added in later versions get merged in.
  for (const tt of def.trainTypes) if (!state.trainTypes.some((t) => t.id === tt.id)) state.trainTypes.push(tt);
  for (const cs of def.codeSets) if (!state.codeSets.some((c) => c.id === cs.id)) state.codeSets.push(cs);
  if (!state.codeSets.some((c) => c.id === state.settings.codeSetId)) state.settings.codeSetId = state.codeSets[0].id;
  for (const b of state.boxes) {
    b.shelfPositions = Math.max(1, Math.min(8, Math.round(b.shelfPositions ?? Math.max(3, b.connections.length))));
    b.connections.forEach((c, i) => {
      if (typeof c.fiddleYardId !== 'string') c.fiddleYardId = '';
      if (typeof c.shelfPosition !== 'number') c.shelfPosition = b.id === 'becton' && c.id === 'becton-fy' ? 2 : i;
    });
  }
  for (const l of state.roster) {
    l.working ??= { trainTypeId: 'light_engine', consist: '', headcode: '' };
    l.location ??= { kind: 'offLayout' };
    // A loco left "in section" when the app closed is put back where it came from is unknown: park it off layout.
    if (l.location.kind === 'section') l.location = { kind: 'offLayout' };
    const loc = l.location;
    if (loc.kind === 'farBox' && !state.boxes.some((b) => b.id === loc.boxId && b.connections.some((c) => c.id === loc.connectionId))) l.location = { kind: 'offLayout' };
  }
  sanitiseTrackPlan(state);
  return state;
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

  reset(): void {
    this.state = createDefaultState();
    this.save();
    for (const l of this.listeners) l(this.state);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
