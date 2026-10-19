import type { AppState, Settings, ThemeId } from '../../core/types';
import { THEMES } from '../theme';
import { topBar, type Ctx, type Screen } from '../app';
import { confirmDialog, field, h, option, toast } from '../dom';
import { disposeAllBoxRuntimes } from '../boxRuntime';
import { resetPlacesUi } from './places';
import { resetRosterUi } from './roster';
import { resetTimetablesUi } from './timetables';
import { resetTrackPlanUi } from './trackPlan';

export function settingsScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const s = st.settings;
  const set = (fn: (x: Settings, all: AppState) => void) => ctx.store.update((a) => fn(a.settings, a));

  const num = (id: string, label: string, value: number, apply: (v: number) => void, opts: { min?: number; max?: number; step?: number; help?: string } = {}) =>
    field(
      label,
      h('input', {
        id,
        type: 'number',
        value,
        min: opts.min,
        max: opts.max,
        step: opts.step ?? 1,
        on: {
          change: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) set(() => apply(v));
          },
        },
      }),
      opts.help,
    );
  const check = (id: string, label: string, value: boolean, apply: (v: boolean) => void) =>
    h('label', { class: 'check', for: id }, h('input', { id, type: 'checkbox', checked: value, on: { change: (e: Event) => set(() => apply((e.target as HTMLInputElement).checked)) } }), label);

  // ---------------------------------------------------------------- signalling
  const signalling = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Signalling'),
    field(
      'Mode',
      h('select', { id: 'set_strict', on: { change: (e: Event) => set((x) => (x.strictness = (e.target as HTMLSelectElement).value as Settings['strictness'])) } },
        option('learner', 'Learner: shows the next step and explains mistakes', s.strictness === 'learner'),
        option('strict', 'Strict: no prompts, behaves like a real box', s.strictness === 'strict'),
      ),
    ),
    field(
      'Bell code set',
      h('select', { id: 'set_cs', on: { change: (e: Event) => set((x) => (x.codeSetId = (e.target as HTMLSelectElement).value)) } }, ...st.codeSets.map((c) => option(c.id, c.name, c.id === s.codeSetId))),
    ),
    check('set_scoring', 'Keep score: points for working trains by the book, points lost for irregularities (for have-a-go sessions)', s.scoring, (v) => (s.scoring = v)),
  );

  // ---------------------------------------------------------------- appearance
  const appearance = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Appearance'),
    field(
      'Theme',
      h('select', { id: 'set_theme', on: { change: (e: Event) => set((x) => (x.theme = (e.target as HTMLSelectElement).value as ThemeId)) } },
        ...THEMES.map((t) => option(t.id, t.name, t.id === s.theme)),
      ),
      THEMES.find((t) => t.id === s.theme)?.description,
    ),
    h('div', { class: 'theme-swatches', 'aria-hidden': 'true' },
      ...THEMES.map((t) => h('button', { type: 'button', tabindex: '-1', class: `swatch${t.id === s.theme ? ' on' : ''}`, title: t.name, style: `--sw1: ${t.swatch[0]}; --sw2: ${t.swatch[1]}; --sw3: ${t.swatch[2]}`, on: { click: () => set((x) => (x.theme = t.id)) } }, h('span', null), h('span', null), h('span', null))),
    ),
  );

  // ---------------------------------------------------------------- sound
  const fileIn = h('input', { id: 'set_wav', type: 'file', accept: 'audio/*,.wav,.mp3,.ogg' });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    if (f.size > 1_500_000) {
      toast('That file is over 1.5 MB. Please trim it to a single bell strike.');
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      set((x) => (x.bellSoundDataUrl = String(r.result)));
      toast('Bell sound loaded. Press "Test bell" to hear it.');
    };
    r.readAsDataURL(f);
  });
  const sound = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Bells and sound'),
    field('Volume', h('input', { id: 'set_vol', type: 'range', min: 0, max: 1, step: 0.05, value: s.volume, on: { change: (e: Event) => set((x) => (x.volume = Number((e.target as HTMLInputElement).value))) } })),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', on: { click: () => { ctx.bell.unlock(); ctx.bell.ring('3-1'); } } }, 'Test bell (3-1)'),
    ),
    field('Replace the bell sound', fileIn, s.bellSoundDataUrl ? 'Your own bell sound is loaded. Each beat plays the file from the start, so use a single strike.' : 'Using the built-in bell recording. Load a WAV or MP3 of a single bell strike to replace it.'),
    s.bellSoundDataUrl ? h('button', { class: 'btn ghost', type: 'button', on: { click: () => set((x) => (x.bellSoundDataUrl = '')) } }, 'Go back to the built-in recording') : null,
    check('set_synth', 'Use a synthesised bell instead of a recording', s.bellSynth, (v) => (s.bellSynth = v)),
    num('set_beat', 'Beat spacing when the bell rings (ms)', s.bellBeatMs, (v) => (s.bellBeatMs = v), { min: 120, max: 800, step: 10 }),
    num('set_gp', 'Pause between groups (ms)', s.bellGroupPauseMs, (v) => (s.bellGroupPauseMs = v), { min: 300, max: 2000, step: 50 }),
    h('div', { class: 'checks' },
      check('set_showtxt', 'Show received codes as text (turn off to rely on your ear)', s.showReceivedCodeText, (v) => (s.showReceivedCodeText = v)),
      check('set_click', 'Click sound when using the tapper', s.tapperClick, (v) => (s.tapperClick = v)),
      check('set_vib', 'Vibrate on each incoming beat (phones)', s.vibrate, (v) => (s.vibrate = v)),
    ),
  );

  // ---------------------------------------------------------------- tapper timing
  const tapper = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Tapper timing'),
    h('p', { class: 'muted small' }, 'Adjust if the tapper misreads your rhythm.'),
    num('set_gg', 'New group after a pause longer than (ms)', s.tap.groupGapMs, (v) => (s.tap.groupGapMs = v), { min: 200, max: 1500, step: 25 }),
    num('set_ce', 'Code ends after silence of (ms)', s.tap.codeEndMs, (v) => (s.tap.codeEndMs = v), { min: 600, max: 4000, step: 50 }),
    num('set_hold', 'Last beat counts as held after (ms)', s.tap.holdMs, (v) => (s.tap.holdMs = v), { min: 400, max: 3000, step: 50 }),
  );

  // ---------------------------------------------------------------- simulated signaller
  const sim = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Simulated signaller'),
    num('set_rmin', 'Reaction time, shortest (ms)', s.responseDelayMs[0], (v) => (s.responseDelayMs = [v, Math.max(v, s.responseDelayMs[1])]), { min: 200, step: 100 }),
    num('set_rmax', 'Reaction time, longest (ms)', s.responseDelayMs[1], (v) => (s.responseDelayMs = [Math.min(v, s.responseDelayMs[0]), v]), { min: 200, step: 100 }),
    num('set_dmin', 'Despatch after line clear, shortest (s)', s.despatchDelayMs[0] / 1000, (v) => (s.despatchDelayMs = [v * 1000, Math.max(v * 1000, s.despatchDelayMs[1])]), { min: 1 }),
    num('set_dmax', 'Despatch after line clear, longest (s)', s.despatchDelayMs[1] / 1000, (v) => (s.despatchDelayMs = [Math.min(v * 1000, s.despatchDelayMs[0]), v * 1000]), { min: 1 }),
    num('set_rep', 'Ring again if no reply after (s)', s.repeatAfterMs / 1000, (v) => (s.repeatAfterMs = v * 1000), { min: 5, max: 120, help: 'For call attention and the other bells. An Is line clear that is not repeated is not rung again: it counts as refused (below).' }),
    h('h3', null, 'Refused trains'),
    num('set_refuse', 'An offer not repeated counts as refused after (s)', s.offerRefusedAfterMs / 1000, (v) => (s.offerRefusedAfterMs = Math.max(3, v) * 1000), { min: 3, max: 120, help: 'To refuse a train, acknowledge the call attention (1) but do not repeat the Is line clear code. The far box holds the train.' }),
    num('set_reoffer', 'Offer a held train again every (s)', s.reofferAfterMs / 1000, (v) => (s.reofferAfterMs = Math.max(5, v) * 1000), { min: 5, max: 900, help: 'A held train is also offered again soon after you send 2-1 (Train out of section) on another line.' }),
    h('div', { class: 'checks' },
      check('set_coincide', 'Offers can coincide: when a train is offered on one line, another line may offer one at about the same time, so you have to regulate (accept the higher class first)', s.coincidingOffers, (v) => (s.coincidingOffers = v)),
    ),
  );

  // ---------------------------------------------------------------- data
  /** Before all the app's data is replaced (reset or import): close running boxes and forget screen state belonging to the old data. */
  const freshStart = () => {
    disposeAllBoxRuntimes();
    resetTrackPlanUi();
    resetPlacesUi();
    resetRosterUi();
    resetTimetablesUi();
  };
  const importText = (text: string, ok: string, bad: string) => {
    try {
      JSON.parse(text);
    } catch {
      toast(bad);
      return;
    }
    freshStart();
    try {
      ctx.store.importJson(text);
      toast(ok);
    } catch {
      toast(bad);
    }
  };
  const downloadBackup = () => {
    const blob = new Blob([ctx.store.exportJson()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'signal-box-simulator-data.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const exportArea = h('textarea', { id: 'data_export', rows: 6, readonly: true, class: 'mono' });
  const importArea = h('textarea', { id: 'data_import', rows: 6, class: 'mono', placeholder: 'Paste saved data here, then press Import.' });
  const importFile = h('input', { id: 'data_file', type: 'file', accept: '.json,application/json' });
  importFile.addEventListener('change', () => {
    const f = importFile.files?.[0];
    if (!f) return;
    f.text().then((t) => importText(t, 'Data imported.', 'That file is not valid saved data.'));
  });
  const data = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Your data'),
    h('p', { class: 'muted small' }, 'Everything is saved in this browser on this device. Export it to back it up or move it between your PC and phone.'),
    h(
      'div',
      { class: 'row' },
      h('button', {
        class: 'btn',
        type: 'button',
        on: {
          click: () => {
            const json = ctx.store.exportJson();
            exportArea.value = json;
            navigator.clipboard?.writeText(json).then(
              () => toast('Copied to the clipboard.'),
              () => { exportArea.select(); toast('Select the text below and copy it.'); },
            ) ?? exportArea.select();
          },
        },
      }, 'Copy data'),
      h('button', {
        class: 'btn',
        type: 'button',
        on: {
          click: () => {
            downloadBackup();
            exportArea.value = ctx.store.exportJson();
          },
        },
      }, 'Download file'),
    ),
    exportArea,
    field('Import from file', importFile),
    importArea,
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', on: { click: () => importText(importArea.value, 'Data imported.', 'That is not valid saved data.') } }, 'Import pasted data'),
    ),
  );

  // ---------------------------------------------------------------- reset to defaults
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const confirmReset = () => {
    const now = ctx.store.state;
    confirmDialog({
      title: 'Reset to defaults?',
      body: [
        'This erases everything saved in this browser on this device, and cannot be undone:',
        h(
          'ul',
          { class: 'reset-list' },
          h('li', null, `${plural(now.layouts.length, 'layout')}, with ${now.layouts.length === 1 ? 'its track plan' : 'their track plans'} and places`),
          h('li', null, `${plural(now.boxes.length, 'signal box', 'signal boxes')} and ${now.boxes.length === 1 ? 'its' : 'their'} connected boxes`),
          h('li', null, `${plural(now.roster.length, 'locomotive')} in the roster`),
          h('li', null, 'All settings: theme, bell sound and timings, simulated signaller'),
          h('li', null, 'Any box that is running is closed, and its score is lost'),
        ),
        'The app then starts again with the data it first came with. Download a backup first if you might want any of it back.',
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', on: { click: () => { downloadBackup(); toast('Backup downloaded.'); } } }, 'Download a backup')),
      ],
      confirmLabel: 'Erase everything and reset',
      onDone: (ok) => {
        if (!ok) return;
        freshStart();
        ctx.store.reset();
        ctx.go('menu');
        toast('Reset: Signal Box Simulator is back to its starting data.');
      },
    });
  };
  const resetPanel = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Reset to defaults'),
    h('p', { class: 'muted small' }, 'Erase all your layouts, signal boxes, places, track plans, locomotives and settings saved in this browser, and start again with the data the app first came with. You will be asked to confirm.'),
    h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'button', id: 'reset_app', on: { click: confirmReset } }, 'Reset to defaults…')),
  );

  return {
    title: 'Settings',
    el: h('main', { class: 'page' }, topBar(ctx, 'Settings'), h('div', { class: 'settings-grid' }, signalling, appearance, sound, tapper, sim, data, resetPanel)),
  };
}
