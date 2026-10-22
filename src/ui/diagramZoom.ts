/*
 * Zooming and panning a diagram drawn with a viewBox: the scroll wheel zooms about the pointer,
 * two fingers pinch, and once zoomed in one finger (or the mouse) drags it about. The zoom is kept
 * per diagram (e.g. per box) so a redraw keeps your view.
 */

export interface ZoomView {
  /** 1 = the whole diagram; up to MAX_ZOOM. */
  scale: number;
  /** The centre of the view, in the diagram's own units. */
  cx: number;
  cy: number;
}

const MAX_ZOOM = 6;
const views = new Map<string, ZoomView>();

export function zoomViewOf(key: string): ZoomView | undefined {
  return views.get(key);
}

export interface ZoomControl {
  zoomBy(f: number): void;
  reset(): void;
  /** True for a moment after a drag, so the click that ends it is ignored. */
  dragged(): boolean;
}

export function enableZoom(svg: SVGSVGElement, key: string, onChange?: (v: ZoomView) => void): ZoomControl {
  const vb = svg.viewBox.baseVal;
  const full = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
  let v: ZoomView = views.get(key) ?? { scale: 1, cx: full.x + full.w / 2, cy: full.y + full.h / 2 };

  const apply = () => {
    v.scale = Math.min(MAX_ZOOM, Math.max(1, v.scale));
    const w = full.w / v.scale;
    const hh = full.h / v.scale;
    v.cx = Math.min(full.x + full.w - w / 2, Math.max(full.x + w / 2, v.cx));
    v.cy = Math.min(full.y + full.h - hh / 2, Math.max(full.y + hh / 2, v.cy));
    svg.setAttribute('viewBox', `${(v.cx - w / 2).toFixed(2)} ${(v.cy - hh / 2).toFixed(2)} ${w.toFixed(2)} ${hh.toFixed(2)}`);
    // Zoomed in, one finger pans the diagram; at full size it scrolls the page as usual.
    svg.style.touchAction = v.scale > 1.001 ? 'none' : 'pan-x pan-y';
    svg.classList.toggle('dg-zoomed', v.scale > 1.001);
    views.set(key, { ...v });
    onChange?.(v);
  };

  /** A point on screen in the diagram's units. */
  const toSvg = (clientX: number, clientY: number) => {
    const r = svg.getBoundingClientRect();
    const w = full.w / v.scale;
    const hh = full.h / v.scale;
    // preserveAspectRatio: the drawing is centred and fitted inside the element.
    const k = Math.min(r.width / w, r.height / hh) || 1;
    const ox = r.left + (r.width - w * k) / 2;
    const oy = r.top + (r.height - hh * k) / 2;
    return { x: v.cx - w / 2 + (clientX - ox) / k, y: v.cy - hh / 2 + (clientY - oy) / k, k };
  };

  /** Zoom by f, keeping the diagram point under (clientX, clientY) where it is. */
  const zoomAt = (f: number, clientX?: number, clientY?: number) => {
    const before = clientX !== undefined && clientY !== undefined ? toSvg(clientX, clientY) : null;
    const old = v.scale;
    v.scale = Math.min(MAX_ZOOM, Math.max(1, v.scale * f));
    if (before && v.scale !== old) {
      // Keep the point under the pointer still.
      const ratio = old / v.scale;
      v.cx = before.x + (v.cx - before.x) * ratio;
      v.cy = before.y + (v.cy - before.y) * ratio;
    }
    apply();
  };

  svg.addEventListener(
    'wheel',
    (e) => {
      // At full size, scrolling out is left to the page.
      if (v.scale <= 1.001 && e.deltaY > 0) return;
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX, e.clientY);
    },
    { passive: false },
  );

  // Pointers: two for a pinch, one to pan (when zoomed in).
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number } | null = null;
  let pan: { x: number; y: number; moved: boolean } | null = null;
  let dragEnded = 0;
  svg.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      pan = null;
    } else if (pts.size === 1 && v.scale > 1.001) pan = { x: e.clientX, y: e.clientY, moved: false };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.d = d;
      dragEnded = Date.now();
      return;
    }
    if (pan) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < 5) return;
      if (!pan.moved) svg.setPointerCapture?.(e.pointerId);
      pan.moved = true;
      const { k } = toSvg(e.clientX, e.clientY);
      v.cx -= dx / k;
      v.cy -= dy / k;
      pan.x = e.clientX;
      pan.y = e.clientY;
      apply();
    }
  });
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pan?.moved || pinch) dragEnded = Date.now();
    if (pts.size < 2) pinch = null;
    if (!pts.size) pan = null;
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  // A drag ends with a click: do not let it count as a tap on the track.
  svg.addEventListener(
    'click',
    (e) => {
      if (Date.now() - dragEnded < 250) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );

  apply();
  return {
    zoomBy: (f) => zoomAt(f),
    reset: () => {
      v = { scale: 1, cx: full.x + full.w / 2, cy: full.y + full.h / 2 };
      apply();
    },
    dragged: () => Date.now() - dragEnded < 250,
  };
}
