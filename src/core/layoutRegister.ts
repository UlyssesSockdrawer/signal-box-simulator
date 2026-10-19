import { farPlace, placesWorkedBy } from './places';
import type { AppState, BoxDef, ConnectionDef, Loco, Place, PlaceRoad } from './types';

/*
 * "Trains on layout": every place a train can stand on the layout and what is
 * there, for the register on the signal box desk. Everything comes from the data
 * (the layout's places, boxes that work no place, trains on a line); no names are
 * built in. Only the box's own layout is listed (boxes not on a layout see the
 * other boxes not on a layout).
 */

export type RegisterLocation =
  | {
      kind: 'place';
      key: string;
      name: string;
      place: Place;
      /** Worked by this box. */
      mine: boolean;
      roads: Array<{ road: PlaceRoad; locos: Loco[] }>;
      /** Trains in the place but not on a named road. */
      loose: Loco[];
    }
  | { kind: 'atBox'; key: string; name: string; box: BoxDef; locos: Loco[] }
  | { kind: 'section'; key: string; name: string; locos: Array<{ loco: Loco; conn: ConnectionDef | undefined; box: BoxDef | undefined }> };

/**
 * Locations in the order the signaller at `boxId` thinks of them: the places this box works,
 * then the places at the far end of its lines (in shelf order), then the rest of the layout,
 * then boxes with trains standing at them, then any trains out on a line.
 */
export function trainsOnLayout(state: AppState, boxId: string): RegisterLocation[] {
  const out: RegisterLocation[] = [];
  const seen = new Set<string>();
  const push = (loc: RegisterLocation) => {
    if (seen.has(loc.key)) return;
    seen.add(loc.key);
    out.push(loc);
  };
  const home = state.boxes.find((b) => b.id === boxId);
  const layout = home ? state.layouts.find((l) => l.id === home.layoutId) : undefined;
  const mineIds = new Set(placesWorkedBy(state, boxId).map((p) => p.id));
  const at = (placeId: string, roadId?: string) =>
    state.roster.filter((l) => l.location.kind === 'place' && l.location.placeId === placeId && (roadId === undefined || l.location.roadId === roadId));
  const placeLoc = (place: Place): RegisterLocation => {
    const roadIds = new Set(place.roads.map((r) => r.id));
    return {
      kind: 'place',
      key: `place:${place.id}`,
      name: place.name,
      place,
      mine: mineIds.has(place.id),
      roads: place.roads.map((road) => ({ road, locos: at(place.id, road.id) })),
      loose: at(place.id).filter((l) => l.location.kind === 'place' && !roadIds.has(l.location.roadId)),
    };
  };
  const atBoxLoc = (box: BoxDef): RegisterLocation => ({
    kind: 'atBox',
    key: `box:${box.id}`,
    name: `At ${box.name}`,
    box,
    locos: state.roster.filter((l) => l.location.kind === 'atBox' && l.location.boxId === box.id),
  });
  const sameLayout = state.boxes.filter((b) => b.layoutId === (home?.layoutId ?? ''));

  if (home) {
    for (const p of placesWorkedBy(state, boxId)) push(placeLoc(p));
    // A box that works no place: trains arriving there stand at the box.
    if (!mineIds.size) push(atBoxLoc(home));
    for (const c of home.connections.slice().sort((x, y) => x.shelfPosition - y.shelfPosition)) {
      const p = farPlace(state, home, c);
      if (p) push(placeLoc(p));
    }
  }
  for (const p of layout?.places ?? []) push(placeLoc(p));
  for (const b of sameLayout) if (state.roster.some((l) => l.location.kind === 'atBox' && l.location.boxId === b.id)) push(atBoxLoc(b));

  // Trains out on a line between two boxes.
  const sameConns = new Set(sameLayout.flatMap((b) => b.connections.map((c) => c.id)));
  const inSection = state.roster.filter((l) => l.location.kind === 'section' && sameConns.has(l.location.connectionId));
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
