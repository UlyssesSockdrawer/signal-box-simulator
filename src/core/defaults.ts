import { DEFAULT_CODE_SETS, DEFAULT_TRAIN_TYPES } from './bellcodes';
import type { AppState, Junction, Settings, TrackCircuit, TrackPlan } from './types';

/** 3: places (stations, sidings, goods, depots, fiddle yards) on layouts (v0.3.14). */
export const SCHEMA_VERSION = 3;

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
};

/*
 * The app's starting data (also what Settings → Reset to defaults restores): a generic example,
 * not anyone's own layout. SIGSIM CENTRAL is a station on a single line with a passing loop
 * (platforms 1 and 2), a goods siding and goods shed, between Fiddle Yard West and Fiddle Yard
 * East, each worked by a simulated signal box. The roster has four LMS locomotives of different
 * types, standing where they can be offered in from either end or sent away from the goods yard.
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
            roads: [1, 2, 3, 4].map((n) => ({ id: `fyw-road${n}`, name: `Road ${n}`, notes: '' })),
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
            shortName: '',
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
            roads: [1, 2, 3, 4].map((n) => ({ id: `fye-road${n}`, name: `Road ${n}`, notes: '' })),
            workedBy: [{ kind: 'remote', boxId: BOX, connectionId: EAST }],
          },
        ],
        trackPlan: sigsimCentralPlan(),
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
      },
      {
        id: 'lms5025',
        number: '5025',
        name: '',
        locoClass: 'LMS Stanier Class 5 4-6-0 ("Black Five")',
        powerType: 'Steam (tender)',
        dccAddress: '5025',
        notes: 'Example entry: mixed traffic engine.',
        working: { trainTypeId: 'ordinary_passenger', consist: '4 coaches', headcode: '' },
        location: { kind: 'place', placeId: 'fy-east', roadId: 'fye-road1' },
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
      joint('sgc-jw', 6, 0), // between the west line's two track circuits
      j('sgc-j1', '1', 'pointsRight', 12, 0), // into the loop
      j('sgc-j2', '2', 'pointsLeft', 18, 0), // to the goods yard
      // Trap points, turned round so the blade faces west: anything running out of the yard towards points 2
      // is derailed (away from the main line) unless they are set for it; trains entering the yard pass them trailing.
      j('sgc-j5', '5', 'catchPoints', 24, -3, { rotate: true }),
      j('sgc-j3', '3', 'pointsLeft', 27, -3), // goods siding / goods shed
      j('sgc-j4', '4', 'pointsLeft', 38, 0, { rotate: true }), // loop rejoins the main line
      joint('sgc-je', 44, 0), // between the east line's two track circuits
    ],
    circuits: [
      c('sgc-t1', 'T1', 'West far', west, [{ kind: 'exit', x: 0, y: 0, to: { kind: 'place', placeId: 'fy-west' } }, at('sgc-jw', 'a')]),
      c('sgc-t2', 'T2', 'West near', west, [at('sgc-jw', 'b'), at('sgc-j1', 'toe')]),
      c('sgc-t3', 'T3', 'West end', box, [at('sgc-j1', 'normal'), at('sgc-j2', 'toe')]),
      c('sgc-t4', 'T4', 'Platform 1', box, [at('sgc-j2', 'normal'), at('sgc-j4', 'normal')], { platform: { number: '1', side: -1 } }),
      c('sgc-t5', 'T5', 'Platform 2 loop', box, [at('sgc-j1', 'reverse'), at('sgc-j4', 'reverse')], { via: [{ x: 15, y: 3 }, { x: 35, y: 3 }], platform: { number: '2', side: 1 } }),
      c('sgc-t6', 'T6', 'Goods neck', box, [at('sgc-j2', 'reverse'), at('sgc-j5', 'b')], { via: [{ x: 21, y: -3 }] }),
      c('sgc-t7', 'T7', 'Yard throat', box, [at('sgc-j5', 'a'), at('sgc-j3', 'toe')]),
      c('sgc-t8', 'T8', 'Goods siding', box, [at('sgc-j3', 'normal'), { kind: 'bufferStops', x: 38, y: -3 }]),
      c('sgc-t9', 'T9', 'Goods shed', box, [at('sgc-j3', 'reverse'), { kind: 'bufferStops', x: 38, y: -6 }], { via: [{ x: 30, y: -6 }] }),
      c('sgc-t10', 'T10', 'East near', east, [at('sgc-j4', 'toe'), at('sgc-je', 'a')]),
      c('sgc-t11', 'T11', 'East far', east, [at('sgc-je', 'b'), { kind: 'exit', x: 50, y: 0, to: { kind: 'place', placeId: 'fy-east' } }]),
    ],
    markers: [
      { id: 'sgc-m1', box: { kind: 'box', boxId: BOX }, x: 0, y: 0, circuitId: 'sgc-t5', dx: 0, dy: 3 },
      { id: 'sgc-m2', box: { kind: 'remote', boxId: BOX, connectionId: WEST }, x: 0, y: 0, circuitId: 'sgc-t1', dx: 0, dy: 3 },
      { id: 'sgc-m3', box: { kind: 'remote', boxId: BOX, connectionId: EAST }, x: 0, y: 0, circuitId: 'sgc-t11', dx: 0, dy: 3 },
    ],
  };
}
