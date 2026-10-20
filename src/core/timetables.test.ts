import { describe, expect, it } from 'vitest';
import { createDefaultState as shippedState } from './defaults';
import { migrate } from './store';
import {
  addTimetable,
  addTrain,
  applyStockPositions,
  duplicateTimetable,
  findTimetable,
  fmtTime,
  parseTime,
  posterTables,
  posterTime,
  routeBetween,
  sortByTime,
  stockPositions,
  thenEntry,
  walkTimetable,
} from './timetables';
import type { AppState } from './types';

const sgc = (s: AppState) => s.layouts[0];
const morning = (s: AppState) => findTimetable(s, 'tt-sgc-morning')!.tt;
const sequence = (s: AppState) => findTimetable(s, 'tt-sgc-sequence')!.tt;

describe('timetables', () => {
  it('ships two example timetables on Sigsim Central that check out clean', () => {
    const s = shippedState();
    expect(sgc(s).timetables!.map((t) => t.timing)).toEqual(['session', 'sequence']);
    for (const tt of [morning(s), sequence(s)]) {
      const w = walkTimetable(s, sgc(s), tt);
      const all = [...w.steps.flatMap((x) => x.issues.map((i) => `${x.entry.id}: ${i.text}`)), ...[...w.trainIssues.values()].flat().map((i) => i.text)];
      expect(all).toEqual([]);
      // Every loco already stands where the timetable starts it.
      expect(stockPositions(s, sgc(s), tt).every((p) => p.there)).toBe(true);
    }
    // The pick-up goods leaves while the Black Five shunts: they share a step in the sequence.
    const w = walkTimetable(s, sgc(s), sequence(s));
    const step = (id: string) => w.steps.find((x) => x.entry.id === id)!.step;
    expect(step('seq-pg1')).toBe(step('seq-st2'));
    expect(step('seq-st3')).toBe(step('seq-pg1') + 1);
  });

  it('finds routes through the signal boxes', () => {
    const s = shippedState();
    const l = sgc(s);
    const through = routeBetween(s, l, 'fy-west', 'fy-east')!;
    expect(through.map((x) => (x.kind === 'line' ? `${x.connectionId}:${x.dir}` : 'local'))).toEqual(['sgc-west:in', 'sgc-east:out']);
    const shunt = routeBetween(s, l, 'sgc-station', 'sgc-goods')!;
    expect(shunt).toHaveLength(1);
    expect(shunt[0].kind).toBe('local');
    const intoGoods = routeBetween(s, l, 'fy-west', 'sgc-goods')!;
    expect(intoGoods.map((x) => x.kind)).toEqual(['line', 'local']);
    expect(routeBetween(s, l, 'sgc-station', 'sgc-station')).toEqual([]);
    // A place no box works cannot be reached.
    l.places.push({ id: 'lonely', kind: 'sidings', name: 'Lonely sidings', shortName: '', notes: '', roads: [], workedBy: [] });
    expect(routeBetween(s, l, 'fy-west', 'lonely')).toBeNull();
  });

  it('flags a train starting where its last move did not leave it, a shunt over a line, and a double-booked loco', () => {
    const s = shippedState();
    const tt = morning(s);
    // The Stopper's light engine move now claims to start in platform 1.
    tt.entries.find((e) => e.id === 'st2')!.from = { placeId: 'sgc-station', roadId: 'sgc-p1' };
    let w = walkTimetable(s, sgc(s), tt);
    const st2 = w.steps.find((x) => x.entry.id === 'st2')!;
    expect(st2.issues.map((i) => i.code)).toContain('roadContinuity');
    tt.entries.find((e) => e.id === 'st2')!.from = { placeId: 'fy-east', roadId: '' };
    w = walkTimetable(s, sgc(s), tt);
    const codes = w.steps.find((x) => x.entry.id === 'st2')!.issues.map((i) => i.code);
    expect(codes).toContain('continuity');
    expect(codes).toContain('shuntOverLine');
    // The coal train's loco also works the pick-up goods.
    tt.trains.find((t) => t.id === 'tr-pickup')!.locoId = 'lms8233';
    w = walkTimetable(s, sgc(s), tt);
    expect(w.trainIssues.get('tr-pickup')?.map((i) => i.code)).toContain('doubleBooked');
  });

  it('chains the next move of a train from where it ended (terminus turnaround)', () => {
    const s = shippedState();
    const l = sgc(s);
    const tt = addTimetable(s, l.id, 'sequence')!;
    const { train, entry } = addTrain(s, l, tt, { locoId: 'lms5025' })!;
    expect(entry.from).toEqual({ placeId: 'fy-east', roadId: 'fye-road1' });
    entry.to = { placeId: 'sgc-station', roadId: 'sgc-p2' };
    const next = thenEntry(s, l, tt, train.id)!;
    expect(next.kind).toBe('shunt');
    expect(next.trainTypeId).toBe('light_engine');
    expect(next.from).toEqual({ placeId: 'sgc-station', roadId: 'sgc-p2' });
    next.to = { placeId: 'sgc-goods', roadId: 'sgc-shed' };
    const back = thenEntry(s, l, tt, train.id)!;
    back.to = { placeId: 'sgc-station', roadId: 'sgc-p2' };
    const home = thenEntry(s, l, tt, train.id)!;
    expect(home.kind).toBe('run');
    expect(home.trainTypeId).toBe('ordinary_passenger');
    home.to = { placeId: 'fy-east', roadId: 'fye-road1' };
    const w = walkTimetable(s, l, tt);
    expect(w.errors).toBe(0);
    expect(w.steps.map((x) => x.entry.trainTypeId)).toEqual(['ordinary_passenger', 'light_engine', 'light_engine', 'ordinary_passenger']);
    // Step through: after step 2 the loco is in the goods shed.
    expect(w.steps[1].after.get('lms5025')).toEqual({ kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-shed' });
  });

  it('reads and writes times', () => {
    expect(parseTime('15:00')).toBe(900);
    expect(parseTime('1500')).toBe(900);
    expect(parseTime('9.05')).toBe(545);
    expect(parseTime('9 05')).toBe(545);
    expect(parseTime('9')).toBe(540);
    expect(parseTime('')).toBeNull();
    expect(parseTime('25:00')).toBeNaN();
    expect(parseTime('+5')).toBe(5);
    expect(parseTime('+1:30')).toBe(90);
    expect(parseTime('90', true)).toBe(90);
    expect(fmtTime(545, { timing: 'clock', elapsed: false })).toBe('09:05');
    expect(fmtTime(90, { timing: 'session', elapsed: true })).toBe('+1:30');
    expect(posterTime(545, { timing: 'clock', elapsed: false })).toEqual({ text: '9.05', half: 'am' });
    expect(posterTime(13 * 60 + 5, { timing: 'clock', elapsed: false })).toEqual({ text: '1.05', half: 'pm' });
  });

  it('keeps timed timetables in time order', () => {
    const s = shippedState();
    const tt = morning(s);
    tt.entries.find((e) => e.id === 'cl2')!.dep = 9 * 60 + 1;
    sortByTime(tt);
    expect(tt.entries.map((e) => e.id).slice(0, 3)).toEqual(['ex1', 'cl2', 'st1']);
  });

  it('builds the poster: passenger trains by direction, the rest separately', () => {
    const s = shippedState();
    const tables = posterTables(s, sgc(s), morning(s), 'passenger');
    expect(tables.map((t) => t.title)).toEqual(['Fiddle Yard West to Fiddle Yard East', 'Fiddle Yard East to Fiddle Yard West']);
    expect(tables[0].rows.map((p) => p.id)).toEqual(['fy-west', 'sgc-station', 'fy-east']);
    expect(tables[0].cols.map((c) => c.entry.id)).toEqual(['ex1', 'st4']);
    expect(tables[0].cols[0].cells.get('sgc-station')?.pass).toBe(true);
    expect(tables[1].cols.map((c) => c.entry.id)).toEqual(['st1', 'ex2']);
    const goods = posterTables(s, sgc(s), morning(s), 'other');
    expect(goods.flatMap((t) => t.cols.map((c) => c.entry.id)).sort()).toEqual(['cl1', 'cl2', 'pg1', 'pg2']);
  });

  it('sets up stock positions and copies timetables', () => {
    const s = shippedState();
    const tt = morning(s);
    s.roster.find((l) => l.id === 'lms6233')!.location = { kind: 'offLayout' };
    const before = stockPositions(s, sgc(s), tt);
    expect(before.find((p) => p.loco?.id === 'lms6233')!.there).toBe(false);
    expect(applyStockPositions(s, sgc(s), tt)).toBe(1);
    expect(s.roster.find((l) => l.id === 'lms6233')!.location).toEqual({ kind: 'place', placeId: 'fy-west', roadId: 'fyw-road1' });
    const copy = duplicateTimetable(s, tt.id)!;
    expect(copy.name).toBe('Morning service (copy)');
    expect(copy.entries.every((e) => copy.trains.some((t) => t.id === e.trainId))).toBe(true);
    expect(walkTimetable(s, sgc(s), copy).errors).toBe(0);
  });

  it('older saves get an empty timetable list and keep their locos', () => {
    const old = shippedState() as unknown as { schemaVersion: number; layouts: Array<{ timetables?: unknown }>; roster: Array<{ jobs?: unknown }> };
    old.schemaVersion = 3;
    for (const l of old.layouts) delete l.timetables;
    for (const l of old.roster) delete l.jobs;
    const s = migrate(JSON.parse(JSON.stringify(old)));
    expect(s.schemaVersion).toBe(4);
    expect(s.layouts[0].timetables).toEqual([]);
    expect(s.roster).toHaveLength(8);
  });
});
