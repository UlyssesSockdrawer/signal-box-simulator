import { BellPlayer } from '../audio/bell';
import type { Store } from '../core/store';
import { addBox, canOpenBox } from '../core/boxes';
import { activeLayout, findLayout, setActiveLayout, unassignedBoxes } from '../core/layouts';
import { layoutOfPlace, placeLocationText } from '../core/places';
import type { AppState, BoxDef, Loco } from '../core/types';
import { h, replace, safeRerender, toast } from './dom';
import { boxScreen } from './screens/box';
import { openBox } from './openBox';
import { boxConfigScreen, plusIcon } from './screens/boxConfig';
import { helpScreen } from './screens/help';
import { layoutScreen } from './screens/layout';
import { rosterScreen } from './screens/roster';
import { settingsScreen } from './screens/settings';
import { layoutListScreen, layoutMenuSummary, moveBoxToLayout } from './screens/layouts';
import { trackPlanScreen } from './screens/trackPlan';
import { tutorialScreen } from './screens/tutorial';
import { timetableListScreen, timetableScreen, timetablesMenuSummary } from './screens/timetables';
import { generateScreen } from './screens/timetableGenerate';
import { findTimetable } from '../core/timetables';
import { applyTheme } from './theme';

export const APP_VERSION = '0.3.37';

export interface Ctx {
  store: Store;
  bell: BellPlayer;
  go(route: string): void;
  /** Go to a screen whose back button should return to `back` (e.g. Settings opened from a box). */
  goFrom(route: string, back: { route: string; label: string }): void;
  /** Where the current screen's back button returns to, if not the main menu. */
  returnTo: { route: string; label: string } | null;
  /** Register cleanup for the current screen (called when navigating away). */
  onLeave(fn: () => void): void;
}

export interface Screen {
  title: string;
  el: HTMLElement;
  /** Screens that manage their own updates (the signal box) don't get re-rendered on store changes. */
  live?: boolean;
}

export function locoName(l: Loco | undefined): string {
  if (!l) return '—';
  return [l.number, l.name].filter(Boolean).join(' ') || '(unnamed)';
}

/** Running number, class and name, e.g. 5047 Black 5, or 7812 GWR Manor 4-6-0 "Erlestoke Manor". */
export function locoFullName(l: Loco | undefined): string {
  if (!l) return '—';
  const s = [l.number, l.locoClass].filter(Boolean).join(' ');
  return (s + (l.name ? ` “${l.name}”` : '')).trim() || '(unnamed)';
}

export function trainTypeName(state: AppState, id: string): string {
  return state.trainTypes.find((t) => t.id === id)?.name ?? id;
}

export function activeCodeSet(state: AppState) {
  return state.codeSets.find((c) => c.id === state.settings.codeSetId) ?? state.codeSets[0];
}

export function locationText(state: AppState, l: Loco): string {
  const loc = l.location;
  // Name the layout when the loco is on one other than the active layout.
  const elsewhere = (layoutId: string | undefined) => {
    const lay = findLayout(state, layoutId);
    return lay && lay.id !== activeLayout(state)?.id ? `${lay.name}: ` : '';
  };
  if (loc.kind === 'place') return `${elsewhere(layoutOfPlace(state, loc.placeId)?.id)}${placeLocationText(state, loc)}`;
  if (loc.kind === 'atBox') {
    const box = state.boxes.find((b) => b.id === loc.boxId);
    return `${elsewhere(box?.layoutId)}At ${box?.name ?? 'a signal box'}`;
  }
  if (loc.kind === 'section') return 'In section';
  return 'Off layout';
}

export function topBar(ctx: Ctx, title: string, extra: HTMLElement | null = null): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    ctx.returnTo
      ? h('button', { class: 'btn ghost back', type: 'button', on: { click: () => ctx.go(ctx.returnTo!.route) } }, `‹ Back to ${ctx.returnTo.label}`)
      : h('button', { class: 'btn ghost back', type: 'button', on: { click: () => ctx.go('menu') }, 'aria-label': 'Back to main menu' }, '‹ Menu'),
    h('h1', { class: 'nameboard page-board' }, title),
    extra,
  );
}

function menuScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const item = (route: string, label: string, sub: string, primary = false) =>
    h(
      'button',
      { class: `menu-item${primary ? ' primary' : ''}`, type: 'button', on: { click: () => ctx.go(route) } },
      h('span', { class: 'mi-label' }, label),
      sub ? h('span', { class: 'mi-sub' }, sub) : null,
    );
  const active = activeLayout(st);
  const placeIds = new Set((active?.places ?? []).map((p) => p.id));
  const boxIds = new Set(st.boxes.filter((b) => (active && b.layoutId === active.id) || !findLayout(st, b.layoutId)).map((b) => b.id));
  const onLayout = st.roster.filter((l) => (l.location.kind === 'place' && placeIds.has(l.location.placeId)) || (l.location.kind === 'atBox' && boxIds.has(l.location.boxId))).length;
  const nPlaces = active?.places.length ?? 0;
  return {
    title: 'Main menu',
    el: h(
      'main',
      { class: 'menu' },
      h(
        'div',
        { class: 'splash' },
        h('h1', { class: 'nameboard splash-board' }, 'Signal Box Simulator'),
        h('p', { class: 'splash-sub' }, 'A signal box simulator for your model railway'),
        active ? h('p', { class: 'nameboard splash-layout' }, active.name) : null,
      ),
      h(
        'nav',
        { class: 'menu-grid menu-shelf', 'aria-label': 'Main menu' },
        item('boxes', 'Open a signal box', '', true),
        item('config', 'Box configurator', 'Each box, its shelf and the boxes it is connected to'),
        item('plan', 'Layout configurator', layoutMenuSummary(st)),
        item('roster', 'Locomotive roster', `${st.roster.length} locomotives`),
        item('timetables', 'Timetables', timetablesMenuSummary(st)),
        item('layout', 'Trains in places', `${onLayout} ${onLayout === 1 ? 'train' : 'trains'} in ${nPlaces} ${nPlaces === 1 ? 'place' : 'places'}${active ? ` on ${active.name}` : ''}`),
        item('tutorial', 'Tutorial', 'Absolute block, bell codes and signals, step by step'),
        item('help', 'Bell code reference', activeCodeSet(st).name),
        item('settings', 'Settings', `${st.settings.strictness === 'learner' ? 'Learner' : 'Strict'} mode`),
      ),
      h('p', { class: 'version' }, `Version ${APP_VERSION}`),
    ),
  };
}

function boxSelectScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const active = activeLayout(st);
  const configure = (id: string) => ctx.goFrom(`config/${id}`, { route: 'boxes', label: 'signal boxes' });
  const boxTile = (b: BoxDef, unassigned = false) => {
    const openable = canOpenBox(b);
    return h(
      'article',
      { class: `box-tile${unassigned ? ' unassigned' : ''}`, 'aria-labelledby': `bt_${b.id}` },
      h('h2', { class: 'nameboard box-card-board', id: `bt_${b.id}` }, b.name),
      unassigned ? h('p', { class: 'unassigned-tag' }, 'Not on a layout') : null,
      b.description ? h('p', { class: 'bt-desc' }, b.description) : null,
      openable
        ? h(
            'ul',
            { class: 'plain bt-conns' },
            ...b.connections.map((c) => {
              const mode = st.settings.workingModes[c.id] ?? c.defaultWorking;
              return h('li', null, `To ${c.neighbourName}: ${c.lineType} line, `, h('strong', null, mode === 'token' ? 'electric key token' : 'simplified absolute block'));
            }),
          )
        : h('p', { class: 'bt-desc' }, 'Not connected to any other signal box yet. Configure it to add one before it can be opened.'),
      h(
        'div',
        { class: 'row bt-actions' },
        openable ? h('button', { class: 'btn primary', type: 'button', on: { click: () => openBox(ctx, b) } }, `Open ${b.name} box`) : null,
        h('button', { class: openable ? 'btn' : 'btn primary', type: 'button', on: { click: () => configure(b.id) } }, 'Configure'),
        unassigned && active
          ? h(
              'button',
              {
                class: 'btn',
                type: 'button',
                on: {
                  click: () => moveBoxToLayout(ctx, b.id, active.id),
                },
              },
              `Put on ${active.name}`,
            )
          : null,
      ),
    );
  };
  const addTile = h(
    'button',
    {
      class: 'add-tile box-add',
      type: 'button',
      id: 'add_box',
      on: {
        click: () => {
          let id = '';
          ctx.store.update((a) => (id = addBox(a, active?.id ?? '').id));
          configure(id);
        },
      },
    },
    plusIcon(),
    h('span', { class: 'mi-label' }, 'Add a signal box'),
    h('span', { class: 'mi-sub' }, active ? `A new box on ${active.name} for you to work. Set it up in the box configurator.` : 'A new box for you to work. Set it up in the box configurator.'),
  );

  // The active layout's boxes; boxes not on any layout in their own group (they can still be opened);
  // boxes on other layouts are left out, with a note.
  const onActive = active ? st.boxes.filter((b) => b.layoutId === active.id) : [];
  const loose = unassignedBoxes(st);
  const elsewhere = st.boxes.filter((b) => !onActive.includes(b) && !loose.includes(b));
  const switcher = st.layouts.length > 1
    ? h(
        'div',
        { class: 'field layout-switch' },
        h('label', { for: 'bs_layout' }, 'Active layout'),
        h(
          'select',
          {
            id: 'bs_layout',
            on: {
              change: (e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                ctx.store.update((a) => setActiveLayout(a, v));
              },
            },
          },
          ...st.layouts.map((l) => h('option', { value: l.id, selected: l.id === active?.id }, l.name)),
        ),
      )
    : null;
  const sections: Array<HTMLElement | null> = [];
  if (active) {
    sections.push(
      h(
        'nav',
        { class: 'menu-shelf box-shelf', 'aria-label': `Signal boxes on ${active.name}` },
        h('h2', { class: 'nameboard section-board box-group-board' }, active.name),
        switcher,
        onActive.length ? null : h('p', { class: 'bt-desc box-group-note' }, `No signal boxes are on ${active.name} yet. Add one, or put an existing box on it.`),
        ...onActive.map((b) => boxTile(b)),
        addTile,
      ),
    );
  }
  if (loose.length || !active) {
    sections.push(
      h(
        'section',
        { class: 'menu-shelf box-shelf box-group-loose', 'aria-label': 'Signal boxes not on a layout' },
        h('h2', { class: 'nameboard section-board box-group-board' }, 'Not on a layout'),
        h(
          'p',
          { class: 'bt-desc box-group-note' },
          active
            ? 'These boxes are not on any layout yet. You can still open them, or put them on a layout.'
            : 'No layout is set up yet, so every box is listed here. You can open a box without one; create a layout in the layout configurator when you are ready.',
        ),
        ...loose.map((b) => boxTile(b, !!active || st.layouts.length > 0)),
        active ? null : addTile,
      ),
    );
  }
  if (elsewhere.length) {
    sections.push(
      h(
        'p',
        { class: 'muted box-elsewhere' },
        `${elsewhere.length === 1 ? '1 box is' : `${elsewhere.length} boxes are`} on other layouts: ${elsewhere.map((b) => `${b.name} (${findLayout(st, b.layoutId)?.name})`).join(', ')}. Change the active layout to work ${elsewhere.length === 1 ? 'it' : 'them'}.`,
      ),
    );
  }
  return {
    title: 'Signal boxes',
    el: h('main', { class: 'page' }, topBar(ctx, 'Choose a signal box'), ...sections),
  };
}

export function startApp(root: HTMLElement, store: Store): void {
  const bell = new BellPlayer(() => store.state.settings);
  let leaveFns: Array<() => void> = [];
  let current: Screen | null = null;

  const unlock = () => bell.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  applyTheme(store.state.settings.theme);
  let lastTheme = store.state.settings.theme;
  store.subscribe((st) => {
    if (st.settings.theme !== lastTheme) {
      lastTheme = st.settings.theme;
      applyTheme(lastTheme);
    }
  });

  const ctx: Ctx = {
    store,
    bell,
    returnTo: null,
    go: (route) => {
      if (location.hash.slice(1) === route) render();
      else location.hash = route;
    },
    goFrom: (route, back) => {
      ctx.returnTo = back;
      ctx.go(route);
    },
    onLeave: (fn) => leaveFns.push(fn),
  };

  const render = () => {
    for (const fn of leaveFns) fn();
    leaveFns = [];
    const route = location.hash.replace(/^#/, '') || 'menu';
    const [name, arg] = route.split('/');
    // A "back to…" link only lasts until you return to it, or go home.
    if (name === 'menu' || name === 'box' || (ctx.returnTo && route === ctx.returnTo.route)) ctx.returnTo = null;
    let screen: Screen;
    switch (name) {
      case 'boxes':
        screen = boxSelectScreen(ctx);
        break;
      case 'box': {
        const box = store.state.boxes.find((b) => b.id === arg) ?? store.state.boxes[0];
        if (!canOpenBox(box)) {
          // A box with nothing to signal to cannot be opened: send the user to set it up.
          toast(`${box.name} is not connected to any other signal box yet.`);
          ctx.returnTo = { route: 'boxes', label: 'signal boxes' };
          history.replaceState(null, '', `#config/${box.id}`);
          screen = boxConfigScreen(ctx, box.id);
          break;
        }
        screen = boxScreen(ctx, box);
        break;
      }
      case 'roster':
        screen = rosterScreen(ctx);
        break;
      case 'layout':
        screen = layoutScreen(ctx);
        break;
      case 'settings':
        screen = settingsScreen(ctx);
        break;
      case 'config':
        screen = boxConfigScreen(ctx, arg);
        break;
      case 'plan': {
        // The layout configurator opens on the list of layouts (or a prompt to create the first).
        const layout = findLayout(store.state, arg);
        if (!layout) {
          if (arg) history.replaceState(null, '', '#plan');
          screen = layoutListScreen(ctx);
          break;
        }
        {
          const t = route.split('/')[2];
          screen = trackPlanScreen(ctx, layout.id, t === 'details' || t === 'places' || t === 'signals' ? t : undefined);
        }
        break;
      }
      case 'timetables':
        screen = timetableListScreen(ctx);
        break;
      case 'tt': {
        // A timetable's editor: #tt/<id>[/poster|cards|settings].
        if (!findTimetable(store.state, arg)) {
          history.replaceState(null, '', '#timetables');
          screen = timetableListScreen(ctx);
          break;
        }
        const t = route.split('/')[2];
        screen = timetableScreen(ctx, arg, t === 'poster' || t === 'cards' || t === 'settings' ? t : 'moves');
        break;
      }
      case 'ttgen':
        // Generate a timetable: #ttgen, or #ttgen/<id> to generate a timetable again.
        if (arg && !findTimetable(store.state, arg)) history.replaceState(null, '', '#ttgen');
        screen = generateScreen(ctx, arg && findTimetable(store.state, arg) ? arg : '');
        break;
      case 'help':
        screen = helpScreen(ctx);
        break;
      case 'tutorial':
        screen = tutorialScreen(ctx, arg);
        break;
      default:
        screen = menuScreen(ctx);
    }
    current = screen;
    document.title = screen.title === 'Main menu' ? 'Signal Box Simulator' : `${screen.title} · Signal Box Simulator`;
    replace(root, screen.el);
    window.scrollTo(0, 0);
  };

  // Re-render passive screens when data changes (but keep focus/scroll where possible).
  // Deferred until focus has moved on, so Tab goes to the next field rather than back to the top.
  const rerender = safeRerender(() => root, () => {
    if (current && !current.live) render();
  });
  store.subscribe(() => {
    if (current && !current.live) rerender();
  });

  window.addEventListener('hashchange', render);
  render();
}
