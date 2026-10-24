import { formatLength, locoLength, locoShape, type LocoShape } from '../core/railway';
import { fittedHead, fromEngine, type ResolvedVehicle } from '../core/stock';
import type { RakeEnd } from '../core/stockTypes';
import type { Loco, UnitSystem } from '../core/types';

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
  /**
   * Draw an engine at the engine end: true for a generic steam tender engine, a kind of engine, or the
   * loco working the train (drawn by its power type, at its length).
   */
  engine?: boolean | LocoShape | Pick<Loco, 'powerType'>;
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

/** Lengths drawn for each kind of engine when no loco is given (metres over buffers). */
export const ENGINE_METRES: Record<LocoShape, number> = { tender: 20, tank: 11, diesel: 17, electric: 17, unit: 20 };

/**
 * An engine in side elevation (v0.3.41), drawn in the ink of the board with its wheels and windows picked
 * out: a steam tender engine (4-6-0 with its tender behind, nearest the train), a steam tank engine (0-6-0
 * side tank with a coal bunker), a diesel (a cab at each end with short noses, on two six-wheel bogies),
 * an electric (flat cab ends, a pantograph) or a unit car. x = left edge, w = length in px. The front
 * (smokebox, or No. 1 end) faces away from the train: `frontLeft` when the engine is left of the rake.
 */
function engineShape(kind: LocoShape, x: number, w: number, frontLeft: boolean): SVGGElement {
  const g = s('g', { class: `rk-engine rk-eng-${kind}`, ...(frontLeft ? {} : { transform: `translate(${2 * x + w},0) scale(-1,1)` }) });
  const G = GROUND;
  const body = (attrs: Record<string, string | number>) => g.append(s('rect', { class: 'rk-body', ...attrs }));
  const path = (d: string, cls = 'rk-body') => g.append(s('path', { class: cls, d }));
  const win = (wx: number, wy: number, ww: number, wh: number) => g.append(s('rect', { class: 'rk-eng-win', x: wx, y: wy, width: ww, height: wh }));
  const wheel = (cx: number, r: number) => g.append(s('circle', { class: 'rk-wheel', cx, cy: G - r, r }));
  const hub = (cx: number, r: number) => g.append(s('circle', { class: 'rk-hub', cx, cy: G - r, r: Math.max(1, r * 0.25) }));
  const buffers = (bx: number) => g.append(s('rect', { class: 'rk-buffer', x: bx, y: G - 18, width: 2.5, height: 4 }));
  const line = (x1: number, y1: number, x2: number, y2: number, cls = 'rk-line') => g.append(s('line', { class: cls, x1, y1, x2, y2 }));

  if (kind === 'tender' || kind === 'tank') {
    const tender = kind === 'tender';
    const E = tender ? w * 0.64 : w; // the engine itself; the tender takes the rest
    const at = (f: number) => x + E * f;
    buffers(x);
    // Frames and running plate.
    body({ x: at(0.03), y: G - 21, width: E * 0.95, height: 6 });
    line(x, G - 21, x + E, G - 21, 'rk-frame');
    // Smokebox, chimney and boiler.
    body({ x: at(0.05), y: G - 46, width: E * 0.13, height: 25, rx: 3 });
    body({ x: at(0.085), y: G - 55, width: 6, height: 10 });
    body({ x: at(0.075), y: G - 57, width: 8.5, height: 2.5 });
    const boilerEnd = tender ? 0.72 : 0.62;
    body({ x: at(0.16), y: G - 44, width: E * (boilerEnd - 0.16), height: 20 });
    for (const f of tender ? [0.3, 0.45, 0.58] : [0.36]) line(at(f), G - 44, at(f), G - 25, 'rk-band');
    // Dome and safety valves.
    const dome = at(tender ? 0.42 : 0.3);
    path(`M${dome - 5},${G - 43} Q${dome},${G - 54} ${dome + 5},${G - 43} Z`);
    body({ x: at(boilerEnd - 0.07), y: G - 48, width: 3, height: 5 });
    if (tender) {
      // Belpaire firebox, outside cylinders over the leading bogie.
      body({ x: at(0.6), y: G - 46, width: E * 0.13, height: 22 });
      body({ x: at(0.05), y: G - 27, width: E * 0.15, height: 12, rx: 2 });
    } else {
      // Side tanks alongside the boiler.
      body({ x: at(0.2), y: G - 39, width: E * 0.42, height: 18 });
      line(at(0.21), G - 35, at(0.61), G - 35, 'rk-band');
    }
    // Cab with its roof, a front spectacle and side window.
    const cab0 = at(boilerEnd);
    const cabW = E * (tender ? 0.27 : 0.22);
    body({ x: cab0, y: G - 51, width: cabW, height: 30 });
    body({ x: cab0 - 2, y: G - 53, width: cabW + 4, height: 3, rx: 1 });
    win(cab0 + 2, G - 47, 3.5, 5);
    win(cab0 + cabW * 0.45, G - 47, cabW * 0.35, 8);
    if (!tender) {
      // Coal bunker behind the cab, with buffers at the back.
      const b0 = cab0 + cabW;
      body({ x: b0, y: G - 40, width: x + E - b0 - 1, height: 19 });
      path(`M${b0 + 1},${G - 40} Q${(b0 + x + E) / 2},${G - 46} ${x + E - 2},${G - 40} Z`, 'rk-coal');
      buffers(x + E - 2.5);
    }
    // Wheels: a leading bogie and three coupled drivers (4-6-0), or six coupled (0-6-0T).
    const drivers = tender ? [0.35, 0.6, 0.85] : [0.22, 0.47, 0.72];
    const dr = tender ? 9 : 7.5;
    if (tender) for (const f of [0.07, 0.185]) wheel(at(f), 4);
    // Splashers over the coupled wheels (a tank engine's are behind its tanks).
    if (tender) for (const f of drivers) path(`M${at(f) - dr - 1},${G - 20} A${dr + 1},${dr + 1} 0 0 1 ${at(f) + dr + 1},${G - 20} Z`, 'rk-coal');
    for (const f of drivers) wheel(at(f), dr);
    for (const f of drivers) hub(at(f), dr);
    line(at(drivers[0]), G - dr + 1, at(drivers[2]), G - dr + 1, 'rk-rod');
    if (tender) line(at(0.18), G - 21, at(drivers[1]), G - dr + 1, 'rk-rod');
    if (tender) {
      // The tender, nearest the train: coal heaped above a flared body, six wheels, buffers at its back.
      const t0 = x + E + 2;
      const tw = w - E - 2;
      line(x + E - 1, G - 16, t0 + 1, G - 16, 'rk-frame'); // drawbar
      body({ x: t0, y: G - 21, width: tw, height: 6 });
      body({ x: t0 + 1, y: G - 41, width: tw - 2, height: 21 });
      body({ x: t0, y: G - 43, width: tw, height: 3, rx: 1 });
      path(`M${t0 + 2},${G - 43} Q${t0 + tw * 0.45},${G - 51} ${t0 + tw - 4},${G - 43} Z`, 'rk-coal');
      line(t0 + 3, G - 33, t0 + tw - 3, G - 33, 'rk-band');
      for (const f of [0.2, 0.5, 0.8]) wheel(t0 + tw * f, 4.5);
      buffers(t0 + tw - 2.5);
    }
    return g;
  }

  // Diesels, electrics and units: a body on bogies, buffers at both ends.
  buffers(x);
  buffers(x + w - 2.5);
  const at = (f: number) => x + w * f;
  if (kind === 'unit') {
    // A railcar or unit car: a coach body with a cab at the front, windows along it.
    path(`M${x + 2},${G - 14} V${G - 44} Q${x + 2},${G - 50} ${x + 9},${G - 50} H${x + w - 3} V${G - 14} Z`);
    win(x + 4, G - 45, 6, 9);
    for (let wx = x + 18; wx + 5 < x + w - 8; wx += 8) win(wx, G - 44, 5, 9);
  } else if (kind === 'electric') {
    body({ x: x + 2, y: G - 46, width: w - 4, height: 32, rx: 3 });
    for (const f of [0, 1]) {
      const cx = f ? x + w - 12 : x + 4;
      win(cx, G - 42, 8, 8);
    }
    for (let gx = at(0.3); gx < at(0.7); gx += 4) line(gx, G - 38, gx, G - 26, 'rk-band');
    // Pantograph on the roof.
    const p = at(0.32);
    path(`M${p - 6},${G - 46} L${p},${G - 54} L${p + 6},${G - 46} M${p - 8},${G - 55} H${p + 8}`, 'rk-panto');
  } else {
    // Diesel: short noses, a cab at each end, engine room with grilles between.
    const nose = w * 0.07;
    const cab = w * 0.11;
    path(
      `M${x + 2},${G - 15} V${G - 33} Q${x + 2},${G - 37} ${x + nose},${G - 37} V${G - 45} Q${x + nose + 2},${G - 48} ${x + nose + 6},${G - 48} ` +
        `H${x + w - nose - 6} Q${x + w - nose - 2},${G - 48} ${x + w - nose},${G - 45} V${G - 37} Q${x + w - 2},${G - 37} ${x + w - 2},${G - 33} V${G - 15} Z`,
    );
    for (const f of [0, 1]) {
      const wx = f ? x + w - nose - cab + 2 : x + nose + 2;
      win(wx, G - 44, cab * 0.4, 7);
      win(wx + cab * 0.55, G - 43, cab * 0.3, 6);
    }
    for (let gx = at(0.3); gx < at(0.7); gx += 3.5) line(gx, G - 42, gx, G - 32, 'rk-band');
    line(at(0.07), G - 24, at(0.93), G - 24, 'rk-band');
  }
  // Underframe, a fuel tank (diesel), and two bogies.
  line(x + 2, G - 14, x + w - 2, G - 14, 'rk-frame');
  if (kind === 'diesel') body({ x: at(0.4), y: G - 14, width: w * 0.2, height: 6, rx: 2 });
  const axles = kind === 'diesel' ? [-0.09, 0, 0.09] : [-0.06, 0.06];
  for (const c of [0.2, 0.8]) {
    g.append(s('rect', { class: 'rk-bogie', x: at(c - 0.13), y: G - 12, width: w * 0.26, height: 5, rx: 1.5 }));
    for (const a of axles) wheel(at(c + a), 3.6);
  }
  return g;
}

/** The rake drawn as an SVG side elevation (end A on the left). */
export function drawRake(rv: ResolvedVehicle[], o: RakeDrawingOptions): SVGSVGElement {
  const kind: LocoShape | null = !o.engine ? null : o.engine === true ? 'tender' : typeof o.engine === 'string' ? o.engine : locoShape(o.engine);
  const engineM = !kind ? 0 : typeof o.engine === 'object' ? locoLength(o.engine as Loco) : ENGINE_METRES[kind];
  const engineW = engineM * K;
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
  if (kind && rv.length) svgEl.append(engineShape(kind, leftEngine ? PAD : x + 4, engineW, leftEngine));
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
