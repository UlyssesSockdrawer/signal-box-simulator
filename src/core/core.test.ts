import { describe, expect, it } from 'vitest';
import { DEFAULT_CODE_SETS, DEFAULT_TRAIN_TYPES, normaliseCode } from './bellcodes';
import { addBox, addConnection, canOpenBox, farBoxLocations, checkBoxName, checkBoxShort, checkConnName, checkShelfPositions, deleteBox, moveConnection, removeConnection, setShelfPositions } from './boxes';
import { createLinkPair } from './link';
import { trainsOnLayout } from './layoutRegister';
import { incomingCandidates } from './selection';
import { SectionController } from './sectionController';
import { createDefaultState } from './defaults';
import { FakeScheduler } from './scheduler';
import { createBoxSession } from './session';
import { migrate } from './store';
import { layoutShelf, positionLabel } from './shelf';
import { TapDecoder } from './tapDecoder';
import type { AppState, Location, WorkingMode } from './types';

function setup(mode: WorkingMode) {
  const state: AppState = createDefaultState();
  state.settings.workingModes['becton-fy'] = mode;
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  const sched = new FakeScheduler();
  const [sess] = createBoxSession(state.boxes[0], () => state, sched);
  const c = sess.controller;
  const bellsIn: string[] = [];
  const hints: string[] = [];
  const moves: Array<{ locoId: string; location: Location }> = [];
  c.events.on('bellIn', (b) => bellsIn.push(b.code + (b.holdLast ? 'H' : '')));
  c.events.on('hint', (h) => hints.push(h.text));
  c.events.on('locoMoved', (m) => {
    moves.push(m);
    const l = state.roster.find((x) => x.id === m.locoId);
    if (l) l.location = m.location;
  });
  sess.neighbour!.start();
  const tick = (ms = 4000) => sched.advance(ms);
  // Open the box: 1, then 5-5-5.
  c.sendBell('1');
  tick();
  c.sendBell('5-5-5');
  tick(8000);
  bellsIn.length = 0;
  return { state, sched, c, nb: sess.neighbour!, bellsIn, hints, moves, tick };
}

describe('bell code helpers', () => {
  it('normalises typed codes', () => {
    expect(normaliseCode(' 3 1 ')).toBe('3-1');
    expect(normaliseCode('2–2–1')).toBe('2-2-1');
    expect(normaliseCode('16')).toBe('16');
    expect(normaliseCode('x')).toBe('');
  });
});

describe('TapDecoder', () => {
  it('decodes rhythm into groups, and detects a held last beat', () => {
    const sched = new FakeScheduler();
    const out: string[] = [];
    const d = new TapDecoder(() => ({ groupGapMs: 450, codeEndMs: 1400, holdMs: 900 }), sched, (c, h) => out.push(c + (h ? 'H' : '')));
    const tap = (hold = 100, gap = 150) => {
      d.press();
      sched.advance(hold);
      d.release();
      sched.advance(gap);
    };
    tap();
    tap();
    tap(100, 700); // pause → new group
    tap(100, 1500); // end of code
    expect(out).toEqual(['3-1']);
    tap();
    tap();
    tap(1200, 1500); // held last beat
    expect(out).toEqual(['3-1', '3H']);
  });
});

describe('Simplified absolute block, single line', () => {
  it('runs an incoming train end to end', () => {
    const t = setup('ab');
    expect(t.c.requestIncoming('ex1', 'ordinary_passenger')).toBeNull();
    t.tick();
    expect(t.bellsIn).toEqual(['1']);
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '3-1']);
    t.c.sendBell('3-1');
    t.c.setInstrument('LC');
    t.tick(8000);
    expect(t.bellsIn).toEqual(['1', '3-1', '2']);
    t.c.sendBell('2');
    t.c.setInstrument('TOL');
    t.tick();
    expect(t.state.roster.find((l) => l.id === 'ex1')!.location.kind).toBe('section');
    t.c.confirmIncomingArrived('P1');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '3-1', '2', '1', '2-1']);
    t.c.setInstrument('LB');
    t.tick();
    expect(t.c.view.incoming).toBeNull();
    expect(t.state.roster.find((l) => l.id === 'ex1')!.location).toEqual({ kind: 'station', boxId: 'becton', note: 'P1' });
    expect(t.c.irregularities).toEqual([]);
  });

  it('runs an outgoing train end to end', () => {
    const t = setup('ab');
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1']);
    t.c.sendBell('2-3');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '2-3']);
    expect(t.c.view.remoteInstrument).toBe('LC');
    t.c.sendBell('2');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('TOL');
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    expect(t.bellsIn).toEqual(['1', '2-3', '2', '1']);
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('2-1');
    t.c.sendBell('2-1');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('LB');
    expect(t.c.view.outgoing).toBeNull();
    expect(t.state.roster.find((l) => l.id === 'ex4')!.location).toEqual({ kind: 'fiddleYard', yardId: 'fy1', roadId: 'road5' });
    expect(t.c.irregularities).toEqual([]);
  });

  it('reports each arrival once, however many times the button is pressed', () => {
    const t = setup('ab');
    // Outgoing
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-3');
    t.tick();
    t.c.sendBell('2');
    t.tick();
    t.c.confirmOutgoingArrived('road5', null);
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    t.c.confirmOutgoingArrived('road5', null);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    expect(t.c.view.outgoing).toBeNull();
    // Incoming
    expect(t.c.requestIncoming('ex1', 'ordinary_passenger')).toBeNull();
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.c.setInstrument('LC');
    t.tick(8000);
    t.c.sendBell('2');
    t.c.setInstrument('TOL');
    t.tick();
    t.c.confirmIncomingArrived('P1');
    t.c.confirmIncomingArrived('P1');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    t.c.confirmIncomingArrived('P1');
    t.c.setInstrument('LB');
    t.tick(5000);
    expect(t.c.view.incoming).toBeNull();
    expect(t.c.irregularities).toEqual([]);
    expect(t.hints).toEqual([]);
  });

  it('ignores Is line clear without call attention, and hints', () => {
    const t = setup('ab');
    t.c.sendBell('3-1');
    t.tick();
    expect(t.bellsIn).toEqual([]);
    expect(t.hints.join(' ')).toMatch(/Call attention/);
  });

  it('rings again when the reply is wrong', () => {
    const t = setup('ab');
    t.c.requestIncoming('ex1', 'ordinary_passenger');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-2');
    t.tick(6000);
    expect(t.bellsIn).toEqual(['1', '3-1', '3-1']);
    expect(t.c.irregularities.length).toBe(1);
  });

  it('repeats call attention if unanswered', () => {
    const t = setup('ab');
    t.c.requestIncoming('ex1', 'ordinary_passenger');
    t.tick(30000);
    expect(t.bellsIn).toEqual(['1', '1']);
  });

  it('will not offer an incoming train while the single line is occupied', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    expect(t.c.requestIncoming('ex1', 'ordinary_passenger')).toMatch(/single line/);
  });

  it('cancels an accepted outgoing train with 3-5', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    expect(t.c.view.remoteInstrument).toBe('LC');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-5');
    t.tick(6000);
    expect(t.bellsIn.at(-1)).toBe('3-5');
    expect(t.c.view.remoteInstrument).toBe('LB');
  });
});

describe('Electric key token, single line', () => {
  it('runs an incoming train end to end', () => {
    const t = setup('token');
    t.c.requestIncoming('ex2', 'branch_passenger');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '1-3']);
    // forgetting to hold: rung again
    t.c.sendBell('1-3', false);
    t.tick(6000);
    expect(t.bellsIn).toEqual(['1', '1-3', '1-3']);
    t.c.sendBell('1-3', true);
    t.tick(9000);
    expect(t.c.view.tokenIndicator).toBe('coming');
    expect(t.bellsIn.at(-1)).toBe('2');
    t.c.sendBell('2');
    t.tick();
    t.c.confirmIncomingArrived('P3');
    expect(t.c.view.tokenInHand).toBe(true);
    // 2-1 before replacing token is refused
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('1');
    expect(t.c.replaceToken()).toBeNull();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('2-1');
    expect(t.c.view.incoming).toBeNull();
    expect(t.c.view.tokensInInstrument).toBe(7);
  });

  it('runs an outgoing train end to end', () => {
    const t = setup('token');
    expect(t.c.withdrawToken()).toMatch(/locked/);
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-3');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '2-3H']);
    expect(t.c.view.releaseAvailable).toBe(true);
    expect(t.c.withdrawToken()).toBeNull();
    expect(t.c.view.tokenIndicator).toBe('going');
    t.c.sendBell('2');
    t.tick();
    expect(t.bellsIn.at(-1)).toBe('2');
    t.c.confirmOutgoingArrived('road4', null);
    t.tick(5000);
    expect(t.c.view.tokenIndicator).toBe('normal');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.c.view.outgoing).toBeNull();
    expect(t.c.view.tokensInInstrument).toBe(5);
    expect(t.c.irregularities).toEqual([]);
  });

  it('lets the release lapse if no token is withdrawn', () => {
    const t = setup('token');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick(20000);
    expect(t.c.view.releaseAvailable).toBe(false);
    expect(t.nb.outgoing).toBeNull();
  });
});

describe('opening the box', () => {
  it('refuses trains until 5-5-5 has been exchanged', () => {
    const state: AppState = createDefaultState();
    state.settings.responseDelayMs = [1000, 1000];
    const sched = new FakeScheduler();
    const [sess] = createBoxSession(state.boxes[0], () => state, sched);
    const c = sess.controller;
    const bells: string[] = [];
    c.events.on('bellIn', (b) => bells.push(b.code));
    sess.neighbour!.start();
    expect(c.view.boxOpen).toBe(false);
    expect(c.view.guidance).toMatch(/5-5-5/);
    expect(c.requestIncoming('ex1', 'ordinary_passenger')).toMatch(/Open the box/);
    c.sendBell('1');
    sched.advance(4000);
    c.sendBell('3-1');
    sched.advance(4000);
    expect(bells).toEqual(['1']);
    c.sendBell('1');
    sched.advance(4000);
    c.sendBell('5-5-5');
    sched.advance(8000);
    expect(bells).toEqual(['1', '1', '5-5-5']);
    expect(c.view.boxOpen).toBe(true);
    expect(c.requestIncoming('ex1', 'ordinary_passenger')).toBeNull();
  });

  it('closes with 7-5-5 and then only answers the opening sequence', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('7-5-5');
    t.tick(8000);
    expect(t.bellsIn).toEqual(['1', '7-5-5']);
    expect(t.c.view.boxOpen).toBe(false);
    t.c.sendBell('16');
    t.tick();
    expect(t.bellsIn).toEqual(['1', '7-5-5']);
    expect(t.hints.at(-1)).toMatch(/closed/);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('5-5-5');
    t.tick(8000);
    expect(t.c.view.boxOpen).toBe(true);
  });

  it('will not close while a train is being signalled', () => {
    const t = setup('ab');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('7-5-5');
    t.tick(8000);
    expect(t.c.view.boxOpen).toBe(true);
  });
});

describe('store migration', () => {
  it('fills defaults into partial saved data', () => {
    const s = migrate({ settings: { volume: 0.2 }, roster: [] });
    expect(s.settings.volume).toBe(0.2);
    expect(s.settings.tap.holdMs).toBe(900);
    expect(s.boxes[0].id).toBe('becton');
    expect(s.roster).toEqual([]);
  });
});

describe('block shelf layout', () => {
  it('places Becton fiddle yard on the right of three positions', () => {
    const box = createDefaultState().boxes[0];
    const slots = layoutShelf(box);
    expect(slots.length).toBe(3);
    expect(slots[0]).toBeNull();
    expect(slots[1]).toBeNull();
    expect(slots[2]?.id).toBe('becton-fy');
    expect(positionLabel(2, 3)).toBe('Right');
  });
  it('moves clashing connections to the nearest free position', () => {
    const box = createDefaultState().boxes[0];
    box.connections.push({ ...box.connections[0], id: 'x', shelfPosition: 2 });
    const slots = layoutShelf(box);
    expect(slots[2]?.id).toBe('becton-fy');
    expect(slots[1]?.id).toBe('x');
  });
  it('migrates old saves without shelf data', () => {
    const def = createDefaultState();
    const old = JSON.parse(JSON.stringify(def));
    delete old.boxes[0].shelfPositions;
    delete old.boxes[0].connections[0].shelfPosition;
    const s = migrate(old);
    expect(s.boxes[0].shelfPositions).toBe(3);
    expect(s.boxes[0].connections[0].shelfPosition).toBe(2);
  });
});

describe('user boxes and connections', () => {
  it('adds new boxes with unique default names', () => {
    const s = createDefaultState();
    const a = addBox(s);
    const b = addBox(s);
    expect(a.name).toBe('New box');
    expect(b.name).toBe('New box 2');
    expect(a.shortName).toBe('NEW');
    expect(b.shortName).toBe('NEW2');
    expect(canOpenBox(a)).toBe(false);
    expect(canOpenBox(s.boxes[0])).toBe(true);
  });

  it('rejects duplicate and empty names', () => {
    const s = createDefaultState();
    const nb = addBox(s);
    expect(checkBoxName(s, 'becton', nb.id)).toMatch(/already/);
    expect(checkBoxName(s, '  ', nb.id)).toMatch(/Enter/);
    expect(checkBoxName(s, 'Becton', 'becton')).toBeNull();
    expect(checkBoxShort(s, 'bec', nb.id)).toMatch(/already/);
    expect(checkConnName(s.boxes[0], 'fiddle yard', null)).toMatch(/already connected/);
    expect(checkConnName(s.boxes[0], 'Becton', null)).toMatch(/itself/);
  });

  it('validates shelf positions', () => {
    const box = createDefaultState().boxes[0];
    expect(checkShelfPositions(box, '0')).not.toBeNull();
    expect(checkShelfPositions(box, '-2')).not.toBeNull();
    expect(checkShelfPositions(box, '2.5')).not.toBeNull();
    expect(checkShelfPositions(box, '9')).not.toBeNull();
    expect(checkShelfPositions(box, '')).not.toBeNull();
    expect(checkShelfPositions(box, '1')).toBeNull();
  });

  it('adds connections in free positions and grows a full shelf', () => {
    const s = createDefaultState();
    const box = addBox(s, 'layout1');
    box.shelfPositions = 1;
    const c1 = addConnection(s, box)!;
    expect(c1.shelfPosition).toBe(0);
    // The first fiddle yard on the box's layout; none for a box not on a layout.
    expect(c1.fiddleYardId).toBe('fy1');
    expect(addConnection(s, addBox(s))!.fiddleYardId).toBe('');
    const c2 = addConnection(s, box)!;
    expect(box.shelfPositions).toBe(2);
    expect(c2.shelfPosition).toBe(1);
    expect(c2.neighbourName).toBe('Connected box 2');
    expect(canOpenBox(box)).toBe(true);
    removeConnection(s, box.id, c1.id);
    expect(box.connections.map((c) => c.id)).toEqual([c2.id]);
  });

  it('swaps instruments when moved onto an occupied position, repacks when the shelf shrinks', () => {
    const s = createDefaultState();
    const box = s.boxes[0];
    const extra = addConnection(s, box)!; // goes in position 0
    expect(extra.shelfPosition).toBe(0);
    moveConnection(box, extra.id, 2);
    expect(extra.shelfPosition).toBe(2);
    expect(box.connections[0].shelfPosition).toBe(0);
    setShelfPositions(box, 2);
    expect(layoutShelf(box).every((c) => c !== null)).toBe(true);
    expect(Math.max(...box.connections.map((c) => c.shelfPosition))).toBe(1);
  });

  it('deletes a box but never the last one', () => {
    const s = createDefaultState();
    expect(deleteBox(s, 'becton')).toBe(false);
    const nb = addBox(s);
    s.roster[0].location = { kind: 'station', boxId: nb.id, note: '' };
    expect(deleteBox(s, nb.id)).toBe(true);
    expect(s.boxes).toHaveLength(1);
    expect(s.roster[0].location.kind).toBe('offLayout');
  });

  it('a connection with no fiddle yard keeps departures on the layout, at the far box', () => {
    const sch = new FakeScheduler();
    const [a, b] = createLinkPair();
    const moved: Location[] = [];
    const ctl = new SectionController({
      link: a, scheduler: sch, boxId: 'x', connectionId: 'c', fiddleYardId: '', mode: 'ab', lineType: 'single',
      neighbourName: 'Tansley Spa', neighbourShort: 'TS', localShort: 'BEC', codeSet: () => DEFAULT_CODE_SETS[0], trainTypes: () => DEFAULT_TRAIN_TYPES,
    });
    ctl.events.on('locoMoved', ({ location }) => moved.push(location));
    b.send({ type: 'movementComplete', direction: 'outgoing', locoId: 'ex1', roadId: '' });
    expect(moved).toEqual([{ kind: 'farBox', boxId: 'x', connectionId: 'c', note: '' }]);
  });

  it('offers trains standing at the far box back over a line with no fiddle yard', () => {
    const s = createDefaultState();
    const box = s.boxes[0];
    const conn = addConnection(s, box)!;
    conn.fiddleYardId = '';
    s.roster[0].location = { kind: 'farBox', boxId: box.id, connectionId: conn.id, note: '' };
    expect(incomingCandidates(s, conn).map((l) => l.id)).toEqual([s.roster[0].id]);
    expect(incomingCandidates(s, box.connections[0]).some((l) => l.id === s.roster[0].id)).toBe(false);
    expect(farBoxLocations(s).map((x) => x.conn.id)).toEqual([conn.id]);
  });

  it('trains at a removed far box location go off the layout, also when loading old data', () => {
    const s = createDefaultState();
    const box = s.boxes[0];
    const conn = addConnection(s, box)!;
    conn.fiddleYardId = '';
    s.roster[0].location = { kind: 'farBox', boxId: box.id, connectionId: conn.id, note: '' };
    const saved = JSON.parse(JSON.stringify(s));
    saved.boxes[0].connections = saved.boxes[0].connections.filter((c: { id: string }) => c.id !== conn.id);
    expect(migrate(saved).roster[0].location.kind).toBe('offLayout');
    removeConnection(s, box.id, conn.id);
    expect(s.roster[0].location.kind).toBe('offLayout');
  });
});

describe('trains on layout register', () => {
  it("lists the box's yards, its station, its far-box locations, then the rest of the layout", () => {
    const s = createDefaultState();
    const becton = s.boxes[0];
    const far = addConnection(s, becton)!;
    far.neighbourName = 'Sidings';
    far.fiddleYardId = '';
    const other = addBox(s, 'layout1');
    addBox(s); // not on the layout: not listed
    s.roster[0].location = { kind: 'farBox', boxId: becton.id, connectionId: far.id, note: 'Road A' };
    s.roster[1].location = { kind: 'section', connectionId: 'becton-fy' };
    const reg = trainsOnLayout(s, becton.id);
    expect(reg.map((r) => r.kind + ':' + r.name)).toEqual([
      'yard:Fiddle Yard',
      'station:Becton station',
      'farBox:Sidings',
      `station:${other.name} station`,
      'section:On the line',
    ]);
    const yard = reg[0];
    expect(yard.kind === 'yard' && yard.roads.length).toBe(6);
    const sid = reg[2];
    expect(sid.kind === 'farBox' && sid.locos.map((l) => l.id)).toEqual([s.roster[0].id]);
  });
});
