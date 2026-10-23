import { DEFAULT_CODE_SETS, DEFAULT_TRAIN_TYPES } from './bellcodes';
import { DEFAULT_CLEARING_POINT } from './railway';
import type { AppState, Junction, Settings, Timetable, TimetableEntry, TrackCircuit, TrackPlan } from './types';

/**
 * 3: places (stations, sidings, goods, depots, fiddle yards) on layouts (v0.3.14). 4: timetables and loco jobs (v0.3.24).
 * 5: optional real-railway lengths and speeds, and the units setting (v0.3.27; nothing needs filling in).
 * 6: simulated running settings and rakes of stock left standing on a layout (v0.3.28; nothing needs filling in).
 * 7: signals on track plans, facing point locks and lever numbers (v0.3.29; nothing needs filling in).
 * 8: rolling stock (v0.3.38): each layout's library types, fleet and rakes; stock left standing in play mode is
 *    individual vehicles (older anonymous standing stock is dropped on load, D14/D19).
 */
export const SCHEMA_VERSION = 8;

/** Name given to the layout made from a save that predates layouts, when it had no layout name. */
export const FALLBACK_LAYOUT_NAME = 'My layout';

export const DEFAULT_SETTINGS: Settings = {
  activeLayoutId: 'layout1',
  theme: 'device',
  strictness: 'learner',
  codeSetId: 'br1960',
  workingModes: {},
  selectionMode: 'manual',
  tap: { groupGapMs: 450, codeEndMs: 1400, holdMs: 900 },
  volume: 0.8,
  tapperClick: true,
  vibrate: true,
  showReceivedCodeText: true,
  responseDelayMs: [1200, 2800],
  despatchDelayMs: [6000, 12000],
  repeatAfterMs: 20000,
  offerRefusedAfterMs: 15000,
  reofferAfterMs: 60000,
  coincidingOffers: false,
  bellBeatMs: 260,
  bellGroupPauseMs: 750,
  bellSoundDataUrl: '',
  bellSynth: false,
  scoring: true,
  boxDiagram: false,
  diagramLabels: 'codes',
  showRoutes: true,
  units: 'imperial',
  simSpeed: 13.4112, // 30 mph
  timeScale: 1,
  modelOccupancy: false,
};

/*
 * The app's starting data (also what Settings → Reset to defaults restores): a generic example,
 * not anyone's own layout. SIGSIM CENTRAL is a station on a single line with a passing loop
 * (platforms 1 and 2), a goods siding and goods shed, between Fiddle Yard West and Fiddle Yard
 * East (six roads each), each worked by a simulated signal box. The roster has eight LMS and
 * ex-Midland locomotives of different classes, standing where they can be offered in from either
 * end or sent away from the goods yard, each with timetable jobs.
 */
const BOX = 'sigsim-central';
const WEST = 'sgc-west';
const EAST = 'sgc-east';

export function createDefaultState(): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
    trainTypes: structuredClone(DEFAULT_TRAIN_TYPES),
    codeSets: structuredClone(DEFAULT_CODE_SETS),
    boxes: [
      {
        id: BOX,
        name: 'Sigsim Central',
        shortName: 'SGC',
        layoutId: 'layout1',
        description: 'Station on a single line with a passing loop (platforms 1 and 2) and a goods yard, between Fiddle Yard West and Fiddle Yard East.',
        shelfPositions: 3,
        connections: [
          { id: WEST, neighbourName: 'Fiddle Yard West', neighbourShort: 'FYW', lineType: 'single', placeId: 'fy-west', defaultWorking: 'ab', shelfPosition: 0 },
          { id: EAST, neighbourName: 'Fiddle Yard East', neighbourShort: 'FYE', lineType: 'single', placeId: 'fy-east', defaultWorking: 'ab', shelfPosition: 2 },
        ],
      },
    ],
    layouts: [
      {
        id: 'layout1',
        name: 'Sigsim Central',
        running: 'left',
        places: [
          {
            id: 'fy-west',
            kind: 'fiddleYard',
            name: 'Fiddle Yard West',
            shortName: 'FYW',
            notes: '',
            roads: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `fyw-road${n}`, name: `Road ${n}`, notes: '' })),
            workedBy: [{ kind: 'remote', boxId: BOX, connectionId: WEST }],
          },
          {
            id: 'sgc-station',
            kind: 'station',
            name: 'Sigsim Central',
            shortName: 'SGC',
            notes: 'A passing loop: trains from each end can pass here, or terminate and go back the way they came.',
            roads: [
              { id: 'sgc-p1', name: 'P1', notes: 'Main line platform.', circuitId: 'sgc-t4' },
              { id: 'sgc-p2', name: 'P2', notes: 'Loop platform.', circuitId: 'sgc-t5' },
            ],
            workedBy: [{ kind: 'box', boxId: BOX }],
          },
          {
            id: 'sgc-goods',
            kind: 'goods',
            name: 'Sigsim Central goods yard',
            shortName: 'GDS',
            notes: 'Reached from the main line at the west end of the station, through catch points that protect the main line. The station pilot stables here.',
            roads: [
              { id: 'sgc-siding', name: 'Goods siding', notes: '', circuitId: 'sgc-t8' },
              { id: 'sgc-shed', name: 'Goods shed', notes: 'Road through the goods shed.', circuitId: 'sgc-t9' },
            ],
            workedBy: [{ kind: 'box', boxId: BOX }],
          },
          {
            id: 'fy-east',
            kind: 'fiddleYard',
            name: 'Fiddle Yard East',
            shortName: 'FYE',
            notes: '',
            roads: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `fye-road${n}`, name: `Road ${n}`, notes: '' })),
            workedBy: [{ kind: 'remote', boxId: BOX, connectionId: EAST }],
          },
        ],
        trackPlan: sigsimCentralPlan(),
        timetables: sigsimCentralTimetables(),
      },
    ],
    roster: [
      {
        id: 'lms6233',
        number: '6233',
        name: 'Duchess of Sutherland',
        locoClass: 'LMS Princess Coronation 4-6-2',
        powerType: 'Steam (tender)',
        dccAddress: '6233',
        notes: 'Example entry: express passenger engine.',
        working: { trainTypeId: 'express_passenger', consist: '6 coaches', headcode: '' },
        location: { kind: 'place', placeId: 'fy-west', roadId: 'fyw-road1' },
        jobs: [{ id: 'job-6233-1', duty: 'express', trainTypeId: '', placeIds: ['fy-west', 'fy-east'], weight: 3 }],
        homePlaceId: 'fy-west',
      },
      {
        id: 'lms5025',
        number: '5025',
        name: '',
        locoClass: 'LMS Stanier Class 5 4-6-0 ("Black Five")',
        powerType: 'Steam (tender)',
        dccAddress: '5025',
        notes: 'Example entry: mixed traffic engine: passenger or goods.',
        working: { trainTypeId: 'ordinary_passenger', consist: '4 coaches', headcode: '' },
        location: { kind: 'place', placeId: 'fy-east', roadId: 'fye-road1' },
        jobs: [
          // Mixed traffic: anything, passenger or goods.
          { id: 'job-5025-1', duty: 'stopping', trainTypeId: '', placeIds: ['fy-east', 'sgc-station'], weight: 3 },
          { id: 'job-5025-2', duty: 'express', trainTypeId: '', placeIds: [], weight: 1 },
          { id: 'job-5025-3', duty: 'parcels', trainTypeId: '', placeIds: [], weight: 1 },
          { id: 'job-5025-4', duty: 'expressGoods', trainTypeId: '', placeIds: [], weight: 2 },
          { id: 'job-5025-5', duty: 'goods', trainTypeId: '', placeIds: [], weight: 1 },
        ],
        homePlaceId: 'fy-east',
      },
      {
        id: 'lms8233',
        number: '8233',
        name: '',
        locoClass: 'LMS Stanier 8F 2-8-0',
        powerType: 'Steam (tender)',
        dccAddress: '8233',
        notes: 'Example entry: heavy freight engine.',
        working: { trainTypeId: 'mineral', consist: 'Coal wagons', headcode: '' },
        location: { kind: 'place', placeId: 'fy-west', roadId: 'fyw-road2' },
        jobs: [
          { id: 'job-8233-1', duty: 'goods', trainTypeId: 'mineral', placeIds: ['fy-west', 'sgc-goods'], weight: 3 },
          { id: 'job-8233-2', duty: 'goods', trainTypeId: '', placeIds: [], weight: 1 },
          { id: 'job-8233-3', duty: 'expressGoods', trainTypeId: '', placeIds: [], weight: 1 },
        ],
        homePlaceId: 'fy-west',
      },
      {
        id: 'lms7298',
        number: '7298',
        name: '',
        locoClass: 'LMS Fowler 3F 0-6-0T ("Jinty")',
        powerType: 'Steam (tank)',
        dccAddress: '7298',
        notes: 'Example entry: station pilot and goods yard shunter.',
        working: { trainTypeId: 'light_engine', consist: '', headcode: '' },
        location: { kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-siding' },
        jobs: [
          { id: 'job-7298-1', duty: 'pilot', trainTypeId: '', placeIds: ['sgc-station', 'sgc-goods'], weight: 3 },
          { id: 'job-7298-2', duty: 'pickup', trainTypeId: '', placeIds: ['sgc-goods', 'fy-east'], weight: 2 },
        ],
        homePlaceId: 'sgc-goods',
      },
      {
        id: 'lms5690',
        number: '5690',
        name: 'Leander',
        locoClass: 'LMS Stanier Jubilee 4-6-0',
        powerType: 'Steam (tender)',
        dccAddress: '5690',
        notes: 'Example entry: express passenger engine, also works parcels.',
        working: { trainTypeId: 'express_passenger', consist: '7 coaches', headcode: '' },
        location: { kind: 'place', placeId: 'fy-east', roadId: 'fye-road5' },
        jobs: [
          { id: 'job-5690-1', duty: 'express', trainTypeId: '', placeIds: ['fy-east', 'fy-west'], weight: 2 },
          { id: 'job-5690-2', duty: 'parcels', trainTypeId: '', placeIds: ['fy-east', 'fy-west'], weight: 1 },
        ],
        homePlaceId: 'fy-east',
      },
      {
        id: 'lms2700',
        number: '2700',
        name: '',
        locoClass: 'LMS Hughes/Fowler 2-6-0 ("Crab")',
        powerType: 'Steam (tender)',
        dccAddress: '2700',
        notes: 'Example entry: mixed traffic engine, mostly on goods.',
        working: { trainTypeId: 'freight_fitted_half', consist: 'Vans', headcode: '' },
        location: { kind: 'place', placeId: 'fy-west', roadId: 'fyw-road3' },
        jobs: [
          // Mixed traffic, mostly goods.
          { id: 'job-2700-1', duty: 'expressGoods', trainTypeId: '', placeIds: ['fy-west', 'fy-east'], weight: 3 },
          { id: 'job-2700-2', duty: 'goods', trainTypeId: '', placeIds: [], weight: 2 },
          { id: 'job-2700-3', duty: 'pickup', trainTypeId: '', placeIds: [], weight: 1 },
          { id: 'job-2700-4', duty: 'stopping', trainTypeId: '', placeIds: [], weight: 1 },
          { id: 'job-2700-5', duty: 'parcels', trainTypeId: '', placeIds: [], weight: 1 },
        ],
        homePlaceId: 'fy-west',
      },
      {
        id: 'lms542',
        number: '542',
        name: '',
        locoClass: 'ex-MR 483 Class 2P 4-4-0',
        powerType: 'Steam (tender)',
        dccAddress: '542',
        notes: 'Example entry: stopping passenger engine, also moves empty stock.',
        working: { trainTypeId: 'ordinary_passenger', consist: '3 coaches', headcode: '' },
        location: { kind: 'place', placeId: 'fy-west', roadId: 'fyw-road4' },
        jobs: [
          { id: 'job-542-1', duty: 'stopping', trainTypeId: '', placeIds: ['fy-west', 'sgc-station'], weight: 3 },
          { id: 'job-542-2', duty: 'parcels', trainTypeId: '', placeIds: [], weight: 1 },
        ],
        homePlaceId: 'fy-west',
      },
      {
        id: 'lms3436',
        number: '3436',
        name: '',
        locoClass: 'ex-MR Johnson 3F 0-6-0',
        powerType: 'Steam (tender)',
        dccAddress: '3436',
        notes: 'Example entry: goods engine for the pick-up goods and coal.',
        working: { trainTypeId: 'pickup_goods', consist: 'Mixed wagons', headcode: '' },
        location: { kind: 'place', placeId: 'fy-east', roadId: 'fye-road6' },
        jobs: [
          { id: 'job-3436-1', duty: 'pickup', trainTypeId: '', placeIds: ['fy-east', 'sgc-goods'], weight: 3 },
          { id: 'job-3436-2', duty: 'goods', trainTypeId: '', placeIds: [], weight: 1 },
        ],
        homePlaceId: 'fy-east',
      },
    ],
  };
}

/**
 * Sigsim Central's track plan (grid units, y downwards). West to east: the single line from Fiddle
 * Yard West in two track circuits (far and near, ready for trains to be shown moving through the
 * section), points 1 into the passing loop, points 2 to the goods yard, platform 1 on the main line
 * and platform 2 on the loop (an island platform between them), points 4 where the loop rejoins,
 * and the single line to Fiddle Yard East, again in two track circuits. The goods yard neck has
 * catch points (5) protecting the main line from anything running away out of the yard, then
 * points 3 to the goods siding and the goods shed road.
 */
/** Sigsim Central's station limits at each end: a quarter of a mile (440 yd) inside the home signals. */
const STATION_LIMIT = DEFAULT_CLEARING_POINT;

function sigsimCentralPlan(): TrackPlan {
  const box = { kind: 'box', boxId: BOX } as const;
  const west = { kind: 'line', boxId: BOX, connectionId: WEST } as const;
  const east = { kind: 'line', boxId: BOX, connectionId: EAST } as const;
  const j = (id: string, number: string, kind: Junction['kind'], x: number, y: number, o: { rotate?: boolean; mirror?: boolean } = {}): Junction => ({ id, number, kind, boxId: BOX, x, y, rotate: !!o.rotate, mirror: !!o.mirror, quarter: false });
  // Joints between the two track circuits of a block section belong to no box.
  const joint = (id: string, x: number, y: number): Junction => ({ id, number: '', kind: 'joint', boxId: '', x, y, rotate: false, mirror: false, quarter: false });
  const at = (junctionId: string, port: string) => ({ kind: 'joined', junctionId, port }) as const;
  const c = (id: string, code: string, name: string, owner: TrackCircuit['owner'], ends: TrackCircuit['ends'], extra: Partial<TrackCircuit> = {}): TrackCircuit => ({ id, code, name, owner, ends, ...extra });
  return {
    junctions: [
      joint('sgc-jw', 1, 0), // between the west line's two track circuits
      joint('sgc-jwi', 6, 0), // the west line ends: station limits begin (the home signal stands here)
      j('sgc-j1', '1', 'pointsRight', 12, 0), // into the loop
      j('sgc-j2', '2', 'pointsLeft', 18, 0), // to the goods yard
      // Trap points, turned round so the blade faces west: anything running out of the yard towards points 2
      // is derailed (away from the main line) unless they are set for it; trains entering the yard pass them trailing.
      j('sgc-j5', '5', 'catchPoints', 24, -3, { rotate: true }),
      j('sgc-j3', '3', 'pointsLeft', 27, -3), // goods siding / goods shed
      j('sgc-j4', '4', 'pointsLeft', 38, 0, { rotate: true }), // loop rejoins the main line
      joint('sgc-jei', 44, 0), // station limits end: the east line begins (the home signal from the east stands here)
      joint('sgc-je', 49, 0), // between the east line's two track circuits
    ],
    circuits: [
      c('sgc-t1', 'T1', 'West far', west, [{ kind: 'exit', x: -3, y: 0, to: { kind: 'place', placeId: 'fy-west' } }, at('sgc-jw', 'a')]),
      c('sgc-t2', 'T2', 'West near', west, [at('sgc-jw', 'b'), at('sgc-jwi', 'a')]),
      // Station limits: from the home signal at the end of the line to the points, a quarter of a mile
      // (the clearing point), where trains can draw forward and set back without going into the section.
      c('sgc-twi', 'T3', 'West inner', box, [at('sgc-jwi', 'b'), at('sgc-j1', 'toe')], { length: STATION_LIMIT }),
      c('sgc-t3', 'T4', 'West end', box, [at('sgc-j1', 'normal'), at('sgc-j2', 'toe')]),
      c('sgc-t4', 'T5', 'Platform 1', box, [at('sgc-j2', 'normal'), at('sgc-j4', 'normal')], { platform: { number: '1', side: -1 } }),
      c('sgc-t5', 'T6', 'Platform 2 loop', box, [at('sgc-j1', 'reverse'), at('sgc-j4', 'reverse')], { via: [{ x: 15, y: 3 }, { x: 35, y: 3 }], platform: { number: '2', side: 1 } }),
      c('sgc-t6', 'T7', 'Goods neck', box, [at('sgc-j2', 'reverse'), at('sgc-j5', 'b')], { via: [{ x: 21, y: -3 }] }),
      c('sgc-t7', 'T8', 'Yard throat', box, [at('sgc-j5', 'a'), at('sgc-j3', 'toe')]),
      c('sgc-t8', 'T9', 'Goods siding', box, [at('sgc-j3', 'normal'), { kind: 'bufferStops', x: 38, y: -3 }]),
      c('sgc-t9', 'T10', 'Goods shed', box, [at('sgc-j3', 'reverse'), { kind: 'bufferStops', x: 38, y: -6 }], { via: [{ x: 30, y: -6 }] }),
      c('sgc-tei', 'T11', 'East inner', box, [at('sgc-j4', 'toe'), at('sgc-jei', 'a')], { length: STATION_LIMIT }),
      c('sgc-t10', 'T12', 'East near', east, [at('sgc-jei', 'b'), at('sgc-je', 'a')]),
      c('sgc-t11', 'T13', 'East far', east, [at('sgc-je', 'b'), { kind: 'exit', x: 53, y: 0, to: { kind: 'place', placeId: 'fy-east' } }]),
    ],
    markers: [
      { id: 'sgc-m1', box: { kind: 'box', boxId: BOX }, x: 0, y: 0, circuitId: 'sgc-t5', dx: 0, dy: 3 },
      { id: 'sgc-m2', box: { kind: 'remote', boxId: BOX, connectionId: WEST }, x: 0, y: 0, circuitId: 'sgc-t1', dx: 0, dy: 3 },
      { id: 'sgc-m3', box: { kind: 'remote', boxId: BOX, connectionId: EAST }, x: 0, y: 0, circuitId: 'sgc-t11', dx: 0, dy: 3 },
    ],
  };
}

/*
 * Two example timetables for Sigsim Central, both the same morning's work: a SESSION CLOCK timetable
 * from 09:00, and the same moves as an OPERATIONS SEQUENCE. The Black Five shows a working that
 * changes: an ordinary passenger from the east terminates in platform 2, the engine goes light to
 * the goods shed while its coaches wait, comes back on to them, and works the train back east.
 */
function sigsimCentralTimetables(): Timetable[] {
  const t = (h: number, m: number) => h * 60 + m;
  const ref = (placeId: string, roadId = '') => ({ placeId, roadId });
  const e = (id: string, trainId: string, kind: TimetableEntry['kind'], trainTypeId: string, headcode: string, from: TimetableEntry['from'], to: TimetableEntry['to'], dep: number | null, arr: number | null, extra: Partial<TimetableEntry> = {}): TimetableEntry => ({
    id, trainId, kind, trainTypeId, headcode, from, to, dep, arr, withPrevious: false, calls: [], notes: '', ...extra,
  });
  const pass = (dep: number) => [{ placeId: 'sgc-station', roadId: 'sgc-p1', stop: false, arr: null, dep }];
  const trains = [
    { id: 'tr-express', name: 'The Express', locoId: 'lms6233', anyWorking: 'express_passenger', consist: '6 coaches', notes: 'Runs through Sigsim Central on the main line (platform 1) without stopping.' },
    { id: 'tr-stopper', name: 'The Stopper', locoId: 'lms5025', anyWorking: 'ordinary_passenger', consist: '4 coaches', notes: 'Terminates at Sigsim Central and goes back east.' },
    { id: 'tr-coal', name: 'Coal train', locoId: 'lms8233', anyWorking: 'mineral', consist: 'Coal wagons', notes: '' },
    { id: 'tr-pickup', name: 'Pick-up goods', locoId: 'lms7298', anyWorking: 'pickup_goods', consist: 'Vans', notes: 'The station pilot takes the pick-up goods to the east and back.' },
  ];
  const entries = (): TimetableEntry[] => [
    e('ex1', 'tr-express', 'run', 'express_passenger', '1E01', ref('fy-west', 'fyw-road1'), ref('fy-east', 'fye-road2'), t(9, 0), t(9, 12), { calls: pass(t(9, 6)) }),
    e('st1', 'tr-stopper', 'run', 'ordinary_passenger', '2W10', ref('fy-east', 'fye-road1'), ref('sgc-station', 'sgc-p2'), t(9, 15), t(9, 22)),
    e('st2', 'tr-stopper', 'shunt', 'light_engine', '', ref('sgc-station', 'sgc-p2'), ref('sgc-goods', 'sgc-shed'), t(9, 25), null, { notes: 'Uncouple and leave the coaches in platform 2. Run light to the goods shed road.' }),
    e('pg1', 'tr-pickup', 'run', 'pickup_goods', '9E30', ref('sgc-goods', 'sgc-siding'), ref('fy-east', 'fye-road3'), t(9, 35), t(9, 42)),
    e('st3', 'tr-stopper', 'shunt', 'light_engine', '', ref('sgc-goods', 'sgc-shed'), ref('sgc-station', 'sgc-p2'), t(9, 40), null, { notes: 'Back on to the coaches in platform 2, ready to work them back east.' }),
    e('cl1', 'tr-coal', 'run', 'mineral', '7T20', ref('fy-west', 'fyw-road2'), ref('sgc-goods', 'sgc-siding'), t(9, 45), t(9, 52)),
    e('st4', 'tr-stopper', 'run', 'ordinary_passenger', '2E11', ref('sgc-station', 'sgc-p2'), ref('fy-east', 'fye-road1'), t(9, 50), t(9, 57)),
    e('ex2', 'tr-express', 'run', 'express_passenger', '1W02', ref('fy-east', 'fye-road2'), ref('fy-west', 'fyw-road1'), t(10, 5), t(10, 17), { calls: pass(t(10, 11)) }),
    e('cl2', 'tr-coal', 'run', 'mineral', '7W21', ref('sgc-goods', 'sgc-siding'), ref('fy-west', 'fyw-road2'), t(10, 20), t(10, 27), { notes: 'Empties back to the west.' }),
    e('pg2', 'tr-pickup', 'run', 'pickup_goods', '9T31', ref('fy-east', 'fye-road3'), ref('sgc-goods', 'sgc-siding'), t(10, 30), t(10, 37)),
  ];
  const timed: Timetable = {
    id: 'tt-sgc-morning', name: 'Morning service', timing: 'session', startAt: t(9, 0), elapsed: false, speed: 1, validity: 'Weekdays', notes: 'Example timetable: the session clock starts at 09:00.', trains: structuredClone(trains), entries: entries(),
  };
  const seqEntries = entries().map((x) => ({ ...x, id: `seq-${x.id}`, dep: null, arr: null, calls: x.calls.map((c) => ({ ...c, arr: null, dep: null })) }));
  // The pick-up goods can leave while the Black Five is shunting.
  const pg = seqEntries.find((x) => x.id === 'seq-pg1');
  if (pg) pg.withPrevious = true;
  const sequence: Timetable = {
    id: 'tt-sgc-sequence', name: 'Operations sequence', timing: 'sequence', startAt: t(9, 0), elapsed: false, speed: 1, validity: 'Any day', notes: 'Example operations sequence: each move is released when the one before it has finished.', trains: structuredClone(trains), entries: seqEntries,
  };
  return [timed, sequence];
}
