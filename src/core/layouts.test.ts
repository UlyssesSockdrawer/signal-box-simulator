import { describe, expect, it } from 'vitest';
import { addBox, addConnection, deleteBox, removeConnection } from './boxes';
import { createDefaultState } from './defaults';
import { activeLayout, addLayout, deleteLayout, moveBoxImpact, setBoxLayout, unassignedBoxes } from './layouts';
import { addPlace, removePlace, removeRoad, setRoadCount, trainsBeyondRoad } from './places';
import { trainsOnLayout } from './layoutRegister';
import { migrate } from './store';
import {
  addTrack,
  attachMarker,
  deleteCircuit,
  findJunction,
  giveBranch,
  grow,
  markerPos,
  moveMarker,
  ownerOfJunction,
  placeMarker,
  planIssues,
  sanitiseTrackPlan,
  shiftCircuit,
} from './trackPlan';

/** A save as v0.3.11 wrote it: one layout's name in settings, yards and plan at the top level. */
function oldSave() {
  const s = createDefaultState() as unknown as Record<string, unknown>;
  const layouts = s.layouts as ReturnType<typeof createDefaultState>['layouts'];
  s.fiddleYards = layouts[0].places.filter((p) => p.kind === 'fiddleYard').map((y) => ({ id: y.id, name: y.name, roads: y.roads }));
  s.trackPlan = { circuits: [], junctions: [] };
  addTrack(s.trackPlan as never);
  delete s.layouts;
  const settings = s.settings as Record<string, unknown>;
  delete settings.activeLayoutId;
  settings.layoutName = 'Becton and Tansley Spa Steam Railway';
  for (const b of s.boxes as Array<Record<string, unknown>>) {
    delete b.layoutId;
    b.stationNotes = '';
    for (const c of b.connections as Array<Record<string, unknown>>) {
      c.fiddleYardId = c.placeId;
      delete c.placeId;
    }
  }
  for (const l of s.roster as Array<{ location: Record<string, unknown> }>) {
    if (l.location.kind === 'place' && l.location.placeId === 'fy1') l.location = { kind: 'fiddleYard', yardId: 'fy1', roadId: l.location.roadId };
    else l.location = { kind: 'station', boxId: 'becton', note: '' };
  }
  return s;
}

describe('layouts: saved data', () => {
  it('turns a save from before layouts into one active layout holding everything', () => {
    const st = migrate(oldSave());
    expect(st.layouts).toHaveLength(1);
    const l = st.layouts[0];
    expect(l.name).toBe('Becton and Tansley Spa Steam Railway');
    expect(l.places.map((y) => `${y.kind}:${y.id}`)).toEqual(['fiddleYard:fy1', 'station:stn_becton']);
    expect(l.trackPlan.circuits).toHaveLength(1);
    expect(st.boxes.every((b) => b.layoutId === l.id)).toBe(true);
    expect(activeLayout(st)?.id).toBe(l.id);
    expect('layoutName' in st.settings).toBe(false);
    expect(st.roster[0].location).toEqual({ kind: 'place', placeId: 'fy1', roadId: 'road1' });
    expect(st.roster[3].location).toEqual({ kind: 'place', placeId: 'stn_becton', roadId: '' });
  });

  it('repairs references to layouts and places that do not exist', () => {
    const st = createDefaultState();
    st.boxes[0].layoutId = 'gone';
    st.settings.activeLayoutId = 'gone';
    st.roster[0].location = { kind: 'place', placeId: 'nope', roadId: 'r' };
    const m = migrate(st);
    expect(m.boxes[0].layoutId).toBe('');
    expect(m.settings.activeLayoutId).toBe('layout1');
    expect(m.roster[0].location.kind).toBe('offLayout');
  });
});

describe('layouts: changes', () => {
  it('adds layouts (the first becomes active) and deletes them, keeping their boxes', () => {
    const st = createDefaultState();
    deleteLayout(st, 'layout1');
    expect(st.layouts).toHaveLength(0);
    expect(st.settings.activeLayoutId).toBe('');
    expect(st.boxes[0].layoutId).toBe('');
    expect(st.boxes[0].connections[0].placeId).toBe('');
    expect(st.roster[0].location.kind).toBe('offLayout');
    expect(unassignedBoxes(st)).toHaveLength(1);
    const a = addLayout(st);
    expect(a.name).toBe('New layout');
    expect(activeLayout(st)?.id).toBe(a.id);
    const b = addLayout(st);
    expect(b.name).toBe('New layout 2');
    expect(activeLayout(st)?.id).toBe(a.id);
  });

  it('sets the number of roads in a fiddle yard; trains on removed roads stay in the yard, and go off the layout with it', () => {
    const st = createDefaultState();
    const up = addPlace(st, 'layout1', 'fiddleYard')!;
    expect(up.roads).toHaveLength(4);
    expect(setRoadCount(st, up.id, 6)).toBeNull();
    expect(up.roads.map((r) => r.name)).toEqual(['Road 1', 'Road 2', 'Road 3', 'Road 4', 'Road 5', 'Road 6']);
    st.roster[0].location = { kind: 'place', placeId: up.id, roadId: up.roads[4].id };
    st.roster[1].location = { kind: 'place', placeId: up.id, roadId: up.roads[0].id };
    expect(trainsBeyondRoad(st, up.id, 3).map((l) => l.id)).toEqual([st.roster[0].id]);
    expect(setRoadCount(st, up.id, 3)).toBeNull();
    expect(up.roads).toHaveLength(3);
    expect(st.roster[0].location).toEqual({ kind: 'place', placeId: up.id, roadId: '' });
    expect(setRoadCount(st, up.id, 0)).toMatch(/at least one/);
    st.roster[2].location = { kind: 'place', placeId: up.id, roadId: up.roads[2].id };
    expect(removeRoad(st, up.id, up.roads[2].id)).toBe(1);
    expect(up.roads).toHaveLength(2);
    expect(removePlace(st, up.id)).toBe(3);
    expect(st.roster[1].location.kind).toBe('offLayout');
    expect(st.layouts[0].places.filter((p) => p.kind === 'fiddleYard')).toHaveLength(1);
  });

  it('new connections run to a fiddle yard on the box\'s own layout', () => {
    const st = createDefaultState();
    const other = addLayout(st);
    const yard = addPlace(st, other.id, 'fiddleYard')!;
    const box = addBox(st, other.id);
    expect(addConnection(st, box)!.placeId).toBe(yard.id);
    setBoxLayout(st, box.id, '');
    expect(box.layoutId).toBe('');
    expect(box.connections[0].placeId).toBe('');
    expect(yard.workedBy).toEqual([]);
  });

  it('the trains-on-layout register only lists the box\'s own layout', () => {
    const st = createDefaultState();
    const other = addLayout(st);
    addPlace(st, other.id, 'fiddleYard');
    addPlace(st, other.id, 'station', { name: 'Elsewhere' });
    const reg = trainsOnLayout(st, st.boxes[0].id);
    expect(reg.map((r) => r.name)).toEqual(['Becton', 'Becton sidings', 'Fiddle Yard']);
  });
});

describe('track owned by connected (simulated) boxes', () => {
  it('gives a branch and its points to the far box of a connection', () => {
    const st = createDefaultState();
    const p = st.layouts[0].trackPlan;
    const a = addTrack(p);
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    const owner = { kind: 'remote' as const, boxId: 'becton', connectionId: 'becton-fy' };
    expect(giveBranch(p, a.id, owner)).toBe(2);
    expect(a.owner).toEqual(owner);
    const j = findJunction(p, r.junctionId!)!;
    expect(j.boxId).toBe('becton');
    expect(j.connectionId).toBe('becton-fy');
    // Track grown from those points belongs to the same far box.
    expect(ownerOfJunction(j)).toEqual(owner);
    const n = grow(p, { kind: 'port', junctionId: j.id, port: 'normal' }, 'track')!;
    expect(p.circuits.find((c) => c.id === n.circuitId)!.owner).toEqual(owner);
    expect(planIssues(st, st.layouts[0]).filter((i) => i.kind === 'unassignedCircuit' || i.kind === 'unassignedJunction')).toHaveLength(0);
    // Removing the connection forgets the ownership.
    removeConnection(st, 'becton', 'becton-fy');
    expect(a.owner.kind).toBe('none');
    expect(findJunction(p, r.junctionId!)!.connectionId).toBeUndefined();
  });

  it('moving a box to another layout wipes its track assignments on the old one', () => {
    const st = createDefaultState();
    const p = st.layouts[0].trackPlan;
    const a = addTrack(p, { kind: 'box', boxId: 'becton' });
    const line = addTrack(p, { kind: 'line', boxId: 'becton', connectionId: 'becton-fy' });
    const r = grow(p, { kind: 'end', circuitId: a.id, end: 1 }, 'pointsRight')!;
    const sid = grow(p, { kind: 'port', junctionId: r.junctionId!, port: 'reverse' }, 'bufferStops')!;
    p.circuits.find((c) => c.id === sid.circuitId)!.owner = { kind: 'remote', boxId: 'becton', connectionId: 'becton-fy' };
    grow(p, { kind: 'end', circuitId: line.id, end: 0 }, 'exit');
    (line.ends[0] as { to: unknown }).to = { kind: 'connection', boxId: 'becton', connectionId: 'becton-fy' };
    const other = addTrack(p, { kind: 'box', boxId: 'elsewhere' });
    placeMarker(p, { kind: 'box', boxId: 'becton' }, a.id);
    const dest = addLayout(st);
    const yard = addPlace(st, dest.id, 'fiddleYard')!;
    const impact = moveBoxImpact(st, 'becton', dest.id);
    expect(impact).toHaveLength(1);
    expect(impact[0].usage).toEqual({ circuits: 3, junctions: 1, exits: 1, markers: 1 });
    setBoxLayout(st, 'becton', dest.id);
    expect(p.circuits.filter((c) => c.id !== other.id).every((c) => c.owner.kind === 'none')).toBe(true);
    expect(other.owner).toEqual({ kind: 'box', boxId: 'elsewhere' });
    expect(findJunction(p, r.junctionId!)!.boxId).toBe('');
    expect((line.ends[0] as { to: { kind: string } }).to.kind).toBe('offScene');
    expect(p.markers).toHaveLength(0);
    // Its connection now runs to the new layout's yard.
    expect(st.boxes[0].connections[0].placeId).toBe(yard.id);
    expect(moveBoxImpact(st, 'becton', 'layout1')).toHaveLength(0);
  });

  it('flags track whose box is not on the layout (e.g. from older data)', () => {
    const st = createDefaultState();
    const p = st.layouts[0].trackPlan;
    addTrack(p, { kind: 'box', boxId: 'becton' });
    st.boxes[0].layoutId = '';
    sanitiseTrackPlan(st);
    expect(planIssues(st, st.layouts[0]).some((i) => i.kind === 'offLayoutCircuit')).toBe(true);
  });
});

describe('signal boxes on the plan', () => {
  it('places a box beside a track, follows the track, and lets go when the track goes', () => {
    const st = createDefaultState();
    const p = st.layouts[0].trackPlan;
    const a = addTrack(p);
    const m = placeMarker(p, { kind: 'box', boxId: 'becton' }, a.id);
    const at = markerPos(p, m);
    expect(at.y).toBe((a.ends[0] as { y: number }).y - 3);
    shiftCircuit(p, a.id, 0, 3);
    expect(markerPos(p, m).y).toBe(at.y + 3);
    moveMarker(p, m.id, at.x + 1, at.y + 3 - 1);
    expect(m.circuitId).toBe(a.id);
    expect(markerPos(p, m)).toEqual({ x: at.x + 1, y: at.y + 2 });
    // Placing the same box again moves it rather than adding a second one.
    placeMarker(p, { kind: 'box', boxId: 'becton' });
    expect(p.markers).toHaveLength(1);
    expect(p.markers![0].circuitId).toBe('');
    attachMarker(p, m.id, a.id);
    const before = markerPos(p, m);
    deleteCircuit(p, a.id);
    expect(m.circuitId).toBe('');
    expect(markerPos(p, m)).toEqual({ x: Math.round(before.x), y: Math.round(before.y) });
  });

  it('removes markers for boxes and connections that are deleted', () => {
    const st = createDefaultState();
    const nb = addBox(st, 'layout1');
    const conn = addConnection(st, nb)!;
    const p = st.layouts[0].trackPlan;
    placeMarker(p, { kind: 'remote', boxId: nb.id, connectionId: conn.id });
    placeMarker(p, { kind: 'box', boxId: nb.id });
    expect(p.markers).toHaveLength(2);
    removeConnection(st, nb.id, conn.id);
    expect(st.layouts[0].trackPlan.markers).toHaveLength(1);
    deleteBox(st, nb.id);
    expect(st.layouts[0].trackPlan.markers).toHaveLength(0);
  });
});
