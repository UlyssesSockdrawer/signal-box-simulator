import { postKey, signalPoint, signalRoutes } from '../core/signals';
import { circuitMiddle, findCircuit } from '../core/trackPlan';
import type { AppState, Layout, PlanSignal } from '../core/types';

/*
 * Signals on the diagram, drawn post by post: every signal at one place (a post) is drawn together,
 * as a picture of the post laid flat beside the line (on the driver's left), its top pointing the way
 * trains run. A junction's arms make one bracket: a cross-beam with a doll for each route, the most
 * important route's doll the longest and the leftmost route's furthest from the line. Distant and
 * shunt-ahead arms ride below the main arm; ground signals lie behind the post's foot. Colour lights
 * at a junction are one head with a junction indicator ("feather") for each diverging route.
 *
 * Posts keep clear of the diagram's labels and of each other by standing further back along the
 * line (never forward, past what they protect).
 */

export interface SignalDrawOptions {
  selected?: string;
  /** The box whose diagram this is: other boxes' signals are drawn faint. */
  boxId?: string;
}

/** An axis-aligned box on the diagram (screen pixels), for keeping signals clear of labels. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const NS = 'http://www.w3.org/2000/svg';
const INK = '#1d2124';
const RED = '#c8261d';
const YELLOW = '#e8b923';
const WHITE = '#f6f1e3';
const LAMP_RED = '#d8322a';
const LAMP_GREEN = '#2bb24c';
const LAMP_WHITE = '#f4f1e6';
const HEAD = '#16130f';
const SCALE = 1.4;
/** Doll spacing on a bracket (local units). */
const S = 20;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...children: Array<SVGElement | string | null>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, typeof v === 'number' ? String(Math.round(v * 10) / 10) : v);
  for (const c of children) if (c !== null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const isMain = (s: PlanSignal) => s.kind === 'home' || s.kind === 'starter';
const isGround = (s: PlanSignal) => s.kind === 'shunt' || s.kind === 'shuntYellow';

interface Placed {
  sg: PlanSignal;
  /** How far its routes lie to the driver's left (grid units; negative = right). */
  lat: number;
}

/** Order arms from the driver's left to right, and pick the most important (straightest) one. */
function order(state: AppState, layout: Layout, arms: PlanSignal[], at: { x: number; y: number; dx: number; dy: number }): { list: Placed[]; main: PlanSignal | undefined } {
  const nx = at.dy;
  const ny = -at.dx;
  const list = arms.map((sg) => {
    const pts: number[] = [];
    for (const r of signalRoutes(state, layout, sg)) {
      const c = findCircuit(layout.trackPlan, r.to.circuitId) ?? findCircuit(layout.trackPlan, r.steps[r.steps.length - 1]?.circuitId ?? '');
      const m = c ? circuitMiddle(layout.trackPlan, c) : null;
      if (m) pts.push((m.x - at.x) * nx + (m.y - at.y) * ny);
    }
    return { sg, lat: pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : 0 };
  });
  list.sort((a, b) => b.lat - a.lat || Number(a.sg.number) - Number(b.sg.number));
  let main: Placed | undefined;
  for (const p of list) if (!main || Math.abs(p.lat) < Math.abs(main.lat) - 0.01) main = p;
  return { list, main: main?.sg };
}

/** A lever number in plain figures, as painted on a diagram, always the right way up. */
function label(g: SVGGElement, x: number, y: number, text: string, rot: number): void {
  if (!text) return;
  g.append(svg('text', { x, y: y + 2.8, 'text-anchor': 'middle', class: 'dg-sig-label', transform: `rotate(${(-rot).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})` }, text));
}

function armGroup(sg: PlanSignal, opts: SignalDrawOptions, hitX: number, hitY: number, r = 7): SVGGElement {
  const mine = !opts.boxId || sg.boxId === opts.boxId;
  const g = svg('g', { class: `dg-sig k-${sg.kind} s-${sg.style}${mine ? '' : ' faint'}${opts.selected === sg.id ? ' selected' : ''}`, 'data-signal': sg.id });
  g.append(svg('title', {}, `${sg.number ? `${sg.number}: ` : ''}${sg.name}`));
  g.append(svg('circle', { cx: hitX, cy: hitY, r, fill: 'transparent', class: 'dg-sig-hit' }));
  return g;
}

// ---------------------------------------------------------------------------- pieces (local units)

/** A semaphore arm on a doll at (x, y), reaching away from the line. */
function semArm(g: SVGGElement, x: number, y: number, kind: PlanSignal['kind']): void {
  if (kind === 'distant') {
    g.append(svg('path', { d: `M${x} ${y}L${x - 12} ${y}L${x - 9.5} ${y + 2}L${x - 12} ${y + 4}L${x} ${y + 4}Z`, fill: YELLOW, stroke: INK, 'stroke-width': 0.7 }));
    g.append(svg('path', { d: `M${x - 3.5} ${y}L${x - 5.5} ${y + 2}L${x - 3.5} ${y + 4}`, fill: 'none', stroke: INK, 'stroke-width': 0.9 }));
  } else if (kind === 'shuntAhead') {
    g.append(svg('rect', { x: x - 8, y, width: 8, height: 3.4, fill: RED, stroke: INK, 'stroke-width': 0.6 }));
    g.append(svg('text', { x: x - 4, y: y + 2.9, 'text-anchor': 'middle', 'font-size': 3.4, 'font-weight': 700, fill: WHITE }, 'S'));
  } else {
    g.append(svg('rect', { x: x - 12, y, width: 12, height: 4, fill: RED, stroke: INK, 'stroke-width': 0.7 }));
    g.append(svg('rect', { x: x - 9.5, y, width: 2, height: 4, fill: WHITE }));
  }
  g.append(svg('circle', { cx: x + 2.4, cy: y + 2, r: 1.5, fill: kind === 'distant' ? YELLOW : LAMP_RED, stroke: INK, 'stroke-width': 0.5 }));
}

/** A colour light head on a doll whose top is (x, y): red (yellow for a distant) above green. */
function clHead(g: SVGGElement, x: number, y: number, kind: PlanSignal['kind']): void {
  g.append(svg('rect', { x: x - 3.6, y: y - 13, width: 7.2, height: 13, rx: 2.5, fill: HEAD }));
  g.append(svg('circle', { cx: x, cy: y - 9.5, r: 2.1, fill: kind === 'distant' ? YELLOW : LAMP_RED }));
  g.append(svg('circle', { cx: x, cy: y - 3.6, r: 2.1, fill: LAMP_GREEN }));
}

/** A ground signal centred at (x, y): a disc, or a position light. */
function groundHead(g: SVGGElement, x: number, y: number, sg: PlanSignal): void {
  if (sg.style === 'colourLight') {
    g.append(svg('path', { d: `M${x - 4.5} ${y + 3.5}L${x + 4.5} ${y + 3.5}L${x + 4.5} ${y - 1}L${x} ${y - 4.5}L${x - 4.5} ${y - 1}Z`, fill: HEAD }));
    g.append(svg('circle', { cx: x - 2, cy: y + 1, r: 1.5, fill: sg.kind === 'shuntYellow' ? YELLOW : sg.kind === 'shuntAhead' ? LAMP_WHITE : LAMP_RED }));
    g.append(svg('circle', { cx: x + 2, cy: y + 1, r: 1.5, fill: LAMP_WHITE }));
  } else {
    g.append(svg('circle', { cx: x, cy: y, r: 4.2, fill: WHITE, stroke: INK, 'stroke-width': 0.8 }));
    g.append(svg('rect', { x: x - 3.6, y: y - 1.1, width: 7.2, height: 2.2, fill: sg.kind === 'shuntYellow' ? YELLOW : RED }));
  }
}

function losBoard(g: SVGGElement, x: number, y: number, sg: PlanSignal): void {
  if (sg.style === 'colourLight') {
    g.append(svg('rect', { x: x - 5, y: y - 3, width: 10, height: 6, rx: 2, fill: HEAD }));
    g.append(svg('circle', { cx: x - 2.4, cy: y, r: 1.6, fill: LAMP_RED }));
    g.append(svg('circle', { cx: x + 2.4, cy: y, r: 1.6, fill: LAMP_RED }));
  } else {
    g.append(svg('rect', { x: x - 5, y: y - 4, width: 10, height: 8, fill: WHITE, stroke: RED, 'stroke-width': 1.1 }));
    g.append(svg('path', { d: `M${x - 3} ${y - 2}L${x + 3} ${y + 2}M${x - 3} ${y + 2}L${x + 3} ${y - 2}`, stroke: RED, 'stroke-width': 0.9 }));
  }
}

// ---------------------------------------------------------------------------- one post

interface Post {
  g: SVGGElement;
  /** Where its foot stands (screen) before any moving back, the way trains run, and its turn. */
  bx: number;
  by: number;
  dx: number;
  dy: number;
  rot: number;
}

function drawPost(state: AppState, layout: Layout, arms: PlanSignal[], at: { x: number; y: number; dx: number; dy: number }, X: (v: number) => number, Y: (v: number) => number, opts: SignalDrawOptions): Post {
  const trueAngle = (Math.atan2(at.dy, at.dx) * 180) / Math.PI;
  // Laid flat: the picture's "up" (local -y) points the way trains run; local -x is away from the line.
  const rot = trueAngle + 90;

  const mains = arms.filter(isMain);
  const distants = arms.filter((s) => s.kind === 'distant');
  const aheads = arms.filter((s) => s.kind === 'shuntAhead');
  const grounds = order(state, layout, arms.filter(isGround), at).list;
  const los = arms.filter((s) => s.kind === 'limitOfShunt');
  // Dolls: one per stop arm; a post with only distants gives each distant a doll.
  const { list, main } = order(state, layout, mains.length ? mains : distants, at);
  const colour = list.length > 0 && list.every((p) => p.sg.style === 'colourLight');
  const feathers = colour && list.length > 1;
  const dolls = feathers ? list.filter((p) => p.sg === main) : list;
  const n = dolls.length;
  const hw = n > 1 ? ((n - 1) * S) / 2 : 0;

  // Stand off the line on the driver's left, far enough that nothing reaches across it.
  const nx = at.dy;
  const ny = -at.dx;
  const off = (hw + (feathers ? 15 : 6)) * SCALE + 2;
  const bx = X(at.x) + nx * off;
  const by = Y(at.y) + ny * off;
  const g = svg('g', { class: 'dg-post' });
  if (opts.boxId && !arms.some((s) => s.boxId === opts.boxId)) g.classList.add('faint');
  const ink = { stroke: INK, 'stroke-width': 1.4, 'stroke-linecap': 'round' as const };

  if (n) {
    const top = (p: Placed) => (n === 1 ? -30 : p.sg === main ? -36 : -28);
    if (n === 1) g.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: top(dolls[0]), ...ink }));
    else {
      g.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -14, ...ink }));
      g.append(svg('line', { x1: -hw - 2, y1: -14, x2: hw + 2, y2: -14, ...ink }));
      g.append(svg('path', { d: `M0 -6L${-hw * 0.7} -14M0 -6L${hw * 0.7} -14`, stroke: INK, 'stroke-width': 0.8, fill: 'none' }));
    }
    g.append(svg('line', { x1: -4, y1: 0, x2: 4, y2: 0, ...ink }));
    dolls.forEach((p, i) => {
      const x = n === 1 ? 0 : -hw + i * S;
      const t = top(p);
      if (n > 1) g.append(svg('line', { x1: x, y1: -14, x2: x, y2: t, ...ink }));
      g.append(svg('circle', { cx: x, cy: t - 1.2, r: 1.3, fill: INK }));
      const a = armGroup(p.sg, opts, x - 4, t + 1);
      if (p.sg.style === 'colourLight') clHead(a, x, t + 1, p.sg.kind);
      else semArm(a, x, t + 1, p.sg.kind);
      // The number stands clear beyond the top of its doll (or head, or feathers).
      label(a, x, t - (p.sg.style === 'colourLight' ? (feathers ? 36 : 22) : 10), p.sg.number, rot);
      g.append(a);
      // Distants and shunt-ahead arms ride below the main arm; their numbers sit beyond the arm's end.
      if (p.sg === main) {
        let y = t + 10;
        for (const d of [...(mains.length ? distants : []), ...aheads]) {
          const big = d.style === 'colourLight' && d.kind === 'distant';
          const dg = armGroup(d, opts, x - 4, y + 2, 5);
          if (big) clHead(dg, x, y + 13, d.kind);
          else if (d.style === 'colourLight') groundHead(dg, x, y + 3, d);
          else semArm(dg, x, y, d.kind);
          label(dg, x - 19, y + (big ? 7 : 2), d.number, rot);
          g.append(dg);
          y += big ? 16 : 9;
        }
      }
    });
    if (feathers && main) {
      // Junction indicators: three white lamps above the head for each diverging route, leaning its way.
      const m = list.find((q) => q.sg === main)!;
      const left = list.filter((p) => p !== m && p.lat > m.lat).reverse();
      const right = list.filter((p) => p !== m && p.lat <= m.lat);
      const oy = -30 - 13;
      const place = (p: Placed, side: -1 | 1, k: number) => {
        const deg = side === -1 ? -135 + k * 28 : -45 - k * 28;
        const r = (deg * Math.PI) / 180;
        const a = armGroup(p.sg, opts, Math.cos(r) * 8, oy + Math.sin(r) * 8, 5);
        for (let j = 1; j <= 3; j++) a.append(svg('circle', { cx: Math.cos(r) * (2 + j * 3.2), cy: oy + Math.sin(r) * (2 + j * 3.2), r: 1.25, fill: LAMP_WHITE, stroke: HEAD, 'stroke-width': 0.6 }));
        label(a, Math.cos(r) * 20, oy + Math.sin(r) * 20, p.sg.number, rot);
        g.append(a);
      };
      left.forEach((p, k) => place(p, -1, k));
      right.forEach((p, k) => place(p, 1, k));
    }
  } else if (aheads.length) {
    // A shunt-ahead on a post of its own.
    g.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -18, ...ink }));
    aheads.forEach((d, i) => {
      const a = armGroup(d, opts, -4, -16 + i * 8, 5);
      if (d.style === 'colourLight') groundHead(a, 0, -15 + i * 8, d);
      else semArm(a, 0, -17 + i * 8, d.kind);
      label(a, -19, -15 + i * 8, d.number, rot);
      g.append(a);
    });
  }

  // Ground signals and boards lie behind the foot, alongside the line; numbers on the outside.
  let y = 9;
  if (grounds.length) g.append(svg('line', { x1: 0, y1: n || aheads.length ? 0 : 3, x2: 0, y2: 9 + (grounds.length - 1) * 10, stroke: INK, 'stroke-width': 1.2 }));
  for (const p of grounds) {
    const a = armGroup(p.sg, opts, 0, y, 5);
    groundHead(a, 0, y, p.sg);
    label(a, -12, y, p.sg.number, rot);
    g.append(a);
    y += 10;
  }
  for (const l of los) {
    const a = armGroup(l, opts, 0, y, 6);
    losBoard(a, 0, y, l);
    g.append(a);
    y += 10;
  }
  return { g, bx, by, dx: at.dx, dy: at.dy, rot };
}

/** The extent of a post's drawing in its own units (from the shapes' attributes; no layout needed). */
function localBox(g: SVGGElement): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x: number, y: number, rx = 0, ry = rx) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    b.x0 = Math.min(b.x0, x - rx);
    b.x1 = Math.max(b.x1, x + rx);
    b.y0 = Math.min(b.y0, y - ry);
    b.y1 = Math.max(b.y1, y + ry);
  };
  const n = (el: Element, a: string) => Number(el.getAttribute(a));
  for (const el of g.querySelectorAll('line, rect, circle, path, text')) {
    if (el.classList.contains('dg-sig-hit')) continue;
    switch (el.tagName) {
      case 'line':
        add(n(el, 'x1'), n(el, 'y1'));
        add(n(el, 'x2'), n(el, 'y2'));
        break;
      case 'rect':
        add(n(el, 'x'), n(el, 'y'));
        add(n(el, 'x') + n(el, 'width'), n(el, 'y') + n(el, 'height'));
        break;
      case 'circle':
        add(n(el, 'cx'), n(el, 'cy'), n(el, 'r'));
        break;
      case 'path': {
        const nums = (el.getAttribute('d') ?? '').match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
        for (let i = 0; i + 1 < nums.length; i += 2) add(nums[i], nums[i + 1]);
        break;
      }
      case 'text': {
        // Numbers turn to stay upright, so allow for either way round.
        const half = Math.max(5, (el.textContent ?? '').length * 2.8 + 2);
        add(n(el, 'x'), n(el, 'y') - 2.8, half, half);
        break;
      }
    }
  }
  return b;
}

/** A local box turned, scaled and moved to the diagram: the box around its corners. */
function screenBox(b: Box, post: Post, shift: number): Box {
  const r = (post.rot * Math.PI) / 180;
  const c = Math.cos(r) * SCALE;
  const s = Math.sin(r) * SCALE;
  const ox = post.bx - post.dx * shift;
  const oy = post.by - post.dy * shift;
  const out = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ]) {
    const sx = ox + x * c - y * s;
    const sy = oy + x * s + y * c;
    out.x0 = Math.min(out.x0, sx);
    out.x1 = Math.max(out.x1, sx);
    out.y0 = Math.min(out.y0, sy);
    out.y1 = Math.max(out.y1, sy);
  }
  return out;
}

const overlap = (a: Box, b: Box, pad: number) => Math.max(0, Math.min(a.x1, b.x1) + pad - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) + pad - Math.max(a.y0, b.y0));

/**
 * Every signal on the plan, post by post. `obstacles` are the diagram's labels and `lines` its track
 * (screen boxes): each post stands back along the line, up to a few track widths, until it is clear
 * of them and of the posts already placed.
 */
export function drawSignals(state: AppState, layout: Layout, X: (v: number) => number, Y: (v: number) => number, opts: SignalDrawOptions, obstacles: Box[] = [], lines: Box[] = []): SVGGElement {
  const layer = svg('g', { class: 'dg-signals' });
  const groups = new Map<string, PlanSignal[]>();
  for (const sg of layout.trackPlan.signals ?? []) {
    const k = postKey(sg);
    groups.set(k, [...(groups.get(k) ?? []), sg]);
  }
  const posts: Array<{ post: Post; local: Box; size: number }> = [];
  for (const arms of groups.values()) {
    const at = signalPoint(state, layout, arms[0], 1.2);
    if (!at) continue;
    const post = drawPost(state, layout, arms, at, X, Y, opts);
    posts.push({ post, local: localBox(post.g), size: arms.length });
  }
  // Big posts (brackets) first: they have the least room to move.
  posts.sort((a, b) => b.size - a.size);
  const taken = [...obstacles];
  const step = (X(1) - X(0)) / 3;
  for (const { post, local } of posts) {
    let best = { shift: 0, cost: Infinity, box: screenBox(local, post, 0) };
    for (let i = 0; i <= 12; i++) {
      const shift = i * step;
      const box = screenBox(local, post, shift);
      const hit = taken.reduce((sum, o) => sum + overlap(box, o, 6), 0) + lines.reduce((sum, o) => sum + overlap(box, o, 0), 0);
      const cost = hit + i * 2;
      if (cost < best.cost) best = { shift, cost, box };
      if (hit === 0) break; // clear
    }
    taken.push(best.box);
    post.g.setAttribute('transform', `translate(${(post.bx - post.dx * best.shift).toFixed(1)} ${(post.by - post.dy * best.shift).toFixed(1)}) rotate(${post.rot.toFixed(1)}) scale(${SCALE})`);
    layer.append(post.g);
  }
  return layer;
}

/** One signal on its own, drawn as on the diagram, for trains running left to right (tutorial, keys). */
export function signalSample(kind: PlanSignal['kind'], style: PlanSignal['style'], title: string): SVGSVGElement {
  const sg = { kind, style } as PlanSignal;
  const g = svg('g', { transform: 'translate(10 25) rotate(90)' });
  const ink = { stroke: INK, 'stroke-width': 1.4, 'stroke-linecap': 'round' as const };
  if (kind === 'home' || kind === 'starter' || kind === 'distant') {
    g.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -30, ...ink }), svg('line', { x1: -4, y1: 0, x2: 4, y2: 0, ...ink }));
    if (style === 'colourLight') clHead(g, 0, -29, kind);
    else semArm(g, 0, -29, kind);
  } else if (kind === 'shuntAhead') {
    g.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -18, ...ink }));
    if (style === 'colourLight') groundHead(g, 0, -15, sg);
    else semArm(g, 0, -17, kind);
  } else if (kind === 'limitOfShunt') losBoard(g, 0, -12, sg);
  else {
    g.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -9, stroke: INK, 'stroke-width': 1.2 }));
    groundHead(g, 0, -13, sg);
  }
  return svg(
    'svg',
    { viewBox: '0 0 48 32', width: 72, height: 48, class: 'sig-sample', role: 'img', 'aria-label': title },
    svg('line', { x1: 0, y1: 29, x2: 48, y2: 29, stroke: INK, 'stroke-width': 2.4 }),
    g,
  );
}
