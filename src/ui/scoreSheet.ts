import { CATEGORY_NAMES, pointsText, type ScoreCategory, type Scorecard, type ScoreSummary } from '../core/score';
import { h, replace } from './dom';

/*
 * The score sheet: the signaller's total, how it is made up, and the log of
 * every point gained or lost. Shown from the Score button on the box's top
 * ribbon (live: it updates as trains are worked) and when the box is closed
 * (the final score for the session).
 */

const hhmmss = (t: number) => {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

const duration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** A friendly verdict for visitors having a go. */
export function verdict(s: ScoreSummary): string {
  const gained = s.byCategory.working.gained + s.byCategory.procedure.gained + s.byCategory.safety.gained;
  const lost = s.byCategory.working.lost + s.byCategory.procedure.lost + s.byCategory.safety.lost;
  if (s.safetyBreaches > 0) return 'A safety rule was broken. Report to the District Inspector!';
  if (s.trainsIn + s.trainsOut === 0) return 'No trains worked yet.';
  const accuracy = gained / Math.max(1, gained + lost);
  if (accuracy >= 0.97) return 'First-class signaller: worked by the book.';
  if (accuracy >= 0.85) return 'A capable signaller.';
  if (accuracy >= 0.65) return 'Signaller in training: a few slips.';
  return 'Back to the rule book.';
}

export interface ScoreSheetOptions {
  boxName: string;
  /** The final score of a closed box (no "start a new score"). */
  final: boolean;
}

export function showScoreSheet(card: Scorecard, opts: ScoreSheetOptions): void {
  const dlg = h('dialog', { class: 'config-case score-sheet', 'aria-labelledby': 'ss_title' });
  const body = h('div', { class: 'ss-body' });
  let armed = false;

  const render = () => {
    const s = card.summary();
    const cat = (c: ScoreCategory) => {
      const x = s.byCategory[c];
      const net = x.gained - x.lost;
      return h(
        'div',
        { class: `ss-cat ss-${c}` },
        h('span', { class: 'ss-cat-name' }, CATEGORY_NAMES[c]),
        h('span', { class: 'ss-cat-count' }, `${x.count} ${x.count === 1 ? 'entry' : 'entries'}`),
        h('strong', { class: `ss-pts ${net < 0 ? 'neg' : net > 0 ? 'pos' : ''}` }, pointsText(net)),
      );
    };
    const stat = (n: number | string, label: string) => h('div', { class: 'ss-stat' }, h('strong', null, String(n)), h('span', null, label));
    const rows = card.entries.map((e) =>
      h(
        'tr',
        { class: `ss-row ss-${e.category}` },
        h('td', { class: 'ss-time' }, hhmmss(e.t)),
        h('td', { class: 'ss-line' }, e.line),
        h('td', null, e.label, e.detail ? h('span', { class: 'ss-detail' }, ` · ${e.detail}`) : null),
        h('td', { class: `ss-pts ${e.points < 0 ? 'neg' : 'pos'}` }, pointsText(e.points)),
      ),
    );
    replace(
      body,
      h(
        'div',
        { class: 'ss-total' },
        h('span', { class: 'ss-total-label' }, opts.final ? 'Final score' : 'Score so far'),
        h('strong', { class: 'ss-total-num' }, String(s.total)),
        h('span', { class: 'ss-verdict' }, verdict(s)),
      ),
      h(
        'div',
        { class: 'ss-stats' },
        stat(s.trainsIn, 'trains received'),
        stat(s.trainsOut, 'trains sent'),
        stat(s.cleanWorkings, 'clean workings'),
        stat(s.safetyBreaches, s.safetyBreaches === 1 ? 'safety breach' : 'safety breaches'),
        stat(duration((opts.final ? s.lastAt : Date.now()) - s.startedAt), 'on duty'),
      ),
      h('div', { class: 'ss-cats' }, cat('working'), cat('procedure'), cat('safety')),
      h('h3', { class: 'ss-log-head' }, 'How the score was made'),
      rows.length
        ? h(
            'div',
            { class: 'ss-log-wrap' },
            h(
              'table',
              { class: 'ss-log' },
              h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Line'), h('th', null, 'What happened'), h('th', { class: 'ss-pts' }, 'Points'))),
              h('tbody', null, ...rows),
              h('tfoot', null, h('tr', null, h('td', { colspan: '3' }, 'Total'), h('td', { class: 'ss-pts' }, String(s.total)))),
            ),
          )
        : h('p', { class: 'ss-empty' }, 'Nothing scored yet. Points are given as you open the box and work trains in and out.'),
    );
  };

  // Hold the page still behind the sheet, so a swipe on a phone scrolls the sheet, not the box
  // (overflow: hidden alone is not enough for iOS Safari: pin the body where it is instead).
  const scrollY = window.scrollY;
  const bodyStyle = document.body.getAttribute('style');
  document.documentElement.classList.add('modal-open');
  Object.assign(document.body.style, { position: 'fixed', top: `-${scrollY}px`, left: '0', right: '0' });
  let off = () => {};
  const close = () => {
    off();
    dlg.close();
    dlg.remove();
    document.documentElement.classList.remove('modal-open');
    if (bodyStyle === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', bodyStyle);
    window.scrollTo(0, scrollY);
  };
  const newScore = h('button', {
    class: 'btn danger',
    type: 'button',
    hidden: opts.final,
    on: {
      click: () => {
        if (!armed) {
          armed = true;
          newScore.classList.add('armed');
          newScore.textContent = 'Press again to start a new score';
          return;
        }
        card.reset();
        armed = false;
        newScore.classList.remove('armed');
        newScore.textContent = 'Start a new score';
      },
    },
  }, 'Start a new score');

  dlg.append(
    h('div', { class: 'ss-head' }, h('h2', { class: 'plate', id: 'ss_title' }, `${opts.boxName} · score sheet`), h('span', { class: 'ss-when' }, opts.final ? 'Box closed' : 'Live: updates as you work trains')),
    body,
    h(
      'div',
      { class: 'row end' },
      newScore,
      h('button', { class: 'btn', type: 'button', on: { click: () => window.print() } }, 'Print'),
      h('button', { class: 'btn primary', type: 'button', on: { click: close } }, 'Close'),
    ),
  );
  render();
  if (!opts.final) off = card.onChange(() => render());
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const ev = e as MouseEvent;
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close();
  });
  document.body.append(dlg);
  dlg.showModal();
  (dlg.querySelector('.btn.primary') as HTMLButtonElement | null)?.focus();
}
