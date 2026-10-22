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
    // Distant: a clear run through P1 or P2 and out on to the line.
    expect(row('1').releasedBy).toEqual(['(2.16 or 3.17)']);
    // Home to P1: FPLs in; points 6 and 11 normal; opposing starters and home locked.
    expect(row('2').releasedBy).toEqual(['5', '10']);
    expect(row('2').locks).toEqual(['6', '7', '11', '12', '18']);
    // Home to P2: points 6 reversed and bolted.
    expect(row('3').releasedBy).toEqual(['5', '6']);
    // Goods home: points 11 and catch points 14 reversed, yard points 15 held whichever way the road is.
    expect(row('4').releasedBy).toEqual(['5', '10', '11', '14', '(– or 15)']);
    expect(row('4').bothWays).toEqual(['15']);
    // Points only move with their FPL out.
    expect(row('6').note).toMatch(/with 5 normal/);
    expect(row('22').releasedBy).toEqual(['(18.12.7 or 19.8)']);
  });

  it('works the frame: points need their FPL out, signals need the route set and no conflict off', () => {
    const { il, sig } = sgc();
    const f = new Frame(il());
    const two = `sig:${sig('2').id}`;
    expect(f.why(two, 'R')).toMatch(/FPL 5 must be in/);
    // Set the route by hand: FPLs in, then the home comes off.
    const j1 = il().levers.find((x) => x.number === '6')!.id;
    f.move(`fpl:${j1}`, 'R');
    expect(f.move(`pts:${j1}`, 'R')).toMatch(/FPL 5 is in/);
    f.move(`fpl:${il().levers.find((x) => x.number === '11')!.id}`, 'R');
    expect(f.move(two, 'R')).toBe('');
    // With the home to P1 off, the opposing home and starter are locked, and the points held.
    expect(f.why(`sig:${sig('18').id}`, 'R')).toMatch(/locked by 2|FPL/);
    expect(f.why(`fpl:${j1}`, 'N')).toMatch(/held by 2/);
    // The distant only once the starter ahead is off too.
    expect(f.why(`sig:${sig('1').id}`, 'R')).toMatch(/16 must be off/);
    expect(f.setRoute(sig('16').id)).toBe('');
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
    expect(f.pointsLie(il().levers.find((x) => x.number === '6')!.id)).toBe('reverse');
    // The starter from P2 westbound is locked by the home into P2.
    expect(f.setRoute(sig('8').id)).toMatch(/locked by 3/);
    f.replace(sig('3').id);
    f.normalise();
    expect(f.pointsLie(il().levers.find((x) => x.number === '6')!.id)).toBe('normal');
    expect(f.setRoute(sig('8').id)).toBe('');
  });

  it('applies overrides: points left free, a lock added or removed', () => {
    const { s, l, sig, row } = sgc();
    const j3 = l.trackPlan.junctions.find((j) => j.id === 'sgc-j3')!;
    // The goods home no longer holds the yard points on its route to the siding.
    l.trackPlan.interlocking = { routes: { [`${sig('4').id}|buffers:sgc-t8`]: { [j3.id]: 'free' }, [`${sig('4').id}|buffers:sgc-t9`]: { [j3.id]: 'free' } } };
    expect(row('4').bothWays).toEqual([]);
    // Add a lock between home 2 and disc 13; remove the one between 2 and 7.
    l.trackPlan.interlocking = { extraLocks: [[sig('2').id, sig('13').id]], removedLocks: [[sig('2').id, sig('7').id]] };
    expect(row('2').locks).toContain('13');
    expect(row('2').locks).not.toContain('7');
    // Kept through a save and load; pruned when a signal goes.
    const back = migrate(JSON.parse(JSON.stringify(s)));
    expect(back.layouts[0].trackPlan.interlocking?.extraLocks).toHaveLength(1);
    l.trackPlan.signals = l.trackPlan.signals!.filter((x) => x.number !== '13');
    pruneInterlocking(l);
    expect(l.trackPlan.interlocking?.extraLocks).toBeUndefined();
  });
});
