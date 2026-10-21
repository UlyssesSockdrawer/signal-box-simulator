import {
  circuitLabel,
  circuitMiddle,
  circuitPath,
  endHeading,
  JUNCTIONS,
  junctionWorker,
  localToWorld,
  markerAnchor,
  markerPos,
  orient,
  ownerKey,
  parallelSideNames,
  planBounds,
  platformPath,
  portsOf,
  TURNTABLE_RADIUS,
  type Pt,
} from '../core/trackPlan';
import { postKey, signalPoint } from '../core/signals';
import type { AppState, ExitTarget, Junction, Layout, MarkerBox, SignalKind, SignalStyle, TrackCircuit } from '../core/types';

/*
 * The signal box diagram: a read-only drawing of a layout's track plan, the
 * way a box's diagram board hangs above the block shelf. The box's own track
 * and the block sections it works are drawn in ink; everything else on the
 * layout is drawn faintly.
 *
 * It is drawn in fixed grid units with a viewBox, so it scales to fit the
 * board. Each track circuit is a <g class="dg-circuit" data-circuit="id">
 * and each junction a <g class="dg-junction" data-junction="id">, so a later
 * simulated running mode can light up occupied track circuits
 * (setOccupied) without redrawing.
 */

const NS = 'http://www.w3.org/2000/svg';
const U = 24;
/** Pixels per grid unit in the drawing (for turning a tap into a place on the plan). */
export const DIAGRAM_UNIT = U;
const INK = '#1d2124';
const FAINT = '#a39a85';
const FONT = 12;

export type DiagramLabels = 'none' | 'codes' | 'names';

export interface DiagramOptions {
  /** The box whose diagram this is: its track is drawn in ink. Omit to draw the whole plan in ink. */
  boxId?: string;
  labels: DiagramLabels;
  /** Draw the layout's signals (v0.3.29) with their lever numbers. */
  signals?: boolean;
  /** The selected signal (layout configurator), drawn highlighted. */
  selectedSignal?: string;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, ...children: Array<SVGElement | string | null>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

/** True when the layout's plan has anything to draw. */
export function hasDiagram(layout: Layout | undefined): boolean {
  const p = layout?.trackPlan;
  return !!p && (p.circuits.length > 0 || p.junctions.length > 0);
}

export function drawDiagram(state: AppState, layout: Layout, opts: DiagramOptions): SVGSVGElement | null {
  const p = layout.trackPlan;
  const b = planBounds(p);
  if (!b) return null;

  const box = opts.boxId ? state.boxes.find((x) => x.id === opts.boxId) : undefined;
  const mineKey = box ? `box|${box.id}` : '';
  const conn = (boxId: string, connId: string) => state.boxes.find((x) => x.id === boxId)?.connections.find((c) => c.id === connId);
  /** This box's own track, and the block sections it works. */
  const isMine = (c: TrackCircuit) => !box || (c.owner.kind === 'box' && c.owner.boxId === box.id) || (c.owner.kind === 'line' && c.owner.boxId === box.id);
  const junctionMine = (j: Junction) => !box || ownerKey(junctionWorker(j)) === mineKey;

  const exitText = (to: ExitTarget) => {
    if (to.kind === 'place') return `To ${layout.places.find((y) => y.id === to.placeId)?.name ?? 'a place'}`;
    if (to.kind === 'connection') return `To ${conn(to.boxId, to.connectionId)?.neighbourName ?? 'another box'}`;
    return 'Off scene';
  };
  const markerShort = (m: MarkerBox) =>
    (m.kind === 'box' ? state.boxes.find((x) => x.id === m.boxId)?.shortName : conn(m.boxId, m.connectionId)?.neighbourShort) || '?';

  // Room around the plan, with extra space where exit names run off the ends.
  let { minX, minY, maxX, maxY } = b;
  const textUnits = (t: string) => (t.length * FONT * 0.62 + 24) / U;
  for (const c of p.circuits) {
    c.ends.forEach((e, i) => {
      if (e.kind !== 'exit') return;
      const hd = endHeading(p, c, i as 0 | 1);
      if (!hd) return;
      const w = textUnits(exitText(e.to));
      if (Math.abs(hd.dy) > Math.abs(hd.dx) * 2) {
        if (hd.dy < 0) minY = Math.min(minY, e.y - w);
        else maxY = Math.max(maxY, e.y + w);
      } else if (hd.dx < 0) minX = Math.min(minX, e.x - w);
      else maxX = Math.max(maxX, e.x + w);
    });
  }
  const M = 1.6;
  const ox = minX - M;
  const oy = minY - M - 0.6;
  const W = (maxX - minX + 2 * M) * U;
  const H = (maxY - minY + 2 * M + 1.2) * U;
  const X = (x: number) => (x - ox) * U;
  const Y = (y: number) => (y - oy) * U;
  const d = (pts: Pt[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.x).toFixed(1)} ${Y(q.y).toFixed(1)}`).join(' ');
  const curvedD = (pts: Pt[]) => {
    const P = pts.map((q) => ({ x: X(q.x), y: Y(q.y) }));
    if (P.length < 3) return d(pts);
    let out = `M${P[0].x.toFixed(1)} ${P[0].y.toFixed(1)}`;
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1];
      const v = P[i];
      const z = P[i + 1];
      const l1 = Math.hypot(v.x - a.x, v.y - a.y) || 1;
      const l2 = Math.hypot(z.x - v.x, z.y - v.y) || 1;
      const rr = Math.min(U * 1.1, l1 / 2, l2 / 2);
      out += `L${(v.x + ((a.x - v.x) / l1) * rr).toFixed(1)} ${(v.y + ((a.y - v.y) / l1) * rr).toFixed(1)}Q${v.x.toFixed(1)} ${v.y.toFixed(1)} ${(v.x + ((z.x - v.x) / l2) * rr).toFixed(1)} ${(v.y + ((z.y - v.y) / l2) * rr).toFixed(1)}`;
    }
    const z = P[P.length - 1];
    return out + `L${z.x.toFixed(1)} ${z.y.toFixed(1)}`;
  };

  const s = svg('svg', {
    class: 'dg-svg',
    viewBox: `0 0 ${W.toFixed(0)} ${H.toFixed(0)}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `Track diagram of ${layout.name}${box ? `, ${box.name} box's area in black` : ''}`,
  });
  const platforms = svg('g', { class: 'dg-platforms' });
  const tracks = svg('g', { class: 'dg-tracks' });
  const labels = svg('g', { class: 'dg-labels' });
  const overlay = svg('g', { class: 'dg-overlay' });
  s.append(platforms, tracks, labels, overlay);
  // Kept so trains' labels can be put on the drawing later (setTrainLabels).
  s.dataset.ox = String(ox);
  s.dataset.oy = String(oy);

  // Track circuits
  for (const c of p.circuits) {
    const path = circuitPath(p, c);
    if (path.length < 2) continue;
    const col = isMine(c) ? INK : FAINT;
    const pd = curvedD(path);
    const g = svg('g', { class: `dg-circuit${isMine(c) ? ' mine' : ''}`, 'data-circuit': c.id });
    g.append(svg('path', { d: pd, class: 'dg-line', fill: 'none', stroke: col, 'stroke-width': 5, 'stroke-linejoin': 'round', 'stroke-dasharray': c.owner.kind === 'line' ? '14 5' : undefined }));
    // A wide invisible stroke, so a circuit is easy to tap (model railway mode: mark it occupied or clear).
    g.append(svg('path', { d: pd, class: 'dg-hit', fill: 'none', stroke: 'transparent', 'stroke-width': 18 }));
    let platformUp = false;
    if (c.platform) {
      const pp = platformPath(p, c);
      if (pp.length >= 2) {
        platforms.append(svg('path', { d: curvedD(pp), fill: 'none', stroke: '#b9ad90', 'stroke-width': U * 0.55, 'stroke-linejoin': 'round' }));
        let pb = 1;
        let pl = 0;
        for (let i = 1; i < pp.length; i++) {
          const l = Math.hypot(pp[i].x - pp[i - 1].x, pp[i].y - pp[i - 1].y);
          if (l > pl) {
            pl = l;
            pb = i;
          }
        }
        const tx = X((pp[pb - 1].x + pp[pb].x) / 2);
        const ty = Y((pp[pb - 1].y + pp[pb].y) / 2);
        // Which side the platform is on, from its own setting (it is drawn along the track's longest straight stretch only).
        platformUp = parallelSideNames(layout.trackPlan, c.id).find((x) => x.side === c.platform!.side)?.name === 'above';
        const label = `P${c.platform.number}`;
        const tw = Math.max(22, label.length * 7.5 + 8);
        labels.append(svg('rect', { x: tx - tw / 2, y: ty - 8, width: tw, height: 16, rx: 2, fill: '#f6f1e3', stroke: '#0c0a08', 'stroke-width': 1.5 }));
        labels.append(svg('text', { x: tx, y: ty + 4, 'text-anchor': 'middle', class: 'dg-tag', fill: '#0c0a08' }, label));
      }
    }
    // Buffer stops and exits
    c.ends.forEach((e, i) => {
      if (e.kind !== 'bufferStops' && e.kind !== 'exit') return;
      const hd = endHeading(p, c, i as 0 | 1);
      if (!hd) return;
      const px = X(e.x);
      const py = Y(e.y);
      const len = Math.hypot(hd.dx, hd.dy) || 1;
      const ux = hd.dx / len;
      const uy = hd.dy / len;
      if (e.kind === 'bufferStops') {
        g.append(svg('path', { d: `M${px - uy * 11} ${py + ux * 11}L${px + uy * 11} ${py - ux * 11}`, stroke: col, 'stroke-width': 6 }));
        return;
      }
      g.append(svg('path', { d: `M${px + ux * 13} ${py + uy * 13}L${px - uy * 8} ${py + ux * 8}L${px + uy * 8} ${py - ux * 8}Z`, fill: col }));
      const upright = Math.abs(uy) > Math.abs(ux) * 2;
      const tx = px + ux * 19;
      const ty = py + uy * 19;
      labels.append(
        upright
          ? svg('text', { x: tx, y: ty, 'text-anchor': 'start', 'dominant-baseline': 'middle', transform: `rotate(${uy < 0 ? -90 : 90} ${tx} ${ty})`, class: 'dg-label', fill: col }, exitText(e.to))
          : svg('text', { x: tx, y: ty + FONT * 0.35, 'text-anchor': ux < 0 ? 'end' : 'start', class: 'dg-label', fill: col }, exitText(e.to)),
      );
    });
    // Direction of traffic on up and down lines
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
    if (c.traffic) {
      const fwd = c.traffic.toward === 1;
      const ux = ((z.x - a.x) * (fwd ? 1 : -1)) / (best || 1);
      const uy = ((z.y - a.y) * (fwd ? 1 : -1)) / (best || 1);
      const cx = X((a.x + z.x) / 2);
      const cy = Y((a.y + z.y) / 2);
      const k = 6;
      g.append(svg('path', { d: `M${cx + ux * k} ${cy + uy * k}L${cx - ux * k - uy * k} ${cy - uy * k + ux * k}L${cx - ux * k * 0.4} ${cy - uy * k * 0.4}L${cx - ux * k + uy * k} ${cy - uy * k - ux * k}Z`, fill: '#f6f1e3', stroke: col, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    }
    tracks.append(g);
    if (opts.labels !== 'none') {
      const mx = X((a.x + z.x) / 2);
      const my = Y((a.y + z.y) / 2);
      const level = a.y === z.y;
      const text = opts.labels === 'names' ? circuitLabel(c) : c.code;
      const ly = platformUp ? my + FONT + 8 : my - 9;
      labels.append(svg('text', { x: level ? mx : mx + 9, y: level ? ly : my, 'text-anchor': level ? 'middle' : 'start', class: 'dg-label', fill: col }, text));
    }
  }

  // Points, crossings and joints
  for (const j of p.junctions) {
    const def = JUNCTIONS[j.kind];
    const col = junctionMine(j) ? INK : FAINT;
    const g = svg('g', { class: `dg-junction${junctionMine(j) ? ' mine' : ''}`, 'data-junction': j.id });
    const centre = j.kind === 'scissors' ? localToWorld(j, 0, 1.5) : localToWorld(j, 0, 0);
    const tt = j.kind === 'turntable';
    if (tt) {
      for (const pp of portsOf(j)) {
        const len = Math.hypot(pp.x, pp.y);
        const edge = localToWorld(j, (pp.x / len) * TURNTABLE_RADIUS, (pp.y / len) * TURNTABLE_RADIUS);
        g.append(svg('path', { d: d([edge, localToWorld(j, pp.x, pp.y)]), fill: 'none', stroke: col, 'stroke-width': 5 }));
      }
      g.append(svg('circle', { cx: X(centre.x), cy: Y(centre.y), r: TURNTABLE_RADIUS * U, fill: '#ddd5bd', stroke: col, 'stroke-width': 3 }));
      g.append(svg('path', { d: d([localToWorld(j, -TURNTABLE_RADIUS + 0.3, 0), localToWorld(j, TURNTABLE_RADIUS - 0.3, 0)]), fill: 'none', stroke: col, 'stroke-width': 5, 'stroke-linecap': 'round' }));
    }
    for (const r of def.routes) {
      const pts = r.path.map(([x, y]) => localToWorld(j, x, y));
      if (r.slip) {
        const [a, m, z] = pts;
        g.append(svg('path', { d: `M${X(a.x)} ${Y(a.y)}Q${X(m.x)} ${Y(m.y)} ${X(z.x)} ${Y(z.y)}`, fill: 'none', stroke: col, 'stroke-width': 3 }));
      } else g.append(svg('path', { d: d(pts), class: 'dg-line', fill: 'none', stroke: col, 'stroke-width': 5, 'stroke-linejoin': 'round' }));
    }
    for (const stub of def.stubs ?? []) g.append(svg('path', { d: d(stub.map(([x, y]) => localToWorld(j, x, y))), fill: 'none', stroke: col, 'stroke-width': 3.5, 'stroke-linecap': 'round' }));
    if (j.kind === 'joint') {
      const c0 = localToWorld(j, 0, 0);
      const n = orient(j, 0, 1);
      g.append(svg('path', { d: `M${X(c0.x) - n.x * 8} ${Y(c0.y) - n.y * 8}L${X(c0.x) + n.x * 8} ${Y(c0.y) + n.y * 8}`, stroke: col, 'stroke-width': 2 }));
    } else if (j.number) {
      const up = portsOf(j).some((pp) => localToWorld(j, pp.x, pp.y).y < j.y) || (def.stubs ?? []).some((st) => st.some(([x, y]) => localToWorld(j, x, y).y < j.y));
      const tx = X(centre.x);
      const ty = tt ? Y(centre.y) - TURNTABLE_RADIUS * U - 20 : j.kind === 'scissors' ? Y(centre.y) : up ? Y(centre.y) + 12 : Y(centre.y) - 27;
      const tw = Math.max(18, j.number.length * 8 + 8);
      labels.append(svg('rect', { x: tx - tw / 2, y: ty, width: tw, height: 15, rx: 2, fill: junctionMine(j) ? '#0c0a08' : FAINT }));
      labels.append(svg('text', { x: tx, y: ty + 11.5, 'text-anchor': 'middle', class: 'dg-tag', fill: '#ffffff' }, j.number));
    }
    tracks.append(g);
  }

  // Signals: a post beside the track (on the left, as in Britain) with the signal's head, drawn by
  // kind and style, and its lever number.
  if (opts.signals) {
    const sigLayer = svg('g', { class: 'dg-signals' });
    overlay.append(sigLayer);
    const posts = new Map<string, number>();
    for (const sg of p.signals ?? []) {
      const at = signalPoint(state, layout, sg);
      if (!at) continue;
      // Arms on one post (a bracket) are drawn side by side along the track; a shunt-ahead below its starter.
      const pk = postKey(sg);
      const i = posts.get(pk) ?? 0;
      posts.set(pk, i + 1);
      const ux = at.dx;
      const uy = at.dy;
      const nx = uy; // left of the way trains run (screen y points down)
      const ny = -ux;
      const off = 11 + (sg.kind === 'shuntAhead' ? 9 : 0);
      const along = -i * 15;
      const bx = X(at.x) + ux * along;
      const by = Y(at.y) + uy * along;
      const hx = bx + nx * off;
      const hy = by + ny * off;
      const mine = !box || sg.boxId === box.id;
      const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
      const g = svg('g', { class: `dg-sig k-${sg.kind} s-${sg.style}${mine ? '' : ' faint'}${opts.selectedSignal === sg.id ? ' selected' : ''}`, 'data-signal': sg.id });
      g.append(svg('title', {}, `${sg.number ? `${sg.number}: ` : ''}${sg.name}`));
      if (sg.kind !== 'shuntAhead') g.append(svg('path', { d: `M${bx + nx * 3} ${by + ny * 3}L${hx} ${hy}`, stroke: INK, 'stroke-width': 1.5 }));
      const head = svg('g', { transform: `translate(${hx.toFixed(1)} ${hy.toFixed(1)}) rotate(${angle.toFixed(1)})` });
      for (const el of signalHead(sg.kind, sg.style)) head.append(el);
      g.append(head);
      g.append(svg('circle', { cx: hx, cy: hy, r: 11, fill: 'transparent', class: 'dg-sig-hit' }));
      if (sg.number) {
        const tx = hx + nx * 13;
        const ty = hy + ny * 13;
        const tw = Math.max(16, sg.number.length * 7 + 6);
        g.append(svg('rect', { x: tx - tw / 2, y: ty - 7, width: tw, height: 13, rx: 2, class: 'dg-sig-num' }));
        g.append(svg('text', { x: tx, y: ty + 3.5, 'text-anchor': 'middle', class: 'dg-tag dg-sig-numtext' }, sg.number));
      }
      sigLayer.append(g);
    }
  }

  // Signal boxes on the plan
  for (const m of p.markers ?? []) {
    const pos = markerPos(p, m);
    const anchor = markerAnchor(p, m);
    const cx = X(pos.x);
    const cy = Y(pos.y);
    const remote = m.box.kind === 'remote';
    const me = !box || (m.box.kind === 'box' && m.box.boxId === box.id);
    const col = me ? INK : FAINT;
    const g = svg('g', { class: `dg-box${me ? ' mine' : ''}` });
    if (anchor) g.append(svg('path', { d: `M${cx} ${cy + 8}L${X(anchor.x)} ${Y(anchor.y)}`, stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': '3 3', fill: 'none' }));
    const w = 30;
    const body = remote ? '#f6f1e3' : me ? '#7a3b22' : FAINT;
    g.append(svg('path', { d: `M${cx - w / 2 - 3} ${cy - 10}L${cx} ${cy - 18}L${cx + w / 2 + 3} ${cy - 10}Z`, fill: col, stroke: '#0c0a08', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
    g.append(svg('rect', { x: cx - w / 2, y: cy - 10, width: w, height: 9, fill: remote ? body : col, stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': remote ? '3 2' : undefined }));
    for (let i = 0; i < 3; i++) g.append(svg('rect', { x: cx - w / 2 + 3 + i * 8.5, y: cy - 8, width: 6.5, height: 5, fill: remote ? col : '#f6f1e3' }));
    g.append(svg('rect', { x: cx - w / 2, y: cy - 1, width: w, height: 9, fill: body, stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': remote ? '3 2' : undefined }));
    const label = markerShort(m.box);
    const tw = Math.max(22, label.length * 7.5 + 10);
    g.append(svg('rect', { x: cx - tw / 2, y: cy + 11, width: tw, height: 16, rx: 2, fill: me ? '#0c0a08' : FAINT }));
    g.append(svg('text', { x: cx, y: cy + 23, 'text-anchor': 'middle', class: 'dg-tag', fill: '#ffffff' }, label));
    labels.append(g);
  }
  return s;
}

/** Light up occupied track circuits (for simulated running). Circuits not listed are shown clear. */
export function setOccupied(diagram: SVGSVGElement, circuitIds: Iterable<string>): void {
  const on = new Set(circuitIds);
  for (const g of diagram.querySelectorAll<SVGGElement>('.dg-circuit')) g.classList.toggle('occupied', on.has(g.dataset.circuit ?? ''));
}

/** Show set routes: circuits locked for a train (white lights), and the points set in them. */
export function setRoutes(diagram: SVGSVGElement, circuitIds: Iterable<string>, junctionIds: Iterable<string>): void {
  const on = new Set(circuitIds);
  const js = new Set(junctionIds);
  for (const g of diagram.querySelectorAll<SVGGElement>('.dg-circuit')) g.classList.toggle('routed', on.has(g.dataset.circuit ?? ''));
  for (const g of diagram.querySelectorAll<SVGGElement>('.dg-junction')) g.classList.toggle('routed', js.has(g.dataset.junction ?? ''));
}

/** Put a train's description (e.g. its number) on the circuit its head is in. */
export function setTrainLabels(state: AppState, layout: Layout, diagram: SVGSVGElement, labels: Array<{ circuitId: string; text: string }>): void {
  const ox = Number(diagram.dataset.ox);
  const oy = Number(diagram.dataset.oy);
  const overlay = diagram.querySelector('.dg-overlay');
  if (!overlay || !Number.isFinite(ox)) return;
  for (const el of overlay.querySelectorAll('.dg-train')) el.remove();
  void state;
  for (const l of labels) {
    const c = layout.trackPlan.circuits.find((x) => x.id === l.circuitId);
    const m = c ? circuitMiddle(layout.trackPlan, c) : null;
    if (!m) continue;
    const x = (m.x - ox) * U;
    const y = (m.y - oy) * U + 16;
    const w = Math.max(30, l.text.length * 7.5 + 10);
    overlay.append(
      svg('g', { class: 'dg-train' }, svg('rect', { x: x - w / 2, y: y - 8, width: w, height: 16, rx: 2 }), svg('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'dg-tag' }, l.text)),
    );
  }
}

/**
 * A signal's head in its own frame: x points the way trains run, the post stands at (0, 0).
 * Semaphore: red arm with a white stripe (home, starter), yellow fishtail arm (distant), white disc
 * with a red (or yellow) band (shunt), small arm (shunt-ahead), white board (limit of shunt). Colour
 * light: red/green or yellow/green lamps, position lights (two lamps) for shunting, two red lamps for a
 * limit of shunt. Lamps are drawn dim: the diagram shows the signals as planned.
 */
export function signalHead(kind: SignalKind, style: SignalStyle): SVGElement[] {
  const out: SVGElement[] = [];
  const lamp = (x: number, y: number, fill: string, r = 2.4) => out.push(svg('circle', { cx: x, cy: y, r, fill, class: 'dg-sig-lamp' }));
  if (style === 'colourLight') {
    if (kind === 'home' || kind === 'starter' || kind === 'distant') {
      out.push(svg('rect', { x: 0, y: -4, width: 15, height: 8, rx: 3.5, fill: '#16130f' }));
      lamp(4, 0, kind === 'distant' ? '#e8b923' : '#d8322a');
      lamp(11, 0, '#2bb24c');
    } else if (kind === 'limitOfShunt') {
      out.push(svg('rect', { x: 0, y: -3.5, width: 13, height: 7, rx: 2, fill: '#16130f' }));
      lamp(3.5, 0, '#d8322a', 2.1);
      lamp(9.5, 0, '#d8322a', 2.1);
    } else {
      // Position light: two lamps (red and white; yellow and white for a yellow one; whites for shunt-ahead).
      out.push(svg('path', { d: 'M0 -4L12 -4L12 4L0 4Z', fill: '#16130f' }));
      lamp(3.5, 1.5, kind === 'shuntYellow' ? '#e8b923' : kind === 'shuntAhead' ? '#f4f1e6' : '#d8322a', 2);
      lamp(8.5, 1.5, '#f4f1e6', 2);
    }
    return out;
  }
  switch (kind) {
    case 'home':
    case 'starter':
      out.push(svg('rect', { x: 0, y: -2.2, width: 14, height: 4.4, fill: '#c8261d', stroke: '#16130f', 'stroke-width': 0.8 }));
      out.push(svg('rect', { x: 9, y: -2.2, width: 2.2, height: 4.4, fill: '#f6f1e3' }));
      break;
    case 'distant':
      out.push(svg('path', { d: 'M0 -2.2L14 -2.2L11 0L14 2.2L0 2.2Z', fill: '#e8b923', stroke: '#16130f', 'stroke-width': 0.8 }));
      out.push(svg('path', { d: 'M7 -2.2L10 0L7 2.2', fill: 'none', stroke: '#16130f', 'stroke-width': 1 }));
      break;
    case 'shunt':
    case 'shuntYellow':
      out.push(svg('circle', { cx: 5, cy: 0, r: 5, fill: '#f6f1e3', stroke: '#16130f', 'stroke-width': 1 }));
      out.push(svg('rect', { x: 0.6, y: -1.3, width: 8.8, height: 2.6, fill: kind === 'shuntYellow' ? '#e8b923' : '#c8261d' }));
      break;
    case 'shuntAhead':
      out.push(svg('rect', { x: 0, y: -1.8, width: 9, height: 3.6, fill: '#c8261d', stroke: '#16130f', 'stroke-width': 0.7 }));
      out.push(svg('text', { x: 4.5, y: 1.4, 'text-anchor': 'middle', 'font-size': 3.6, 'font-weight': 700, fill: '#f6f1e3' }, 'S'));
      break;
    case 'limitOfShunt':
      out.push(svg('rect', { x: 0, y: -4, width: 10, height: 8, fill: '#f6f1e3', stroke: '#c8261d', 'stroke-width': 1.4 }));
      out.push(svg('path', { d: 'M2 -2L8 2M2 2L8 -2', stroke: '#c8261d', 'stroke-width': 1 }));
      break;
  }
  return out;
}

/** A signal head on its own, as drawn on the diagram (for the tutorial and keys). */
export function signalSample(kind: SignalKind, style: SignalStyle, label: string): SVGSVGElement {
  return svg(
    'svg',
    { viewBox: '-2 -6 19 12', width: 76, height: 48, class: 'sig-sample', role: 'img', 'aria-label': label },
    svg('line', { x1: -2, y1: 5.5, x2: 17, y2: 5.5, stroke: 'currentColor', 'stroke-width': 0.6, opacity: 0.35 }),
    ...signalHead(kind, style),
  );
}
