import { findLayout } from '../../core/layouts';
import { arrivalChoices, arrivedLabel, farPlace, findPlace, findRoad, placeLocationText } from '../../core/places';
import { pointsText } from '../../core/score';
import { describeCode, REGULATION_SIGNALS, signalCode, trainCode } from '../../core/bellcodes';
import { realScheduler } from '../../core/scheduler';
import { instrumentName, type LogEntry } from '../../core/sectionController';
import { incomingCandidates, SELECTORS, stationLocos } from '../../core/selection';
import { layoutShelf, positionLabel } from '../../core/shelf';
import { beatDots } from '../../core/simulatedNeighbour';
import { TapDecoder } from '../../core/tapDecoder';
import { trainsOnLayout, type RegisterLocation } from '../../core/layoutRegister';
import type { BoxDef, ConnectionDef, InstrumentState, Loco } from '../../core/types';
import { getBoxRuntime, takeFinishedScore, type ConnRuntime } from '../boxRuntime';
import type { ThroughWorkings } from '../../core/throughTrains';
import { drawDiagram, hasDiagram, type DiagramLabels } from '../planDiagram';
import { showScoreSheet } from '../scoreSheet';
import { activeCodeSet, locationText, locoFullName, locoName, trainTypeName, type Ctx, type Screen } from '../app';
import { confirmButton, h, option, replace, safeRerender, toast } from '../dom';
import { codeReference } from './help';
import { layoutEditor } from './layout';

/*
 * The signal box console.
 *
 *   header      ‹ Menu · external nameboard · clock · mode · Score · Diagram · Codes · Yard · Settings
 *   diagram     the layout's track plan as a diagram board (shown or hidden from the header)
 *   next step   learner guidance (for visitors at shows), between the diagram and the shelf
 *   block shelf one instrument group per connection, in the box's shelf positions
 *   desk        next arrival (from a chosen line) · departure (to a chosen line) · trains on layout · train register
 *
 * On a phone the shelf shows the selected instrument group only and the desk
 * becomes tabs; CSS does the rearranging so there is one DOM for every size.
 */

type DeskTab = 'arr' | 'dep' | 'yard' | 'reg';

interface ConnectionUI {
  caseEl: HTMLElement;
  arrBody: HTMLElement;
  depBody: HTMLElement;
  regBody: HTMLElement;
  guidance(): { text: string; hint: string };
  /** A train is being offered or worked on this line. */
  busy(): boolean;
  name: string;
  tapPress(): void;
  tapRelease(): void;
  setSelected(on: boolean, many: boolean): void;
}

export function boxScreen(ctx: Ctx, box: BoxDef): Screen {
  const store = ctx.store;
  const learner = () => store.state.settings.strictness === 'learner';
  const runtime = getBoxRuntime(ctx, box);
  const sessions = runtime.conns.map((cr) => cr.session);
  // After the box is closed it resets; redraw this screen with the fresh, unopened box.
  ctx.onLeave(
    runtime.onReset(() => {
      if (location.hash.replace(/^#/, '') === `box/${box.id}`) {
        ctx.go(`box/${box.id}`);
        toast(`${box.name} box closed. Open it again with 1, then 5-5-5.`);
      }
    }),
  );

  // The final score of a box that has just been closed (shown once, here).
  const finished = takeFinishedScore(box.id);
  if (finished && store.state.settings.scoring) window.setTimeout(() => showScoreSheet(finished, { boxName: box.name, final: true }), 0);

  document.body.classList.add('console-mode');
  ctx.onLeave(() => document.body.classList.remove('console-mode'));

  let selected = 0;
  let tab: DeskTab = 'arr';

  // ---------------------------------------------------------------- next step
  const nextStep = h('div', { class: 'next-step', role: 'status', 'aria-live': 'polite' });
  // The Next step bar sits above the shelf, so a change in its height moves the instruments. Never
  // change it while a finger or mouse button is down: the tap would land somewhere else (e.g. tapping
  // a chip on another line's case selects that case, which changes the next step).
  let pointerHeld = false;
  let stepPending = false;
  const onDown = () => (pointerHeld = true);
  const onUp = () =>
    window.setTimeout(() => {
      pointerHeld = false;
      if (stepPending) {
        stepPending = false;
        renderNextStep();
      }
    }, 0);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  ctx.onLeave(() => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
  });
  const renderNextStep = () => {
    if (pointerHeld) {
      stepPending = true;
      return;
    }
    const ui = uis[selected];
    if (!ui || !learner()) {
      nextStep.hidden = true;
      return;
    }
    // Through trains (offering on) need the signaller to work two lines at once: that guidance comes first.
    const tg = runtime.workings.guidance();
    // A quiet line selected while a train is still being worked on another: show that line's next step.
    const other = !tg && !ui.busy() ? uis.find((u) => u !== ui && u.busy()) : undefined;
    const g = tg ? { text: tg.text, hint: '' } : other ? { ...other.guidance(), text: `${other.name}: ${other.guidance().text}` } : ui.guidance();
    nextStep.hidden = false;
    replace(
      nextStep,
      h('span', { class: 'ns-tag' }, 'Next step'),
      h(
        'div',
        { class: 'ns-body' },
        h('p', { class: 'ns-text' }, g.text || 'Waiting…'),
        g.hint ? h('p', { class: 'ns-hint' }, g.hint) : null,
      ),
    );
  };

  // ---------------------------------------------------------------- connections
  let uis: ConnectionUI[] = [];
  uis = runtime.conns.map((cr, i) => connectionUI(ctx, box, cr, renderNextStep, () => select(i), runtime.workings, runtime.conns.map((x) => x.session.connection)));


  // ---------------------------------------------------------------- header
  const clock = h('span', { class: 'box-clock', 'aria-label': 'Box clock' });
  const tick = () => {
    const d = new Date();
    clock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  };
  tick();
  const clockTimer = window.setInterval(tick, 1000);
  ctx.onLeave(() => window.clearInterval(clockTimer));

  const slots = layoutShelf(box);
  const shelfMap = h(
    'nav',
    { class: 'shelf-map', 'aria-label': 'Block shelf positions' },
    h('span', { class: 'sm-label' }, 'Shelf'),
    ...slots.map((c, pos) => {
      if (!c) return h('span', { class: 'sm-empty', title: `${positionLabel(pos, slots.length)}: empty` });
      const idx = sessions.findIndex((s) => s.connection.id === c.id);
      return h('button', { class: 'sm-conn', type: 'button', 'data-idx': String(idx), on: { click: () => select(idx) } }, c.neighbourName);
    }),
  );

  const side = sidePanel(ctx, box.id);
  ctx.onLeave(side.dispose);

  // ---------------------------------------------------------------- score
  const score = runtime.score;
  const scoreNum = h('strong', { class: 'score-num' });
  const scoreDelta = h('span', { class: 'score-delta', 'aria-hidden': 'true' });
  const scoreBtn = h(
    'button',
    { class: 'score-chip', type: 'button', title: 'Score sheet', on: { click: () => showScoreSheet(score, { boxName: box.name, final: false }) } },
    h('span', { class: 'score-word' }, 'Score'),
    scoreNum,
    scoreDelta,
  );
  let deltaTimer = 0;
  const renderScore = (delta?: number) => {
    scoreBtn.hidden = !store.state.settings.scoring;
    scoreNum.textContent = String(score.total);
    scoreBtn.setAttribute('aria-label', `Score ${score.total}. Open the score sheet.`);
    if (delta === undefined || delta === 0) return;
    scoreDelta.textContent = pointsText(delta);
    scoreDelta.className = `score-delta show ${delta < 0 ? 'neg' : 'pos'}`;
    window.clearTimeout(deltaTimer);
    deltaTimer = window.setTimeout(() => (scoreDelta.className = 'score-delta'), 1800);
  };
  ctx.onLeave(score.onChange((e) => renderScore(e?.points)));
  ctx.onLeave(store.subscribe(() => renderScore()));
  ctx.onLeave(() => window.clearTimeout(deltaTimer));
  renderScore();

  // ---------------------------------------------------------------- diagram board
  const diagramBtn = h('button', { class: 'btn small', type: 'button', 'aria-controls': 'diagram-board', on: { click: () => store.update((s) => { s.settings.boxDiagram = !s.settings.boxDiagram; }) } }, 'Diagram');
  const diagramEl = h('section', { id: 'diagram-board', class: 'diagram-shelf', 'aria-label': 'Track diagram' });
  let diagramKey = '';
  const renderDiagram = () => {
    const st = store.state;
    const show = st.settings.boxDiagram;
    diagramBtn.setAttribute('aria-pressed', String(show));
    diagramBtn.title = show ? 'Hide the track diagram' : 'Show the track diagram';
    diagramEl.hidden = !show;
    if (!show) {
      diagramKey = '';
      return;
    }
    const b = st.boxes.find((x) => x.id === box.id) ?? box;
    const layout = b.layoutId ? findLayout(st, b.layoutId) : undefined;
    const key = JSON.stringify([layout?.trackPlan, layout?.name, layout?.places.map((y) => y.name), st.settings.diagramLabels, st.boxes.map((x) => [x.id, x.shortName, x.connections.map((c) => [c.id, c.neighbourName, c.neighbourShort])])]);
    if (key === diagramKey) return;
    diagramKey = key;
    const labelsSeg = h(
      'div',
      { class: 'dg-tools', role: 'group', 'aria-label': 'Track labels' },
      ...(['none', 'codes', 'names'] as DiagramLabels[]).map((v) =>
        h('button', { class: 'dg-tool', type: 'button', 'aria-pressed': String(st.settings.diagramLabels === v), on: { click: () => store.update((s) => { s.settings.diagramLabels = v; }) } }, v === 'none' ? 'No labels' : v === 'codes' ? 'Codes' : 'Names'),
      ),
    );
    const editPlan = (label: string) =>
      h('button', { class: 'btn small', type: 'button', on: { click: () => ctx.goFrom(`plan/${layout!.id}`, { route: `box/${box.id}`, label: `${box.name} box` }) } }, label);
    if (!layout || !hasDiagram(layout)) {
      replace(
        diagramEl,
        h(
          'div',
          { class: 'dg-board dg-empty' },
          h('p', null, !layout ? `${box.name} is not on a layout, so there is no track diagram to show.` : `No track has been drawn for ${layout.name} yet. Draw it in the Layout configurator and it will appear here.`),
          layout ? editPlan('Open the Layout configurator') : null,
        ),
      );
      return;
    }
    const svgEl = drawDiagram(st, layout, { boxId: box.id, labels: st.settings.diagramLabels });
    replace(diagramEl, h('div', { class: 'dg-board' }, svgEl, labelsSeg));
  };
  ctx.onLeave(store.subscribe(renderDiagram));
  renderDiagram();

  const header = h(
    'header',
    { class: 'console-head' },
    h('button', { class: 'btn ghost back-btn', type: 'button', on: { click: () => ctx.go('menu') }, 'aria-label': 'Back to main menu' }, '‹', h('span', { class: 'back-word' }, ' Menu')),
    h('h1', { class: 'nameboard' }, box.name),
    clock,
    h('span', { class: `chip ${learner() ? 'chip-learner' : 'chip-strict'}` }, learner() ? 'Learner' : 'Strict'),
    shelfMap,
    h(
      'div',
      { class: 'head-tools' },
      scoreBtn,
      diagramBtn,
      h('button', { class: 'btn small', type: 'button', 'aria-controls': 'side-panel', on: { click: () => side.toggle('codes') } }, 'Bell codes'),
      h('button', { class: 'btn small', type: 'button', 'aria-controls': 'side-panel', on: { click: () => side.toggle('layout') } }, 'Places'),
      h('button', { class: 'btn small', type: 'button', on: { click: () => ctx.goFrom('settings', { route: `box/${box.id}`, label: `${box.name} box` }) } }, 'Settings'),
    ),
  );

  const soundBanner = h(
    'button',
    { class: 'sound-banner', type: 'button', hidden: ctx.bell.ready, on: { click: () => { ctx.bell.unlock(); soundBanner.hidden = true; } } },
    'Sound is off until you tap here (browsers need a tap before playing sound).',
  );
  const onAnyPointer = () => window.setTimeout(() => (soundBanner.hidden = ctx.bell.ready), 100);
  window.addEventListener('pointerdown', onAnyPointer);
  ctx.onLeave(() => window.removeEventListener('pointerdown', onAnyPointer));

  // ---------------------------------------------------------------- shelf
  const shelf = h(
    'section',
    { class: 'shelf', 'aria-label': 'Block shelf' },
    h(
      'div',
      { class: 'shelf-grid', style: `--positions: ${slots.length}` },
      ...slots.map((c, pos) => {
        if (!c) {
          return h('div', { class: 'slot-empty' }, h('span', { class: 'label' }, positionLabel(pos, slots.length)), h('span', null, 'Empty shelf position'));
        }
        const idx = sessions.findIndex((s) => s.connection.id === c.id);
        return uis[idx].caseEl;
      }),
    ),
  );

  // ---------------------------------------------------------------- desk
  const deskTabsEl = h('div', { class: 'desk-tabs', role: 'tablist' });
  const tabs: Array<[DeskTab, string]> = [
    ['arr', 'Arrival'],
    ['dep', 'Departure'],
    ['yard', 'On layout'],
    ['reg', 'Register'],
  ];
  const panel = (t: DeskTab, label: string) => h('section', { class: 'desk-panel', 'data-tab': t, 'aria-label': label });
  const arrPanel = panel('arr', 'Next arrival');
  const depPanel = panel('dep', 'Departure');
  const yardPanel = panel('yard', 'Trains on layout');
  const regPanel = panel('reg', 'Train register');
  const renderTabs = () => {
    replace(
      deskTabsEl,
      ...tabs.map(([t, label]) =>
        h('button', { class: 'desk-tab', type: 'button', role: 'tab', 'aria-selected': String(t === tab), on: { click: () => { tab = t; renderTabs(); } } }, label),
      ),
    );
    for (const p of [arrPanel, depPanel, yardPanel, regPanel]) p.classList.toggle('active', p.dataset.tab === tab);
  };

  // Trains on layout: every location and what is standing there (names all come from the data).
  const renderYard = () => {
    const st = store.state;
    const trainText = (l: Loco) => `${locoFullName(l)}, ${trainTypeName(st, l.working.trainTypeId).toLowerCase()}`;
    const none = [h('dt', { class: 'muted' }, '—'), h('dd', { class: 'muted' }, 'no trains')];
    const group = (loc: RegisterLocation) => {
      let meta = '';
      let rows: HTMLElement[] = [];
      let count = 0;
      if (loc.kind === 'place') {
        meta = loc.roads.length ? `${loc.roads.length} ${loc.roads.length === 1 ? 'road' : 'roads'}` : '';
        rows = loc.roads.flatMap(({ road, locos }) => [
          h('dt', null, road.name),
          h('dd', { class: locos.length ? '' : 'muted' }, locos.length ? locos.map(trainText).join('; ') : 'empty'),
        ]);
        rows.push(...loc.loose.flatMap((l) => [h('dt', null, loc.roads.length ? 'No road' : 'Here'), h('dd', null, trainText(l))]));
        if (!rows.length) rows = none;
        count = loc.roads.reduce((n, r) => n + r.locos.length, 0) + loc.loose.length;
      } else if (loc.kind === 'section') {
        rows = loc.locos.flatMap(({ loco, conn, box: b }) => [h('dt', null, conn && b ? `${b.shortName}–${conn.neighbourShort}` : 'Line'), h('dd', null, trainText(loco))]);
        count = loc.locos.length;
      } else {
        rows = loc.locos.length ? loc.locos.flatMap((l) => [h('dt', null, 'At box'), h('dd', null, trainText(l))]) : none;
        count = loc.locos.length;
      }
      return h(
        'section',
        { class: `reg-loc${loc.kind === 'place' && loc.mine ? ' mine' : ''}` },
        h('h3', { class: 'reg-loc-head' }, h('span', { class: 'reg-loc-name' }, loc.name), h('span', { class: 'reg-loc-meta' }, [meta, `${count} ${count === 1 ? 'train' : 'trains'}`].filter(Boolean).join(' · '))),
        h('dl', { class: 'yard-list' }, ...rows),
      );
    };
    replace(
      yardPanel,
      h('div', { class: 'panel-head' }, h('h2', { class: 'label' }, 'Trains on layout'), h('button', { class: 'btn small', type: 'button', on: { click: () => side.toggle('layout') } }, 'Edit')),
      ...trainsOnLayout(st, box.id).map(group),
    );
  };
  const unsubYard = store.subscribe(renderYard);
  ctx.onLeave(unsubYard);

  const desk = h('div', { class: 'desk' }, deskTabsEl, arrPanel, depPanel, yardPanel, regPanel);

  // ---------------------------------------------------------------- selection
  // The selected instrument case: its tapper (Space bar), register and next step.
  function select(i: number): void {
    if (i < 0 || i >= uis.length) return;
    selected = i;
    uis.forEach((u, j) => u.setSelected(j === i, uis.length > 1));
    replace(regPanel, uis[i].regBody);
    for (const b of shelfMap.querySelectorAll<HTMLElement>('.sm-conn')) b.setAttribute('aria-pressed', String(b.dataset.idx === String(i)));
    renderNextStep();
  }

  // Next arrival and Departure each choose their own line, so a train can be received
  // from one box while another is sent to a different box. Choosing a line there also
  // selects that line's instruments, ready to work its bell.
  let arrIdx = 0;
  let depIdx = 0;
  const arrBar = h('div', { class: 'line-bar' });
  const depBar = h('div', { class: 'line-bar' });
  const arrHost = h('div');
  const depHost = h('div');
  arrPanel.append(arrBar, arrHost);
  depPanel.append(depBar, depHost);
  const barKeys = new Map<HTMLElement, string>();
  const renderBar = (bar: HTMLElement, which: 'arr' | 'dep') => {
    const idx = which === 'arr' ? arrIdx : depIdx;
    const lead = which === 'arr' ? 'Next arrival from' : 'Departure to';
    const busy = (i: number) => {
      const v = sessions[i].controller.view;
      if (which === 'arr' && v.incoming) return v.incoming.departed ? ' (train on its way)' : ' (train offered)';
      if (which === 'dep' && v.outgoing?.departed) return v.outgoing.arrived ? ' (train arrived)' : ' (train on its way)';
      return '';
    };
    const labels = sessions.map((s, i) => `${s.connection.neighbourName}${busy(i)}`);
    const key = JSON.stringify([idx, labels]);
    if (barKeys.get(bar) === key) return;
    barKeys.set(bar, key);
    if (sessions.length <= 1) {
      replace(bar, h('h2', { class: 'label' }, `${lead} ${sessions[0]?.connection.neighbourName ?? ''}`));
      return;
    }
    const id = `line_${which}`;
    replace(
      bar,
      h('label', { class: 'label', for: id }, lead),
      h(
        'select',
        { id, class: 'line-select', on: { change: (e: Event) => showLine(which, Number((e.target as HTMLSelectElement).value)) } },
        ...labels.map((label, i) => option(String(i), label, i === idx)),
      ),
    );
  };
  function showLine(which: 'arr' | 'dep', i: number, selectCase = true): void {
    if (i < 0 || i >= uis.length) return;
    if (which === 'arr') {
      arrIdx = i;
      replace(arrHost, uis[i].arrBody);
      renderBar(arrBar, 'arr');
    } else {
      depIdx = i;
      replace(depHost, uis[i].depBody);
      renderBar(depBar, 'dep');
    }
    if (selectCase) select(i);
  }
  for (const s of sessions) {
    const off = s.controller.events.on('change', () => {
      renderBar(arrBar, 'arr');
      renderBar(depBar, 'dep');
    });
    ctx.onLeave(off);
  }

  // Space bar = the selected group's tapper.
  const typing = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'BUTTON' && !el.classList.contains('tapper')));
  };
  const kd = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || e.repeat || typing(e.target)) return;
    e.preventDefault();
    uis[selected]?.tapPress();
  };
  const ku = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || typing(e.target)) return;
    e.preventDefault();
    uis[selected]?.tapRelease();
  };
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  ctx.onLeave(() => {
    window.removeEventListener('keydown', kd);
    window.removeEventListener('keyup', ku);
  });

  const unsubStep = store.subscribe(renderNextStep);
  ctx.onLeave(unsubStep);

  // When a through train needs work on another line (e.g. offering it on), select that line's instruments once.
  let lastThroughKey = '';
  ctx.onLeave(
    runtime.workings.onChange(() => {
      const tg = runtime.workings.guidance();
      const key = tg ? `${tg.connId}|${tg.text}` : '';
      if (key !== lastThroughKey) {
        lastThroughKey = key;
        const i = tg ? runtime.conns.findIndex((x) => x.session.connection.id === tg.connId) : -1;
        // The Departure panel follows the line the through train is being offered on to.
        if (i >= 0 && tg && runtime.workings.throughTo(tg.connId) && depIdx !== i) showLine('dep', i, false);
        if (i >= 0 && i !== selected) select(i);
        else renderNextStep();
      }
    }),
  );  renderTabs();
  if (uis.length) {
    showLine('arr', 0, false);
    showLine('dep', 0, false);
    select(0);
  }
  renderYard();
  renderNextStep();

  return {
    title: `${box.name} box`,
    live: true,
    el: h(
      'main',
      { class: 'console' },
      header,
      soundBanner,
      diagramEl,
      nextStep,
      h('div', { class: 'console-main' }, shelf, desk),
      side.el,
    ),
  };
}

// =============================================================================
// One connection: its instrument group on the shelf and its desk panels
// =============================================================================

function connectionUI(ctx: Ctx, box: BoxDef, cr: ConnRuntime, onGuidance: () => void, onSelect: () => void, workings: ThroughWorkings, allConns: ConnectionDef[]): ConnectionUI {
  const store = ctx.store;
  const c = cr.session.controller;
  const conn = cr.session.connection;
  // Controller listeners are removed when the screen closes; the box itself keeps running.
  const offs: Array<() => void> = [];
  ctx.onLeave(() => offs.forEach((off) => off()));
  const st = () => store.state;
  const learner = () => st().settings.strictness === 'learner';
  const codeSet = () => activeCodeSet(st());
  const short = conn.neighbourShort;

  let incSel = '';
  /** Where the incoming train is put when it arrives: 'placeId|roadId' of a place this box works. */
  let arrAt = '';
  let outSel = '';
  let arrRoad = '';
  let lastHint = '';
  let hintAt = 0;

  /** Where a train in this box's places stands, briefly: "P1", "Becton sidings · Coal siding". */
  const whereAtBox = (l: Loco) => {
    const loc = l.location;
    if (loc.kind === 'atBox') return 'At box';
    if (loc.kind !== 'place') return locationText(st(), l);
    const p = findPlace(st(), loc.placeId);
    const r = findRoad(p, loc.roadId);
    return r ? (/^(p\d|platform)/i.test(r.name) ? r.name : `${p?.name} · ${r.name}`) : (p?.name ?? '');
  };
  /** Where an incoming candidate stands: its road at the far end, or the roster. */
  const whereFrom = (l: Loco) => {
    const loc = l.location;
    if (loc.kind === 'offLayout') return 'Roster';
    if (loc.kind !== 'place') return locationText(st(), l);
    return findRoad(findPlace(st(), loc.placeId), loc.roadId)?.name ?? placeLocationText(st(), loc);
  };
  const farPlaceName = () => {
    const state = st();
    const b = state.boxes.find((x) => x.id === box.id) ?? box;
    return farPlace(state, b, conn)?.name ?? '';
  };
  /** The roads of the places this box works, for putting an arriving train on (none for a junction box). */
  const arrivalKey = () => JSON.stringify(arrivalChoices(st(), box.id));
  const arrivalSelect = (id: string): HTMLSelectElement | null => {
    const state = st();
    const choices = arrivalChoices(state, box.id);
    if (!choices.length) return null;
    const val = (x: { placeId: string; roadId: string }) => `${x.placeId}|${x.roadId}`;
    const occ = new Set(state.roster.flatMap((l) => (l.location.kind === 'place' && l.location.roadId ? [val(l.location)] : [])));
    if (!arrAt || !choices.some((x) => val(x) === arrAt)) arrAt = val(choices.find((x) => !occ.has(val(x))) ?? choices[0]);
    return h(
      'select',
      { id, 'aria-label': 'Where it arrived', on: { change: (e: Event) => (arrAt = (e.target as HTMLSelectElement).value) } },
      ...choices.map((x) => option(val(x), `${choices.every((y) => y.placeId === x.placeId) && x.roadId ? x.label.split(' · ').slice(1).join(' · ') : x.label}${occ.has(val(x)) ? ' (occupied)' : ''}`, val(x) === arrAt)),
    );
  };
  const arrivalTarget = () => {
    if (!arrivalChoices(st(), box.id).length || !arrAt) return null;
    const [placeId, roadId] = arrAt.split('|');
    return { placeId, roadId: roadId ?? '' };
  };

  /** The train on this line has arrived (stopped here) or passed (a through train sent on). */
  const arrived = () => {
    if (workings.through(conn.id)) c.confirmIncomingArrived(null, { moveLoco: !workings.keepLocoWhereItIs(conn.id) });
    else c.confirmIncomingArrived(arrivalTarget());
  };
  /** Where the incoming train goes at this box: stop here, or on along another line (offering it on). */
  const routeField = (): HTMLElement | null => {
    const others = allConns.filter((x) => x.id !== conn.id);
    if (!others.length || !c.view.incoming) return null;
    const thr = workings.through(conn.id);
    const id = `route_${conn.id}`;
    const stopLabel = `Stop at ${box.name} (${arrivalChoices(st(), box.id).length ? 'into a road' : 'stands at the box'})`;
    return h(
      'div',
      { class: 'field route-field' },
      h('label', { for: id }, 'Route'),
      h(
        'select',
        {
          id,
          disabled: thr?.stage === 'sentOn' || thr?.stage === 'passed',
          on: {
            change: (e: Event) => {
              const err = workings.setRoute(conn.id, (e.target as HTMLSelectElement).value);
              if (err) toast(err);
            },
          },
        },
        option('', stopLabel, !thr),
        ...others.map((x) => option(x.id, `On to ${x.neighbourName} (offer it on)`, thr?.toConnId === x.id)),
      ),
      thr
        ? h('small', { class: 'help' }, thr.blocked ? `Another train is chosen to depart to ${allConns.find((x) => x.id === thr.toConnId)?.neighbourName}.` : 'Once you have accepted it, offer it on: call attention on that line, then send its Is line clear code.')
        : null,
    );
  };

  /** A brass button that works once: it disables itself as soon as it is pressed, so a double click reports nothing twice. */
  const onceButton = (label: string, fn: () => void) =>
    h('button', { class: 'btn primary', type: 'button', on: { click: (e: Event) => { const b = e.currentTarget as HTMLButtonElement; if (b.disabled) return; b.disabled = true; fn(); } } }, label);

  const keyed = new Map<HTMLElement, string>();
  const mount = (el: HTMLElement, key: string, render: () => void) => {
    if (keyed.get(el) === key) return;
    keyed.set(el, key);
    render();
  };

  // ------------------------------------------------------------- describer
  const describer = h('div', { class: 'describer', 'aria-live': 'polite' });
  const renderDescriber = () => {
    const v = c.view;
    const state = st();
    let dir = '';
    let code = '';
    let text = '';
    let stage = '';
    if (v.incoming) {
      const l = state.roster.find((x) => x.id === v.incoming!.locoId);
      dir = `FROM ${short}`;
      code = trainCode(codeSet(), v.incoming.trainTypeId);
      text = `${trainTypeName(state, v.incoming.trainTypeId)} · ${l ? locoName(l) : ''}${l?.dccAddress ? ` · DCC ${l.dccAddress}` : ''}`;
      const accepted = v.mode === 'ab' ? v.myInstrument !== 'LB' : v.tokenIndicator === 'coming';
      stage = v.incoming.arrived ? 'ARRIVED' : v.incoming.departed ? 'ON LINE' : accepted ? 'ACCEPTED' : 'OFFERED';
    } else if (v.outgoing?.locoId) {
      const l = state.roster.find((x) => x.id === v.outgoing!.locoId);
      const tt = v.outgoing.trainTypeId ?? l?.working.trainTypeId ?? '';
      dir = `TO ${short}`;
      code = trainCode(codeSet(), tt);
      text = `${trainTypeName(state, tt)} · ${l ? locoName(l) : ''}${l?.dccAddress ? ` · DCC ${l.dccAddress}` : ''}`;
      const accepted = v.mode === 'ab' ? v.remoteInstrument !== 'LB' : v.tokenWithdrawnHere || v.releaseAvailable;
      stage = v.outgoing.arrived ? 'ARRIVED' : v.outgoing.departed ? 'ON LINE' : accepted ? 'LINE CLEAR' : 'READY TO OFFER';
    }
    mount(describer, JSON.stringify([dir, code, text, stage, v.boxOpen]), () => {
      describer.classList.toggle('empty', !dir);
      if (!dir) {
        replace(describer, h('span', null, v.boxOpen ? '— NO TRAIN DESCRIBED —' : '— BOX CLOSED · OPEN WITH 5-5-5 —'));
        return;
      }
      replace(
        describer,
        h('span', { class: 'd-dir' }, dir),
        code ? h('span', { class: 'd-code' }, code) : null,
        h('span', { class: 'd-text' }, text.toUpperCase()),
        h('span', { class: 'd-stage' }, stage),
      );
    });
  };

  // ------------------------------------------------------------- bell
  const dome = h('div', { class: 'bell-dome', role: 'img', 'aria-label': `Block bell from ${conn.neighbourName}` });
  const bellCode = h('span', { class: 'bell-code' }, '—');
  const bellDesc = h('span', { class: 'bell-desc' });
  const renderBellText = () => {
    const lastBell = cr.lastBell;
    if (!lastBell) return;
    const showText = st().settings.showReceivedCodeText;
    bellCode.textContent = showText ? lastBell.code : beatDots(lastBell.code);
    bellDesc.textContent = showText ? describeCode(lastBell.code, codeSet(), st().trainTypes) + (lastBell.hold ? ' (held)' : '') : '';
  };
  const flash = () => {
    dome.classList.remove('ring');
    void dome.offsetWidth;
    dome.classList.add('ring');
  };
  // The bell itself is rung by the box runtime; here we only flash the dome and show the code.
  cr.onBeat = (beat) => {
    flash();
    if (beat === 0) renderBellText();
  };
  ctx.onLeave(() => (cr.onBeat = null));
  renderBellText();
  const bellCol = h(
    'div',
    { class: 'bell-col' },
    dome,
    bellCode,
    bellDesc,
    h('button', { class: 'btn small', type: 'button', on: { click: () => cr.lastBell && ctx.bell.ring(cr.lastBell.code, flash) } }, 'Ring again'),
  );

  // ------------------------------------------------------------- instruments
  const instEl = h('div', { class: 'inst-area' });
  const face = (s: InstrumentState) =>
    h('div', { class: `face face-${s}`, role: 'img', 'aria-label': instrumentName(s) }, h('span', { class: 'face-label' }, 'Showing'), h('strong', null, instrumentName(s)));
  const renderInstruments = () => {
    const v = c.view;
    mount(instEl, JSON.stringify(v, ['mode', 'myInstrument', 'remoteInstrument', 'tokenIndicator', 'tokensInInstrument', 'tokenWithdrawnHere', 'tokenInHand', 'releaseAvailable']), () => {
      if (v.mode === 'ab') {
        // Midland Railway pattern: Train On Line left, Line Blocked centre, Line Clear right.
        const order: InstrumentState[] = ['TOL', 'LB', 'LC'];
        const words: Record<InstrumentState, string> = { TOL: 'On Line', LB: 'Blocked', LC: 'Clear' };
        replace(
          instEl,
          h(
            'div',
            { class: 'inst-col' },
            h('span', { class: 'inst-label' }, `Yours · trains from ${short}`),
            face(v.myInstrument),
            h(
              'div',
              { class: 'commutator', role: 'group', 'aria-label': 'Block instrument commutator' },
              ...order.map((s) =>
                h('button', { class: `pos pos-${s}`, type: 'button', 'aria-pressed': String(v.myInstrument === s), 'aria-label': instrumentName(s), on: { click: () => c.setInstrument(s) } }, words[s]),
              ),
            ),
          ),
          h(
            'div',
            { class: 'inst-col' },
            h('span', { class: 'inst-label' }, `${short} repeater · trains to ${short}`),
            face(v.remoteInstrument),
            h('span', { class: 'inst-note' }, `Worked by ${conn.neighbourName}`),
          ),
        );
      } else {
        const ind = v.tokenIndicator === 'normal' ? 'Line normal' : v.tokenIndicator === 'coming' ? `Train coming from ${short}` : `Train going to ${short}`;
        const state = v.tokenWithdrawnHere ? 'Token out: give it to the driver.' : v.tokenInHand ? 'Token from driver: replace it.' : '';
        replace(
          instEl,
          h(
            'div',
            { class: 'inst-col token-col' },
            h('span', { class: 'inst-label' }, 'Electric key token instrument'),
            h('div', { class: `token-face ind-${v.tokenIndicator}` }, h('span', { class: 'face-label' }, 'Indicator'), h('strong', null, ind)),
            h(
              'div',
              { class: `needle ${v.releaseAvailable ? 'deflected' : ''}` },
              h('span', { class: 'needle-arm', 'aria-hidden': 'true' }),
              h('span', null, v.releaseAvailable ? `Release from ${short}` : 'Needle upright'),
              h('span', { class: 'token-count' }, `Tokens: ${v.tokensInInstrument}`),
            ),
            state ? h('p', { class: 'token-state' }, state) : null,
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'btn', type: 'button', on: { click: () => { const e = c.withdrawToken(); if (e) toast(e); } } }, 'Withdraw token'),
              h('button', { class: 'btn', type: 'button', on: { click: () => { const e = c.replaceToken(); if (e) toast(e); } } }, 'Replace token'),
            ),
          ),
        );
      }
    });
  };

  // ------------------------------------------------------------- tapper + code card
  const tapDisplay = h('span', { class: 'tap-display', 'aria-live': 'polite' }, ' ');
  const showSent = (code: string, hold: boolean) => {
    tapDisplay.textContent = `Sent ${code}${hold ? ' (held)' : ''}`;
    tapDisplay.classList.add('sent');
  };
  const decoder = new TapDecoder(
    () => st().settings.tap,
    realScheduler,
    (code, hold) => {
      c.sendBell(code, hold);
      showSent(code, hold);
    },
    (p) => {
      if (p.groups.length === 0) return;
      tapDisplay.classList.remove('sent');
      tapDisplay.textContent = p.groups.map((n) => '•'.repeat(n)).join('  ') + `  ${p.groups.join('-')}${p.holding ? ' holding' : ''}`;
    },
  );
  const tapper = h('button', { class: 'tapper', type: 'button', 'aria-label': `Bell tapper to ${conn.neighbourName}. Press in rhythm; the space bar also works.` }, 'Tapper');
  const press = () => {
    ctx.bell.unlock();
    ctx.bell.click();
    tapper.classList.add('down');
    decoder.press();
  };
  const release = () => {
    tapper.classList.remove('down');
    decoder.release();
  };
  tapper.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      tapper.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    onSelect();
    press();
  });
  tapper.addEventListener('pointerup', release);
  tapper.addEventListener('pointercancel', release);
  tapper.addEventListener('contextmenu', (e) => e.preventDefault());

  const send = (code: string, hold = false) => {
    ctx.bell.unlock();
    onSelect();
    c.sendBell(code, hold);
    showSent(code, hold);
  };

  const holdBox = h('input', { type: 'checkbox', id: `cc_hold_${conn.id}` });
  const card = h('div', { class: 'code-card', hidden: true, role: 'dialog', 'aria-label': 'Bell code card' });
  const renderCard = () => {
    const set = codeSet();
    const item = (code: string, label: string) =>
      h('button', { class: 'cc-code', type: 'button', on: { click: () => { send(code, holdBox.checked); holdBox.checked = false; card.hidden = true; } } }, h('strong', null, code), h('span', null, label));
    const seen = new Set<string>();
    const trainItems = st()
      .trainTypes.filter((t) => set.trainCodes[t.id])
      .filter((t) => {
        const k = set.trainCodes[t.id].code + t.name;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((t) => item(set.trainCodes[t.id].code, `${t.name} (${set.trainCodes[t.id].classLabel})`));
    replace(
      card,
      h('div', { class: 'cc-head' }, h('strong', null, 'Bell code card'), h('button', { class: 'cc-close', type: 'button', 'aria-label': 'Close code card', on: { click: () => (card.hidden = true) } }, '✕')),
      h('label', { class: 'check', for: holdBox.id }, holdBox, 'Hold the last beat (token release)'),
      h('p', { class: 'cc-sub' }, 'Signals'),
      ...REGULATION_SIGNALS.map((r) => item(signalCode(set, r.id), r.name)),
      h('p', { class: 'cc-sub' }, 'Is line clear'),
      ...trainItems,
    );
  };
  renderCard();

  // Quick-send chips: the opening code until the box is open, then the everyday codes.
  const chipsEl = h('div', { class: 'chips' });
  const chip = (id: string, label: string) =>
    h('button', { class: 'btn code-chip', type: 'button', on: { click: () => send(signalCode(codeSet(), id)) } }, h('strong', null, signalCode(codeSet(), id)), h('span', null, label));
  const renderChips = () => {
    const open = c.view.boxOpen;
    mount(chipsEl, JSON.stringify([open, codeSet().id]), () => {
      const cardBtn = h('button', { class: 'btn code-chip', type: 'button', 'aria-haspopup': 'dialog', on: { click: () => { renderCard(); card.hidden = !card.hidden; } } }, h('span', null, 'Code card ▾'));
      replace(
        chipsEl,
        ...(open
          ? [chip('call_attention', 'Call attn'), chip('train_entering_section', 'Entering'), chip('train_out_of_section', 'Out of section'), cardBtn]
          : [chip('call_attention', 'Call attn'), chip('opening', 'Open box'), cardBtn]),
      );
    });
  };

  const tapperRow = h(
    'div',
    { class: 'tapper-row' },
    tapper,
    h(
      'div',
      { class: 'tap-side' },
      tapDisplay,
      chipsEl,
    ),
  );

  // ------------------------------------------------------------- arrival action (on the case)
  // Not prototypical, but it is how the operator tells the app the train is in, so keep it by the instruments.
  const actionEl = h('div', { class: 'case-action' });
  const renderAction = () => {
    const inc = c.view.incoming;
    const show = !!inc && inc.departed && !inc.arrived;
    mount(actionEl, JSON.stringify([show, inc?.locoId, arrivalKey(), workings.through(conn.id)]), () => {
      actionEl.hidden = !show;
      if (!show || !inc) return replace(actionEl);
      const l = st().roster.find((x) => x.id === inc.locoId);
      const thr = workings.through(conn.id);
      replace(
        actionEl,
        h(
          'button',
          { class: 'btn arrived-btn', type: 'button', on: { click: (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; arrived(); } } },
          `${l ? locoName(l) : 'Train'} ${thr?.stage === 'sentOn' ? 'passed complete' : 'arrived complete'}`,
          h('span', null, 'tail lamp seen'),
        ),
        thr ? null : arrivalSelect(`cparr_${conn.id}`),
      );
    });
  };

  // ------------------------------------------------------------- the case
  const caseEl = h(
    'article',
    { class: 'case', 'aria-label': `Instruments for ${conn.neighbourName}`, on: { pointerdown: () => onSelect() } },
    h(
      'div',
      { class: 'case-head' },
      h('span', { class: 'plate' }, conn.neighbourName),
      h('span', { class: 'case-sub' }, `${conn.lineType === 'single' ? 'Single line' : 'Double line'} · ${c.view.mode === 'token' ? 'Key token' : 'Absolute block'}`),
    ),
    describer,
    h('div', { class: 'case-instruments' }, bellCol, instEl),
    actionEl,
    tapperRow,
    card,
  );

  // ------------------------------------------------------------- desk: arrival
  const arrBody = h('div', { class: 'desk-body' });
  const renderIncoming = () => {
    const v = c.view;
    const state = st();
    const candidates = incomingCandidates(state, conn);
    if (incSel && !candidates.some((l) => l.id === incSel) && !v.incoming) incSel = '';
    const thr = workings.through(conn.id);
    const key = JSON.stringify([v.boxOpen, v.incoming, incSel, state.settings.selectionMode, candidates.map((l) => [l.id, l.working, l.location, l.number, l.locoClass, l.name]), codeSet().id, thr, workings.route(conn.id), arrivalKey()]);
    mount(arrBody, key, () => {
      const title = null; // the panel's line bar names the line ("Next arrival from …")
      if (!v.incoming) {
        const sel = h(
          'select',
          { id: `inc_${conn.id}`, on: { change: (e: Event) => { incSel = (e.target as HTMLSelectElement).value; renderIncoming(); } } },
          option('', candidates.length ? 'Choose a train…' : farPlaceName() ? `No trains in ${farPlaceName()}` : 'No trains off the layout', !incSel),
          ...candidates.map((l) => option(l.id, `${whereFrom(l)}: ${locoFullName(l)}, ${trainTypeName(state, l.working.trainTypeId).toLowerCase()}`, l.id === incSel)),
        );
        const chosen = candidates.find((l) => l.id === incSel);
        const modeSel = h(
          'select',
          { id: `incmode_${conn.id}`, 'aria-label': 'How the next train is chosen', on: { change: (e: Event) => store.update((s) => { s.settings.selectionMode = (e.target as HTMLSelectElement).value as 'manual' | 'random'; }) } },
          ...Object.values(SELECTORS).map((x) => option(x.id, x.name, x.id === state.settings.selectionMode)),
        );
        replace(
          arrBody,
          title,
          h(
            'div',
            { class: 'quick-row' },
            modeSel,
            state.settings.selectionMode === 'random'
              ? h('button', { class: 'btn small', type: 'button', on: { click: () => { const id = SELECTORS.random.suggest(candidates, state); if (id) { incSel = id; renderIncoming(); } } } }, 'Pick at random')
              : null,
          ),
          h('div', { class: 'field' }, h('label', { for: sel.id }, 'Next train'), sel),
          chosen ? workingEditor(chosen.id, 'Working for this train') : null,
          h(
            'button',
            {
              class: 'btn primary wide',
              type: 'button',
              id: `offer_${conn.id}`,
              disabled: !chosen || !v.boxOpen,
              on: {
                click: () => {
                  if (!chosen) return;
                  ctx.bell.unlock();
                  const err = c.requestIncoming(chosen.id, chosen.working.trainTypeId);
                  if (err) toast(err);
                  else arrAt = '';
                },
              },
            },
            'Offer next incoming train',
          ),
          h('p', { class: 'muted small' }, v.boxOpen ? `${conn.neighbourName} will call attention and offer the train on the bell.` : 'Open the box first: tap 1 (call attention), then send 5-5-5 (Opening of signal box).'),
        );
      } else {
        const inc = v.incoming;
        const onward = thr ? allConns.find((x) => x.id === thr.toConnId) : undefined;
        const status = !inc.departed
          ? `Being offered. Don't move the train until ${short} sends 2 (Train entering section).`
          : !inc.arrived
            ? thr?.stage === 'sentOn'
              ? `Sent on towards ${onward?.neighbourName}. Report it passed complete once its tail lamp has passed.`
              : onward
                ? `Despatched. It runs through ${box.name} to ${onward.neighbourName}.`
                : `Despatched. Drive it into ${box.name}.`
            : 'Arrived. Call attention, then send 2-1.';
        const arrSel = thr ? null : arrivalSelect(`parr_${conn.id}`);
        replace(
          arrBody,
          title,
          trainCard(inc.locoId, inc.trainTypeId),
          routeField(),
          h('p', { class: `status ${inc.departed ? 'go' : ''}` }, status),
          inc.departed && !inc.arrived
            ? h(
                'div',
                { class: 'quick-row' },
                arrSel ? h('label', { for: arrSel.id }, 'Into') : null,
                arrSel,
                onceButton(thr?.stage === 'sentOn' ? 'Train passed complete' : thr ? 'Train arrived (standing here)' : 'Train arrived complete', arrived),
              )
            : null,
          !inc.departed ? confirmButton('Cancel this train', 'Press again to cancel', () => c.cancelIncoming(), 'btn ghost danger') : null,
        );
      }
    });
  };

  // ------------------------------------------------------------- desk: departure
  const depBody = h('div', { class: 'desk-body' });
  const renderOutgoing = () => {
    const v = c.view;
    const state = st();
    const inStation = stationLocos(state, box.id);
    const b = state.boxes.find((x) => x.id === box.id) ?? box;
    const place = farPlace(state, b, conn);
    const accepted = v.mode === 'ab' ? v.remoteInstrument === 'LC' : v.tokenWithdrawnHere || v.releaseAvailable;
    const occupied = new Set(state.roster.flatMap((l) => (l.location.kind === 'place' && l.location.placeId === place?.id ? [l.location.roadId] : [])));
    if (!arrRoad || !place?.roads.some((r) => r.id === arrRoad)) arrRoad = place?.roads.find((r) => !occupied.has(r.id))?.id ?? place?.roads[0]?.id ?? '';
    const key = JSON.stringify([v.outgoing, outSel, accepted, arrRoad, place?.name, place?.roads, inStation.map((l) => [l.id, l.working, l.location, l.number, l.locoClass, l.name]), [...occupied], codeSet().id, workings.throughTo(conn.id)]);
    mount(depBody, key, () => {
      const title = null; // the panel's line bar names the line ("Departure to …")
      const out = v.outgoing;
      if (out?.departed) {
        const roadSel = h(
          'select',
          { id: `road_${conn.id}`, on: { change: (e: Event) => { arrRoad = (e.target as HTMLSelectElement).value; } } },
          ...(place?.roads ?? []).map((r) => option(r.id, `${r.name}${occupied.has(r.id) ? ' (occupied)' : ''}`, r.id === arrRoad)),
        );
        replace(
          depBody,
          title,
          out.locoId ? trainCard(out.locoId, out.trainTypeId ?? state.roster.find((l) => l.id === out.locoId)?.working.trainTypeId ?? '') : h('p', null, 'Train on line.'),
          out.arrived
            ? h('p', { class: 'status go' }, `Arrived at ${place?.name ?? conn.neighbourName}. ${conn.neighbourName} will call attention and send 2-1 (Train out of section).`)
            : place?.roads.length
              ? [
                  h('p', { class: 'status go' }, `On line to ${conn.neighbourName}. Drive it into ${place.name}.`),
                  h('div', { class: 'quick-row' }, h('label', { for: roadSel.id }, 'Into road'), roadSel, onceButton(arrivedLabel(place, conn.neighbourName), () => c.confirmOutgoingArrived(arrRoad, out.locoId))),
                ]
              : [
                  h('p', { class: 'status go' }, place ? `On line to ${conn.neighbourName}. Drive it to ${place.name}, then press below when it has arrived complete.` : `On line to ${conn.neighbourName}. Drive it there (it goes back to the roster), then press below when it has arrived complete.`),
                  onceButton(arrivedLabel(place, conn.neighbourName), () => c.confirmOutgoingArrived('', out.locoId)),
                ],
        );
        return;
      }
      const thrTo = workings.throughTo(conn.id);
      const thrLoco = thrTo && !thrTo.blocked ? state.roster.find((l) => l.id === thrTo.locoId) : undefined;
      const fromName = thrTo ? allConns.find((x) => x.id === thrTo.fromConnId)?.neighbourName ?? '' : '';
      if (thrLoco && !inStation.some((l) => l.id === thrLoco.id)) outSel = thrLoco.id;
      if (outSel && !inStation.some((l) => l.id === outSel) && outSel !== thrLoco?.id) outSel = '';
      const sel = h(
        'select',
        {
          id: `out_${conn.id}`,
          on: {
            change: (e: Event) => {
              outSel = (e.target as HTMLSelectElement).value;
              // Choosing another train for this line stops the through train here instead.
              if (thrTo && outSel !== thrTo.locoId) workings.setRoute(thrTo.fromConnId, '');
              const l = st().roster.find((x) => x.id === outSel);
              c.setOutgoing(outSel || null, l?.working.trainTypeId ?? null);
              renderOutgoing();
            },
          },
        },
        option('', inStation.length ? 'Choose a train…' : `No trains in ${box.name} station`, !outSel),
        ...inStation.map((l) => option(l.id, `${whereAtBox(l)}: ${locoFullName(l)}, ${trainTypeName(state, l.working.trainTypeId).toLowerCase()}`, l.id === outSel)),
        ...(thrLoco && !inStation.some((l) => l.id === thrLoco.id) ? [option(thrLoco.id, `Through from ${fromName}: ${locoFullName(thrLoco)}, ${trainTypeName(state, thrTo!.trainTypeId).toLowerCase()}`, outSel === thrLoco.id)] : []),
      );
      const chosen = inStation.find((l) => l.id === outSel) ?? (thrLoco?.id === outSel ? thrLoco : undefined);
      const code = chosen ? trainCode(codeSet(), chosen.working.trainTypeId) : '';
      replace(
        depBody,
        title,
        h('div', { class: 'field' }, h('label', { for: sel.id }, 'Departing train'), sel),
        chosen ? workingEditor(chosen.id, 'Working for this departure') : null,
        chosen
          ? h('p', null, code ? ['Offer with ', h('strong', null, signalCode(codeSet(), 'call_attention')), ', then ', h('strong', null, code), '.'] : 'This working has no bell code in the current code set.')
          : h('p', { class: 'muted small' }, farPlaceName() ? `Choose the train before offering it, so the app can move it to ${farPlaceName()} when it arrives.` : `Choose the train before offering it. ${conn.neighbourName} has no place on the layout, so it goes back to the roster when it arrives.`),
        accepted
          ? h('p', { class: 'status go' }, v.mode === 'ab' ? (thrLoco && outSel === thrLoco.id ? 'Line clear: clear your signals for the through train. Send 2 as it passes your box.' : 'Line clear: clear your starting signal. Send 2 as it departs.') : v.tokenWithdrawnHere ? 'Token out: hand it to the driver, clear your signal, send 2 as it departs.' : 'Release given: withdraw the token now.')
          : null,
      );
    });
  };

  function workingEditor(locoId: string, heading: string): HTMLElement {
    const state = st();
    const l = state.roster.find((x) => x.id === locoId)!;
    const set = codeSet();
    const upd = (fn: (w: typeof l.working) => void) =>
      store.update((s) => {
        const x = s.roster.find((y) => y.id === locoId);
        if (x) fn(x.working);
      });
    const idp = `w_${conn.id}_${heading.slice(-3)}_${locoId}`;
    const sel = h(
      'select',
      { id: `${idp}_tt`, on: { change: (e: Event) => upd((w) => (w.trainTypeId = (e.target as HTMLSelectElement).value)) } },
      ...state.trainTypes.map((t) => option(t.id, `${t.name}${set.trainCodes[t.id] ? `  (${set.trainCodes[t.id].code})` : '  (no code)'}`, t.id === l.working.trainTypeId)),
    );
    const consist = h('input', { id: `${idp}_cs`, type: 'text', value: l.working.consist, placeholder: 'e.g. 4 coaches', on: { change: (e: Event) => upd((w) => (w.consist = (e.target as HTMLInputElement).value.trim())) } });
    const headcode = h('input', { id: `${idp}_hc`, type: 'text', value: l.working.headcode, placeholder: 'optional', on: { change: (e: Event) => upd((w) => (w.headcode = (e.target as HTMLInputElement).value.trim())) } });
    return h(
      'fieldset',
      { class: 'working-editor' },
      h('legend', null, heading),
      h('div', { class: 'we-grid' },
        h('div', { class: 'field we-type' }, h('label', { for: sel.id }, 'Working as'), sel),
        h('div', { class: 'field' }, h('label', { for: consist.id }, 'Consist'), consist),
        h('div', { class: 'field' }, h('label', { for: headcode.id }, 'Headcode'), headcode),
      ),
    );
  }

  function trainCard(locoId: string, trainTypeId: string): HTMLElement {
    const state = st();
    const l = state.roster.find((x) => x.id === locoId);
    const entry = codeSet().trainCodes[trainTypeId];
    return h(
      'div',
      { class: 'train-card' },
      h('div', { class: 'dcc' }, h('span', { class: 'face-label' }, 'DCC'), h('strong', { class: 'num' }, l?.dccAddress || '—')),
      h(
        'div',
        { class: 'train-info' },
        h('h3', null, locoName(l)),
        h('p', { class: 'muted' }, [l?.locoClass, l?.working.consist].filter(Boolean).join(' · ')),
        h('p', null, trainTypeName(state, trainTypeId), entry ? [' · ', h('strong', null, entry.code), ` · ${entry.classLabel}`] : null, l?.working.headcode ? ` · ${l.working.headcode}` : ''),
      ),
    );
  }

  // ------------------------------------------------------------- desk: register
  const logList = h('ol', { class: 'log', reversed: true });
  const irrEl = h('p', { class: 'muted small' });
  const addLogItem = (e: LogEntry) => {
    if (e.kind === 'hint' && !learner()) return;
    const t = new Date(e.t);
    const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    logList.insertBefore(h('li', { class: `log-${e.kind}` }, h('time', null, time), h('span', null, e.text)), logList.firstChild);
    while (logList.children.length > 150) logList.lastChild?.remove();
    irrEl.textContent = c.irregularities.length ? `Irregularities this session: ${c.irregularities.length}` : '';
  };
  const regBody = h(
    'div',
    { class: 'desk-body' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { class: 'label' }, `Train register · ${conn.neighbourName}`),
      confirmButton('Clear', 'Press again to clear', () => {
        c.clearLog();
        logList.replaceChildren();
        irrEl.textContent = '';
      }, 'btn ghost small'),
    ),
    irrEl,
    logList,
  );
  for (const e of c.log) addLogItem(e);
  offs.push(c.events.on('log', addLogItem));
  offs.push(c.events.on('hint', (hn) => {
    if (!learner()) return;
    lastHint = hn.text;
    hintAt = Date.now();
    onGuidance();
  }));

  // ------------------------------------------------------------- wiring
  const syncOutgoing = () => {
    const out = c.view.outgoing;
    if (!outSel || out?.departed) return;
    const l = st().roster.find((x) => x.id === outSel);
    if (l && stationLocos(st(), box.id).some((x) => x.id === l.id) && (out?.locoId !== l.id || out?.trainTypeId !== l.working.trainTypeId)) c.setOutgoing(l.id, l.working.trainTypeId);
  };
  let lastGuidance = '';
  const renderAll = () => {
    renderDescriber();
    renderInstruments();
    renderAction();
    renderChips();
    renderIncoming();
    renderOutgoing();
    if (c.view.guidance !== lastGuidance) {
      lastGuidance = c.view.guidance;
      if (Date.now() - hintAt > 1500) lastHint = '';
      onGuidance();
    }
  };
  offs.push(c.events.on('change', renderAll));
  // Through trains link two lines: a change on one can change what the other shows.
  offs.push(workings.onChange(renderAll));
  const unsub = store.subscribe(() => {
    syncOutgoing();
    renderBellText();
    renderAll();
  });
  ctx.onLeave(unsub);
  renderAll();

  return {
    caseEl,
    arrBody,
    depBody,
    regBody,
    guidance: () => ({ text: c.view.guidance, hint: lastHint }),
    busy: () => !!(c.view.incoming || c.view.outgoing?.departed),
    name: conn.neighbourName,
    tapPress: press,
    tapRelease: release,
    setSelected: (on, many) => {
      caseEl.classList.toggle('selected', on);
      caseEl.classList.toggle('selectable', many);
    },
  };
}

// =============================================================================
// Side panel: bell code reference, and fiddle yard / station editing
// =============================================================================

type SideTab = 'codes' | 'layout';

function sidePanel(ctx: Ctx, boxId: string): { el: HTMLElement; toggle(tab: SideTab): void; dispose(): void } {
  let tab: SideTab = 'codes';
  const body = h('div', { class: 'side-body' });
  const tabBtn = (t: SideTab, label: string) =>
    h('button', { class: 'btn small side-tab', type: 'button', role: 'tab', 'data-tab': t, on: { click: () => { tab = t; render(); } } }, label);
  const tabs = h('div', { class: 'side-tabs', role: 'tablist' }, tabBtn('codes', 'Bell codes'), tabBtn('layout', 'Trains in places'));
  const el = h(
    'aside',
    { id: 'side-panel', class: 'side-panel', hidden: true, 'aria-label': 'Reference and layout' },
    h('div', { class: 'side-head' }, tabs, h('button', { class: 'btn small', type: 'button', 'aria-label': 'Close panel', on: { click: () => close() } }, 'Close ✕')),
    body,
  );

  const render = () => {
    if (el.hidden) return;
    for (const b of tabs.querySelectorAll<HTMLElement>('.side-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    replace(body, tab === 'codes' ? codeReference(ctx, true) : layoutEditor(ctx, true, ctx.store.state.boxes.find((b) => b.id === boxId)?.layoutId ?? ""));
  };
  // Data changes rebuild the panel once focus has moved on, keeping the user's place.
  const rerender = safeRerender(() => body, render, () => body);

  const open = (t: SideTab) => {
    tab = t;
    el.hidden = false;
    document.body.classList.add('side-open');
    body.scrollTop = 0;
    render();
  };
  const close = () => {
    el.hidden = true;
    document.body.classList.remove('side-open');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !el.hidden) close();
  };
  window.addEventListener('keydown', onKey);
  const unsub = ctx.store.subscribe(() => rerender());
  return {
    el,
    toggle: (t) => (!el.hidden && tab === t ? close() : open(t)),
    dispose: () => {
      unsub();
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('side-open');
    },
  };
}
