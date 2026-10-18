import { REGULATION_SIGNALS } from '../../core/bellcodes';
import { beatDots } from '../../core/simulatedNeighbour';
import { activeCodeSet, topBar, type Ctx, type Screen } from '../app';
import { h } from '../dom';

/** The bell code tables, used on the reference page and in the signal box side panel. */
export function codeReference(ctx: Ctx, compact = false): HTMLElement {
  const st = ctx.store.state;
  const cs = activeCodeSet(st);
  const play = (code: string) =>
    h('button', { class: 'btn small', type: 'button', 'aria-label': `Play ${code}`, on: { click: () => { ctx.bell.unlock(); ctx.bell.ring(code); } } }, '▶ Play');

  const trainRows = st.trainTypes
    .filter((t) => cs.trainCodes[t.id])
    .map((t) => {
      const e = cs.trainCodes[t.id];
      return h(
        'tr',
        null,
        h('td', { class: 'code-cell' }, h('strong', null, e.code), h('div', { class: 'dots', 'aria-hidden': 'true' }, beatDots(e.code))),
        h('td', null, e.classLabel),
        h('td', null, h('strong', null, t.name), h('div', { class: 'muted small' }, t.description, e.note && !t.description.toLowerCase().includes(e.note.toLowerCase()) ? ` (${e.note})` : '')),
        h('td', null, play(e.code)),
      );
    });

  const sigRows = REGULATION_SIGNALS.filter((r) => cs.signals[r.id]).map((r) => {
    const code = cs.signals[r.id];
    return h(
      'tr',
      null,
      h('td', { class: 'code-cell' }, h('strong', null, code), h('div', { class: 'dots', 'aria-hidden': 'true' }, beatDots(code))),
      h('td', null, r.needsCallAttention ? 'Yes' : h('strong', null, 'No')),
      h('td', null, h('strong', null, r.name), h('div', { class: 'muted small' }, r.description)),
      h('td', null, play(code)),
    );
  });

  return h(
      'div',
      { class: `code-ref${compact ? ' compact' : ''}` },
      h(
        'section',
        { class: 'panel prose' },
        h('p', null, h('strong', null, cs.name), '. ', cs.notes),
        h('p', null, 'A code such as ', h('strong', null, '3-1'), ' means three beats, a pause, then one beat. Every code you receive is acknowledged by repeating it exactly. If a signaller cannot agree to what is asked (for example the line is not clear), they simply do not reply.'),
        compact ? null : h('p', null, 'Choose the code set in ', h('a', { href: '#settings' }, 'Settings'), '.'),
      ),
      h('h2', null, 'Is line clear (train descriptions)'),
      h('p', { class: 'muted' }, 'Sent after call attention has been acknowledged, to offer a train. Repeating it back accepts the train.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'codes' }, h('thead', null, h('tr', null, h('th', null, 'Code'), h('th', null, 'Class'), h('th', null, 'Train'), h('th', null, ''))), h('tbody', null, ...trainRows))),
      h('h2', null, 'Other bell signals'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'codes' }, h('thead', null, h('tr', null, h('th', null, 'Code'), h('th', null, 'Call attention first?'), h('th', null, 'Meaning'), h('th', null, ''))), h('tbody', null, ...sigRows))),
      h('p', { class: 'muted small' }, 'Sources: BR Regulations for Train Signalling (1960) as summarised by signalbox.org and Wikipedia; later codes from the Rule Book list at davros.org. Codes varied by region and railway; check against your own.'),
    );
}

export function helpScreen(ctx: Ctx): Screen {
  return {
    title: 'Bell codes',
    el: h('main', { class: 'page' }, topBar(ctx, 'Bell code reference'), codeReference(ctx)),
  };
}
