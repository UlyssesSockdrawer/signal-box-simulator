import { describe, expect, it } from 'vitest';
import { accept, play } from './simHarness';

function ring(t: ReturnType<typeof play>, c: typeof t.west, code: string) {
  c.sendBell('1');
  t.tick();
  c.sendBell(code);
  t.tick(8000);
}

/**
 * Bring the Black Five in light off the west line into P1. Off the layout it was turned as needed, so its
 * facing is not settled; `smokeboxEast` says it came in smokebox first (its smokebox facing east).
 */
function lightIntoP1(t: ReturnType<typeof play>, smokeboxEast = false) {
  const bf = t.loco('lms5025');
  bf.location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r1' };
  bf.working = { trainTypeId: 'light_engine', consist: '', headcode: '' };
  expect(t.west.requestIncoming('lms5025', 'light_engine')).toBeNull();
  t.sim.setDestination('sigsim-central', 'sgc-west', { placeId: 'sgc-station', roadId: 'sgc-p1' });
  accept(t, t.west, '2-3');
  expect(t.sim.incoming('sigsim-central', 'sgc-west')?.facing).toBe('');
  expect(t.until(() => !!t.sim.incoming('sigsim-central', 'sgc-west')?.arrivedDetected)).toBe(true);
  expect(t.trains.source.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms5025', at: { placeId: 'sgc-station', roadId: 'sgc-p1' }, by: 'person' })).toBe('applied');
  ring(t, t.west, '2-1');
  t.west.setInstrument('LB');
  expect(bf.working.facingFree).toBe(true);
  if (smokeboxEast) {
    delete bf.working.facingFree;
    bf.working.facing = { circuitId: 'sgc-t4', end: 1 };
  }
  return bf;
}

/** Send it away west as a light engine; returns the departure status seen. */
function awayWest(t: ReturnType<typeof play>): string {
  t.west.setOutgoing('lms5025', 'light_engine');
  ring(t, t.west, '2-3');
  let seen = '';
  expect(t.until(() => ((seen = t.sim.outgoingText('sigsim-central', 'sgc-west') || seen), /departing/.test(seen)), 60_000)).toBe(true);
  // Train entering section, as it goes.
  t.west.sendBell('2');
  t.tick();
  return seen;
}

describe('which way an engine faces (play mode, v0.3.36)', () => {
  it('in off the west line smokebox first; back out west without turning, it runs tender first', () => {
    const t = play();
    lightIntoP1(t, true);
    expect(awayWest(t)).toMatch(/tender first/);
  });

  it('a train comes on smokebox first, and the railway remembers which way its engine faces', () => {
    const t = play();
    const bf = t.loco('lms5025');
    bf.location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r1' };
    bf.working = { trainTypeId: 'ordinary_passenger', consist: '4 coaches', headcode: '' };
    expect(t.west.requestIncoming('lms5025', 'ordinary_passenger')).toBeNull();
    t.sim.setDestination('sigsim-central', 'sgc-west', { placeId: 'sgc-station', roadId: 'sgc-p1' });
    accept(t, t.west, '3-1');
    expect(t.sim.incoming('sigsim-central', 'sgc-west')?.facing).toBe('smokebox first');
    expect(t.until(() => !!t.sim.incoming('sigsim-central', 'sgc-west')?.arrivedDetected)).toBe(true);
    expect(bf.working.facing).toEqual({ circuitId: 'sgc-t4', end: 1 });
  });

  it('turned on a turntable it runs smokebox first again', () => {
    const t = play();
    const l = t.state.layouts[0];
    // The goods shed road doubles as the turntable road.
    l.places.push({ id: 'tt', kind: 'turntable', name: 'Turntable', shortName: '', notes: '', roads: [{ id: 'tt-r', name: 'Turntable road', notes: '', circuitId: 'sgc-t9' }], workedBy: [{ kind: 'box', boxId: 'sigsim-central' }] });
    const bf = lightIntoP1(t, true);
    let done = false;
    const permitted = new Set<string>();
    const block = () => {
      for (const w of t.sim.permissions('sigsim-central').waiting) {
        if (permitted.has(w.connId) || w.kind !== 'inside') continue;
        const c = w.connId === 'sgc-west' ? t.west : t.east;
        ring(t, c, '2-4');
        c.setInstrument('TOL');
        permitted.add(w.connId);
      }
    };
    const texts = new Set<string>();
    expect(t.sim.shunt('sigsim-central', 'lms5025', { placeId: 'tt', roadId: 'tt-r' }, () => (done = true))).toBeNull();
    expect(t.until(() => (block(), (t.sim as unknown as { trains: Array<{ status: string }> }).trains.forEach((x) => texts.add(x.status)), done), 600_000)).toBe(true);
    expect([...texts]).toContain('Being turned on the turntable.');
    bf.location = { kind: 'place', placeId: 'tt', roadId: 'tt-r' };
    done = false;
    expect(t.sim.shunt('sigsim-central', 'lms5025', { placeId: 'sgc-station', roadId: 'sgc-p1' }, () => (done = true))).toBeNull();
    expect(t.until(() => (block(), done), 600_000)).toBe(true);
    bf.location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' };
    // Turned as needed: it faces whichever way its next run wants, settled when it sets off.
    expect(bf.working.facingFree).toBe(true);
    for (const c of permitted) ring(t, c === 'sgc-west' ? t.west : t.east, '2-1');
    t.west.setInstrument('LB');
    t.east.setInstrument('LB');
    expect(awayWest(t)).toMatch(/smokebox first/);
    expect(bf.working.facingFree).toBeUndefined();
  });

  it('back on to the layout, an engine is turned as an operator would: a train smokebox first, a light engine ready for the train it goes to work', () => {
    for (const [working, consist, expected] of [
      ['light_engine', '', ''],
      ['ordinary_passenger', '4 coaches', 'smokebox first'],
    ] as const) {
      const t = play();
      const bf = lightIntoP1(t, true);
      // Out west tender first (it came in from the west smokebox first and was not turned).
      expect(awayWest(t)).toMatch(/tender first/);
      expect(t.until(() => !!t.west.view.outgoing?.arrived, 300_000)).toBe(true);
      t.tick(5000);
      t.west.sendBell('1');
      t.tick();
      t.west.sendBell('2-1');
      t.tick(20_000);
      expect(t.west.view.outgoing).toBeNull();
      // Offered back off the west line (single or double, out and back or round: it makes no difference).
      bf.working.trainTypeId = working;
      bf.working.consist = consist;
      expect(t.west.requestIncoming('lms5025', working)).toBeNull();
      accept(t, t.west, working === 'light_engine' ? '2-3' : '3-1');
      expect({ working, facing: t.sim.incoming('sigsim-central', 'sgc-west')?.facing }).toEqual({ working, facing: expected });
      expect(!!bf.working.facingFree).toBe(working === 'light_engine');
    }
  });

  it('turned on the turntable to suit its train: back on to the coaches, then away with them smokebox first', () => {
    const t = play();
    const l = t.state.layouts[0];
    l.places.push({ id: 'tt', kind: 'turntable', name: 'Turntable', shortName: '', notes: '', roads: [{ id: 'tt-r', name: 'Turntable road', notes: '', circuitId: 'sgc-t9' }], workedBy: [{ kind: 'box', boxId: 'sigsim-central' }] });
    const bf = lightIntoP1(t);
    // Its coaches stand in P1 (as if it had brought them in from the west and been uncoupled).
    l.stock = [{ id: 'rake-c', description: '4 coaches', vehicles: [{ kind: 'coach', count: 4, metres: 20 }], placeId: 'sgc-station', roadId: 'sgc-p1', circuitId: 'sgc-t4' }];
    const permitted = new Set<string>();
    const block = () => {
      for (const w of t.sim.permissions('sigsim-central').waiting) {
        if (permitted.has(w.connId) || w.kind !== 'inside') continue;
        const c = w.connId === 'sgc-west' ? t.west : t.east;
        ring(t, c, '2-4');
        c.setInstrument('TOL');
        permitted.add(w.connId);
      }
    };
    for (const to of [{ placeId: 'tt', roadId: 'tt-r' }, { placeId: 'sgc-station', roadId: 'sgc-p1' }]) {
      let done = false;
      expect(t.sim.shunt('sigsim-central', 'lms5025', to, () => (done = true))).toBeNull();
      expect(t.until(() => (block(), done), 600_000)).toBe(true);
      bf.location = { kind: 'place', ...to };
    }
    for (const c of permitted) ring(t, c === 'sgc-west' ? t.west : t.east, '2-1');
    t.west.setInstrument('LB');
    t.east.setInstrument('LB');
    // Away west with its coaches (running round first if it came back on at the wrong end).
    bf.working.trainTypeId = 'ordinary_passenger';
    t.west.setOutgoing('lms5025', 'ordinary_passenger');
    let seen = '';
    const blocked2 = new Set<string>();
    expect(
      t.until(() => {
        for (const w of t.sim.permissions('sigsim-central').waiting) {
          if (blocked2.has(w.connId) || w.kind !== 'inside') continue;
          const c = w.connId === 'sgc-west' ? t.west : t.east;
          ring(t, c, '2-4');
          c.setInstrument('TOL');
          blocked2.add(w.connId);
        }
        if (!t.sim.jobsText('sigsim-central').length && blocked2.size) {
          for (const c of blocked2) {
            const cc = c === 'sgc-west' ? t.west : t.east;
            ring(t, cc, '2-1');
            cc.setInstrument('LB');
          }
          blocked2.clear();
        }
        if (!t.west.view.remoteInstrument || t.west.view.remoteInstrument === 'LB') if (!t.sim.jobsText('sigsim-central').length && !t.west.view.outgoing?.departed) ring(t, t.west, '3-1');
        seen = t.sim.outgoingText('sigsim-central', 'sgc-west') || seen;
        return /departing/.test(seen);
      }, 1_800_000),
    ).toBe(true);
    expect(seen).toMatch(/smokebox first/);
    expect(bf.working.consist).toBe('4 coaches');
  });
});
