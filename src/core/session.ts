import { createLinkPair } from './link';
import { arrivedLabel, farPlace } from './places';
import type { Scheduler } from './scheduler';
import { SectionController } from './sectionController';
import { SimulatedNeighbour } from './simulatedNeighbour';
import type { AppState, BoxDef, ConnectionDef, Loco } from './types';

export interface SectionSession {
  connection: ConnectionDef;
  controller: SectionController;
  /** Present when the far end is simulated (always, for now). */
  neighbour: SimulatedNeighbour | null;
}

export function locoLabel(l: Loco | undefined): string {
  if (!l) return 'the train';
  return [l.number, l.name ? `"${l.name}"` : ''].filter(Boolean).join(' ') || 'the train';
}

/**
 * Builds the running objects for one signal box: a SectionController for each
 * connection, wired to a SimulatedNeighbour. A networked neighbour would
 * replace createLinkPair()+SimulatedNeighbour with a WebSocket-backed LinkEnd.
 */
export function createBoxSession(box: BoxDef, getState: () => AppState, scheduler: Scheduler): SectionSession[] {
  return box.connections.map((connection) => {
    const [localEnd, remoteEnd] = createLinkPair();
    const st = getState();
    const place = farPlace(st, box, connection);
    const mode = st.settings.workingModes[connection.id] ?? connection.defaultWorking;
    const codeSet = () => {
      const s = getState();
      return s.codeSets.find((c) => c.id === s.settings.codeSetId) ?? s.codeSets[0];
    };
    const trainTypes = () => getState().trainTypes;
    const controller = new SectionController({
      link: localEnd,
      scheduler,
      boxId: box.id,
      connectionId: connection.id,
      farPlaceId: place?.id ?? '',
      farPlaceName: place?.name,
      mode,
      lineType: connection.lineType,
      neighbourName: connection.neighbourName,
      neighbourShort: connection.neighbourShort,
      localShort: box.shortName,
      codeSet,
      trainTypes,
      locoLabel: (id) => locoLabel(getState().roster.find((l) => l.id === id)),
    });
    const neighbour = new SimulatedNeighbour({
      link: remoteEnd,
      scheduler,
      settings: () => getState().settings,
      codeSet,
      trainTypes,
      mode: () => mode,
      lineType: connection.lineType,
      name: connection.neighbourName,
      localName: box.name,
      servesFiddleYard: place?.kind === 'fiddleYard',
      placeName: place?.name ?? '',
      arrivedLabel: arrivedLabel(place, connection.neighbourName),
      locoLabel: (id) => locoLabel(getState().roster.find((l) => l.id === id)),
      otherLines: box.connections.length - 1,
      trainTypeOf: (id) => getState().roster.find((l) => l.id === id)?.working.trainTypeId ?? null,
    });
    return { connection, controller, neighbour };
  });
}
