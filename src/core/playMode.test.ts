import { describe, expect, it } from 'vitest';
import { addConnection } from './boxes';
import { createDefaultState as shippedState, SCHEMA_VERSION } from './defaults';
import { addPlace, placesWorkedBy, setConnectionPlace, setWorker } from './places';
import {
  circuitLength,
  circuitLineSpeed,
  consistVehicles,
  DEFAULT_DIVERGING_SPEED,
  DEFAULT_LINE_SPEED,
  DEFAULT_SECTION_LENGTH,
  divergingSpeed,
  formatLength,
  formatSpeed,
  isShortCircuit,
  layoutLineSpeed,
  locoMaxSpeed,
  METRES_PER_CHAIN,
  METRES_PER_MILE,
  METRES_PER_YARD,
  MPS_PER_KMH,
  MPS_PER_MPH,
  parseLength,
  parseSpeed,
  SHORT_CIRCUIT_LENGTH,
  STATION_CIRCUIT_LENGTH,
  trainLength,
} from './railway';
import { FakeScheduler } from './scheduler';
import { createBoxSession } from './session';
import { migrate } from './store';
import { createBectonState } from './testState';
import { ThroughWorkings } from './throughTrains';
import { connectTrainEvents, createTrainSource, ReportedMovements, type RunningMode, type TrainEvent } from './trainEvents';
import type { AppState, BoxDef } from './types';

/** A box being worked with its lines opened, its train events wired in the given running mode. */
function worked(state: AppState, box: BoxDef, mode: RunningMode = 'model') {
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  const sched = new FakeScheduler();
  const sessions = createBoxSession(box, () => state, sched);
  for (const s of sessions) {
    s.controller.events.on('locoMoved', (m) => {
      const l = state.roster.find((x) => x.id === m.locoId);
      if (l) l.location = m.location;
    });
    s.neighbour!.start();
  }
  const workings = new ThroughWorkings(sessions, {
    worksPlaces: () => placesWorkedBy(state, box.id).length > 0,
    codeSet: () => state.codeSets[0],
    trainTypes: () => state.trainTypes,
    locoLabel: (id) => id,
  });
  const trains = connectTrainEvents(mode, sessions, workings);
  const tick = (ms = 4000) => sched.advance(ms);
  for (const s of sessions) {
    s.controller.sendBell('1');
    tick();
    s.controller.sendBell('5-5-5');
    tick(8000);
  }
  const ctrl = (connId: string) => sessions.find((s) => s.connection.id === connId)!.controller;
  return { sessions, workings, trains, tick, ctrl, report: (e: TrainEvent) => trains.source.report(e) };
}

/** Accept the train offered on a line and acknowledge its Train entering section: it is on its way to the box. */
function acceptAndAwait(t: ReturnType<typeof worked>, connId: string, code: string) {
  const c = t.ctrl(connId);
  t.tick();
  c.sendBell('1');
  t.tick();
  c.sendBell(code);
  c.setInstrument('LC');
  t.tick(8000);
  c.sendBell('2');
  c.setInstrument('TOL');
  t.tick();
  expect(c.view.incoming?.departed).toBe(true);
}

describe('source of train events (the seam)', () => {
  it('model railway mode: the person reports an arrival into a road through the source, once only', () => {
    const state = shippedState();
    const t = worked(state, state.boxes[0]);
    const west = t.ctrl('sgc-west');
    expect(west.requestIncoming('lms8233', 'mineral')).toBeNull();
    acceptAndAwait(t, 'sgc-west', '4-1');
    const at = { placeId: 'sgc-station', roadId: state.layouts[0].places.find((p) => p.id === 'sgc-station')!.roads[1].id };
    expect(t.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms8233', at, by: 'person' })).toBe('applied');
    expect(west.view.incoming?.arrived).toBe(true);
    expect(state.roster.find((l) => l.id === 'lms8233')!.location).toEqual({ kind: 'place', ...at });
    // Arrival reports count once: a second press (or a simulated operator as well) is ignored.
    expect(t.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms8233', at: { placeId: 'sgc-station', roadId: '' }, by: 'person' })).toBe('ignored');
    expect(state.roster.find((l) => l.id === 'lms8233')!.location).toEqual({ kind: 'place', ...at });
    // Train out of section as usual.
    west.sendBell('1');
    t.tick();
    west.sendBell('2-1');
    t.tick();
    west.setInstrument('LB');
    t.tick();
    expect(west.view.incoming).toBeNull();
  });

  it('a departure reported arrived at the far place goes through the source; the far box clears it back', () => {
    const state = shippedState();
    const t = worked(state, state.boxes[0]);
    const east = t.ctrl('sgc-east');
    east.setOutgoing('lms7298', 'pickup_goods');
    east.sendBell('1');
    t.tick();
    east.sendBell('3');
    t.tick();
    east.sendBell('2');
    t.tick();
    expect(east.view.outgoing?.departed).toBe(true);
    expect(t.report({ type: 'arrivedFar', connectionId: 'sgc-east', locoId: 'lms7298', roadId: 'fye-road4', by: 'person' })).toBe('applied');
    expect(t.report({ type: 'arrivedFar', connectionId: 'sgc-east', locoId: 'lms7298', roadId: 'fye-road5', by: 'fiddleYardOperator' })).toBe('ignored');
    t.tick(5000);
    east.sendBell('1');
    t.tick();
    east.sendBell('2-1');
    t.tick();
    expect(east.view.outgoing).toBeNull();
    expect(state.roster.find((l) => l.id === 'lms7298')!.location).toEqual({ kind: 'place', placeId: 'fy-east', roadId: 'fye-road4' });
  });

  it('a through train reported passed complete stays in the section ahead', () => {
    // Becton (works no place) between the fiddle yard and Tansley Spa: trains are sent on.
    const state = createBectonState();
    const box = state.boxes[0];
    const toC = addConnection(state, box)!;
    toC.neighbourName = 'Tansley Spa';
    toC.neighbourShort = 'TS';
    const ts = addPlace(state, 'layout1', 'station', { name: 'Tansley Spa', roads: 2 })!;
    setConnectionPlace(state, box, toC, ts.id);
    for (const p of placesWorkedBy(state, box.id)) setWorker(p, { kind: 'box', boxId: box.id }, false);
    const t = worked(state, box);
    const a = t.ctrl('becton-fy');
    const c = t.ctrl(toC.id);
    expect(t.workings.route('becton-fy')).toBe(toC.id);
    expect(a.requestIncoming('ex1', 'express_passenger')).toBeNull();
    t.tick();
    a.sendBell('1');
    t.tick();
    a.sendBell('4');
    a.setInstrument('LC');
    t.tick(500);
    c.sendBell('1');
    t.tick();
    c.sendBell('4');
    t.tick(8000);
    a.sendBell('2');
    a.setInstrument('TOL');
    t.tick();
    c.sendBell('2');
    t.tick();
    expect(t.workings.through('becton-fy')?.stage).toBe('sentOn');
    // Tail lamp seen: "Train passed complete" (no road: it is not stopping here).
    expect(t.report({ type: 'passed', connectionId: 'becton-fy', locoId: 'ex1', by: 'person' })).toBe('applied');
    expect(a.view.incoming?.arrived).toBe(true);
    expect(state.roster.find((l) => l.id === 'ex1')!.location).toEqual({ kind: 'section', connectionId: toC.id });
  });

  it('a through train arriving before it is sent on stands at the box (any road reported is not used)', () => {
    const state = createBectonState();
    const box = state.boxes[0];
    const toC = addConnection(state, box)!;
    const ts = addPlace(state, 'layout1', 'station', { name: 'Tansley Spa', roads: 2 })!;
    setConnectionPlace(state, box, toC, ts.id);
    for (const p of placesWorkedBy(state, box.id)) setWorker(p, { kind: 'box', boxId: box.id }, false);
    const t = worked(state, box);
    const a = t.ctrl('becton-fy');
    a.requestIncoming('ex1', 'express_passenger');
    acceptAndAwait(t, 'becton-fy', '4');
    expect(t.report({ type: 'arrived', connectionId: 'becton-fy', locoId: 'ex1', at: { placeId: 'becton-station', roadId: 'becton-p1' }, by: 'person' })).toBe('applied');
    expect(t.workings.through('becton-fy')?.stage).toBe('standing');
    expect(state.roster.find((l) => l.id === 'ex1')!.location).toEqual({ kind: 'atBox', boxId: 'becton' });
  });

  it('later-stage events and requests are declared but not used yet; unknown lines are refused', () => {
    const state = shippedState();
    const t = worked(state, state.boxes[0]);
    const seen: string[] = [];
    t.trains.router.onApplied((e, o) => seen.push(`${e.type}:${o}`));
    expect(t.report({ type: 'enteredCircuit', circuitId: 'sgc-t1', locoId: null, by: 'detection' })).toBe('notUsed');
    expect(t.report({ type: 'clearedCircuit', circuitId: 'sgc-t1', locoId: null, by: 'railway' })).toBe('notUsed');
    expect(t.report({ type: 'stopped', circuitId: 'sgc-t4', locoId: 'lms5025', by: 'railway' })).toBe('notUsed');
    expect(t.report({ type: 'arrived', connectionId: 'nowhere', locoId: null, at: null, by: 'person' })).toBe('unknownLine');
    // Nothing waiting on the line: ignored.
    expect(t.report({ type: 'arrived', connectionId: 'sgc-west', locoId: null, at: null, by: 'person' })).toBe('ignored');
    expect(seen).toEqual(['enteredCircuit:notUsed', 'clearedCircuit:notUsed', 'stopped:notUsed', 'arrived:unknownLine', 'arrived:ignored']);
    for (const r of [
      { type: 'releaseIntoSection', connectionId: 'sgc-west', locoId: null },
      { type: 'setPoints', junctionId: 'sgc-j1', lie: 'reverse' },
      { type: 'clearSignal', signalId: 's1', clear: true },
    ] as const)
      expect(t.trains.source.request(r)).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('the running mode belongs to the box session; any source can feed the router', () => {
    const state = shippedState();
    expect(worked(state, state.boxes[0], 'model').trains.mode).toBe('model');
    const play = worked(shippedState(), shippedState().boxes[0], 'play');
    expect(play.trains.mode).toBe('play');
    // The mode is not stored on the layout or the box.
    expect(JSON.stringify(state)).not.toMatch(/"mode"|runningMode/);
    expect(createTrainSource('model')).toBeInstanceOf(ReportedMovements);
    // After disposal, reports go nowhere.
    play.trains.dispose();
    expect(play.report({ type: 'arrived', connectionId: 'sgc-west', locoId: null, at: null, by: 'person' })).toBe('ignored');
  });
});

describe('real-railway data: lengths and speeds', () => {
  const sgc = () => {
    const s = shippedState();
    return { s, l: s.layouts[0], c: (code: string) => s.layouts[0].trackPlan.circuits.find((x) => x.code === code)! };
  };

  it('Sigsim Central with no values given: sections share 2 miles, station circuits 220 yd, short ones 55 yd', () => {
    const { s, l, c } = sgc();
    for (const code of ['T1', 'T2', 'T10', 'T11']) expect(circuitLength(s, l, c(code))).toEqual({ metres: METRES_PER_MILE, basis: 'section' });
    for (const code of ['T3', 'T6', 'T7']) expect(circuitLength(s, l, c(code))).toEqual({ metres: SHORT_CIRCUIT_LENGTH, basis: 'short' });
    for (const code of ['T4', 'T5', 'T8', 'T9']) expect(circuitLength(s, l, c(code))).toEqual({ metres: STATION_CIRCUIT_LENGTH, basis: 'ordinary' });
    expect(DEFAULT_SECTION_LENGTH).toBeCloseTo(3218.688, 6);
    expect(STATION_CIRCUIT_LENGTH).toBeCloseTo(10 * METRES_PER_CHAIN, 6);
    expect(SHORT_CIRCUIT_LENGTH).toBeCloseTo(2.5 * METRES_PER_CHAIN, 6);
    expect(circuitLength(s, l, 'sgc-t4').basis).toBe('ordinary');
  });

  it('stated lengths win; the rest of the line shares what is left of the section', () => {
    const { s, l, c } = sgc();
    s.boxes[0].connections.find((x) => x.id === 'sgc-west')!.sectionLength = 3 * METRES_PER_MILE;
    expect(circuitLength(s, l, c('T1')).metres).toBeCloseTo(1.5 * METRES_PER_MILE, 6);
    c('T1').length = 400;
    expect(circuitLength(s, l, c('T1'))).toEqual({ metres: 400, basis: 'stated' });
    expect(circuitLength(s, l, c('T2')).metres).toBeCloseTo(3 * METRES_PER_MILE - 400, 6);
    // A stated length longer than the section: the others are never shorter than a short circuit.
    c('T1').length = 10_000;
    expect(circuitLength(s, l, c('T2')).metres).toBe(SHORT_CIRCUIT_LENGTH);
    c('T6').length = 120;
    expect(circuitLength(s, l, c('T6'))).toEqual({ metres: 120, basis: 'stated' });
  });

  it("a double line's up and down lines each run the whole section", () => {
    const { s, l, c } = sgc();
    c('T1').traffic = { line: 'up', toward: 1 };
    c('T2').traffic = { line: 'down', toward: 0 };
    expect(circuitLength(s, l, c('T1')).metres).toBeCloseTo(DEFAULT_SECTION_LENGTH, 6);
    expect(circuitLength(s, l, c('T2')).metres).toBeCloseTo(DEFAULT_SECTION_LENGTH, 6);
  });

  it('short circuits: both ends on point-work, or named as a neck, throat or release; never a road or platform', () => {
    const { s, l, c } = sgc();
    void s;
    expect(isShortCircuit(l, c('T3'))).toBe(true); // between points 1 and 2
    expect(isShortCircuit(l, c('T6'))).toBe(true); // points 2 to catch points 5
    expect(isShortCircuit(l, c('T4'))).toBe(false); // platform road between points
    expect(isShortCircuit(l, c('T8'))).toBe(false); // a goods road
    expect(isShortCircuit(l, c('T1'))).toBe(false); // line circuit
    // Named as a loco release, even with a buffer stop at one end.
    c('T9').name = 'Loco release';
    l.places.find((p) => p.id === 'sgc-goods')!.roads.forEach((r) => r.circuitId === 'sgc-t9' && delete r.circuitId);
    expect(isShortCircuit(l, c('T9'))).toBe(true);
  });

  it('speeds: the layout default, circuit overrides, diverging speed of points, loco maximum', () => {
    const { s, l, c } = sgc();
    expect(layoutLineSpeed(l)).toBeCloseTo(60 * MPS_PER_MPH, 9);
    expect(circuitLineSpeed(l, c('T4'))).toBe(DEFAULT_LINE_SPEED);
    l.lineSpeed = parseSpeed('40 mph')!;
    c('T6').lineSpeed = parseSpeed('10 mph')!;
    expect(formatSpeed(circuitLineSpeed(l, c('T4')), 'imperial')).toBe('40 mph');
    expect(formatSpeed(circuitLineSpeed(l, c('T6')), 'imperial')).toBe('10 mph');
    const pts = l.trackPlan.junctions.find((j) => j.kind !== 'joint')!;
    expect(divergingSpeed(pts)).toBe(DEFAULT_DIVERGING_SPEED);
    pts.divergingSpeed = parseSpeed('25 km/h')!;
    expect(formatSpeed(divergingSpeed(pts), 'metric')).toBe('25 km/h');
    const duchess = s.roster.find((x) => x.id === 'lms6233')!;
    expect(locoMaxSpeed(duchess)).toBeNull();
    duchess.maxSpeed = parseSpeed('90')!;
    expect(formatSpeed(locoMaxSpeed(duchess)!, 'imperial')).toBe('90 mph');
  });

  it('train length: stated, else the loco and the vehicles its consist names', () => {
    const s = shippedState();
    const loco = s.roster.find((l) => l.id === 'lms5025')!;
    loco.working.consist = '4 coaches + brake van';
    expect(consistVehicles(loco.working.consist).map((v) => `${v.count} ${v.kind}`)).toEqual(['4 coach', '1 brake van']);
    expect(trainLength(loco)).toBe(20 + 4 * 20 + 8);
    loco.working.consist = 'six wagons, a brake van';
    expect(trainLength(loco)).toBe(20 + 6 * 6 + 8);
    loco.working.consist = '';
    expect(trainLength(loco)).toBe(20); // light engine
    loco.working.length = 150;
    expect(trainLength(loco)).toBe(150);
    const jinty = s.roster.find((l) => l.id === 'lms7298')!;
    jinty.working.consist = 'auto-coach';
    expect(trainLength(jinty)).toBe(11); // as a light engine it has nothing behind it
    jinty.working.trainTypeId = 'branch_passenger';
    expect(trainLength(jinty)).toBe(11 + 19);
    jinty.powerType = 'DMU';
    jinty.working.consist = '2-car';
    expect(trainLength(jinty)).toBe(40);
  });

  it('reads lengths and speeds typed in either system, and shows them in the chosen units', () => {
    expect(parseLength('2 mi 40 ch')).toBeCloseTo(2.5 * METRES_PER_MILE, 6);
    expect(parseLength('10 ch')).toBeCloseTo(STATION_CIRCUIT_LENGTH, 6);
    expect(parseLength('2½ ch')).toBeCloseTo(SHORT_CIRCUIT_LENGTH, 6);
    expect(parseLength('2 1/2 chains')).toBeCloseTo(SHORT_CIRCUIT_LENGTH, 6);
    expect(parseLength('220 yd')).toBeCloseTo(220 * METRES_PER_YARD, 6);
    expect(parseLength('200 m')).toBe(200);
    expect(parseLength('1.2 km')).toBe(1200);
    expect(parseLength('12m 40ch')).toBeCloseTo(12.5 * METRES_PER_MILE, 6); // railway mileage: m = miles beside chains
    expect(parseLength('1/2 mi')).toBeCloseTo(METRES_PER_MILE / 2, 6);
    expect(parseLength('3', 'mi')).toBeCloseTo(3 * METRES_PER_MILE, 6);
    for (const bad of ['', 'far', '2 mi far', '0 m', '-3 m', '2 40 ch']) expect(parseLength(bad)).toBeNull();
    expect(parseSpeed('25 mph')).toBeCloseTo(25 * MPS_PER_MPH, 9);
    expect(parseSpeed('40 km/h')).toBeCloseTo(40 * MPS_PER_KMH, 9);
    expect(parseSpeed('40 kph')).toBeCloseTo(40 * MPS_PER_KMH, 9);
    expect(parseSpeed('60', 'km/h')).toBeCloseTo(60 * MPS_PER_KMH, 9);
    expect(parseSpeed('fast')).toBeNull();
    expect(formatLength(DEFAULT_SECTION_LENGTH, 'imperial', 'section')).toBe('2 mi');
    expect(formatLength(2.5 * METRES_PER_MILE, 'imperial', 'section')).toBe('2 mi 40 ch');
    expect(formatLength(STATION_CIRCUIT_LENGTH, 'imperial', 'section')).toBe('10 ch');
    expect(formatLength(STATION_CIRCUIT_LENGTH, 'imperial')).toBe('220 yd');
    expect(formatLength(SHORT_CIRCUIT_LENGTH, 'imperial')).toBe('55 yd');
    expect(formatLength(DEFAULT_SECTION_LENGTH, 'metric', 'section')).toBe('3.22 km');
    expect(formatLength(800, 'metric', 'section')).toBe('800 m');
    expect(formatLength(STATION_CIRCUIT_LENGTH, 'metric')).toBe('201 m');
    expect(formatSpeed(DEFAULT_LINE_SPEED, 'imperial')).toBe('60 mph');
    expect(formatSpeed(DEFAULT_LINE_SPEED, 'metric')).toBe('97 km/h');
  });
});

describe('saved data with real-railway values', () => {
  it('a fresh install and Becton-style data load unchanged apart from the schema and the units setting', () => {
    for (const make of [shippedState, createBectonState]) {
      const before = make();
      const old = JSON.parse(JSON.stringify(before));
      old.schemaVersion = 4;
      delete old.settings.units;
      const s = migrate(old);
      expect(s.schemaVersion).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
      expect(s.settings.units).toBe('imperial');
      // Nothing is filled in: lengths and speeds stay absent, so the defaults apply.
      expect(JSON.stringify(s)).not.toMatch(/"(sectionLength|length|lineSpeed|divergingSpeed|maxSpeed)"/);
      if (make === shippedState) {
        expect(s.layouts).toEqual(before.layouts);
        expect(s.boxes).toEqual(before.boxes);
        expect(s.roster).toEqual(before.roster);
      } else {
        // The Becton data (no timetables or markers yet) keeps its places, plan, boxes and roster.
        expect(s.layouts[0].places).toEqual(before.layouts[0].places);
        expect(s.layouts[0].trackPlan.circuits).toEqual(before.layouts[0].trackPlan.circuits);
        expect(s.boxes).toEqual(before.boxes);
        expect(s.roster).toEqual(before.roster);
      }
    }
  });

  it('keeps usable values and drops unusable ones (so the defaults apply)', () => {
    const raw = JSON.parse(JSON.stringify(shippedState()));
    raw.settings.units = 'metric';
    raw.boxes[0].connections[0].sectionLength = 4000;
    raw.boxes[0].connections[1].sectionLength = -1;
    raw.layouts[0].lineSpeed = 'fast';
    raw.layouts[0].trackPlan.circuits[0].length = 500;
    raw.layouts[0].trackPlan.circuits[1].lineSpeed = 0;
    raw.layouts[0].trackPlan.junctions[2].divergingSpeed = 6.7;
    raw.roster[0].maxSpeed = 40;
    raw.roster[1].working.length = null;
    const s = migrate(raw);
    expect(s.settings.units).toBe('metric');
    expect(s.boxes[0].connections[0].sectionLength).toBe(4000);
    expect('sectionLength' in s.boxes[0].connections[1]).toBe(false);
    expect('lineSpeed' in s.layouts[0]).toBe(false);
    expect(s.layouts[0].trackPlan.circuits[0].length).toBe(500);
    expect('lineSpeed' in s.layouts[0].trackPlan.circuits[1]).toBe(false);
    expect(s.layouts[0].trackPlan.junctions[2].divergingSpeed).toBe(6.7);
    expect(s.roster[0].maxSpeed).toBe(40);
    expect('length' in s.roster[1].working).toBe(false);
    // Survives a save and load.
    expect(migrate(JSON.parse(JSON.stringify(s)))).toEqual(s);
    raw.settings.units = 'furlongs';
    expect(migrate(raw).settings.units).toBe('imperial');
  });
});
