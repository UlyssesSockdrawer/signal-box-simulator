import type { AppState, BoxDef, ConnectionDef, FiddleYard, FiddleYardRoad, Loco } from './types';

/*
 * "Trains on layout": every place a train can stand on the layout and what is
 * there, for the register on the signal box desk. Locations come from the data
 * (fiddle yards, each box's station, the locations served by far boxes); no
 * names are built in. When the layout configurator arrives, it will supply this
 * list instead.
 */

export type RegisterLocation =
  | { kind: 'yard'; key: string; name: string; yard: FiddleYard; roads: Array<{ road: FiddleYardRoad; locos: Loco[] }> }
  | { kind: 'station'; key: string; name: string; box: BoxDef; locos: Loco[] }
  | { kind: 'farBox'; key: string; name: string; box: BoxDef; conn: ConnectionDef; locos: Loco[] }
  | { kind: 'section'; key: string; name: string; locos: Array<{ loco: Loco; conn: ConnectionDef | undefined; box: BoxDef | undefined }> };

/**
 * Locations in the order the signaller at `boxId` thinks of them: the fiddle yards
 * and far-box locations this box works to (in shelf order) around its own station,
 * then the rest of the layout, then any trains out on a line.
 */
export function trainsOnLayout(state: AppState, boxId: string): RegisterLocation[] {
  const out: RegisterLocation[] = [];
  const seen = new Set<string>();
  const push = (loc: RegisterLocation) => {
    if (seen.has(loc.key)) return;
    seen.add(loc.key);
    out.push(loc);
  };
  const yardLoc = (yard: FiddleYard): RegisterLocation => ({
    kind: 'yard',
    key: `yard:${yard.id}`,
    name: yard.name,
    yard,
    roads: yard.roads.map((road) => ({
      road,
      locos: state.roster.filter((l) => l.location.kind === 'fiddleYard' && l.location.yardId === yard.id && l.location.roadId === road.id),
    })),
  });
  const stationLoc = (box: BoxDef): RegisterLocation => ({
    kind: 'station',
    key: `station:${box.id}`,
    name: `${box.name} station`,
    box,
    locos: state.roster.filter((l) => l.location.kind === 'station' && l.location.boxId === box.id),
  });
  const farLoc = (box: BoxDef, conn: ConnectionDef): RegisterLocation => ({
    kind: 'farBox',
    key: `far:${conn.id}`,
    name: conn.neighbourName,
    box,
    conn,
    locos: state.roster.filter((l) => l.location.kind === 'farBox' && l.location.connectionId === conn.id),
  });
  const byShelf = (b: BoxDef) => b.connections.slice().sort((x, y) => x.shelfPosition - y.shelfPosition);

  // This box first: yards it serves, its own station, the far-box locations it works to.
  const home = state.boxes.find((b) => b.id === boxId);
  if (home) {
    for (const c of byShelf(home)) {
      const y = state.fiddleYards.find((yy) => yy.id === c.fiddleYardId);
      if (y) push(yardLoc(y));
    }
    push(stationLoc(home));
    for (const c of byShelf(home)) {
      if (!c.fiddleYardId) push(farLoc(home, c));
    }
  }
  // Then the rest of the layout.
  for (const b of state.boxes) {
    if (b.id === boxId) continue;
    push(stationLoc(b));
    for (const c of byShelf(b)) if (!c.fiddleYardId) push(farLoc(b, c));
  }
  for (const y of state.fiddleYards) push(yardLoc(y));
  // Locations left behind by a line that has since been given a fiddle yard, if trains still stand there.
  for (const b of state.boxes) {
    for (const c of b.connections) {
      if (c.fiddleYardId && state.roster.some((l) => l.location.kind === 'farBox' && l.location.connectionId === c.id)) push(farLoc(b, c));
    }
  }
  // Trains out on a line between two boxes.
  const inSection = state.roster.filter((l) => l.location.kind === 'section');
  if (inSection.length) {
    push({
      kind: 'section',
      key: 'section',
      name: 'On the line',
      locos: inSection.map((loco) => {
        const id = loco.location.kind === 'section' ? loco.location.connectionId : '';
        const box = state.boxes.find((b) => b.connections.some((c) => c.id === id));
        return { loco, box, conn: box?.connections.find((c) => c.id === id) };
      }),
    });
  }
  return out;
}
