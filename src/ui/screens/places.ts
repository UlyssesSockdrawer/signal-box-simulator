import { boxesOn, findLayout } from '../../core/layouts';
import {
  addPlace,
  addRoad,
  checkPlaceName,
  checkPlaceShort,
  checkRoadName,
  kindInfo,
  MAX_PLACES,
  MAX_ROADS,
  PLACE_KINDS,
  PLACE_SHORT_MAX,
  placeOccupants,
  removePlace,
  removeRoad,
  setConnectionPlace,
  setRoadCount,
  setWorker,
  tieRoad,
  trainsBeyondRoad,
  worksPlace,
} from '../../core/places';
import { circuitLabel } from '../../core/trackPlan';
import type { AppState, Layout, Place, PlaceKind, PlaceRoad, PlaceWorker } from '../../core/types';
import { type Ctx } from '../app';
import { disposeBoxRuntime } from '../boxRuntime';
import { confirmButton, h, option, toast } from '../dom';
import { plusIcon } from './boxConfig';
import { confirmTrainsOff } from './layouts';

/*
 * The layout configurator's Places tab: every place on the layout where trains stand or are
 * worked — stations, sidings, goods yards and sheds, loco depots, fiddle yards. Each is a
 * mahogany case on the teak shelf: its kind, name and notes, the signal boxes that work it (a
 * station can have several, e.g. North and South boxes; a junction box need not work any), the
 * lines whose trains run to and from it, and its roads (platforms, siding roads, yard roads),
 * each of which can be tied to a track circuit on the plan.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Places this session has just added, to focus their name field once drawn. */
let focusNext = '';

export function layoutPlaces(ctx: Ctx, layoutId: string): HTMLElement {
  const st = ctx.store.state;
  const layout = findLayout(st, layoutId)!;
  const boxes = boxesOn(st, layout.id);
  const upd = (placeId: string, fn: (p: Place, l: Layout, a: AppState) => void) =>
    ctx.store.update((a) => {
      const l = findLayout(a, layoutId);
      const p = l?.places.find((x) => x.id === placeId);
      if (l && p) fn(p, l, a);
    });
  /** Changes that alter what a running box does (where its lines run) restart its runtime. */
  const restartBoxes = (ids: string[]) => ids.forEach((id) => disposeBoxRuntime(id));

  const checked = (id: string, label: string, value: string, max: number, check: (v: string) => string | null, apply: (v: string) => void, help?: string, onInput?: (v: string, ok: boolean) => void) => {
    const input = h('input', { type: 'text', id, value, maxlength: max, autocomplete: 'off' });
    const err = h('small', { class: 'field-error', id: `${id}_err`, role: 'alert', hidden: true });
    const show = (msg: string | null) => {
      err.textContent = msg ?? '';
      err.hidden = !msg;
      input.classList.toggle('invalid', !!msg);
    };
    input.setAttribute('aria-describedby', `${id}_err`);
    input.addEventListener('input', () => {
      const msg = check(input.value);
      show(msg);
      onInput?.(input.value, !msg);
    });
    input.addEventListener('change', () => {
      const msg = check(input.value);
      show(msg);
      if (!msg && input.value.trim() !== value) apply(input.value.trim());
    });
    return h('div', { class: 'field' }, h('label', { for: id }, label), input, err, help ? h('small', { class: 'help' }, help) : null);
  };

  // ---------------------------------------------------------------- one road
  const circuitOptions = (r: PlaceRoad) => {
    const tiedTo = new Map<string, string>();
    for (const p of layout.places) for (const x of p.roads) if (x.circuitId && x.id !== r.id) tiedTo.set(x.circuitId, `${p.name} · ${x.name}`);
    return [
      option('', layout.trackPlan.circuits.length ? 'Not tied to the track plan' : 'No track plan yet', !r.circuitId),
      ...layout.trackPlan.circuits.map((c) => {
        const other = tiedTo.get(c.id);
        const plat = c.platform ? ` · platform ${c.platform.number}` : '';
        return option(c.id, `${circuitLabel(c)}${plat}${other ? ` (now ${other})` : ''}`, r.circuitId === c.id);
      }),
    ];
  };

  const roadRow = (p: Place, r: PlaceRoad) => {
    const trains = placeOccupants(st, p.id, r.id);
    const tid = `pl_rc_${r.id}`;
    return h(
      'li',
      { class: 'pl-road' },
      h(
        'div',
        { class: 'pl-road-grid' },
        checked(`pl_rn_${r.id}`, 'Road', r.name, 30, (v) => checkRoadName(p, v, r.id), (v) => upd(p.id, (pp) => {
          const x = pp.roads.find((y) => y.id === r.id);
          if (x) x.name = v;
        })),
        h('div', { class: 'field' }, h('label', { for: tid }, 'Track circuit'), h('select', { id: tid, disabled: !layout.trackPlan.circuits.length, on: { change: (e: Event) => upd(p.id, (_pp, l) => tieRoad(l, p.id, r.id, (e.target as HTMLSelectElement).value)) } }, ...circuitOptions(r))),
        h(
          'div',
          { class: 'field pl-road-notes' },
          h('label', { for: `pl_rnote_${r.id}` }, 'Notes'),
          h('input', {
            id: `pl_rnote_${r.id}`,
            type: 'text',
            value: r.notes,
            placeholder: 'Length, what it is used for…',
            on: { change: (e: Event) => upd(p.id, (pp) => { const x = pp.roads.find((y) => y.id === r.id); if (x) x.notes = (e.target as HTMLInputElement).value.trim(); }) },
          }),
        ),
      ),
      h(
        'div',
        { class: 'row pl-road-foot' },
        h('small', { class: 'help' }, trains.length ? `${plural(trains.length, 'train')} standing here` : 'Empty'),
        p.kind === 'fiddleYard' && p.roads.length <= 1
          ? null
          : confirmButton(`Remove ${r.name}`, trains.length ? 'Press again (its trains stay in the place)' : 'Press again to remove', () => ctx.store.update((a) => removeRoad(a, p.id, r.id)), 'btn danger small'),
      ),
    );
  };

  // ---------------------------------------------------------------- one place
  const placeCase = (p: Place) => {
    const board = h('h2', { class: 'nameboard section-board', id: `pl_board_${p.id}` }, p.name);
    const trains = placeOccupants(st, p.id);
    const kindId = `pl_kind_${p.id}`;
    const conns = boxes.flatMap((b) => b.connections.map((c) => ({ b, c })));

    const workerRow = (w: PlaceWorker, label: string, sub: string) => {
      const id = `pl_w_${p.id}_${w.kind === 'box' ? w.boxId : w.connectionId}`;
      return h(
        'li',
        null,
        h(
          'label',
          { class: 'check', for: id },
          h('input', { id, type: 'checkbox', checked: worksPlace(p, w), on: { change: (e: Event) => upd(p.id, (pp) => setWorker(pp, w, (e.target as HTMLInputElement).checked)) } }),
          h('span', null, h('strong', null, label), sub ? h('small', { class: 'help' }, ` · ${sub}`) : null),
        ),
      );
    };

    const lineRow = ({ b, c }: (typeof conns)[number]) => {
      const id = `pl_line_${p.id}_${c.id}`;
      const elsewhere = c.placeId && c.placeId !== p.id ? layout.places.find((x) => x.id === c.placeId) : undefined;
      return h(
        'li',
        null,
        h(
          'label',
          { class: 'check', for: id },
          h('input', {
            id,
            type: 'checkbox',
            checked: c.placeId === p.id,
            on: {
              change: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                restartBoxes([b.id]);
                ctx.store.update((a) => {
                  const bb = a.boxes.find((x) => x.id === b.id);
                  const cc = bb?.connections.find((x) => x.id === c.id);
                  if (bb && cc) setConnectionPlace(a, bb, cc, on ? p.id : '');
                });
                toast(on ? `Trains on the line from ${b.name} to ${c.neighbourName} now run to and from ${p.name}.` : `The line from ${b.name} to ${c.neighbourName} no longer runs to ${p.name}: its trains come from and go back to the roster.`);
              },
            },
          }),
          h('span', null, h('strong', null, `${b.name} – ${c.neighbourName}`), elsewhere ? h('small', { class: 'help' }, ` · now runs to ${elsewhere.name}`) : null),
        ),
      );
    };

    const roadCount = () => {
      const id = `pl_rcount_${p.id}`;
      const input = h('input', {
        id,
        type: 'number',
        min: p.kind === 'fiddleYard' ? 1 : 0,
        max: MAX_ROADS,
        step: 1,
        inputmode: 'numeric',
        value: p.roads.length,
        on: {
          keydown: (e: KeyboardEvent) => {
            if (['-', '+', 'e', 'E', '.', ','].includes(e.key)) e.preventDefault();
          },
          change: (e: Event) => {
            const el = e.target as HTMLInputElement;
            const n = Number(el.value);
            let err: string | null = null;
            const lost = Number.isInteger(n) && n >= 0 ? trainsBeyondRoad(ctx.store.state, p.id, n) : [];
            const apply = () => {
              ctx.store.update((a) => (err = setRoadCount(a, p.id, n)));
              if (err) {
                el.value = String(p.roads.length);
                toast(err);
              } else if (lost.length) toast(`${plural(lost.length, 'train')} left on no road in ${p.name}.`);
            };
            apply();
          },
        },
      });
      return h('div', { class: 'field pl-count' }, h('label', { for: id }, 'Number of roads'), input, h('small', { class: 'help' }, `Up to ${MAX_ROADS}. Removing roads keeps their trains in ${p.name}, on no road.`));
    };

    const remove = () => {
      let n = 0;
      restartBoxes(conns.filter(({ c }) => c.placeId === p.id).map(({ b }) => b.id));
      ctx.store.update((a) => (n = removePlace(a, p.id)));
      toast(`${p.name} removed.${n ? ` ${plural(n, 'train')} moved off the layout.` : ''}`);
    };

    return h(
      'article',
      { class: 'config-case pl-case', 'aria-labelledby': `pl_board_${p.id}`, 'data-kind': p.kind },
      h('div', { class: 'panel-head' }, board, h('span', { class: 'pl-kind-tag' }, kindInfo(p.kind).name)),
      h(
        'div',
        { class: 'form-grid tight' },
        checked(`pl_name_${p.id}`, 'Name', p.name, 60, (v) => checkPlaceName(layout, v, p.id), (v) => upd(p.id, (pp) => (pp.name = v)), undefined, (v, ok) => (board.textContent = ok ? v.trim() : p.name)),
        checked(`pl_short_${p.id}`, 'Short name', p.shortName, PLACE_SHORT_MAX, (v) => checkPlaceShort(layout, v, p.id), (v) => upd(p.id, (pp) => (pp.shortName = v.toUpperCase())), 'Optional, e.g. YK'),
        h(
          'div',
          { class: 'field' },
          h('label', { for: kindId }, 'Kind of place'),
          h('select', { id: kindId, on: { change: (e: Event) => upd(p.id, (pp) => (pp.kind = (e.target as HTMLSelectElement).value as PlaceKind)) } }, ...PLACE_KINDS.map((k) => option(k.kind, k.name, k.kind === p.kind))),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: `pl_notes_${p.id}` }, 'Notes'),
        h('textarea', { id: `pl_notes_${p.id}`, rows: 2, placeholder: 'Anything the signaller should know about it', on: { change: (e: Event) => upd(p.id, (pp) => (pp.notes = (e.target as HTMLTextAreaElement).value.trim())) } }, p.notes),
      ),
      h(
        'div',
        { class: 'pl-section' },
        h('h3', { class: 'shelf-label' }, 'Worked by'),
        boxes.length
          ? h(
              'ul',
              { class: 'plain pl-checks' },
              ...boxes.map((b) => workerRow({ kind: 'box', boxId: b.id }, b.name, 'signal box you work')),
              ...conns.map(({ b, c }) => workerRow({ kind: 'remote', boxId: b.id, connectionId: c.id }, c.neighbourName, `simulated, at the far end of the line from ${b.name}`)),
            )
          : h('p', { class: 'help' }, `No signal boxes on ${layout.name} yet (Details tab).`),
        h('small', { class: 'help' }, 'Trains arriving at a box you work can be put on the roads of the places it works. A station can be worked by more than one box.'),
      ),
      conns.length
        ? h(
            'div',
            { class: 'pl-section' },
            h('h3', { class: 'shelf-label' }, 'Lines that run here'),
            h('ul', { class: 'plain pl-checks' }, ...conns.map(lineRow)),
            h('small', { class: 'help' }, 'Trains sent along these lines arrive here, and trains standing here can be offered back along them.'),
          )
        : null,
      h(
        'div',
        { class: 'pl-section' },
        h('h3', { class: 'shelf-label' }, `Roads (${p.roads.length})`),
        p.kind === 'fiddleYard' ? roadCount() : null,
        p.roads.length ? h('ul', { class: 'plain pl-roads' }, ...p.roads.map((r) => roadRow(p, r))) : h('p', { class: 'help' }, `No roads: trains stand somewhere in ${p.name}.`),
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            disabled: p.roads.length >= MAX_ROADS,
            on: {
              click: () => {
                let id = '';
                upd(p.id, (pp) => (id = addRoad(pp)?.id ?? ''));
                if (id) focusNext = `pl_rn_${id}`;
              },
            },
          },
          `+ Add a road to ${p.name}`,
        ),
      ),
      h(
        'div',
        { class: 'row end pl-foot' },
        h('small', { class: 'help' }, trains.length ? `${plural(trains.length, 'train')} in ${p.name}.` : `No trains in ${p.name}.`),
        trains.length
          ? h('button', { class: 'btn danger small', type: 'button', on: { click: () => confirmTrainsOff(placeOccupants(ctx.store.state, p.id), `Remove ${p.name}?`, `in ${p.name}`, `Remove ${p.name}`, remove) } }, `Remove ${p.name}`)
          : confirmButton(`Remove ${p.name}`, 'Press again to remove', remove, 'btn danger small'),
      ),
    );
  };

  // ---------------------------------------------------------------- adding
  const full = layout.places.length >= MAX_PLACES;
  const addCase = h(
    'div',
    { class: 'add-tile pl-add', role: 'group', 'aria-labelledby': 'pl_add_l' },
    plusIcon(),
    h('span', { class: 'mi-label', id: 'pl_add_l' }, 'Add a place'),
    h('span', { class: 'mi-sub' }, full ? `No more than ${MAX_PLACES} places.` : 'Choose what kind:'),
    h(
      'div',
      { class: 'pl-add-kinds' },
      ...PLACE_KINDS.map((k) =>
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            id: `pl_add_${k.kind}`,
            disabled: full,
            on: {
              click: () => {
                let id = '';
                ctx.store.update((a) => (id = addPlace(a, layout.id, k.kind)?.id ?? ''));
                if (id) focusNext = `pl_name_${id}`;
              },
            },
          },
          k.name,
        ),
      ),
    ),
  );

  // Group the cases by kind, in the catalogue's order.
  const groups = PLACE_KINDS.map((k) => ({ k, places: layout.places.filter((p) => p.kind === k.kind) })).filter((g) => g.places.length);
  const intro = h(
    'p',
    { class: 'shelf-help' },
    `Everywhere on ${layout.name} that trains stand: stations, sidings, goods yards and sheds, loco depots and fiddle yards. `,
    'Say which signal boxes work each one and which lines run to it, and give it its roads (platforms, siding roads, yard roads). ',
    'Roads can be tied to track circuits on the track plan.',
  );
  const el = h(
    'div',
    { class: 'pl-page' },
    intro,
    ...groups.map((g) => h('section', { class: 'pl-group', 'aria-label': g.k.plural }, h('h2', { class: 'shelf-label pl-group-head' }, g.k.plural), h('div', { class: 'pl-grid' }, ...g.places.map(placeCase)))),
    h('div', { class: 'pl-grid' }, addCase),
  );
  if (focusNext) {
    const id = focusNext;
    focusNext = '';
    window.setTimeout(() => {
      const f = document.getElementById(id) as HTMLInputElement | null;
      f?.focus();
      f?.select();
      f?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
  }
  return el;
}
