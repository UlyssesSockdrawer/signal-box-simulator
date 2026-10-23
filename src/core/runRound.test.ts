import { mintFromConsist, stockLibrary, vehiclesDescription } from './stock';
import { describe, expect, it } from 'vitest';
import { accept, play } from './simHarness';
import { addTimetable, addTrain } from './timetables';

/** Ring 1 then a code on a line, and wait for the answer. */
function ring(t: ReturnType<typeof play>, c: typeof t.west, code: string) {
  c.sendBell('1');
  t.tick();
  c.sendBell(code);
  t.tick(8000);
}

/** Block back (2-4) on every line the railway is waiting for, as the box's Next step would say. */
function blockBackAsAsked(t: ReturnType<typeof play>, blocked: Set<string>) {
  for (const w of t.sim.permissions('sigsim-central').waiting) {
    if (blocked.has(w.connId) || w.kind !== 'inside') continue;
    const c = w.connId === 'sgc-west' ? t.west : t.east;
    ring(t, c, '2-4');
    c.setInstrument('TOL');
    blocked.add(w.connId);
  }
}

/** Receive the Black Five off the west line into P1, reported arrived complete. */
function arriveInP1(t: ReturnType<typeof play>) {
  t.loco('lms5025').location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r1' };
  expect(t.west.requestIncoming('lms5025', 'ordinary_passenger')).toBeNull();
  t.sim.setDestination('sigsim-central', 'sgc-west', { placeId: 'sgc-station', roadId: 'sgc-p1' });
  accept(t, t.west, '3-1');
  const view = () => t.sim.incoming('sigsim-central', 'sgc-west');
  expect(t.until(() => !!view()?.arrivedDetected)).toBe(true);
  expect(t.trains.source.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms5025', at: { placeId: 'sgc-station', roadId: 'sgc-p1' }, by: 'person' })).toBe('applied');
  t.west.sendBell('1');
  t.tick();
  t.west.sendBell('2-1');
  t.west.setInstrument('LB');
  t.tick(8000);
}

describe('the engine at the right end of its train (play mode)', () => {
  it('a train arrives engine first: the railway remembers the engine is at the far end of its road', () => {
    const t = play();
    arriveInP1(t);
    const bf = t.loco('lms5025');
    expect(bf.location).toEqual({ kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' });
    // P1 is T5 (sgc-t4); off the west line it ran east, so the engine is at the east end (end 1).
    expect(bf.working.locoEnd).toEqual({ circuitId: 'sgc-t4', end: 1 });
  });

  it('going on east it leaves engine first, with no running round', () => {
    const t = play();
    arriveInP1(t);
    t.east.setOutgoing('lms5025', 'ordinary_passenger');
    t.tick(500);
    expect(t.sim.jobsText('sigsim-central')).toEqual([]);
    ring(t, t.east, '3-1');
    expect(t.until(() => t.occupied().includes('T12'), 120_000)).toBe(true);
    expect(t.sim.jobsText('sigsim-central')).toEqual([]);
  });

  it('back west it runs round first when the departure is set: uncouples, round by the loop (blocking back where it must), couples up at the west end, then goes engine first', () => {
    const t = play();
    arriveInP1(t);
    const bf = t.loco('lms5025');
    t.west.setOutgoing('lms5025', 'ordinary_passenger');
    t.tick(500);
    expect(t.sim.outgoingText('sigsim-central', 'sgc-west')).toMatch(/uncoupling to run round/);
    const seen = new Set<string>();
    t.board.onChange(() => t.occupied().forEach((c) => seen.add(c)));
    const blocked = new Set<string>();
    expect(
      t.until(() => {
        blockBackAsAsked(t, blocked);
        return bf.working.locoEnd?.end === 0 && !t.sim.jobsText('sigsim-central').length;
      }, 900_000),
    ).toBe(true);
    // Round by the loop: out east on to the East inner, back along the loop, set back in the West inner.
    for (const c of ['T11', 'T6', 'T3']) expect(seen).toContain(c);
    expect(bf.working.consist).toBe('4 coaches');
    expect(t.state.layouts[0].stock ?? []).toHaveLength(0);
    // It went over both lines' clearing points, so both were blocked back first.
    expect([...blocked].sort()).toEqual(['sgc-east', 'sgc-west']);
    for (const c of [t.west, t.east]) {
      ring(t, c, '2-1');
      c.setInstrument('LB');
    }
    ring(t, t.west, '3-1');
    expect(t.until(() => t.occupied().includes('T2'), 120_000)).toBe(true);
  });

  it('an engine that cannot run round (the loop blocked by standing stock) is released by the station pilot, ECS-style', () => {
    const t = play();
    arriveInP1(t);
    const bf = t.loco('lms5025');
    // Stock standing in the loop (P2) and the West inner: no way round.
    const l = t.state.layouts[0];
    l.stock = [{ id: 'rake-x', vehicles: mintFromConsist('6 vans'), placeId: 'sgc-station', roadId: 'sgc-p2', circuitId: 'sgc-t5' }];
    t.tick(500);
    t.west.setOutgoing('lms5025', 'ordinary_passenger');
    const texts = new Set<string>();
    const blocked = new Set<string>();
    expect(
      t.until(() => {
        blockBackAsAsked(t, blocked);
        for (const x of t.sim.jobsText('sigsim-central')) texts.add(x);
        return bf.working.locoEnd?.end === 0 && !t.sim.jobsText('sigsim-central').length;
      }, 1_800_000),
    ).toBe(true);
    const all = [...texts].join(' | ');
    expect(all).toMatch(/station pilot \(7298\)/i);
    expect(all).toMatch(/drawing the stock off/);
    expect(all).toMatch(/putting the stock back/);
    expect(all).toMatch(/backing on to its train at the outer end/);
    // The engine has its coaches again, at the west end; the pilot has none.
    expect(bf.working.consist).toBe('4 coaches');
    expect(bf.location).toEqual({ kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' });
    expect(t.loco('lms7298').working.consist).toBe('');
    expect((l.stock ?? []).map((r) => r.id)).toEqual(['rake-x']);
  });

  it('with no station pilot, a trapped engine waits and the departure says why', () => {
    const t = play();
    arriveInP1(t);
    t.loco('lms7298').jobs = [];
    t.state.layouts[0].stock = [{ id: 'rake-x', vehicles: mintFromConsist('6 vans'), placeId: 'sgc-station', roadId: 'sgc-p2', circuitId: 'sgc-t5' }];
    t.tick(500);
    t.west.setOutgoing('lms5025', 'ordinary_passenger');
    t.tick(500);
    expect(t.sim.outgoingText('sigsim-central', 'sgc-west')).toMatch(/trapped at the wrong end.*station pilot/);
  });

  it('railcars, push-pull trains and light engines need no running round', () => {
    const t = play();
    arriveInP1(t);
    const bf = t.loco('lms5025');
    bf.working.consist = 'auto-coach';
    t.west.setOutgoing('lms5025', 'ordinary_passenger');
    t.tick(500);
    expect(t.sim.jobsText('sigsim-central')).toEqual([]);
  });

  it('a shunt that says what it moves with takes those and leaves the rest', () => {
    const t = play();
    const bf = t.loco('lms5025');
    bf.location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' };
    bf.working = { trainTypeId: 'light_engine', consist: '4 coaches + 2 vans', headcode: '' };
    let done = false;
    expect(t.sim.shunt('sigsim-central', 'lms5025', { placeId: 'sgc-station', roadId: 'sgc-p2' }, () => (done = true), { vehicles: '2 vans' })).toBeNull();
    expect(bf.working.consist).toBe('2 vans');
    expect(t.state.layouts[0].stock).toMatchObject([{ circuitId: 'sgc-t4' }]);
    expect(vehiclesDescription(t.state.layouts[0].stock![0].vehicles, stockLibrary())).toBe('4 coaches');
    const blocked = new Set<string>();
    expect(t.until(() => (blockBackAsAsked(t, blocked), done), 600_000)).toBe(true);
  });

  it('a timetabled run round is run by the railway in play mode', () => {
    const t = play();
    arriveInP1(t);
    const l = t.state.layouts[0];
    const tt = addTimetable(t.state, l.id, 'sequence')!;
    const { entry } = addTrain(t.state, l, tt, { locoId: 'lms5025' })!;
    entry.kind = 'shunt';
    entry.trainTypeId = 'light_engine';
    entry.from = { placeId: 'sgc-station', roadId: 'sgc-p1' };
    entry.to = { placeId: 'sgc-station', roadId: 'sgc-p1' };
    entry.runRound = true;
    t.runner.load(tt);
    t.runner.start();
    t.tick(500);
    expect(t.runner.items[0].card).toBeNull();
    expect(t.runner.items[0].status).toMatch(/runs round its train/);
    const blocked = new Set<string>();
    expect(t.until(() => (blockBackAsAsked(t, blocked), t.runner.items[0].state === 'done'), 900_000)).toBe(true);
    const bf = t.loco('lms5025');
    expect(bf.working.locoEnd).toEqual({ circuitId: 'sgc-t4', end: 0 });
    expect(bf.working.consist).toBe('4 coaches');
    // Its working is left as it was (running round does not make it a light engine).
    expect(bf.working.trainTypeId).toBe('ordinary_passenger');
  });

  it('with a departure not yet due, the engine runs round while it waits (the timetable gives it the time)', () => {
    const t = play();
    arriveInP1(t);
    const l = t.state.layouts[0];
    const tt = addTimetable(t.state, l.id, 'session')!;
    tt.startAt = 9 * 60;
    const { entry } = addTrain(t.state, l, tt, { locoId: 'lms5025' })!;
    entry.kind = 'run';
    entry.trainTypeId = 'ordinary_passenger';
    entry.from = { placeId: 'sgc-station', roadId: 'sgc-p1' };
    entry.to = { placeId: 'fy-west', roadId: '' };
    entry.dep = 9 * 60 + 30;
    t.runner.load(tt);
    t.runner.start();
    t.tick(1000);
    expect(t.runner.items[0].state).toBe('waiting');
    expect(t.sim.jobsText('sigsim-central').join(' ')).toMatch(/run round/);
    const blocked = new Set<string>();
    expect(t.until(() => (blockBackAsAsked(t, blocked), t.loco('lms5025').working.locoEnd?.end === 0), 900_000)).toBe(true);
    expect(t.runner.items[0].state).toBe('waiting');
  });
});
