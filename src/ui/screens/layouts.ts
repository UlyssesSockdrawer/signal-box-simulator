import { addBox } from '../../core/boxes';
import {
  activeLayout,
  addLayout,
  addYard,
  boxesOn,
  checkLayoutName,
  checkYardName,
  deleteLayout,
  findLayout,
  MAX_ROADS,
  MAX_YARDS,
  moveBoxImpact,
  removeYard,
  setActiveLayout,
  setBoxLayout,
  setYardRoadCount,
  trainsBeyondRoad,
  yardOccupants,
  type PlanUsage,
} from '../../core/layouts';
import type { AppState, FiddleYard, Layout, Loco } from '../../core/types';
import { locoFullName, topBar, type Ctx, type Screen } from '../app';
import { disposeBoxRuntime } from '../boxRuntime';
import { confirmButton, confirmDialog, h, toast } from '../dom';
import { plusIcon } from './boxConfig';

/*
 * Layouts: the layout configurator opens on a list of the layouts set up in the
 * app (or a prompt to create the first one). Each layout's Details tab holds its
 * name, whether it is the active layout, its signal boxes and its fiddle yards.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function planCounts(l: Layout): string {
  const p = l.trackPlan;
  const n = p.junctions.filter((j) => j.kind !== 'joint').length;
  return p.circuits.length ? `${plural(p.circuits.length, 'track circuit')}, ${plural(n, 'junction')}` : 'No track plan yet';
}

/** One line for the main menu's Layout configurator item. */
export function layoutMenuSummary(state: AppState): string {
  const a = activeLayout(state);
  if (!a) return 'Create a layout: its track plan, fiddle yards and signal boxes';
  const others = state.layouts.length - 1;
  return `${a.name}: ${planCounts(a).replace('No track plan yet', 'no track plan yet')}${others > 0 ? ` · ${plural(others, 'other layout')}` : ''}`;
}

const yardText = (y: FiddleYard) => `${y.name} (${plural(y.roads.length, 'road')})`;

const usageText = (u: PlanUsage) =>
  [
    u.circuits ? plural(u.circuits, 'track circuit') : '',
    u.junctions ? `${plural(u.junctions, 'junction')} (points, crossings and so on)` : '',
    u.exits ? plural(u.exits, 'exit') + ' leading to its lines' : '',
    u.markers ? `its signal box${u.markers === 1 ? '' : 'es'} on the plan` : '',
  ]
    .filter(Boolean)
    .join(', ');

/**
 * Move a box to another layout ('' = none). Its track assignments on the layout it leaves are
 * wiped, so when it has any the user is warned and asked to confirm first. `onCancel` lets the
 * caller put its control (select, tick box) back.
 */
export function moveBoxToLayout(ctx: Ctx, boxId: string, layoutId: string, onCancel?: () => void): void {
  const st = ctx.store.state;
  const box = st.boxes.find((b) => b.id === boxId);
  if (!box || box.layoutId === layoutId) return;
  const to = findLayout(st, layoutId);
  const go = () => {
    disposeBoxRuntime(boxId);
    ctx.store.update((a) => setBoxLayout(a, boxId, layoutId));
    toast(to ? `${box.name} is now on ${to.name}.` : `${box.name} is not on a layout now.`);
  };
  const impact = moveBoxImpact(st, boxId, layoutId);
  if (!impact.length) return go();
  confirmDialog({
    title: to ? `Move ${box.name} to ${to.name}?` : `Take ${box.name} off its layout?`,
    body: [
      `${box.name} has track on ${impact.map((x) => x.layout.name).join(' and ')}. Moving it clears all of it: the track and points become unassigned, and this cannot be undone.`,
      h('ul', null, ...impact.map((x) => h('li', null, `${x.layout.name}: ${usageText(x.usage)}`))),
      'This includes track given to the line to its connected boxes and to the connected boxes themselves.',
    ],
    confirmLabel: 'Move and clear its track',
    onDone: (ok) => (ok ? go() : onCancel?.()),
  });
}

/** Ask before sending trains off the layout (back to the roster), naming them. */
export function confirmTrainsOff(trains: Loco[], title: string, what: string, confirmLabel: string, run: () => void, onCancel?: () => void): void {
  if (!trains.length) return run();
  confirmDialog({
    title,
    body: [
      `${plural(trains.length, 'train')} ${trains.length === 1 ? 'is' : 'are'} standing ${what}. ${trains.length === 1 ? 'It goes' : 'They go'} off the layout and stay${trains.length === 1 ? 's' : ''} in the roster:`,
      h('ul', null, ...trains.map((l) => h('li', null, locoFullName(l)))),
    ],
    confirmLabel,
    onDone: (ok) => (ok ? run() : onCancel?.()),
  });
}

/** Route for a layout in the editor. `tab` = 'details' opens its Details tab first. */
export const layoutRoute = (id: string, tab?: 'details') => `plan/${id}${tab ? `/${tab}` : ''}`;

export function layoutListScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const active = activeLayout(st);

  const tile = (l: Layout) => {
    const isActive = l.id === active?.id;
    const boxes = boxesOn(st, l.id);
    return h(
      'article',
      { class: `box-tile layout-tile${isActive ? ' is-active' : ''}`, 'aria-labelledby': `lt_${l.id}` },
      h('h2', { class: 'nameboard box-card-board', id: `lt_${l.id}` }, l.name),
      isActive ? h('p', { class: 'active-tag' }, 'Active layout') : null,
      h(
        'ul',
        { class: 'plain bt-conns' },
        h('li', null, h('strong', null, 'Signal boxes: '), boxes.length ? boxes.map((b) => b.name).join(', ') : 'none yet'),
        h('li', null, h('strong', null, 'Fiddle yards: '), l.fiddleYards.length ? l.fiddleYards.map(yardText).join(', ') : 'none'),
        h('li', null, h('strong', null, 'Track plan: '), planCounts(l)),
      ),
      h(
        'div',
        { class: 'row bt-actions' },
        h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.go(layoutRoute(l.id)) } }, 'Open layout'),
        isActive
          ? null
          : h(
              'button',
              {
                class: 'btn',
                type: 'button',
                on: {
                  click: () => {
                    ctx.store.update((a) => setActiveLayout(a, l.id));
                    toast(`${l.name} is now the active layout.`);
                  },
                },
              },
              'Make active',
            ),
      ),
    );
  };

  const addTile = h(
    'button',
    {
      class: 'add-tile box-add',
      type: 'button',
      id: 'add_layout',
      on: {
        click: () => {
          let id = '';
          ctx.store.update((a) => (id = addLayout(a).id));
          ctx.go(layoutRoute(id, 'details'));
        },
      },
    },
    plusIcon(),
    h('span', { class: 'mi-label' }, st.layouts.length ? 'Create a new layout' : 'Create your first layout'),
    h('span', { class: 'mi-sub' }, 'Name it, set up its fiddle yards and signal boxes, then draw its track plan.'),
  );

  return {
    title: 'Layouts',
    el: h(
      'main',
      { class: 'page' },
      topBar(ctx, 'Layout configurator'),
      h(
        'p',
        { class: 'muted layout-intro' },
        st.layouts.length
          ? 'Open a layout to work on it, or create a new one. The active layout decides which signal boxes Open a signal box offers.'
          : 'There are no layouts yet. A layout has its own track plan, fiddle yards and signal boxes. Your locomotive roster is shared by every layout.',
      ),
      h('nav', { class: 'menu-shelf box-shelf', 'aria-label': 'Layouts' }, ...st.layouts.map(tile), addTile),
    ),
  };
}

/** The Details tab: name, active, signal boxes and fiddle yards of one layout. */
export function layoutDetails(ctx: Ctx, layoutId: string): HTMLElement {
  const st = ctx.store.state;
  const layout = findLayout(st, layoutId)!;
  const isActive = activeLayout(st)?.id === layout.id;
  const upd = (fn: (l: Layout, a: AppState) => void) =>
    ctx.store.update((a) => {
      const l = findLayout(a, layout.id);
      if (l) fn(l, a);
    });

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

  // ---------------------------------------------------------------- the layout
  const board = h('h2', { class: 'nameboard section-board', id: 'ld_board' }, layout.name);
  const layoutCase = h(
    'article',
    { class: 'config-case', 'aria-labelledby': 'ld_board' },
    h('div', { class: 'panel-head' }, board, isActive ? h('span', { class: 'active-tag' }, 'Active layout') : null),
    h(
      'div',
      { class: 'form-grid tight' },
      checked('ld_name', 'Layout name', layout.name, 60, (v) => checkLayoutName(ctx.store.state, v, layout.id), (v) => upd((l) => (l.name = v)), 'Shown on the main menu while this layout is active.', (v, ok) => (board.textContent = ok ? v.trim() : layout.name)),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', id: 'ld_running_l' }, 'Double lines: trains keep to the'),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-labelledby': 'ld_running_l' },
          ...(['left', 'right'] as const).map((side) => {
            const on = (layout.running ?? 'left') === side;
            return h(
              'button',
              { class: 'btn small', type: 'button', 'aria-pressed': String(on), on: { click: () => !on && upd((l) => (l.running = side)) } },
              side === 'left' ? 'Left (British)' : 'Right',
            );
          }),
        ),
        h('small', { class: 'help' }, 'Used by Double line on a track circuit to set which way the up and down lines run. Lines already set are not changed.'),
      ),
    ),
    isActive
      ? h('p', { class: 'help' }, 'This is the active layout: Open a signal box offers its boxes, and its name is on the main menu.')
      : h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              on: {
                click: () => {
                  ctx.store.update((a) => setActiveLayout(a, layout.id));
                  toast(`${layout.name} is now the active layout.`);
                },
              },
            },
            'Make this the active layout',
          ),
        ),
    h(
      'div',
      { class: 'row end' },
      confirmButton('Delete this layout', 'Press again to delete it', () => {
        for (const b of boxesOn(ctx.store.state, layout.id)) disposeBoxRuntime(b.id);
        ctx.store.update((a) => deleteLayout(a, layout.id));
        toast(`${layout.name} deleted. Its signal boxes are kept, not on a layout.`);
        ctx.go('plan');
      }, 'btn danger small'),
    ),
  );

  // ---------------------------------------------------------------- signal boxes
  const boxRow = (b: AppState['boxes'][number]) => {
    const on = b.layoutId === layout.id;
    const elsewhere = !on ? findLayout(st, b.layoutId) : undefined;
    const id = `ld_box_${b.id}`;
    return h(
      'li',
      { class: 'ld-box' },
      h(
        'label',
        { class: 'check', for: id },
        h('input', {
          id,
          type: 'checkbox',
          checked: on,
          on: {
            change: (e: Event) => {
              const input = e.target as HTMLInputElement;
              const yes = input.checked;
              moveBoxToLayout(ctx, b.id, yes ? layout.id : '', () => (input.checked = !yes));
            },
          },
        }),
        h('span', null, h('strong', null, b.name), elsewhere ? h('small', { class: 'help' }, ` · on ${elsewhere.name} (ticking moves it here and clears its track there)`) : !on ? h('small', { class: 'help' }, ' · not on a layout') : null),
      ),
      h('button', { class: 'btn small', type: 'button', on: { click: () => ctx.goFrom(`config/${b.id}`, { route: layoutRoute(layout.id, 'details'), label: layout.name }) } }, 'Configure'),
    );
  };
  const addBoxTile = h(
    'button',
    {
      class: 'add-tile ld-add',
      type: 'button',
      id: 'ld_add_box',
      on: {
        click: () => {
          let id = '';
          ctx.store.update((a) => (id = addBox(a, layout.id).id));
          ctx.goFrom(`config/${id}`, { route: layoutRoute(layout.id, 'details'), label: layout.name });
        },
      },
    },
    plusIcon(),
    h('span', { class: 'mi-label' }, 'Add a signal box'),
    h('span', { class: 'mi-sub' }, `A new box on ${layout.name}. Set it up in the box configurator.`),
  );
  const boxesCase = h(
    'article',
    { class: 'config-case' },
    h('span', { class: 'plate' }, 'Signal boxes'),
    h('p', { class: 'help' }, "Tick the boxes that stand on this layout. A box is on one layout at a time: moving it clears its track on the layout it leaves (you are asked first). Their connected boxes (worked by the simulated signaller) come with them."),
    st.boxes.length ? h('ul', { class: 'plain ld-boxes' }, ...st.boxes.map(boxRow)) : null,
    addBoxTile,
  );

  // ---------------------------------------------------------------- fiddle yards
  const yardCase = (y: FiddleYard) => {
    const occ = yardOccupants(st, y.id).length;
    const roadsId = `ld_roads_${y.id}`;
    const roadsErr = h('small', { class: 'field-error', id: `${roadsId}_err`, role: 'alert', hidden: true });
    const roadsInput = h('input', {
      id: roadsId,
      type: 'number',
      min: 1,
      max: MAX_ROADS,
      step: 1,
      inputmode: 'numeric',
      value: y.roads.length,
      'aria-describedby': `${roadsId}_err`,
      on: {
        keydown: (e: KeyboardEvent) => {
          if (['-', '+', 'e', 'E', '.', ','].includes(e.key)) e.preventDefault();
        },
        change: (e: Event) => {
          const input = e.target as HTMLInputElement;
          const n = Number(input.value);
          const apply = () => {
            let err: string | null = null;
            ctx.store.update((a) => (err = setYardRoadCount(a, y.id, n)));
            if (err) {
              roadsErr.textContent = err;
              roadsErr.hidden = false;
              input.value = String(y.roads.length);
              toast(err);
            }
          };
          const lost = Number.isInteger(n) && n >= 1 ? trainsBeyondRoad(ctx.store.state, y.id, n) : [];
          confirmTrainsOff(lost, `Cut ${y.name} to ${plural(n, 'road')}?`, 'on the roads being removed', 'Remove the roads', () => {
            apply();
            if (lost.length) toast(`${plural(lost.length, 'train')} moved off the layout.`);
          }, () => (input.value = String(y.roads.length)));
        },
      },
    });
    return h(
      'div',
      { class: 'ld-yard' },
      h(
        'div',
        { class: 'form-grid tight' },
        checked(`ld_yname_${y.id}`, 'Fiddle yard name', y.name, 40, (v) => checkYardName(layout, v, y.id), (v) => upd((l) => {
          const yy = l.fiddleYards.find((x) => x.id === y.id);
          if (yy) yy.name = v;
        }), 'e.g. Up yard, Down yard'),
        h('div', { class: 'field' }, h('label', { for: roadsId }, 'Roads'), roadsInput, roadsErr, h('small', { class: 'help' }, `1 to ${MAX_ROADS}`)),
      ),
      h('p', { class: 'help' }, `${y.roads.map((r) => r.name).join(' · ')}${occ ? ` — ${plural(occ, 'train')} standing here` : ''}. Rename roads and place trains in Fiddle yard & station.`),
      h(
        'div',
        { class: 'row end' },
        (() => {
          const remove = () => {
            let n = 0;
            ctx.store.update((a) => (n = removeYard(a, y.id)));
            toast(`${y.name} removed.${n ? ` ${plural(n, 'train')} moved off the layout.` : ''}`);
          };
          const trains = yardOccupants(st, y.id);
          return trains.length
            ? h('button', { class: 'btn danger small', type: 'button', on: { click: () => confirmTrainsOff(yardOccupants(ctx.store.state, y.id), `Remove ${y.name}?`, `in ${y.name}`, 'Remove the yard', remove) } }, `Remove ${y.name}`)
            : confirmButton(`Remove ${y.name}`, 'Press again to remove', remove, 'btn danger small');
        })(),
      ),
    );
  };
  const addYardTile = h(
    'button',
    {
      class: 'add-tile ld-add',
      type: 'button',
      id: 'ld_add_yard',
      disabled: layout.fiddleYards.length >= MAX_YARDS,
      on: {
        click: () => {
          let y: FiddleYard | null = null;
          ctx.store.update((a) => (y = addYard(a, layout.id)));
          if (y)
            window.setTimeout(() => {
              const el = document.getElementById(`ld_yname_${(y as FiddleYard).id}`) as HTMLInputElement | null;
              el?.focus();
              el?.select();
            }, 0);
        },
      },
    },
    plusIcon(),
    h('span', { class: 'mi-label' }, 'Add a fiddle yard'),
    h('span', { class: 'mi-sub' }, layout.fiddleYards.length >= MAX_YARDS ? `No more than ${MAX_YARDS} fiddle yards.` : 'Starts with four roads; change the number to suit.'),
  );
  const yardsCase = h(
    'article',
    { class: 'config-case' },
    h('span', { class: 'plate' }, 'Fiddle yards'),
    h('p', { class: 'help' }, `${layout.name} has ${plural(layout.fiddleYards.length, 'fiddle yard')}. For example, an up and a down fiddle yard of four roads each. Connections in the box configurator choose which yard they run to.`),
    ...layout.fiddleYards.map(yardCase),
    addYardTile,
  );

  return h('div', { class: 'ld-grid' }, layoutCase, boxesCase, yardsCase);
}
