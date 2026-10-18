import { DEFAULT_CODE_SETS, DEFAULT_TRAIN_TYPES } from './bellcodes';
import type { AppState, Settings } from './types';

export const SCHEMA_VERSION = 2;

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
  bellBeatMs: 260,
  bellGroupPauseMs: 750,
  bellSoundDataUrl: '',
  bellSynth: false,
};

export function createDefaultState(): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
    trainTypes: structuredClone(DEFAULT_TRAIN_TYPES),
    codeSets: structuredClone(DEFAULT_CODE_SETS),
    boxes: [
      {
        id: 'becton',
        name: 'Becton',
        shortName: 'BEC',
        layoutId: 'layout1',
        description: 'Terminus of the Becton and Tansley Spa Steam Railway. Single line to the fiddle yard.',
        stationNotes:
          'P1: longest, loco release at the end; tender engine + 3–4 coaches. Coaches may need to be drawn off by the station pilot.\n' +
          'P2: shorter. A train in P2 blocks the P1 loco release; the pilot must draw off the coaches to release the loco.\n' +
          'P3: bay. Single car DMU or push-pull tank engine service.\n' +
          'Coal siding: not used for arrivals. Goods demonstrators go into P1–P3 and are broken up by the pilot.',
        shelfPositions: 3,
        connections: [
          {
            id: 'becton-fy',
            neighbourName: 'Fiddle Yard',
            neighbourShort: 'FY',
            lineType: 'single',
            fiddleYardId: 'fy1',
            defaultWorking: 'ab',
            shelfPosition: 2,
          },
        ],
      },
    ],
    layouts: [
      {
        id: 'layout1',
        name: 'Becton and Tansley Spa Steam Railway',
        running: 'left',
        fiddleYards: [
          {
            id: 'fy1',
            name: 'Fiddle Yard',
            roads: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `road${n}`, name: `Road ${n}`, notes: '' })),
          },
        ],
        // The track plan starts empty: each layout builds its own in the layout configurator.
        trackPlan: { circuits: [], junctions: [] },
      },
    ],
    roster: [
      {
        id: 'ex1',
        number: '7812',
        name: 'Erlestoke Manor',
        locoClass: 'GWR Manor 4-6-0',
        powerType: 'Steam (tender)',
        dccAddress: '7812',
        notes: 'Example entry: edit or delete.',
        working: { trainTypeId: 'ordinary_passenger', consist: '3 coaches', headcode: '' },
        location: { kind: 'fiddleYard', yardId: 'fy1', roadId: 'road1' },
      },
      {
        id: 'ex2',
        number: '6435',
        name: '',
        locoClass: 'GWR 64xx 0-6-0PT',
        powerType: 'Steam (tank)',
        dccAddress: '6435',
        notes: 'Example entry: push-pull with auto-coach.',
        working: { trainTypeId: 'branch_passenger', consist: 'Auto-coach', headcode: '' },
        location: { kind: 'fiddleYard', yardId: 'fy1', roadId: 'road2' },
      },
      {
        id: 'ex3',
        number: '55028',
        name: '',
        locoClass: 'Class 121 railcar',
        powerType: 'DMU',
        dccAddress: '5028',
        notes: 'Example entry.',
        working: { trainTypeId: 'railcar', consist: 'Single car', headcode: '2B12' },
        location: { kind: 'fiddleYard', yardId: 'fy1', roadId: 'road3' },
      },
      {
        id: 'ex4',
        number: 'D3022',
        name: '',
        locoClass: 'Class 08 0-6-0DE',
        powerType: 'Diesel',
        dccAddress: '3022',
        notes: 'Example entry: station pilot.',
        working: { trainTypeId: 'light_engine', consist: '', headcode: '' },
        location: { kind: 'station', boxId: 'becton', note: 'Pilot' },
      },
    ],
  };
}
