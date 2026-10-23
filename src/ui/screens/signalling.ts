import { generatedLies, layoutInterlockings, lockingTable, lockKey, pruneInterlocking, type BoxInterlocking } from '../../core/interlocking';
import { boxesOn, findLayout } from '../../core/layouts';
import { circuitLength, formatLength, parseLength } from '../../core/railway';
import {
  addSignal,
  DEFAULT_SIGNALLING,
  deleteSignal,
  findSignal,
  generateSignals,
  isPoints,
  needsFpl,
  numberLevers,
  postKey,
  postRoutes,
  SIGNAL_KIND_ORDER,
  SIGNAL_KINDS,
  SIGNAL_STYLES,
  signalIssues,
  signalsOf,
  updateSignal,
} from '../../core/signals';
import { circuitPath, findCircuit, junctionName } from '../../core/trackPlan';
import type { AppState, Layout, PlanSignal, SignalKind, SignallingOptions, SignalStyle } from '../../core/types';
import { type Ctx } from '../app';
import { confirmDialog, confirmButton, h, option, toast } from '../dom';
import { DIAGRAM_UNIT, drawDiagram, hasDiagram } from '../planDiagram';

/*
 * The layout configurator's SIGNALLING tab (v0.3.29): the layout's signals on its plan.
 *  - Generate an arrangement (semaphore, colour light, or mixed at random), keeping signals you have
 *    placed or changed yourself; the levers are numbered west to east (points take their lever numbers).
 *  - Place your own: choose the kind and style, tap the track near the end the signal is to face.
 *  - Select a signal on the board or in the list to change it: name, lever number, kind, style, which
 *    way it faces, how far before the end of its circuit it stands, and the routes it reads to.
 *  - Points: whether each has a facing point lock (worked out, or set by hand), with its lever number.
 * The interlocking (locking table) comes next (v0.3.30).
 */

/** What this tab remembers for the app session. */
const ui: { sel: string; placing: { kind: SignalKind; style: SignalStyle } | null; opts: SignallingOptions | null } = { sel: '', placing: null, opts: null };

export function resetSignallingUi(): void {
  ui.sel = '';
  ui.placing = null;
  ui.opts = null;
}

export function layoutSignalling(ctx: Ctx, layoutId: string): HTMLElement {
  const store = ctx.store;
  const st = store.state;
  const layout = findLayout(st, layoutId)!;
  const plan = layout.trackPlan;
  const units = st.settings.units;
  const upd = (fn: (l: Layout, a: AppState) => void) =>
    store.update((a) => {
      const l = findLayout(a, layoutId);
      if (l) {
        fn(l, a);
        pruneInterlocking(l);
      }
    });
  const sigs = signalsOf(layout);
  if (ui.sel && !findSignal(layout, ui.sel)) ui.sel = '';
  const opts: SignallingOptions = ui.opts ?? { ...(plan.signalling ?? DEFAULT_SIGNALLING) };
  ui.opts = opts;
  const rerender = () => store.update(() => {});

  if (!hasDiagram(layout)) {
    return h('div', { class: 'config-stack sg-page' }, h('section', { class: 'config-case' }, h('h2', { class: 'section-board nameboard' }, 'Signalling'), h('p', null, `Draw the track plan of ${layout.name} first (Track plan tab); then signals can be generated or placed on it.`)));
  }

  // ---------------------------------------------------------------- generate
  const seg = <T extends string>(label: string, id: string, items: Array<[T, string]>, cur: T, set: (v: T) => void) =>
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'label-text', id: `${id}_l` }, label),
      h('div', { class: 'seg', role: 'group', 'aria-labelledby': `${id}_l` }, ...items.map(([v, name]) => h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(cur === v), on: { click: () => { set(v); rerender(); } } }, name))),
    );
  const check = (id: string, label: string, value: boolean, set: (v: boolean) => void) =>
    h('label', { class: 'check', for: id }, h('input', { id, type: 'checkbox', checked: value, on: { change: (e: Event) => { set((e.target as HTMLInputElement).checked); rerender(); } } }), label);
  const generated = sigs.filter((s) => !s.manual).length;
  const manual = sigs.filter((s) => s.manual).length;
  const doGenerate = () =>
    confirmDialog({
      title: 'Generate signals?',
      body: [
        `Signals are placed for every signal box on ${layout.name}${manual ? `. Your own ${manual === 1 ? 'signal is' : `${manual} signals are`} kept` : ''}${generated ? `; the ${generated} generated before are replaced` : ''}.`,
        'Then every lever is numbered west to east in each box’s frame: signals, points and facing point locks. Points on the plan are renumbered to their lever numbers.',
      ],
      confirmLabel: 'Generate signals',
      confirmClass: 'btn primary',
      onDone: (ok) => {
        if (!ok) return;
        let r = { added: 0, kept: 0 };
        upd((l, a) => (r = generateSignals(a, l, opts)));
        toast(`${r.added} signals placed${r.kept ? `, ${r.kept} of yours kept` : ''}. Levers numbered.`);
      },
    });
  const generateCase = h(
    'section',
    { class: 'config-case sg-generate' },
    h('h2', { class: 'section-board nameboard' }, 'Signalling'),
    h('p', { class: 'muted small' }, `${sigs.length ? `${sigs.length} signals: ${generated} generated, ${manual} placed or changed by you.` : 'No signals yet.'} Signals you place or change are always kept when you generate again.`),
    seg<SignallingOptions['style']>('Generate as', 'sg_style', [['semaphore', 'Semaphore'], ['colourLight', 'Colour light'], ['mixed', 'Mixed']], opts.style, (v) => (opts.style = v)),
    h('p', { class: 'muted small' }, 'Mixed gives each signal post a style at random.'),
    h('div', { class: 'checks' },
      check('sg_shunt', 'Shunt signals (out of sidings, and for setting back)', opts.shunt, (v) => (opts.shunt = v)),
      check('sg_sa', 'Shunt-ahead signals on section signals, with a limit of shunt in the section', opts.shuntAhead, (v) => (opts.shuntAhead = v)),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', on: { click: doGenerate } }, sigs.length ? 'Generate again' : 'Generate signals'),
      sigs.length ? h('button', { class: 'btn', type: 'button', on: { click: () => { upd((l, a) => numberLevers(a, l)); toast('Levers numbered west to east.'); } } }, 'Number the levers') : null,
      generated ? confirmButton('Remove generated signals', 'Press again to remove them', () => upd((l) => (l.trackPlan.signals = (l.trackPlan.signals ?? []).filter((s) => s.manual)))) : null,
    ),
  );

  // ---------------------------------------------------------------- board
  const svgEl = drawDiagram(st, layout, { labels: 'codes', signals: true, selectedSignal: ui.sel });
  // Drawn larger than the box's diagram board, so signals and their numbers can be read and tapped; the board scrolls.
  if (svgEl) {
    const vb = svgEl.viewBox.baseVal;
    svgEl.style.width = `${Math.round(vb.width * 1.25)}px`;
    svgEl.style.maxWidth = 'none';
  }
  const placeBar = ui.placing
    ? h(
        'div',
        { class: 'tp-pickbar sg-pickbar', role: 'status' },
        h('span', null, `Placing a ${SIGNAL_STYLES[ui.placing.style].toLowerCase()} ${SIGNAL_KINDS[ui.placing.kind].name.toLowerCase()} signal: tap the track near the end it is to face (trains running towards that end).`),
        h('button', { class: 'btn small', type: 'button', on: { click: () => { ui.placing = null; rerender(); } } }, 'Cancel'),
      )
    : null;
  const kindSel = h('select', { id: 'sg_kind', 'aria-label': 'Kind of signal' }, ...SIGNAL_KIND_ORDER.map((k) => option(k, SIGNAL_KINDS[k].name, k === (ui.placing?.kind ?? 'home'))));
  const styleSel = h('select', { id: 'sg_pstyle', 'aria-label': 'Style' }, ...(['semaphore', 'colourLight'] as SignalStyle[]).map((v) => option(v, SIGNAL_STYLES[v], v === (ui.placing?.style ?? (opts.style === 'colourLight' ? 'colourLight' : 'semaphore')))));
  const toolbar = h(
    'div',
    { class: 'tp-toolbar' },
    kindSel,
    styleSel,
    h('button', { class: 'btn small', type: 'button', on: { click: () => { ui.placing = { kind: kindSel.value as SignalKind, style: styleSel.value as SignalStyle }; rerender(); } } }, '+ Place a signal'),
  );
  const onBoardClick = (e: Event) => {
    const target = e.target as Element;
    const sg = target.closest?.('.dg-sig') as SVGGElement | null;
    if (sg && !ui.placing) {
      ui.sel = sg.dataset.signal ?? '';
      rerender();
      return;
    }
    if (!ui.placing) return;
    const g = target.closest?.('.dg-circuit') as SVGGElement | null;
    const circuitId = g?.dataset.circuit;
    if (!circuitId) return;
    const at = whereOnCircuit(st, layout, circuitId, e as MouseEvent, svgEl);
    if (!at) return;
    const placing = ui.placing;
    let id = '';
    upd((l, a) => (id = addSignal(a, l, at, placing.kind, placing.style).id));
    ui.placing = null;
    ui.sel = id;
    rerender();
  };
  const board = h('div', { class: `dg-board sg-board${ui.placing ? ' dg-tappable sg-placing' : ''}`, on: { click: onBoardClick } }, svgEl);
  const boardCase = h('section', { class: 'config-case sg-board-case' }, toolbar, placeBar, h('div', { class: 'sg-board-wrap' }, board));

  // ---------------------------------------------------------------- selected signal
  const sel = ui.sel ? findSignal(layout, ui.sel) : undefined;
  const ils: BoxInterlocking[] = layoutInterlockings(st, layout);
  const ilOf = (boxId: string) => ils.find((x) => x.boxId === boxId);
  const leverNum = (il: BoxInterlocking, key: string) => il.levers.find((l) => l.key === key)?.number || '?';
  /** Change the overrides (and drop ones that put things back as generated). */
  const setOverride = (fn: (ov: NonNullable<Layout['trackPlan']['interlocking']>) => void) =>
    upd((l) => {
      const ov = (l.trackPlan.interlocking ??= {});
      fn(ov);
    });

  const inspector = sel ? signalCase(sel) : null;

  function signalCase(s: PlanSignal): HTMLElement {
    const c = findCircuit(plan, s.circuitId);
    const info = SIGNAL_KINDS[s.kind];
    const set = (patch: Partial<PlanSignal>) => upd((l) => updateSignal(l, s.id, patch));
    const endName = (end: 0 | 1) => {
      const e = c?.ends[end];
      if (!e) return '';
      if (e.kind === 'bufferStops') return 'the buffer stops';
      if (e.kind === 'exit') return 'the edge of the plan';
      if (e.kind === 'joined') {
        const j = plan.junctions.find((x) => x.id === e.junctionId);
        return j ? (j.kind === 'joint' ? 'the joint' : junctionName(j)) : 'the end';
      }
      return 'the end';
    };
    const metres = c ? circuitLength(st, layout, c).metres : 0;
    const backInput = h('input', {
      id: 'sg_back',
      type: 'text',
      value: s.back ? formatLength(s.back, units) : '0',
      on: {
        change: (e: Event) => {
          const t = (e.target as HTMLInputElement).value.trim();
          const v = t === '0' || t === '' ? 0 : parseLength(t, units === 'metric' ? 'm' : 'yd');
          if (v === null) return toast('Type a distance, e.g. 200 yd, 10 ch or 180 m.');
          set({ back: Math.min(v, Math.max(0, metres - 1)) });
        },
      },
    });
    const pr = postRoutes(st, layout, s);
    const mine = pr.reads.get(s.id) ?? [];
    const routeBox = info.cls === 'main' || info.cls === 'shunt' || info.cls === 'shuntAhead'
      ? h(
          'fieldset',
          { class: 'sg-routes' },
          h('legend', null, 'Routes it reads to'),
          h('label', { class: 'check', for: 'sg_follow' }, h('input', { id: 'sg_follow', type: 'checkbox', checked: !s.reads, on: { change: (e: Event) => set((e.target as HTMLInputElement).checked ? { reads: undefined } : { reads: mine.map((r) => r.key) }) } }), 'Every route here not read by another signal at this place (follows the track as it changes)'),
          ...pr.routes.map((r, i) =>
            h(
              'label',
              { class: 'check', for: `sg_r${i}` },
              h('input', {
                id: `sg_r${i}`,
                type: 'checkbox',
                disabled: !s.reads,
                checked: mine.some((m) => m.key === r.key),
                on: {
                  change: (e: Event) => {
                    const on = (e.target as HTMLInputElement).checked;
                    // Pin to the routes it reads now; keep pins to a whole road or yard, except this route's own.
                    const keys = new Set([...mine.map((m) => m.key), ...(s.reads ?? []).filter((k) => k !== r.group && k !== r.key)]);
                    if (on) keys.add(r.key);
                    else keys.delete(r.key);
                    set({ reads: [...keys] });
                  },
                },
              }),
              r.label,
            ),
          ),
          pr.routes.length ? null : h('p', { class: 'muted small' }, 'No route beyond it: check which way it faces.'),
        )
      : h('p', { class: 'muted small' }, s.kind === 'distant' ? 'A distant reads no route of its own: it shows caution unless the stop signals ahead are off.' : 'A limit of shunt is a fixed board: shunting moves stop at it.');
    return h(
      'section',
      { class: 'config-case sg-inspector', 'aria-label': 'Selected signal' },
      h('div', { class: 'row' }, h('h3', { class: 'plate' }, `${s.number ? `${s.number} · ` : ''}${info.name}`), h('span', { class: 'tag' }, s.manual ? 'Placed or changed by you' : 'Generated')),
      h('p', { class: 'muted small' }, info.description),
      h('div', { class: 'form-grid tight' },
        field('Name', h('input', { id: 'sg_name', type: 'text', value: s.name, on: { change: (e: Event) => set({ name: (e.target as HTMLInputElement).value.trim() || s.name }) } })),
        info.lever ? field('Lever number', h('input', { id: 'sg_num', type: 'text', inputmode: 'numeric', value: s.number, on: { change: (e: Event) => set({ number: (e.target as HTMLInputElement).value.trim() }) } })) : null,
        field('Kind', h('select', { id: 'sg_k', on: { change: (e: Event) => set({ kind: (e.target as HTMLSelectElement).value as SignalKind }) } }, ...SIGNAL_KIND_ORDER.map((k) => option(k, SIGNAL_KINDS[k].name, k === s.kind)))),
        field('Style', h('select', { id: 'sg_s', on: { change: (e: Event) => set({ style: (e.target as HTMLSelectElement).value as SignalStyle }) } }, ...(['semaphore', 'colourLight'] as SignalStyle[]).map((v) => option(v, SIGNAL_STYLES[v], v === s.style)))),
        field(`Before ${endName(s.end)} (${units === 'metric' ? 'm' : 'yd'})`, backInput),
      ),
      h('p', null, `On ${c ? c.name || c.code : 'a circuit'} (${c?.code ?? ''}), for trains running towards ${endName(s.end)}. Worked by ${st.boxes.find((b) => b.id === s.boxId)?.name ?? 'no box'}.`),
      routeBox,
      interlockBox(s),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn small', type: 'button', on: { click: () => set({ end: (1 - s.end) as 0 | 1, back: 0 }) } }, 'Face the other way'),
        h('button', { class: 'btn small', type: 'button', on: { click: () => { ui.sel = ''; rerender(); } } }, 'Done'),
        confirmButton('Delete signal', 'Press again to delete', () => { upd((l) => deleteSignal(l, s.id)); ui.sel = ''; }),
      ),
    );
  }

  // ---------------------------------------------------------------- points and their locks
  const boxes = boxesOn(st, layout.id);
  const pointsCase = h(
    'section',
    { class: 'config-case sg-points' },
    h('h3', { class: 'label' }, 'Points and facing point locks'),
    h('p', { class: 'muted small' }, 'Points that trains run through facing, from running track to running track, need a facing point lock (FPL), worked by its own lever. Points on the plan are numbered as their levers when the levers are numbered.'),
    ...boxes.map((b) => {
      const pts = plan.junctions.filter((j) => j.boxId === b.id && !j.connectionId && isPoints(j));
      if (!pts.length) return null;
      return h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'sg-table' },
          h('caption', null, b.name),
          h('thead', null, h('tr', null, h('th', null, 'Points'), h('th', null, 'FPL lever'), h('th', null, 'Lock'))),
          h(
            'tbody',
            null,
            ...pts
              .sort((x, y) => Number(x.number) - Number(y.number) || x.x - y.x)
              .map((j) =>
                h(
                  'tr',
                  null,
                  h('td', null, junctionName(j)),
                  h('td', { class: 'num' }, needsFpl(st, layout, j) ? j.fplNumber || '(number the levers)' : '—'),
                  h(
                    'td',
                    null,
                    h(
                      'select',
                      { 'aria-label': `Lock for ${junctionName(j)}`, on: { change: (e: Event) => upd((l) => { const x = l.trackPlan.junctions.find((y) => y.id === j.id); if (!x) return; const v = (e.target as HTMLSelectElement).value; if (v) x.lock = v as 'fpl' | 'none'; else delete x.lock; }) } },
                      option('', `Worked out (${needsFpl(st, layout, { ...j, lock: undefined }) ? 'FPL' : 'none'})`, !j.lock),
                      option('fpl', 'Facing point lock', j.lock === 'fpl'),
                      option('none', 'No lock', j.lock === 'none'),
                    ),
                  ),
                ),
              ),
          ),
        ),
      );
    }),
  );

  // ---------------------------------------------------------------- interlocking
  /** The selected signal's part in the interlocking: how its routes lock the points, and what it locks. */
  function interlockBox(s: PlanSignal): HTMLElement | null {
    const il = ilOf(s.boxId);
    if (!il || !SIGNAL_KINDS[s.kind].lever) return null;
    const rel = il.releases.get(s.id) ?? [];
    const pointsLevers = il.levers.filter((l) => l.kind === 'points');
    if (s.kind === 'distant') {
      return h(
        'fieldset',
        { class: 'sg-routes sg-lock' },
        h('legend', null, 'Interlocking'),
        h('p', { class: 'small' }, rel.length ? `Released by ${rel.map((r) => r.label).join(' or ')}: the stop signals ahead for a clear run on to the line.` : 'No clear run on to the line from here, so it can never come off (a fixed distant).'),
      );
    }
    const ov = layout.trackPlan.interlocking ?? {};
    const routeRows = rel.map((r) => {
      const gen = generatedLies(layout, s, r.steps);
      const okey = `${s.id}|${r.key}`;
      const mine = ov.routes?.[okey] ?? {};
      const ids = [...new Set([...gen.keys(), ...Object.keys(mine)])].filter((j) => pointsLevers.some((l) => l.id === j));
      const pick = (jid: string) => {
        const g = gen.get(jid);
        const cur = mine[jid] ?? g ?? 'free';
        return h(
          'select',
          {
            'aria-label': `Points ${leverNum(il, `pts:${jid}`)} for ${r.label}`,
            on: {
              change: (e: Event) => {
                const v = (e.target as HTMLSelectElement).value as 'normal' | 'reverse' | 'free';
                setOverride((o) => {
                  const m = ((o.routes ??= {})[okey] ??= {});
                  if (v === (g ?? 'free')) delete m[jid];
                  else m[jid] = v;
                  if (!Object.keys(m).length) delete o.routes![okey];
                });
              },
            },
          },
          option('normal', `Normal${g === 'normal' ? ' (generated)' : ''}`, cur === 'normal'),
          option('reverse', `Reverse${g === 'reverse' ? ' (generated)' : ''}`, cur === 'reverse'),
          option('free', `Not locked${!g ? ' (generated)' : ''}`, cur === 'free'),
        );
      };
      const others = pointsLevers.filter((l) => !ids.includes(l.id));
      return h(
        'div',
        { class: 'sg-lock-route' },
        h('strong', null, r.label),
        r.overridden ? h('span', { class: 'tag' }, ' changed') : null,
        ...ids.map((jid) => h('div', { class: 'row sg-lock-pt' }, h('span', null, `Points ${leverNum(il, `pts:${jid}`)}`), pick(jid))),
        others.length
          ? h(
              'select',
              {
                'aria-label': `Also lock points for ${r.label}`,
                on: { change: (e: Event) => { const jid = (e.target as HTMLSelectElement).value; if (jid) setOverride((o) => { ((o.routes ??= {})[okey] ??= {})[jid] = 'normal'; }); } },
              },
              option('', 'Also lock points…', true),
              ...others.map((l) => option(l.id, `Points ${l.number}`, false)),
            )
          : null,
      );
    });
    const locked = [...(il.locks.get(s.id) ?? [])];
    const removed = (ov.removedLocks ?? []).filter(([a, b]) => a === s.id || b === s.id).map(([a, b]) => (a === s.id ? b : a));
    const candidates = signalsOf(layout).filter((x) => x.boxId === s.boxId && x.id !== s.id && x.number && SIGNAL_KINDS[x.kind].lever && x.kind !== 'distant' && !locked.includes(x.id));
    const num = (id: string) => signalsOf(layout).find((x) => x.id === id)?.number || '?';
    return h(
      'fieldset',
      { class: 'sg-routes sg-lock' },
      h('legend', null, 'Interlocking'),
      rel.length ? h('p', { class: 'muted small' }, 'How each route locks the points (FPLs follow: points met facing on a running line are bolted).') : h('p', { class: 'muted small' }, 'No route: it can never come off.'),
      ...routeRows,
      h('div', { class: 'sg-lock-locks' },
        h('strong', null, 'Locks at danger: '),
        ...(locked.length
          ? locked.map((o) =>
              h('button', {
                class: 'btn small sg-lock-chip',
                type: 'button',
                title: 'Remove this lock',
                on: {
                  click: () =>
                    setOverride((ov2) => {
                      const k = lockKey(s.id, o);
                      if ((ov2.extraLocks ?? []).some(([a, b]) => lockKey(a, b) === k)) ov2.extraLocks = ov2.extraLocks!.filter(([a, b]) => lockKey(a, b) !== k);
                      else (ov2.removedLocks ??= []).push([s.id, o]);
                    }),
                },
              }, `${num(o)} ✕`),
            )
          : [h('span', { class: 'muted small' }, 'nothing')]),
      ),
      removed.length
        ? h('div', { class: 'sg-lock-locks' }, h('span', { class: 'muted small' }, 'Locks you removed: '), ...removed.map((o) => h('button', { class: 'btn small', type: 'button', on: { click: () => setOverride((ov2) => { ov2.removedLocks = (ov2.removedLocks ?? []).filter(([a, b]) => lockKey(a, b) !== lockKey(s.id, o)); }) } }, `Restore ${num(o)}`)))
        : null,
      candidates.length
        ? h(
            'select',
            {
              'aria-label': 'Add a lock with another signal',
              on: { change: (e: Event) => { const o = (e.target as HTMLSelectElement).value; if (o) setOverride((ov2) => { ov2.removedLocks = (ov2.removedLocks ?? []).filter(([a, b]) => lockKey(a, b) !== lockKey(s.id, o)); (ov2.extraLocks ??= []).push([s.id, o]); }); } },
            },
            option('', 'Add a lock with…', true),
            ...candidates.sort((a, b) => Number(a.number) - Number(b.number)).map((x) => option(x.id, `${x.number} ${x.name}`, false)),
          )
        : null,
    );
  }

  const lockCase = ils.length
    ? h(
        'section',
        { class: 'config-case sg-locking' },
        h('h3', { class: 'label' }, 'Interlocking'),
        h('p', { class: 'muted small' }, 'Worked out from the signals and their routes. A lever can be pulled only once the levers it is released by are pulled, and while it is pulled the levers it locks stay normal. Select a signal to change how its routes lock the points, or what it locks.'),
        ...ils.map((il) => {
          const box = st.boxes.find((b) => b.id === il.boxId);
          const rows = lockingTable(st, layout, il);
          return h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'sg-table sg-lock-table' },
              h('caption', null, `${box?.name ?? 'No box'} · locking table`),
              h('thead', null, h('tr', null, h('th', null, 'Lever'), h('th', null, 'Works'), h('th', null, 'Released by'), h('th', null, 'Locks'), h('th', null, 'Both ways'))),
              h(
                'tbody',
                null,
                ...rows.map((r) =>
                  h(
                    'tr',
                    { class: `k-${r.lever.kind}${r.lever.kind === 'signal' && r.lever.id === ui.sel ? ' selected' : ''}` },
                    h('td', { class: 'num' }, r.lever.number || '—'),
                    h('td', null, r.lever.kind === 'signal' ? h('button', { class: 'linkish', type: 'button', on: { click: () => { ui.sel = r.lever.id; rerender(); } } }, r.lever.name) : r.lever.name, r.note ? h('div', { class: 'muted small' }, r.note) : null),
                    h('td', { class: 'num' }, r.releasedBy.join(' ') || '—'),
                    h('td', { class: 'num' }, r.locks.join(' ') || '—'),
                    h('td', { class: 'num' }, r.bothWays.join(' ') || '—'),
                  ),
                ),
              ),
            ),
          );
        }),
      )
    : null;

  // ---------------------------------------------------------------- list and checks
  const issues = signalIssues(st, layout);
  const issuesCase = issues.length
    ? h('section', { class: 'config-case sg-issues' }, h('h3', { class: 'label' }, `Worth a look (${issues.length})`), h('ul', null, ...issues.map((i) => h('li', null, i.signalId ? h('button', { class: 'linkish', type: 'button', on: { click: () => { ui.sel = i.signalId!; rerender(); } } }, i.text) : i.text))))
    : null;
  const listCase = sigs.length
    ? h(
        'section',
        { class: 'config-case sg-list' },
        h('h3', { class: 'label' }, 'Signals'),
        ...boxes.map((b) => {
          const mine = sigs.filter((s) => s.boxId === b.id).sort((x, y) => (Number(x.number) || 999) - (Number(y.number) || 999));
          if (!mine.length) return null;
          return h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'sg-table' },
              h('caption', null, b.name),
              h('thead', null, h('tr', null, h('th', null, 'Lever'), h('th', null, 'Signal'), h('th', null, 'Kind'), h('th', null, 'Style'), h('th', null, 'Reads to'))),
              h(
                'tbody',
                null,
                ...mine.map((s) =>
                  h(
                    'tr',
                    { class: s.id === ui.sel ? 'selected' : '' },
                    h('td', { class: 'num' }, s.number || '—'),
                    h('td', null, h('button', { class: 'linkish', type: 'button', on: { click: () => { ui.sel = s.id; rerender(); } } }, s.name), s.manual ? h('span', { class: 'muted small' }, ' · yours') : null),
                    h('td', null, SIGNAL_KINDS[s.kind].name),
                    h('td', null, SIGNAL_STYLES[s.style]),
                    h('td', { class: 'small' }, (postRoutes(st, layout, s).reads.get(s.id) ?? []).map((r) => r.label).join(', ') || '—'),
                  ),
                ),
              ),
            ),
          );
        }),
        sigs.some((s) => !s.boxId) ? h('p', { class: 'muted small' }, `${sigs.filter((s) => !s.boxId).length} signal(s) on track no box works.`) : null,
      )
    : null;

  return h('div', { class: 'config-shelf sg-page' }, h('div', { class: 'sg-grid' }, h('div', { class: 'sg-main' }, generateCase, boardCase, issuesCase, listCase, lockCase), h('div', { class: 'sg-side' }, inspector, pointsCase)));

  function field(label: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'field' }, h('label', { for: control.id }, label), control);
  }
  void postKey;
}

/** Where on a circuit a tap was: the nearer end, and how far before it (metres; 0 near the end). */
function whereOnCircuit(state: AppState, layout: Layout, circuitId: string, ev: MouseEvent, svgEl: SVGSVGElement | null): { circuitId: string; end: 0 | 1; back: number } | null {
  const c = findCircuit(layout.trackPlan, circuitId);
  if (!c || !svgEl) return null;
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return { circuitId, end: 1, back: 0 };
  const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
  const ox = Number(svgEl.dataset.ox);
  const oy = Number(svgEl.dataset.oy);
  const gx = pt.x / DIAGRAM_UNIT + ox;
  const gy = pt.y / DIAGRAM_UNIT + oy;
  const path = circuitPath(layout.trackPlan, c);
  let best = { d: Infinity, along: 0 };
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
    const t = Math.max(0, Math.min(1, ((gx - a.x) * (b.x - a.x) + (gy - a.y) * (b.y - a.y)) / (l * l)));
    const d = Math.hypot(a.x + (b.x - a.x) * t - gx, a.y + (b.y - a.y) * t - gy);
    if (d < best.d) best = { d, along: acc + t * l };
    acc += l;
  }
  const total = acc || 1;
  const end: 0 | 1 = best.along > total / 2 ? 1 : 0;
  const fromEnd = end === 1 ? total - best.along : best.along;
  const metres = circuitLength(state, layout, c).metres;
  return { circuitId, end, back: fromEnd < 0.8 ? 0 : Math.round((fromEnd / total) * metres) };
}
