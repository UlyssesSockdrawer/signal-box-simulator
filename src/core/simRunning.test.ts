import { stockLibrary, vehiclesDescription } from './stock';
import { describe, expect, it } from 'vitest';
import { createDefaultState as shippedState } from './defaults';
import { boxSignals, findPath, playReadiness } from './routing';
import { createBectonState } from './testState';
import { accept, play } from './simHarness';
import { addTimetable, addTrain } from './timetables';

describe('routing and signals on the plan', () => {
  it('Sigsim Central: home signals where the lines meet the station, section signals at the ends of the inner circuits (the station limits)', () => {
    const s = shippedState();
    const sig = boxSignals(s, s.layouts[0], s.boxes[0]).map((x) => `${x.kind}:${x.connectionId}:${s.layouts[0].trackPlan.circuits.find((c) => c.id === x.circuitId)!.code}`);
    expect(sig.sort()).toEqual(['home:sgc-east:T12', 'home:sgc-west:T2', 'section:sgc-east:T11', 'section:sgc-west:T3'].sort());
    expect(playReadiness(s, s.boxes[0])).toEqual([]);
  });

  it('finds the way round: P1 to the west via T4 and the West inner; the goods shed via the neck and throat', () => {
    const s = shippedState();
    const l = s.layouts[0];
    const codes = (p: { circuitId: string }[] | null) => p?.map((x) => l.trackPlan.circuits.find((c) => c.id === x.circuitId)!.code);
    expect(codes(findPath(s, l, { circuitId: 'sgc-t4', toward: 0 }, (d) => d.circuitId === 'sgc-t1'))).toEqual(['T5', 'T4', 'T3', 'T2', 'T1']);
    expect(codes(findPath(s, l, { circuitId: 'sgc-t2', toward: 1 }, (d) => d.circuitId === 'sgc-t9'))).toEqual(['T2', 'T3', 'T4', 'T7', 'T8', 'T10']);
    // With P1 blocked, an eastbound train goes round the loop.
    expect(codes(findPath(s, l, { circuitId: 'sgc-t2', toward: 1 }, (d) => d.circuitId === 'sgc-t10', { blocked: (c) => c === 'sgc-t4' }))).toEqual(['T2', 'T3', 'T6', 'T11', 'T12']);
  });

  it('says why a box cannot be run in play mode', () => {
    const s = createBectonState();
    expect(playReadiness(s, s.boxes[0]).join(' ')).toMatch(/No track has been drawn/);
  });
});

describe('simulated running (signaller play mode)', () => {
  it('lights up standing trains and stock where they stand', () => {
    const t = play();
    // The Jinty in the goods siding (T9); the fiddle yards are off the plan.
    expect(t.occupied()).toEqual(['T9']);
  });

  it('a train off the west line: runs circuit by circuit, is held at the home signal, routed round an occupied road, and may only be reported arrived once detected', () => {
    const t = play({ scale: 1 });
    expect(t.west.requestIncoming('lms8233', 'mineral')).toBeNull();
    accept(t, t.west, '4-1');
    expect(t.west.view.incoming?.departed).toBe(true);
    t.tick(500);
    expect(t.occupied()).toEqual(['T1', 'T9']);
    // The person cannot report it arrived yet: the track circuits do not show it.
    expect(t.trains.source.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms8233', at: null, by: 'person' })).toBe('notDetected');
    const view = () => t.sim.incoming('sigsim-central', 'sgc-west')!;
    expect(view().locked).toBe(false);
    // A goods train goes to the goods yard: the siding is occupied, so the shed road.
    expect(view().dest).toEqual({ placeId: 'sgc-goods', roadId: 'sgc-shed' });
    // The home signal stays at danger until the train is in the last circuit before it.
    const home = () => t.sim.signals('sigsim-central').find((x) => x.kind === 'home' && x.connectionId === 'sgc-west')!;
    expect(home().clear).toBe(false);
    expect(t.until(() => t.occupied().includes('T2'))).toBe(true);
    t.tick(500);
    expect(home().clear).toBe(true);
    expect(view().locked).toBe(true);
    // Changing the road is refused once the route is set.
    expect(t.sim.setDestination('sigsim-central', 'sgc-west', { placeId: 'sgc-station', roadId: 'sgc-p2' })).toMatch(/can no longer be changed/);
    const seen = new Set<string>();
    expect(t.until(() => (t.occupied().forEach((c) => seen.add(c)), !!view()?.arrivedDetected))).toBe(true);
    for (const c of ['T1', 'T2', 'T4', 'T7', 'T8', 'T10']) expect(seen).toContain(c);
    expect(home().clear).toBe(false);
    // Arrived complete in the shed road, clear of the line.
    expect(t.occupied()).toEqual(['T9', 'T10']);
    expect(t.trains.source.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms8233', at: view().at, by: 'person' })).toBe('applied');
    expect(t.loco('lms8233').location).toEqual({ kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-shed' });
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('2-1');
    t.tick();
    t.west.setInstrument('LB');
    t.tick();
    expect(t.west.view.incoming).toBeNull();
    // Standing in the shed road still.
    expect(t.occupied()).toEqual(['T9', 'T10']);
  });

  it('the road chosen by the signaller (or the timetable) is used; a train is held at the home signal while it is occupied', () => {
    const t = play();
    expect(t.sim.setDestination('sigsim-central', 'sgc-west', { placeId: 'sgc-goods', roadId: 'sgc-siding' })).toBeNull();
    t.west.requestIncoming('lms8233', 'mineral');
    accept(t, t.west, '4-1');
    const view = () => t.sim.incoming('sigsim-central', 'sgc-west')!;
    expect(t.until(() => view().status.startsWith('Held at the home signal'), 120_000)).toBe(true);
    expect(view().locked).toBe(false);
    // Back to the app's choice: it takes the free shed road.
    t.sim.setDestination('sigsim-central', 'sgc-west', null);
    expect(t.until(() => view().locked)).toBe(true);
    expect(view().dest).toEqual({ placeId: 'sgc-goods', roadId: 'sgc-shed' });
  });

  it('a departure: the section signal clears only with Line Clear; the train runs out over the exit and the railway reports it arrived at the far end', () => {
    const t = play();
    // The Jinty leaves the goods siding for the east as a pick-up goods (it takes nothing with it: no rake there).
    const seen = new Set<string>(t.occupied());
    t.board.onChange(() => t.occupied().forEach((c) => seen.add(c)));
    t.loco('lms7298').working.trainTypeId = 'pickup_goods';
    t.east.setOutgoing('lms7298', 'pickup_goods');
    t.tick(2000);
    const sec = () => t.sim.signals('sigsim-central').filter((x) => x.kind === 'section' && x.connectionId === 'sgc-east');
    expect(sec().every((x) => !x.clear)).toBe(true);
    expect(t.sim.outgoingText('sigsim-central', 'sgc-east')).toMatch(/until Fiddle Yard East gives Line Clear/);
    expect(t.occupied()).toEqual(['T9']);
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('3');
    t.tick();
    expect(t.east.view.remoteInstrument).toBe('LC');
    t.tick(250);
    expect(sec().some((x) => x.clear)).toBe(true);
    // It sets off (out of the goods yard, setting back in the west end on to the main line); the signaller sends 2 as it goes.
    t.east.sendBell('2');
    t.tick();
    expect(t.until(() => !!t.east.view.outgoing?.arrived)).toBe(true);
    for (const c of ['T9', 'T8', 'T7', 'T4', 'T5', 'T12', 'T13']) expect(seen).toContain(c);
    expect(seen).not.toContain('T2');
    expect(t.occupied()).toEqual([]);
    t.tick(5000);
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('2-1');
    t.tick();
    expect(t.east.view.outgoing).toBeNull();
    expect(t.loco('lms7298').location.kind).toBe('place');
    expect((t.loco('lms7298').location as { placeId: string }).placeId).toBe('fy-east');
    // The person cannot report a far-end arrival in play mode: the railway does.
    expect(t.trains.source.report({ type: 'arrivedFar', connectionId: 'sgc-east', locoId: 'lms7298', roadId: '', by: 'person' })).toBe('notDetected');
  });

  it('a through express: with Line Clear from the east it runs straight through P1, passed complete once clear of the west line', () => {
    const t = play();
    expect(t.workings.setRoute('sgc-west', 'sgc-east')).toBeNull();
    t.west.requestIncoming('lms6233', 'express_passenger');
    t.tick();
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('4');
    t.west.setInstrument('LC');
    t.tick(500);
    // Offer it on to the east, which accepts.
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('4');
    t.tick(8000);
    t.west.sendBell('2');
    t.west.setInstrument('TOL');
    t.tick(500);
    const view = () => t.sim.incoming('sigsim-central', 'sgc-west');
    const seen = new Set<string>();
    t.board.onChange(() => t.occupied().forEach((c) => seen.add(c)));
    // A clear run: the home signal comes off while it is still in the first circuit.
    expect(t.until(() => !!view()?.locked, 20_000)).toBe(true);
    expect(t.occupied()).toContain('T1');
    expect(t.until(() => seen.has('T5'))).toBe(true);
    expect(seen).not.toContain('T6');
    t.east.sendBell('2');
    t.tick();
    expect(t.until(() => !!view()?.passedDetected)).toBe(true);
    expect(t.trains.source.report({ type: 'passed', connectionId: 'sgc-west', locoId: 'lms6233', by: 'person' })).toBe('applied');
    expect(t.until(() => !!t.east.view.outgoing?.arrived)).toBe(true);
  });

  it('a through train with no Line Clear ahead is checked: home off only when close, it stops at the section signal, then goes on when the box in advance accepts it', () => {
    const t = play();
    t.workings.setRoute('sgc-west', 'sgc-east');
    t.west.requestIncoming('lms6233', 'express_passenger');
    accept(t, t.west, '4');
    const view = () => t.sim.incoming('sigsim-central', 'sgc-west')!;
    // Not offered on yet: the home signal waits until the train is in the last circuit of the section.
    t.tick(2000);
    expect(t.occupied()).toContain('T1');
    expect(view().locked).toBe(false);
    expect(t.until(() => view().locked)).toBe(true);
    expect(t.occupied()).toContain('T2');
    // It runs through P1 to the section signal (the advanced starter) and stands there on the East
    // inner, clear of the platform and the west line.
    expect(t.until(() => view().arrivedDetected)).toBe(true);
    expect(t.occupied()).toEqual(['T9', 'T11']);
    expect(view().passedDetected).toBe(false);
    // Offer it on; the east accepts; the section signal clears and away it goes.
    t.east.sendBell('1');
    t.tick();
    t.east.sendBell('4');
    t.tick();
    expect(t.until(() => t.occupied().includes('T12'), 60_000)).toBe(true);
    t.east.sendBell('2');
    t.tick();
    expect(t.until(() => view().passedDetected)).toBe(true);
  });

  it('an arriving passenger train goes to a free platform: round the loop when P1 is occupied', () => {
    const t = play();
    t.loco('lms7298').location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' };
    t.west.requestIncoming('lms5025', 'ordinary_passenger');
    accept(t, t.west, '3-1');
    const view = () => t.sim.incoming('sigsim-central', 'sgc-west')!;
    expect(t.until(() => view().locked)).toBe(true);
    expect(view().dest).toEqual({ placeId: 'sgc-station', roadId: 'sgc-p2' });
    expect(t.until(() => view().arrivedDetected)).toBe(true);
    expect(t.occupied()).toEqual(['T5', 'T6']);
  });

  it('a light engine move leaves its coaches in the road as a rake, which keeps the circuit occupied; the next train from there takes them', () => {
    const t = play();
    const s = t.state;
    // The Black Five stands in P1 with its 4 coaches, and is to run as a light engine to the goods shed.
    const bf = t.loco('lms5025');
    bf.location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' };
    bf.working = { trainTypeId: 'light_engine', consist: '4 coaches', headcode: '' };
    t.tick(500);
    expect(t.occupied()).toEqual(['T5', 'T9']);
    let done = false;
    const seen = new Set<string>();
    expect(t.sim.shunt('sigsim-central', 'lms5025', { placeId: 'sgc-goods', roadId: 'sgc-shed' }, () => (done = true))).toBeNull();
    expect(s.layouts[0].stock).toHaveLength(1);
    expect(s.layouts[0].stock![0]).toMatchObject({ placeId: 'sgc-station', roadId: 'sgc-p1', circuitId: 'sgc-t4' });
    expect(vehiclesDescription(s.layouts[0].stock![0].vehicles, stockLibrary())).toBe('4 coaches');
    expect(bf.working.consist).toBe('');
    // It sets back in the west end (T4) to get from P1 into the goods yard; the coaches keep P1 occupied.
    expect(t.until(() => (t.occupied().forEach((c) => seen.add(c)), done))).toBe(true);
    for (const c of ['T4', 'T7', 'T8', 'T10']) expect(seen).toContain(c);
    expect(seen).not.toContain('T2');
    bf.location = { kind: 'place', placeId: 'sgc-goods', roadId: 'sgc-shed' };
    t.tick(500);
    expect(t.occupied()).toEqual(['T5', 'T9', 'T10']);
    expect(t.board.occupants('sgc-t4')[0]).toMatch(/^rake:/);
    // Back on to the coaches (into a road with only stock in it): out of the goods yard, setting back in
    // the west end, it runs on to them from the west, so it couples up at their west end.
    done = false;
    expect(t.sim.shunt('sigsim-central', 'lms5025', { placeId: 'sgc-station', roadId: 'sgc-p1' }, () => (done = true))).toBeNull();
    expect(t.until(() => done)).toBe(true);
    expect(bf.working.locoEnd).toEqual({ circuitId: 'sgc-t4', end: 0 });
    bf.location = { kind: 'place', placeId: 'sgc-station', roadId: 'sgc-p1' };
    bf.working.trainTypeId = 'ordinary_passenger';
    // Away west with them as a train, engine leading.
    t.west.setOutgoing('lms5025', 'ordinary_passenger');
    t.west.sendBell('1');
    t.tick();
    t.west.sendBell('3-1');
    expect(t.until(() => !(s.layouts[0].stock ?? []).length, 20_000)).toBe(true);
    expect(bf.working.consist).toBe('4 coaches');
    expect(t.until(() => t.occupied().includes('T2'))).toBe(true);
  });

  it('a timetabled shunt runs through the plan by itself in play mode (no card to press)', () => {
    const t = play();
    const l = t.state.layouts[0];
    const tt = addTimetable(t.state, l.id, 'sequence')!;
    const { entry } = addTrain(t.state, l, tt, { locoId: 'lms7298' })!;
    entry.kind = 'shunt';
    entry.trainTypeId = 'light_engine';
    entry.to = { placeId: 'sgc-station', roadId: '' };
    t.runner.load(tt);
    t.runner.start();
    t.tick(500);
    const it0 = t.runner.items[0];
    expect(it0.card).toBeNull();
    expect(it0.status).toMatch(/simulated/);
    const seen = new Set<string>(t.occupied());
    t.board.onChange(() => t.occupied().forEach((c) => seen.add(c)));
    expect(t.until(() => t.runner.items[0].state === 'done')).toBe(true);
    // Out of the goods siding, setting back in the west end, into a platform road.
    for (const c of ['T8', 'T7', 'T4']) expect(seen).toContain(c);
    const loc = t.loco('lms7298').location as { placeId: string; roadId: string };
    expect(loc.placeId).toBe('sgc-station');
    expect(['sgc-p1', 'sgc-p2']).toContain(loc.roadId);
    t.tick(500);
    expect(t.occupied()).toEqual([loc.roadId === 'sgc-p1' ? 'T5' : 'T6']);
  });

  it('model railway mode: no simulated trains; circuits marked by hand go on the board', () => {
    const t = play({ mode: 'model' });
    t.trains.source.report({ type: 'enteredCircuit', circuitId: 'sgc-t3', locoId: null, by: 'person' });
    expect(t.board.marked('sgc-t3')).toBe(true);
    t.trains.source.report({ type: 'clearedCircuit', circuitId: 'sgc-t3', locoId: null, by: 'person' });
    expect(t.board.marked('sgc-t3')).toBe(false);
    // Arrivals are reported as before, with no detection needed.
    t.west.requestIncoming('lms8233', 'mineral');
    accept(t, t.west, '4-1');
    expect(t.trains.source.report({ type: 'arrived', connectionId: 'sgc-west', locoId: 'lms8233', at: { placeId: 'sgc-station', roadId: 'sgc-p2' }, by: 'person' })).toBe('applied');
  });
});
