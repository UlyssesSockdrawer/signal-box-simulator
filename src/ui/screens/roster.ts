import { activeLayout, findLayout } from '../../core/layouts';
import { placesWorkedBy } from '../../core/places';
import { newId } from '../../core/store';
import type { AppState, Location, Loco } from '../../core/types';
import { activeCodeSet, locationText, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { confirmButton, field, h, option } from '../dom';

const POWER_TYPES = ['Steam (tender)', 'Steam (tank)', 'Diesel', 'DMU', 'Electric', 'Other'];

let openId: string | null = null;

/** Encode a Location as a select value. */
export function locValue(l: Location): string {
  if (l.kind === 'place') return `pl|${l.placeId}|${l.roadId}`;
  if (l.kind === 'atBox') return `bx|${l.boxId}`;
  return 'off';
}

/**
 * Every place a loco can be put, grouped by layout (the active layout first): each road of each
 * place (or the place itself when it has no roads), and boxes that work no place. The roster is
 * shared by every layout, so a loco can be moved to another layout's places.
 */
export function locOptions(state: AppState, current: Location): Array<HTMLOptionElement | HTMLOptGroupElement> {
  const cur = locValue(current);
  const groupFor = (layoutId: string, label: string) => {
    const opts: HTMLOptionElement[] = [];
    for (const p of findLayout(state, layoutId)?.places ?? []) {
      const loose = `pl|${p.id}|`;
      // A train somewhere in a place with roads (no road chosen) keeps that choice.
      if (!p.roads.length || cur === loose) opts.push(option(loose, p.roads.length ? `${p.name} (no road)` : p.name, cur === loose));
      for (const r of p.roads) opts.push(option(`pl|${p.id}|${r.id}`, `${p.name} · ${r.name}`, cur === `pl|${p.id}|${r.id}`));
    }
    for (const b of state.boxes.filter((x) => (layoutId ? x.layoutId === layoutId : !findLayout(state, x.layoutId)))) {
      const v = `bx|${b.id}`;
      if (!placesWorkedBy(state, b.id).length || cur === v) opts.push(option(v, `At ${b.name} box`, cur === v));
    }
    return { label, opts };
  };
  const active = activeLayout(state);
  const groups = [
    ...(active ? [groupFor(active.id, active.name)] : []),
    ...state.layouts.filter((l) => l.id !== active?.id).map((l) => groupFor(l.id, l.name)),
    groupFor('', 'Not on a layout'),
  ].filter((g) => g.opts.length);
  const off = option('off', 'Off layout / shed', cur === 'off');
  if (groups.length <= 1) return [...(groups[0]?.opts ?? []), off];
  return [...groups.map((g) => h('optgroup', { label: g.label }, ...g.opts)), off];
}

export function parseLoc(v: string): Location {
  const [k, a, b] = v.split('|');
  if (k === 'pl') return { kind: 'place', placeId: a, roadId: b ?? '' };
  if (k === 'bx') return { kind: 'atBox', boxId: a };
  return { kind: 'offLayout' };
}

export function rosterScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const set = activeCodeSet(st);
  const upd = (id: string, fn: (l: Loco) => void) =>
    ctx.store.update((s) => {
      const l = s.roster.find((x) => x.id === id);
      if (l) fn(l);
    });

  const text = (l: Loco, key: 'number' | 'name' | 'locoClass' | 'dccAddress' | 'notes', label: string, help?: string) =>
    field(
      label,
      h('input', { id: `r_${l.id}_${key}`, type: key === 'dccAddress' ? 'text' : 'text', inputmode: key === 'dccAddress' ? 'numeric' : undefined, value: l[key], on: { change: (e: Event) => upd(l.id, (x) => (x[key] = (e.target as HTMLInputElement).value.trim())) } }),
      help,
    );

  const card = (l: Loco) => {
    const editor = h(
      'details',
      {
        class: 'loco',
        open: openId === l.id,
        on: { toggle: (e: Event) => { if ((e.target as HTMLDetailsElement).open) openId = l.id; else if (openId === l.id) openId = null; } },
      },
      h(
        'summary',
        null,
        h('span', { class: 'loco-num' }, l.number || '—'),
        h('span', { class: 'loco-name' }, l.name || l.locoClass || '(unnamed)'),
        h('span', { class: 'loco-meta' }, `DCC ${l.dccAddress || '—'} · ${trainTypeName(st, l.working.trainTypeId)} · ${locationText(st, l)}`),
      ),
      h(
        'div',
        { class: 'form-grid' },
        text(l, 'number', 'Number'),
        text(l, 'name', 'Name'),
        text(l, 'locoClass', 'Class / type'),
        field('Power', h('select', { id: `r_${l.id}_power`, on: { change: (e: Event) => upd(l.id, (x) => (x.powerType = (e.target as HTMLSelectElement).value)) } }, ...POWER_TYPES.map((p) => option(p, p, p === l.powerType)))),
        text(l, 'dccAddress', 'DCC address'),
        field(
          'Working as',
          h('select', { id: `r_${l.id}_tt`, on: { change: (e: Event) => upd(l.id, (x) => (x.working.trainTypeId = (e.target as HTMLSelectElement).value)) } },
            ...st.trainTypes.map((t) => option(t.id, `${t.name}${set.trainCodes[t.id] ? ` (${set.trainCodes[t.id].code})` : ''}`, t.id === l.working.trainTypeId)),
          ),
          'Sets the bell code used when this train is offered.',
        ),
        field('Consist', h('input', { id: `r_${l.id}_consist`, type: 'text', value: l.working.consist, placeholder: 'e.g. 4 coaches', on: { change: (e: Event) => upd(l.id, (x) => (x.working.consist = (e.target as HTMLInputElement).value)) } })),
        field('Headcode', h('input', { id: `r_${l.id}_hc`, type: 'text', value: l.working.headcode, on: { change: (e: Event) => upd(l.id, (x) => (x.working.headcode = (e.target as HTMLInputElement).value)) } })),
        field('Where it is', h('select', { id: `r_${l.id}_loc`, on: { change: (e: Event) => upd(l.id, (x) => (x.location = parseLoc((e.target as HTMLSelectElement).value))) } }, ...locOptions(st, l.location))),
        text(l, 'notes', 'Notes'),
      ),
      h('div', { class: 'row end' }, confirmButton('Delete locomotive', 'Press again to delete', () => ctx.store.update((s) => (s.roster = s.roster.filter((x) => x.id !== l.id))))),
    );
    return editor;
  };

  const add = () => {
    const id = newId('loco');
    openId = id;
    ctx.store.update((s) =>
      s.roster.push({
        id,
        number: '',
        name: '',
        locoClass: '',
        powerType: 'Steam (tank)',
        dccAddress: '',
        notes: '',
        working: { trainTypeId: 'ordinary_passenger', consist: '', headcode: '' },
        location: { kind: 'offLayout' },
      }),
    );
    window.setTimeout(() => document.getElementById(`r_${id}_number`)?.focus(), 50);
  };

  const sorted = [...st.roster].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  return {
    title: 'Roster',
    el: h(
      'main',
      { class: 'page' },
      topBar(ctx, 'Locomotive roster', h('button', { class: 'btn primary', type: 'button', on: { click: add } }, '+ Add locomotive')),
      h('p', { class: 'muted' }, 'Each locomotive has a working (the kind of train it is running as), which sets its bell code. Change the working whenever the loco changes job, for example from a passenger train to light engine for the turntable.'),
      sorted.length ? h('div', { class: 'stack' }, ...sorted.map(card)) : h('p', { class: 'empty' }, 'No locomotives yet. Press "Add locomotive" to start your roster.'),
      h('p', { class: 'muted small' }, `${st.roster.length} locomotives. Bell codes shown are from "${set.name}".`),
    ),
  };
}
