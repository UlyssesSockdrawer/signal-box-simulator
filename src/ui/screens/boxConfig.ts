import {
  addConnection,
  canOpenBox,
  checkBoxName,
  checkBoxShort,
  checkConnName,
  checkConnShort,
  checkShelfPositions,
  deleteBox,
  MAX_SHELF_POSITIONS,
  moveConnection,
  removeConnection,
  setShelfPositions,
  SHORT_NAME_MAX,
} from '../../core/boxes';
import { layoutOfBox } from '../../core/layouts';
import { kindInfo, PLACE_KINDS, placesForBox, placesWorkedBy, setConnectionPlace } from '../../core/places';
import { layoutShelf, positionLabel } from '../../core/shelf';
import type { AppState, BoxDef, ConnectionDef, LineType, WorkingMode } from '../../core/types';
import { topBar, type Ctx, type Screen } from '../app';
import { disposeBoxRuntime } from '../boxRuntime';
import { confirmButton, h, option, toast } from '../dom';
import { moveBoxToLayout } from './layouts';

/**
 * Box configurator: what one signal box needs in order to work — its name,
 * its block shelf, and the boxes it is connected to. Laid out in the main
 * menu style: mahogany cases on the teak shelf.
 */
export function boxConfigScreen(ctx: Ctx, boxId?: string): Screen {
  const st = ctx.store.state;
  const box = st.boxes.find((b) => b.id === boxId) ?? st.boxes[0];

  const updBox = (fn: (b: BoxDef, a: AppState) => void) =>
    ctx.store.update((a) => {
      const b = a.boxes.find((x) => x.id === box.id);
      if (b) fn(b, a);
    });
  const updConn = (connId: string, fn: (c: ConnectionDef, b: BoxDef, a: AppState) => void) =>
    ctx.store.update((a) => {
      const b = a.boxes.find((x) => x.id === box.id);
      const c = b?.connections.find((x) => x.id === connId);
      if (b && c) fn(c, b, a);
    });

  /** A labelled field whose value is checked as you type and only saved when it is valid. */
  const checkedField = (
    id: string,
    label: string,
    input: HTMLInputElement,
    check: (v: string) => string | null,
    apply: (v: string) => void,
    opts: { help?: string; onInput?: (v: string, ok: boolean) => void; onReject?: () => void } = {},
  ) => {
    input.id = id;
    const err = h('small', { class: 'field-error', id: `${id}_err`, role: 'alert', hidden: true });
    const show = (msg: string | null) => {
      err.textContent = msg ?? '';
      err.hidden = !msg;
      input.classList.toggle('invalid', !!msg);
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    input.setAttribute('aria-describedby', `${id}_err`);
    input.addEventListener('input', () => {
      const msg = check(input.value);
      show(msg);
      opts.onInput?.(input.value, !msg);
    });
    input.addEventListener('change', () => {
      const msg = check(input.value);
      show(msg);
      if (msg) opts.onReject?.();
      else apply(input.value.trim());
    });
    return h('div', { class: 'field' }, h('label', { for: id }, label), input, err, opts.help ? h('small', { class: 'help' }, opts.help) : null);
  };
  const textInput = (value: string, max?: number) => h('input', { type: 'text', value, maxlength: max, autocomplete: 'off' });
  const selectField = (id: string, label: string, sel: HTMLSelectElement, help?: string) => {
    sel.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), sel, help ? h('small', { class: 'help' }, help) : null);
  };

  // ------------------------------------------------------------ the box itself
  // The nameboard shows the box name exactly as entered.
  const boardName = (name: string) => name.trim() || box.name;
  const board = h('h2', { class: 'nameboard section-board', id: 'bc_board' }, boardName(box.name));
  const openable = canOpenBox(box);
  const openBtn = h(
    'button',
    { class: 'btn primary', type: 'button', disabled: !openable, title: openable ? undefined : 'Add a connected signal box first', on: { click: () => canOpenBox(box) && ctx.go(`box/${box.id}`) } },
    `Open ${box.name} box`,
  );

  const shelfInput = h('input', {
    type: 'number',
    min: 1,
    max: MAX_SHELF_POSITIONS,
    step: 1,
    inputmode: 'numeric',
    value: box.shelfPositions,
    on: { keydown: (e: KeyboardEvent) => { if (['-', '+', 'e', 'E', '.', ','].includes(e.key)) e.preventDefault(); } },
  });

  const boxCase = h(
    'article',
    { class: 'config-case config-box', 'aria-labelledby': 'bc_board' },
    h('div', { class: 'panel-head' }, board, openBtn),
    openable ? null : h('p', { class: 'config-warn' }, 'This box cannot be opened until it is connected to at least one other signal box. Add one below.'),
    h(
      'div',
      { class: 'form-grid tight' },
      checkedField(
        `bc_name_${box.id}`,
        'Box name',
        textInput(box.name, 40),
        (v) => checkBoxName(ctx.store.state, v, box.id),
        (v) => updBox((b) => (b.name = v)),
        {
          help: 'Shown on the nameboard.',
          onInput: (v, ok) => (board.textContent = boardName(ok ? v : box.name)),
          onReject: () => (board.textContent = boardName(box.name)),
        },
      ),
      checkedField(
        `bc_short_${box.id}`,
        'Short name',
        textInput(box.shortName, SHORT_NAME_MAX),
        (v) => checkBoxShort(ctx.store.state, v, box.id),
        (v) => updBox((b) => (b.shortName = v.toUpperCase())),
        { help: 'Used in the register, e.g. BEC.' },
      ),
      checkedField(
        `bc_sp_${box.id}`,
        'Block shelf positions',
        shelfInput,
        (v) => checkShelfPositions(box, v),
        (v) => updBox((b) => setShelfPositions(b, Number(v))),
        { help: `Places for instrument groups along the shelf, left to right (1 to ${MAX_SHELF_POSITIONS}).`, onReject: () => (shelfInput.value = String(box.shelfPositions)) },
      ),
      selectField(
        `bc_layout_${box.id}`,
        'Layout',
        h(
          'select',
          {
            on: {
              change: (e: Event) => {
                const sel = e.target as HTMLSelectElement;
                // Moving clears the box's track on the layout it leaves: asks first when it has any.
                moveBoxToLayout(ctx, box.id, sel.value, () => (sel.value = box.layoutId));
              },
            },
          },
          option('', 'Not on a layout', !layoutOfBox(st, box)),
          ...st.layouts.map((l) => option(l.id, l.name, l.id === box.layoutId)),
        ),
        st.layouts.length
          ? 'The layout this box stands on. Open a signal box lists the boxes on the active layout. Moving it clears its track on the layout it leaves.'
          : 'No layouts yet. Create one in the layout configurator, then put this box on it.',
      ),
    ),
    (() => {
      const lay = layoutOfBox(st, box);
      if (!lay) return null;
      const worked = placesWorkedBy(st, box.id);
      return h(
        'div',
        { class: 'bc-places' },
        h('p', { class: 'help' }, worked.length ? `Works ${worked.map((p) => p.name).join(', ')}: arriving trains are put on their roads.` : `Works no place (e.g. a junction box): arriving trains stand at the box.`),
        h('button', { class: 'btn small', type: 'button', on: { click: () => ctx.goFrom(`plan/${lay.id}/places`, { route: `config/${box.id}`, label: `${box.name} configuration` }) } }, 'Places on the layout'),
      );
    })(),
    st.boxes.length > 1
      ? h(
          'div',
          { class: 'row end' },
          confirmButton(`Delete ${box.name} box`, 'Press again to delete', () => {
            disposeBoxRuntime(box.id);
            ctx.store.update((a) => deleteBox(a, box.id));
            toast(`${box.name} box deleted.`);
            ctx.go('boxes');
          }, 'btn danger small'),
        )
      : null,
  );

  // ------------------------------------------------------------ connected boxes
  const slots = layoutShelf(box);
  const connCase = (c: ConnectionDef) => {
    const mode = st.settings.workingModes[c.id] ?? c.defaultWorking;
    const pos = slots.findIndex((s) => s?.id === c.id);
    const plate = h('span', { class: 'plate' }, c.neighbourName);
    const places = placesForBox(st, box);
    const cur = places.find((p) => p.id === c.placeId);
    const lay = layoutOfBox(st, box);
    return h(
      'article',
      { class: 'config-case conn-case', 'aria-label': `Connection to ${c.neighbourName}` },
      h('div', { class: 'case-head' }, plate, h('span', { class: 'case-sub' }, `${positionLabel(pos, slots.length)} on the shelf`)),
      h(
        'div',
        { class: 'form-grid tight' },
        checkedField(
          `bc_nn_${c.id}`,
          'Name of the box at the other end',
          textInput(c.neighbourName, 40),
          (v) => checkConnName(box, v, c.id),
          (v) => updConn(c.id, (cc) => (cc.neighbourName = v)),
          { help: 'Shown on the instrument nameplate.', onInput: (v, ok) => (plate.textContent = ok ? v.trim() : c.neighbourName), onReject: () => (plate.textContent = c.neighbourName) },
        ),
        checkedField(
          `bc_ns_${c.id}`,
          'Short name',
          textInput(c.neighbourShort, SHORT_NAME_MAX),
          (v) => checkConnShort(box, v, c.id),
          (v) => updConn(c.id, (cc) => (cc.neighbourShort = v.toUpperCase())),
          { help: 'Used on the train describer and in the register, e.g. FY.' },
        ),
        selectField(
          `bc_pos_${c.id}`,
          'Position on the block shelf',
          h(
            'select',
            { on: { change: (e: Event) => updConn(c.id, (_cc, b) => moveConnection(b, c.id, Number((e.target as HTMLSelectElement).value))) } },
            ...slots.map((s, i) => option(String(i), `${positionLabel(i, slots.length)}${s && s.id !== c.id ? ` (swap with ${s.neighbourName})` : ''}`, i === pos)),
          ),
        ),
        selectField(
          `bc_lt_${c.id}`,
          'Line',
          h(
            'select',
            { on: { change: (e: Event) => updConn(c.id, (cc) => (cc.lineType = (e.target as HTMLSelectElement).value as LineType)) } },
            option('single', 'Single line', c.lineType === 'single'),
            option('double', 'Double line', c.lineType === 'double'),
          ),
          'On a single line, only one train may be in the section in either direction.',
        ),
        selectField(
          `bc_wm_${c.id}`,
          'Working',
          h(
            'select',
            { on: { change: (e: Event) => ctx.store.update((a) => { a.settings.workingModes[c.id] = (e.target as HTMLSelectElement).value as WorkingMode; }) } },
            option('ab', 'Absolute block (simplified)', mode === 'ab'),
            option('token', 'Electric key token', mode === 'token'),
          ),
          'Absolute block uses one block instrument; key token adds a token instrument (hold the last beat to give a release).',
        ),
        selectField(
          `bc_place_${c.id}`,
          'Trains run to and from',
          h(
            'select',
            {
              disabled: !lay,
              on: {
                change: (e: Event) => {
                  disposeBoxRuntime(box.id);
                  updConn(c.id, (cc, b, a) => setConnectionPlace(a, b, cc, (e.target as HTMLSelectElement).value));
                },
              },
            },
            option('', 'No place: trains come from, and go back to, the roster', !cur),
            ...PLACE_KINDS.map((k) => ({ k, ps: places.filter((p) => p.kind === k.kind) }))
              .filter((g) => g.ps.length)
              .map((g) => h('optgroup', { label: g.k.plural }, ...g.ps.map((p) => option(p.id, p.name, p.id === c.placeId)))),
          ),
          !lay
            ? `Put ${box.name} on a layout to choose a place: a fiddle yard, or a station or sidings worked by ${c.neighbourName}.`
            : cur
              ? `Trains offered by ${c.neighbourName} come from ${cur.name}${cur.kind === 'fiddleYard' ? '' : ` (${kindInfo(cur.kind).name.toLowerCase()})`}, and trains sent to it arrive there. Places are set up in the layout configurator (Places).`
              : places.length
                ? `Choose the fiddle yard, or the place on ${lay.name} that ${c.neighbourName} works. Places are set up in the layout configurator (Places).`
                : `${lay.name} has no places yet. Add a fiddle yard or station in the layout configurator (Places).`,
        ),
      ),
      h(
        'div',
        { class: 'row end' },
        confirmButton('Remove connection', 'Press again to remove', () => {
          disposeBoxRuntime(box.id);
          ctx.store.update((a) => removeConnection(a, box.id, c.id));
          toast(`${c.neighbourName} removed from ${box.name}.`);
        }, 'btn danger small'),
      ),
    );
  };

  const shelfFull = box.connections.length >= MAX_SHELF_POSITIONS;
  const willGrow = !shelfFull && !slots.includes(null);
  const addTile = h(
    'button',
    {
      class: 'add-tile',
      type: 'button',
      id: 'bc_add_conn',
      disabled: shelfFull,
      on: {
        click: () => {
          let added: ConnectionDef | null = null;
          disposeBoxRuntime(box.id);
          updBox((b, a) => (added = addConnection(a, b)));
          if (added) toast(willGrow ? `Connection added. The shelf now has ${box.shelfPositions} positions.` : 'Connection added. Give it a name.');
          window.setTimeout(() => {
            const id = added ? `bc_nn_${(added as ConnectionDef).id}` : '';
            const el = id ? (document.getElementById(id) as HTMLInputElement | null) : null;
            el?.focus();
            el?.select();
          }, 0);
        },
      },
    },
    plusIcon(),
    h('span', { class: 'mi-label' }, 'Add a connected signal box'),
    h(
      'span',
      { class: 'mi-sub' },
      shelfFull
        ? `The shelf is full (${MAX_SHELF_POSITIONS} positions).`
        : willGrow
          ? 'The shelf is full, so it will gain a position.'
          : 'Its instruments go in the first free shelf position.',
    ),
  );

  const tabs =
    st.boxes.length > 1
      ? h(
          'nav',
          { class: 'config-tabs', 'aria-label': 'Signal box to configure' },
          ...st.boxes.map((b) =>
            h(
              'button',
              { class: 'btn small side-tab', type: 'button', 'aria-selected': String(b.id === box.id), 'aria-current': b.id === box.id ? 'page' : undefined, on: { click: () => ctx.go(`config/${b.id}`) } },
              b.name,
            ),
          ),
        )
      : null;

  return {
    title: 'Box configurator',
    el: h(
      'main',
      { class: 'page config-page' },
      topBar(ctx, 'Box configurator'),
      tabs,
      h('p', { class: 'muted' }, 'Set up the signal box and the boxes it works with. Adding or removing a connection closes the box; other changes take effect the next time it is opened.'),
      h(
        'div',
        { class: 'config-shelf' },
        boxCase,
        h('h3', { class: 'shelf-label' }, 'Connected signal boxes'),
        h('div', { class: 'conn-grid' }, ...box.connections.slice().sort((a, b) => slots.indexOf(a) - slots.indexOf(b)).map(connCase), addTile),
      ),
    ),
  };
}

/** A + in a brass roundel, for "add" tiles. */
export function plusIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('class', 'plus-icon');
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', '24');
  circle.setAttribute('cy', '24');
  circle.setAttribute('r', '22');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M24 13v22M13 24h22');
  svg.append(circle, path);
  return svg;
}
