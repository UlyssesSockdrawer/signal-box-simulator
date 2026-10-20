import { findLayout } from '../../core/layouts';
import { applyStockPositions, fmtTime, isTimed, stockPositions, timetablesOf, timingInfo } from '../../core/timetables';
import type { Positioning, RunItem, RunOperator, TimetableRunner, PastMode } from '../../core/timetableRunner';
import type { BoxDef, Layout, Timetable } from '../../core/types';
import { locoFullName, type Ctx } from '../app';
import { confirmButton, confirmDialog, h, option, toast } from '../dom';
import { getRunner, peekRunner } from '../timetableRuntime';

/*
 * Running a timetable from a signal box (v0.3.25): the TIMETABLE STRIP under the Next step bar
 * (the clock, moves waiting for you with their Done buttons, what is under way and what is next),
 * and the TIMETABLE tab of the box's side panel (choosing and starting a timetable, pausing,
 * releasing, skipping and marking moves done, switching to another timetable).
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Remembered for the app session: which timetable the panel offers and who is the fiddle yard operator. */
const choice: { ttId: string; operator: RunOperator } = { ttId: '', operator: 'simulated' };

function layoutOf(ctx: Ctx, box: BoxDef): Layout | undefined {
  const b = ctx.store.state.boxes.find((x) => x.id === box.id) ?? box;
  return findLayout(ctx.store.state, b.layoutId);
}

/** "09:23" on the timetable clock, or "Step 3 of 9" for an operations sequence. */
export function runClock(r: TimetableRunner): string {
  const tt = r.tt;
  if (!tt) return '';
  if (!isTimed(tt)) {
    const steps = [...new Set(r.items.filter((x) => !x.positioning && !x.finishing).map((x) => x.step))].sort((a, b) => a - b);
    const open = r.items.filter((x) => !x.positioning && !x.finishing && (x.state === 'waiting' || x.state === 'active')).map((x) => x.step);
    const cur = open.length ? Math.min(...open) : steps.length;
    return `Step ${Math.min(cur, steps.length)} of ${steps.length}`;
  }
  const now = r.clockNow();
  if (now === null) return '';
  return tt.timing === 'session' && tt.elapsed ? `+${Math.floor(now / 60)}:${String(Math.floor(now % 60)).padStart(2, '0')}` : fmtTime(Math.floor(now), { timing: 'clock', elapsed: false });
}

function when(r: TimetableRunner, it: RunItem): string {
  if (it.positioning) return 'First';
  if (it.finishing) return 'Finishing';
  if (r.tt && isTimed(r.tt)) return fmtTime(it.entry.dep, r.tt) || '—';
  return `Step ${it.step}`;
}

const STATE_NAME: Record<RunItem['state'], string> = { waiting: 'Waiting', active: 'Under way', done: 'Done', skipped: 'Skipped' };

// ====================================================================== strip

export function timetableStrip(ctx: Ctx, box: BoxDef, openPanel: () => void): { el: HTMLElement; render(): void } {
  const el = h('section', { class: 'tt-strip', 'aria-label': 'Timetable', hidden: true });
  let key = '';
  const render = () => {
    const r = peekRunner(layoutOf(ctx, box)?.id);
    if (!r?.tt || !r.started) {
      el.hidden = true;
      key = '';
      return;
    }
    const cards = r.items.filter((x) => x.state === 'active' && x.card);
    const under = r.items.filter((x) => x.state === 'active' && !x.card);
    const next = r.items.find((x) => x.state === 'waiting');
    const waitBox = r.waitingForOpen();
    const k = JSON.stringify([r.tt.id, runClock(r), r.paused, r.finished, waitBox, cards.map((x) => [x.id, x.card?.text]), under.map((x) => [x.id, x.status]), next?.id, next?.status]);
    el.hidden = false;
    if (k === key) return;
    key = k;
    const parts: Array<HTMLElement | null> = [
      h(
        'div',
        { class: 'tts-head' },
        h('span', { class: 'tts-tag' }, 'Timetable'),
        h('strong', { class: 'tts-name' }, r.tt.name),
        h('span', { class: 'tts-clock' }, runClock(r)),
        r.paused ? h('span', { class: 'tts-badge' }, 'Paused') : null,
        r.finished ? h('span', { class: 'tts-badge done' }, 'Finished') : null,
        waitBox ? h('span', { class: 'tts-badge' }, 'Waiting') : null,
        h('button', { class: 'btn small', type: 'button', 'aria-controls': 'side-panel', on: { click: openPanel } }, 'Timetable ▸'),
      ),
      waitBox ? h('p', { class: 'tts-wait' }, `Starts once ${waitBox} is open on every line: call attention (1), then 5-5-5 to each box. Nothing is offered and the clock waits until then.`) : null,
      cards.length
        ? h(
            'ul',
            { class: 'plain tts-cards' },
            ...cards.map((it) =>
              h(
                'li',
                { class: `tts-card ${it.card!.kind}` },
                h('span', { class: 'tts-when' }, when(r, it)),
                h('span', { class: 'tts-text' }, it.card!.text),
                h('button', { class: 'btn primary small', type: 'button', on: { click: () => r.done(it.id) } }, it.card!.kind === 'note' ? 'OK' : 'Done'),
              ),
            ),
          )
        : null,
      under.length || next
        ? h(
            'p',
            { class: 'tts-line' },
            ...under.slice(0, 3).map((it) => h('span', { class: 'tts-under' }, `${it.entry.headcode || it.train?.name || 'Move'}: ${it.status}`)),
            next ? h('span', { class: 'tts-next' }, `Next: ${when(r, next)} ${r.describe(next)}${next.status ? ` – ${next.status}` : ''}`) : null,
          )
        : null,
    ];
    el.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  };
  return { el, render };
}

// ====================================================================== side panel

export function timetablePanel(ctx: Ctx, box: BoxDef): HTMLElement {
  const st = ctx.store.state;
  const layout = layoutOf(ctx, box);
  if (!layout) return h('div', { class: 'ttp' }, h('p', { class: 'muted' }, `${box.name} is not on a layout. Timetables belong to a layout: put the box on one first.`));
  const list = timetablesOf(layout);
  const r = getRunner(ctx, layout.id);
  const back = { route: `box/${box.id}`, label: `${box.name} box` };
  if (!list.length) {
    return h(
      'div',
      { class: 'ttp' },
      h('p', null, `${layout.name} has no timetables yet.`),
      h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.goFrom('timetables', back) } }, 'Make a timetable'),
    );
  }
  if (!choice.ttId || !list.some((t) => t.id === choice.ttId)) choice.ttId = r.tt && list.some((t) => t.id === r.tt!.id) ? r.tt.id : list[0].id;
  const ttSelect = (id: string, exclude?: string) =>
    h(
      'select',
      { id, on: { change: (e: Event) => (choice.ttId = (e.target as HTMLSelectElement).value) } },
      ...list.filter((t) => t.id !== exclude).map((t) => option(t.id, `${t.name} (${timingInfo(t.timing).short.toLowerCase()})`, t.id === choice.ttId)),
    );
  const operatorField = () =>
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'ttp_op' }, 'Fiddle yard operator'),
      h(
        'select',
        {
          id: 'ttp_op',
          on: {
            change: (e: Event) => {
              choice.operator = (e.target as HTMLSelectElement).value as RunOperator;
              if (r.started) r.operator = choice.operator;
            },
          },
        },
        option('simulated', 'Simulated: trains come and go by themselves', (r.started ? r.operator : choice.operator) === 'simulated'),
        option('me', 'Me: I move them and press Done', (r.started ? r.operator : choice.operator) === 'me'),
      ),
      h('small', { class: 'help' }, 'For moves no box you work signals: trains entering or leaving the layout, and moves between places only the simulated boxes work.'),
    );

  if (!r.tt || !r.started) {
    if (choice.ttId && choice.ttId !== '' && list.every((t) => t.id !== choice.ttId)) choice.ttId = list[0].id;
    return h(
      'div',
      { class: 'ttp' },
      h('h2', { class: 'ttp-title' }, 'Run a timetable'),
      h('p', { class: 'muted small' }, `Trains are offered to you, due departures are chosen for you, and shunts and fiddle yard moves come up as cards, as the timetable says. ${layout.name}'s boxes take part while they are open.`),
      h('div', { class: 'field' }, h('label', { for: 'ttp_tt' }, 'Timetable'), ttSelect('ttp_tt')),
      operatorField(),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', on: { click: () => startDialog(ctx, layout, r, list.find((t) => t.id === choice.ttId)!) } }, 'Start…'),
        h('button', { class: 'btn', type: 'button', on: { click: () => ctx.goFrom(`tt/${choice.ttId}`, back) } }, 'Edit it'),
      ),
    );
  }

  const tt = r.tt;
  const others = list.filter((t) => t.id !== tt.id);
  if (others.length && (!choice.ttId || choice.ttId === tt.id)) choice.ttId = others[0].id;
  const itemRow = (it: RunItem) =>
    h(
      'li',
      { class: `ttp-item ${it.state}${it.card ? ' needs' : ''}` },
      h(
        'div',
        { class: 'ttp-item-head' },
        h('span', { class: 'ttp-when' }, when(r, it)),
        h('span', { class: `ttp-state ${it.state}` }, STATE_NAME[it.state]),
        it.late ? h('span', { class: 'ttp-late' }, `${it.late} min late`) : null,
      ),
      h('p', { class: 'ttp-what' }, r.describe(it)),
      it.status && it.state !== 'done' ? h('p', { class: 'ttp-status' }, it.card ? it.card.text : it.status) : null,
      it.state === 'waiting' || it.state === 'active'
        ? h(
            'div',
            { class: 'row ttp-btns' },
            it.card ? h('button', { class: 'btn primary small', type: 'button', on: { click: () => r.done(it.id) } }, it.card.kind === 'note' ? 'OK' : 'Done') : null,
            it.state === 'waiting' || /Cancelled/.test(it.status)
              ? h('button', { class: 'btn small', type: 'button', on: { click: () => { const err = r.releaseNow(it.id); if (err) toast(err); } } }, it.state === 'waiting' ? 'Release now' : 'Offer it again')
              : null,
            h('button', { class: 'btn small', type: 'button', on: { click: () => { const err = r.markDone(it.id); if (err) toast(err); } } }, 'Mark done'),
            confirmButton('Skip', 'Skip it?', () => {
              const err = r.skip(it.id);
              if (err) toast(err);
            }, 'btn ghost small'),
          )
        : null,
    );
  const open = r.items.filter((x) => x.state === 'waiting' || x.state === 'active');
  const closed = r.items.filter((x) => x.state === 'done' || x.state === 'skipped');
  return h(
    'div',
    { class: 'ttp' },
    h(
      'div',
      { class: 'ttp-run' },
      h('div', { class: 'ttp-run-head' }, h('h2', { class: 'ttp-title' }, tt.name), h('span', { class: 'tts-clock' }, runClock(r)), r.paused ? h('span', { class: 'tts-badge' }, 'Paused') : null, r.finished ? h('span', { class: 'tts-badge done' }, 'Finished') : null),
      r.waitingForOpen() ? h('p', { class: 'config-warn' }, `Waiting for ${r.waitingForOpen()} to be opened on every line (call attention, then 5-5-5 to each box). The timetable begins then.`) : null,
      h('p', { class: 'muted small' }, `${timingInfo(tt.timing).name}${tt.timing === 'session' && tt.speed > 1 ? `, fast clock ×${tt.speed}` : ''} · ${plural(closed.length, 'move')} done of ${r.items.length}`),
      h(
        'div',
        { class: 'row ttp-btns' },
        h('button', { class: 'btn primary small', type: 'button', disabled: !r.items.some((x) => x.state === 'waiting'), on: { click: () => { const err = r.releaseNow(); if (err) toast(err); } } }, 'Release next now'),
        h('button', { class: 'btn small', type: 'button', on: { click: () => r.pause(!r.paused) } }, r.paused ? 'Resume' : 'Pause'),
        confirmButton('Stop', 'Stop the timetable?', () => {
          r.stop();
          toast(`${tt.name} stopped. Trains already offered or under way carry on as ordinary trains.`);
        }, 'btn danger small'),
      ),
      operatorField(),
      others.length
        ? h(
            'div',
            { class: 'field ttp-switch' },
            h('label', { for: 'ttp_sw' }, 'Switch to'),
            h('div', { class: 'row' }, ttSelect('ttp_sw', tt.id), h('button', { class: 'btn small', type: 'button', on: { click: () => switchDialog(ctx, layout, r, list.find((t) => t.id === choice.ttId)!) } }, 'Switch…')),
          )
        : null,
    ),
    open.length ? h('ol', { class: 'plain ttp-items' }, ...open.map(itemRow)) : h('p', { class: 'muted' }, r.finished ? 'Every move has run.' : 'Nothing waiting.'),
    closed.length
      ? h('details', { class: 'ttp-closed' }, h('summary', null, `Done and skipped (${closed.length})`), h('ol', { class: 'plain ttp-items' }, ...closed.map(itemRow)))
      : null,
    h('details', { class: 'ttp-log' }, h('summary', null, 'Timetable log'), h('ol', { class: 'plain' }, ...r.log.slice(-40).reverse().map((l) => h('li', null, h('time', null, clockOf(l.t)), ' ', l.text)))),
  );
}

const clockOf = (t: number) => {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

// ====================================================================== start and switch

function radios(name: string, opts: Array<[string, string]>, value: string, set: (v: string) => void): HTMLElement {
  return h(
    'div',
    { class: 'ttp-radios', role: 'radiogroup' },
    ...opts.map(([v, label]) => {
      const id = `${name}_${v}`;
      return h('label', { class: 'check', for: id }, h('input', { type: 'radio', id, name, value: v, checked: v === value, on: { change: () => set(v) } }), h('span', null, label));
    }),
  );
}

function startDialog(ctx: Ctx, layout: Layout, r: TimetableRunner, tt: Timetable): void {
  const st = ctx.store.state;
  const past = r.pastCount(tt);
  const wrong = stockPositions(st, layout, tt).filter((p) => p.loco && !p.there);
  let pastMode: PastMode = 'skip';
  let stock: 'positioning' | 'put' | 'asis' = 'positioning';
  const body: Array<string | HTMLElement> = [`${timingInfo(tt.timing).name}${tt.timing === 'session' ? `, clock starting at ${tt.elapsed ? '+0:00' : fmtTime(tt.startAt, { timing: 'clock', elapsed: false })}${tt.speed > 1 ? ` (×${tt.speed})` : ''}` : ''}. Fiddle yard operator: ${choice.operator === 'me' ? 'you' : 'simulated'}.`];
  body.push(`It begins once the boxes you have open on ${layout.name} are open with every neighbour (5-5-5): nothing is offered${tt.timing === 'session' ? ' and the clock does not start' : ''} until then.`);
  if (past) {
    body.push(
      h('p', { class: 'ttp-q' }, `${plural(past, 'move')} ${past === 1 ? 'has' : 'have'} a time that has already passed.`),
      radios('ttp_past', [['skip', `Skip ${past === 1 ? 'it' : 'them'} and join the timetable now`], ['late', `Run ${past === 1 ? 'it' : 'them'} now, late`]], pastMode, (v) => (pastMode = v as PastMode)),
    );
  }
  if (wrong.length) {
    body.push(
      h('p', { class: 'ttp-q' }, `${plural(wrong.length, 'loco')} ${wrong.length === 1 ? 'is' : 'are'} not where the timetable starts ${wrong.length === 1 ? 'it' : 'them'}:`),
      h('ul', null, ...wrong.map((p) => h('li', null, `${locoFullName(p.loco)}: starts at ${p.startText}`))),
      radios(
        'ttp_stock',
        [
          ['positioning', 'Add positioning moves first (light engine and fiddle yard moves to bring them there)'],
          ['put', 'Put them there now in the app (I have moved them on the layout)'],
          ['asis', 'Start with them where they are'],
        ],
        stock,
        (v) => (stock = v as typeof stock),
      ),
    );
  }
  confirmDialog({
    title: `Start ${tt.name}?`,
    body,
    confirmLabel: 'Start',
    confirmClass: 'btn primary',
    onDone: (ok) => {
      if (!ok) return;
      let positioning: Positioning[] = [];
      if (wrong.length && stock === 'put') ctx.store.update((a) => {
        const l = a.layouts.find((x) => x.id === layout.id);
        const t = l ? timetablesOf(l).find((x) => x.id === tt.id) : undefined;
        if (l && t) applyStockPositions(a, l, t);
      });
      if (wrong.length && stock === 'positioning') positioning = r.positioningFor(tt);
      r.load(tt);
      r.start({ operator: choice.operator, past: pastMode, positioning });
      toast(`${tt.name} started.`);
    },
  });
}

function switchDialog(ctx: Ctx, layout: Layout, r: TimetableRunner, tt: Timetable): void {
  const finishing = r.items.filter((x) => r.underWay(x));
  const pos = r.positioningFor(tt);
  const past = r.pastCount(tt);
  let pastMode: PastMode = 'skip';
  let usePos = true;
  const body: Array<string | HTMLElement> = [
    finishing.length ? `${plural(finishing.length, 'move')} under way will finish first:` : 'No moves are under way, so it starts straight away.',
    finishing.length ? h('ul', null, ...finishing.map((it) => h('li', null, r.describe(it)))) : '',
    `Moves of ${r.tt?.name ?? 'the current timetable'} not yet started are dropped.`,
  ].filter(Boolean);
  if (pos.length) {
    body.push(
      h('p', { class: 'ttp-q' }, `${tt.name} starts ${plural(pos.length, 'loco')} somewhere else:`),
      h('ul', null, ...pos.map((p) => h('li', null, p.text))),
      radios('ttp_pos', [['yes', 'Add these positioning moves first'], ['no', 'Start with them where they are']], 'yes', (v) => (usePos = v === 'yes')),
    );
  }
  if (past) {
    body.push(
      h('p', { class: 'ttp-q' }, `${plural(past, 'move')} of ${tt.name} ${past === 1 ? 'has' : 'have'} a time that has already passed.`),
      radios('ttp_past2', [['skip', 'Skip them'], ['late', 'Run them now, late']], pastMode, (v) => (pastMode = v as PastMode)),
    );
  }
  confirmDialog({
    title: `Switch to ${tt.name}?`,
    body,
    confirmLabel: 'Switch',
    confirmClass: 'btn primary',
    onDone: (ok) => {
      if (!ok) return;
      r.switchTo(tt, { positioning: usePos ? pos : [], past: pastMode, operator: choice.operator });
      toast(`Switched to ${tt.name}.`);
    },
  });
}
