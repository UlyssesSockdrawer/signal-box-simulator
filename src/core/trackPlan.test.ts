import { describe, expect, it } from 'vitest';
import { addConnection, deleteBox, addBox, removeConnection } from './boxes';
import { createDefaultState } from './defaults';
import { migrate } from './store';
import {
  addJunctionInTrack,
  addTrack,
  branchFrom,
  checkCircuitCode,
  circuitPath,
  connectParallel,
  deleteJunction,
  findCircuit,
  findJunction,
  turnRound,
  addBend,
  removeBend,
  parallelTrack,
  parallelSideNames,
  addDoubleTrack,
  rotateQuarter,
  setTurntableRoads,
  freePorts,
  mergeAtJoint,
  acrossJoint,
  crossoverFrom,
  mirrorJunction,
  circuitPath as pathOf,
  giveBranch,
  grow,
  JUNCTIONS,
  joinOpenEnds,
  neighbours,
  openEnds,
  planIssues,
  portAnchor,
  setJunctionKind,
  splitCircuit,
  checkPlatformNumber,
  platformPath,
  platformsOf,
  setPlatform,
  deleteCircuit,
  detachEnd,
  lineRun,
  setDoubleLine,
  setTraffic,
  tracksAlongside,
} from './trackPlan';
import type { AppState, TrackPlan } from './types';

const plan = (): TrackPlan => ({ circuits: [], junctions: [] });

describe('track plan: starting out', () => {
  it('ships with an empty plan, and old saves get one', () => {
    expect(migrate(createDefaultState()).layouts[0].trackPlan).toEqual({ circuits: [], junctions: [], markers: [] });
    // A save from before layouts, with no track plan.
    const old = createDefaultState() as unknown as Record<string, unknown>;
    old.fiddleYards = (old.layouts as AppState['layouts'])[0].fiddleYards;
    delete old.layouts;
    expect(migrate(old).layouts[0].trackPlan).toEqual({ circuits: [], junctions: [], markers: [] });
  });

  it('lays a first track with two unfinished ends, then more tracks below it', () => {
    const p = plan();
    const a = addTrack(p);
    expect(a.code).toBe('T1');
    expect(openEnds(p)).toHaveLength(2);
    const b = addTrack(p);
    expect(b.code).toBe('T2');
    const ya = (a.ends[0] as { y: number }).y;
    const yb = (b.ends[0] as { y: number }).y;
    expect(yb - ya).toBe(3);
  });

  it('checks codes are given and unique', () => {
    const p = plan();
    const a = addTrack(p);
    addTrack(p);
    expect(checkCircuitCode(p, '', a.id)).toMatch(/code/);
    expect(checkCircuitCode(p, 't2', a.id)).toMatch(/already/);
    expect(checkCircuitCode(p, 'T1', a.id)).toBeNull();
  });
});

describe('track plan: growing from the ends', () => {
  it('terminates a track at buffer stops or sends it off the scene', () => {
    const p = plan();
    const a = addTrack(p);
    grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'bufferStops');
    grow(p, { kind: 'end', circuitId: a.id, end: 0 }, 'exit');
    expect(a.ends[1].kind).toBe('bufferStops');
    expect(a.ends[0].kind).toBe('exit');
    expect(openEnds(p)).toHaveLength(0);
  });

  it('continues a track as a new circuit beyond a joint', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'track')!;
    const n = findCircuit(p, r.circuitId!)!;
    expect(p.junctions[0].kind).toBe('joint');
    expect(neighbours(p, a).map((x) => x.circuit.id)).toEqual([n.id]);
    // The new circuit carries on to the right, level.
    const path = circuitPath(p, n);
    expect(path[path.length - 1].x).toBeGreaterThan(path[0].x);
    expect(path[0].y).toBe(path[path.length - 1].y);
  });

  it('adds points at an end: the toe joins and both roads are unfinished', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    const j = findJunction(p, r.junctionId!)!;
    expect(a.ends[1]).toEqual({ kind: 'joined', junctionId: j.id, port: 'toe' });
    const ends = openEnds(p);
    expect(ends).toHaveLength(3);
    expect(ends.filter((e) => e.kind === 'port').map((e) => (e as { port: string }).port).sort()).toEqual(['normal', 'reverse']);
  });

  it('points added at a left-hand end face left', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 0 }, 'pointsLeft')!;
    const j = findJunction(p, r.junctionId!)!;
    expect(j.rotate).toBe(true);
    expect(portAnchor(j, 'normal')!.dx).toBe(-1);
    // Left-hand travelling left turns to the left of the direction of travel: downwards on the plan.
    expect(portAnchor(j, 'reverse')!.dy).toBe(1);
  });

  it('a turnout road takes a 45 degree run, then goes level, one track spacing away', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    const g = grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'reverse' }, 'track')!;
    const path = circuitPath(p, findCircuit(p, g.circuitId!)!);
    expect(path).toHaveLength(3);
    expect(path[1].x - path[0].x).toBe(path[1].y - path[0].y);
    const j = findJunction(p, r.junctionId!)!;
    expect(path[2].y - j.y).toBe(3);
  });

  it('builds three-way points, slips and scissors with the right routes', () => {
    expect(JUNCTIONS.threeWay.ports).toHaveLength(4);
    expect(JUNCTIONS.threeWay.routes).toHaveLength(3);
    expect(JUNCTIONS.diamond.routes).toHaveLength(2);
    expect(JUNCTIONS.singleSlip.routes).toHaveLength(3);
    expect(JUNCTIONS.doubleSlip.routes).toHaveLength(4);
    expect(JUNCTIONS.scissors.routes).toHaveLength(4);
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'doubleSlip')!;
    expect(openEnds(p).filter((e) => e.kind === 'port')).toHaveLength(3);
    // A slip from a junction port gets a short circuit in between.
    const g = grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'c' }, 'threeWay')!;
    expect(p.circuits).toHaveLength(2);
    expect(findJunction(p, g.junctionId!)!.kind).toBe('threeWay');
  });
});

describe('track plan: connecting tracks', () => {
  const twoParallel = (gap = 3) => {
    const p = plan();
    const a = addTrack(p);
    const b = addTrack(p);
    for (const e of b.ends) if (e.kind !== 'joined') e.y = (a.ends[0] as { y: number }).y + gap;
    return { p, a, b };
  };

  it.each(['rising', 'falling'] as const)('connects two parallel tracks with a %s crossover', (lean: 'rising' | 'falling') => {
    const { p, a, b } = twoParallel(3);
    const r = connectParallel(p, a.id, b.id, lean);
    expect(r.error).toBeUndefined();
    expect(p.junctions).toHaveLength(2);
    expect(p.circuits).toHaveLength(5);
    const x = findCircuit(p, r.circuitId!)!;
    const path = circuitPath(p, x);
    expect(path).toHaveLength(2);
    expect(Math.abs(path[1].x - path[0].x)).toBe(Math.abs(path[1].y - path[0].y));
    // From the upper track you can now reach the lower one through the crossover.
    expect(branchFrom(p, a.id).circuits).toHaveLength(5);
    expect(openEnds(p)).toHaveLength(4);
    if (lean === 'rising') expect(path[1].x > path[0].x === path[1].y < path[0].y).toBe(true);
  });

  it('refuses tracks that are the same, too close, or not side by side', () => {
    const { p, a, b } = twoParallel(1);
    expect(connectParallel(p, a.id, a.id, 'rising').error).toMatch(/different/);
    expect(connectParallel(p, a.id, b.id, 'rising').error).toMatch(/too close/);
    const q = twoParallel(3);
    for (const e of q.b.ends) if (e.kind !== 'joined') e.x += 40;
    expect(connectParallel(q.p, q.a.id, q.b.id, 'rising').error).toMatch(/long enough|side by side/);
  });

  it('joins two unfinished ends with a joint, or an end to a junction road', () => {
    const p = plan();
    const a = addTrack(p);
    const b = addTrack(p);
    expect(joinOpenEnds(p, { kind: 'end', circuitId: a.id, end: 1 }, { kind: 'end', circuitId: b.id, end: 0 }).error).toBeUndefined();
    expect(openEnds(p)).toHaveLength(2);
    expect(neighbours(p, a)[0].circuit.id).toBe(b.id);
    const r = grow(p, { kind: 'end', circuitId: b.id, end: 1 }, 'pointsRight')!;
    expect(joinOpenEnds(p, { kind: 'end', circuitId: a.id, end: 0 }, { kind: 'port', junctionId: r.junctionId!, port: 'reverse' }).error).toBeUndefined();
    expect(a.ends[0]).toMatchObject({ kind: 'joined', port: 'reverse' });
    expect(joinOpenEnds(p, { kind: 'end', circuitId: a.id, end: 0 }, { kind: 'end', circuitId: a.id, end: 1 }).error).toBeTruthy();
  });

  it('puts points into the middle of a track and splits tracks', () => {
    const p = plan();
    const a = addTrack(p);
    const r = addJunctionInTrack(p, a.id, 'pointsRight', false);
    expect(r.error).toBeUndefined();
    expect(p.circuits).toHaveLength(2);
    expect(openEnds(p)).toHaveLength(3);
    const s = splitCircuit(p, a.id);
    expect(s.error).toBeUndefined();
    expect(p.circuits).toHaveLength(3);
  });
});

describe('track plan: editing junctions', () => {
  it('deleting points leaves the tracks with unfinished ends', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    deleteJunction(p, r.junctionId!);
    expect(a.ends[1].kind).toBe('open');
    expect(p.junctions).toHaveLength(0);
  });

  it('changing the type keeps the ports it still has', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'threeWay')!;
    grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'right' }, 'bufferStops');
    setJunctionKind(p, r.junctionId!, 'pointsRight');
    expect(a.ends[1]).toMatchObject({ port: 'toe' });
    // Unfinished: the far end of T1, both roads of the RH points, and the old right road's track.
    expect(openEnds(p).length).toBe(4);
  });

  it('right-hand points keep their hand whichever way they face', () => {
    const p = plan();
    const a = addTrack(p);
    // Grown off the left-hand end, travelling left: the turnout must go to the right of travel (up the plan).
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 0 }, 'pointsRight')!;
    const j = findJunction(p, r.junctionId!)!;
    const rev = portAnchor(j, 'reverse')!;
    expect(rev.dx).toBe(-1);
    expect(rev.dy).toBe(-1);
  });

  it('turning facing points round makes them trailing, with the track kept joined', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    const j = findJunction(p, r.junctionId!)!;
    const join = portAnchor(j, 'toe')!;
    expect(turnRound(p, j.id).error).toBeUndefined();
    // T1 now joins the straight road, at the same place; the toe faces onwards, still right-hand.
    expect(a.ends[1]).toMatchObject({ kind: 'joined', port: 'normal' });
    const n = portAnchor(j, 'normal')!;
    expect([n.x, n.y]).toEqual([join.x, join.y]);
    expect(portAnchor(j, 'toe')!.x).toBeGreaterThan(join.x);
    expect(portAnchor(j, 'toe')!.dx).toBe(1);
    expect(portAnchor(j, 'reverse')!).toMatchObject({ dx: -1, dy: -1 });
    // And back again.
    turnRound(p, j.id);
    expect(a.ends[1]).toMatchObject({ port: 'toe' });
    expect([portAnchor(j, 'toe')!.x, portAnchor(j, 'toe')!.y]).toEqual([join.x, join.y]);
  });

  it('a track coming in on a diagonal joins the turnout road when the points are turned round', () => {
    const p = plan();
    const t1 = addTrack(p);
    const p1 = grow(p, { kind: 'end', circuitId: t1.id, end: 1 }, 'pointsRight')!;
    // A track on the turnout road, then right-hand points on its end: the case from the bug report.
    const t2 = grow(p, { kind: 'port', junctionId: p1.junctionId!, port: 'reverse' }, 'track')!;
    const c2 = findCircuit(p, t2.circuitId!)!;
    for (const e of c2.ends) if (e.kind === 'open') e.x = (portAnchor(findJunction(p, p1.junctionId!)!, 'reverse')!.x) + 2;
    // c2 is now a pure 45° run, ending on the lower track position
    const p2 = grow(p, { kind: 'end', circuitId: c2.id, end: 1 }, 'pointsRight')!;
    turnRound(p, p2.junctionId!);
    expect(c2.ends[1]).toMatchObject({ kind: 'joined', port: 'reverse' });
    const j2 = findJunction(p, p2.junctionId!)!;
    expect(portAnchor(j2, 'toe')!.dx).toBe(1);
    expect(portAnchor(j2, 'normal')!.dx).toBe(-1);
  });

  it('builds a double track converging onto a single line with trailing points', () => {
    const p = plan();
    const up = addTrack(p);
    const down = addTrack(p);
    // Upper track: trailing left-hand points, toe onward (single line), turnout road down and back.
    const r = grow(p, { kind: 'end', circuitId: up.id, end: 1 }, 'pointsLeft', { trailing: true })!;
    const j = findJunction(p, r.junctionId!)!;
    expect(up.ends[1]).toMatchObject({ port: 'normal' });
    expect(portAnchor(j, 'reverse')!).toMatchObject({ dx: -1, dy: 1 });
    // Join the lower track to the turnout road; it rises at 45° into it.
    expect(joinOpenEnds(p, { kind: 'end', circuitId: down.id, end: 1 }, { kind: 'port', junctionId: j.id, port: 'reverse' }).error).toBeUndefined();
    const path = pathOf(p, down);
    const last = path[path.length - 1];
    const prev = path[path.length - 2];
    expect(Math.abs(last.x - prev.x)).toBe(Math.abs(last.y - prev.y));
    // Single line on from the toe, ending at a headshunt-style buffer stop is just as easy.
    const s = grow(p, { kind: 'port', junctionId: j.id, port: 'toe' }, 'track')!;
    expect(findCircuit(p, s.circuitId!)).toBeTruthy();
    // Left ends of both tracks, and the far end of the single line.
    expect(openEnds(p)).toHaveLength(3);
  });

  it('turning round points at the end of a track grown off a turnout road makes a crossover', () => {
    // Matt's steps: T1, facing RH points, track off the turnout road (it levels out), RH points, Turn round.
    const p = plan();
    const t1 = addTrack(p);
    const p1 = grow(p, { kind: 'end', circuitId: t1.id, end: 1 }, 'pointsRight')!;
    const t2 = grow(p, { kind: 'port', junctionId: p1.junctionId!, port: 'reverse' }, 'track')!;
    const c2 = findCircuit(p, t2.circuitId!)!;
    const p2 = grow(p, { kind: 'end', circuitId: c2.id, end: 1 }, 'pointsRight')!;
    const j2 = findJunction(p, p2.junctionId!)!;
    const lineY = portAnchor(j2, 'toe')!.y;
    turnRound(p, j2.id);
    expect(c2.ends[1]).toMatchObject({ kind: 'joined', port: 'reverse' });
    // Still on the same line, toe facing onward, and the track between is a straight 45°.
    expect(j2.y).toBe(lineY);
    expect(portAnchor(j2, 'toe')!.dx).toBe(1);
    const path = pathOf(p, c2);
    expect(path).toHaveLength(2);
    expect(Math.abs(path[1].x - path[0].x)).toBe(Math.abs(path[1].y - path[0].y));
  });

  it('adds a crossover to a new track from a turnout road in one go', () => {
    const p = plan();
    const t1 = addTrack(p);
    const p1 = grow(p, { kind: 'end', circuitId: t1.id, end: 1 }, 'pointsRight')!;
    const r = crossoverFrom(p, { kind: 'port', junctionId: p1.junctionId!, port: 'reverse' });
    expect(r.error).toBeUndefined();
    const j2 = findJunction(p, r.junctionId!)!;
    const j1 = findJunction(p, p1.junctionId!)!;
    // Opposing points of the same hand, three squares below, toe facing onward.
    expect(j2.kind).toBe('pointsRight');
    expect(j2.y - j1.y).toBe(3);
    expect(portAnchor(j2, 'toe')!.dx).toBe(1);
    const x = findCircuit(p, r.circuitId!)!;
    expect(x.ends[1]).toMatchObject({ port: 'reverse' });
    // The new track's toe and straight road are open, ready to carry on both ways.
    const free = openEnds(p).filter((e) => e.kind === 'port' && e.junctionId === j2.id).map((e) => (e as { port: string }).port).sort();
    expect(free).toEqual(['normal', 'toe']);
  });

  it('a crossover from a level end adds the facing points too, and joins an existing track alongside', () => {
    const p = plan();
    const up = addTrack(p);
    const down = addTrack(p);
    // Make the lower track run well past where the crossover lands.
    for (const e of down.ends) if (e.kind === 'open' && e.x > 5) e.x += 20;
    const r = crossoverFrom(p, { kind: 'end', circuitId: up.id, end: 1 }, 'pointsRight');
    expect(r.error).toBeUndefined();
    expect(p.junctions.map((j) => j.kind)).toEqual(['pointsRight', 'pointsRight']);
    // The second points went into the existing lower track, splitting it.
    const j2 = findJunction(p, r.junctionId!)!;
    expect(portAnchor(j2, 'normal') && findCircuit(p, down.id)!.ends.some((e) => e.kind === 'joined' && e.junctionId === j2.id)).toBe(true);
    expect(p.circuits).toHaveLength(4);
  });

  it('a Y on a branch does not send its near road back onto the main line', () => {
    // Main line, right-hand points, branch off the turnout road, Y points at the end of the branch.
    const p = plan();
    const main = addTrack(p);
    const mainY = (main.ends[0] as { y: number }).y;
    const p4 = grow(p, { kind: 'end', circuitId: main.id, end: 1 }, 'pointsRight')!;
    const t7 = grow(p, { kind: 'port', junctionId: p4.junctionId!, port: 'reverse' }, 'track')!;
    const y5 = grow(p, { kind: 'end', circuitId: t7.circuitId!, end: 1 }, 'pointsY')!;
    const left = grow(p, { kind: 'port', junctionId: y5.junctionId!, port: 'left' }, 'track')!;
    const right = grow(p, { kind: 'port', junctionId: y5.junctionId!, port: 'right' }, 'track')!;
    const endY = (id: string) => (findCircuit(p, id)!.ends[1] as { y: number }).y;
    // The main line carries on from the points' straight road, so the left road keeps off its row.
    expect(endY(left.circuitId!)).not.toBe(mainY);
    expect(endY(left.circuitId!)).toBeGreaterThan(mainY);
    expect(endY(left.circuitId!)).toBeLessThan(findJunction(p, y5.junctionId!)!.y);
    // ...and keeps a clear row between itself and the main line.
    expect(endY(left.circuitId!) - mainY).toBeGreaterThanOrEqual(2);
    // Y roads fan out by half a spacing each: the right road lands two rows below the Y.
    expect(endY(right.circuitId!) - findJunction(p, y5.junctionId!)!.y).toBe(2);
  });

  it('merges track circuits that meet at joints into one', () => {
    // Three circuits in a line, like platform 1 laid in three goes.
    const p = plan();
    const a = addTrack(p);
    const b = findCircuit(p, grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'track')!.circuitId!)!;
    const c = findCircuit(p, grow(p, { kind: 'end', circuitId: b.id, end: 1 }, 'track')!.circuitId!)!;
    a.name = 'Platform 1';
    const farEnd = structuredClone(c.ends[1]);
    expect(acrossJoint(p, a.id, 1)!.circuit.id).toBe(b.id);
    expect(mergeAtJoint(p, acrossJoint(p, a.id, 1)!.joint.id, a.id).error).toBeUndefined();
    expect(mergeAtJoint(p, acrossJoint(p, a.id, 1)!.joint.id, a.id).error).toBeUndefined();
    expect(p.circuits).toHaveLength(1);
    expect(p.junctions).toHaveLength(0);
    expect(a.ends[1]).toEqual(farEnd);
    expect(a.code).toBe('T1');
    expect(a.name).toBe('Platform 1');
    expect(openEnds(p)).toHaveLength(2);
  });

  it('only merges across joints', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    expect(mergeAtJoint(p, r.junctionId!).error).toMatch(/joint/);
    expect(acrossJoint(p, a.id, 1)).toBeNull();
  });

  it('a road heading up never doubles back down to reach a lower end', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsLeft')!;
    const g = grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'reverse' }, 'track')!;
    const c = findCircuit(p, g.circuitId!)!;
    const port = portAnchor(findJunction(p, r.junctionId!)!, 'reverse')!;
    (c.ends[1] as { y: number }).y = port.y + 1; // dragged below the road's start
    const path = pathOf(p, c);
    // Leaves level, then drops: no up-then-down zigzag.
    expect(path[1].y).toBe(port.y);
  });

  it('refuses to turn round points with two roads joined', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'normal' }, 'bufferStops');
    expect(turnRound(p, r.junctionId!).error).toMatch(/one road/);
  });

  it('adds catch points in a track and mirrors crossings', () => {
    const p = plan();
    const a = addTrack(p);
    const r = addJunctionInTrack(p, a.id, 'catchPoints', false);
    expect(r.error).toBeUndefined();
    expect(openEnds(p)).toHaveLength(2);
    const d = grow(p, { kind: 'end', circuitId: a.id, end: 0 }, 'diamond')!;
    const j = findJunction(p, d.junctionId!)!;
    const before = portAnchor(j, 'b')!.y;
    mirrorJunction(p, j.id);
    expect(portAnchor(j, 'b')!.y).toBe(j.y - (before - j.y));
  });

  it('reads v0.3.6 turned-round points as the same drawing, with the right hand', () => {
    const st = createDefaultState();
    st.layouts[0].trackPlan = {
      circuits: [],
      junctions: [{ id: 'j1', number: '1', kind: 'pointsRight', boxId: '', x: 10, y: 4, flip: true } as never],
    };
    const m = migrate(st);
    const j = m.layouts[0].trackPlan.junctions[0];
    // Old "flipped right-hand" drew the turnout down and to the left: that is left-hand points facing left.
    expect(j.kind).toBe('pointsLeft');
    expect(j.rotate).toBe(true);
    expect(portAnchor(j, 'reverse')).toMatchObject({ x: 9, y: 5, dx: -1, dy: 1 });
    expect(j.flip).toBeUndefined();
  });
});

describe('track plan: boxes', () => {
  it('gives a branch to a box, stopping at lines and other boxes', () => {
    const st = createDefaultState();
    const p = st.layouts[0].trackPlan;
    const line = addTrack(p);
    line.owner = { kind: 'line', boxId: 'becton', connectionId: 'becton-fy' };
    const r = grow(p, { kind: 'end', circuitId: line.id, end: 1 }, 'pointsRight')!;
    const n = grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'normal' }, 'track')!;
    const rv = grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'reverse' }, 'bufferStops')!;
    const other = findCircuit(p, rv.circuitId!)!;
    other.owner = { kind: 'box', boxId: 'elsewhere' };
    const count = giveBranch(p, n.circuitId!, 'becton');
    expect(count).toBe(2); // the circuit and the points
    expect(findCircuit(p, n.circuitId!)!.owner).toEqual({ kind: 'box', boxId: 'becton' });
    expect(line.owner.kind).toBe('line');
    expect(other.owner).toEqual({ kind: 'box', boxId: 'elsewhere' });
    expect(findJunction(p, r.junctionId!)!.boxId).toBe('becton');
  });

  it('forgets boxes, lines and exits that are removed', () => {
    const st = createDefaultState();
    const nb = addBox(st);
    const conn = addConnection(st, nb)!;
    const p = st.layouts[0].trackPlan;
    const a = addTrack(p, { kind: 'line', boxId: nb.id, connectionId: conn.id });
    const b = addTrack(p, { kind: 'box', boxId: nb.id });
    grow(p, { kind: 'end', circuitId: b.id, end: 0 }, 'exit');
    (b.ends[0] as { to: unknown }).to = { kind: 'connection', boxId: nb.id, connectionId: conn.id };
    removeConnection(st, nb.id, conn.id);
    expect(a.owner.kind).toBe('none');
    expect((b.ends[0] as { to: { kind: string } }).to.kind).toBe('offScene');
    deleteBox(st, nb.id);
    expect(b.owner.kind).toBe('none');
  });

  it('lists what still needs doing', () => {
    const st = createDefaultState();
    const a = addTrack(st.layouts[0].trackPlan);
    grow(st.layouts[0].trackPlan, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight');
    const kinds = planIssues(st, st.layouts[0]).map((i) => i.kind);
    expect(kinds.filter((k) => k === 'openEnd')).toHaveLength(3);
    expect(kinds).toContain('unassignedCircuit');
    expect(kinds).toContain('unassignedJunction');
  });
});

describe('track plan: curves, double track and turntables', () => {
  it('a curve turns the line a quarter turn, and points can go on the new upright line', () => {
    const p = plan();
    const a = addTrack(p);
    const e = a.ends[1] as { x: number; y: number };
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'curveLeft')!;
    const c = findCircuit(p, r.circuitId!)!;
    expect(c.via).toEqual([{ x: e.x + 3, y: e.y }]);
    const far = c.ends[1] as { x: number; y: number };
    expect(far).toMatchObject({ x: e.x + 3, y: e.y - 5 });
    // Points on the end of the upright line face up the plan, still right-hand.
    const pts = grow(p, { kind: 'end', circuitId: c.id, end: 1 }, 'pointsRight')!;
    const j = findJunction(p, pts.junctionId!)!;
    expect(j.quarter).toBe(true);
    expect(portAnchor(j, 'normal')!).toMatchObject({ dx: 0, dy: -1 });
    // Travelling up, right is to the right of the plan.
    expect(portAnchor(j, 'reverse')!).toMatchObject({ dx: 1, dy: -1 });
    // A track grown off the straight road carries on upwards.
    const t = grow(p, { kind: 'port', junctionId: j.id, port: 'normal' }, 'track')!;
    const tp = pathOf(p, findCircuit(p, t.circuitId!)!);
    expect(tp[0].x).toBe(tp[tp.length - 1].x);
    expect(tp[tp.length - 1].y).toBeLessThan(tp[0].y);
  });

  it('bends can be added and removed', () => {
    const p = plan();
    const a = addTrack(p);
    expect(addBend(p, a.id).error).toBeUndefined();
    expect(a.via).toHaveLength(1);
    a.via![0].y += 4;
    expect(pathOf(p, a).length).toBeGreaterThan(2);
    removeBend(p, a.id);
    expect(a.via).toBeUndefined();
  });

  it('lays a parallel track the same shape, round corners too', () => {
    const p = plan();
    const a = addTrack(p);
    const sides = parallelSideNames(p, a.id).map((x) => x.name).sort();
    expect(sides).toEqual(['above', 'below']);
    const below = parallelSideNames(p, a.id).find((x) => x.name === 'below')!.side;
    const r = parallelTrack(p, a.id, below);
    const b = findCircuit(p, r.circuitId!)!;
    const pa = pathOf(p, a);
    const pb = pathOf(p, b);
    expect(pb.map((q) => q.y - 3)).toEqual(pa.map((q) => q.y));
    expect(pb.map((q) => q.x)).toEqual(pa.map((q) => q.x));
    expect(b.via).toBeUndefined();
    // Round a corner: level then down. The outside track's corner is moved out both ways.
    const q = plan();
    const c = addTrack(q);
    (c.ends[1] as { x: number; y: number }).y += 8;
    c.via = [{ x: (c.ends[1] as { x: number }).x, y: (c.ends[0] as { y: number }).y }];
    const above = parallelSideNames(q, c.id).find((x) => x.name === 'above')!.side;
    const o = findCircuit(q, parallelTrack(q, c.id, above).circuitId!)!;
    expect(o.via![0]).toEqual({ x: c.via[0].x + 3, y: c.via[0].y - 3 });
  });

  it('curving both lines of a double track gives concentric curves, not one on top of the other', () => {
    const p = plan();
    const { circuitIds } = addDoubleTrack(p);
    const [up, down] = circuitIds;
    const outer = findCircuit(p, grow(p, { kind: 'end', circuitId: up, end: 1 }, 'curveRight')!.circuitId!)!;
    const inner = findCircuit(p, grow(p, { kind: 'end', circuitId: down, end: 1 }, 'curveRight')!.circuitId!)!;
    // The inner line turns one spacing sooner, so its upright part runs alongside the outer one.
    expect(outer.via![0].x - inner.via![0].x).toBe(3);
    expect(inner.via![0].y - outer.via![0].y).toBe(3);
  });

  it('lays double track in one go', () => {
    const p = plan();
    const { circuitIds } = addDoubleTrack(p);
    const [a, b] = circuitIds.map((id) => findCircuit(p, id)!);
    expect((b.ends[0] as { y: number }).y - (a.ends[0] as { y: number }).y).toBe(3);
    expect(openEnds(p)).toHaveLength(4);
  });

  it('turntables have roads you choose; taking a road away leaves its track unfinished', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'turntable')!;
    const j = findJunction(p, r.junctionId!)!;
    expect(a.ends[1]).toMatchObject({ port: 'r4' });
    expect(freePorts(p, j).map((x) => x.id).sort()).toEqual(['r0', 'r1', 'r7']);
    const stall = grow(p, { kind: 'port', junctionId: j.id, port: 'r7' }, 'bufferStops')!;
    setTurntableRoads(p, j.id, ['r4', 'r0', 'r6']);
    expect(findCircuit(p, stall.circuitId!)!.ends[0].kind).toBe('open');
    expect(freePorts(p, j).map((x) => x.id).sort()).toEqual(['r0', 'r6']);
    // An upright road from the deck runs straight up.
    const up = grow(p, { kind: 'port', junctionId: j.id, port: 'r6' }, 'track')!;
    const path = pathOf(p, findCircuit(p, up.circuitId!)!);
    expect(path[0].x).toBe(path[1].x);
    // Turntables are not worked from a signal box, so they are not listed as unassigned.
    const st = createDefaultState();
    st.layouts[0].trackPlan = p;
    expect(planIssues(st, st.layouts[0]).some((i) => i.kind === 'unassignedJunction' && i.junctionId === j.id)).toBe(false);
  });

  it('turns points a quarter turn, keeping a single joined road in place', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    const j = findJunction(p, r.junctionId!)!;
    const toe = portAnchor(j, 'toe')!;
    rotateQuarter(p, j.id);
    expect([portAnchor(j, 'toe')!.x, portAnchor(j, 'toe')!.y]).toEqual([toe.x, toe.y]);
    expect(portAnchor(j, 'normal')!).toMatchObject({ dx: 0, dy: 1 });
    for (let i = 0; i < 3; i++) rotateQuarter(p, j.id);
    expect(portAnchor(j, 'normal')!).toMatchObject({ dx: 1, dy: 0 });
  });

  it('merging keeps the shape of a line that turns at the joint', () => {
    const p = plan();
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'curveRight')!;
    const before = pathOf(p, a).concat(pathOf(p, findCircuit(p, r.circuitId!)!));
    const jt = p.junctions[0].id;
    expect(mergeAtJoint(p, jt, a.id).error).toBeUndefined();
    const after = pathOf(p, a);
    for (const q of after) expect(before.some((b) => b.x === q.x && b.y === q.y)).toBe(true);
    expect(after[after.length - 1].y).toBeGreaterThan(after[0].y);
  });
});

describe('track plan: tidy joints and platforms', () => {
  it('removes a joint once neither side has track, but keeps one with track on one side', () => {
    const p = plan();
    const a = addTrack(p);
    const n = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'track')!;
    const joint = p.junctions[0];
    expect(joint.kind).toBe('joint');
    deleteCircuit(p, n.circuitId!);
    expect(findJunction(p, joint.id)).toBeDefined(); // a's end still joins it: an unfinished end
    deleteCircuit(p, a.id);
    expect(p.junctions).toHaveLength(0);
    // Unjoining the last track from a joint also removes it.
    const b = addTrack(p);
    grow(p, { kind: 'end', circuitId: b.id, end: 1 }, 'track');
    const c2 = p.circuits.find((c) => c.id !== b.id)!;
    deleteCircuit(p, c2.id);
    detachEnd(p, b.id, 1);
    expect(p.junctions).toHaveLength(0);
  });

  it('cleans up orphaned joints in saved plans', () => {
    const st = createDefaultState();
    st.layouts[0].trackPlan = { circuits: [], junctions: [{ id: 'j1', number: '', kind: 'joint', boxId: '', x: 4, y: 4, rotate: false, mirror: false }] };
    expect(migrate(st).layouts[0].trackPlan.junctions).toHaveLength(0);
  });

  it('marks platform roads, numbers them per box and flags duplicates', () => {
    const st = createDefaultState();
    const p = st.layouts[0].trackPlan;
    const a = addTrack(p, { kind: 'box', boxId: 'becton' });
    const b = addTrack(p, { kind: 'box', boxId: 'becton' });
    setPlatform(p, a.id, {});
    setPlatform(p, b.id, {});
    expect(a.platform).toEqual({ number: '1', side: 1 });
    expect(b.platform!.number).toBe('2');
    expect(platformPath(p, a).length).toBeGreaterThan(1);
    setPlatform(p, b.id, { number: '1', side: -1 });
    expect(b.platform).toEqual({ number: '1', side: -1 });
    expect(planIssues(st, st.layouts[0]).filter((i) => i.kind === 'duplicatePlatform')).toHaveLength(1);
    expect(platformsOf(p, 'box|becton').map((x) => x.number)).toEqual(['1', '1']);
    setPlatform(p, b.id, null);
    expect(b.platform).toBeUndefined();
    expect(checkPlatformNumber('')).not.toBeNull();
    expect(checkPlatformNumber('3 bay')).toBeNull();
  });

  it('keeps the platform when merging track circuits at a joint', () => {
    const p = plan();
    const a = addTrack(p);
    const n = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'track')!;
    setPlatform(p, n.circuitId!, { number: '2' });
    const r = mergeAtJoint(p, p.junctions[0].id, a.id);
    expect(findCircuit(p, r.circuitId!)!.platform!.number).toBe('2');
  });
});

describe('track plan: up and down lines', () => {
  /** An oval-ish double track: two parallel lines, each in two circuits joined at a joint, curving up at both ends. */
  function doubleLine() {
    const p = plan();
    const r = addDoubleTrack(p);
    const [a, b] = r.circuitIds.map((id) => findCircuit(p, id)!);
    const a2 = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'track')!;
    const b2 = grow(p, { kind: 'end', circuitId: b.id, end: 1 }, 'track')!;
    return { p, a, b, a2: findCircuit(p, a2.circuitId!)!, b2: findCircuit(p, b2.circuitId!)! };
  }

  it('single lines run both ways until told otherwise, and a direction carries along the whole line', () => {
    const { p, a, a2 } = doubleLine();
    expect(a.traffic).toBeUndefined();
    expect(lineRun(p, a.id).map((c) => c.id).sort()).toEqual([a.id, a2.id].sort());
    expect(setTraffic(p, a.id, { line: 'up', toward: 1 }, true)).toBe(2);
    // a2 joins a's end 1 by its end 0, so its trains run on towards its end 1.
    expect(a2.traffic).toEqual({ line: 'up', toward: 1 });
    setTraffic(p, a2.id, null, true);
    expect(a.traffic).toBeUndefined();
  });

  it('makes a double line from two tracks alongside, following left- or right-hand running', () => {
    const { p, a, b, a2, b2 } = doubleLine();
    const along = tracksAlongside(p, a.id);
    expect(along[0].circuit.id).toBe(b.id);
    const st = createDefaultState();
    st.layouts[0].trackPlan = p;
    // a is drawn above b and runs left to right (end 0 → end 1). Left-hand running: an eastbound
    // train keeps to the north (upper) line, with the other line on its right.
    setDoubleLine(p, a.id, b.id, 'up', 'left');
    expect(a.traffic).toEqual({ line: 'up', toward: 1 });
    expect(b.traffic).toEqual({ line: 'down', toward: 0 });
    expect(a2.traffic).toEqual({ line: 'up', toward: 1 });
    expect(b2.traffic).toEqual({ line: 'down', toward: 0 });
    expect(planIssues(st, st.layouts[0]).some((i) => i.kind === 'flowClash')).toBe(false);
    // Turning one circuit round is caught.
    a2.traffic = { line: 'up', toward: a2.traffic!.toward === 1 ? 0 : 1 };
    expect(planIssues(st, st.layouts[0]).some((i) => i.kind === 'flowClash')).toBe(true);
    // Right-hand running swaps the directions.
    const before = a.traffic!.toward;
    setDoubleLine(p, a.id, b.id, 'up', 'right');
    expect(a.traffic!.toward).toBe(1 - before);
  });
});
