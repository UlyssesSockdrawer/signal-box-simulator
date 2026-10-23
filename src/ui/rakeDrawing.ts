import { formatLength } from '../core/railway';
import { fittedHead, fromEngine, type ResolvedVehicle } from '../core/stock';
import type { RakeEnd } from '../core/stockTypes';
import type { UnitSystem } from '../core/types';

/*
 * The rake visualiser (v0.3.38): a schematic side elevation of a rake, each vehicle a block drawn to its
 * length over buffers, on the same enamel board and ink as the box diagram. Cues are by shape, not
 * colour alone: coach windows, guard's doors and duckets, cab ends, gangways between corridor
 * vehicles, open, mineral, cattle and closed goods bodies, brake van verandas. A brake pipe runs
 * under the fitted head and visibly stops at the first unfitted vehicle (fitted vehicles beyond the
 * break show it dashed). Loads are drawn in open wagons and hatched in vans. Approximate lengths
 * have dashed outlines; a vehicle of unknown length is dotted and marked "?". A scale bar and,
 * optionally, the length of a road or platform show whether it fits.
 */

const NS = 'http://www.w3.org/2000/svg';
/** Pixels per metre. */
const K = 6;
const GROUND = 84;
const PAD = 16;
const ENGINE_M = 18;

function s<K2 extends keyof SVGElementTagNameMap>(tag: K2, attrs: Record<string, string | number | undefined> = {}, ...kids: Array<SVGElement | string | null>): SVGElementTagNameMap[K2] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const c of kids) if (c !== null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export interface RakeDrawingOptions {
  engineEnd: RakeEnd;
  units: UnitSystem;
  /** Short labels under the vehicles (e.g. identities), in rake order. */
  labels?: string[];
  /** Draw an engine at the engine end. */
  engine?: boolean;
  /** Length of a road or platform to compare with, metres, and its name. */
  road?: { metres: number; name: string };
  /** Accessible description. */
  title?: string;
}

/** What shape to draw a vehicle as. */
function shapeOf(v: ResolvedVehicle): string {
  const c = v.cls;
  if (c?.shape && c.shape !== 'coach') return c.shape;
  if (v.coachType) return v.coachType;
  if (v.category === 'brakeVan') return 'brakeVan';
  if (v.category === 'van') return 'closed';
  if (v.category === 'wagon') return 'open';
  return 'other';
}

/** One vehicle's body, x = left edge, w = length in px; `cabRight`: a driving trailer's cab end. */
function vehicleBody(v: ResolvedVehicle, x: number, w: number, cabRight: boolean): SVGGElement {
  const g = s('g', { class: `rk-veh rk-${shapeOf(v)}${v.approx ? ' rk-approx' : ''}${v.unknownLength ? ' rk-unknown' : ''}` });
  const shape = shapeOf(v);
  const bx = x + 2;
  const bw = Math.max(4, w - 4);
  const coaching = !!v.coachType;
  const tall = coaching || shape === 'closed' || shape === 'cattle' || shape === 'brakeVan';
  const top = coaching ? GROUND - 50 : shape === 'open' ? GROUND - 30 : shape === 'mineral' ? GROUND - 34 : shape === 'tank' ? GROUND - 38 : GROUND - 42;
  const bottom = GROUND - 12;
  const body = (cls = 'rk-body') => {
    if (shape === 'tank') return s('rect', { class: cls, x: bx, y: top, width: bw, height: bottom - top, rx: (bottom - top) / 2 });
    if (tall) {
      // A roof arch over the body.
      return s('path', { class: cls, d: `M${bx},${bottom} V${top + 5} Q${bx + bw / 2},${top - 5} ${bx + bw},${top + 5} V${bottom} Z` });
    }
    return s('rect', { class: cls, x: bx, y: top, width: bw, height: bottom - top });
  };
  if (shape === 'brakeVan') {
    // The body stops short of one end: an open veranda (platform) at the other.
    const ve = Math.min(16, bw * 0.25);
    g.append(s('path', { class: 'rk-body', d: `M${bx + ve},${bottom} V${top + 5} Q${bx + ve + (bw - ve) / 2},${top - 4} ${bx + bw},${top + 5} V${bottom} Z` }));
    g.append(s('path', { class: 'rk-line', d: `M${bx},${bottom} V${top + 10} H${bx + ve}` }));
    g.append(s('rect', { class: 'rk-mark', x: bx + ve + (bw - ve) / 2 - 4, y: top + 8, width: 8, height: 12 })); // ducket
  } else g.append(body());
  const windows = (from: number, to: number, y = top + 10, hh = 10, gap = 7) => {
    for (let wx = from; wx + 5 <= to; wx += gap) g.append(s('rect', { class: 'rk-win', x: wx, y, width: 4.5, height: hh }));
  };
  const door = (dx: number, dw = 9) => g.append(s('rect', { class: 'rk-line rk-door', x: dx, y: top + 7, width: dw, height: bottom - top - 9 }));
  switch (shape) {
    case 'ordinary':
      windows(bx + 5, bx + bw - 5);
      break;
    case 'catering':
      windows(bx + 5, bx + bw - 5, top + 12, 8, 9);
      for (let vx = bx + 10; vx < bx + bw - 10; vx += 14) g.append(s('rect', { class: 'rk-mark', x: vx, y: top - 3, width: 4, height: 3 })); // roof vents
      break;
    case 'sleeping':
      windows(bx + 5, bx + bw - 5, top + 9, 6, 9);
      break;
    case 'passengerBrake': {
      // Passenger part with windows, guard's van part with double doors and a ducket.
      const vanW = Math.min(bw * 0.35, 26);
      windows(bx + 5, bx + bw - vanW - 4);
      door(bx + bw - vanW, 8);
      door(bx + bw - vanW + 9, 8);
      g.append(s('rect', { class: 'rk-mark', x: bx + bw - vanW / 2 - 3, y: top + 9, width: 6, height: 6 }));
      break;
    }
    case 'fullBrake':
    case 'van':
      for (let dx = bx + 6; dx + 9 < bx + bw - 4; dx += Math.max(18, bw / 4)) door(dx);
      if (shape === 'fullBrake') g.append(s('rect', { class: 'rk-mark', x: bx + bw / 2 - 3, y: top + 9, width: 6, height: 6 }));
      break;
    case 'drivingTrailer': {
      const cabX = cabRight ? bx + bw - 10 : bx + 2;
      windows(cabRight ? bx + 5 : bx + 14, cabRight ? bx + bw - 14 : bx + bw - 5);
      g.append(s('rect', { class: 'rk-mark', x: cabX, y: top + 8, width: 8, height: 12 })); // cab windows
      break;
    }
    case 'tpo':
      g.append(s('rect', { class: 'rk-mark', x: bx + bw / 2 - 6, y: top + 18, width: 12, height: 2 })); // letter box
      door(bx + 8);
      door(bx + bw - 17);
      break;
    case 'closed':
      door(bx + bw / 2 - 6, 12);
      break;
    case 'cattle':
      for (let y = top + 8; y < bottom - 2; y += 5) g.append(s('line', { class: 'rk-line', x1: bx + 2, y1: y, x2: bx + bw - 2, y2: y }));
      break;
    case 'open':
    case 'mineral':
      for (let y = top + 5; y < bottom; y += 5) g.append(s('line', { class: 'rk-plank', x1: bx, y1: y, x2: bx + bw, y2: y }));
      if (shape === 'mineral') g.append(s('line', { class: 'rk-line', x1: bx + 3, y1: top, x2: bx + 3, y2: bottom }));
      break;
    default:
      break;
  }
  // Loads: a heap above an open wagon; hatching in a van.
  if (v.loaded) {
    if (shape === 'open' || shape === 'mineral' || shape === 'flat') g.append(s('path', { class: 'rk-load', d: `M${bx + 2},${top} Q${bx + bw / 2},${top - 12} ${bx + bw - 2},${top} Z` }));
    else g.append(s('rect', { class: 'rk-loaded-hatch', x: bx + 3, y: top + 6, width: bw - 6, height: bottom - top - 8 }));
  }
  // Underframe, buffers, wheels.
  g.append(s('line', { class: 'rk-frame', x1: bx, y1: bottom + 1, x2: bx + bw, y2: bottom + 1 }));
  g.append(s('rect', { class: 'rk-buffer', x: x, y: bottom - 6, width: 2.5, height: 4 }), s('rect', { class: 'rk-buffer', x: x + w - 2.5, y: bottom - 6, width: 2.5, height: 4 }));
  const wheel = (cx: number) => g.append(s('circle', { class: 'rk-wheel', cx, cy: GROUND - 5, r: 4 }));
  if (coaching && bw > 50) [bx + 8, bx + 17, bx + bw - 17, bx + bw - 8].forEach(wheel);
  else [bx + Math.min(8, bw / 4), bx + bw - Math.min(8, bw / 4)].forEach(wheel);
  if (v.unknownLength) g.append(s('text', { class: 'rk-q', x: bx + bw / 2, y: top + (bottom - top) / 2 + 5, 'text-anchor': 'middle' }, '?'));
  return g;
}

/** A simple engine outline, facing the rake. */
function engineShape(x: number, w: number, facingRight: boolean): SVGGElement {
  const g = s('g', { class: 'rk-engine' });
  const bottom = GROUND - 12;
  const cabW = w * 0.28;
  const cabX = facingRight ? x + w - cabW - 2 : x + 2;
  const boilerX = facingRight ? x + 6 : x + cabW + 2;
  const boilerW = w - cabW - 8;
  g.append(s('rect', { class: 'rk-body', x: cabX, y: bottom - 40, width: cabW, height: 40 }));
  g.append(s('rect', { class: 'rk-body', x: boilerX, y: bottom - 28, width: boilerW, height: 22, rx: 8 }));
  const chimX = facingRight ? boilerX + 6 : boilerX + boilerW - 12;
  g.append(s('rect', { class: 'rk-body', x: chimX, y: bottom - 38, width: 6, height: 11 }));
  g.append(s('line', { class: 'rk-frame', x1: x + 2, y1: bottom + 1, x2: x + w - 2, y2: bottom + 1 }));
  for (const cx of [x + w * 0.25, x + w * 0.45, x + w * 0.65]) g.append(s('circle', { class: 'rk-wheel', cx, cy: GROUND - 6, r: 6 }));
  return g;
}

/** The rake drawn as an SVG side elevation (end A on the left). */
export function drawRake(rv: ResolvedVehicle[], o: RakeDrawingOptions): SVGSVGElement {
  const engineW = o.engine ? ENGINE_M * K : 0;
  const total = rv.reduce((m, v) => m + v.metres, 0);
  const roadEnd = o.road ? o.road.metres : 0;
  const leftEngine = !!o.engine && o.engineEnd === 'A';
  const rakeX0 = PAD + (leftEngine ? engineW + 4 : 0);
  const width = Math.max(PAD * 2 + engineW + 4 + Math.max(total, roadEnd) * K + 20, 280);
  const height = GROUND + 46;
  const svgEl = s('svg', { class: 'rk-svg', viewBox: `0 0 ${Math.round(width)} ${height}`, width: Math.round(width), height, role: 'img', 'aria-label': o.title ?? 'Rake' });
  svgEl.append(s('title', {}, o.title ?? 'Rake'));
  svgEl.append(s('line', { class: 'rk-rail', x1: 4, y1: GROUND, x2: width - 4, y2: GROUND }));
  // Brake pipe: solid under the fitted head, dashed under fitted vehicles beyond the break.
  const fe = fromEngine(rv, o.engineEnd);
  const head = fittedHead(fe);
  const inHead = new Set(fe.slice(0, head).map((v) => v.vehicle.id));
  let x = rakeX0;
  rv.forEach((v, i) => {
    const w = v.metres * K;
    const cabRight = i === rv.length - 1 ? true : i === 0 ? false : o.engineEnd === 'A';
    const g = vehicleBody(v, x, w, cabRight);
    if (v.fitted) g.append(s('line', { class: inHead.has(v.vehicle.id) ? 'rk-pipe' : 'rk-pipe rk-pipe-off', x1: x, y1: GROUND - 9, x2: x + w, y2: GROUND - 9 }));
    // Gangways between corridor vehicles.
    const next = rv[i + 1];
    if (v.corridor === true && next?.corridor === true) svgEl.append(s('rect', { class: 'rk-gangway', x: x + w - 3, y: GROUND - 52, width: 6, height: 26 }));
    const label = o.labels?.[i];
    if (label) {
      const max = Math.max(3, Math.floor(w / 5.6));
      g.append(s('text', { class: 'rk-label', x: x + w / 2, y: GROUND + 12, 'text-anchor': 'middle' }, label.length > max ? `${label.slice(0, max - 1)}…` : label));
    }
    svgEl.append(g);
    x += w;
  });
  if (o.engine && rv.length) svgEl.append(engineShape(leftEngine ? PAD : x + 4, engineW, leftEngine));
  // Ends A and B.
  if (rv.length) {
    svgEl.append(s('text', { class: 'rk-end', x: rakeX0, y: 12, 'text-anchor': 'start' }, 'A'));
    svgEl.append(s('text', { class: 'rk-end', x, y: 12, 'text-anchor': 'end' }, 'B'));
  }
  // The road or platform it is to fit, measured from the end the engine is at.
  if (o.road) {
    const rx = leftEngine || o.engineEnd === 'A' ? rakeX0 + o.road.metres * K : x - o.road.metres * K;
    const fits = total <= o.road.metres;
    svgEl.append(s('line', { class: `rk-road${fits ? '' : ' rk-road-short'}`, x1: rx, y1: 6, x2: rx, y2: GROUND + 4 }));
    svgEl.append(s('text', { class: 'rk-road-label', x: rx + (o.engineEnd === 'A' ? -4 : 4), y: 24, 'text-anchor': o.engineEnd === 'A' ? 'end' : 'start' }, `${o.road.name} ends`));
  }
  // Scale bar: 20 m, or 50 ft.
  const barM = o.units === 'metric' ? 20 : 50 * 0.3048;
  const bx = PAD;
  const by = GROUND + 30;
  svgEl.append(s('line', { class: 'rk-scale', x1: bx, y1: by, x2: bx + barM * K, y2: by }));
  for (const t of [0, 0.5, 1]) svgEl.append(s('line', { class: 'rk-scale', x1: bx + barM * K * t, y1: by - 3, x2: bx + barM * K * t, y2: by + 3 }));
  svgEl.append(s('text', { class: 'rk-scale-label', x: bx + barM * K + 6, y: by + 4 }, o.units === 'metric' ? '20 m' : '50 ft'));
  if (total) svgEl.append(s('text', { class: 'rk-scale-label', x: bx + barM * K + 60, y: by + 4 }, `rake ${rv.some((v) => v.approx) ? 'about ' : ''}${formatLength(total, o.units, 'vehicle')}`));
  return svgEl;
}
