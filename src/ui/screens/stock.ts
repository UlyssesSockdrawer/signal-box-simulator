import { findLayout } from '../../core/layouts';
import { circuitLength, formatLength, parseLength } from '../../core/railway';
import {
  BASIS_NAMES,
  canLoad,
  CATEGORY_NAMES,
  COACH_TYPE_NAMES,
  classCode,
  duplicateIdentities,
  emptyRollingStock,
  mintVehicle,
  newVehicleId,
  stockLibrary,
  summariseRake,
  systemIdentity,
  vehicleName,
  type StockLibrary,
  type StockNote,
} from '../../core/stock';
import { overBuffersFromHeadstocks } from '../../core/stockLibrary';
import { CATEGORIES, COACH_TYPES } from '../../core/stockSanitise';
import type { CoachType, LengthBasis, Rake, RollingStock, StockCategory, Vehicle, VehicleClass } from '../../core/stockTypes';
import type { AppState, Layout } from '../../core/types';
import { type Ctx } from '../app';
import { confirmButton, h, option, toast } from '../dom';
import { drawRake } from '../rakeDrawing';
import { plusIcon } from './boxConfig';

/*
 * The layout configurator's Stock tab (v0.3.38): the layout's stock library (built-in prototype types
 * plus the user's own), its fleet of individual vehicles, and saved rakes with the rake builder and
 * visualiser. A planning tool in model railway mode; later stages use the same rakes in timetables
 * and the generator. Wood and brass: mahogany cases on the teak shelf, brass for the key action.
 */

/** UI state kept for the app session. */
const open = new Map<string, boolean>([
  ['rakes', true],
  ['fleet', false],
  ['library', false],
]);
let selRake = '';
let editClass = '';
let checkRoad = '';
let checkType = '';
let fleetFilter = '';
let fleetSort: 'identity' | 'type' | 'loaded' = 'identity';
let libFilter = { origin: '', era: '', category: '', hidden: false, text: '' };
let focusNext = '';

export function resetStockUi(): void {
  selRake = '';
  editClass = '';
  checkRoad = '';
  checkType = '';
  fleetFilter = '';
  fleetSort = 'identity';
  libFilter = { origin: '', era: '', category: '', hidden: false, text: '' };
  open.set('rakes', true);
  open.set('fleet', false);
  open.set('library', false);
}

const ERA_NAMES: Record<string, string> = { grouping: 'Grouping (1923–47)', postwar: 'Post-war (1948–60)', br1960: 'BR 1960 on' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Words for a validity note. */
function noteText(n: StockNote, names: (ids: string[]) => string, units: AppState['settings']['units']): string {
  const who = n.vehicleIds.length ? ` (${names(n.vehicleIds)})` : '';
  switch (n.code) {
    case 'freightNoBrakeVan':
      return 'A goods train needs a brake van.';
    case 'passengerNoGuard':
      return 'No vehicle with a guard’s compartment (a passenger brake, full brake or driving brake).';
    case 'brakeVanNotAtTail':
      return `The brake van normally runs at the tail, away from the engine${who}.`;
    case 'guardNotAtEnd':
      return `No guard’s vehicle at either end of the rake${who}.`;
    case 'drivingTrailerNotAtEnd':
      return `A driving trailer belongs at an end of the rake${who}.`;
    case 'nonCorridorBreak':
      return `A non-corridor vehicle breaks the corridor through the rake${who}.`;
    case 'unfittedAheadOfFitted':
      return `Unfitted vehicles are ahead of fitted ones: fitted vehicles usually run next to the engine${who}.`;
    case 'unfittedVanOnFittedTrain':
      return `Safety: an unfitted brake van on a train with a fitted head. Use a fitted (or piped) van${who}.`;
    case 'tooLong':
      return `Longer than the road: ${n.data?.approx ? 'about ' : ''}${formatLength(Number(n.data?.metres), units, 'vehicle')} in ${formatLength(Number(n.data?.road), units, 'vehicle')}.`;
    case 'overVehicleLimit':
      return `More vehicles than the train type allows (${n.data?.count} of ${n.data?.max}).`;
    case 'overTonsLimit':
      return `Heavier than the train type allows (${n.data?.tons} of ${n.data?.max} tons).`;
    case 'unknownLength':
      return `Length not known: a generic length is used${who}.`;
    case 'sharedVehicles':
      return `Some vehicles are also in ${n.data?.rakes}${who}.`;
  }
}

export function layoutStock(ctx: Ctx, layoutId: string): HTMLElement {
  const st = ctx.store.state;
  const layout = findLayout(st, layoutId)!;
  const rs: RollingStock = layout.rollingStock ?? emptyRollingStock();
  const lib = stockLibrary(rs);
  const units = st.settings.units;
  const vlen = (m: number) => formatLength(m, units, 'vehicle');
  /** Change the layout's rolling stock (made on first use). */
  const upd = (fn: (r: RollingStock, l: Layout, lb: StockLibrary) => void) =>
    ctx.store.update((a) => {
      const l = findLayout(a, layoutId);
      if (!l) return;
      l.rollingStock ??= emptyRollingStock();
      fn(l.rollingStock, l, stockLibrary(l.rollingStock));
    });
  const byId = new Map(rs.fleet.map((v) => [v.id, v]));
  const names = (ids: string[]) => ids.map((id) => (byId.get(id) ? vehicleName(byId.get(id)!, lib) : '?')).join(', ');
  const clsName = (id: string) => lib.cls(id)?.name ?? 'Unknown type';

  /** Library types grouped by category as <optgroup>s. */
  const classOptions = (selected: string, filter: (c: VehicleClass) => boolean = () => true) => {
    const list = lib.list().filter(filter);
    const sel = lib.cls(selected);
    if (sel && !list.includes(sel)) list.unshift(sel);
    return CATEGORIES.map((cat) => {
      const cs = list.filter((c) => c.category === cat);
      if (!cs.length) return null;
      return h('optgroup', { label: CATEGORY_NAMES[cat] }, ...cs.map((c) => option(c.id, `${c.name}${c.origin && c.origin !== 'generic' ? ` · ${c.origin}` : ''}${c.builtIn ? '' : ' (yours)'}`, c.id === selected)));
    }).filter((x): x is HTMLOptGroupElement => !!x);
  };

  const sectionCase = (key: string, title: string, summary: string, body: HTMLElement) => {
    const isOpen = open.get(key) ?? false;
    const bodyId = `sk_body_${key}`;
    body.id = bodyId;
    body.hidden = !isOpen;
    const toggle = h(
      'button',
      {
        class: 'pl-toggle',
        type: 'button',
        'aria-expanded': String(isOpen),
        'aria-controls': bodyId,
        on: {
          click: () => {
            const now = body.hasAttribute('hidden');
            body.hidden = !now;
            open.set(key, now);
            toggle.setAttribute('aria-expanded', String(now));
          },
        },
      },
      h('span', { class: 'pl-chev', 'aria-hidden': 'true' }),
      h('h2', { class: 'nameboard section-board', id: `sk_board_${key}` }, title),
      h('span', { class: 'pl-summary' }, summary),
    );
    return h('article', { class: 'config-case pl-case sk-case', 'aria-labelledby': `sk_board_${key}` }, toggle, body);
  };

  // ---------------------------------------------------------------- rakes
  const rakesBody = () => {
    const body = h('div', { class: 'pl-body sk-body' });
    const rake = rs.rakes.find((r) => r.id === selRake) ?? rs.rakes[0];
    if (rake) selRake = rake.id;
    const newRake = () => {
      const id = `rake_${newVehicleId().slice(0, 8)}`;
      upd((r) => r.rakes.push({ id, identity: `Rake ${r.rakes.length + 1}`, vehicleIds: [], engineEnd: 'A', notes: '' }));
      selRake = id;
      focusNext = `sk_rname_${id}`;
    };
    body.append(
      h(
        'div',
        { class: 'sk-rake-picks', role: 'group', 'aria-label': 'Saved rakes' },
        ...rs.rakes.map((r) =>
          h('button', { class: 'btn small sk-pick', type: 'button', 'aria-pressed': String(r.id === rake?.id), on: { click: () => ((selRake = r.id), ctx.store.update(() => {})) } }, `${r.identity} · ${r.vehicleIds.length}`),
        ),
        h('button', { class: 'add-tile sk-add-rake', type: 'button', on: { click: newRake } }, plusIcon(), h('span', { class: 'mi-label' }, 'New rake')),
      ),
    );
    if (!rake) {
      body.append(h('p', { class: 'help' }, 'No rakes yet. A rake is an ordered list of vehicles from the fleet, with ends A and B. Start one with New rake.'));
      return body;
    }
    // Things to check it against: a road (its track circuit length) and a train type (its limits).
    const roads = layout.places.flatMap((p) => p.roads.filter((r) => r.circuitId).map((r) => ({ key: `${p.id}|${r.id}`, name: `${p.name} · ${r.name}`, metres: circuitLength(st, layout, r.circuitId!).metres })));
    const road = roads.find((r) => r.key === checkRoad);
    const params = lib.params();
    const limit = checkType ? params.trainLimits[checkType] : undefined;
    const sum = summariseRake(rake, rs, lib, { roadMetres: road?.metres, trainTypeId: checkType || undefined, limit });
    const editRake = (fn: (r: Rake, rr: RollingStock) => void) =>
      upd((rr) => {
        const r = rr.rakes.find((x) => x.id === rake.id);
        if (r) fn(r, rr);
      });
    const nameInput = h('input', { type: 'text', id: `sk_rname_${rake.id}`, value: rake.identity, maxlength: 60, autocomplete: 'off', on: { change: (e: Event) => editRake((r) => (r.identity = (e.target as HTMLInputElement).value.trim() || r.identity)) } });
    const seg = (end: 'A' | 'B', label: string) => h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(rake.engineEnd === end), on: { click: () => editRake((r) => (r.engineEnd = end)) } }, label);
    const typeName = (id: string) => st.trainTypes.find((t) => t.id === id)?.name ?? id;
    const fe = sum.vehicles;
    const vis = drawRake(fe, {
      engineEnd: rake.engineEnd,
      units,
      engine: true,
      labels: fe.map((v) => v.vehicle.identity?.trim() || classCode(v.cls)),
      road: road ? { metres: road.metres, name: road.name } : undefined,
      title: `${rake.identity}: ${plural(sum.count, 'vehicle')}, ${sum.length.approx ? 'about ' : ''}${vlen(sum.length.metres)}`,
    });
    const kv = (k: string, v: string) => [h('dt', null, k), h('dd', null, v)];
    const freighty = sum.kind === 'freight' || sum.kind === 'mixed';
    const derived = h(
      'dl',
      { class: 'kv sk-derived' },
      ...kv('Vehicles', String(sum.count)),
      ...kv('Length over buffers', sum.count ? `${sum.length.approx ? 'about ' : ''}${vlen(sum.length.metres)}` : '—'),
      ...kv('Weight', sum.weight.kg === null ? 'not known (no weights in the library yet)' : `${sum.weight.missing ? 'at least ' : ''}${Math.round(sum.weight.kg / 1016.047)} tons`),
      ...kv('Fitted head', sum.count ? `${sum.fittedHead} of ${sum.count} (${Math.round(sum.fittedProportion * 100)}%) from the engine end` : '—'),
      ...(freighty ? kv('Goods train class', typeName(sum.headcodeClass)) : []),
      ...kv('Push-pull', sum.pushPull ? 'yes: a driving trailer at the far end' : 'no'),
      ...kv('Guard’s vehicles', sum.guards.length ? sum.guards.map((i) => `${i + 1}`).join(', ') : 'none'),
    );
    const notes = sum.notes.length
      ? h('ul', { class: 'plain sk-notes' }, ...sum.notes.map((n) => h('li', { class: n.severity === 'safety' ? 'sk-safety' : '' }, noteText(n, names, units))))
      : h('p', { class: 'help' }, sum.count ? 'No notes.' : 'Add vehicles below.');
    // The vehicles, end A first.
    const vehRow = (v: Vehicle, i: number) => {
      const r = sum.vehicles[i];
      const move = (d: number) =>
        editRake((rk) => {
          const j = i + d;
          if (j < 0 || j >= rk.vehicleIds.length) return;
          [rk.vehicleIds[i], rk.vehicleIds[j]] = [rk.vehicleIds[j], rk.vehicleIds[i]];
        });
      return h(
        'li',
        { class: 'sk-row' },
        h('span', { class: 'sk-pos' }, String(i + 1)),
        h('span', { class: 'sk-name' }, h('strong', null, vehicleName(v, lib)), h('small', { class: 'help' }, ` ${clsName(v.classId)} · ${r.approx ? 'about ' : ''}${vlen(r.metres)}${r.fitted ? ' · fitted' : ''}${r.loaded ? ' · loaded' : ''}`)),
        h('span', { class: 'sk-btns' },
          h('button', { class: 'btn small', type: 'button', disabled: i === 0, 'aria-label': `Move ${vehicleName(v, lib)} towards end A`, on: { click: () => move(-1) } }, '▲'),
          h('button', { class: 'btn small', type: 'button', disabled: i === rake.vehicleIds.length - 1, 'aria-label': `Move ${vehicleName(v, lib)} towards end B`, on: { click: () => move(1) } }, '▼'),
          h('button', { class: 'btn danger small', type: 'button', 'aria-label': `Take ${vehicleName(v, lib)} out of the rake`, on: { click: () => editRake((rk) => rk.vehicleIds.splice(i, 1)) } }, '✕'),
        ),
      );
    };
    const vehicles = sum.vehicles.map((x) => x.vehicle);
    // Adding: one from the fleet, or a new vehicle of a type (added to the fleet too).
    const inOther = (id: string) => rs.rakes.filter((r) => r.id !== rake.id && r.vehicleIds.includes(id)).length;
    const fleetSel = h(
      'select',
      { id: 'sk_add_fleet', 'aria-label': 'A vehicle from the fleet' },
      option('', rs.fleet.length ? 'Choose a vehicle…' : 'The fleet is empty'),
      ...rs.fleet.map((v) => {
        const o = option(v.id, `${vehicleName(v, lib)} · ${clsName(v.classId)}${rake.vehicleIds.includes(v.id) ? ' (in this rake)' : inOther(v.id) ? ` (also in ${plural(inOther(v.id), 'other rake')})` : ''}`);
        o.disabled = rake.vehicleIds.includes(v.id);
        return o;
      }),
    );
    const typeSel = h('select', { id: 'sk_add_type', 'aria-label': 'A type from the library' }, option('', 'Choose a type…'), ...classOptions(''));
    body.append(
      h(
        'div',
        { class: 'form-grid tight sk-rake-head' },
        h('div', { class: 'field' }, h('label', { for: nameInput.id }, 'Rake name'), nameInput),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Engine assumed at'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Engine assumed at' }, seg('A', 'End A'), seg('B', 'End B'))),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'sk_check_road' }, 'Check it fits'),
          h('select', { id: 'sk_check_road', on: { change: (e: Event) => ((checkRoad = (e.target as HTMLSelectElement).value), ctx.store.update(() => {})) } }, option('', roads.length ? 'No road chosen' : 'No roads tied to track circuits'), ...roads.map((r) => option(r.key, `${r.name} (${vlen(r.metres)})`, r.key === checkRoad))),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'sk_check_type' }, 'Check against a train type'),
          h('select', { id: 'sk_check_type', on: { change: (e: Event) => ((checkType = (e.target as HTMLSelectElement).value), ctx.store.update(() => {})) } }, option('', 'None'), ...st.trainTypes.map((t) => option(t.id, t.name, t.id === checkType))),
        ),
      ),
      h('div', { class: 'sk-vis' }, vis),
      h('div', { class: 'pl-two' }, h('div', { class: 'pl-section' }, h('h3', { class: 'shelf-label' }, 'Worked out'), derived), h('div', { class: 'pl-section' }, h('h3', { class: 'shelf-label' }, 'Notes'), notes, h('small', { class: 'help' }, 'Notes never stop you building a rake.'))),
      h('h3', { class: 'shelf-label' }, `Vehicles, end A first (${vehicles.length})`),
      vehicles.length ? h('ol', { class: 'plain sk-rows' }, ...vehicles.map(vehRow)) : h('p', { class: 'help' }, 'No vehicles in this rake yet.'),
      h(
        'div',
        { class: 'sk-adders' },
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'sk_add_fleet' }, 'Add a vehicle from the fleet'),
          h('div', { class: 'row' }, fleetSel, h('button', { class: 'btn small', type: 'button', on: { click: () => fleetSel.value && editRake((r) => r.vehicleIds.push(fleetSel.value)) } }, 'Add')),
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'sk_add_type' }, 'Add a new vehicle of a type'),
          h(
            'div',
            { class: 'row' },
            typeSel,
            h(
              'button',
              {
                class: 'btn primary small',
                type: 'button',
                on: {
                  click: () => {
                    if (!typeSel.value) return toast('Choose a type first.');
                    const v = mintVehicle(typeSel.value);
                    editRake((r, rr) => {
                      rr.fleet.push(v);
                      r.vehicleIds.push(v.id);
                    });
                  },
                },
              },
              'Add new',
            ),
          ),
          h('small', { class: 'help' }, 'It joins the fleet too, with its system identity until you give it one.'),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: `sk_rnotes_${rake.id}` }, 'Notes'),
        h('textarea', { id: `sk_rnotes_${rake.id}`, rows: 2, maxlength: 2000, on: { change: (e: Event) => editRake((r) => (r.notes = (e.target as HTMLTextAreaElement).value)) } }, rake.notes),
      ),
      h(
        'div',
        { class: 'row end' },
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            on: {
              click: () => {
                const id = `rake_${newVehicleId().slice(0, 8)}`;
                upd((rr) => rr.rakes.push({ ...structuredClone(rake), id, identity: `${rake.identity} (copy)` }));
                selRake = id;
              },
            },
          },
          'Make a copy',
        ),
        confirmButton(`Delete ${rake.identity}`, 'Delete? (vehicles stay in the fleet)', () => upd((rr) => (rr.rakes = rr.rakes.filter((x) => x.id !== rake.id))), 'btn danger small'),
      ),
    );
    return body;
  };

  // ---------------------------------------------------------------- fleet
  const fleetBody = () => {
    const body = h('div', { class: 'pl-body sk-body' });
    const dups = duplicateIdentities(rs.fleet, lib);
    const places = layout.places;
    const q = fleetFilter.trim().toLowerCase();
    const list = rs.fleet
      .filter((v) => !q || `${vehicleName(v, lib)} ${clsName(v.classId)}`.toLowerCase().includes(q))
      .sort((a, b) =>
        fleetSort === 'type'
          ? clsName(a.classId).localeCompare(clsName(b.classId)) || vehicleName(a, lib).localeCompare(vehicleName(b, lib))
          : fleetSort === 'loaded'
            ? Number(!!b.loaded) - Number(!!a.loaded) || vehicleName(a, lib).localeCompare(vehicleName(b, lib))
            : vehicleName(a, lib).localeCompare(vehicleName(b, lib), undefined, { numeric: true }),
      );
    const editV = (id: string, fn: (v: Vehicle) => void) =>
      upd((r) => {
        const v = r.fleet.find((x) => x.id === id);
        if (v) fn(v);
      });
    const row = (v: Vehicle) => {
      const c = lib.cls(v.classId);
      const inRakes = rs.rakes.filter((r) => r.vehicleIds.includes(v.id));
      const dup = dups.has(vehicleName(v, lib).trim().toLowerCase());
      return h(
        'li',
        { class: 'sk-fleet-row' },
        h(
          'div',
          { class: 'field' },
          h('input', {
            type: 'text',
            id: `sk_vid_${v.id}`,
            value: v.identity ?? '',
            placeholder: systemIdentity(v, c),
            maxlength: 120,
            autocomplete: 'off',
            'aria-label': `Identity of ${vehicleName(v, lib)} (blank shows ${systemIdentity(v, c)})`,
            on: { change: (e: Event) => editV(v.id, (x) => ((x.identity = (e.target as HTMLInputElement).value.trim()) || delete x.identity)) },
          }),
          dup ? h('small', { class: 'sk-warn' }, 'Another vehicle has this identity.') : null,
        ),
        h('div', { class: 'field' }, h('select', { 'aria-label': `Type of ${vehicleName(v, lib)}`, on: { change: (e: Event) => editV(v.id, (x) => (x.classId = (e.target as HTMLSelectElement).value)) } }, ...(c ? [] : [option(v.classId, 'Unknown type', true)]), ...classOptions(v.classId))),
        h(
          'div',
          { class: 'sk-fleet-end' },
          canLoad(c)
            ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!v.loaded, on: { change: (e: Event) => editV(v.id, (x) => ((e.target as HTMLInputElement).checked ? (x.loaded = true) : delete x.loaded)) } }), h('span', null, 'Loaded'))
            : null,
          h(
            'select',
            { 'aria-label': `Home of ${vehicleName(v, lib)}`, title: 'Home place (used later to send empties back)', on: { change: (e: Event) => editV(v.id, (x) => ((e.target as HTMLSelectElement).value ? (x.home = (e.target as HTMLSelectElement).value) : delete x.home)) } },
            option('', 'No home'),
            ...places.map((p) => option(p.id, `Home: ${p.name}`, p.id === v.home)),
          ),
          h('small', { class: 'help' }, inRakes.length ? `in ${inRakes.map((r) => r.identity).join(', ')}` : 'in no rake'),
          (() => {
            const x = confirmButton('✕', 'Remove?', () => upd((r) => {
              r.fleet = r.fleet.filter((y) => y.id !== v.id);
              for (const k of r.rakes) k.vehicleIds = k.vehicleIds.filter((id) => id !== v.id);
            }), 'btn danger small');
            x.setAttribute('aria-label', `Remove ${vehicleName(v, lib)} from the fleet${inRakes.length ? ' and its rakes' : ''}`);
            return x;
          })(),
        ),
      );
    };
    const addSel = h('select', { id: 'sk_fleet_type', 'aria-label': 'Type of the new vehicle' }, option('', 'Choose a type…'), ...classOptions(''));
    body.append(
      h('p', { class: 'help' }, 'Every vehicle has a permanent system identity (its type code and part of its id). Type your own identity to override it, e.g. a running number; clear it to go back.'),
      h(
        'div',
        { class: 'row sk-tools' },
        h('input', { type: 'search', id: 'sk_fleet_q', value: fleetFilter, placeholder: 'Filter by identity or type', 'aria-label': 'Filter the fleet', on: { change: (e: Event) => ((fleetFilter = (e.target as HTMLInputElement).value), ctx.store.update(() => {})) } }),
        h(
          'select',
          { 'aria-label': 'Sort the fleet', on: { change: (e: Event) => ((fleetSort = (e.target as HTMLSelectElement).value as typeof fleetSort), ctx.store.update(() => {})) } },
          option('identity', 'Sort by identity', fleetSort === 'identity'),
          option('type', 'Sort by type', fleetSort === 'type'),
          option('loaded', 'Loaded first', fleetSort === 'loaded'),
        ),
      ),
      list.length ? h('ul', { class: 'plain sk-fleet' }, ...list.map(row)) : h('p', { class: 'help' }, rs.fleet.length ? 'Nothing matches the filter.' : 'No vehicles yet.'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'sk_fleet_type' }, 'Add a vehicle'),
        h('div', { class: 'row' }, addSel, h('button', { class: 'btn primary small', type: 'button', on: { click: () => (addSel.value ? upd((r) => r.fleet.push(mintVehicle(addSel.value))) : toast('Choose a type first.')) } }, 'Add to the fleet')),
      ),
    );
    return body;
  };

  // ---------------------------------------------------------------- library
  const libraryBody = () => {
    const body = h('div', { class: 'pl-body sk-body' });
    const all = [...rs.classes, ...lib.builtIns()];
    const origins = [...new Set(all.map((c) => c.origin ?? '').filter(Boolean))].sort();
    const eras = [...new Set(all.flatMap((c) => c.eras ?? []))];
    const q = libFilter.text.trim().toLowerCase();
    const shown = all.filter(
      (c) =>
        (libFilter.hidden || !lib.hidden(c.id)) &&
        (!libFilter.origin || (libFilter.origin === '(yours)' ? !c.builtIn : c.origin === libFilter.origin)) &&
        (!libFilter.era || !c.eras?.length || c.eras.includes(libFilter.era)) &&
        (!libFilter.category || c.category === libFilter.category) &&
        (!q || `${c.name} ${c.code ?? ''} ${c.diagram ?? ''}`.toLowerCase().includes(q)),
    );
    const setF = (k: keyof typeof libFilter, v: string | boolean) => {
      (libFilter as Record<string, string | boolean>)[k] = v;
      ctx.store.update(() => {});
    };
    const lengthText = (c: VehicleClass) =>
      c.metresOverBuffers === undefined ? 'length not known' : `${c.lengthBasis && c.lengthBasis !== 'measured' ? 'about ' : ''}${vlen(c.metresOverBuffers)} · ${BASIS_NAMES[c.lengthBasis ?? 'estimated']}`;
    const tags = (c: VehicleClass) =>
      [c.coachType ? COACH_TYPE_NAMES[c.coachType] : CATEGORY_NAMES[c.category].replace(/s$/, ''), c.fitted ? 'fitted' : 'unfitted', c.corridor === true ? 'corridor' : c.corridor === false ? 'non-corridor' : '', c.guard ? 'guard’s compartment' : '', c.origin ? (c.origin === 'generic' ? 'generic' : c.origin) : '', c.diagram ?? '']
        .filter(Boolean)
        .join(' · ');
    const inUse = (id: string) => rs.fleet.filter((v) => v.classId === id).length;
    const row = (c: VehicleClass) => {
      const n = inUse(c.id);
      const hidden = lib.hidden(c.id);
      const copy = () => {
        const id = `type_${newVehicleId().slice(0, 8)}`;
        upd((r) => r.classes.push({ ...structuredClone(c), id, name: `${c.name} (copy)`, builtIn: false, copiedFrom: c.id }));
        editClass = id;
        focusNext = `sk_cname_${id}`;
      };
      return h(
        'li',
        { class: `sk-lib-row${hidden ? ' sk-hidden' : ''}` },
        h(
          'div',
          { class: 'sk-lib-main' },
          h('strong', null, c.name),
          c.code ? h('span', { class: 'pl-kind-tag' }, c.code) : null,
          h('small', { class: 'help sk-lib-len' }, lengthText(c)),
          h('small', { class: 'help' }, tags(c)),
          c.source ? h('small', { class: 'help sk-src' }, c.source) : null,
          n ? h('small', { class: 'help' }, `${plural(n, 'vehicle')} in the fleet`) : null,
        ),
        h(
          'div',
          { class: 'sk-btns' },
          c.builtIn
            ? h('button', { class: 'btn small', type: 'button', on: { click: () => upd((r) => (hidden ? (r.hidden = r.hidden.filter((x) => x !== c.id)) : r.hidden.push(c.id))) } }, hidden ? 'Show' : 'Hide')
            : h('button', { class: 'btn small', type: 'button', 'aria-expanded': String(editClass === c.id), on: { click: () => ((editClass = editClass === c.id ? '' : c.id), ctx.store.update(() => {})) } }, editClass === c.id ? 'Done' : 'Edit'),
          h('button', { class: 'btn small', type: 'button', on: { click: copy } }, 'Copy'),
          c.builtIn
            ? null
            : n
              ? h('button', { class: 'btn danger small', type: 'button', disabled: true, title: 'Vehicles in the fleet are of this type' }, 'Remove')
              : confirmButton('Remove', 'Remove?', () => upd((r) => (r.classes = r.classes.filter((x) => x.id !== c.id))), 'btn danger small'),
        ),
        !c.builtIn && editClass === c.id ? classForm(c) : null,
      );
    };
    const sel = (id: string, label: string, value: string, opts: Array<[string, string]>, k: keyof typeof libFilter) =>
      h('select', { id, 'aria-label': label, on: { change: (e: Event) => setF(k, (e.target as HTMLSelectElement).value) } }, ...opts.map(([v, t]) => option(v, t, v === value)));
    body.append(
      h('p', { class: 'help' }, 'Prototype vehicle types, by length over buffers. Lengths marked "about" are estimated, nominal or generic. Generic types stand in for any company or era. Add your own types for anything missing; built-in types can be hidden, or copied to edit.'),
      h(
        'div',
        { class: 'row sk-tools' },
        h('input', { type: 'search', value: libFilter.text, placeholder: 'Search names, codes, diagrams', 'aria-label': 'Search the library', on: { change: (e: Event) => setF('text', (e.target as HTMLInputElement).value) } }),
        sel('sk_lib_origin', 'Company', libFilter.origin, [['', 'Any company'], ['(yours)', 'Your own types'], ...origins.map((o): [string, string] => [o, o === 'generic' ? 'Generic' : o])], 'origin'),
        sel('sk_lib_era', 'Era', libFilter.era, [['', 'Any era'], ...eras.map((e): [string, string] => [e, ERA_NAMES[e] ?? e])], 'era'),
        sel('sk_lib_cat', 'Kind', libFilter.category, [['', 'Every kind'], ...CATEGORIES.map((c): [string, string] => [c, CATEGORY_NAMES[c]])], 'category'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: libFilter.hidden, on: { change: (e: Event) => setF('hidden', (e.target as HTMLInputElement).checked) } }), h('span', null, `Show hidden (${rs.hidden.length})`)),
      ),
      h(
        'button',
        {
          class: 'add-tile sk-add-type',
          type: 'button',
          on: {
            click: () => {
              const id = `type_${newVehicleId().slice(0, 8)}`;
              upd((r) => r.classes.push({ id, name: 'New type', category: 'wagon', guard: false, fitted: false, builtIn: false }));
              editClass = id;
              focusNext = `sk_cname_${id}`;
              libFilter.origin = '';
            },
          },
        },
        plusIcon(),
        h('span', { class: 'mi-label' }, 'Add your own type'),
        h('span', { class: 'mi-sub' }, 'e.g. “I have a GWR Mink, it’s this long”'),
      ),
      shown.length ? h('ul', { class: 'plain sk-lib' }, ...shown.map(row)) : h('p', { class: 'help' }, 'Nothing matches.'),
    );
    return body;
  };

  /** The form for one of the user's own types. */
  const classForm = (c: VehicleClass) => {
    const editC = (fn: (x: VehicleClass) => void) =>
      upd((r) => {
        const x = r.classes.find((y) => y.id === c.id);
        if (x) fn(x);
      });
    const text = (id: string, label: string, value: string, max: number, apply: (v: string) => void, help?: string) =>
      h('div', { class: 'field' }, h('label', { for: id }, label), h('input', { type: 'text', id, value, maxlength: max, autocomplete: 'off', on: { change: (e: Event) => apply((e.target as HTMLInputElement).value.trim()) } }), help ? h('small', { class: 'help' }, help) : null);
    const bare = units === 'metric' ? 'm' : 'ft';
    const lengthField = (id: string, label: string, value: number | undefined, apply: (m: number | undefined) => void, help: string) => {
      const input = h('input', { type: 'text', id, value: value ? vlen(value) : '', placeholder: units === 'metric' ? 'e.g. 6.5 m' : 'e.g. 21 ft 6 in', autocomplete: 'off' });
      const err = h('small', { class: 'field-error', role: 'alert', hidden: true }, 'Cannot read that length.');
      input.addEventListener('change', () => {
        const t = input.value.trim();
        const m = t ? parseLength(t, bare) : undefined;
        err.hidden = m !== null;
        if (m !== null) apply(m ?? undefined);
      });
      return h('div', { class: 'field' }, h('label', { for: id }, label), input, err, h('small', { class: 'help' }, help));
    };
    const coachy = c.category === 'coach' || c.category === 'van';
    return h(
      'div',
      { class: 'form-grid tight sk-class-form' },
      text(`sk_cname_${c.id}`, 'Name', c.name, 120, (v) => v && editC((x) => (x.name = v))),
      text(`sk_ccode_${c.id}`, 'Code', c.code ?? '', 12, (v) => editC((x) => (v ? (x.code = v.toUpperCase()) : delete x.code)), 'Starts its vehicles’ identities, e.g. MINK.'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: `sk_ccat_${c.id}` }, 'Kind'),
        h('select', { id: `sk_ccat_${c.id}`, on: { change: (e: Event) => editC((x) => {
          x.category = (e.target as HTMLSelectElement).value as StockCategory;
          if (x.category === 'coach' && !x.coachType) x.coachType = 'ordinary';
          if (x.category !== 'coach' && x.category !== 'van') delete x.coachType;
          if (x.category === 'brakeVan') x.guard = true;
        }) } }, ...CATEGORIES.map((k) => option(k, CATEGORY_NAMES[k].replace(/s$/, ''), k === c.category))),
      ),
      coachy
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: `sk_ctype_${c.id}` }, 'Coaching stock'),
            h('select', { id: `sk_ctype_${c.id}`, on: { change: (e: Event) => editC((x) => {
              const v = (e.target as HTMLSelectElement).value as CoachType | '';
              if (v) x.coachType = v;
              else delete x.coachType;
              if (v === 'passengerBrake' || v === 'fullBrake') x.guard = true;
            }) } }, ...(c.category === 'van' ? [option('', 'No: a goods van', !c.coachType)] : []), ...COACH_TYPES.map((t) => option(t, COACH_TYPE_NAMES[t], t === c.coachType))),
          )
        : null,
      coachy
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: `sk_ccor_${c.id}` }, 'Corridor'),
            h('select', { id: `sk_ccor_${c.id}`, on: { change: (e: Event) => editC((x) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === '') delete x.corridor;
              else x.corridor = v === 'yes';
            }) } }, option('yes', 'Corridor (or open saloon)', c.corridor === true), option('no', 'Non-corridor', c.corridor === false), option('', 'Not recorded', c.corridor === undefined)),
          )
        : null,
      lengthField(`sk_clen_${c.id}`, 'Length over buffers', c.metresOverBuffers, (m) => editC((x) => {
        if (m === undefined) {
          delete x.metresOverBuffers;
          delete x.lengthBasis;
        } else {
          x.metresOverBuffers = m;
          x.lengthBasis ??= 'measured';
        }
      }), 'What the app measures against platforms and roads.'),
      lengthField(`sk_chs_${c.id}`, 'Over headstocks (optional)', c.metresOverHeadstocks, (m) => editC((x) => {
        if (m === undefined) return void delete x.metresOverHeadstocks;
        x.metresOverHeadstocks = m;
        // No over-buffers length given: work it out with the buffer allowance, marked estimated.
        if (x.metresOverBuffers === undefined || x.lengthBasis === 'estimated') {
          x.metresOverBuffers = overBuffersFromHeadstocks(m, x.category, x.coachType, x.origin, x.eras);
          x.lengthBasis = 'estimated';
        }
      }), 'Leave over buffers blank to work it out from this.'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: `sk_cbasis_${c.id}` }, 'How sure is the length'),
        h('select', { id: `sk_cbasis_${c.id}`, disabled: c.metresOverBuffers === undefined, on: { change: (e: Event) => editC((x) => (x.lengthBasis = (e.target as HTMLSelectElement).value as LengthBasis)) } },
          option('measured', 'Measured (exact)', c.lengthBasis === 'measured'),
          option('estimated', 'Estimated (about)', c.lengthBasis === 'estimated'),
          option('nominal', 'Nominal (about)', c.lengthBasis === 'nominal'),
        ),
      ),
      h(
        'div',
        { class: 'field sk-checks' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.fitted, on: { change: (e: Event) => editC((x) => (x.fitted = (e.target as HTMLInputElement).checked)) } }), h('span', null, 'Fitted (continuous brake)')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.guard, on: { change: (e: Event) => editC((x) => (x.guard = (e.target as HTMLInputElement).checked)) } }), h('span', null, 'Guard’s compartment')),
      ),
      text(`sk_corig_${c.id}`, 'Company', c.origin ?? '', 40, (v) => editC((x) => (v ? (x.origin = v) : delete x.origin)), 'e.g. GWR. Picks its buffer allowance if the app knows it.'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: `sk_cera_${c.id}` }, 'Era'),
        h('select', { id: `sk_cera_${c.id}`, on: { change: (e: Event) => editC((x) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v) x.eras = [v];
          else delete x.eras;
        }) } }, option('', 'Any era', !c.eras?.length), ...Object.entries(ERA_NAMES).map(([k, n]) => option(k, n, c.eras?.[0] === k))),
      ),
      text(`sk_ctare_${c.id}`, 'Tare weight, tons (optional)', c.tareKg ? String(Math.round((c.tareKg / 1016.047) * 10) / 10) : '', 8, (v) => editC((x) => {
        const n = Number(v);
        if (v && Number.isFinite(n) && n > 0) x.tareKg = n * 1016.047;
        else delete x.tareKg;
      })),
      text(`sk_cnotes_${c.id}`, 'Notes', c.notes ?? '', 400, (v) => editC((x) => (v ? (x.notes = v) : delete x.notes))),
    );
  };

  const el = h(
    'div',
    { class: 'pl-page sk-page' },
    h(
      'p',
      { class: 'shelf-help' },
      `The rolling stock of ${layout.name}: a library of vehicle types, your fleet of individual vehicles, and rakes built from them, drawn to scale with what they add up to. `,
      'Use it to plan formations for timetables. In signaller play mode, stock left standing in roads is made of individual vehicles too.',
    ),
    sectionCase('rakes', 'Rakes', `${plural(rs.rakes.length, 'rake')} saved`, rakesBody()),
    sectionCase('fleet', 'Fleet', `${plural(rs.fleet.length, 'vehicle')}`, fleetBody()),
    sectionCase('library', 'Library', `${lib.builtIns().length} built-in types${rs.classes.length ? ` + ${rs.classes.length} of your own` : ''}${rs.hidden.length ? ` · ${rs.hidden.length} hidden` : ''}`, libraryBody()),
  );
  if (focusNext) {
    const id = focusNext;
    focusNext = '';
    window.setTimeout(() => {
      const f = document.getElementById(id) as HTMLInputElement | null;
      f?.closest<HTMLElement>('.pl-body')?.removeAttribute('hidden');
      f?.focus();
      f?.select();
    }, 0);
  }
  return el;
}
