import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { boxInterlocking, Frame, lockingTable, pruneInterlocking } from './interlocking';
import { generateSignals, signalsOf } from './signals';
import { migrate } from './store';

const sgc = () => {
  const s = createDefaultState();
  const l = s.layouts[0];
  generateSignals(s, l, { style: 'semaphore', shunt: true, shuntAhead: false });
  const sig = (n: string) => signalsOf(l).find((x) => x.number === n)!;
  const il = () => boxInterlocking(s, l, 'sigsim-central');
  const row = (n: string) => lockingTable(s, l, il()).find((r) => r.lever.number === n)!;
  return { s, l, sig, il, row };
};

describe('interlocking', () => {
  it('generates the locking table for Sigsim Central from the signals and their routes', () => {
    const { row } = sgc();
    // Distant: a clear run through P1 or P2 to the advanced starter, and out on to the line.
    expect(row('1').releasedBy).toEqual(['25', '(2.18 or 3.19)']);
    // Home to P1: FPLs in; points 8 and 13 normal; the opposing advanced starter, starter, discs and home locked.
    expect(row('2').releasedBy).toEqual(['7', '12']);
    expect(row('2').locks).toEqual(['5', '8', '10', '13', '14', '20', '23']);
    // Home to P2: points 8 reversed and bolted.
    expect(row('3').releasedBy).toEqual(['7', '8']);
    // Goods home: points 13 and catch points 16 reversed, yard points 17 held whichever way the road is.
    expect(row('4').releasedBy).toEqual(['7', '12', '13', '16', '(– or 17)']);
    expect(row('4').bothWays).toEqual(['17']);
    // Points only move with their FPL out.
    expect(row('8').note).toMatch(/with 7 normal/);
    expect(row('26').releasedBy).toEqual(['5', '(23.14 or 24.9)']);
  });

  it('works the frame: points need their FPL out, signals need the route set and no conflict off', () => {
    const { il, sig } = sgc();
    const f = new Frame(il());
    const two = `sig:${sig('2').id}`;
    expect(f.why(two, 'R')).toMatch(/FPL 7 must be in/);
    // Set the route by hand: FPLs in, then the home comes off.
    const j1 = il().levers.find((x) => x.number === '8')!.id;
    f.move(`fpl:${j1}`, 'R');
    expect(f.move(`pts:${j1}`, 'R')).toMatch(/FPL 7 is in/);
    f.move(`fpl:${il().levers.find((x) => x.number === '13')!.id}`, 'R');
    expect(f.move(two, 'R')).toBe('');
    // With the home to P1 off, the opposing home and starter are locked, and the points held.
    expect(f.why(`sig:${sig('23').id}`, 'R')).toMatch(/locked by 2|FPL/);
    expect(f.why(`fpl:${j1}`, 'N')).toMatch(/held by 2/);
    // The distant only once the starter and advanced starter ahead are off too.
    expect(f.why(`sig:${sig('1').id}`, 'R')).toMatch(/(18|25) must be off/);
    expect(f.setRoute(sig('18').id)).toBe('');
    expect(f.setRoute(sig('25').id)).toBe('');
    expect(f.move(`sig:${sig('1').id}`, 'R')).toBe('');
    // The home can't go back while the distant is off; replace() puts the distant back first.
    expect(f.why(two, 'N')).toMatch(/held off by 1/);
    f.replace(sig('2').id);
    expect(f.offSignals().map((id) => signalsOf(sgc().l).length && id)).not.toContain(sig('2').id);
    expect(f.reversed(`sig:${sig('1').id}`)).toBe(false);
  });

  it('the automatic signaller sets routes and respects locks', () => {
    const { il, sig } = sgc();
    const f = new Frame(il());
    expect(f.setRoute(sig('3').id)).toBe('');
    expect(f.pointsLie(il().levers.find((x) => x.number === '8')!.id)).toBe('reverse');
    // The starter from P2 westbound is locked by the home into P2.
    expect(f.setRoute(sig('9').id)).toMatch(/locked by 3/);
    f.replace(sig('3').id);
    f.normalise();
    expect(f.pointsLie(il().levers.find((x) => x.number === '8')!.id)).toBe('normal');
    expect(f.setRoute(sig('9').id)).toBe('');
  });

  it('applies overrides: points left free, a lock added or removed', () => {
    const { s, l, sig, row } = sgc();
    const j3 = l.trackPlan.junctions.find((j) => j.id === 'sgc-j3')!;
    // The goods home no longer holds the yard points on its route to the siding.
    l.trackPlan.interlocking = { routes: { [`${sig('4').id}|buffers:sgc-t8`]: { [j3.id]: 'free' }, [`${sig('4').id}|buffers:sgc-t9`]: { [j3.id]: 'free' } } };
    expect(row('4').bothWays).toEqual([]);
    // Add a lock between home 2 and disc 15; remove the one between 2 and 5.
    l.trackPlan.interlocking = { extraLocks: [[sig('2').id, sig('15').id]], removedLocks: [[sig('2').id, sig('5').id]] };
    expect(row('2').locks).toContain('15');
    expect(row('2').locks).not.toContain('5');
    // Kept through a save and load; pruned when a signal goes.
    const back = migrate(JSON.parse(JSON.stringify(s)));
    expect(back.layouts[0].trackPlan.interlocking?.extraLocks).toHaveLength(1);
    l.trackPlan.signals = l.trackPlan.signals!.filter((x) => x.number !== '15');
    pruneInterlocking(l);
    expect(l.trackPlan.interlocking?.extraLocks).toBeUndefined();
  });
});
