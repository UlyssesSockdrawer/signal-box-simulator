type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & {
  class?: string;
  style?: string;
  on?: Partial<Record<string, (e: any) => void>>;
};

/** Tiny hyperscript helper: h('button', { class: 'x', on: { click } }, 'Label') */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') {
        for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) if (fn) el.addEventListener(ev, fn);
      } else if (k === 'value' && 'value' in el) {
        (el as HTMLInputElement).value = String(v);
      } else if (k === 'checked' && 'checked' in el) {
        (el as HTMLInputElement).checked = Boolean(v);
      } else if (k === 'selected' && 'selected' in el) {
        (el as HTMLOptionElement).selected = Boolean(v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export function option(value: string, label: string, selected = false): HTMLOptionElement {
  return h('option', { value, selected }, label);
}

/** A labelled form row. */
export function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const id = control.id || `f_${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, help ? h('small', { class: 'help' }, help) : null);
}

/** Button that needs a second press to confirm (the app frame blocks confirm()). */
export function confirmButton(label: string, confirmLabel: string, onConfirm: () => void, cls = 'btn danger'): HTMLButtonElement {
  let armed = false;
  let timer: number | undefined;
  const b = h('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      b.classList.add('armed');
      timer = window.setTimeout(() => {
        armed = false;
        b.textContent = label;
        b.classList.remove('armed');
      }, 4000);
      return;
    }
    window.clearTimeout(timer);
    onConfirm();
  });
  return b;
}

let toastTimer: number | undefined;
export function toast(text: string): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------------------
// Re-rendering a form without losing the user's place
// ---------------------------------------------------------------------------
// Screens rebuild their DOM when saved data changes. Fields save on 'change',
// which fires as the user tabs or clicks out of a field — before the browser
// has moved focus on. Rebuilding at that moment removes the element focus is
// leaving, so Tab restarts from the top of the page and a click on a button
// can be lost. So rebuilds are deferred until focus has moved and any press
// has finished, then focus (and the text selection) is put back on the same
// field in the new DOM.

const FOCUSABLE = 'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

interface FocusSnap {
  id: string;
  index: number;
  selStart: number | null;
  selEnd: number | null;
  selDir: 'forward' | 'backward' | 'none' | null;
}

function snapFocus(root: Element): FocusSnap | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body || !root.contains(a)) return null;
  const snap: FocusSnap = { id: a.id, index: [...root.querySelectorAll(FOCUSABLE)].indexOf(a), selStart: null, selEnd: null, selDir: null };
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
    try {
      snap.selStart = a.selectionStart;
      snap.selEnd = a.selectionEnd;
      snap.selDir = a.selectionDirection;
    } catch {
      /* number inputs have no selection */
    }
  }
  return snap;
}

function restoreFocus(root: Element, snap: FocusSnap | null): void {
  if (!snap) return;
  const byId = snap.id ? document.getElementById(snap.id) : null;
  const el = (byId && root.contains(byId) ? byId : root.querySelectorAll<HTMLElement>(FOCUSABLE)[snap.index]) ?? null;
  if (!el) return;
  el.focus({ preventScroll: true });
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && snap.selStart !== null && snap.selEnd !== null) {
    try {
      el.setSelectionRange(snap.selStart, snap.selEnd, snap.selDir ?? undefined);
    } catch {
      /* not a text field */
    }
  }
}

let pointerDown = false;
let lastChanged: EventTarget | null = null;
const pointerUpWaiters = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (pointerDown = true), { capture: true });
  const up = () => {
    pointerDown = false;
    const fns = [...pointerUpWaiters];
    pointerUpWaiters.clear();
    // After the click that follows pointerup has been handled.
    for (const fn of fns) window.setTimeout(fn, 0);
  };
  window.addEventListener('pointerup', up, { capture: true });
  window.addEventListener('pointercancel', up, { capture: true });
  document.addEventListener('change', (e) => (lastChanged = e.target), { capture: true });
}

/**
 * Returns a function that schedules `render` (which rebuilds the contents of `root`)
 * at a safe moment, keeping focus, text selection and scroll position.
 * `scroller` is the element whose scroll position to keep (default: the window).
 */
export function safeRerender(root: () => Element | null, render: () => void, scroller: () => HTMLElement | null = () => null): () => void {
  let queued = false;
  const run = () => {
    queued = false;
    const r = root();
    if (!r) return;
    // Wait for a press (mouse, touch, pen) to finish, so the click lands on the element pressed.
    if (pointerDown) {
      queued = true;
      pointerUpWaiters.add(run);
      return;
    }
    // A drop-down the user has just opened (not the one that changed) would close if rebuilt: wait until they leave it.
    const a = document.activeElement;
    if (a instanceof HTMLSelectElement && r.contains(a) && a !== lastChanged) {
      queued = true;
      a.addEventListener('blur', () => window.setTimeout(run, 0), { once: true });
      return;
    }
    const sc = scroller();
    const y = sc ? sc.scrollTop : window.scrollY;
    const snap = snapFocus(r);
    render();
    const r2 = root();
    if (sc) sc.scrollTop = y;
    else window.scrollTo(0, y);
    if (r2) restoreFocus(r2, snap);
  };
  return () => {
    if (queued) return;
    queued = true;
    // Let the browser finish moving focus (Tab / click) first.
    window.setTimeout(run, 0);
  };
}

/**
 * Ask the user to confirm an action that cannot be undone, in a modal dialog styled as a
 * mahogany case. `onDone(true)` runs when they confirm, `onDone(false)` when they cancel
 * (Cancel, Escape or a click outside).
 */
export function confirmDialog(opts: { title: string; body: Array<string | HTMLElement>; confirmLabel: string; cancelLabel?: string; confirmClass?: string; onDone: (ok: boolean) => void }): void {
  const dlg = h('dialog', { class: 'config-case confirm-dialog', 'aria-labelledby': 'cd_title' });
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    dlg.close();
    dlg.remove();
    opts.onDone(ok);
  };
  dlg.append(
    h('h2', { class: 'plate', id: 'cd_title' }, opts.title),
    ...opts.body.map((b) => (typeof b === 'string' ? h('p', null, b) : b)),
    h(
      'div',
      { class: 'row end' },
      h('button', { class: 'btn', type: 'button', on: { click: () => finish(false) } }, opts.cancelLabel ?? 'Cancel'),
      h('button', { class: opts.confirmClass ?? 'btn danger armed', type: 'button', on: { click: () => finish(true) } }, opts.confirmLabel),
    ),
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(false);
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      const ev = e as MouseEvent;
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) finish(false);
    }
  });
  document.body.append(dlg);
  dlg.showModal();
  (dlg.querySelector('.btn') as HTMLButtonElement | null)?.focus();
}
