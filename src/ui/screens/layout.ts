import { activeLayout, findLayout } from '../../core/layouts';
import { kindInfo, placesWorkedBy, workerName } from '../../core/places';
import type { BoxDef, Location, Loco, Place } from '../../core/types';
import { locationText, locoFullName, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { h, option } from '../dom';
import { locOptions, parseLoc } from './roster';

/**
 * Trains in places: what is standing where, in every place on one layout (the active one
 * unless given), and at boxes that work no place. Used on the Trains in places page and in
 * the signal box side panel. Places themselves (their names, roads and who works them) are
 * set up in the layout configurator's Places tab. Boxes not on any layout are shown too, so
 * they can still be worked before a layout is set up.
 */
export function layoutEditor(ctx: Ctx, stacked = false, layoutId?: string): HTMLElement {
  const st = ctx.store.state;
  const layout = layoutId === undefined ? activeLayout(st) : findLayout(st, layoutId);
  const shownBox = (b: BoxDef) => (layout ? b.layoutId === layout.id : false) || !findLayout(st, b.layoutId);
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
      h('select', { id: `mv_${l.id}`, 'aria-label': `Move ${locoFullName(l)}`, on: { change: (e: Event) => moveLoco(l.id, parseLoc((e.target as HTMLSelectElement).value)) } }, ...locOptions(st, l.location)),
    );

  const putSelect = (id: string, label: string, here: (l: Loco) => boolean, toLoc: Location) =>
    h(
      'select',
      {
        id,
        'aria-label': label,
        class: 'put-select',
        on: {
          change: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) moveLoco(v, toLoc);
          },
        },
      },
      option('', label, true),
      ...st.roster.filter((l) => !here(l)).map((l) => option(l.id, `${locoFullName(l)} (${locationText(st, l)})`)),
    );

  const at = (l: Loco, placeId: string, roadId?: string) => l.location.kind === 'place' && l.location.placeId === placeId && (roadId === undefined || l.location.roadId === roadId);

  const placePanel = (p: Place) => {
    const roadIds = new Set(p.roads.map((r) => r.id));
    const loose = st.roster.filter((l) => at(l, p.id) && l.location.kind === 'place' && !roadIds.has(l.location.roadId));
    const workers = p.workedBy.map((w) => workerName(st, w));
    return h(
      'section',
      { class: `${stacked ? 'panel' : 'config-case'} place-panel` },
      h('div', { class: 'place-head' }, h('h2', { class: 'nameboard section-board' }, p.name), h('span', { class: 'chip' }, kindInfo(p.kind).name)),
      h('p', { class: 'muted small' }, workers.length ? `Worked by ${workers.join(', ')}` : 'Not worked by any signal box yet.'),
      p.notes ? h('p', { class: 'pre small' }, p.notes) : null,
      p.roads.length
        ? h(
            'div',
            { class: 'roads' },
            ...p.roads.map((r) => {
              const occ = st.roster.filter((l) => at(l, p.id, r.id));
              return h(
                'div',
                { class: `road ${occ.length ? 'occupied' : ''}` },
                h('div', { class: 'road-head' }, h('strong', { class: 'road-title' }, r.name), r.notes ? h('span', { class: 'muted small' }, r.notes) : null),
                occ.length ? h('ul', { class: 'plain' }, ...occ.map(occupantRow)) : h('p', { class: 'muted small' }, 'Empty'),
                putSelect(`put_${r.id}`, `Put a loco on ${r.name}…`, (l) => at(l, p.id, r.id), { kind: 'place', placeId: p.id, roadId: r.id }),
              );
            }),
          )
        : null,
      loose.length || !p.roads.length
        ? h(
            'div',
            { class: 'road' },
            p.roads.length ? h('div', { class: 'road-head' }, h('strong', { class: 'road-title' }, 'Not on a road')) : null,
            loose.length ? h('ul', { class: 'plain' }, ...loose.map(occupantRow)) : h('p', { class: 'muted small' }, 'Empty'),
            p.roads.length ? null : putSelect(`put_${p.id}`, `Put a loco in ${p.name}…`, (l) => at(l, p.id), { kind: 'place', placeId: p.id, roadId: '' }),
          )
        : null,
    );
  };

  // Boxes that work no place (junction boxes), or are not on a layout: trains arriving there stand at the box.
  const boxPanel = (b: BoxDef) => {
    const occ = st.roster.filter((l) => l.location.kind === 'atBox' && l.location.boxId === b.id);
    return h(
      'section',
      { class: `${stacked ? 'panel' : 'config-case'} place-panel` },
      h('div', { class: 'place-head' }, h('h2', { class: 'nameboard section-board' }, `At ${b.name}`), h('span', { class: 'chip' }, 'Signal box')),
      h('p', { class: 'muted small' }, findLayout(st, b.layoutId) ? `${b.name} works no place, so trains arriving there stand at the box.` : `${b.name} box is not on a layout yet, so trains arriving there stand at the box.`),
      occ.length ? h('ul', { class: 'plain' }, ...occ.map(occupantRow)) : h('p', { class: 'muted small' }, 'Empty'),
      putSelect(`putbx_${b.id}`, `Put a loco at ${b.name}…`, (l) => l.location.kind === 'atBox' && l.location.boxId === b.id, { kind: 'atBox', boxId: b.id }),
    );
  };

  const places = (layout?.places ?? []).map(placePanel);
  const boxes = st.boxes
    .filter(shownBox)
    .filter((b) => !findLayout(st, b.layoutId) || !placesWorkedBy(st, b.id).length || st.roster.some((l) => l.location.kind === 'atBox' && l.location.boxId === b.id))
    .map(boxPanel);
  const note = !layout
    ? h('p', { class: 'muted' }, st.layouts.length ? 'This box is not on a layout, so it has no places.' : 'No layout is set up yet. Create one in the layout configurator to add stations, sidings and fiddle yards.')
    : !places.length
      ? h('p', { class: 'muted' }, `${layout.name} has no places yet. Add stations, sidings, goods yards and fiddle yards in the layout configurator (Places).`)
      : null;
  const edit = layout
    ? h('button', { class: 'btn small', type: 'button', on: { click: () => ctx.goFrom(`plan/${layout.id}/places`, { route: location.hash.replace(/^#/, '') || 'layout', label: 'trains in places' }) } }, 'Edit places')
    : null;
  const all = [...(note ? [note] : []), ...places, ...boxes];
  if (stacked) return h('div', { class: 'stack' }, edit ? h('div', { class: 'row end' }, edit) : null, ...all);
  const half = Math.ceil(all.length / 2);
  return h(
    'div',
    { class: 'stack' },
    edit ? h('div', { class: 'row end' }, edit) : null,
    h('div', { class: 'two-col' }, h('div', { class: 'stack' }, ...all.slice(0, half)), h('div', { class: 'stack' }, ...all.slice(half))),
  );
}

export function layoutScreen(ctx: Ctx): Screen {
  return {
    title: 'Trains in places',
    el: h(
      'main',
      { class: 'page config-page places-page' },
      topBar(ctx, 'Trains in places'),
      h(
        'div',
        { class: 'config-shelf' },
        activeLayout(ctx.store.state) ? h('p', { class: 'nameboard splash-layout yard-layout' }, activeLayout(ctx.store.state)!.name) : null,
        h('p', { class: 'shelf-note' }, 'Set up what is standing where before a session. Trains move automatically as you signal them; you can correct anything here.'),
        layoutEditor(ctx),
      ),
    ),
  };
}
