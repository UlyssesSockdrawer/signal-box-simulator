import { farBoxLocations } from '../../core/boxes';
import { newId } from '../../core/store';
import { activeLayout, findLayout, findYard, removeRoad } from '../../core/layouts';
import type { BoxDef, Location, Loco } from '../../core/types';
import { locationText, locoFullName, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { confirmButton, h, option, toast } from '../dom';
import { confirmTrainsOff } from './layouts';
import { locOptions, parseLoc } from './roster';

/**
 * Fiddle yard roads and station contents for one layout (the active one unless given),
 * used on the Fiddle yard & station page and in the signal box side panel. Boxes not on
 * any layout are shown too, so they can still be worked before a layout is set up.
 */
export function layoutEditor(ctx: Ctx, stacked = false, layoutId?: string): HTMLElement {
  const st = ctx.store.state;
  const layout = layoutId === undefined ? activeLayout(st) : findLayout(st, layoutId);
  const shownBox = (b: BoxDef) => (layout ? b.layoutId === layout.id : false) || !findLayout(st, b.layoutId);
  const noLayout = (b: BoxDef) => !findLayout(st, b.layoutId);
  const moveLoco = (id: string, loc: Location) =>
    ctx.store.update((s) => {
      const l = s.roster.find((x) => x.id === id);
      if (l) l.location = loc;
    });

  const occupantRow = (l: Loco) =>
    h(
      'li',
      { class: 'occupant' },
      h('div', null, h('strong', null, locoFullName(l)), h('span', { class: 'muted small' }, ` · DCC ${l.dccAddress || '—'} · ${trainTypeName(st, l.working.trainTypeId)}${l.working.consist ? ` · ${l.working.consist}` : ''}`)),
      h(
        'select',
        {
          id: `mv_${l.id}`,
          'aria-label': `Move ${locoFullName(l)}`,
          on: { change: (e: Event) => moveLoco(l.id, parseLoc((e.target as HTMLSelectElement).value, l.location)) },
        },
        ...locOptions(st, l.location),
      ),
    );

  const placeSelect = (id: string, label: string, exclude: (l: Loco) => boolean, toLoc: Location) =>
    h(
      'select',
      {
        id,
        'aria-label': label,
        on: {
          change: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) moveLoco(v, toLoc);
          },
        },
      },
      option('', label, true),
      ...st.roster.filter((l) => !exclude(l)).map((l) => option(l.id, `${locoFullName(l)} (${locationText(st, l)})`)),
    );

  const yards = (layout?.fiddleYards ?? []).map((y) =>
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'row' },
        h('h2', { class: 'nameboard section-board' }, y.name),
        h('input', {
          id: `yn_${y.id}`,
          type: 'text',
          value: y.name,
          'aria-label': 'Fiddle yard name',
          on: { change: (e: Event) => ctx.store.update((s) => { const yy = findYard(s, y.id); if (yy) yy.name = (e.target as HTMLInputElement).value || yy.name; }) },
        }),
      ),
      h(
        'div',
        { class: 'roads' },
        ...y.roads.map((r) => {
          const occ = st.roster.filter((l) => l.location.kind === 'fiddleYard' && l.location.yardId === y.id && l.location.roadId === r.id);
          return h(
            'div',
            { class: `road ${occ.length ? 'occupied' : ''}` },
            h(
              'div',
              { class: 'road-head' },
              h('input', {
                id: `rn_${r.id}`,
                class: 'road-name',
                type: 'text',
                value: r.name,
                'aria-label': 'Road name',
                on: { change: (e: Event) => ctx.store.update((s) => { const rr = findYard(s, y.id)?.roads.find((x) => x.id === r.id); if (rr) rr.name = (e.target as HTMLInputElement).value || rr.name; }) },
              }),
              h('input', {
                id: `rnote_${r.id}`,
                type: 'text',
                value: r.notes,
                placeholder: 'Notes (length, use…)',
                'aria-label': 'Road notes',
                on: { change: (e: Event) => ctx.store.update((s) => { const rr = findYard(s, y.id)?.roads.find((x) => x.id === r.id); if (rr) rr.notes = (e.target as HTMLInputElement).value; }) },
              }),
            ),
            occ.length ? h('ul', { class: 'plain' }, ...occ.map(occupantRow)) : h('p', { class: 'muted small' }, 'Empty'),
            h(
              'div',
              { class: 'row' },
              placeSelect(`place_${r.id}`, 'Place a loco on this road…', (l) => l.location.kind === 'fiddleYard' && l.location.roadId === r.id, { kind: 'fiddleYard', yardId: y.id, roadId: r.id }),
              y.roads.length <= 1
                ? null
                : occ.length
                  ? h(
                      'button',
                      {
                        class: 'btn ghost danger small',
                        type: 'button',
                        on: {
                          click: () =>
                            confirmTrainsOff(occ, `Remove ${r.name}?`, `on ${r.name}`, 'Remove the road', () => {
                              ctx.store.update((s) => removeRoad(s, y.id, r.id));
                              toast(`${r.name} removed. ${occ.length === 1 ? 'Its train is' : 'Its trains are'} off the layout.`);
                            }),
                        },
                      },
                      'Remove road',
                    )
                  : confirmButton('Remove road', 'Press again', () => ctx.store.update((s) => removeRoad(s, y.id, r.id)), 'btn ghost danger small'),
            ),
          );
        }),
      ),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          on: { click: () => ctx.store.update((s) => { const yy = findYard(s, y.id); if (yy) yy.roads.push({ id: newId('road'), name: `Road ${yy.roads.length + 1}`, notes: '' }); }) },
        },
        '+ Add road',
      ),
    ),
  );

  const stations = st.boxes.filter(shownBox).map((b) => {
    const occ = st.roster.filter((l) => l.location.kind === 'station' && l.location.boxId === b.id);
    return h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'nameboard section-board' }, `${b.name} station`),
      noLayout(b) && layout ? h('p', { class: 'muted small' }, `${b.name} box is not on a layout yet.`) : null,
      h('details', null, h('summary', null, 'Station notes'), h('p', { class: 'pre' }, b.stationNotes)),
      occ.length
        ? h(
            'ul',
            { class: 'plain' },
            ...occ.map((l) =>
              h(
                'li',
                { class: 'occupant' },
                h('div', null, h('strong', null, locoFullName(l)), h('span', { class: 'muted small' }, ` · DCC ${l.dccAddress || '—'} · ${trainTypeName(st, l.working.trainTypeId)}`)),
                h('input', {
                  id: `snote_${l.id}`,
                  type: 'text',
                  placeholder: 'Platform, e.g. P1',
                  value: l.location.kind === 'station' ? l.location.note : '',
                  'aria-label': 'Platform or road',
                  on: { change: (e: Event) => moveLoco(l.id, { kind: 'station', boxId: b.id, note: (e.target as HTMLInputElement).value.trim() }) },
                }),
                h('select', { id: `smv_${l.id}`, 'aria-label': 'Move', on: { change: (e: Event) => moveLoco(l.id, parseLoc((e.target as HTMLSelectElement).value, l.location)) } }, ...locOptions(st, l.location)),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'No trains in the station.'),
      placeSelect(`stplace_${b.id}`, `Put a loco in ${b.name} station…`, (l) => l.location.kind === 'station' && l.location.boxId === b.id, { kind: 'station', boxId: b.id, note: '' }),
    );
  });

  // Locations on the layout served by the box at the far end of a line with no fiddle yard.
  const farLocations = farBoxLocations(st).filter(({ box: b }) => shownBox(b)).map(({ box: b, conn: c }) => {
    const here = { kind: 'farBox' as const, boxId: b.id, connectionId: c.id };
    const occ = st.roster.filter((l) => l.location.kind === 'farBox' && l.location.connectionId === c.id);
    return h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'nameboard section-board' }, c.neighbourName),
      h('p', { class: 'muted small' }, `The location served by ${c.neighbourName}, at the far end of the line from ${b.name}. Trains sent there stay on the layout and can be offered back.`),
      occ.length
        ? h(
            'ul',
            { class: 'plain' },
            ...occ.map((l) =>
              h(
                'li',
                { class: 'occupant' },
                h('div', null, h('strong', null, locoFullName(l)), h('span', { class: 'muted small' }, ` · DCC ${l.dccAddress || '—'} · ${trainTypeName(st, l.working.trainTypeId)}`)),
                h('input', {
                  id: `fbnote_${l.id}`,
                  type: 'text',
                  placeholder: 'Platform or road',
                  value: l.location.kind === 'farBox' ? l.location.note : '',
                  'aria-label': 'Platform or road',
                  on: { change: (e: Event) => moveLoco(l.id, { ...here, note: (e.target as HTMLInputElement).value.trim() }) },
                }),
                h('select', { id: `fbmv_${l.id}`, 'aria-label': 'Move', on: { change: (e: Event) => moveLoco(l.id, parseLoc((e.target as HTMLSelectElement).value, l.location)) } }, ...locOptions(st, l.location)),
              ),
            ),
          )
        : h('p', { class: 'muted' }, `No trains at ${c.neighbourName}.`),
      placeSelect(`fbplace_${c.id}`, `Put a loco at ${c.neighbourName}…`, (l) => l.location.kind === 'farBox' && l.location.connectionId === c.id, { ...here, note: '' }),
    );
  });

  const noYards = layout && !yards.length ? h('p', { class: 'muted' }, `${layout.name} has no fiddle yards. Add them in the layout configurator (Details).`) : null;
  const noLayoutNote = !layout
    ? h('p', { class: 'muted' }, st.layouts.length ? 'This box is not on a layout, so no fiddle yards are shown. Put it on a layout in the box configurator.' : 'No layout is set up yet. Create one in the layout configurator to add fiddle yards.')
    : null;
  const yardEls: HTMLElement[] = [...(noLayoutNote ? [noLayoutNote] : []), ...(noYards ? [noYards] : []), ...yards];
  return stacked
    ? h('div', { class: 'stack' }, ...stations, ...farLocations, ...yardEls)
    : h('div', { class: 'two-col' }, h('div', { class: 'stack' }, ...yardEls), h('div', { class: 'stack' }, ...stations, ...farLocations));
}

export function layoutScreen(ctx: Ctx): Screen {
  return {
    title: 'Fiddle yard and station',
    el: h(
      'main',
      { class: 'page' },
      topBar(ctx, 'Fiddle yard & station'),
      activeLayout(ctx.store.state) ? h('p', { class: 'nameboard splash-layout yard-layout' }, activeLayout(ctx.store.state)!.name) : null,
      h('p', { class: 'muted' }, 'Set up what is standing where before a session. Trains move automatically as you signal them; you can correct anything here.'),
      layoutEditor(ctx),
    ),
  };
}
