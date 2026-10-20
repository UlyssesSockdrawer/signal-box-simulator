import { jobText } from '../../core/duties';
import { activeLayout } from '../../core/layouts';
import { BUSYNESS, defaultGeneratorOptions, defaultLocos, generateTimetable, MIX_LEVELS, MIX_PRESETS, newSeed, onLayout, type MixCategory } from '../../core/timetableGenerator';
import { checkTimetableName, findTimetable, fmtTime, issuesSummary, MAX_ENTRIES, MAX_SPEED, MAX_TIMETABLES, parseTime, TIMINGS, timetablesOf, walkTimetable } from '../../core/timetables';
import type { AppState, GeneratorOptions, Layout, Loco, Timetable, TimetableTiming } from '../../core/types';
import { locoFullName, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { confirmDialog, h, option, toast } from '../dom';

/*
 * GENERATE A TIMETABLE (v0.3.26): the generator's options, a preview that updates as you change
 * them (how many trains and moves, whether it checks out, the trains it would run), and Generate,
 * which saves it as an ordinary timetable to edit, print and run. Opened from the list of timetables,
 * or from a generated timetable's Settings ("Generate again", with its options filled in).
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const genRoute = (forId?: string) => (forId ? `ttgen/${forId}` : 'ttgen');

/** Kept while you move about the app, so the options are as you left them. */
const ui: { layoutId: string; forId: string; name: string; opts: GeneratorOptions | null } = { layoutId: '', forId: '', name: '', opts: null };

function nextHour(): number {
  const d = new Date();
  return ((d.getHours() + 1) % 24) * 60;
}

function uniqueName(layout: Layout, base: string): string {
  const taken = new Set(timetablesOf(layout).map((t) => t.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

function jobsText(st: AppState, l: Loco, layout: Layout): string {
  if (!l.jobs?.length) return `no jobs: works as ${trainTypeName(st, l.working.trainTypeId).toLowerCase()}`;
  return l.jobs
    .map((j) => {
      const places = j.placeIds.map((id) => layout.places.find((p) => p.id === id)?.shortName || layout.places.find((p) => p.id === id)?.name).filter(Boolean);
      return `${jobText(st, j).toLowerCase()}${places.length ? ` (${places.join(', ')})` : ''}`;
    })
    .join('; ');
}

export function generateScreen(ctx: Ctx, forId: string): Screen {
  const st = ctx.store.state;
  const found = forId ? findTimetable(st, forId) : null;
  const layout = found?.layout ?? activeLayout(st);
  if (!ctx.returnTo) ctx.returnTo = found ? { route: `tt/${found.tt.id}/settings`, label: found.tt.name } : { route: 'timetables', label: 'timetables' };
  if (!layout) {
    return { title: 'Generate a timetable', el: h('main', { class: 'page' }, topBar(ctx, 'Generate a timetable'), h('p', { class: 'muted' }, 'Timetables belong to a layout. Create a layout first.')) };
  }
  // Fresh options when coming to it for another layout or timetable.
  if (!ui.opts || ui.layoutId !== layout.id || ui.forId !== forId) {
    ui.layoutId = layout.id;
    ui.forId = forId;
    ui.opts = found?.tt.generated ? structuredClone(found.tt.generated) : defaultGeneratorOptions('sequence');
    ui.name = found ? found.tt.name : uniqueName(layout, 'Generated timetable');
  }
  const shelf = h('div', { class: 'config-shelf tt-gen-shelf' });
  const draw = () => {
    const y = window.scrollY;
    shelf.replaceChildren(...content(ctx, layout, found?.tt ?? null, draw));
    window.scrollTo(0, y);
  };
  shelf.append(...content(ctx, layout, found?.tt ?? null, draw));
  return {
    title: 'Generate a timetable',
    el: h(
      'main',
      { class: 'page config-page tt-page tt-gen-page' },
      topBar(ctx, found ? `Generate ${found.tt.name} again` : 'Generate a timetable'),
      h('p', { class: 'muted tt-sub' }, `${layout.name} · made from its places, signal boxes and the locos’ timetable duties (set in the roster)`),
      shelf,
    ),
  };
}

function content(ctx: Ctx, layout: Layout, tt: Timetable | null, draw: () => void): HTMLElement[] {
  const st = ctx.store.state;
  const o = ui.opts!;
  const set = (fn: (x: GeneratorOptions) => void) => {
    fn(o);
    draw();
  };

  // ---- how it runs
  const timingSeg = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', id: 'tg_timing_l' }, 'How it runs'),
    h(
      'div',
      { class: 'seg tt-timing-seg', role: 'group', 'aria-labelledby': 'tg_timing_l' },
      ...TIMINGS.map((x) =>
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            'aria-pressed': String(o.timing === x.timing),
            on: {
              click: () =>
                set((g) => {
                  if (g.timing === x.timing) return;
                  const wasSeq = g.timing === 'sequence';
                  g.timing = x.timing as TimetableTiming;
                  if (wasSeq !== (g.timing === 'sequence')) g.length = g.timing === 'sequence' ? 24 : 120;
                  if (g.timing === 'clock') g.startAt = nextHour();
                }),
            },
          },
          x.name,
        ),
      ),
    ),
    h('small', { class: 'help' }, TIMINGS.find((x) => x.timing === o.timing)!.help),
  );
  const startField =
    o.timing === 'sequence'
      ? null
      : h(
          'div',
          { class: 'field' },
          h('label', { for: 'tg_start' }, o.timing === 'clock' ? 'First train' : 'Clock starts at'),
          h('input', {
            id: 'tg_start',
            type: 'text',
            value: fmtTime(o.startAt, { timing: 'clock', elapsed: false }),
            maxlength: 5,
            on: {
              change: (e: Event) => {
                const v = parseTime((e.target as HTMLInputElement).value);
                if (v === null || Number.isNaN(v)) {
                  toast('A time such as 09:00 or 1500.');
                  draw();
                } else set((g) => (g.startAt = v));
              },
            },
          }),
          h('small', { class: 'help' }, o.timing === 'clock' ? 'Real time: by the system clock.' : 'The time shown when the session starts.'),
        );
  const speedField =
    o.timing === 'session'
      ? h(
          'div',
          { class: 'field' },
          h('label', { for: 'tg_speed' }, 'Clock speed'),
          h('select', { id: 'tg_speed', on: { change: (e: Event) => set((g) => (g.speed = Number((e.target as HTMLSelectElement).value))) } }, ...Array.from({ length: MAX_SPEED }, (_, i) => i + 1).map((n) => option(String(n), n === 1 ? 'Real time (×1)' : `Fast clock ×${n}`, n === o.speed))),
        )
      : null;
  const seq = o.timing === 'sequence';
  const lengthField = h(
    'div',
    { class: 'field' },
    h('label', { for: 'tg_len' }, seq ? 'How many moves' : 'How long (minutes of timetable)'),
    h(
      'select',
      { id: 'tg_len', on: { change: (e: Event) => set((g) => (g.length = Number((e.target as HTMLSelectElement).value))) } },
      ...(seq ? [8, 12, 16, 24, 32, 48, 64, 96] : [30, 60, 90, 120, 180, 240, 360, 480]).map((n) => option(String(n), seq ? `About ${n} moves` : n < 60 ? `${n} minutes` : `${n / 60} hour${n === 60 ? '' : 's'}${o.timing === 'clock' ? ` (to ${fmtTime(o.startAt + n, { timing: 'clock', elapsed: false })})` : ''}`, n === o.length)),
    ),
    h('small', { class: 'help' }, seq ? 'Trains finish what they are doing and locos go home after the last one, so it may come out a few moves longer.' : 'New trains start within this time; the last ones finish, and locos go home, after it.'),
  );
  const busySeg = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', id: 'tg_busy_l' }, 'How busy'),
    h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'tg_busy_l' }, ...BUSYNESS.map((b) => h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(o.busyness === b.id), on: { click: () => set((g) => (g.busyness = b.id)) } }, b.name))),
    h('small', { class: 'help' }, BUSYNESS.find((b) => b.id === o.busyness)!.help),
  );

  // ---- traffic mix
  const preset = MIX_PRESETS.find((p) => p.mix.passenger === o.mix.passenger && p.mix.goods === o.mix.goods && p.mix.shunting === o.mix.shunting);
  const mixLevel = (cat: MixCategory, label: string) =>
    h(
      'div',
      { class: 'field' },
      h('label', { for: `tg_mix_${cat}` }, label),
      h('select', { id: `tg_mix_${cat}`, on: { change: (e: Event) => set((g) => (g.mix[cat] = Number((e.target as HTMLSelectElement).value))) } }, ...MIX_LEVELS.map((name, i) => option(String(i), name, i === o.mix[cat]))),
    );
  const mixCase = h(
    'article',
    { class: 'config-case', 'aria-labelledby': 'tg_mix_plate' },
    h('span', { class: 'plate', id: 'tg_mix_plate' }, 'Traffic mix'),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'tg_preset' }, 'Mix'),
      h(
        'select',
        {
          id: 'tg_preset',
          on: {
            change: (e: Event) => {
              const p = MIX_PRESETS.find((x) => x.id === (e.target as HTMLSelectElement).value);
              if (p) set((g) => (g.mix = { ...p.mix }));
            },
          },
        },
        ...MIX_PRESETS.map((p) => option(p.id, p.name, p === preset)),
        preset ? null : option('custom', 'My own mix', true),
      ),
      h('small', { class: 'help' }, 'On top of how often each loco gets each of its duties (in the roster).'),
    ),
    h('div', { class: 'form-grid tight' }, mixLevel('passenger', 'Passenger trains'), mixLevel('goods', 'Goods trains'), mixLevel('shunting', 'Pilots and shunting')),
  );

  // ---- locos taking part
  const defaults = new Set(defaultLocos(st, layout).map((l) => l.id));
  const chosen = new Set(o.locoIds.length ? o.locoIds : defaults);
  const candidates = st.roster.filter((l) => onLayout(st, layout, l) || l.location.kind === 'offLayout' || l.jobs?.some((j) => j.placeIds.some((id) => layout.places.some((p) => p.id === id))));
  const locoCase = h(
    'article',
    { class: 'config-case', 'aria-labelledby': 'tg_loco_plate' },
    h('span', { class: 'plate', id: 'tg_loco_plate' }, 'Locos taking part'),
    h('p', { class: 'help' }, `Ticked: the locos on ${layout.name} with timetable duties. A loco off the layout comes on through a fiddle yard when it is first needed.`),
    candidates.length
      ? h(
          'ul',
          { class: 'plain tg-locos' },
          ...candidates.map((l) => {
            const id = `tg_loco_${l.id}`;
            return h(
              'li',
              null,
              h(
                'label',
                { class: 'check', for: id },
                h('input', {
                  id,
                  type: 'checkbox',
                  checked: chosen.has(l.id),
                  on: {
                    change: (e: Event) =>
                      set((g) => {
                        const next = new Set(chosen);
                        if ((e.target as HTMLInputElement).checked) next.add(l.id);
                        else next.delete(l.id);
                        const same = next.size === defaults.size && [...next].every((x) => defaults.has(x));
                        g.locoIds = same ? [] : [...next];
                      }),
                  },
                }),
                h('span', null, h('strong', null, locoFullName(l)), h('small', { class: 'help' }, ` · ${onLayout(st, layout, l) ? '' : 'off the layout · '}${jobsText(st, l, layout)}`)),
              ),
            );
          }),
        )
      : h('p', { class: 'muted' }, 'No locos in the roster yet.'),
    h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', on: { click: () => ctx.goFrom('roster', { route: genRoute(ui.forId), label: 'Generate a timetable' }) } }, 'Set duties in the roster')),
  );

  // ---- the preview
  const res = generateTimetable(st, layout, o, ui.name);
  const w = walkTimetable(st, layout, res.tt);
  const timed = o.timing !== 'sequence';
  const preview = h(
    'article',
    { class: 'config-case tg-preview', 'aria-labelledby': 'tg_prev_plate', 'aria-live': 'polite' },
    h('span', { class: 'plate', id: 'tg_prev_plate' }, 'What it makes'),
    h('p', null, h('strong', null, `${plural(res.tt.trains.length, 'train')}, ${plural(res.tt.entries.length, 'move')}`), timed && res.tt.entries.length ? ` · ${fmtTime(res.tt.entries[0].dep, res.tt)} to ${fmtTime(Math.max(...res.tt.entries.map((e) => e.arr ?? e.dep ?? 0)), res.tt)}` : '', ` · checks: ${issuesSummary(w)}`),
    ...res.notes.map((n) => h('p', { class: 'config-warn' }, n)),
    res.tt.entries.length > MAX_ENTRIES ? h('p', { class: 'config-warn' }, `That is more than the ${MAX_ENTRIES} moves a timetable can hold: make it shorter.`) : null,
    res.tt.trains.length
      ? h(
          'ol',
          { class: 'plain tg-trains' },
          ...res.tt.trains.slice(0, 14).map((t) => {
            const first = res.tt.entries.find((e) => e.trainId === t.id);
            const loco = st.roster.find((l) => l.id === t.locoId);
            return h('li', null, timed && first ? h('span', { class: 'tg-when' }, fmtTime(first.dep, res.tt)) : null, h('strong', null, t.name), ` · ${loco ? locoFullName(loco) : 'any loco'}`, t.notes ? h('small', { class: 'help' }, ` · ${t.notes}`) : null);
          }),
          res.tt.trains.length > 14 ? h('li', { class: 'muted' }, `…and ${res.tt.trains.length - 14} more.`) : null,
        )
      : null,
  );

  // ---- name, pattern, generate
  const nameErr = checkTimetableName(layout, ui.name, tt?.id ?? null);
  const nameInput = h('input', { id: 'tg_name', type: 'text', value: ui.name, maxlength: 60, on: { change: (e: Event) => ((ui.name = (e.target as HTMLInputElement).value.trim()), draw()) } });
  const full = !tt && timetablesOf(layout).length >= MAX_TIMETABLES;
  const save = (replace: boolean) => {
    const name = ui.name.trim();
    const err = checkTimetableName(layout, name, replace ? (tt?.id ?? null) : null);
    if (err) return toast(err);
    if (!res.tt.entries.length) return toast('Nothing to save: no moves could be made.');
    if (res.tt.entries.length > MAX_ENTRIES) return toast(`More than ${MAX_ENTRIES} moves: make it shorter.`);
    let id = '';
    ctx.store.update((a) => {
      const l = a.layouts.find((x) => x.id === layout.id);
      if (!l) return;
      const made = generateTimetable(a, l, o, name).tt;
      const old = replace && tt ? timetablesOf(l).find((x) => x.id === tt.id) : undefined;
      if (old) {
        Object.assign(old, { ...made, id: old.id, validity: old.validity === 'Generated' || !old.validity ? made.validity : old.validity });
        id = old.id;
      } else {
        timetablesOf(l).push(made);
        id = made.id;
      }
    });
    if (!id) return;
    ui.opts = null;
    toast(`${name} ${replace ? 'generated again' : 'made'}: ${plural(res.tt.entries.length, 'move')}. Edit it as you like.`);
    ctx.returnTo = null;
    ctx.go(`tt/${id}`);
  };
  const actions = h(
    'article',
    { class: 'config-case' },
    h('span', { class: 'plate' }, 'Generate'),
    h(
      'div',
      { class: 'form-grid tight' },
      h('div', { class: 'field' }, h('label', { for: 'tg_name' }, 'Name'), nameInput, nameErr && !(tt && ui.name.trim() === tt.name) ? h('small', { class: 'field-error' }, nameErr) : null),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Pattern'),
        h('div', { class: 'row' }, h('span', { class: 'tg-seed' }, `No. ${o.seed}`), h('button', { class: 'btn small', type: 'button', id: 'tg_new', on: { click: () => set((g) => (g.seed = newSeed())) } }, 'Try another')),
        h('small', { class: 'help' }, 'The same pattern with the same options makes the same timetable.'),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      tt
        ? h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              id: 'tg_replace',
              on: {
                click: () =>
                  confirmDialog({
                    title: `Replace ${tt.name}?`,
                    body: [`Its ${plural(tt.entries.length, 'move')} are replaced by the ${plural(res.tt.entries.length, 'move')} shown here. Changes you made to it by hand are lost.`],
                    confirmLabel: 'Replace',
                    onDone: (ok) => ok && save(true),
                  }),
              },
            },
            `Replace ${tt.name}`,
          )
        : null,
      h('button', { class: tt ? 'btn' : 'btn primary', type: 'button', id: 'tg_make', disabled: full, on: { click: () => (tt && ui.name.trim() === tt.name ? toast('Give the new timetable a name of its own.') : save(false)) } }, tt ? 'Save as a new timetable' : 'Generate timetable'),
    ),
    full ? h('p', { class: 'help' }, `${layout.name} has the most timetables allowed (${MAX_TIMETABLES}).`) : null,
  );

  const runCase = h(
    'article',
    { class: 'config-case', 'aria-labelledby': 'tg_run_plate' },
    h('span', { class: 'plate', id: 'tg_run_plate' }, 'Timing'),
    timingSeg,
    h('div', { class: 'form-grid tight' }, startField, speedField, lengthField),
    busySeg,
  );
  return [runCase, mixCase, locoCase, preview, actions, h('p', { class: 'shelf-help' }, `Or let it make the timetable up as you go: open one of ${layout.name}'s signal boxes and choose Endless in its Timetable panel.`)];
}
