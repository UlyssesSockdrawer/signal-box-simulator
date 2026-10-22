import { describe, expect, it } from 'vitest';
import { createDefaultState as shippedState, SCHEMA_VERSION } from './defaults';
import {
  addSignal,
  deleteSignal,
  generateSignals,
  needsFpl,
  numberLevers,
  postRoutes,
  routesFrom,
  runningCircuits,
  signalIssues,
  signalPoint,
  signalRoutes,
  signalsOf,
  updateSignal,
} from './signals';
import { migrate } from './store';
import { pruneSignals } from './trackPlan';
import type { AppState, PlanSignal } from './types';

const sgc = () => {
  const s: AppState = shippedState();
  const l = s.layouts[0];
  const code = (id: string) => l.trackPlan.circuits.find((c) => c.id === id)!.code;
  const junction = (id: string) => l.trackPlan.junctions.find((j) => j.id === id)!;
  const show = (x: PlanSignal) => `${x.number}:${x.kind}@${code(x.circuitId)}.${x.end}`;
  return { s, l, code, junction, show };
};

describe('signals on the plan', () => {
  it('generates a complete semaphore arrangement for Sigsim Central, numbered west to east', () => {
    const { s, l, code, junction } = sgc();
    const r = generateSignals(s, l, { style: 'semaphore', shunt: true, shuntAhead: false });
    expect(r).toEqual({ added: 14, kept: 0 });
    const sig = signalsOf(l);
    expect(sig.every((x) => x.style === 'semaphore' && !x.manual && x.boxId === 'sigsim-central')).toBe(true);
    const byKind = (k: string) => sig.filter((x) => x.kind === k).map((x) => `${code(x.circuitId)}.${x.end}`).sort();
    // Homes where each line meets the station: three arms from the west (P1, P2, goods), two from the east.
    expect(byKind('home')).toEqual(['T10.0', 'T10.0', 'T2.1', 'T2.1', 'T2.1']);
    // Starters at the ends of the platforms; an advanced starter at the west end, as the goods yard joins in between.
    expect(byKind('starter')).toEqual(['T3.0', 'T4.0', 'T4.1', 'T5.0', 'T5.1']);
    expect(byKind('distant')).toEqual(['T10.0', 'T2.1']);
    // Shunt signals: out of the goods neck, and on the west end for setting back.
    expect(byKind('shunt')).toEqual(['T3.1', 'T6.0']);
    // The home arms read one destination each.
    const homes = sig.filter((x) => x.kind === 'home' && x.circuitId === 'sgc-t2');
    expect(homes.map((x) => signalRoutes(s, l, x).map((rt) => rt.label).sort().join('+')).sort()).toEqual(['to Goods shed+to Goods siding', 'to P1', 'to P2']);
    // Levers 1 to 22 in one frame, west to east, with no gaps or repeats.
    const levers = [...sig.filter((x) => x.number).map((x) => Number(x.number)), ...l.trackPlan.junctions.flatMap((j) => (j.kind === 'joint' ? [] : [Number(j.number), ...(j.fplNumber ? [Number(j.fplNumber)] : [])]))];
    expect(levers.sort((a, b) => a - b)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect(sig.find((x) => x.kind === 'distant' && x.circuitId === 'sgc-t2')!.number).toBe('1');
    expect(sig.find((x) => x.kind === 'distant' && x.circuitId === 'sgc-t10')!.number).toBe('22');
    // Points take their lever numbers; facing points on running lines have locks just before them.
    expect(junction('sgc-j1').number).toBe('6');
    expect(junction('sgc-j1').fplNumber).toBe('5');
    expect(needsFpl(s, l, junction('sgc-j1'))).toBe(true);
    expect(needsFpl(s, l, junction('sgc-j2'))).toBe(true);
    expect(needsFpl(s, l, junction('sgc-j4'))).toBe(true);
    expect(needsFpl(s, l, junction('sgc-j3'))).toBe(false); // yard points
    expect(needsFpl(s, l, junction('sgc-j5'))).toBe(false); // catch points
    expect(junction('sgc-j3').fplNumber).toBeUndefined();
    expect(signalIssues(s, l)).toEqual([]);
  });

  it('running roads: the lines, the platforms and the west end; not the goods neck, throat or yard roads', () => {
    const { s, l, code } = sgc();
    expect([...runningCircuits(s, l, s.boxes[0])].map(code).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T10', 'T11']);
  });

  it('colour light or mixed; shunt-ahead with a limit of shunt in the section', () => {
    const { s, l } = sgc();
    generateSignals(s, l, { style: 'colourLight', shunt: false, shuntAhead: true });
    const sig = signalsOf(l);
    expect(sig.every((x) => x.style === 'colourLight')).toBe(true);
    expect(sig.some((x) => x.kind === 'shunt')).toBe(false);
    const sa = sig.filter((x) => x.kind === 'shuntAhead');
    expect(sa).toHaveLength(4);
    const los = sig.filter((x) => x.kind === 'limitOfShunt');
    expect(los.map((x) => [x.circuitId, x.end, x.back, x.number])).toEqual([
      ['sgc-t2', 0, 1409, ''],
      ['sgc-t10', 1, 1409, ''],
    ]);
    // A shunt-ahead's route goes into the section as far as the limit of shunt.
    expect(signalRoutes(s, l, sa[0]).map((r) => r.key)[0]).toMatch(/^sig:sgc-t(2|10)\|/);
    expect(sa.every((x) => signalRoutes(s, l, x).every((r) => r.label === 'to the limit of shunt'))).toBe(true);
    // Mixed: every arm on one post has the same style; both styles appear.
    let n = 0;
    generateSignals(s, l, { style: 'mixed', shunt: true, shuntAhead: false }, () => (n++ % 2 ? 0.9 : 0.1));
    const posts = new Map<string, Set<string>>();
    for (const x of signalsOf(l)) posts.set(`${x.circuitId}|${x.end}|${x.back}`, (posts.get(`${x.circuitId}|${x.end}|${x.back}`) ?? new Set()).add(x.style));
    expect([...posts.values()].every((v) => v.size === 1)).toBe(true);
    expect(new Set(signalsOf(l).map((x) => x.style)).size).toBe(2);
  });

  it('keeps signals placed or changed by hand when generating again; a home you placed stops generated homes there', () => {
    const { s, l } = sgc();
    generateSignals(s, l);
    const mine = addSignal(s, l, { circuitId: 'sgc-t10', end: 0, back: 0 }, 'home', 'colourLight');
    expect(mine.manual).toBe(true);
    expect(mine.boxId).toBe('sigsim-central');
    const p1 = signalsOf(l).find((x) => x.kind === 'starter' && x.circuitId === 'sgc-t4' && x.end === 1)!;
    updateSignal(l, p1.id, { name: 'Down Starter P1' });
    const r = generateSignals(s, l);
    expect(r.kept).toBe(2);
    const sig = signalsOf(l);
    expect(sig.find((x) => x.id === mine.id)).toBeTruthy();
    expect(sig.find((x) => x.id === p1.id)?.name).toBe('Down Starter P1');
    // Only your home at the east end now (no generated arms beside it): it reads both platforms.
    const east = sig.filter((x) => x.kind === 'home' && x.circuitId === 'sgc-t10');
    expect(east).toHaveLength(1);
    expect(signalRoutes(s, l, east[0]).map((rt) => rt.label).sort()).toEqual(['to P1', 'to P2']);
    // No second starter generated where yours stands.
    expect(sig.filter((x) => x.kind === 'starter' && x.circuitId === 'sgc-t4' && x.end === 1)).toHaveLength(1);
  });

  it('routes follow the plan: a route no arm reads is flagged, and an unpinned arm picks it up by itself', () => {
    const { s, l } = sgc();
    generateSignals(s, l);
    const homes = signalsOf(l).filter((x) => x.kind === 'home' && x.circuitId === 'sgc-t2');
    const toP2 = homes.find((x) => signalRoutes(s, l, x).some((r) => r.label === 'to P2'))!;
    deleteSignal(l, toP2.id);
    expect(signalIssues(s, l).map((i) => i.text).join(' ')).toMatch(/reads the route to P2/);
    // Let the goods arm read whatever is left: it now reads the goods yard and P2.
    const goods = homes.find((x) => signalRoutes(s, l, x).some((r) => r.label === 'to Goods shed'))!;
    updateSignal(l, goods.id, { reads: undefined });
    expect(signalRoutes(s, l, goods).map((r) => r.label).sort()).toEqual(['to Goods shed', 'to Goods siding', 'to P2']);
    expect(signalIssues(s, l).filter((i) => /reads the route/.test(i.text))).toEqual([]);
    expect(postRoutes(s, l, goods).routes).toHaveLength(4);
  });

  it('shunt routes end at the next signal of any kind; running routes run on past shunt signals', () => {
    const { s, l, code } = sgc();
    generateSignals(s, l);
    const fromWestEnd = routesFrom(s, l, { circuitId: 'sgc-t3', end: 1, back: 0 }, 'shunt').map((r) => `${r.label}:${r.steps.map((x) => code(x.circuitId)).join('-')}`);
    expect(fromWestEnd.sort()).toEqual(['to Goods shed:T6-T7-T9', 'to Goods siding:T6-T7-T8', 'to P1:T4']);
    // From the goods neck to the west end's advanced starter.
    const disc = signalsOf(l).find((x) => x.kind === 'shunt' && x.circuitId === 'sgc-t6')!;
    expect(signalRoutes(s, l, disc).map((r) => r.label)).toEqual(['to West end']);
  });

  it('places a signal where it stands on the drawing, and numbers a new one into the frame', () => {
    const { s, l } = sgc();
    generateSignals(s, l);
    const d = signalsOf(l).find((x) => x.kind === 'distant' && x.circuitId === 'sgc-t2')!;
    const home = signalsOf(l).find((x) => x.kind === 'home' && x.circuitId === 'sgc-t2')!;
    const pd = signalPoint(s, l, d)!;
    const ph = signalPoint(s, l, home)!;
    expect(pd.x).toBeLessThan(ph.x); // the distant stands out on the line, west of the home
    expect(pd.dx).toBeGreaterThan(0); // for eastbound trains
    const extra = addSignal(s, l, { circuitId: 'sgc-t8', end: 0, back: 20 }, 'shuntYellow', 'semaphore');
    expect(extra.number).toBe('23');
    updateSignal(l, extra.id, { number: '2' });
    expect(signalIssues(s, l).map((i) => i.text).join(' ')).toMatch(/Lever 2 is used twice/);
    numberLevers(s, l);
    expect(signalIssues(s, l).filter((i) => /used twice/.test(i.text))).toEqual([]);
  });

  it('saved signals load cleanly: bad ones dropped, signals on deleted track pruned', () => {
    const { s, l } = sgc();
    generateSignals(s, l);
    const raw = JSON.parse(JSON.stringify(s));
    raw.layouts[0].trackPlan.signals.push({ id: 'x1', kind: 'wobbly', circuitId: 'sgc-t1', end: 1 }, { id: 'x2', kind: 'home', circuitId: 'gone', end: 1 }, { id: 'x3', kind: 'shunt', circuitId: 'sgc-t8', end: 0, back: -5, style: 'odd', number: 7, boxId: 'nobox' });
    raw.layouts[0].trackPlan.junctions[1].lock = 'maybe';
    const m = migrate(raw);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    const ms = signalsOf(m.layouts[0]);
    expect(ms.find((x) => x.id === 'x1')).toBeUndefined();
    expect(ms.find((x) => x.id === 'x2')).toBeUndefined();
    expect(ms.find((x) => x.id === 'x3')).toMatchObject({ back: 0, style: 'semaphore', number: '7', boxId: '', manual: false });
    expect(m.layouts[0].trackPlan.junctions[1].lock).toBeUndefined();
    expect(ms).toHaveLength(15);
    expect(migrate(JSON.parse(JSON.stringify(m)))).toEqual(m);
    // Track deleted: its signals go with it.
    l.trackPlan.circuits = l.trackPlan.circuits.filter((c) => c.id !== 'sgc-t6');
    expect(pruneSignals(l.trackPlan)).toBe(1);
    // A fresh install has no signals (the example is generated with one press).
    expect(shippedState().layouts[0].trackPlan.signals).toBeUndefined();
  });

  it('keeps generated bracket arms reading their roads when a signal is added part way along a route', () => {
    const { s, l } = sgc();
    generateSignals(s, l, { style: 'semaphore', shunt: true, shuntAhead: false });
    const homes = signalsOf(l).filter((x) => x.kind === 'home' && x.circuitId === 'sgc-t2');
    const before = homes.map((x) => signalRoutes(s, l, x).map((r) => r.label).sort().join('+'));
    // A starter half way along platform 1, facing east: the P1 arm now reads to it.
    addSignal(s, l, { circuitId: 'sgc-t4', end: 1, back: 60 }, 'starter', 'colourLight');
    expect(homes.map((x) => signalRoutes(s, l, x).map((r) => r.label).sort().join('+'))).toEqual(before);
    const p1 = homes.find((x) => x.name.endsWith('to P1'))!;
    expect(signalRoutes(s, l, p1)[0].to).toMatchObject({ kind: 'signal', circuitId: 'sgc-t4' });
    expect(signalIssues(s, l).filter((x) => homes.some((h) => h.id === x.signalId))).toEqual([]);
  });

  it('puts a yellow shunt signal where a headshunt leaves the line to the yard', () => {
    const { s, l } = sgc();
    const p = l.trackPlan;
    // Sigsim Central with a headshunt: points part way up the goods neck, the headshunt running back west.
    p.circuits = p.circuits.filter((c) => c.id !== 'sgc-t6');
    p.junctions.push({ id: 'hs-j', kind: 'pointsLeft', number: '6', boxId: 'sigsim-central', x: 21, y: -3, rotate: true, mirror: false } as (typeof p.junctions)[number]);
    const t6 = shippedState().layouts[0].trackPlan.circuits.find((c) => c.id === 'sgc-t6')!;
    p.circuits.push(
      { ...t6, id: 'hs-t13', code: 'T13', name: 'Goods neck', ends: [{ kind: 'joined', junctionId: 'sgc-j2', port: 'reverse' }, { kind: 'joined', junctionId: 'hs-j', port: 'reverse' }] },
      { ...t6, id: 'hs-t12', code: 'T12', name: 'Yard neck', via: undefined, ends: [{ kind: 'joined', junctionId: 'hs-j', port: 'toe' }, { kind: 'joined', junctionId: 'sgc-j5', port: 'b' }] },
      { ...t6, id: 'hs-t14', code: 'T14', name: 'Headshunt', via: undefined, ends: [{ kind: 'joined', junctionId: 'hs-j', port: 'normal' }, { kind: 'bufferStops', x: 12, y: -3 }] },
    );
    generateSignals(s, l, { style: 'semaphore', shunt: true, shuntAhead: false });
    const yellow = signalsOf(l).filter((x) => x.kind === 'shuntYellow');
    // On the yard side of the headshunt points, facing them: into the headshunt at danger, towards the main line only when off.
    expect(yellow.map((x) => [x.circuitId, x.end])).toEqual([['hs-t12', 0]]);
    expect(signalRoutes(s, l, yellow[0]).map((r) => r.label).sort()).toEqual(['to Goods neck', 'to Headshunt']);
    // Still a disc at the foot of the neck on to the running line, and none inside the yard.
    expect(signalsOf(l).some((x) => x.kind === 'shunt' && x.circuitId === 'hs-t13' && x.end === 0)).toBe(true);
    expect(signalsOf(l).some((x) => ['sgc-t8', 'sgc-t9', 'sgc-t7', 'hs-t14'].includes(x.circuitId))).toBe(false);
  });
});
