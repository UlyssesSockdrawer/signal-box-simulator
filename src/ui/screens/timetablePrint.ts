import {
  findTrain,
  fmtTime,
  isTimed,
  PASSENGER_TYPES,
  posterTables,
  posterTime,
  refText,
  trainLoco,
  walkTimetable,
  type PosterCell,
  type PosterTable,
} from '../../core/timetables';
import type { AppState, Layout, Timetable, TimetableEntry } from '../../core/types';
import { activeCodeSet, locoFullName, trainTypeName, type Ctx } from '../app';
import { h, option } from '../dom';
import { eraOf, lampClass, usesLamps } from '../../core/headcodes';
import { lampDiagram } from '../lampDiagram';

/*
 * Printable views of a timetable, styled as railway paperwork (the same in every theme, like the
 * enamel diagram board):
 *  - POSTER: a letterpress public timetable — cream paper, woodtype headings, the layout's name as
 *    the railway company, one table per direction with places down the side and a column per train.
 *    Goods and other trains follow in their own smaller tables. A sequence timetable prints its
 *    order of working instead of times.
 *  - TRAIN CARDS: one card per move, as in a card-order system, to hand to operators.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Short working names for the column heads (as a WTT or poster would abbreviate them). */
const SHORT: Record<string, string> = {
  express_passenger: 'Exp.',
  ordinary_passenger: '',
  branch_passenger: 'Branch',
  railcar: 'Rail-car',
  parcels: 'Parcels',
  ecs: 'E.C.S.',
  freight_fitted_half: 'Exp. Gds',
  freight_fitted_third: 'Exp. Gds',
  freight_fitted_four: 'Exp. Gds',
  freight_unfitted: 'Exp. Gds',
  through_freight: 'Thro’ Gds',
  mineral: 'Mineral',
  pickup_goods: 'Pick-up',
  branch_freight: 'Br. Gds',
  light_engine: 'Light Eng.',
  engine_brake_van: 'Eng. & Van',
};
const short = (st: AppState, id: string) => SHORT[id] ?? trainTypeName(st, id);

/** "Sigsim Central Railway" (not "… Railway Railway"). */
function companyName(layout: Layout): string {
  const n = layout.name.trim();
  return /\b(railway|railroad|line|tramway)\b/i.test(n) ? n : `${n} Railway`;
}

const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** What to choose in the browser's print dialog for the poster to fill the sheet. */
function printNote(): HTMLElement {
  const paper = PAPERS.find((x) => x.id === prefs.paper)!;
  return h(
    'p',
    { class: 'shelf-help tt-print-note' },
    `Printing fills a ${paper.name} sheet${prefs.edge === 'bleed' ? ', paper colour to the edges' : ' inside a 10 mm margin'}. In the print dialog choose ${paper.name} paper, portrait, scale 100% (or Default)${prefs.edge === 'bleed' ? ' and margins Default or None' : ''}. ${prefs.edge === 'bleed' ? 'Most printers leave a thin unprinted strip at the very edge: trim it off, or print borderless if your printer can.' : ''}`,
  );
}

function printTools(...controls: Array<HTMLElement | null>) {
  return h('div', { class: 'row tt-print-tools' }, ...controls, h('span', { class: 'tt-spacer' }), h('button', { class: 'btn primary', type: 'button', on: { click: () => window.print() } }, 'Print'));
}

// ====================================================================== poster

export function posterView(ctx: Ctx, layout: Layout, tt: Timetable): HTMLElement {
  const st = ctx.store.state;
  const passenger = posterTables(st, layout, tt, 'passenger');
  // Goods and other trains: a plain list (as a working notice would give them), not route tables.
  const other = tt.entries
    .map((e, i) => ({ e, order: i + 1 }))
    .filter(({ e }) => e.kind === 'run' && e.from.placeId && e.to.placeId && !PASSENGER_TYPES.has(e.trainTypeId));
  const timed = isTimed(tt);
  const elapsed = tt.timing === 'session' && tt.elapsed;
  const used = new Set(passenger.flatMap((t) => t.cols.map((c) => c.entry.trainTypeId)));
  const era = eraOf(layout);
  const lamps = usesLamps(era);
  // Lamp eras: a key to the lamp headcodes of the trains on the poster, in class order.
  const lampKinds = lamps
    ? [...new Set([...passenger.flatMap((t) => t.cols.map((c) => c.entry.trainTypeId)), ...other.map(({ e }) => e.trainTypeId)])]
        .filter((id) => lampClass(era, id))
        .sort((a, b) => lampClass(era, a)!.localeCompare(lampClass(era, b)!))
    : [];
  const lampKey = lampKinds.length
    ? h(
        'div',
        { class: 'pp-lampkey' },
        h('p', { class: 'pp-lampkey-title' }, 'Engine head lamps'),
        h('ul', { class: 'plain' }, ...lampKinds.map((id) => h('li', null, lampDiagram(era, id, 'pp-lamps'), h('span', null, h('strong', null, `${lampClass(era, id)} `), trainTypeName(st, id))))),
      )
    : null;

  const table = (t: PosterTable, small: boolean) => {
    const cols = t.cols;
    const head = (c: (typeof cols)[number]) => c.entry.headcode || (c.train?.name ?? '');
    const lines: HTMLTableRowElement[] = [];
    t.rows.forEach((place, i) => {
      const cells = cols.map((c) => c.cells.get(place.id));
      const lastRow = i === t.rows.length - 1;
      const firstRow = i === 0;
      if (!timed) {
        lines.push(
          h(
            'tr',
            { class: `pp-line${firstRow ? ' first' : ''}${lastRow ? ' last' : ''}` },
            h('th', { scope: 'row', class: 'pp-place' }, h('span', null, place.name)),
            h('td', { class: 'pp-ad' }, ''),
            ...cells.map((cell) => h('td', { class: 'pp-t' }, seqCell(cell))),
          ),
        );
        return;
      }
      // The first place has departures, the last arrivals; places between have both lines when
      // any train shows an arrival time there.
      const kinds: Array<'arr' | 'dep'> = firstRow ? ['dep'] : lastRow ? ['arr'] : cells.some((c) => c && !c.pass && c.arr !== null) ? ['arr', 'dep'] : ['dep'];
      kinds.forEach((k, j) =>
        lines.push(
          h(
            'tr',
            { class: `pp-line${j === 0 && firstRow ? ' first' : ''}${lastRow ? ' last' : ''}${j > 0 ? ' cont' : ''}` },
            h('th', { scope: 'row', class: 'pp-place' }, j === 0 ? h('span', null, place.name) : ''),
            h('td', { class: 'pp-ad' }, k === 'arr' ? 'arr.' : 'dep.'),
            ...cells.map((cell) => h('td', { class: 'pp-t' }, timeCell(cell, k))),
          ),
        ),
      );
    });
    const halves = timed && !elapsed ? cols.map((c) => posterTime(c.entry.dep ?? c.entry.arr, tt).half) : [];
    return h(
      'section',
      { class: `pp-table${small ? ' small' : ''}` },
      h('h3', { class: 'pp-dir' }, h('span', null, t.rows[0].name), h('em', null, ' to '), h('span', null, t.rows[t.rows.length - 1].name)),
      h(
        'div',
        { class: 'pp-scroll' },
        h(
          'table',
          null,
          h(
            'thead',
            null,
            h('tr', { class: 'pp-heads' }, h('th', { class: 'pp-corner', scope: 'col' }, timed ? '' : 'Order'), h('th', { class: 'pp-ad' }), ...cols.map((c) => h('th', { scope: 'col' }, timed ? head(c) : `No. ${c.order}`))),
            h('tr', { class: 'pp-kinds' }, h('th', { class: 'pp-corner' }), h('th', { class: 'pp-ad' }), ...cols.map((c) => h('th', null, c.entry.trainTypeId === 'express_passenger' ? h('strong', null, 'E') : short(st, c.entry.trainTypeId)))),
            halves.length ? h('tr', { class: 'pp-halves' }, h('th', { class: 'pp-corner' }), h('th', { class: 'pp-ad' }), ...halves.map((x, i) => h('th', null, i === 0 || x !== halves[i - 1] ? (x === 'am' ? 'a.m.' : 'p.m.') : ''))) : null,
          ),
          h('tbody', null, ...lines),
        ),
      ),
    );
  };

  const timeCell = (cell: PosterCell | undefined, k: 'arr' | 'dep') => {
    if (!cell) return h('span', { class: 'pp-none' }, '..');
    if (cell.pass) return k === 'dep' ? h('span', { class: 'pp-pass', title: 'Passes without stopping' }, '—') : '';
    const v = k === 'arr' ? cell.arr : cell.dep;
    if (v === null) return (k === 'arr' && cell.first) || (k === 'dep' && cell.last) ? '' : h('span', { class: 'pp-none' }, k === 'arr' && !cell.last ? '' : '..');
    return posterTime(v, tt).text;
  };
  const seqCell = (cell: PosterCell | undefined) => {
    if (!cell) return h('span', { class: 'pp-none' }, '..');
    if (cell.pass) return h('span', { class: 'pp-pass', title: 'Passes without stopping' }, '—');
    return h('span', { class: 'pp-stop' }, cell.first ? 'dep.' : cell.last ? 'arr.' : 'calls');
  };

  const key = [
    used.has('express_passenger') ? h('li', null, h('strong', null, 'E'), ' Express') : null,
    passenger.some((t) => t.cols.some((c) => [...c.cells.values()].some((x) => x.pass))) ? h('li', null, h('strong', null, '—'), ' Passes without stopping') : null,
    h('li', null, h('strong', null, '..'), ' Does not call'),
    !timed ? h('li', null, h('strong', null, 'No.'), ' Trains run in this order, each when the one before has finished, not to the clock.') : null,
    elapsed ? h('li', null, 'Times are hours and minutes after the start of the session.') : null,
    tt.timing === 'session' && !elapsed && tt.speed > 1 ? h('li', null, `Times are by the session clock, which runs ${tt.speed} times faster than real time.`) : null,
  ];

  const nothing = !passenger.length && !other.length;
  const otherTable = other.length
    ? h(
        'section',
        { class: 'pp-table small pp-list' },
        h(
          'div',
          { class: 'pp-scroll' },
          h(
            'table',
            null,
            h('thead', null, h('tr', { class: 'pp-heads' }, h('th', { scope: 'col' }, timed ? 'Dep.' : 'No.'), h('th', { scope: 'col' }, 'Train'), h('th', { scope: 'col', class: 'pp-l' }, 'From'), h('th', { scope: 'col', class: 'pp-l' }, 'To'), timed ? h('th', { scope: 'col' }, 'Arr.') : null)),
            h(
              'tbody',
              null,
              ...other.map(({ e, order }) =>
                h(
                  'tr',
                  { class: 'pp-line' },
                  h('td', { class: 'pp-t' }, timed ? posterTime(e.dep, tt).text : String(order)),
                  h('td', { class: 'pp-train' }, lamps ? lampDiagram(era, e.trainTypeId, 'pp-lamps') : null, h('strong', null, e.headcode || findTrain(tt, e.trainId)?.name || ''), ' ', h('em', null, trainTypeName(st, e.trainTypeId))),
                  h('td', { class: 'pp-l' }, layout.places.find((p) => p.id === e.from.placeId)?.name ?? ''),
                  h('td', { class: 'pp-l' }, layout.places.find((p) => p.id === e.to.placeId)?.name ?? ''),
                  timed ? h('td', { class: 'pp-t' }, posterTime(e.arr, tt).text) : null,
                ),
              ),
            ),
          ),
        ),
      )
    : null;
  const poster = h(
    'article',
    { class: 'tt-poster tt-print-area', 'aria-label': `${tt.name} poster` },
    h(
      'div',
      { class: 'pp-border' },
      h('p', { class: 'pp-company' }, companyName(layout)),
      h('div', { class: 'pp-rule', 'aria-hidden': 'true' }, h('span', null, '✦')),
      h('h2', { class: 'pp-title' }, timed ? 'Time Table' : 'Order of Working'),
      h('p', { class: 'pp-of' }, 'of'),
      h('p', { class: 'pp-title2' }, passenger.length ? 'Passenger Trains' : 'Trains'),
      h('p', { class: 'pp-valid' }, [tt.validity, tt.name].filter(Boolean).join(' · ')),
      h('div', { class: 'pp-rule thin', 'aria-hidden': 'true' }),
      nothing ? h('p', { class: 'pp-empty' }, 'No trains run between places yet. Add Run moves on the Moves tab.') : null,
      ...passenger.map((t) => table(t, false)),
      other.length ? h('h3', { class: 'pp-section' }, passenger.length ? 'Goods and other trains' : 'Goods and other trains', h('small', null, ' (not for passengers)')) : null,
      otherTable,
      nothing ? null : h('ul', { class: 'plain pp-key' }, ...key),
      nothing ? null : lampKey,
      tt.notes ? h('p', { class: 'pp-notes' }, tt.notes) : null,
      h('div', { class: 'pp-rule thin', 'aria-hidden': 'true' }),
      h('p', { class: 'pp-order' }, 'By Order'),
      h('p', { class: 'pp-date' }, `${layout.name}, ${today()}`),
      h('p', { class: 'pp-imprint' }, 'Printed by the Signal Box Simulator'),
    ),
  );
  const counts = `${plural(passenger.reduce((n, t) => n + t.cols.length, 0), 'passenger train')}, ${plural(other.length, 'other train')}. Shunts and moves on and off the layout are on the train cards.`;
  fitPosterForPrint(ctx, poster);
  const shelf = h(
    'div',
    { class: 'config-shelf tt-print-shelf' },
    printTools(
      ...posterPrintTools(() => {
        const help = shelf.querySelector('.tt-print-note');
        if (help) help.replaceWith(printNote());
      }),
      h('p', { class: 'shelf-help' }, counts),
    ),
    printNote(),
    h('div', { class: 'tt-paper-wrap' }, poster),
  );
  return shelf;
}

/*
 * Printing the poster to fill the paper (for exhibition props): the poster is made exactly the size
 * of the chosen sheet, with its paper colour running to the edges ("to the edge", no page margins)
 * or inside a 10 mm white margin. Its contents are then scaled as large as they will go: the
 * content is laid out at the width that, once scaled, fills the sheet's width, and the scale is the
 * largest at which it also fits the height — so both the width and the height are used. The
 * double-ruled border stays inside a 7 mm safe area, as printers cannot print to the very edge.
 */
export type PaperId = 'a5' | 'a4' | 'a3' | 'letter' | 'tabloid';
export const PAPERS: Array<{ id: PaperId; name: string; w: number; h: number; css: string }> = [
  { id: 'a5', name: 'A5', w: 148, h: 210, css: 'A5' },
  { id: 'a4', name: 'A4', w: 210, h: 297, css: 'A4' },
  { id: 'a3', name: 'A3', w: 297, h: 420, css: 'A3' },
  { id: 'letter', name: 'US Letter', w: 215.9, h: 279.4, css: 'letter' },
  { id: 'tabloid', name: 'US Tabloid (11 × 17 in)', w: 279.4, h: 431.8, css: '279.4mm 431.8mm' },
];
type Edge = 'bleed' | 'margin';
const PREFS_KEY = 'signal-box-simulator-poster-print';
const prefs: { paper: PaperId; edge: Edge } = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { paper: PAPERS.some((x) => x.id === v.paper) ? v.paper : 'a4', edge: v.edge === 'margin' ? 'margin' : 'bleed' };
  } catch {
    return { paper: 'a4' as PaperId, edge: 'bleed' as Edge };
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* not saved: only a convenience */
  }
};
const MM = 96 / 25.4;

/** The @page rule for the poster: the chosen sheet, with no margins when the paper colour runs to the edge. */
function setPageStyle(on: boolean): void {
  let st = document.getElementById('tt-page-style');
  if (!on) return st?.remove();
  const paper = PAPERS.find((x) => x.id === prefs.paper)!;
  if (!st) {
    st = h('style', { id: 'tt-page-style' });
    document.head.append(st);
  }
  st.textContent = `@page { size: ${paper.css} portrait; margin: ${prefs.edge === 'bleed' ? '0' : '10mm'}; }`;
}

function posterPrintTools(redraw: () => void): HTMLElement[] {
  const sel = (id: string, label: string, opts: Array<[string, string]>, value: string, set: (v: string) => void) =>
    h(
      'div',
      { class: 'field tt-card-filter' },
      h('label', { for: id }, label),
      h(
        'select',
        {
          id,
          on: {
            change: (e: Event) => {
              set((e.target as HTMLSelectElement).value);
              savePrefs();
              setPageStyle(true);
              redraw();
            },
          },
        },
        ...opts.map(([v, l]) => option(v, l, v === value)),
      ),
    );
  return [
    sel('pp_paper', 'Paper', PAPERS.map((x) => [x.id, x.name]), prefs.paper, (v) => (prefs.paper = v as PaperId)),
    sel('pp_edge', 'Edges', [['bleed', 'Paper colour to the edge'], ['margin', 'White 10 mm margin']], prefs.edge, (v) => (prefs.edge = v as Edge)),
  ];
}

function fitPosterForPrint(ctx: Ctx, poster: HTMLElement): void {
  const border = poster.querySelector<HTMLElement>('.pp-border')!;
  const before = () => {
    if (!poster.isConnected) return;
    const paper = PAPERS.find((x) => x.id === prefs.paper)!;
    const margin = prefs.edge === 'bleed' ? 0 : 10;
    // The sheet less any margin, less half a millimetre so rounding never spills on to a second page.
    const W = (paper.w - 2 * margin) * MM;
    const H = (paper.h - 2 * margin - 0.5) * MM;
    const pad = (prefs.edge === 'bleed' ? 7 : 3) * MM;
    const aw = W - 2 * pad;
    const ah = H - 2 * pad;
    poster.classList.add('pp-fitting');
    Object.assign(poster.style, { width: `${W}px`, height: `${H}px`, maxWidth: 'none', padding: `${pad}px`, boxShadow: 'none', overflow: 'hidden', borderRadius: '0' });
    // Natural height of the contents laid out at width w (unscaled).
    const heightAt = (w: number) => {
      border.style.zoom = '1';
      border.style.width = `${w}px`;
      border.style.minHeight = '0';
      return border.getBoundingClientRect().height;
    };
    // The largest scale z at which the contents, laid out at aw / z, are no taller than ah / z.
    let lo = 0.3;
    let hi = 3;
    for (let i = 0; i < 24; i++) {
      const z = (lo + hi) / 2;
      if (heightAt(aw / z) * z <= ah) lo = z;
      else hi = z;
    }
    const z = lo;
    border.style.width = `${aw / z}px`;
    border.style.minHeight = `${ah / z}px`;
    border.style.zoom = String(z);
  };
  const after = () => {
    poster.classList.remove('pp-fitting');
    poster.removeAttribute('style');
    border.removeAttribute('style');
  };
  setPageStyle(true);
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);
  ctx.onLeave(() => {
    setPageStyle(false);
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
  });
}

// ====================================================================== train cards

let cardFilter = '';

export function cardsView(ctx: Ctx, layout: Layout, tt: Timetable): HTMLElement {
  const st = ctx.store.state;
  const w = walkTimetable(st, layout, tt);
  const set = activeCodeSet(st);
  if (cardFilter && !findTrain(tt, cardFilter)) cardFilter = '';
  const timed = isTimed(tt);
  const steps = w.steps.filter((s) => !cardFilter || s.entry.trainId === cardFilter);
  const noOf = (e: TimetableEntry) => {
    const s = w.steps.find((x) => x.entry.id === e.id)!;
    return timed ? `${s.index + 1}` : `${s.step}`;
  };
  const brief = (e: TimetableEntry) => {
    if (e.kind === 'enter') return `comes on at ${refText(st, e.to)}`;
    if (e.kind === 'leave') return `leaves the layout`;
    if (e.kind === 'note') return 'note';
    return `${trainTypeName(st, e.trainTypeId).toLowerCase()} to ${refText(st, e.to.placeId ? e.to : e.from)}`;
  };
  const era = eraOf(layout);
  const lamps = usesLamps(era);
  const lampRow = (trainTypeId: string): HTMLElement | null => {
    const d = lampDiagram(era, trainTypeId, 'tc-lamps');
    return d ? h('span', { class: 'tc-lamp-row' }, d, h('span', null, d.getAttribute('aria-label')!.replace(/^Class (\w) headcode: /, 'Class $1: '))) : null;
  };
  const card = (s: (typeof steps)[number]) => {
    const e = s.entry;
    const train = findTrain(tt, e.trainId);
    const loco = trainLoco(st, train);
    const mine = train ? tt.entries.filter((x) => x.trainId === train.id) : [];
    const k = mine.indexOf(e);
    const before = k > 0 ? mine[k - 1] : undefined;
    const after = k >= 0 && k < mine.length - 1 ? mine[k + 1] : undefined;
    const code = e.kind === 'run' ? set.trainCodes[e.trainTypeId]?.code : undefined;
    const row = (label: string, value: string | HTMLElement | null) => (value ? h('div', { class: 'tc-row' }, h('dt', null, label), h('dd', null, value)) : null);
    const kindStamp = e.kind === 'run' ? 'Run' : e.kind === 'shunt' ? (e.runRound ? 'Run round' : 'Shunt') : e.kind === 'enter' ? 'On' : e.kind === 'leave' ? 'Off' : 'Note';
    return h(
      'article',
      { class: `tt-card kind-${e.kind}${s.issues.some((i) => i.level === 'error') ? ' has-error' : ''}`, 'aria-label': `Card ${noOf(e)}` },
      h(
        'header',
        { class: 'tc-head' },
        h('span', { class: 'tc-no' }, h('small', null, 'No.'), noOf(e)),
        timed && e.dep !== null ? h('span', { class: 'tc-time' }, fmtTime(e.dep, tt)) : null,
        h('span', { class: 'tc-stamp', 'aria-hidden': 'true' }, kindStamp),
        h('span', { class: 'tc-hc' }, e.headcode || ''),
      ),
      h(
        'dl',
        { class: 'tc-body' },
        e.kind === 'note' ? row('Note', e.notes || '—') : null,
        train ? row('Train', train.name + (train.consist ? ` · ${train.consist}` : '')) : null,
        e.kind !== 'note' ? row('Loco', loco ? `${locoFullName(loco)}${loco.dccAddress ? ` · DCC ${loco.dccAddress}` : ''}` : train ? `Any ${trainTypeName(st, train.anyWorking).toLowerCase()} loco` : '—') : null,
        e.kind !== 'note' ? row(e.kind === 'run' ? 'Runs as' : 'Working', `${trainTypeName(st, e.trainTypeId)}${code ? ` · bell ${code}` : ''}`) : null,
        e.kind !== 'note' && lamps ? row('Lamps', lampRow(e.trainTypeId)) : null,
        e.kind === 'run' || e.kind === 'shunt' || e.kind === 'leave' ? row('From', refText(st, e.from)) : null,
        e.kind === 'run' || e.kind === 'enter' || (e.kind === 'shunt' && e.to.placeId && !e.runRound) ? row(e.kind === 'enter' ? 'Comes on at' : 'To', refText(st, e.to)) : null,
        e.kind === 'shunt' && e.runRound ? row('Run round', 'Uncouple, run round the train and couple up at the other end') : null,
        e.kind === 'shunt' && e.vehicles ? row('Moves with', `${e.vehicles} (leave the rest)`) : null,
        e.calls.length ? row('Calls', e.calls.map((c) => `${refText(st, c)} (${c.stop ? 'stops' : 'passes'})`).join('; ')) : null,
        timed && e.arr !== null ? row('Arrives', fmtTime(e.arr, tt)) : null,
        e.kind !== 'note' && e.notes ? row('Notes', e.notes) : null,
      ),
      h(
        'footer',
        { class: 'tc-foot' },
        !timed && e.withPrevious ? h('p', null, 'Given out with the card before it.') : null,
        before ? h('p', null, `Before: No. ${noOf(before)}, ${brief(before)}.`) : train ? h('p', null, 'First move of this train.') : null,
        after ? h('p', null, `Then: No. ${noOf(after)}, ${brief(after)}.`) : train ? h('p', null, 'Last move of this train.') : null,
        s.issues.length ? h('p', { class: 'tc-issue' }, `To check: ${s.issues.map((i) => i.text).join(' ')}`) : null,
      ),
    );
  };
  const filter = h(
    'div',
    { class: 'field tt-card-filter' },
    h('label', { for: 'tc_filter' }, 'Cards for'),
    h(
      'select',
      {
        id: 'tc_filter',
        on: {
          change: (ev: Event) => {
            cardFilter = (ev.target as HTMLSelectElement).value;
            const shelf = (ev.target as HTMLElement).closest('.tt-print-shelf');
            shelf?.replaceWith(cardsView(ctx, layout, tt));
            window.setTimeout(() => document.getElementById('tc_filter')?.focus(), 0);
          },
        },
      },
      option('', `Every move (${plural(tt.entries.length, 'card')})`, !cardFilter),
      ...tt.trains.map((t) => option(t.id, `${t.name} only`, t.id === cardFilter)),
    ),
  );
  return h(
    'div',
    { class: 'config-shelf tt-print-shelf' },
    printTools(filter, h('p', { class: 'shelf-help' }, timed ? 'One card per move, in time order.' : 'One card per move, in the order of working. Hand each out when the one before it has finished.')),
    steps.length ? h('div', { class: 'tt-cards tt-print-area' }, ...steps.map(card)) : h('p', { class: 'shelf-help' }, 'No moves yet.'),
  );
}

