import { activeLayout, setActiveLayout } from '../../core/layouts';
import { PLACE_KINDS } from '../../core/places';
import {
  addTimetable,
  addTrain,
  applyStockPositions,
  checkTimetableName,
  checkTrainName,
  deleteTimetable,
  duplicateTimetable,
  ENTRY_KINDS,
  entriesOfTrain,
  entryKindName,
  findTimetable,
  findTrain,
  fmtTime,
  isTimed,
  issuesSummary,
  locosFor,
  MAX_ENTRIES,
  MAX_SPEED,
  MAX_TIMETABLES,
  moveEntry,
  parseTime,
  refShort,
  refText,
  removeEntry,
  removeTrain,
  routeText,
  sortByTime,
  stockPositions,
  thenEntry,
  timetablesOf,
  timingInfo,
  TIMINGS,
  trainLabel,
  trainLoco,
  walkTimetable,
  type TtIssue,
  type TtPos,
  type TtStep,
  type TtWalk,
} from '../../core/timetables';
import type { AppState, Layout, PlaceRef, Timetable, TimetableCall, TimetableEntry, TimetableTiming, TimetableTrain } from '../../core/types';
import { activeCodeSet, locoFullName, locoName, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { confirmButton, confirmDialog, h, option, toast } from '../dom';
import { plusIcon } from './boxConfig';
import { cardsView, posterView } from './timetablePrint';

/*
 * TIMETABLES: the list of a layout's timetables, and the timetable editor. The editor's Moves tab
 * lists every move in order (or train by train), each a mahogany row that opens into its form; a
 * train's next move is added with "+ Then this train…", which starts it where the last one ended.
 * Checks run as you edit (where each loco is after every move), and Step through shows where
 * everything stands after each one. Poster and Train cards are printable views (timetablePrint.ts).
 */

type Tab = 'moves' | 'poster' | 'cards' | 'settings';
type View = 'order' | 'train';

const ui: { view: View; open: string | null; trainOpen: Map<string, boolean>; step: number | null; stockOpen: boolean | null; focus: string } = {
  view: 'order',
  open: null,
  trainOpen: new Map(),
  step: null,
  stockOpen: null,
  focus: '',
};

/** Forget the editor's open rows and step position (e.g. when all data is reset). */
export function resetTimetablesUi(): void {
  ui.view = 'order';
  ui.open = null;
  ui.trainOpen.clear();
  ui.step = null;
  ui.stockOpen = null;
  ui.focus = '';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const ttRoute = (id: string, tab?: Tab) => `tt/${id}${tab && tab !== 'moves' ? `/${tab}` : ''}`;

/** One line about a timetable: "Session clock from 09:00 · 4 trains · 10 moves". */
export function timetableSummary(tt: Timetable): string {
  const timing = tt.timing === 'session' ? (tt.elapsed ? 'Session clock (minutes after the start)' : `Session clock from ${fmtTime(tt.startAt, { timing: 'clock', elapsed: false })}${tt.speed > 1 ? `, fast clock ×${tt.speed}` : ''}`) : timingInfo(tt.timing).name;
  return `${timing} · ${plural(tt.trains.length, 'train')} · ${plural(tt.entries.length, 'move')}`;
}

/** For the main menu. */
export function timetablesMenuSummary(state: AppState): string {
  const a = activeLayout(state);
  if (!a) return 'Create a layout first';
  const n = timetablesOf(a).length;
  return n ? `${plural(n, 'timetable')} for ${a.name}` : `No timetables for ${a.name} yet`;
}

// ====================================================================== list

export function timetableListScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const layout = activeLayout(st);
  const switcher =
    st.layouts.length > 1
      ? h(
          'div',
          { class: 'field layout-switch' },
          h('label', { for: 'tl_layout' }, 'Layout'),
          h('select', { id: 'tl_layout', on: { change: (e: Event) => ctx.store.update((a) => setActiveLayout(a, (e.target as HTMLSelectElement).value)) } }, ...st.layouts.map((l) => option(l.id, l.name, l.id === layout?.id))),
          h('small', { class: 'help' }, 'Choosing a layout here makes it the active layout.'),
        )
      : null;
  if (!layout) {
    return {
      title: 'Timetables',
      el: h(
        'main',
        { class: 'page' },
        topBar(ctx, 'Timetables'),
        h('div', { class: 'menu-shelf box-shelf' }, h('p', { class: 'bt-desc box-group-note' }, 'Timetables belong to a layout: they name its stations, sidings and fiddle yards. Create a layout first.'), h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.go('plan') } }, 'Layout configurator')),
      ),
    };
  }
  const list = timetablesOf(layout);
  const tile = (tt: Timetable) => {
    const w = walkTimetable(st, layout, tt);
    return h(
      'article',
      { class: 'box-tile tt-tile', 'aria-labelledby': `tl_${tt.id}` },
      h('h2', { class: 'nameboard box-card-board', id: `tl_${tt.id}` }, tt.name),
      h('p', { class: 'active-tag tt-timing-tag' }, timingInfo(tt.timing).short),
      h(
        'ul',
        { class: 'plain bt-conns' },
        h('li', null, timetableSummary(tt)),
        tt.trains.length ? h('li', null, h('strong', null, 'Trains: '), tt.trains.map((t) => t.name).join(', ')) : null,
        h('li', { class: w.errors ? 'tt-bad' : '' }, h('strong', null, 'Checks: '), issuesSummary(w)),
      ),
      h(
        'div',
        { class: 'row bt-actions' },
        h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.go(ttRoute(tt.id)) } }, 'Open timetable'),
        h('button', { class: 'btn', type: 'button', on: { click: () => ctx.go(ttRoute(tt.id, 'poster')) } }, 'Poster'),
        h('button', { class: 'btn', type: 'button', on: { click: () => ctx.go(ttRoute(tt.id, 'cards')) } }, 'Train cards'),
      ),
    );
  };
  const full = list.length >= MAX_TIMETABLES;
  const addTile = h(
    'div',
    { class: 'add-tile box-add tt-add', role: 'group', 'aria-labelledby': 'tl_add_l' },
    plusIcon(),
    h('span', { class: 'mi-label', id: 'tl_add_l' }, list.length ? 'Create a timetable' : 'Create your first timetable'),
    h('span', { class: 'mi-sub' }, full ? `No more than ${MAX_TIMETABLES} timetables on a layout.` : 'How should it run?'),
    h(
      'div',
      { class: 'pl-add-kinds' },
      ...TIMINGS.map((t) =>
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            id: `tl_add_${t.timing}`,
            disabled: full,
            title: t.help,
            on: {
              click: () => {
                let id = '';
                ctx.store.update((a) => (id = addTimetable(a, layout.id, t.timing)?.id ?? ''));
                if (id) ctx.go(ttRoute(id, 'settings'));
              },
            },
          },
          t.name,
        ),
      ),
    ),
  );
  return {
    title: 'Timetables',
    el: h(
      'main',
      { class: 'page' },
      topBar(ctx, 'Timetables'),
      h(
        'p',
        { class: 'muted layout-intro' },
        `Timetables for ${layout.name}. Each is a list of moves, train by train: where each train runs, what it runs as, and which loco works it. An operations sequence has no times (each move follows the one before); real-time and session-clock timetables run to the clock.`,
      ),
      h('nav', { class: 'menu-shelf box-shelf', 'aria-label': `Timetables for ${layout.name}` }, h('h2', { class: 'nameboard section-board box-group-board' }, layout.name), switcher, ...list.map(tile), addTile),
    ),
  };
}

// ====================================================================== editor

export function timetableScreen(ctx: Ctx, ttId: string, tab: Tab): Screen {
  const st = ctx.store.state;
  const found = findTimetable(st, ttId)!;
  const layout = found.layout;
  const tt = found.tt;
  // Back goes to the list of timetables (unless the editor was opened from a signal box).
  if (!ctx.returnTo || !ctx.returnTo.route.startsWith('box/')) ctx.returnTo = { route: 'timetables', label: 'timetables' };
  ctx.onLeave(() => {
    if (ctx.returnTo?.route === 'timetables') ctx.returnTo = null;
  });
  /** Change this timetable (the screen is rebuilt from the store afterwards). */
  const upd = (fn: (t: Timetable, l: Layout, a: AppState) => void) =>
    ctx.store.update((a) => {
      const f = findTimetable(a, ttId);
      if (f) fn(f.tt, f.layout, a);
    });

  const tabs = h(
    'nav',
    { class: 'config-tabs', 'aria-label': 'Timetable sections' },
    ...(
      [
        ['moves', 'Moves'],
        ['poster', 'Poster'],
        ['cards', 'Train cards'],
        ['settings', 'Settings'],
      ] as Array<[Tab, string]>
    ).map(([id, label]) =>
      h('button', { class: 'btn small side-tab', type: 'button', 'aria-selected': String(tab === id), 'aria-current': tab === id ? 'page' : undefined, on: { click: () => ctx.go(ttRoute(ttId, id)) } }, label),
    ),
  );
  const top = topBar(ctx, tt.name);
  const body =
    tab === 'poster' ? posterView(ctx, layout, tt) : tab === 'cards' ? cardsView(ctx, layout, tt) : tab === 'settings' ? settingsTab(ctx, layout, tt, upd) : movesTab(ctx, layout, tt, upd);
  const el = h('main', { class: `page config-page tt-page tt-tab-${tab}` }, top, h('p', { class: 'muted tt-sub' }, `${layout.name} · ${timetableSummary(tt)}`), tabs, body);
  if (ui.focus) {
    const id = ui.focus;
    ui.focus = '';
    window.setTimeout(() => {
      const f = document.getElementById(id) as HTMLElement | null;
      f?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      f?.focus({ preventScroll: true });
    }, 0);
  }
  return { title: `${tt.name} · Timetables`, el };
}

type Upd = (fn: (t: Timetable, l: Layout, a: AppState) => void) => void;

// ---------------------------------------------------------------- small controls

/** A text input checked as you type and saved on change when valid. */
function checkedInput(id: string, label: string, value: string, max: number, check: (v: string) => string | null, apply: (v: string) => void, opts: { help?: string; placeholder?: string; onInput?: (v: string, ok: boolean) => void; cls?: string } = {}) {
  const input = h('input', { type: 'text', id, value, maxlength: max, autocomplete: 'off', placeholder: opts.placeholder });
  const err = h('small', { class: 'field-error', id: `${id}_err`, role: 'alert', hidden: true });
  input.setAttribute('aria-describedby', `${id}_err`);
  const show = (msg: string | null) => {
    err.textContent = msg ?? '';
    err.hidden = !msg;
    input.classList.toggle('invalid', !!msg);
  };
  input.addEventListener('input', () => {
    const msg = check(input.value);
    show(msg);
    opts.onInput?.(input.value, !msg);
  });
  input.addEventListener('change', () => {
    const msg = check(input.value);
    show(msg);
    if (!msg && input.value.trim() !== value) apply(input.value.trim());
  });
  return h('div', { class: `field${opts.cls ? ` ${opts.cls}` : ''}` }, h('label', { for: id }, label), input, err, opts.help ? h('small', { class: 'help' }, opts.help) : null);
}

/** A time field: "09:05" (or "+0:05" on a session clock shown as minutes after the start). */
function timeInput(id: string, label: string, tt: Timetable, value: number | null, apply: (v: number | null) => void) {
  const elapsed = tt.timing === 'session' && tt.elapsed;
  return checkedInput(
    id,
    label,
    fmtTime(value, tt),
    8,
    (v) => (Number.isNaN(parseTime(v, elapsed)) ? (elapsed ? 'Minutes after the start, e.g. +5 or +1:30.' : 'A time such as 09:05 or 1500.') : null),
    (v) => apply(parseTime(v, elapsed)),
    { placeholder: elapsed ? '+0:05' : '09:05', cls: 'tt-time' },
  );
}

/** Place and road choices on the layout, grouped by kind of place. value = "placeId|roadId". */
function refOptions(layout: Layout, ref: PlaceRef, opts: { blank?: string } = {}) {
  const cur = `${ref.placeId}|${ref.roadId}`;
  const out: Array<HTMLOptionElement | HTMLOptGroupElement> = [option('|', opts.blank ?? 'Choose a place…', !ref.placeId)];
  for (const k of PLACE_KINDS) {
    const places = layout.places.filter((p) => p.kind === k.kind);
    if (!places.length) continue;
    out.push(
      h(
        'optgroup',
        { label: k.plural },
        ...places.flatMap((p) => [
          option(`${p.id}|`, p.roads.length ? `${p.name} (any road)` : p.name, cur === `${p.id}|`),
          ...p.roads.map((r) => option(`${p.id}|${r.id}`, `${p.name} · ${r.name}`, cur === `${p.id}|${r.id}`)),
        ]),
      ),
    );
  }
  if (ref.placeId && !layout.places.some((p) => p.id === ref.placeId)) out.push(option(cur, 'A place no longer on the layout', true));
  else if (ref.roadId && !layout.places.find((p) => p.id === ref.placeId)?.roads.some((r) => r.id === ref.roadId)) out.push(option(cur, 'A road that no longer exists', true));
  return out;
}

function refSelect(id: string, label: string, layout: Layout, ref: PlaceRef, apply: (r: PlaceRef) => void, help?: string) {
  const sel = h(
    'select',
    {
      id,
      on: {
        change: (e: Event) => {
          const [placeId, roadId] = (e.target as HTMLSelectElement).value.split('|');
          apply({ placeId: placeId ?? '', roadId: roadId ?? '' });
        },
      },
    },
    ...refOptions(layout, ref),
  );
  return h('div', { class: 'field' }, h('label', { for: id }, label), sel, help ? h('small', { class: 'help' }, help) : null);
}

function workingOptions(st: AppState, current: string) {
  const set = activeCodeSet(st);
  return st.trainTypes.map((t) => option(t.id, `${t.name}${set.trainCodes[t.id] ? ` (${set.trainCodes[t.id].code})` : ''}`, t.id === current));
}

function issueList(issues: TtIssue[]) {
  if (!issues.length) return null;
  return h('ul', { class: 'plain tt-issues' }, ...issues.map((i) => h('li', { class: `tt-issue ${i.level}` }, h('span', { class: 'tt-issue-mark', 'aria-hidden': 'true' }, i.level === 'error' ? '✕' : '!'), h('span', null, i.text))));
}

// ---------------------------------------------------------------- the Moves tab

function movesTab(ctx: Ctx, layout: Layout, tt: Timetable, upd: Upd): HTMLElement {
  const st = ctx.store.state;
  const w = walkTimetable(st, layout, tt);
  const stepOf = new Map(w.steps.map((s) => [s.entry.id, s]));
  if (ui.step !== null && ui.step >= w.steps.length) ui.step = w.steps.length ? w.steps.length - 1 : null;
  const shelf = h('div', { class: 'config-shelf tt-shelf' });
  const redraw = () => {
    // Local changes (open rows, view, stepping) redraw this tab without leaving the page.
    const y = window.scrollY;
    shelf.replaceWith(movesTab(ctx, layout, tt, upd));
    window.scrollTo(0, y);
  };

  // ---- toolbar
  const newTrain = () => {
    let entryId = '';
    let trainId = '';
    upd((t, l, a) => {
      const r = addTrain(a, l, t);
      if (r) {
        entryId = r.entry.id;
        trainId = r.train.id;
        sortByTime(t);
      }
    });
    if (!entryId) return toast(`A timetable can have up to ${MAX_ENTRIES} moves.`);
    ui.open = entryId;
    ui.trainOpen.set(trainId, true);
    ui.focus = ui.view === 'train' ? `tt_tname_${trainId}` : `tt_kind_${entryId}`;
  };
  const viewSeg = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Show the moves' },
    ...(
      [
        ['order', 'In order'],
        ['train', 'By train'],
      ] as Array<[View, string]>
    ).map(([v, label]) =>
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          'aria-pressed': String(ui.view === v),
          on: {
            click: () => {
              ui.view = v;
              redraw();
            },
          },
        },
        label,
      ),
    ),
  );
  const toolbar = h(
    'div',
    { class: 'tt-toolbar' },
    viewSeg,
    h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        'aria-pressed': String(ui.step !== null),
        disabled: !w.steps.length,
        on: {
          click: () => {
            ui.step = ui.step === null ? -1 : null;
            redraw();
          },
        },
      },
      ui.step === null ? 'Step through' : 'Stop stepping',
    ),
    h('span', { class: `tt-check-sum${w.errors ? ' bad' : w.warnings ? ' warn' : ' ok'}` }, issuesSummary(w)),
    h('button', { class: 'btn primary small', type: 'button', id: 'tt_new_train', disabled: tt.entries.length >= MAX_ENTRIES, on: { click: newTrain } }, '+ New train'),
  );
  shelf.append(toolbar);

  // ---- step through
  if (ui.step !== null) shelf.append(stepPanel(st, layout, tt, w, redraw));

  // ---- stock at the start
  shelf.append(stockCase(ctx, layout, tt, w, redraw));

  // ---- trains with problems of their own
  const trainProblems = [...w.trainIssues.entries()].filter(([, list]) => list.length);
  if (trainProblems.length && ui.view === 'order')
    shelf.append(h('div', { class: 'config-warn tt-train-warn' }, ...trainProblems.map(([id, list]) => h('p', null, h('strong', null, `${findTrain(tt, id)?.name ?? 'A train'}: `), list.map((i) => i.text).join(' ')))));

  // ---- the moves
  if (!tt.entries.length) {
    shelf.append(
      h(
        'button',
        { class: 'add-tile tt-first', type: 'button', on: { click: newTrain } },
        plusIcon(),
        h('span', { class: 'mi-label' }, 'Add the first train'),
        h('span', { class: 'mi-sub' }, 'A train is a chain of moves worked by one loco. Start with its first move, then add “Then this train…” for each move after it.'),
      ),
    );
    return shelf;
  }
  const highlight = ui.step !== null && ui.step >= 0 ? w.steps[ui.step]?.entry.id : '';
  const rowFor = (e: TimetableEntry) => entryRow(ctx, layout, tt, e, stepOf.get(e.id)!, upd, redraw, highlight === e.id);
  if (ui.view === 'order') {
    shelf.append(h('ol', { class: 'plain tt-rows', 'aria-label': 'Moves in order' }, ...tt.entries.map(rowFor)));
  } else {
    const loose = tt.entries.filter((e) => !findTrain(tt, e.trainId));
    shelf.append(h('div', { class: 'tt-trains' }, ...tt.trains.map((t) => trainCase(ctx, layout, tt, t, w, upd, redraw, rowFor))));
    if (loose.length) shelf.append(h('section', { class: 'config-case tt-loose' }, h('span', { class: 'plate' }, 'Notes'), h('ol', { class: 'plain tt-rows' }, ...loose.map(rowFor))));
  }
  shelf.append(
    h(
      'div',
      { class: 'row tt-foot' },
      h('button', { class: 'btn', type: 'button', disabled: tt.entries.length >= MAX_ENTRIES, on: { click: newTrain } }, '+ New train'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          disabled: tt.entries.length >= MAX_ENTRIES,
          on: {
            click: () => {
              let id = '';
              upd((t) => {
                const e: TimetableEntry = { id: `tte_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, trainId: '', kind: 'note', dep: null, arr: null, withPrevious: false, trainTypeId: 'light_engine', headcode: '', from: { placeId: '', roadId: '' }, to: { placeId: '', roadId: '' }, calls: [], notes: '' };
                if (isTimed(t)) e.dep = t.entries.length ? (t.entries[t.entries.length - 1].dep ?? null) : t.startAt;
                t.entries.push(e);
                id = e.id;
              });
              ui.open = id;
              ui.focus = `tt_notes_${id}`;
            },
          },
        },
        '+ Note',
      ),
    ),
  );
  return shelf;
}

/** Where every loco stands after a step (or before the first, at -1), grouped by place. */
function stepPanel(st: AppState, layout: Layout, tt: Timetable, w: TtWalk, redraw: () => void): HTMLElement {
  const i = ui.step ?? -1;
  const s: TtStep | undefined = i >= 0 ? w.steps[i] : undefined;
  const pos: Map<string, TtPos> = s ? s.after : new Map(w.units.map((u) => [u.key, u.start]));
  const unitName = (key: string) => {
    const u = w.units.find((x) => x.key === key);
    if (!u) return '';
    const loco = u.locoId ? st.roster.find((l) => l.id === u.locoId) : undefined;
    const trains = u.trainIds.map((id) => findTrain(tt, id)?.name).filter(Boolean).join(' / ');
    return loco ? `${locoName(loco)} (${trains})` : `${trains} (any loco)`;
  };
  const byPlace = new Map<string, Array<{ road: string; who: string }>>();
  const off: string[] = [];
  for (const [key, p] of pos) {
    if (p.kind === 'off') off.push(unitName(key));
    else {
      const place = layout.places.find((x) => x.id === p.placeId);
      const road = place?.roads.find((r) => r.id === p.roadId)?.name ?? '';
      (byPlace.get(p.placeId) ?? byPlace.set(p.placeId, []).get(p.placeId)!).push({ road, who: unitName(key) });
    }
  }
  const go = (n: number) => () => {
    ui.step = Math.max(-1, Math.min(w.steps.length - 1, n));
    redraw();
    window.setTimeout(() => document.querySelector('.tt-row.stepping')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
  };
  const what = s
    ? `After move ${i + 1} of ${w.steps.length}${isTimed(tt) && s.entry.dep !== null ? ` (${fmtTime(s.entry.dep, tt)})` : !isTimed(tt) ? ` (step ${s.step})` : ''}: ${moveTitle(st, tt, s.entry)}`
    : 'Before the first move: the stock positions at the start';
  return h(
    'section',
    { class: 'config-case tt-step', 'aria-label': 'Step through', 'aria-live': 'polite' },
    h('div', { class: 'tt-step-head' }, h('span', { class: 'plate' }, 'Step through'), h('p', { class: 'tt-step-what' }, what)),
    h(
      'div',
      { class: 'row tt-step-btns' },
      h('button', { class: 'btn small', type: 'button', disabled: i < 0, on: { click: go(-1) } }, '⏮ Start'),
      h('button', { class: 'btn small', type: 'button', disabled: i < 0, on: { click: go(i - 1) } }, '‹ Back'),
      h('button', { class: 'btn primary small', type: 'button', disabled: i >= w.steps.length - 1, on: { click: go(i + 1) } }, 'Next move ›'),
      h('button', { class: 'btn small', type: 'button', disabled: i >= w.steps.length - 1, on: { click: go(w.steps.length - 1) } }, 'End ⏭'),
    ),
    s ? issueList(s.issues) : null,
    h(
      'div',
      { class: 'tt-step-places' },
      ...layout.places
        .filter((p) => byPlace.has(p.id))
        .map((p) =>
          h(
            'div',
            { class: 'tt-step-place' },
            h('h3', { class: 'shelf-label' }, p.name),
            h('ul', { class: 'plain' }, ...byPlace.get(p.id)!.map((x) => h('li', null, x.road ? h('strong', null, `${x.road}: `) : null, x.who))),
          ),
        ),
      off.length ? h('div', { class: 'tt-step-place' }, h('h3', { class: 'shelf-label' }, 'Off the layout'), h('ul', { class: 'plain' }, ...off.map((x) => h('li', null, x)))) : null,
    ),
  );
}

function stockCase(ctx: Ctx, layout: Layout, tt: Timetable, w: TtWalk, redraw: () => void): HTMLElement {
  const st = ctx.store.state;
  const rows = stockPositions(st, layout, tt, w);
  const wrong = rows.filter((r) => r.loco && !r.there);
  const open = ui.stockOpen ?? wrong.length > 0;
  const bodyId = 'tt_stock_body';
  const body = h(
    'div',
    { class: 'pl-body', id: bodyId, hidden: !open },
    rows.length
      ? h(
          'table',
          { class: 'tt-stock' },
          h('thead', null, h('tr', null, h('th', null, 'Loco'), h('th', null, 'Works'), h('th', null, 'Starts at'), h('th', null, 'In the roster now'))),
          h(
            'tbody',
            null,
            ...rows.map((r) =>
              h(
                'tr',
                { class: r.loco ? (r.there ? 'ok' : 'move') : 'any' },
                h('td', null, r.loco ? locoName(r.loco) : 'Any loco'),
                h('td', null, r.trains.map((t) => t.name).join(', ')),
                h('td', null, r.startText),
                h('td', null, r.loco ? (r.there ? '✓ There' : locationTextOf(st, r.loco.location)) : 'Chosen when it runs'),
              ),
            ),
          ),
        )
      : h('p', { class: 'help' }, 'No trains yet.'),
    wrong.length
      ? h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn primary small',
              type: 'button',
              on: {
                click: () =>
                  confirmDialog({
                    title: 'Put the locos where the timetable starts them?',
                    body: [`This moves ${plural(wrong.length, 'loco')} in the roster (not on your layout: move them there too):`, h('ul', null, ...wrong.map((r) => h('li', null, `${locoFullName(r.loco)} to ${r.startText}`)))],
                    confirmLabel: 'Move them',
                    onDone: (ok) => {
                      if (!ok) return;
                      let n = 0;
                      ctx.store.update((a) => {
                        const f = findTimetable(a, tt.id);
                        if (f) n = applyStockPositions(a, f.layout, f.tt);
                      });
                      toast(`${plural(n, 'loco')} moved to their starting places.`);
                    },
                  }),
              },
            },
            'Put them there now',
          ),
          h('small', { class: 'help' }, 'Moves them in the app. On a real layout, place them on the track as well.'),
        )
      : null,
  );
  const toggle = h(
    'button',
    {
      class: 'pl-toggle',
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': bodyId,
      on: {
        click: () => {
          ui.stockOpen = !open;
          redraw();
        },
      },
    },
    h('span', { class: 'pl-chev', 'aria-hidden': 'true' }),
    h('span', { class: 'plate' }, 'Stock at the start'),
    h('span', { class: 'pl-summary' }, rows.length ? (wrong.length ? `${plural(wrong.length, 'loco')} not where the timetable starts ${wrong.length === 1 ? 'it' : 'them'}` : 'Every loco is where the timetable starts it') : 'No trains yet'),
  );
  return h('section', { class: `config-case pl-case tt-stock-case${wrong.length ? ' needs' : ''}` }, toggle, body);
}

function locationTextOf(st: AppState, loc: AppState['roster'][number]['location']): string {
  if (loc.kind === 'place') return refText(st, loc);
  if (loc.kind === 'offLayout') return 'Off the layout';
  if (loc.kind === 'atBox') return `At ${st.boxes.find((b) => b.id === loc.boxId)?.name ?? 'a box'}`;
  return 'In section';
}

/** "Ordinary passenger FYE Rd 1 → SGC P2" */
function moveTitle(st: AppState, tt: Timetable, e: TimetableEntry): string {
  const train = findTrain(tt, e.trainId);
  const who = train ? `${train.name}: ` : '';
  switch (e.kind) {
    case 'note':
      return `Note${e.notes ? `: ${e.notes.split('\n')[0]}` : ''}`;
    case 'enter':
      return `${who}comes on to the layout at ${refShort(st, e.to)}`;
    case 'leave':
      return `${who}leaves the layout from ${refShort(st, e.from)}`;
    case 'shunt':
      return `${who}${trainTypeName(st, e.trainTypeId)} ${refShort(st, e.from)}${e.to.placeId && (e.to.placeId !== e.from.placeId || e.to.roadId !== e.from.roadId) ? ` → ${refShort(st, e.to)}` : ' (stays)'}`;
    default:
      return `${who}${trainTypeName(st, e.trainTypeId)} ${refShort(st, e.from)} → ${refShort(st, e.to)}`;
  }
}

// ---------------------------------------------------------------- one move

function entryRow(ctx: Ctx, layout: Layout, tt: Timetable, e: TimetableEntry, step: TtStep, upd: Upd, redraw: () => void, stepping: boolean): HTMLElement {
  const st = ctx.store.state;
  const train = findTrain(tt, e.trainId);
  const open = ui.open === e.id;
  const errors = step.issues.filter((i) => i.level === 'error').length;
  const warns = step.issues.length - errors;
  const loco = trainLoco(st, train);
  const set = activeCodeSet(st);
  const code = e.kind === 'run' ? set.trainCodes[e.trainTypeId]?.code : undefined;
  const no = isTimed(tt) ? fmtTime(e.dep, tt) || '—' : e.withPrevious && step.index > 0 ? `${step.step}+` : String(step.step);
  const bodyId = `tt_body_${e.id}`;
  const head = h(
    'button',
    {
      class: 'tt-row-head',
      type: 'button',
      id: `tt_head_${e.id}`,
      'aria-expanded': String(open),
      'aria-controls': bodyId,
      on: {
        click: () => {
          ui.open = open ? null : e.id;
          redraw();
          if (!open) window.setTimeout(() => document.getElementById(`tt_head_${e.id}`)?.focus(), 0);
        },
      },
    },
    h('span', { class: 'pl-chev', 'aria-hidden': 'true' }),
    h('span', { class: `tt-no${isTimed(tt) ? ' time' : ''}`, title: isTimed(tt) ? 'Departs' : e.withPrevious ? 'Released with the move before it' : 'Step' }, no),
    e.headcode ? h('span', { class: 'tt-headcode' }, e.headcode) : null,
    h(
      'span',
      { class: 'tt-what' },
      h('span', { class: 'tt-what-main' }, moveTitle(st, tt, e)),
      e.kind !== 'note' ? h('span', { class: 'tt-what-sub' }, [entryKindName(e.kind), loco ? locoName(loco) : train && !train.locoId ? 'any loco' : '', code ? `bell ${code}` : '', isTimed(tt) && e.arr !== null ? `arr ${fmtTime(e.arr, tt)}` : ''].filter(Boolean).join(' · ')) : null,
    ),
    errors || warns ? h('span', { class: `tt-flag ${errors ? 'error' : 'warn'}`, title: step.issues.map((i) => i.text).join(' ') }, errors ? `✕ ${errors}` : `! ${warns}`) : null,
  );
  const li = h('li', { class: `tt-row kind-${e.kind}${open ? ' open' : ''}${stepping ? ' stepping' : ''}${errors ? ' has-error' : ''}`, id: `tt_row_${e.id}` }, head);
  if (open) li.append(entryForm(ctx, layout, tt, e, step, upd, redraw, bodyId));
  return li;
}

function entryForm(ctx: Ctx, layout: Layout, tt: Timetable, e: TimetableEntry, step: TtStep, upd: Upd, redraw: () => void, bodyId: string): HTMLElement {
  const st = ctx.store.state;
  const id = (k: string) => `tt_${k}_${e.id}`;
  const edit = (fn: (x: TimetableEntry, t: Timetable, l: Layout, a: AppState) => void, resort = false) =>
    upd((t, l, a) => {
      const x = t.entries.find((y) => y.id === e.id);
      if (!x) return;
      fn(x, t, l, a);
      if (resort) sortByTime(t);
    });
  const train = findTrain(tt, e.trainId);
  const timed = isTimed(tt);
  const index = tt.entries.indexOf(e);

  const kindSel = h('div', { class: 'field' }, h('label', { for: id('kind') }, 'Kind of move'), h('select', { id: id('kind'), on: { change: (ev: Event) => edit((x) => (x.kind = (ev.target as HTMLSelectElement).value as TimetableEntry['kind'])) } }, ...ENTRY_KINDS.map((k) => option(k.kind, k.name, k.kind === e.kind))), h('small', { class: 'help' }, ENTRY_KINDS.find((k) => k.kind === e.kind)?.help ?? ''));
  const trainSel = h(
    'div',
    { class: 'field' },
    h('label', { for: id('train') }, 'Train'),
    h(
      'select',
      { id: id('train'), on: { change: (ev: Event) => edit((x) => (x.trainId = (ev.target as HTMLSelectElement).value)) } },
      ...(e.kind === 'note' ? [option('', 'Not about one train', !e.trainId)] : []),
      ...tt.trains.map((t) => option(t.id, trainLabel(st, t), t.id === e.trainId)),
    ),
    train && ui.view === 'order'
      ? h(
          'button',
          {
            class: 'btn small tt-link',
            type: 'button',
            on: {
              click: () => {
                ui.view = 'train';
                ui.trainOpen.set(train.id, true);
                redraw();
                window.setTimeout(() => document.getElementById(`tt_train_${train.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
              },
            },
          },
          `Edit ${train.name} (loco, consist)`,
        )
      : null,
  );
  const fields: Array<HTMLElement | null> = [kindSel, tt.trains.length ? trainSel : null];
  if (e.kind !== 'note') {
    fields.push(h('div', { class: 'field' }, h('label', { for: id('tt') }, e.kind === 'run' ? 'Runs as' : 'Working'), h('select', { id: id('tt'), on: { change: (ev: Event) => edit((x) => (x.trainTypeId = (ev.target as HTMLSelectElement).value)) } }, ...workingOptions(st, e.trainTypeId)), h('small', { class: 'help' }, 'Sets its description and bell code for this move.')));
    fields.push(checkedInput(id('hc'), 'Reporting number', e.headcode, 8, () => null, (v) => edit((x) => (x.headcode = v.toUpperCase())), { placeholder: 'e.g. 2B05', help: 'Optional. Shown on the poster and train cards.' }));
  }
  if (timed) {
    fields.push(timeInput(id('dep'), e.kind === 'note' ? 'At' : e.kind === 'run' ? 'Departs' : 'Starts', tt, e.dep, (v) => edit((x) => (x.dep = v), true)));
    if (e.kind === 'run' || e.kind === 'enter') fields.push(timeInput(id('arr'), 'Arrives', tt, e.arr, (v) => edit((x) => (x.arr = v))));
  } else if (index > 0) {
    fields.push(
      h(
        'div',
        { class: 'field tt-with' },
        h('span', { class: 'field-label' }, 'When'),
        h('label', { class: 'check', for: id('with') }, h('input', { id: id('with'), type: 'checkbox', checked: e.withPrevious, on: { change: (ev: Event) => edit((x) => (x.withPrevious = (ev.target as HTMLInputElement).checked)) } }), h('span', null, 'Released with the move before it')),
        h('small', { class: 'help' }, e.withPrevious ? 'Both are given out together: two things happen at once.' : 'Given out once the move before it has finished.'),
      ),
    );
  }
  const where: Array<HTMLElement | null> = [];
  if (e.kind === 'run' || e.kind === 'shunt' || e.kind === 'leave') where.push(refSelect(id('from'), e.kind === 'leave' ? 'Leaves from' : 'From', layout, e.from, (r) => edit((x) => (x.from = r))));
  if (e.kind === 'run' || e.kind === 'enter' || e.kind === 'shunt')
    where.push(refSelect(id('to'), e.kind === 'enter' ? 'Comes on at' : 'To', layout, e.to, (r) => edit((x) => (x.to = r)), e.kind === 'shunt' ? 'The same place and road for a change of working where it stands.' : e.kind === 'enter' ? 'Usually a fiddle yard road.' : undefined));
  const route = (e.kind === 'run' || e.kind === 'shunt') && e.from.placeId && e.to.placeId ? h('p', { class: 'help tt-route' }, h('strong', null, 'Route: '), routeText(st, step.route)) : null;

  const calls = e.kind === 'run' ? callsSection(layout, tt, e, edit, id) : null;
  const notes = h('div', { class: 'field' }, h('label', { for: id('notes') }, e.kind === 'note' ? 'Note' : 'Notes for the operators'), h('textarea', { id: id('notes'), rows: 2, placeholder: e.kind === 'note' ? 'e.g. Pilot attaches a van to the stopper.' : 'e.g. Uncouple and leave the coaches in the platform.', on: { change: (ev: Event) => edit((x) => (x.notes = (ev.target as HTMLTextAreaElement).value.trim())) } }, e.notes));

  const actions = h(
    'div',
    { class: 'row tt-actions' },
    !timed ? h('button', { class: 'btn small', type: 'button', disabled: index <= 0, title: 'Earlier', 'aria-label': 'Move earlier', on: { click: () => upd((t) => moveEntry(t, e.id, -1)) } }, '▲ Earlier') : null,
    !timed ? h('button', { class: 'btn small', type: 'button', disabled: index >= tt.entries.length - 1, title: 'Later', 'aria-label': 'Move later', on: { click: () => upd((t) => moveEntry(t, e.id, 1)) } }, '▼ Later') : null,
    train
      ? h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            on: {
              click: () => {
                let nid = '';
                upd((t, l, a) => {
                  nid = thenEntry(a, l, t, train.id)?.id ?? '';
                  sortByTime(t);
                });
                if (nid) {
                  ui.open = nid;
                  ui.focus = `tt_kind_${nid}`;
                }
              },
            },
          },
          `+ Then ${train.name}…`,
        )
      : null,
    h('span', { class: 'tt-spacer' }),
    confirmButton('Remove this move', 'Press again to remove', () => upd((t) => removeEntry(t, e.id)), 'btn danger small'),
  );
  return h('div', { class: 'tt-form', id: bodyId }, issueList(step.issues), h('div', { class: 'form-grid tight tt-grid' }, ...fields), where.length ? h('div', { class: 'form-grid tight tt-grid tt-where' }, ...where) : null, route, calls, notes, actions);
}

function callsSection(layout: Layout, tt: Timetable, e: TimetableEntry, edit: (fn: (x: TimetableEntry) => void) => void, id: (k: string) => string): HTMLElement {
  const timed = isTimed(tt);
  const editCall = (i: number, fn: (c: TimetableCall) => void) => edit((x) => x.calls[i] && fn(x.calls[i]));
  return h(
    'div',
    { class: 'pl-section tt-calls' },
    h('h3', { class: 'shelf-label' }, 'Calls at and passes'),
    e.calls.length
      ? h(
          'ul',
          { class: 'plain tt-call-list' },
          ...e.calls.map((c, i) =>
            h(
              'li',
              { class: 'tt-call' },
              h('div', { class: 'field' }, h('select', { id: id(`call${i}`), 'aria-label': `Call ${i + 1}: place`, on: { change: (ev: Event) => { const [p, r] = (ev.target as HTMLSelectElement).value.split('|'); editCall(i, (cc) => { cc.placeId = p ?? ''; cc.roadId = r ?? ''; }); } } }, ...refOptions(layout, c))),
              h(
                'div',
                { class: 'seg', role: 'group', 'aria-label': 'Stops or passes' },
                h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(c.stop), on: { click: () => !c.stop && editCall(i, (cc) => (cc.stop = true)) } }, 'Stops'),
                h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(!c.stop), on: { click: () => c.stop && editCall(i, (cc) => (cc.stop = false)) } }, 'Passes'),
              ),
              timed && c.stop ? timeInput(id(`carr${i}`), 'Arr', tt, c.arr, (v) => editCall(i, (cc) => (cc.arr = v))) : null,
              timed ? timeInput(id(`cdep${i}`), c.stop ? 'Dep' : 'Passes at', tt, c.dep, (v) => editCall(i, (cc) => (cc.dep = v))) : null,
              (() => {
                const x = h('button', { class: 'btn danger small', type: 'button', 'aria-label': `Remove call ${i + 1}`, title: 'Remove', on: { click: () => edit((y) => y.calls.splice(i, 1)) } }, '✕');
                return x;
              })(),
            ),
          ),
        )
      : h('p', { class: 'help' }, 'Optional: places on the way, for the poster (e.g. a station a through train passes or stops at).'),
    h('button', { class: 'btn small', type: 'button', on: { click: () => edit((x) => x.calls.push({ placeId: '', roadId: '', stop: true, arr: null, dep: null })) } }, '+ Add a call'),
  );
}

// ---------------------------------------------------------------- one train (By train view)

function trainCase(ctx: Ctx, layout: Layout, tt: Timetable, t: TimetableTrain, w: TtWalk, upd: Upd, redraw: () => void, rowFor: (e: TimetableEntry) => HTMLElement): HTMLElement {
  const st = ctx.store.state;
  const moves = entriesOfTrain(tt, t.id);
  const open = ui.trainOpen.get(t.id) ?? tt.trains.length <= 3;
  const editT = (fn: (x: TimetableTrain) => void) =>
    upd((tt2) => {
      const x = tt2.trains.find((y) => y.id === t.id);
      if (x) fn(x);
    });
  const issues = w.trainIssues.get(t.id) ?? [];
  const moveIssues = moves.reduce((n, e) => n + (w.steps.find((s) => s.entry.id === e.id)?.issues.length ?? 0), 0);
  const path = moves.filter((e) => e.kind !== 'note');
  const pathText = path.length ? [path[0].kind === 'enter' ? 'Off layout' : refShort(st, path[0].from), ...path.map((e) => (e.kind === 'leave' ? 'Off layout' : refShort(st, e.to.placeId ? e.to : e.from)))].join(' → ') : 'No moves yet';
  const board = h('h2', { class: 'nameboard section-board', id: `tt_tboard_${t.id}` }, t.name);
  const bodyId = `tt_tbody_${t.id}`;
  const toggle = h(
    'button',
    {
      class: 'pl-toggle',
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': bodyId,
      on: {
        click: () => {
          ui.trainOpen.set(t.id, !open);
          redraw();
        },
      },
    },
    h('span', { class: 'pl-chev', 'aria-hidden': 'true' }),
    board,
    h('span', { class: 'pl-kind-tag' }, trainLoco(st, t) ? locoName(trainLoco(st, t)) : t.locoId ? 'Loco missing' : 'Any loco'),
    h('span', { class: 'pl-summary' }, `${plural(moves.length, 'move')} · ${pathText}${issues.length + moveIssues ? ` · ${plural(issues.length + moveIssues, 'thing')} to check` : ''}`),
  );
  const locoOptions = [
    option('', 'Any loco with a job for…', !t.locoId),
    ...[...st.roster].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })).map((l) => option(l.id, `${locoFullName(l)}`, l.id === t.locoId)),
    ...(t.locoId && !st.roster.some((l) => l.id === t.locoId) ? [option(t.locoId, 'A loco no longer in the roster', true)] : []),
  ];
  const suitable = !t.locoId ? locosFor(st, t.anyWorking) : [];
  const body = h(
    'div',
    { class: 'pl-body', id: bodyId, hidden: !open },
    issueList(issues),
    h(
      'div',
      { class: 'form-grid tight tt-grid' },
      checkedInput(`tt_tname_${t.id}`, 'Name', t.name, 40, (v) => checkTrainName(tt, v, t.id), (v) => editT((x) => (x.name = v)), { onInput: (v, ok) => (board.textContent = ok ? v.trim() : t.name) }),
      h('div', { class: 'field' }, h('label', { for: `tt_tloco_${t.id}` }, 'Worked by'), h('select', { id: `tt_tloco_${t.id}`, on: { change: (ev: Event) => editT((x) => (x.locoId = (ev.target as HTMLSelectElement).value)) } }, ...locoOptions)),
      !t.locoId
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: `tt_tany_${t.id}` }, 'Job'),
            h('select', { id: `tt_tany_${t.id}`, on: { change: (ev: Event) => editT((x) => (x.anyWorking = (ev.target as HTMLSelectElement).value)) } }, ...workingOptions(st, t.anyWorking)),
            h('small', { class: 'help' }, suitable.length ? `Chosen when it runs from: ${suitable.map(locoName).join(', ')}.` : 'No loco has this job yet: give locos jobs in the roster.'),
          )
        : null,
      checkedInput(`tt_tcons_${t.id}`, 'Consist', t.consist, 60, () => null, (v) => editT((x) => (x.consist = v)), { placeholder: 'e.g. 4 coaches' }),
    ),
    h('div', { class: 'field' }, h('label', { for: `tt_tnotes_${t.id}` }, 'Notes'), h('textarea', { id: `tt_tnotes_${t.id}`, rows: 2, on: { change: (ev: Event) => editT((x) => (x.notes = (ev.target as HTMLTextAreaElement).value.trim())) } }, t.notes)),
    moves.length ? h('ol', { class: 'plain tt-rows' }, ...moves.map(rowFor)) : h('p', { class: 'help' }, 'No moves yet.'),
    h(
      'div',
      { class: 'row tt-actions' },
      h(
        'button',
        {
          class: 'btn primary small',
          type: 'button',
          id: `tt_then_${t.id}`,
          disabled: tt.entries.length >= MAX_ENTRIES,
          on: {
            click: () => {
              let nid = '';
              upd((t2, l, a) => {
                nid = thenEntry(a, l, t2, t.id)?.id ?? '';
                sortByTime(t2);
              });
              if (nid) {
                ui.open = nid;
                ui.focus = `tt_kind_${nid}`;
              }
            },
          },
        },
        `+ Then ${t.name}…`,
      ),
      h('span', { class: 'tt-spacer' }),
      confirmButton(`Remove ${t.name}`, `Remove it and its ${plural(moves.length, 'move')}?`, () => upd((t2) => removeTrain(t2, t.id)), 'btn danger small'),
    ),
  );
  return h('article', { class: `config-case pl-case tt-train${open ? '' : ' collapsed'}`, id: `tt_train_${t.id}`, 'aria-labelledby': `tt_tboard_${t.id}` }, toggle, body);
}

// ---------------------------------------------------------------- the Settings tab

function settingsTab(ctx: Ctx, layout: Layout, tt: Timetable, upd: Upd): HTMLElement {
  const board = h('h2', { class: 'nameboard section-board', id: 'tts_board' }, tt.name);
  const timingSeg = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', id: 'tts_timing_l' }, 'How it runs'),
    h(
      'div',
      { class: 'seg tt-timing-seg', role: 'group', 'aria-labelledby': 'tts_timing_l' },
      ...TIMINGS.map((x) => h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(tt.timing === x.timing), on: { click: () => tt.timing !== x.timing && upd((t) => setTiming(t, x.timing)) } }, x.name)),
    ),
    h('small', { class: 'help' }, timingInfo(tt.timing).help),
  );
  const session =
    tt.timing === 'session'
      ? h(
          'div',
          { class: 'form-grid tight' },
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label' }, 'Show times'),
            h('label', { class: 'check', for: 'tts_elapsed' }, h('input', { id: 'tts_elapsed', type: 'checkbox', checked: tt.elapsed, on: { change: (e: Event) => upd((t) => setElapsed(t, (e.target as HTMLInputElement).checked)) } }), h('span', null, 'As minutes after the start (+0:05)')),
          ),
          tt.elapsed ? null : timeInput('tts_start', 'Clock starts at', { ...tt, timing: 'clock' } as Timetable, tt.startAt, (v) => upd((t) => setStart(t, v ?? 0))),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'tts_speed' }, 'Clock speed'),
            h('select', { id: 'tts_speed', on: { change: (e: Event) => upd((t) => (t.speed = Number((e.target as HTMLSelectElement).value))) } }, ...Array.from({ length: MAX_SPEED }, (_, i) => i + 1).map((n) => option(String(n), n === 1 ? 'Real time (×1)' : `Fast clock ×${n}`, n === tt.speed))),
            h('small', { class: 'help' }, 'A fast clock makes a model railway’s short runs feel like the real distances.'),
          ),
        )
      : null;
  const untimed = isTimed(tt) ? tt.entries.filter((e) => e.dep === null).length : 0;
  const caseEl = h(
    'article',
    { class: 'config-case', 'aria-labelledby': 'tts_board' },
    h('div', { class: 'panel-head' }, board),
    h(
      'div',
      { class: 'form-grid tight' },
      checkedInput('tts_name', 'Name', tt.name, 60, (v) => checkTimetableName(layout, v, tt.id), (v) => upd((t) => (t.name = v)), { onInput: (v, ok) => (board.textContent = ok ? v.trim() : tt.name) }),
      checkedInput('tts_valid', 'Runs on', tt.validity, 60, () => null, (v) => upd((t) => (t.validity = v)), { placeholder: 'e.g. Weekdays, Gala weekend', help: 'Printed under the poster’s title.' }),
    ),
    timingSeg,
    session,
    untimed
      ? h(
          'div',
          { class: 'config-warn' },
          h('p', null, `${plural(untimed, 'move')} ${untimed === 1 ? 'has' : 'have'} no time yet.`),
          h('button', { class: 'btn small', type: 'button', on: { click: () => upd((t) => fillTimes(t, 5)) } }, 'Give them times 5 minutes apart'),
        )
      : null,
    h('div', { class: 'field' }, h('label', { for: 'tts_notes' }, 'Notes'), h('textarea', { id: 'tts_notes', rows: 3, on: { change: (e: Event) => upd((t) => (t.notes = (e.target as HTMLTextAreaElement).value.trim())) } }, tt.notes)),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          on: {
            click: () => {
              let id = '';
              ctx.store.update((a) => (id = duplicateTimetable(a, tt.id)?.id ?? ''));
              if (id) {
                toast('Copied. You are now editing the copy.');
                ctx.go(ttRoute(id, 'settings'));
              } else toast(`A layout can have up to ${MAX_TIMETABLES} timetables.`);
            },
          },
        },
        'Make a copy',
      ),
      h('span', { class: 'tt-spacer' }),
      confirmButton('Delete this timetable', 'Press again to delete it', () => {
        ctx.store.update((a) => deleteTimetable(a, tt.id));
        toast(`${tt.name} deleted.`);
        ctx.go('timetables');
      }, 'btn danger small'),
    ),
  );
  return h('div', { class: 'config-shelf tt-shelf' }, caseEl, h('p', { class: 'shelf-help' }, `Belongs to ${layout.name}. Running a timetable in a signal box (picking it for a session, releasing moves, switching on the fly) is coming in the next version.`));
}

function setTiming(t: Timetable, timing: TimetableTiming): void {
  t.timing = timing;
  if (timing !== 'sequence') sortByTime(t);
}

/** Switch a session clock between clock times and minutes after the start, keeping each move at the same moment. */
function setElapsed(t: Timetable, elapsed: boolean): void {
  if (t.elapsed === elapsed) return;
  const shift = elapsed ? -t.startAt : t.startAt;
  const mv = (x: number | null) => (x === null ? null : Math.max(0, x + shift));
  for (const e of t.entries) {
    e.dep = mv(e.dep);
    e.arr = mv(e.arr);
    for (const c of e.calls) {
      c.arr = mv(c.arr);
      c.dep = mv(c.dep);
    }
  }
  t.elapsed = elapsed;
}

/** A new start time for a session clock moves every move by the same amount. */
function setStart(t: Timetable, start: number): void {
  const shift = start - t.startAt;
  const mv = (x: number | null) => (x === null ? null : x + shift);
  for (const e of t.entries) {
    e.dep = mv(e.dep);
    e.arr = mv(e.arr);
    for (const c of e.calls) {
      c.arr = mv(c.arr);
      c.dep = mv(c.dep);
    }
  }
  t.startAt = start;
}

/** Give every untimed move a time, `gap` minutes after the move before it. */
function fillTimes(t: Timetable, gap: number): void {
  let last: number | null = null;
  for (const e of t.entries) {
    if (e.dep === null) e.dep = last === null ? (t.timing === 'session' && t.elapsed ? 0 : t.startAt) : last + gap;
    last = Math.max(e.dep, e.arr ?? e.dep);
  }
}

