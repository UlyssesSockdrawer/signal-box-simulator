import {
  addJunctionInTrack,
  addTrack,
  branchFrom,
  checkCircuitCode,
  checkJunctionNumber,
  circuitLabel,
  circuitPath,
  CODE_MAX,
  connectParallel,
  addBend,
  addDoubleTrack,
  moveBend,
  orient,
  parallelSideNames,
  parallelTrack,
  portsOf,
  removeBend,
  rotateQuarter,
  setTurntableRoads,
  TURNTABLE_RADIUS,
  acrossJoint,
  mergeAtJoint,
  crossoverFrom,
  deleteCircuit,
  deleteJunction,
  detachEnd,
  endAnchor,
  endHeading,
  findCircuit,
  findJunction,
  mirrorJunction,
  MIRRORABLE,
  turnRound,
  giveBranch,
  grow,
  GROW_JUNCTIONS,
  INSERT_JUNCTIONS,
  isOpenEnd,
  joinOpenEnds,
  junctionName,
  JUNCTIONS,
  localToWorld,
  moveEnd,
  moveJunction,
  openEndAnchor,
  openEnds,
  planBounds,
  planIssues,
  portAnchor,
  portDef,
  portUse,
  setEndKind,
  setExitTarget,
  setJunctionKind,
  shiftCircuit,
  splitCircuit,
  type CrossoverLean,
  type GrowPiece,
  type OpenEndRef,
  type PlanIssue,
  type Pt,
} from '../../core/trackPlan';
import type { AppState, ExitTarget, Junction, JunctionKind, TrackCircuit, TrackOwner, TrackPlan } from '../../core/types';
import { topBar, type Ctx, type Screen } from '../app';
import { confirmButton, h, option, safeRerender, toast } from '../dom';
import { plusIcon } from './boxConfig';

/*
 * Layout configurator: build the layout's track plan by growing it from its
 * unfinished ends (the brass + roundels), then give the track to signal boxes.
 * The screen manages its own updates (it is "live") so that dragging and the
 * open menu survive changes to saved data.
 */

const NS = 'http://www.w3.org/2000/svg';
/** Grid unit in pixels at 100% zoom. */
const UNIT = 24;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
/** Margin around the plan, in grid units. */
const MARGIN = 5;

const INK = '#1d2124';
const LINE_GREY = '#5f6368';
/** Box colours on the enamel diagram (all dark enough for white text and to stand out on cream). */
const BOX_COLOURS = ['#1f4e8c', '#b5541b', '#2e6b3a', '#6a3d8c', '#8a5a00', '#0f6b6b', '#a3271f', '#455a64'];

type Tab = 'plan' | 'areas';
type Sel = { kind: 'circuit'; id: string } | { kind: 'junction'; id: string } | null;
type Pick =
  | { kind: 'join'; from: OpenEndRef }
  | { kind: 'parallel'; from: string }
  | { kind: 'parallelChoose'; from: string; to: string };

interface Ui {
  tab: Tab;
  sel: Sel;
  menu: OpenEndRef | null;
  pick: Pick | null;
  zoom: number;
  /** Set once the zoom has been chosen for this session (smaller to start with on phones). */
  zoomChosen: boolean;
  names: boolean;
  issueIdx: number;
  insertKind: JunctionKind;
  insertFlip: boolean;
  /** New points from the + menu: facing (the line divides) or trailing (lines join). */
  trailing: boolean;
  /** The selected bend of the selected track circuit, if any. */
  bend: number | null;
}

// Kept for the session, so coming back to the screen finds it as it was.
const ui: Ui = { tab: 'plan', sel: null, menu: null, pick: null, zoom: 1, zoomChosen: false, names: true, issueIdx: 0, insertKind: 'pointsRight', insertFlip: false, trailing: false, bend: null };
const undoStack: string[] = [];
const redoStack: string[] = [];
const UNDO_MAX = 60;

type Hit =
  | { t: 'circuit'; id: string }
  | { t: 'junction'; id: string }
  | { t: 'open'; ref: OpenEndRef }
  | { t: 'end'; circuitId: string; end: 0 | 1 }
  | { t: 'bend'; circuitId: string; i: number };

type Drag =
  | { kind: 'bend'; circuitId: string; i: number; ox: number; oy: number }
  | { kind: 'junction'; id: string; ox: number; oy: number }
  | { kind: 'end'; circuitId: string; end: 0 | 1; ox: number; oy: number }
  | { kind: 'circuit'; id: string };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...children: Array<SVGElement | string | null>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const junctions = (n: number) => `${n} junction${n === 1 ? '' : 's'}`;
const refKey = (r: OpenEndRef) => (r.kind === 'end' ? `e|${r.circuitId}|${r.end}` : `p|${r.junctionId}|${r.port}`);
const sameRef = (a: OpenEndRef | null, b: OpenEndRef | null) => !!a && !!b && refKey(a) === refKey(b);

export function trackPlanScreen(ctx: Ctx): Screen {
  const store = ctx.store;
  const plan = () => store.state.trackPlan;
  let quiet = false;

  // ---------------------------------------------------------------- editing with undo
  const edit = <R>(fn: (p: TrackPlan, a: AppState) => R): R => {
    const before = JSON.stringify(store.state.trackPlan);
    let out!: R;
    quiet = true;
    try {
      store.update((a) => (out = fn(a.trackPlan, a)));
    } finally {
      quiet = false;
    }
    if (JSON.stringify(store.state.trackPlan) !== before) {
      undoStack.push(before);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
      redoStack.length = 0;
    }
    return out;
  };
  const restore = (from: string[], to: string[]) => {
    const snap = from.pop();
    if (!snap) return;
    to.push(JSON.stringify(store.state.trackPlan));
    quiet = true;
    store.update((a) => (a.trackPlan = JSON.parse(snap)));
    quiet = false;
    // Drop a selection or menu that no longer exists.
    if (ui.sel?.kind === 'circuit' && !findCircuit(plan(), ui.sel.id)) ui.sel = null;
    if (ui.sel?.kind === 'junction' && !findJunction(plan(), ui.sel.id)) ui.sel = null;
    if (ui.menu && !isOpenEnd(plan(), ui.menu)) ui.menu = null;
    ui.pick = null;
    renderAll();
  };
  const undo = () => restore(undoStack, redoStack);
  const redo = () => restore(redoStack, undoStack);

  // ---------------------------------------------------------------- names
  const boxName = (id: string) => store.state.boxes.find((b) => b.id === id)?.name ?? 'Unknown box';
  const boxColour = (id: string) => {
    const i = store.state.boxes.findIndex((b) => b.id === id);
    return i < 0 ? INK : BOX_COLOURS[i % BOX_COLOURS.length];
  };
  const lineName = (boxId: string, connId: string) => {
    const b = store.state.boxes.find((x) => x.id === boxId);
    const c = b?.connections.find((x) => x.id === connId);
    return `Line: ${b?.name ?? '?'} – ${c?.neighbourName ?? '?'}`;
  };
  const ownerText = (o: TrackOwner) => (o.kind === 'box' ? boxName(o.boxId) : o.kind === 'line' ? lineName(o.boxId, o.connectionId) : 'Not assigned');
  const exitText = (to: ExitTarget) => {
    if (to.kind === 'fiddleYard') return `To ${store.state.fiddleYards.find((y) => y.id === to.yardId)?.name ?? 'fiddle yard'}`;
    if (to.kind === 'connection') {
      const c = store.state.boxes.find((b) => b.id === to.boxId)?.connections.find((x) => x.id === to.connectionId);
      return `To ${c?.neighbourName ?? 'another box'}`;
    }
    return 'Off scene';
  };
  const refText = (r: OpenEndRef) => {
    if (r.kind === 'end') {
      const c = findCircuit(plan(), r.circuitId);
      return c ? `the end of ${c.code}` : 'this end';
    }
    const j = findJunction(plan(), r.junctionId);
    const p = j ? portDef(j.kind, r.port) : null;
    return j && p ? `${junctionName(j)} · ${p.label.toLowerCase()}` : 'this end';
  };

  // ---------------------------------------------------------------- page skeleton
  const tabsEl = h('nav', { class: 'config-tabs', 'aria-label': 'Layout configurator sections' });
  const toolbarEl = h('div', { class: 'tp-toolbar' });
  const pickbarEl = h('div', { class: 'tp-pickbar', role: 'status', 'aria-live': 'polite', hidden: true });
  const boardEl = h('div', { class: 'tp-board', tabindex: '-1' });
  const boardWrap = h('div', { class: 'tp-board-wrap' });
  const statusEl = h('div', { class: 'tp-status' });
  const sideEl = h('aside', { class: 'config-case tp-side', 'aria-label': 'Selected piece' });
  const root = h(
    'main',
    { class: 'page config-page tp-page' },
    topBar(ctx, 'Layout configurator'),
    tabsEl,
    h('div', { class: 'config-shelf tp-shelf' }, h('div', { class: 'tp-wrap' }, h('div', { class: 'tp-main' }, toolbarEl, pickbarEl, boardWrap, statusEl), sideEl)),
  );

  // ---------------------------------------------------------------- tabs, toolbar, pick bar
  const renderTabs = () => {
    const tab = (id: Tab, label: string) =>
      h(
        'button',
        {
          class: 'btn small side-tab',
          type: 'button',
          'aria-selected': String(ui.tab === id),
          'aria-current': ui.tab === id ? 'page' : undefined,
          on: {
            click: () => {
              ui.tab = id;
              ui.menu = null;
              ui.pick = null;
              ui.issueIdx = 0;
              renderAll();
            },
          },
        },
        label,
      );
    tabsEl.replaceChildren(tab('plan', 'Track plan'), tab('areas', 'Box areas'));
  };

  const fit = () => {
    const b = planBounds(plan());
    const w = boardEl.clientWidth - 8;
    if (!b || w <= 0) {
      ui.zoom = 1;
      return;
    }
    const z = w / ((b.maxX - b.minX + 2 * MARGIN) * UNIT);
    ui.zoom = clampZoom(z);
    ui.zoomChosen = true;
  };
  const zoomBy = (f: number) => {
    const r = boardEl.getBoundingClientRect();
    zoomAt(ui.zoom * f, r.left + r.width / 2, r.top + r.height / 2);
  };
  /** Zoom keeping the point of the plan under (clientX, clientY) where it is. */
  const zoomAt = (z: number, clientX: number, clientY: number) => {
    const nz = clampZoom(z);
    ui.zoomChosen = true;
    if (Math.abs(nz - ui.zoom) < 0.005) return;
    const r = boardEl.getBoundingClientRect();
    const mx = clientX - r.left - boardEl.clientLeft;
    const my = clientY - r.top - boardEl.clientTop;
    const gx = view.ox + (boardEl.scrollLeft + mx) / view.u;
    const gy = view.oy + (boardEl.scrollTop + my) / view.u;
    ui.zoom = nz;
    renderBoard();
    boardEl.scrollLeft = (gx - view.ox) * view.u - mx;
    boardEl.scrollTop = (gy - view.oy) * view.u - my;
  };

  const layNewTrack = () => {
    const c = edit((p) => addTrack(p));
    ui.sel = { kind: 'circuit', id: c.id };
    ui.menu = null;
    ui.pick = null;
    renderAll();
    scrollToSel();
    toast(`${c.code} laid. Tap + at either end to carry on from it.`);
  };

  const layDoubleTrack = () => {
    const r = edit((p) => addDoubleTrack(p));
    ui.sel = { kind: 'circuit', id: r.circuitIds[0] };
    ui.menu = null;
    ui.pick = null;
    ui.bend = null;
    renderAll();
    scrollToSel();
    toast('Double track laid. Carry on from the + at either end of each line.');
  };

  const renderToolbar = () => {
    const btn = (label: string, fn: () => void, opts: { disabled?: boolean; aria?: string; cls?: string; pressed?: boolean } = {}) =>
      h(
        'button',
        { class: `btn small ${opts.cls ?? ''}`, type: 'button', disabled: opts.disabled, 'aria-label': opts.aria, 'aria-pressed': opts.pressed === undefined ? undefined : String(opts.pressed), on: { click: fn } },
        label,
      );
    toolbarEl.replaceChildren(
      h('div', { class: 'seg' }, btn('Undo', undo, { disabled: !undoStack.length }), btn('Redo', redo, { disabled: !redoStack.length })),
      h(
        'div',
        { class: 'seg' },
        btn('−', () => zoomBy(1 / 1.25), { aria: 'Zoom out' }),
        btn('Fit', () => {
          fit();
          renderBoard();
        }),
        btn('+', () => zoomBy(1.25), { aria: 'Zoom in' }),
      ),
      h('span', { class: 'shelf-label tp-tool-label' }, 'Labels'),
      h(
        'div',
        { class: 'seg' },
        btn('Codes', () => ((ui.names = false), renderBoard(), renderToolbar()), { pressed: !ui.names }),
        btn('Codes + names', () => ((ui.names = true), renderBoard(), renderToolbar()), { pressed: ui.names }),
      ),
      ...(ui.tab === 'plan' ? [btn('+ Lay a new track', layNewTrack, { cls: 'tp-new' }), btn('+ Lay double track', layDoubleTrack)] : []),
    );
  };

  const cancelPick = () => {
    ui.pick = null;
    renderAll();
  };
  const leanIcon = (lean: CrossoverLean) =>
    svg('svg', { width: 36, height: 24, viewBox: '0 0 36 24', 'aria-hidden': 'true' }, svg('path', { d: lean === 'rising' ? 'M2 20 H12 L24 4 H34' : 'M2 4 H12 L24 20 H34', stroke: 'currentColor', 'stroke-width': 3, fill: 'none' }));

  const renderPickbar = () => {
    const p = ui.pick;
    pickbarEl.hidden = !p;
    if (!p) {
      pickbarEl.replaceChildren();
      return;
    }
    const cancel = h('button', { class: 'btn small', type: 'button', on: { click: cancelPick } }, 'Cancel');
    if (p.kind === 'join') {
      pickbarEl.replaceChildren(h('span', { class: 'tp-pick-text' }, `Tap the + you want to join ${refText(p.from)} to.`), cancel);
    } else if (p.kind === 'parallel') {
      const c = findCircuit(plan(), p.from);
      pickbarEl.replaceChildren(h('span', { class: 'tp-pick-text' }, `Tap the track that runs alongside ${c?.code ?? 'this track'}.`), cancel);
    } else {
      const a = findCircuit(plan(), p.from);
      const b = findCircuit(plan(), p.to);
      const go = (lean: CrossoverLean) => {
        const r = edit((pl) => connectParallel(pl, p.from, p.to, lean));
        if (r.error) {
          toast(r.error);
          return;
        }
        ui.pick = null;
        ui.sel = r.circuitId ? { kind: 'circuit', id: r.circuitId } : null;
        renderAll();
        toast('Crossover added: two sets of points and the track between them.');
      };
      pickbarEl.replaceChildren(
        h('span', { class: 'tp-pick-text' }, `Connect ${a?.code ?? '?'} and ${b?.code ?? '?'} with a crossover:`),
        h('button', { class: 'btn small primary tp-lean', type: 'button', on: { click: () => go('rising') } }, leanIcon('rising'), 'Rising to the right'),
        h('button', { class: 'btn small primary tp-lean', type: 'button', on: { click: () => go('falling') } }, leanIcon('falling'), 'Falling to the right'),
        cancel,
      );
    }
  };

  // ---------------------------------------------------------------- the diagram
  let drag: { hit: Hit | null; drag: Drag | null; sx: number; sy: number; dx: number; dy: number; pointerId: number; base: string } | null = null;
  let view: { ox: number; oy: number; u: number } = { ox: 0, oy: 0, u: UNIT };
  let frozenBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  const X = (x: number) => (x - view.ox) * view.u;
  const Y = (y: number) => (y - view.oy) * view.u;
  const d = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' ');
  /** A track's route with its corners rounded off, so bends read as curves. */
  const curvedD = (pts: Pt[]) => {
    const P = pts.map((p) => ({ x: X(p.x), y: Y(p.y) }));
    if (P.length < 3) return d(pts);
    const r = view.u * 1.1;
    let out = `M${P[0].x.toFixed(1)} ${P[0].y.toFixed(1)}`;
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1];
      const v = P[i];
      const b = P[i + 1];
      const l1 = Math.hypot(v.x - a.x, v.y - a.y) || 1;
      const l2 = Math.hypot(b.x - v.x, b.y - v.y) || 1;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const p1 = { x: v.x + ((a.x - v.x) / l1) * rr, y: v.y + ((a.y - v.y) / l1) * rr };
      const p2 = { x: v.x + ((b.x - v.x) / l2) * rr, y: v.y + ((b.y - v.y) / l2) * rr };
      out += `L${p1.x.toFixed(1)} ${p1.y.toFixed(1)}Q${v.x.toFixed(1)} ${v.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    const z = P[P.length - 1];
    return out + `L${z.x.toFixed(1)} ${z.y.toFixed(1)}`;
  };

  const hitAttrs = (hit: Hit, label: string, draggable: boolean) => ({
    'data-hit': JSON.stringify(hit),
    tabindex: 0,
    role: 'button',
    'aria-label': label,
    style: draggable ? 'touch-action:none' : undefined,
    class: 'tp-hit',
  });

  const circuitColour = (c: TrackCircuit): { stroke: string; dash?: string } => {
    if (ui.tab !== 'areas') return { stroke: INK };
    if (c.owner.kind === 'box') return { stroke: boxColour(c.owner.boxId) };
    if (c.owner.kind === 'line') return { stroke: LINE_GREY, dash: '12 6' };
    return { stroke: INK };
  };
  const junctionColour = (j: Junction) => (ui.tab === 'areas' && j.boxId ? boxColour(j.boxId) : INK);

  const plusMark = (p: Pt, ref: OpenEndRef, label: string, state: 'normal' | 'menu' | 'target' | 'source') => {
    const cx = X(p.x);
    const cy = Y(p.y);
    const r = Math.max(9, 11 * Math.min(1.2, view.u / UNIT));
    const draggable = ref.kind === 'end';
    return svg(
      'g',
      { ...hitAttrs({ t: 'open', ref }, label, draggable), class: `tp-hit tp-plus tp-plus-${state}` },
      state === 'menu' || state === 'target' ? svg('circle', { cx, cy, r: r + 6, fill: 'none', stroke: state === 'target' ? '#1f5546' : '#0c0a08', 'stroke-width': 2.5, 'stroke-dasharray': '4 3' }) : null,
      svg('circle', { cx, cy, r: r + 8, fill: 'transparent' }),
      svg('circle', { cx, cy, r, fill: state === 'source' ? '#ece6d3' : '#c9a85a', stroke: '#0c0a08', 'stroke-width': 2 }),
      svg('path', { d: `M${cx} ${cy - r * 0.55}V${cy + r * 0.55}M${cx - r * 0.55} ${cy}H${cx + r * 0.55}`, stroke: '#241a0e', 'stroke-width': 3, 'stroke-linecap': 'round' }),
    );
  };

  const drawPlan = (p: TrackPlan): SVGSVGElement => {
    const b0 = planBounds(p);
    let b = b0 ?? { minX: 0, minY: 0, maxX: 16, maxY: 8 };
    if (frozenBounds) b = { minX: Math.min(b.minX, frozenBounds.minX), minY: Math.min(b.minY, frozenBounds.minY), maxX: Math.max(b.maxX, frozenBounds.maxX), maxY: Math.max(b.maxY, frozenBounds.maxY) };
    const u = UNIT * ui.zoom;
    const avail = Math.max(0, boardEl.clientWidth - 4) / u;
    const wUnits = Math.max(b.maxX - b.minX + 2 * MARGIN, avail);
    // Fill the board, so the grid dots reach the bottom even when zoomed out.
    const hUnits = Math.max(b.maxY - b.minY + 2 * MARGIN, 10, 300 / u);
    view = { ox: b.minX - MARGIN - (wUnits - (b.maxX - b.minX + 2 * MARGIN)) / 2, oy: b.minY - MARGIN, u };
    const W = Math.round(wUnits * u);
    const H = Math.round(hUnits * u);
    const font = Math.max(10, Math.round(12 * Math.min(1.4, ui.zoom)));
    const s = svg('svg', { class: 'tp-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Track plan' });
    const dots = svg('pattern', { id: 'tp-dots', width: u, height: u, patternUnits: 'userSpaceOnUse', x: X(Math.floor(view.ox)) % u, y: Y(Math.floor(view.oy)) % u }, svg('circle', { cx: 0.5, cy: 0.5, r: 1.2, fill: '#c9bfa6' }));
    s.append(svg('defs', {}, dots), svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#tp-dots)', class: 'tp-bg' }));

    const picking = ui.pick?.kind === 'parallel';
    const selC = ui.sel?.kind === 'circuit' ? ui.sel.id : null;
    const selJ = ui.sel?.kind === 'junction' ? ui.sel.id : null;
    const branch = ui.tab === 'areas' && selC ? new Set(branchFrom(p, selC).circuits.map((c) => c.id)) : null;

    // Track circuits
    const labels: SVGElement[] = [];
    for (const c of p.circuits) {
      const path = circuitPath(p, c);
      if (path.length < 2) continue;
      const pd = curvedD(path);
      const col = circuitColour(c);
      const freeEnds = c.ends.some((e) => e.kind !== 'joined');
      const g = svg('g', { ...hitAttrs({ t: 'circuit', id: c.id }, `Track circuit ${circuitLabel(c)}`, freeEnds), class: `tp-hit tp-circuit${picking && c.id !== (ui.pick as { from: string }).from ? ' tp-pickable' : ''}` });
      g.append(svg('path', { d: pd, class: 'tp-hitline', fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(18, u * 0.8), 'stroke-linejoin': 'round' }));
      if (c.id === selC) g.append(svg('path', { d: pd, fill: 'none', stroke: '#e6b450', 'stroke-width': Math.max(14, u * 0.7), 'stroke-linejoin': 'round', opacity: 0.7 }));
      else if (branch?.has(c.id)) g.append(svg('path', { d: pd, fill: 'none', stroke: '#e6b450', 'stroke-width': Math.max(12, u * 0.6), 'stroke-linejoin': 'round', opacity: 0.35 }));
      if (ui.pick?.kind === 'parallelChoose' && (c.id === ui.pick.from || c.id === ui.pick.to))
        g.append(svg('path', { d: pd, fill: 'none', stroke: '#1f5546', 'stroke-width': Math.max(14, u * 0.7), 'stroke-linejoin': 'round', opacity: 0.45 }));
      g.append(svg('path', { d: pd, class: 'tp-line', fill: 'none', stroke: col.stroke, 'stroke-width': 6, 'stroke-dasharray': col.dash, 'stroke-linejoin': 'round' }));
      // End fittings
      c.ends.forEach((e, i) => {
        if (e.kind === 'bufferStops' || e.kind === 'exit') {
          const hd = endHeading(p, c, i as 0 | 1);
          if (!hd) return;
          const px = X(e.x);
          const py = Y(e.y);
          const len = Math.hypot(hd.dx, hd.dy) || 1;
          const ux = hd.dx / len;
          const uy = hd.dy / len;
          if (e.kind === 'bufferStops') {
            g.append(svg('path', { d: `M${px - uy * 13} ${py + ux * 13}L${px + uy * 13} ${py - ux * 13}`, stroke: col.stroke, 'stroke-width': 7 }));
          } else {
            g.append(svg('path', { d: `M${px + ux * 14} ${py + uy * 14}L${px - uy * 9} ${py + ux * 9}L${px + uy * 9} ${py - ux * 9}Z`, fill: col.stroke }));
            labels.push(
              svg('text', { x: px + ux * 20, y: py + uy * 20 + font * 0.35, 'text-anchor': ux < 0 ? 'end' : 'start', class: 'tp-label', 'font-size': font, fill: INK }, exitText(e.to)),
            );
          }
          g.append(svg('circle', { ...hitAttrs({ t: 'end', circuitId: c.id, end: i as 0 | 1 }, `${e.kind === 'exit' ? 'Scene exit' : 'Buffer stops'} at the end of ${c.code}`, true), cx: px, cy: py, r: 14, fill: 'transparent' }));
        }
      });
      s.append(g);
      // Bend handles on the selected track: drag them to shape curves.
      if (c.id === selC && ui.tab === 'plan')
        (c.via ?? []).forEach((v, i) => {
          const on = ui.bend === i;
          s.append(
            svg(
              'g',
              { ...hitAttrs({ t: 'bend', circuitId: c.id, i }, `Bend ${i + 1} of ${c.code}`, true), class: 'tp-hit tp-bend' },
              svg('circle', { cx: X(v.x), cy: Y(v.y), r: 18, fill: 'transparent' }),
              svg('circle', { cx: X(v.x), cy: Y(v.y), r: on ? 9 : 7, fill: on ? '#c9a85a' : '#ece6d3', stroke: '#0c0a08', 'stroke-width': 2.5 }),
            ),
          );
        });
      // Label at the middle of the longest stretch
      let best = 0;
      let bi = 1;
      for (let i = 1; i < path.length; i++) {
        const l = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
        if (l > best) {
          best = l;
          bi = i;
        }
      }
      const a = path[bi - 1];
      const z = path[bi];
      const mx = X((a.x + z.x) / 2);
      const my = Y((a.y + z.y) / 2);
      const level = a.y === z.y;
      const text = ui.names ? circuitLabel(c) : c.code;
      labels.push(svg('text', { x: level ? mx : mx + 10, y: level ? my - 10 : my, 'text-anchor': level ? 'middle' : 'start', class: 'tp-label', 'font-size': font, fill: col.stroke === LINE_GREY ? '#3c4043' : col.stroke }, text));
    }

    // Junctions
    for (const j of p.junctions) {
      const def = JUNCTIONS[j.kind];
      const col = junctionColour(j);
      const g = svg('g', { ...hitAttrs({ t: 'junction', id: j.id }, `${junctionName(j)} (${def.name})`, true), class: 'tp-hit tp-junction' });
      const centre = j.kind === 'scissors' ? localToWorld(j, 0, 1.5) : localToWorld(j, 0, 0);
      const tt = j.kind === 'turntable';
      const bigR = tt ? TURNTABLE_RADIUS + 0.9 : j.kind === 'scissors' ? 2.6 : 1.3;
      if (j.id === selJ) g.append(svg('circle', { cx: X(centre.x), cy: Y(centre.y), r: Math.max(20, u * bigR), fill: '#e6b450', opacity: 0.6 }));
      if (tt) {
        // Roads from the edge of the deck out to their ends, then the pit and the turning bridge.
        for (const pp of portsOf(j)) {
          const len = Math.hypot(pp.x, pp.y);
          const edge = localToWorld(j, (pp.x / len) * TURNTABLE_RADIUS, (pp.y / len) * TURNTABLE_RADIUS);
          g.append(svg('path', { d: d([edge, localToWorld(j, pp.x, pp.y)]), fill: 'none', stroke: col, 'stroke-width': 6 }));
        }
        g.append(svg('circle', { cx: X(centre.x), cy: Y(centre.y), r: TURNTABLE_RADIUS * u, fill: '#ddd5bd', stroke: col, 'stroke-width': 4 }));
        g.append(svg('path', { d: d([localToWorld(j, -TURNTABLE_RADIUS + 0.3, 0), localToWorld(j, TURNTABLE_RADIUS - 0.3, 0)]), fill: 'none', stroke: col, 'stroke-width': 6, 'stroke-linecap': 'round' }));
        g.append(svg('circle', { cx: X(centre.x), cy: Y(centre.y), r: 4, fill: col }));
      }
      for (const r of def.routes) {
        const pts = r.path.map(([x, y]) => localToWorld(j, x, y));
        if (r.slip) {
          const [a, m, z] = pts;
          g.append(svg('path', { d: `M${X(a.x)} ${Y(a.y)}Q${X(m.x)} ${Y(m.y)} ${X(z.x)} ${Y(z.y)}`, fill: 'none', stroke: col, 'stroke-width': 3.5 }));
        } else g.append(svg('path', { d: d(pts), fill: 'none', stroke: col, 'stroke-width': 6, 'stroke-linejoin': 'round' }));
      }
      for (const stub of def.stubs ?? []) {
        const pts = stub.map(([x, y]) => localToWorld(j, x, y));
        g.append(svg('path', { d: d(pts), fill: 'none', stroke: col, 'stroke-width': 4, 'stroke-linecap': 'round' }));
      }
      if (j.kind === 'joint') {
        // A short tick across the line, whichever way the line runs.
        const c0 = localToWorld(j, 0, 0);
        const n = orient(j, 0, 1);
        g.append(svg('path', { d: `M${X(c0.x) - n.x * 9} ${Y(c0.y) - n.y * 9}L${X(c0.x) + n.x * 9} ${Y(c0.y) + n.y * 9}`, stroke: INK, 'stroke-width': 2.5 }));
      } else {
        const up = portsOf(j).some((pp) => localToWorld(j, pp.x, pp.y).y < j.y) || (def.stubs ?? []).some((st) => st.some(([x, y]) => localToWorld(j, x, y).y < j.y));
        const tx = X(centre.x);
        const ty = tt ? Y(centre.y) - TURNTABLE_RADIUS * u - 22 : j.kind === 'scissors' ? Y(centre.y) : up ? Y(centre.y) + 14 : Y(centre.y) - 30;
        const label = j.number || '?';
        const tw = Math.max(18, label.length * 8 + 8);
        g.append(svg('rect', { x: tx - tw / 2, y: ty, width: tw, height: 16, rx: 2, fill: ui.tab === 'areas' && j.boxId ? col : '#0c0a08' }));
        g.append(svg('text', { x: tx, y: ty + 12, 'text-anchor': 'middle', class: 'tp-tag', fill: '#ffffff' }, label));
      }
      g.append(svg('circle', { cx: X(centre.x), cy: Y(centre.y), r: Math.max(16, u * (tt ? TURNTABLE_RADIUS : j.kind === 'scissors' ? 2 : 0.9)), fill: 'transparent' }));
      s.append(g);
    }
    for (const l of labels) s.append(l);

    // Unfinished ends
    const joinFrom = ui.pick?.kind === 'join' ? ui.pick.from : null;
    for (const ref of openEnds(p)) {
      const a = plusAt(p, ref);
      if (!a) continue;
      const state = joinFrom ? (sameRef(joinFrom, ref) ? 'source' : 'target') : sameRef(ui.menu, ref) ? 'menu' : 'normal';
      s.append(plusMark(a, ref, joinFrom && state === 'target' ? `Join to ${refText(ref)}` : `Add to ${refText(ref)}`, state));
    }
    return s;
  };

  /** Where a + is drawn: at a free track end, or just beyond a junction's unfinished road. */
  function plusAt(p: TrackPlan, ref: OpenEndRef): Pt | null {
    if (ref.kind === 'end') {
      const c = findCircuit(p, ref.circuitId);
      return c ? endAnchor(p, c.ends[ref.end]) : null;
    }
    const a = openEndAnchor(p, ref);
    if (!a) return null;
    const len = Math.hypot(a.dx, a.dy) || 1;
    // Far enough out that neighbouring roads' + marks do not overlap, even zoomed out.
    const off = Math.max(0.75, 16 / view.u);
    return { x: a.x + (a.dx / len) * off, y: a.y + (a.dy / len) * off };
  }

  const svgHost = h('div', { class: 'tp-svg-host' });
  const menuEl = h('div', { class: 'config-case tp-menu', role: 'dialog', 'aria-label': 'Add a piece', hidden: true });
  const emptyEl = h(
    'button',
    { class: 'add-tile tp-empty', type: 'button', hidden: true, on: { click: layNewTrack } },
    plusIcon(),
    h('span', { class: 'mi-label' }, 'Lay the first track'),
    h('span', { class: 'mi-sub' }, 'Then grow the plan from its ends: tap a + to add track, points, slips, buffer stops or an exit off the scene.'),
  );
  boardEl.append(svgHost, emptyEl);
  boardWrap.append(boardEl, menuEl);
  boardEl.addEventListener('scroll', () => positionMenu());

  const renderBoard = (p: TrackPlan = plan()) => {
    const empty = !p.circuits.length && !p.junctions.length;
    emptyEl.hidden = !empty;
    svgHost.hidden = empty;
    if (empty) {
      svgHost.replaceChildren();
      menuEl.hidden = true;
      return;
    }
    svgHost.replaceChildren(drawPlan(p));
    if (!drag) renderMenu();
  };

  const scrollToSel = () => {
    window.setTimeout(() => {
      const target = ui.sel
        ? [...svgHost.querySelectorAll<SVGElement>('[data-hit]')].find((el) => {
            const hh = JSON.parse(el.getAttribute('data-hit')!) as Hit;
            return (hh.t === 'circuit' || hh.t === 'junction') && hh.id === ui.sel!.id;
          })
        : null;
      if (!target) return;
      const r = target.getBoundingClientRect();
      const br = boardEl.getBoundingClientRect();
      if (r.right > br.right - 20 || r.left < br.left + 20) boardEl.scrollLeft += r.left + r.width / 2 - (br.left + br.width / 2);
      if (r.bottom > br.bottom - 20 || r.top < br.top + 20) boardEl.scrollTop += r.top + r.height / 2 - (br.top + br.height / 2);
    }, 0);
  };

  // ---------------------------------------------------------------- the + menu
  const pieceIcon = (piece: GrowPiece | 'join' | 'crossover' | 'crossoverLeft'): SVGSVGElement => {
    const st = { stroke: 'currentColor', 'stroke-width': 3, fill: 'none' };
    const slip = { stroke: '#c9a85a', 'stroke-width': 2, fill: 'none' };
    const paths: Record<string, Array<SVGElement>> = {
      track: [svg('path', { d: 'M3 12H33', ...st })],
      bufferStops: [svg('path', { d: 'M3 12H27', ...st }), svg('path', { d: 'M30 4V20', stroke: 'currentColor', 'stroke-width': 4 })],
      exit: [svg('path', { d: 'M3 12H24', ...st }), svg('path', { d: 'M22 5L32 12L22 19Z', fill: 'currentColor' })],
      pointsRight: [svg('path', { d: 'M3 8H33M13 8L29 20', ...st })],
      pointsLeft: [svg('path', { d: 'M3 16H33M13 16L29 4', ...st })],
      pointsY: [svg('path', { d: 'M3 12H12L31 4M12 12L31 20', ...st })],
      threeWay: [svg('path', { d: 'M3 12H33M12 12L31 3M12 12L31 21', ...st })],
      diamond: [svg('path', { d: 'M3 12H33M8 20L28 4', ...st })],
      singleSlip: [svg('path', { d: 'M3 12H33M8 20L28 4', ...st }), svg('path', { d: 'M5 12Q18 12 24 7', ...slip })],
      doubleSlip: [svg('path', { d: 'M3 12H33M8 20L28 4', ...st }), svg('path', { d: 'M5 12Q18 12 24 7M12 17Q18 12 31 12', ...slip })],
      scissors: [svg('path', { d: 'M3 5H33M3 19H33M10 5L26 19M10 19L26 5', ...st })],
      joint: [svg('path', { d: 'M3 12H33', ...st }), svg('path', { d: 'M18 5V19', stroke: 'currentColor', 'stroke-width': 2 })],
      crossover: [svg('path', { d: 'M3 5H33M3 19H33M10 5L24 19', ...st })],
      curveLeft: [svg('path', { d: 'M3 20H16Q26 20 26 10V2', ...st })],
      curveRight: [svg('path', { d: 'M3 4H16Q26 4 26 14V22', ...st })],
      turntable: [svg('circle', { cx: 18, cy: 12, r: 8, stroke: 'currentColor', 'stroke-width': 2.5, fill: 'none' }), svg('path', { d: 'M1 12H10M26 12H35M12 12H24M24 6L30 2M24 18L30 22', ...st })],
      crossoverLeft: [svg('path', { d: 'M3 5H33M3 19H33M10 19L24 5', ...st })],
      catchPoints: [svg('path', { d: 'M3 10H33', ...st }), svg('path', { d: 'M12 10L22 17', stroke: 'currentColor', 'stroke-width': 3, fill: 'none' })],
      join: [svg('path', { d: 'M3 12H13M23 12H33', ...st }), svg('path', { d: 'M14 12H22', stroke: 'currentColor', 'stroke-width': 2, 'stroke-dasharray': '2 2' })],
    };
    return svg('svg', { width: 36, height: 24, viewBox: '0 0 36 24', 'aria-hidden': 'true' }, ...(paths[piece] ?? []));
  };

  const pieceButton = (icon: GrowPiece | 'join' | 'crossover' | 'crossoverLeft', title: string, sub: string, fn: () => void) =>
    h('button', { class: 'tp-pick', type: 'button', on: { click: fn } }, pieceIcon(icon), h('span', null, h('b', null, title), h('span', null, sub)));

  const growHere = (ref: OpenEndRef, piece: GrowPiece) => {
    const r = edit((p) => grow(p, ref, piece, { trailing: ui.trailing }));
    ui.menu = null;
    if (r?.junctionId) ui.sel = { kind: 'junction', id: r.junctionId };
    else if (r?.circuitId) ui.sel = { kind: 'circuit', id: r.circuitId };
    renderAll();
    scrollToSel();
  };

  const renderMenu = () => {
    const ref = ui.menu;
    if (!ref || !isOpenEnd(plan(), ref) || ui.tab !== 'plan') {
      menuEl.hidden = true;
      menuEl.replaceChildren();
      return;
    }
    const close = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Close', on: { click: () => ((ui.menu = null), renderAll()) } }, '×');
    const a = openEndAnchor(plan(), ref);
    const diverging = ref.kind === 'port' && !!a && a.dx !== 0 && a.dy !== 0;
    const crossover = (hand?: 'pointsRight' | 'pointsLeft') => {
      const r = edit((p) => crossoverFrom(p, ref, hand));
      if (r.error) return toast(r.error);
      ui.menu = null;
      ui.sel = r.junctionId ? { kind: 'junction', id: r.junctionId } : ui.sel;
      renderAll();
      scrollToSel();
      toast('Crossover added. Carry on from the new points: their toe one way, their straight road the other.');
    };
    const crossoverItems = diverging
      ? [pieceButton('crossover', 'Crossover to a track alongside', 'Opposing points of the same hand', () => crossover())]
      : [
          pieceButton('crossover', 'Right-hand crossover', 'Points here, then across to a track alongside', () => crossover('pointsRight')),
          pieceButton('crossoverLeft', 'Left-hand crossover', 'Points here, then across to a track alongside', () => crossover('pointsLeft')),
        ];
    const items = [
      pieceButton('track', 'Track circuit', 'The line continues', () => growHere(ref, 'track')),
      pieceButton('curveLeft', 'Curve left', 'The line turns to the left', () => growHere(ref, 'curveLeft')),
      pieceButton('curveRight', 'Curve right', 'The line turns to the right', () => growHere(ref, 'curveRight')),
      ...(diverging ? crossoverItems : []),
      pieceButton('bufferStops', 'Buffer stops', 'The line ends here', () => growHere(ref, 'bufferStops')),
      pieceButton('exit', 'Leaves the scene', 'To a fiddle yard or another box', () => growHere(ref, 'exit')),
      ...GROW_JUNCTIONS.map((k) => pieceButton(k, JUNCTIONS[k].name, JUNCTIONS[k].sub, () => growHere(ref, k))),
      ...(diverging ? [] : crossoverItems),
      pieceButton('join', 'Join to another end', 'Tap a second + to link them', () => {
        ui.pick = { kind: 'join', from: ref };
        ui.menu = null;
        renderAll();
      }),
    ];
    const way = (trailing: boolean, label: string) =>
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          'aria-pressed': String(ui.trailing === trailing),
          on: {
            click: () => {
              ui.trailing = trailing;
              renderMenu();
            },
          },
        },
        label,
      );
    menuEl.replaceChildren(
      h('div', { class: 'tp-menu-head' }, h('span', { class: 'shelf-label' }, `Add to ${refText(ref)}`), close),
      h(
        'div',
        { class: 'tp-way' },
        h('span', { class: 'field-label', id: 'tp_way' }, 'New points and slips'),
        h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'tp_way' }, way(false, 'Facing: the line divides'), way(true, 'Trailing: lines join')),
      ),
      h('div', { class: 'tp-menu-grid' }, ...items),
    );
    menuEl.hidden = false;
    positionMenu();
    window.setTimeout(() => (menuEl.querySelector('.tp-pick') as HTMLElement | null)?.focus({ preventScroll: true }), 0);
  };

  /** Keep the menu beside its +, following the board as it scrolls. It may hang below the board. */
  const positionMenu = () => {
    const ref = ui.menu;
    if (menuEl.hidden || !ref) return;
    const a = plusAt(plan(), ref);
    if (!a) return;
    const border = 8;
    const px = boardEl.offsetLeft + border + X(a.x) - boardEl.scrollLeft;
    const py = boardEl.offsetTop + border + Y(a.y) - boardEl.scrollTop;
    const wrapW = boardWrap.clientWidth;
    const menuW = Math.min(460, Math.max(260, wrapW - 16));
    menuEl.style.width = `${menuW}px`;
    menuEl.style.left = `${Math.max(8, Math.min(px + 20, wrapW - menuW - 8))}px`;
    menuEl.style.top = `${Math.max(8, py + 20)}px`;
  };

  // ---------------------------------------------------------------- pointer and keyboard
  const readHit = (t: EventTarget | null): { hit: Hit; el: Element } | null => {
    const el = (t as Element | null)?.closest?.('[data-hit]');
    if (!el) return null;
    try {
      return { hit: JSON.parse(el.getAttribute('data-hit')!) as Hit, el };
    } catch {
      return null;
    }
  };

  const dragFor = (hit: Hit): Drag | null => {
    if (ui.pick) return null;
    const p = plan();
    if (hit.t === 'bend') {
      const v = findCircuit(p, hit.circuitId)?.via?.[hit.i];
      return v ? { kind: 'bend', circuitId: hit.circuitId, i: hit.i, ox: v.x, oy: v.y } : null;
    }
    if (hit.t === 'junction') {
      const j = findJunction(p, hit.id);
      return j ? { kind: 'junction', id: j.id, ox: j.x, oy: j.y } : null;
    }
    if (hit.t === 'end' || (hit.t === 'open' && hit.ref.kind === 'end')) {
      const circuitId = hit.t === 'end' ? hit.circuitId : (hit.ref as { circuitId: string }).circuitId;
      const end = hit.t === 'end' ? hit.end : (hit.ref as { end: 0 | 1 }).end;
      const e = findCircuit(p, circuitId)?.ends[end];
      return e && e.kind !== 'joined' ? { kind: 'end', circuitId, end, ox: e.x, oy: e.y } : null;
    }
    if (hit.t === 'circuit') {
      const c = findCircuit(p, hit.id);
      return c && c.ends.some((e) => e.kind !== 'joined') ? { kind: 'circuit', id: c.id } : null;
    }
    return null;
  };

  const applyDrag = (p: TrackPlan, g: Drag, dx: number, dy: number) => {
    if (g.kind === 'bend') moveBend(p, g.circuitId, g.i, g.ox + dx, g.oy + dy);
    else if (g.kind === 'junction') moveJunction(p, g.id, g.ox + dx, g.oy + dy);
    else if (g.kind === 'end') moveEnd(p, g.circuitId, g.end, g.ox + dx, g.oy + dy);
    else shiftCircuit(p, g.id, dx, dy);
  };

  const activate = (hit: Hit) => {
    const pick = ui.pick;
    if (hit.t === 'open') {
      if (pick?.kind === 'join') {
        if (sameRef(pick.from, hit.ref)) return cancelPick();
        const r = edit((p) => joinOpenEnds(p, pick.from, hit.ref));
        if (r.error) return toast(r.error);
        ui.pick = null;
        ui.sel = r.circuitId ? { kind: 'circuit', id: r.circuitId } : null;
        renderAll();
        return toast('Joined.');
      }
      if (pick) return toast('Tap a track, not a +.');
      if (ui.tab !== 'plan') {
        ui.tab = 'plan';
      }
      ui.menu = sameRef(ui.menu, hit.ref) ? null : hit.ref;
      renderAll();
      return;
    }
    if (hit.t === 'bend') {
      if (pick) return;
      ui.sel = { kind: 'circuit', id: hit.circuitId };
      ui.bend = ui.bend === hit.i ? null : hit.i;
      ui.menu = null;
      renderAll();
      return;
    }
    const circuitId = hit.t === 'circuit' ? hit.id : hit.t === 'end' ? hit.circuitId : null;
    if (pick?.kind === 'parallel' || pick?.kind === 'parallelChoose') {
      if (!circuitId) return toast('Tap a track circuit.');
      if (circuitId === pick.from) return toast('Tap the other track: the one that runs alongside.');
      ui.pick = { kind: 'parallelChoose', from: pick.from, to: circuitId };
      renderAll();
      return;
    }
    if (pick?.kind === 'join') return toast('Tap a + to join to, or Cancel.');
    ui.menu = null;
    const next: Sel = circuitId ? { kind: 'circuit', id: circuitId } : hit.t === 'junction' ? { kind: 'junction', id: hit.id } : null;
    if (next?.kind !== ui.sel?.kind || next?.id !== ui.sel?.id) ui.bend = null;
    ui.sel = next;
    renderAll();
  };

  boardEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || pinch) return;
    const found = readHit(e.target);
    if (!found) {
      // On the background: a tap clears the selection (a drag scrolls).
      if ((e.target as Element).closest('.tp-svg')) drag = { hit: null, drag: null, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, pointerId: e.pointerId, base: '' };
      return;
    }
    const g = dragFor(found.hit);
    drag = { hit: found.hit, drag: g, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, pointerId: e.pointerId, base: JSON.stringify(plan()) };
    if (g) {
      try {
        boardEl.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable */
      }
      frozenBounds = planBounds(plan());
    }
  });
  boardEl.addEventListener('pointermove', (e: PointerEvent) => {
    if (pinch) return;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.drag) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag = null;
      return;
    }
    const dx = Math.round((e.clientX - drag.sx) / view.u);
    const dy = Math.round((e.clientY - drag.sy) / view.u);
    if (dx === drag.dx && dy === drag.dy) return;
    drag.dx = dx;
    drag.dy = dy;
    menuEl.hidden = true;
    const work = JSON.parse(drag.base) as TrackPlan;
    applyDrag(work, drag.drag, dx, dy);
    const sl = boardEl.scrollLeft;
    const st = boardEl.scrollTop;
    renderBoard(work);
    boardEl.scrollLeft = sl;
    boardEl.scrollTop = st;
  });
  const endPointer = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dd = drag;
    drag = null;
    frozenBounds = null;
    const sl = boardEl.scrollLeft;
    const st = boardEl.scrollTop;
    if (cancelled) renderBoard();
    else if (dd.drag && (dd.dx || dd.dy)) {
      edit((p) => applyDrag(p, dd.drag!, dd.dx, dd.dy));
      if (dd.drag.kind === 'bend') {
        ui.sel = { kind: 'circuit', id: dd.drag.circuitId };
        ui.bend = dd.drag.i;
      }
      renderAll();
    } else {
      // A tap: act on the click that follows, so that a menu opened by the tap
      // cannot catch that click (on a phone it would land on a menu item).
      tapped = { hit: dd.hit, at: Date.now() };
    }
    boardEl.scrollLeft = sl;
    boardEl.scrollTop = st;
  };
  let tapped: { hit: Hit | null; at: number } | null = null;
  boardEl.addEventListener('click', () => {
    const t = tapped;
    tapped = null;
    if (!t || Date.now() - t.at > 1000) return;
    if (t.hit) activate(t.hit);
    else if (!ui.pick && (ui.sel || ui.menu)) {
      // A tap on the background clears the selection.
      ui.sel = null;
      ui.menu = null;
      renderAll();
    }
  });
  boardEl.addEventListener('pointerup', (e) => endPointer(e, false));
  boardEl.addEventListener('pointercancel', (e) => endPointer(e, true));

  // Pinch to zoom on touch screens; ctrl + wheel (and trackpad pinch) on a computer.
  // While the fingers move, the drawing is only stretched (its elements must stay in the
  // page, or the browser stops sending the touches); it is redrawn at the new zoom when
  // the pinch ends.
  let pinch: { d0: number; z0: number; w: number; h: number; scale: number } | null = null;
  let pinchFrame = 0;
  const touchInfo = (t: TouchList) => {
    const a = t[0];
    const b = t[1];
    return { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  };
  const svgNow = () => svgHost.firstElementChild as SVGSVGElement | null;
  boardEl.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      // A second finger turns a drag or tap into a pinch.
      if (drag?.drag) {
        drag = null;
        frozenBounds = null;
        renderBoard();
      }
      drag = null;
      tapped = null;
      const el = svgNow();
      if (!el) return;
      menuEl.hidden = true;
      pinch = { d0: touchInfo(e.touches).d, z0: ui.zoom, w: Number(el.getAttribute('width')), h: Number(el.getAttribute('height')), scale: 1 };
    },
    { passive: false },
  );
  const stretch = (p: NonNullable<typeof pinch>, scale: number, clientX: number, clientY: number) => {
    const el = svgNow();
    if (!el) return;
    const r = boardEl.getBoundingClientRect();
    const mx = clientX - r.left - boardEl.clientLeft;
    const my = clientY - r.top - boardEl.clientTop;
    // Point of the drawing (in its own units) under the fingers.
    const gx = (boardEl.scrollLeft + mx) / p.scale;
    const gy = (boardEl.scrollTop + my) / p.scale;
    p.scale = scale;
    el.setAttribute('width', String(Math.round(p.w * scale)));
    el.setAttribute('height', String(Math.round(p.h * scale)));
    boardEl.scrollLeft = gx * scale - mx;
    boardEl.scrollTop = gy * scale - my;
  };
  const onPinchMove = (e: TouchEvent) => {
    if (!pinch || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const t = touchInfo(e.touches);
    const p = pinch;
    const z = clampZoom((p.z0 * t.d) / p.d0);
    cancelAnimationFrame(pinchFrame);
    pinchFrame = requestAnimationFrame(() => pinch === p && stretch(p, z / p.z0, t.x, t.y));
  };
  const endPinch = (e: TouchEvent) => {
    if (!pinch || e.touches.length >= 2) return;
    const p = pinch;
    pinch = null;
    tapped = null;
    cancelAnimationFrame(pinchFrame);
    // Redraw properly at the new zoom, keeping the middle of the board where it was.
    const mx = boardEl.clientWidth / 2;
    const my = boardEl.clientHeight / 2;
    const gx = view.ox + (boardEl.scrollLeft + mx) / (view.u * p.scale);
    const gy = view.oy + (boardEl.scrollTop + my) / (view.u * p.scale);
    ui.zoom = clampZoom(p.z0 * p.scale);
    ui.zoomChosen = true;
    renderBoard();
    boardEl.scrollLeft = (gx - view.ox) * view.u - mx;
    boardEl.scrollTop = (gy - view.oy) * view.u - my;
  };
  window.addEventListener('touchmove', onPinchMove, { passive: false });
  window.addEventListener('touchend', endPinch);
  window.addEventListener('touchcancel', endPinch);
  ctx.onLeave(() => {
    window.removeEventListener('touchmove', onPinchMove);
    window.removeEventListener('touchend', endPinch);
    window.removeEventListener('touchcancel', endPinch);
  });
  // Safari's own page-zoom gesture
  boardEl.addEventListener('gesturestart', (e) => e.preventDefault());
  boardEl.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomAt(ui.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    },
    { passive: false },
  );

  boardEl.addEventListener('keydown', (e: KeyboardEvent) => {
    const found = readHit(e.target);
    if (!found) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(found.hit);
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const mv = arrows[e.key];
    if (!mv) return;
    const g = dragFor(found.hit);
    if (!g) return;
    e.preventDefault();
    edit((p) => applyDrag(p, g, mv[0], mv[1]));
    renderAll();
    // Keep focus on the moved item.
    window.setTimeout(() => {
      const key = JSON.stringify(found.hit);
      const el = [...svgHost.querySelectorAll<SVGElement>('[data-hit]')].find((x) => x.getAttribute('data-hit') === key);
      el?.focus();
    }, 0);
  });

  root.addEventListener('keydown', (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    if (e.key === 'Escape') {
      if (ui.pick) cancelPick();
      else if (ui.menu) {
        ui.menu = null;
        renderAll();
      } else if (ui.sel && !typing) {
        ui.sel = null;
        renderAll();
      }
      return;
    }
    if (typing || !(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  });

  // ---------------------------------------------------------------- status strip
  const issuesFor = (): PlanIssue[] => {
    const all = planIssues(store.state);
    return ui.tab === 'plan' ? all.filter((i) => i.kind === 'openEnd' || i.kind === 'duplicateNumber') : all.filter((i) => i.kind === 'unassignedCircuit' || i.kind === 'unassignedJunction');
  };
  const showIssue = (i: PlanIssue) => {
    ui.pick = null;
    if (i.kind === 'openEnd') {
      ui.menu = ui.tab === 'plan' ? i.ref : null;
      ui.sel = i.ref.kind === 'end' ? { kind: 'circuit', id: i.ref.circuitId } : { kind: 'junction', id: i.ref.junctionId };
    } else if (i.kind === 'unassignedCircuit') ui.sel = { kind: 'circuit', id: i.circuitId };
    else ui.sel = { kind: 'junction', id: i.junctionId };
    renderAll();
    scrollToSel();
  };
  const renderStatus = () => {
    const p = plan();
    if (!p.circuits.length && !p.junctions.length) {
      statusEl.replaceChildren();
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    const issues = issuesFor();
    const counts = `${p.circuits.length} track circuit${p.circuits.length === 1 ? '' : 's'} · ${junctions(p.junctions.filter((j) => j.kind !== 'joint').length)}`;
    if (!issues.length) {
      statusEl.className = 'tp-status ok';
      statusEl.replaceChildren(h('span', null, ui.tab === 'plan' ? 'Every end is finished.' : 'All track is given to a box or line.'), h('span', { class: 'tp-counts' }, counts));
      return;
    }
    statusEl.className = 'tp-status';
    ui.issueIdx %= issues.length;
    const cur = issues[ui.issueIdx];
    statusEl.replaceChildren(
      h('span', null, `${issues.length} to do: ${cur.text}`),
      h('span', { class: 'tp-counts' }, counts),
      h(
        'span',
        { class: 'row' },
        h('button', { class: 'btn small', type: 'button', on: { click: () => showIssue(cur) } }, 'Show me'),
        issues.length > 1
          ? h(
              'button',
              {
                class: 'btn small',
                type: 'button',
                on: {
                  click: () => {
                    ui.issueIdx = (ui.issueIdx + 1) % issues.length;
                    showIssue(issues[ui.issueIdx]);
                  },
                },
              },
              'Next',
            )
          : null,
      ),
    );
  };

  // ---------------------------------------------------------------- inspector
  const checked = (id: string, label: string, value: string, max: number, check: (v: string) => string | null, apply: (v: string) => void, help?: string) => {
    const input = h('input', { type: 'text', id, value, maxlength: max, autocomplete: 'off' });
    const err = h('small', { class: 'field-error', id: `${id}_err`, role: 'alert', hidden: true });
    const show = (msg: string | null) => {
      err.textContent = msg ?? '';
      err.hidden = !msg;
      input.classList.toggle('invalid', !!msg);
    };
    input.setAttribute('aria-describedby', `${id}_err`);
    input.addEventListener('input', () => show(check(input.value)));
    input.addEventListener('change', () => {
      const msg = check(input.value);
      show(msg);
      if (!msg && input.value.trim() !== value) apply(input.value.trim());
    });
    return h('div', { class: 'field' }, h('label', { for: id }, label), input, err, help ? h('small', { class: 'help' }, help) : null);
  };
  const selectField = (id: string, label: string, sel: HTMLSelectElement, help?: string) => {
    sel.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), sel, help ? h('small', { class: 'help' }, help) : null);
  };

  const ownerOptions = (current: TrackOwner) => {
    const val = current.kind === 'box' ? `box|${current.boxId}` : current.kind === 'line' ? `line|${current.boxId}|${current.connectionId}` : 'none';
    const opts = [option('none', 'Not assigned', val === 'none'), ...store.state.boxes.map((b) => option(`box|${b.id}`, b.name, val === `box|${b.id}`))];
    for (const b of store.state.boxes) for (const c of b.connections) opts.push(option(`line|${b.id}|${c.id}`, lineName(b.id, c.id), val === `line|${b.id}|${c.id}`));
    return opts;
  };
  const parseOwner = (v: string): TrackOwner => {
    const [k, a, b] = v.split('|');
    if (k === 'box') return { kind: 'box', boxId: a };
    if (k === 'line') return { kind: 'line', boxId: a, connectionId: b };
    return { kind: 'none' };
  };

  const summaryCase = () => {
    const p = plan();
    const st = store.state;
    if (ui.tab === 'areas') {
      const rows = st.boxes.map((b) => {
        const nC = p.circuits.filter((c) => c.owner.kind === 'box' && c.owner.boxId === b.id).length;
        const nJ = p.junctions.filter((j) => j.boxId === b.id && j.kind !== 'joint').length;
        return keyRow(boxColour(b.id), undefined, b.name, `${nC} track circuit${nC === 1 ? '' : 's'} · ${junctions(nJ)}`);
      });
      const lines = p.circuits.filter((c) => c.owner.kind === 'line');
      const none = p.circuits.filter((c) => c.owner.kind === 'none').length;
      return [
        h('span', { class: 'plate' }, 'Signal boxes'),
        h('p', { class: 'help' }, 'Tap a track circuit to give it, or its whole branch, to a box. Track between two boxes belongs to the line that joins them.'),
        h('div', { class: 'tp-key' }, ...rows, keyRow(LINE_GREY, '9 5', 'Lines between boxes', lines.length ? lines.map((c) => c.code).join(', ') : 'None yet'), keyRow(INK, undefined, 'Not assigned', `${none} track circuit${none === 1 ? '' : 's'}`)),
      ];
    }
    return [
      h('span', { class: 'plate' }, 'Track plan'),
      h('p', { class: 'help' }, 'Tap a + on any unfinished end to add the next piece. Tap a track or points to change them here. Drag points and track ends to tidy the drawing.'),
      h('p', { class: 'help' }, 'For a crossover, tap the + on a turnout road (or the end of a track) and choose Crossover: opposing points of the same hand start the track alongside. To join two tracks already laid side by side, select one and choose Connect to a parallel track.'),
      h('p', { class: 'help' }, 'Track circuits that meet at a joint (the short tick across the line) can be made into one: select either and press Merge.'),
      p.circuits.length ? null : h('button', { class: 'btn primary', type: 'button', on: { click: layNewTrack } }, 'Lay the first track'),
    ];
  };
  const keyRow = (colour: string, dash: string | undefined, title: string, sub: string) =>
    h(
      'div',
      { class: 'tp-key-row' },
      svg('svg', { width: 44, height: 16, viewBox: '0 0 44 16', class: 'tp-swatch', 'aria-hidden': 'true' }, svg('path', { d: 'M4 8H40', stroke: colour, 'stroke-width': 5, 'stroke-dasharray': dash })),
      h('span', null, h('strong', null, title), h('small', { class: 'help' }, sub)),
    );

  const endName = (c: TrackCircuit, i: 0 | 1) => {
    const a = endAnchor(plan(), c.ends[0]);
    const b = endAnchor(plan(), c.ends[1]);
    if (!a || !b) return i === 0 ? 'One end' : 'Other end';
    if (a.x !== b.x) return (i === 0) === a.x < b.x ? 'Left end' : 'Right end';
    return (i === 0) === a.y < b.y ? 'Top end' : 'Bottom end';
  };

  const endRow = (c: TrackCircuit, i: 0 | 1) => {
    const e = c.ends[i];
    const title = h('span', { class: 'field-label' }, endName(c, i));
    if (e.kind === 'joined') {
      const j = findJunction(plan(), e.junctionId);
      const pd = j ? portDef(j.kind, e.port) : null;
      return h(
        'div',
        { class: 'tp-end' },
        h('div', null, title, h('small', { class: 'help' }, j ? `Joined to ${junctionName(j)}${j.kind === 'joint' ? '' : ` · ${pd?.label.toLowerCase()}`}` : 'Joined')),
        h(
          'div',
          { class: 'row' },
          (() => {
            const x = acrossJoint(plan(), c.id, i);
            return x
              ? h(
                  'button',
                  {
                    class: 'btn small primary',
                    type: 'button',
                    on: {
                      click: () => {
                        const r = edit((pl) => mergeAtJoint(pl, x.joint.id, c.id));
                        if (r.error) return toast(r.error);
                        renderAll();
                        toast(`${x.circuit.code} merged into ${c.code}.`);
                      },
                    },
                  },
                  `Merge with ${x.circuit.code}`,
                )
              : null;
          })(),
          j ? h('button', { class: 'btn small', type: 'button', on: { click: () => ((ui.sel = { kind: 'junction', id: j.id }), renderAll()) } }, 'Select') : null,
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              on: {
                click: () => {
                  edit((p) => detachEnd(p, c.id, i));
                  renderAll();
                },
              },
            },
            'Unjoin',
          ),
        ),
      );
    }
    const kinds: Array<['open' | 'bufferStops' | 'exit', string]> = [
      ['open', 'Not finished'],
      ['bufferStops', 'Buffer stops'],
      ['exit', 'Leaves the scene'],
    ];
    const groupId = `tp_end_${i}`;
    const seg = h(
      'div',
      { class: 'seg tp-seg', role: 'group', 'aria-labelledby': groupId },
      ...kinds.map(([k, label]) =>
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            'aria-pressed': String(e.kind === k),
            on: {
              click: () => {
                if (e.kind === k) return;
                edit((p) => setEndKind(p, c.id, i, k));
                renderAll();
              },
            },
          },
          label,
        ),
      ),
    );
    title.id = groupId;
    let extra: HTMLElement | null = null;
    if (e.kind === 'exit') {
      const val = e.to.kind === 'fiddleYard' ? `fy|${e.to.yardId}` : e.to.kind === 'connection' ? `conn|${e.to.boxId}|${e.to.connectionId}` : 'off';
      const opts = [option('off', 'Off the scene', val === 'off'), ...store.state.fiddleYards.map((y) => option(`fy|${y.id}`, y.name, val === `fy|${y.id}`))];
      for (const b of store.state.boxes) for (const cn of b.connections) opts.push(option(`conn|${b.id}|${cn.id}`, `Line to ${cn.neighbourName} (from ${b.name})`, val === `conn|${b.id}|${cn.id}`));
      extra = selectField(
        `tp_exit_${i}`,
        'Leads to',
        h(
          'select',
          {
            on: {
              change: (ev: Event) => {
                const [k, a, b] = (ev.target as HTMLSelectElement).value.split('|');
                const to: ExitTarget = k === 'fy' ? { kind: 'fiddleYard', yardId: a } : k === 'conn' ? { kind: 'connection', boxId: a, connectionId: b } : { kind: 'offScene' };
                edit((p) => setExitTarget(p, c.id, i, to));
                renderAll();
              },
            },
          },
          ...opts,
        ),
      );
    } else if (e.kind === 'open') {
      extra = h('button', { class: 'btn small primary', type: 'button', on: { click: () => ((ui.menu = { kind: 'end', circuitId: c.id, end: i }), renderAll()) } }, 'Add…');
    }
    return h('div', { class: 'tp-end tp-end-free' }, title, seg, extra);
  };

  /** Arrow buttons that move a piece one square (easier than dragging on a phone). */
  const nudgePad = (label: string, move: (dx: number, dy: number) => void, help: string, what = '') => {
    const b = (text: string, aria: string, dx: number, dy: number) =>
      h('button', { class: 'btn small tp-nudge-btn', type: 'button', 'aria-label': what ? aria.replace('Move', `Move ${what}`) : aria, on: { click: () => move(dx, dy) } }, text);
    return h(
      'div',
      { class: 'tp-nudge' },
      h('span', { class: 'field-label' }, label),
      h('div', { class: 'tp-nudge-pad' }, b('◀', 'Move left', -1, 0), b('▲', 'Move up', 0, -1), b('▼', 'Move down', 0, 1), b('▶', 'Move right', 1, 0)),
      h('small', { class: 'help' }, help),
    );
  };

  const circuitCase = (c: TrackCircuit) => {
    const p = plan();
    const els: Array<HTMLElement | null> = [];
    els.push(h('div', { class: 'tp-plate-row' }, h('span', { class: 'plate' }, circuitLabel(c)), h('small', { class: 'help' }, `Track circuit · ${ownerText(c.owner)}`)));
    if (ui.tab === 'plan') {
      els.push(
        h(
          'div',
          { class: 'tp-two' },
          checked('tp_code', 'Code', c.code, CODE_MAX, (v) => checkCircuitCode(plan(), v, c.id), (v) => {
            edit((pl) => {
              const x = findCircuit(pl, c.id);
              if (x) x.code = v;
            });
            renderAll();
          }),
          checked('tp_name', 'Name', c.name, 40, () => null, (v) => {
            edit((pl) => {
              const x = findCircuit(pl, c.id);
              if (x) x.name = v;
            });
            renderAll();
          }),
        ),
      );
    }
    els.push(
      selectField(
        'tp_owner',
        'Signal box',
        h(
          'select',
          {
            on: {
              change: (ev: Event) => {
                const o = parseOwner((ev.target as HTMLSelectElement).value);
                edit((pl) => {
                  const x = findCircuit(pl, c.id);
                  if (x) x.owner = o;
                });
                renderAll();
              },
            },
          },
          ...ownerOptions(c.owner),
        ),
        'The box whose track this is, or the line between two boxes (the block section).',
      ),
    );
    if (ui.tab === 'areas' && c.owner.kind !== 'line' && store.state.boxes.length) {
      const br = branchFrom(p, c.id);
      const n = br.circuits.length + br.junctions.length;
      const giveSel = h('select', { id: 'tp_give' }, ...store.state.boxes.map((b) => option(b.id, b.name, c.owner.kind === 'box' ? b.id === c.owner.boxId : false)));
      els.push(
        h(
          'div',
          { class: 'tp-give' },
          selectField('tp_give', 'Give this branch to', giveSel, `${c.code} and the track joined to it (highlighted), up to lines between boxes and other boxes' track: ${br.circuits.length} track circuit${br.circuits.length === 1 ? '' : 's'}, ${junctions(br.junctions.filter((j) => j.kind !== 'joint').length)}.`),
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              on: {
                click: () => {
                  const boxId = giveSel.value;
                  const count = edit((pl) => giveBranch(pl, c.id, boxId));
                  renderAll();
                  toast(`${count} piece${count === 1 ? '' : 's'} given to ${boxName(boxId)}.`);
                },
              },
            },
            `Give ${n} piece${n === 1 ? '' : 's'} to the box`,
          ),
        ),
      );
    }
    if (ui.tab === 'plan') {
      els.push(h('div', { class: 'tp-ends' }, h('h3', { class: 'shelf-label' }, 'Ends'), endRow(c, 0), endRow(c, 1)));
      if (c.ends.some((e) => e.kind !== 'joined'))
        els.push(
          nudgePad(
            'Move its free end' + (c.ends.every((e) => e.kind !== 'joined') ? 's' : ''),
            (dx, dy) => {
              edit((pl) => shiftCircuit(pl, c.id, dx, dy));
              renderAll();
            },
            'Joined ends stay with their points; the track re-draws to follow.',
            'track',
          ),
        );
      // Curves: bends in the track, drawn rounded.
      const bends = c.via ?? [];
      const bendSel = ui.bend !== null && ui.bend < bends.length ? ui.bend : null;
      els.push(
        h(
          'div',
          { class: 'tp-bends' },
          h('h3', { class: 'shelf-label' }, 'Curves'),
          h(
            'small',
            { class: 'help' },
            bends.length
              ? `${bends.length} bend${bends.length === 1 ? '' : 's'}. Drag a bend (the round handle on the track) to shape the curve, or tap one to move it with the arrows.`
              : 'Add a bend, then drag its handle to make the track curve round a corner.',
          ),
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                class: 'btn small',
                type: 'button',
                on: {
                  click: () => {
                    const r = edit((pl) => addBend(pl, c.id));
                    if (r.error) return toast(r.error);
                    ui.bend = r.index ?? null;
                    renderAll();
                  },
                },
              },
              'Add a bend',
            ),
            bendSel !== null
              ? h(
                  'button',
                  {
                    class: 'btn small danger',
                    type: 'button',
                    on: {
                      click: () => {
                        edit((pl) => removeBend(pl, c.id, bendSel));
                        ui.bend = null;
                        renderAll();
                      },
                    },
                  },
                  'Remove this bend',
                )
              : null,
            bends.length
              ? h(
                  'button',
                  {
                    class: 'btn small',
                    type: 'button',
                    on: {
                      click: () => {
                        edit((pl) => removeBend(pl, c.id));
                        ui.bend = null;
                        renderAll();
                      },
                    },
                  },
                  'Straighten',
                )
              : null,
          ),
          bendSel !== null
            ? nudgePad(
                `Move bend ${bendSel + 1}`,
                (dx, dy) => {
                  edit((pl) => {
                    const v = findCircuit(pl, c.id)?.via?.[bendSel];
                    if (v) moveBend(pl, c.id, bendSel, v.x + dx, v.y + dy);
                  });
                  renderAll();
                },
                'The curve re-draws as it moves.',
                'bend',
              )
            : null,
        ),
      );
      // Parallel track: same shape, one track spacing away.
      els.push(
        h(
          'div',
          { class: 'tp-parallel' },
          h('h3', { class: 'shelf-label' }, 'Double track'),
          h(
            'div',
            { class: 'row' },
            ...parallelSideNames(plan(), c.id).map((sd) =>
              h(
                'button',
                {
                  class: 'btn small',
                  type: 'button',
                  on: {
                    click: () => {
                      const r = edit((pl) => parallelTrack(pl, c.id, sd.side));
                      if (r.error) return toast(r.error);
                      ui.sel = r.circuitId ? { kind: 'circuit', id: r.circuitId } : ui.sel;
                      ui.bend = null;
                      renderAll();
                      toast(`Parallel track laid ${sd.name} ${c.code}.`);
                    },
                  },
                },
                `Lay a parallel track ${sd.name}`,
              ),
            ),
          ),
          h('small', { class: 'help' }, 'Same shape, one track spacing away, with unfinished ends to carry on from. Then use Connect to a parallel track for crossovers.'),
        ),
      );
      els.push(
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            on: {
              click: () => {
                ui.pick = { kind: 'parallel', from: c.id };
                ui.menu = null;
                renderAll();
              },
            },
          },
          'Connect to a parallel track',
        ),
      );
      // Points (or a crossing) in the middle of this track
      const kindSel = h(
        'select',
        { on: { change: (ev: Event) => (ui.insertKind = (ev.target as HTMLSelectElement).value as JunctionKind) } },
        ...INSERT_JUNCTIONS.map((k) => option(k, JUNCTIONS[k].name, k === ui.insertKind)),
      );
      const faceSeg = h(
        'div',
        { class: 'seg', role: 'group', 'aria-labelledby': 'tp_face' },
        h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(!ui.insertFlip), on: { click: () => ((ui.insertFlip = false), renderSideNow()) } }, 'Left'),
        h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(ui.insertFlip), on: { click: () => ((ui.insertFlip = true), renderSideNow()) } }, 'Right'),
      );
      els.push(
        h(
          'details',
          { class: 'tp-insert' },
          h('summary', null, 'Put points in this track'),
          selectField('tp_ins_kind', 'Type', kindSel),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'tp_face' }, 'Toe faces'), faceSeg),
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              on: {
                click: () => {
                  const r = edit((pl) => addJunctionInTrack(pl, c.id, ui.insertKind, ui.insertFlip));
                  if (r.error) return toast(r.error);
                  ui.sel = r.junction ? { kind: 'junction', id: r.junction.id } : ui.sel;
                  renderAll();
                },
              },
            },
            'Add to the middle of the track',
          ),
        ),
      );
      els.push(
        h(
          'div',
          { class: 'row tp-actions' },
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              on: {
                click: () => {
                  const r = edit((pl) => splitCircuit(pl, c.id));
                  if (r.error) return toast(r.error);
                  renderAll();
                  toast(`Split: ${c.code} and ${r.newCircuit?.code}.`);
                },
              },
            },
            'Split in two',
          ),
          confirmButton('Delete track circuit', 'Press again to delete', () => {
            edit((pl) => deleteCircuit(pl, c.id));
            ui.sel = null;
            renderAll();
          }, 'btn danger small'),
        ),
      );
    }
    return els;
  };

  const junctionCase = (j: Junction) => {
    const def = JUNCTIONS[j.kind];
    const els: Array<HTMLElement | null> = [];
    els.push(h('div', { class: 'tp-plate-row' }, h('span', { class: 'plate' }, junctionName(j)), h('small', { class: 'help' }, `${def.name}${j.kind === 'joint' ? '' : ` · ${j.boxId ? `worked by ${boxName(j.boxId)}` : 'not worked by a box yet'}`}`)));
    if (j.kind !== 'joint') {
      els.push(
        h(
          'div',
          { class: 'tp-two' },
          checked('tp_num', 'Number', j.number, 6, checkJunctionNumber, (v) => {
            edit((pl) => {
              const x = findJunction(pl, j.id);
              if (x) x.number = v;
            });
            renderAll();
          }, 'e.g. its lever number'),
          ui.tab === 'plan'
            ? selectField(
                'tp_kind',
                'Type',
                h(
                  'select',
                  {
                    on: {
                      change: (ev: Event) => {
                        edit((pl) => setJunctionKind(pl, j.id, (ev.target as HTMLSelectElement).value as JunctionKind));
                        renderAll();
                      },
                    },
                  },
                  ...GROW_JUNCTIONS.map((k) => option(k, JUNCTIONS[k].name, k === j.kind)),
                ),
              )
            : null,
        ),
      );
      els.push(
        selectField(
          'tp_jbox',
          'Worked by',
          h(
            'select',
            {
              on: {
                change: (ev: Event) => {
                  const v = (ev.target as HTMLSelectElement).value;
                  edit((pl) => {
                    const x = findJunction(pl, j.id);
                    if (x) x.boxId = v;
                  });
                  renderAll();
                },
              },
            },
            option('', 'Not assigned', !j.boxId),
            ...store.state.boxes.map((b) => option(b.id, b.name, b.id === j.boxId)),
          ),
          j.kind === 'turntable' ? 'Turntables are usually worked on the spot: leave this unassigned unless a box controls it.' : 'The signal box whose levers work it.',
        ),
      );
    }
    if (ui.tab === 'plan' && j.kind === 'joint') {
      const ua = portUse(plan(), j.id, 'a');
      const ub = portUse(plan(), j.id, 'b');
      if (ua && ub && ua.circuit.id !== ub.circuit.id)
        els.push(
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              on: {
                click: () => {
                  const r = edit((pl) => mergeAtJoint(pl, j.id, ua.circuit.id));
                  if (r.error) return toast(r.error);
                  ui.sel = r.circuitId ? { kind: 'circuit', id: r.circuitId } : null;
                  renderAll();
                  toast(`${ub.circuit.code} merged into ${ua.circuit.code}.`);
                },
              },
            },
            `Merge ${ua.circuit.code} and ${ub.circuit.code} into one track circuit`,
          ),
        );
    }
    if (ui.tab === 'plan') {
      els.push(
        nudgePad(
          'Move',
          (dx, dy) => {
            edit((pl) => {
              const x = findJunction(pl, j.id);
              if (x) moveJunction(pl, j.id, x.x + dx, x.y + dy);
            });
            renderAll();
          },
          'Its tracks follow.',
        ),
      );
      if (j.kind === 'turntable') {
        const roads = new Set(j.roads ?? []);
        els.push(
          h(
            'fieldset',
            { class: 'tp-roads' },
            h('legend', { class: 'field-label' }, 'Roads round the deck'),
            h(
              'div',
              { class: 'tp-roads-grid' },
              ...def.ports.map((pd) =>
                h(
                  'label',
                  { class: 'check' },
                  h('input', {
                    type: 'checkbox',
                    checked: roads.has(pd.id),
                    on: {
                      change: (ev: Event) => {
                        const on = (ev.target as HTMLInputElement).checked;
                        const next = def.ports.map((x) => x.id).filter((id) => (id === pd.id ? on : roads.has(id)));
                        edit((pl) => setTurntableRoads(pl, j.id, next));
                        renderAll();
                      },
                    },
                  }),
                  pd.label,
                ),
              ),
            ),
            h('small', { class: 'help' }, 'Numbered clockwise from the entry road. Taking a road away leaves its track unfinished.'),
          ),
        );
      }
      const rows = portsOf(j).map((pd) => {
        const u = portUse(plan(), j.id, pd.id);
        return h(
          'div',
          { class: 'tp-end' },
          h('div', null, h('span', { class: 'field-label' }, pd.label), u ? h('small', { class: 'help' }, circuitLabel(u.circuit)) : h('span', { class: 'chip tp-chip-open' }, 'Not finished')),
          u
            ? h(
                'div',
                { class: 'row' },
                h('button', { class: 'btn small', type: 'button', on: { click: () => ((ui.sel = { kind: 'circuit', id: u.circuit.id }), renderAll()) } }, 'Select'),
                h(
                  'button',
                  {
                    class: 'btn small',
                    type: 'button',
                    on: {
                      click: () => {
                        edit((pl) => detachEnd(pl, u.circuit.id, u.end));
                        renderAll();
                      },
                    },
                  },
                  'Unjoin',
                ),
              )
            : h('button', { class: 'btn small primary', type: 'button', on: { click: () => ((ui.menu = { kind: 'port', junctionId: j.id, port: pd.id }), renderAll()) } }, 'Add…'),
        );
      });
      els.push(h('div', { class: 'tp-ends' }, h('h3', { class: 'shelf-label' }, 'Ends'), ...rows));
      els.push(
        h(
          'div',
          { class: 'row tp-actions' },
          h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              on: {
                click: () => {
                  const r = edit((pl) => turnRound(pl, j.id));
                  if (r.error) return toast(r.error);
                  renderAll();
                },
              },
            },
            'Turn round',
          ),
          j.kind !== 'joint'
            ? h(
                'button',
                {
                  class: 'btn small',
                  type: 'button',
                  on: {
                    click: () => {
                      edit((pl) => rotateQuarter(pl, j.id));
                      renderAll();
                    },
                  },
                },
                'Turn 90°',
              )
            : null,
          MIRRORABLE.includes(j.kind)
            ? h(
                'button',
                {
                  class: 'btn small',
                  type: 'button',
                  on: {
                    click: () => {
                      edit((pl) => mirrorJunction(pl, j.id));
                      renderAll();
                    },
                  },
                },
                'Mirror',
              )
            : null,
          confirmButton(`Delete ${j.kind === 'joint' ? 'joint' : def.name.toLowerCase()}`, 'Press again to delete', () => {
            edit((pl) => deleteJunction(pl, j.id));
            ui.sel = null;
            renderAll();
          }, 'btn danger small'),
        ),
      );
      els.push(
        h(
          'p',
          { class: 'help' },
          j.kind === 'joint'
            ? 'Drag it on the plan, or select it and use the arrow keys, to move it. Its tracks follow.'
            : 'Turn round makes the points face the other way and keeps their hand. With one road joined, that track moves to the road that now faces it, so facing points become trailing points. To change hand, change the type. Drag it, or use the arrow keys, to move it.',
        ),
      );
    }
    return els;
  };

  const renderSideNow = () => {
    const p = plan();
    let content: Array<HTMLElement | null>;
    if (ui.sel?.kind === 'circuit') {
      const c = findCircuit(p, ui.sel.id);
      content = c ? circuitCase(c) : summaryCase();
    } else if (ui.sel?.kind === 'junction') {
      const j = findJunction(p, ui.sel.id);
      content = j ? junctionCase(j) : summaryCase();
    } else content = summaryCase();
    sideEl.replaceChildren(...content.filter((x): x is HTMLElement => !!x));
  };
  const renderSide = safeRerender(() => sideEl, renderSideNow);

  // ---------------------------------------------------------------- everything
  const renderAll = () => {
    if (ui.sel?.kind === 'circuit' && !findCircuit(plan(), ui.sel.id)) ui.sel = null;
    if (ui.sel?.kind === 'junction' && !findJunction(plan(), ui.sel.id)) ui.sel = null;
    renderTabs();
    renderToolbar();
    renderPickbar();
    renderBoard();
    renderStatus();
    renderSide();
    boardEl.classList.toggle('tp-picking', !!ui.pick);
  };

  const unsub = store.subscribe(() => {
    if (quiet || drag) return;
    renderAll();
  });
  ctx.onLeave(() => {
    unsub();
    ui.menu = null;
    ui.pick = null;
  });

  renderTabs();
  renderToolbar();
  renderPickbar();
  renderStatus();
  renderSideNow();
  // The board needs its width, so draw it once the page is on screen.
  window.setTimeout(() => {
    // Phones start further out so more of the plan fits; pinch or the buttons change it.
    if (!ui.zoomChosen) {
      ui.zoom = boardEl.clientWidth < 600 ? 0.65 : 1;
      ui.zoomChosen = true;
    }
    renderBoard();
    if (ui.sel) scrollToSel();
  }, 0);
  const onResize = () => renderBoard();
  window.addEventListener('resize', onResize);
  ctx.onLeave(() => window.removeEventListener('resize', onResize));

  return { title: 'Layout configurator', el: root, live: true };
}

/** One-line summary for the main menu. */
export function trackPlanSummary(state: AppState): string {
  const p = state.trackPlan;
  if (!p.circuits.length) return 'Draw your track plan and give it to your signal boxes';
  const n = p.junctions.filter((j) => j.kind !== 'joint').length;
  return `${p.circuits.length} track circuit${p.circuits.length === 1 ? '' : 's'}, ${junctions(n)}`;
}

