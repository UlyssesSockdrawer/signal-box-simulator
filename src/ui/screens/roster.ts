import { farBoxLocations } from '../../core/boxes';
import { newId } from '../../core/store';
import type { AppState, Location, Loco } from '../../core/types';
import { activeCodeSet, locationText, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { confirmButton, field, h, option } from '../dom';

const POWER_TYPES = ['Steam (tender)', 'Steam (tank)', 'Diesel', 'DMU', 'Electric', 'Other'];

let openId: string | null = null;

/** Encode a Location as a select value. */
export function locValue(l: Location): string {
  if (l.kind === 'fiddleYard') return `fy|${l.yardId}|${l.roadId}`;
  if (l.kind === 'station') return `st|${l.boxId}`;
  if (l.kind === 'farBox') return `fb|${l.boxId}|${l.connectionId}`;
  return 'off';
}

export function locOptions(state: AppState, current: Location): HTMLOptionElement[] {
  const cur = locValue(current);
  const opts: HTMLOptionElement[] = [];
  for (const y of state.fiddleYards) for (const r of y.roads) opts.push(option(`fy|${y.id}|${r.id}`, `${y.name}: ${r.name}`, cur === `fy|${y.id}|${r.id}`));
  for (const b of state.boxes) opts.push(option(`st|${b.id}`, `${b.name} station`, cur === `st|${b.id}`));
  for (const { box, conn } of farBoxLocations(state)) {
    const v = `fb|${box.id}|${conn.id}`;
    opts.push(option(v, `At ${conn.neighbourName} (line from ${box.name})`, cur === v));
  }
  opts.push(option('off', 'Off layout / shed', cur === 'off'));
  return opts;
}

export function parseLoc(v: string, prev: Location): Location {
  const [k, a, b] = v.split('|');
  if (k === 'fy') return { kind: 'fiddleYard', yardId: a, roadId: b };
  if (k === 'st') return { kind: 'station', boxId: a, note: prev.kind === 'station' ? prev.note : '' };
  if (k === 'fb') return { kind: 'farBox', boxId: a, connectionId: b, note: prev.kind === 'farBox' ? prev.note : '' };
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
        field('Where it is', h('select', { id: `r_${l.id}_loc`, on: { change: (e: Event) => upd(l.id, (x) => (x.location = parseLoc((e.target as HTMLSelectElement).value, x.location))) } }, ...locOptions(st, l.location))),
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
