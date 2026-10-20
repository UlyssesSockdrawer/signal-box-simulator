// Headcodes (v0.3.26): how trains show what they are, chosen per layout by era.
//
//  - Grouping era (1923–1947, the GWR 1936 / LMS 1937 standard codes): the engine carries a LAMP
//    HEADCODE for its class of train, and a train may carry a three-digit REPORTING NUMBER (e.g. 123).
//  - BR steam era (1948–1960, the BR 1950s standard codes): lamp headcodes as before, slightly
//    rearranged, plus a three-digit reporting number.
//  - BR 1960 onwards: the four-character alphanumeric headcode (e.g. 2E11: class 2, destination E,
//    train 11) replaces the lamp code.
//
// Lamp positions are drawn as you face the front of the engine: left buffer, the top (chimney or
// smokebox) bracket, the centre of the buffer beam, and the right buffer. Railways had their own
// variations (the Southern used route discs), so these are the standard codes only.

import type { AppState, HeadcodeEra, Layout, Place, Timetable, TimetableEntry } from './types';

export type { HeadcodeEra };

export interface HeadcodeEraInfo {
  id: HeadcodeEra;
  name: string;
  /** For a sentence: "the Grouping era" (keeps "BR" in capitals). */
  label: string;
  years: string;
  description: string;
}

export const HEADCODE_ERAS: HeadcodeEraInfo[] = [
  {
    id: 'grouping',
    name: 'Grouping era: lamp headcodes',
    label: 'Grouping era',
    years: '1923–1947',
    description: 'Engines carry a lamp headcode for their class of train (the GWR 1936 / LMS 1937 standard codes), and trains a three-digit reporting number such as 123.',
  },
  {
    id: 'brLamps',
    name: 'BR steam era: lamp headcodes',
    label: 'BR steam era',
    years: '1948–1960',
    description: 'Lamp headcodes as rearranged by British Railways in the 1950s, and a three-digit reporting number such as 123.',
  },
  {
    id: 'br1960',
    name: 'BR 1960 onwards: four-character headcodes',
    label: 'BR era of four-character headcodes',
    years: '1960 on',
    description: 'A four-character headcode such as 2E11 (class 2, destination E, train 11) replaces the lamp code.',
  },
];

export const DEFAULT_ERA: HeadcodeEra = 'br1960';

export function eraOf(layout: Layout | null | undefined): HeadcodeEra {
  const e = layout?.headcodeEra;
  return e === 'grouping' || e === 'brLamps' || e === 'br1960' ? e : DEFAULT_ERA;
}

export function eraInfo(era: HeadcodeEra): HeadcodeEraInfo {
  return HEADCODE_ERAS.find((e) => e.id === era) ?? HEADCODE_ERAS[2];
}

export function usesLamps(era: HeadcodeEra): boolean {
  return era !== 'br1960';
}

/** What the headcode field is called in this era. */
export function headcodeLabel(era: HeadcodeEra): string {
  return usesLamps(era) ? 'Reporting number' : 'Headcode';
}

export function headcodePlaceholder(era: HeadcodeEra): string {
  return usesLamps(era) ? 'e.g. 123' : 'e.g. 2E11';
}

// ---------------------------------------------------------------------------
// Lamp headcodes
// ---------------------------------------------------------------------------

/** Which lamp brackets carry a lamp, as you face the engine. */
export interface LampPattern {
  left: boolean;
  top: boolean;
  centre: boolean;
  right: boolean;
}

/** Lamp classes of the built-in train types, per era. Custom train types have none. */
const LAMP_CLASS: Record<'grouping' | 'brLamps', Record<string, string>> = {
  grouping: {
    express_passenger: 'A',
    ordinary_passenger: 'B',
    branch_passenger: 'B',
    railcar: 'B',
    parcels: 'C',
    ecs: 'C',
    freight_fitted_half: 'C',
    freight_fitted_third: 'D',
    freight_fitted_four: 'E',
    freight_unfitted: 'F',
    light_engine: 'G',
    engine_brake_van: 'G',
    through_freight: 'H',
    mineral: 'J',
    pickup_goods: 'K',
    branch_freight: 'K',
  },
  brLamps: {
    express_passenger: 'A',
    ordinary_passenger: 'B',
    branch_passenger: 'B',
    railcar: 'B',
    parcels: 'C',
    ecs: 'C',
    freight_fitted_half: 'C',
    freight_fitted_third: 'D',
    freight_fitted_four: 'E',
    freight_unfitted: 'F',
    light_engine: 'G',
    engine_brake_van: 'G',
    through_freight: 'H',
    mineral: 'J',
    pickup_goods: 'K',
    branch_freight: 'K',
  },
};

// Written left buffer / middle / right buffer: '.' a buffer lamp, '_' none; in the middle "'" the
// top lamp, '.' the centre (buffer beam) lamp, ':' both.
const LAMP_CODES: Record<'grouping' | 'brLamps', Record<string, string>> = {
  grouping: { A: "._.", B: "_'_", C: ".'_", D: '.._', E: "_'.", F: '_:_', G: '_._', H: '_..', J: '.__', K: '__.' },
  brLamps: { A: "._.", B: "_'_", C: '.._', D: ".'_", E: '_..', F: "_'.", G: '_._', H: '_:_', J: '.__', K: '__.' },
};

function parseLamps(code: string): LampPattern {
  const m = code[1];
  return { left: code[0] === '.', right: code[2] === '.', top: m === "'" || m === ':', centre: m === '.' || m === ':' };
}

/** The lamp class letter of a train type in a lamp era (null for custom types, or the 1960 era). */
export function lampClass(era: HeadcodeEra, trainTypeId: string): string | null {
  if (era === 'br1960') return null;
  return LAMP_CLASS[era][trainTypeId] ?? null;
}

export function lampPattern(era: HeadcodeEra, trainTypeId: string): LampPattern | null {
  const c = lampClass(era, trainTypeId);
  if (!c || era === 'br1960') return null;
  const code = LAMP_CODES[era][c];
  return code ? parseLamps(code) : null;
}

/** Words for a lamp pattern, e.g. "lamp over each buffer". */
export function lampText(p: LampPattern): string {
  const parts: string[] = [];
  if (p.left && p.right) parts.push('over each buffer');
  else if (p.left) parts.push('over the left buffer');
  else if (p.right) parts.push('over the right buffer');
  if (p.top) parts.push('at the chimney');
  if (p.centre) parts.push('in the middle of the buffer beam');
  const n = [p.left, p.right, p.top, p.centre].filter(Boolean).length;
  if (!n) return 'no lamps';
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${n > 1 ? 'lamps' : 'lamp'} ${said}`;
}

// ---------------------------------------------------------------------------
// BR 1960 four-character headcodes
// ---------------------------------------------------------------------------

/** BR 1960 class digit of the built-in train types. */
const CLASS_DIGIT: Record<string, string> = {
  express_passenger: '1',
  ordinary_passenger: '2',
  branch_passenger: '2',
  railcar: '2',
  parcels: '3',
  freight_fitted_half: '4',
  ecs: '5',
  freight_fitted_third: '6',
  freight_fitted_four: '7',
  freight_unfitted: '8',
  through_freight: '8',
  mineral: '8',
  pickup_goods: '9',
  branch_freight: '9',
  light_engine: '0',
  engine_brake_van: '0',
};

export function classDigit(trainTypeId: string): string | null {
  return CLASS_DIGIT[trainTypeId] ?? null;
}

const NO_LETTERS = new Set(['I', 'O']); // too like 1 and 0 on a headcode panel

/**
 * A destination letter for every place on the layout, unique to it: the first letter of the last
 * word of its name if free (Fiddle Yard East → E), else of the words before it, else any other
 * letter of its name, else any free letter.
 */
export function destinationLetters(layout: Layout): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const take = (p: Place, letters: string[]): boolean => {
    for (const l of letters) {
      if (/^[A-Z]$/.test(l) && !NO_LETTERS.has(l) && !used.has(l)) {
        used.add(l);
        out.set(p.id, l);
        return true;
      }
    }
    return false;
  };
  const pending: Place[] = [];
  for (const p of layout.places) {
    const words = p.name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    if (!take(p, words.map((w) => w[0]).reverse())) pending.push(p);
  }
  for (const p of pending) {
    if (take(p, [...p.name.toUpperCase(), ...p.shortName.toUpperCase()])) continue;
    take(p, [...'ABCDEFGHJKLMNPQRSTUVWXYZ']);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checking and filling in
// ---------------------------------------------------------------------------

/** Whether an entry should carry a headcode / reporting number in this era. */
export function wantsHeadcode(era: HeadcodeEra, e: Pick<TimetableEntry, 'kind' | 'trainTypeId'>): boolean {
  if (e.kind !== 'run' && e.kind !== 'enter' && e.kind !== 'leave') return false;
  if (usesLamps(era)) return e.trainTypeId !== 'light_engine' && e.trainTypeId !== 'engine_brake_van';
  return classDigit(e.trainTypeId) !== null;
}

/** A warning for a headcode that is not the usual shape for the era ('' is fine), or null. */
export function checkHeadcode(era: HeadcodeEra, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (usesLamps(era)) return /^\d{1,3}$/.test(t) ? null : 'Reporting numbers in this era are up to three digits, e.g. 123.';
  return /^\d[A-Z]\d{2}$/.test(t.toUpperCase()) ? null : 'Headcodes from 1960 are a class digit, a letter and two digits, e.g. 2E11.';
}

/** The class digit a 1960 headcode should start with for this train type, when it does not. */
export function headcodeClassWarning(era: HeadcodeEra, text: string, trainTypeId: string): string | null {
  if (era !== 'br1960') return null;
  const d = classDigit(trainTypeId);
  const t = text.trim();
  if (!d || !/^\d[A-Z]\d{2}$/i.test(t) || t[0] === d) return null;
  return `This kind of train is class ${d}: its headcode would start with ${d}.`;
}

/** Hands out fresh headcodes / reporting numbers, avoiding ones already used. */
export class HeadcodeAllocator {
  private used = new Set<string>();
  private counters = new Map<string, number>();
  private letters: Map<string, string>;

  constructor(
    readonly era: HeadcodeEra,
    readonly layout: Layout,
    existing: Iterable<string> = [],
  ) {
    for (const h of existing) if (h) this.used.add(h.toUpperCase());
    this.letters = destinationLetters(layout);
  }

  /** The destination letter of a place ('' when none). */
  letterFor(placeId: string): string {
    return this.letters.get(placeId) ?? '';
  }

  /** A new headcode for a move of this kind of train to this place, or '' if it carries none. */
  next(trainTypeId: string, destPlaceId: string, kind: TimetableEntry['kind'] = 'run'): string {
    if (!wantsHeadcode(this.era, { kind, trainTypeId })) return '';
    if (usesLamps(this.era)) {
      // Passenger and coaching-stock trains 1xx, freight 5xx: easy to tell apart on the poster.
      const freight = /freight|mineral|goods/.test(trainTypeId);
      return this.take(freight ? '5' : '1', (n) => `${freight ? 5 : 1}${String(n).padStart(2, '0')}`, 99);
    }
    const d = classDigit(trainTypeId)!;
    const l = this.letterFor(destPlaceId) || 'Z';
    return this.take(`${d}${l}`, (n) => `${d}${l}${String(n).padStart(2, '0')}`, 99);
  }

  private take(key: string, make: (n: number) => string, max: number): string {
    let n = this.counters.get(key) ?? 0;
    for (let i = 0; i < max; i++) {
      n = (n % max) + 1;
      const h = make(n);
      if (!this.used.has(h)) {
        this.counters.set(key, n);
        this.used.add(h);
        return h;
      }
    }
    return '';
  }
}

/** Where a move is going, for its destination letter: its `to` place, or (leaving the layout) where it leaves from. */
export function destinationOf(e: TimetableEntry): string {
  return e.kind === 'leave' ? e.from.placeId : e.to.placeId || e.from.placeId;
}

/**
 * Fill in headcodes / reporting numbers for the moves of a timetable that should carry one (each move
 * gets its own: a train that turns round runs back under a new number). `all` renumbers every move
 * and clears numbers from moves that carry none; otherwise only blank ones are filled. Returns how
 * many changed.
 */
export function fillHeadcodes(_state: AppState, layout: Layout, tt: Timetable, all: boolean): number {
  const era = eraOf(layout);
  const keep = all ? [] : tt.entries.map((e) => e.headcode);
  const alloc = new HeadcodeAllocator(era, layout, keep);
  let changed = 0;
  for (const e of tt.entries) {
    if (!wantsHeadcode(era, e)) {
      if (all && e.headcode && e.kind !== 'note') {
        e.headcode = '';
        changed++;
      }
      continue;
    }
    if (!all && e.headcode) continue;
    const h = alloc.next(e.trainTypeId, destinationOf(e), e.kind);
    if (h && h !== e.headcode) {
      e.headcode = h;
      changed++;
    }
  }
  return changed;
}
