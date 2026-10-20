// A small drawing of an engine's front with its headcode lamps (v0.3.26), as you face it.
// Drawn in currentColor so it takes the ink of wherever it sits (editor, poster, cards).

import { lampClass, lampPattern, lampText, type HeadcodeEra } from '../core/headcodes';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** The lamp diagram for a kind of train in a lamp era, or null when there is none (1960 era, custom train types). */
export function lampDiagram(era: HeadcodeEra, trainTypeId: string, cls = ''): SVGSVGElement | null {
  const p = lampPattern(era, trainTypeId);
  if (!p) return null;
  const letter = lampClass(era, trainTypeId);
  const svg = el('svg', { viewBox: '-2 -3 64 49', class: `lamp-code ${cls}`.trim(), role: 'img' });
  const label = `Class ${letter} headcode: ${lampText(p)}`;
  svg.setAttribute('aria-label', label);
  const title = el('title', {});
  title.textContent = label;
  svg.append(title);
  const outline = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' };
  // Chimney, smokebox and buffer beam with its buffers.
  svg.append(
    el('path', { d: 'M26 9V3h8v6', ...outline }),
    el('path', { d: 'M13 33V20a11 11 0 0 1 11-11h12a11 11 0 0 1 11 11v13', ...outline }),
    el('rect', { x: 3, y: 33, width: 54, height: 8, rx: 1, ...outline }),
    el('circle', { cx: 9, cy: 37, r: 2.6, ...outline }),
    el('circle', { cx: 51, cy: 37, r: 2.6, ...outline }),
  );
  const lamp = (x: number, y: number, lit: boolean) => {
    if (!lit) {
      svg.append(el('path', { d: `M${x - 2} ${y + 4}h4`, stroke: 'currentColor', 'stroke-width': 1.4, opacity: 0.55 }));
      return;
    }
    // A lamp: its body (outlined), handle, and a white lens.
    svg.append(
      el('rect', { x: x - 5.5, y: y - 6, width: 11, height: 11.5, rx: 2, fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 1.2 }),
      el('path', { d: `M${x - 2.5} ${y - 6}v-2.5h5v2.5`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
      el('circle', { cx: x, cy: y, r: 3.6, fill: '#fff3c4', stroke: '#fff3c4', 'stroke-width': 0.6, class: 'lamp-lens' }),
    );
  };
  lamp(30, 15, p.top);
  lamp(9, 28, p.left);
  lamp(30, 28, p.centre);
  lamp(51, 28, p.right);
  return svg;
}
