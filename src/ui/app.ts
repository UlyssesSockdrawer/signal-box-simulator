import { BellPlayer } from '../audio/bell';
import type { Store } from '../core/store';
import { addBox, canOpenBox } from '../core/boxes';
import type { AppState, BoxDef, Loco } from '../core/types';
import { h, replace, safeRerender, toast } from './dom';
import { boxScreen } from './screens/box';
import { boxConfigScreen, plusIcon } from './screens/boxConfig';
import { helpScreen } from './screens/help';
import { layoutScreen } from './screens/layout';
import { rosterScreen } from './screens/roster';
import { settingsScreen } from './screens/settings';
import { trackPlanScreen, trackPlanSummary } from './screens/trackPlan';
import { tutorialScreen } from './screens/tutorial';
import { applyTheme } from './theme';

export const APP_VERSION = '0.3.11';

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
  if (loc.kind === 'fiddleYard') {
    const yard = state.fiddleYards.find((y) => y.id === loc.yardId);
    const road = yard?.roads.find((r) => r.id === loc.roadId);
    return `${yard?.name ?? 'Fiddle yard'}, ${road?.name ?? loc.roadId}`;
  }
  if (loc.kind === 'station') {
    const box = state.boxes.find((b) => b.id === loc.boxId);
    return `${box?.name ?? loc.boxId} station${loc.note ? ` (${loc.note})` : ''}`;
  }
  if (loc.kind === 'farBox') {
    const conn = state.boxes.find((b) => b.id === loc.boxId)?.connections.find((c) => c.id === loc.connectionId);
    return `At ${conn?.neighbourName ?? 'another box'}${loc.note ? ` (${loc.note})` : ''}`;
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
  const fyCount = st.roster.filter((l) => l.location.kind === 'fiddleYard').length;
  const stnCount = st.roster.filter((l) => l.location.kind === 'station').length;
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
        st.settings.layoutName ? h('p', { class: 'nameboard splash-layout' }, st.settings.layoutName) : null,
      ),
      h(
        'nav',
        { class: 'menu-grid menu-shelf', 'aria-label': 'Main menu' },
        item('boxes', 'Open a signal box', '', true),
        item('config', 'Box configurator', 'Each box, its shelf and the boxes it is connected to'),
        item('plan', 'Layout configurator', trackPlanSummary(st)),
        item('roster', 'Locomotive roster', `${st.roster.length} locomotives`),
        item('layout', 'Fiddle yard & station', `${fyCount} in fiddle yard, ${stnCount} in station`),
        item('tutorial', 'Tutorial', 'Absolute block and bell codes, step by step'),
        item('help', 'Bell code reference', activeCodeSet(st).name),
        item('settings', 'Settings', `${st.settings.strictness === 'learner' ? 'Learner' : 'Strict'} mode`),
      ),
      h('p', { class: 'version' }, `Version ${APP_VERSION}`),
    ),
  };
}

function boxSelectScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const configure = (id: string) => ctx.goFrom(`config/${id}`, { route: 'boxes', label: 'signal boxes' });
  const boxTile = (b: BoxDef) => {
    const openable = canOpenBox(b);
    return h(
      'article',
      { class: 'box-tile', 'aria-labelledby': `bt_${b.id}` },
      h('h2', { class: 'nameboard box-card-board', id: `bt_${b.id}` }, b.name),
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
        openable ? h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.go(`box/${b.id}`) } }, `Open ${b.name} box`) : null,
        h('button', { class: openable ? 'btn' : 'btn primary', type: 'button', on: { click: () => configure(b.id) } }, 'Configure'),
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
          ctx.store.update((a) => (id = addBox(a).id));
          configure(id);
        },
      },
    },
    plusIcon(),
    h('span', { class: 'mi-label' }, 'Add a signal box'),
    h('span', { class: 'mi-sub' }, 'A new box for you to work. Set it up in the box configurator.'),
  );
  return {
    title: 'Signal boxes',
    el: h(
      'main',
      { class: 'page' },
      topBar(ctx, 'Choose a signal box'),
      h('nav', { class: 'menu-shelf box-shelf', 'aria-label': 'Signal boxes' }, ...st.boxes.map(boxTile), addTile),
    ),
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
      case 'plan':
        screen = trackPlanScreen(ctx);
        break;
      case 'help':
        screen = helpScreen(ctx);
        break;
      case 'tutorial':
        screen = tutorialScreen(ctx);
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
