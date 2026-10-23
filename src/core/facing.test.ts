import { describe, expect, it } from 'vitest';
import { accept, play } from './simHarness';

function ring(t: ReturnType<typeof play>, c: typeof t.west, code: string) {
  c.sendBell('1');
  t.tick();
  c.sendBell(code);
  t.tick(8000);
}

/** Bring the Black Five in light off the west line into P1 (smokebox first, so its smokebox faces east). */
function lightIntoP1(t: ReturnType<typeof play>) {
  const bf = t.loco('lms5025');
  bf.location = { kind: 'place', placeId: 'fy-west', roadId: 'fy-west-r1' };
  bf.working = { trainTypeId: 'light_engine', consist: '', headcode: '' };
  expect(t.west.requestIncoming('lms5025', 'light_engine')).toBeNull();
  t.sim.setDestination('sigsim-central', 'sgc-west', { placeId: 'sgc-station', roadId: 'sgc-p1' });
  accept(t, t.west, '2-3');
  expect(t.sim.incoming('sigsim-central', 'sgc-west')?.facing).toBe('smokebox first');
  expect(t.until(() => !!t.sim.incoming('sigsim-central', 'sgc-west')?.arrivedDetected)).toBe(true);
  expect(t.trains.source.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms5025', at: { placeId: 'sgc-station', roadId: 'sgc-p1' }, by: 'person' })).toBe('applied');
  ring(t, t.west, '2-1');
  t.west.setInstrument('LB');
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
    const bf = lightIntoP1(t);
    expect(bf.working.facing).toEqual({ circuitId: 'sgc-t4', end: 1 });
    expect(awayWest(t)).toMatch(/tender first/);
  });

  it('turned on a turntable it runs smokebox first again', () => {
    const t = play();
    const l = t.state.layouts[0];
    // The goods shed road doubles as the turntable road.
    l.places.push({ id: 'tt', kind: 'turntable', name: 'Turntable', shortName: '', notes: '', roads: [{ id: 'tt-r', name: 'Turntable road', notes: '', circuitId: 'sgc-t9' }], workedBy: [{ kind: 'box', boxId: 'sigsim-central' }] });
    const bf = lightIntoP1(t);
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
    // Now it faces west: away west smokebox first.
    expect(bf.working.facing).toEqual({ circuitId: 'sgc-t4', end: 0 });
    for (const c of permitted) ring(t, c === 'sgc-west' ? t.west : t.east, '2-1');
    t.west.setInstrument('LB');
    t.east.setInstrument('LB');
    expect(awayWest(t)).toMatch(/smokebox first/);
  });

  it('back from a box beyond: the other way round from how it went, unless that box has a turntable (then smokebox first)', () => {
    for (const [turntable, outSmokebox, expected] of [
      [false, false, 'smokebox first'],
      [false, true, 'tender first'],
      [true, true, 'smokebox first'],
    ] as const) {
      const t = play();
      t.state.boxes[0].connections.find((c) => c.id === 'sgc-west')!.turntable = turntable || undefined;
      const bf = lightIntoP1(t);
      // Turned by hand meanwhile, so it goes out smokebox first.
      if (outSmokebox) bf.working.facing = { circuitId: 'sgc-t4', end: 0 };
      expect(awayWest(t)).toMatch(outSmokebox ? /smokebox first/ : /tender first/);
      expect(t.until(() => !!t.west.view.outgoing?.arrived, 300_000)).toBe(true);
      expect(bf.working.offFacing).toEqual({ connectionId: 'sgc-west', smokeboxFirst: outSmokebox });
      t.tick(5000);
      t.west.sendBell('1');
      t.tick();
      t.west.sendBell('2-1');
      t.tick(20_000);
      expect(t.west.view.outgoing).toBeNull();
      // Offered back off the west line.
      expect(t.west.requestIncoming('lms5025', 'light_engine')).toBeNull();
      accept(t, t.west, '2-3');
      expect({ turntable, outSmokebox, facing: t.sim.incoming('sigsim-central', 'sgc-west')?.facing }).toEqual({ turntable, outSmokebox, facing: expected });
    }
  });
});
