import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { generateSignals, signalsOf } from './signals';
import { accept, play } from './simHarness';
import { addTimetable, addTrain } from './timetables';

/** Sigsim Central with a generated set of semaphore signals, worked in play mode. */
function signalled() {
  const state = createDefaultState();
  generateSignals(state, state.layouts[0], { style: 'semaphore', shunt: true, shuntAhead: false });
  const t = play({ state });
  const l = state.layouts[0];
  const id = (n: string) => signalsOf(l).find((x) => x.number === n)!.id;
  const frame = () => t.sim.frameOf('sigsim-central')!;
  const off = (n: string) => frame().reversed(`sig:${id(n)}`);
  const offNow = () => signalsOf(l).filter((x) => x.number && frame().reversed(`sig:${x.id}`)).map((x) => x.number);
  /** Every signal pulled off so far (from the frame's log). */
  const pulled = () => [...new Set(frame().log.filter((m) => m.to === 'R' && m.key.startsWith('sig:')).map((m) => signalsOf(l).find((x) => `sig:${x.id}` === m.key)!.number))].sort((a, b) => Number(a) - Number(b));
  return { ...t, l, id, frame, off, offNow, pulled };
}

describe('trains and signals placed on the plan', () => {
  it('a goods train into the shed: the goods home and the disc on its way come off once the route is set, and go back behind it', () => {
    const t = signalled();
    t.west.requestIncoming('lms8233', 'mineral');
    accept(t, t.west, '4-1');
    const view = () => t.sim.incoming('sigsim-central', 'sgc-west')!;
    // Nothing off while it is far out on the line.
    t.tick(500);
    expect(t.offNow()).toEqual([]);
    const seen = new Set<string>();
    expect(t.until(() => (t.offNow().forEach((n) => seen.add(n)), view().locked))).toBe(true);
    t.tick(500);
    t.offNow().forEach((n) => seen.add(n));
    // The goods arm of the bracket (4), with points 11 and catch points 14 reversed and the FPLs in.
    expect(seen).toContain('4');
    const lever = (n: string) => t.frame().il.levers.find((x) => x.number === n)!;
    expect(t.frame().pointsLie(lever('11').id)).toBe('reverse');
    expect(t.frame().pointsLie(lever('14').id)).toBe('reverse');
    expect(t.frame().reversed(lever('10').key)).toBe(true);
    // The other arms stay at danger; the distant can't come off (no run through).
    expect(t.off('2') || t.off('3') || t.off('1')).toBe(false);
    expect(t.until(() => (t.offNow().forEach((n) => seen.add(n)), view().arrivedDetected))).toBe(true);
    // The disc at the west end it passed on the way (9) was cleared for it.
    expect(seen).toContain('9');
    // Everything back to danger behind it, and the points back to normal.
    t.tick(1000);
    expect(t.offNow()).toEqual([]);
    expect(t.frame().pointsLie(lever('11').id)).toBe('normal');
  });

  it('a through express with Line Clear ahead: home, starter, then the distant come off', () => {
    const t = signalled();
    t.workings.setRoute('sgc-west', 'sgc-east');
    t.west.requestIncoming('lms6233', 'express_passenger');
    t.tick();
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('4');
    t.west.setInstrument('LC');
    t.tick(500);
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('4');
    t.tick(8000);
    t.west.sendBell('2');
    t.west.setInstrument('TOL');
    const seen = new Set<string>();
    expect(t.until(() => (t.offNow().forEach((n) => seen.add(n)), seen.has('1')), 60_000)).toBe(true);
    // The disc at the west end stands on its way (facing it), so it is cleared too.
    expect([...seen].sort()).toEqual(['1', '16', '2', '9']);
    t.east.sendBell('2');
    expect(t.until(() => !!t.east.view.outgoing?.arrived)).toBe(true);
    expect(t.offNow()).toEqual([]);
  });

  it('the interlocking governs: with the starter locked by the home (an added lock), the train waits at the starter until the home is back at danger', () => {
    const t = signalled();
    t.l.trackPlan.interlocking = { extraLocks: [[t.id('2'), t.id('16')]] };
    t.east.setOutgoing('lms5025', 'ordinary_passenger');
    // A departure from P1 east would need 16; first bring a train in to P1 from the west.
    t.west.requestIncoming('lms6233', 'express_passenger');
    accept(t, t.west, '4');
    const view = () => t.sim.incoming('sigsim-central', 'sgc-west')!;
    expect(t.until(() => t.off('2'), 120_000)).toBe(true);
    // While 2 is off, 16 can't be pulled.
    expect(t.frame().why(`sig:${t.id('16')}`, 'R')).toMatch(/locked by 2/);
    expect(t.until(() => !t.off('2'))).toBe(true);
    expect(t.frame().why(`sig:${t.id('16')}`, 'R')).not.toMatch(/locked by 2/);
    expect(t.until(() => view().arrivedDetected)).toBe(true);
  });

  it('a departure from the goods yard: out under the disc, setting back at the west end under the next disc, then the starter with Line Clear', () => {
    const t = signalled();
    t.loco('lms7298').working.trainTypeId = 'pickup_goods';
    t.east.setOutgoing('lms7298', 'pickup_goods');
    t.tick(2000);
    expect(t.offNow()).toEqual([]);
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('3');
    t.tick();
    t.east.sendBell('2');
    const seen = new Set<string>();
    expect(t.until(() => (t.offNow().forEach((n) => seen.add(n)), !!t.east.view.outgoing?.arrived))).toBe(true);
    expect(t.pulled()).toEqual(['9', '13', '16']);
    expect(t.offNow()).toEqual([]);
  });

  it('a timetabled shunt from the goods yard to a platform runs under the shunt signals', () => {
    const t = signalled();
    const tt = addTimetable(t.state, t.l.id, 'sequence')!;
    const { entry } = addTrain(t.state, t.l, tt, { locoId: 'lms7298' })!;
    entry.kind = 'shunt';
    entry.trainTypeId = 'light_engine';
    entry.to = { placeId: 'sgc-station', roadId: '' };
    t.runner.load(tt);
    t.runner.start();
    expect(t.until(() => t.runner.items[0].state === 'done')).toBe(true);
    // Out under the goods neck disc (13), back under the west end disc (9).
    expect(t.pulled()).toEqual(['9', '13']);
    expect(t.offNow()).toEqual([]);
  });
});
