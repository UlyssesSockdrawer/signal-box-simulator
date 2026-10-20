import { activeLayout, findLayout } from '../../core/layouts';
import { placesWorkedBy } from '../../core/places';
import { newId } from '../../core/store';
import { applyRole, dutiesFor, dutyInfo, dutyOf, dutyTypes, isRailcar, rolesFor, type RoleInfo } from '../../core/duties';
import { blankJob } from '../../core/timetables';
import type { AppState, DutyId, Location, Loco, LocoJob } from '../../core/types';
import { activeCodeSet, locationText, locoName, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { confirmButton, confirmDialog, field, h, option } from '../dom';

const WEIGHT: Record<number, string> = { 1: 'sometimes', 2: 'often', 3: 'mostly' };

const POWER_TYPES = ['Steam (tender)', 'Steam (tank)', 'Diesel', 'DMU', 'Electric', 'Other'];

let openId: string | null = null;

/** Changing to or from a DMU changes what it can work: a railcar works railcar services only. */
function setPower(l: Loco, power: string): void {
  const was = l.powerType === 'DMU';
  l.powerType = power;
  const now = power === 'DMU';
  if (now && !was) {
    if (l.jobs?.length) l.jobs = l.jobs.some((j) => j.duty === 'railcar') ? l.jobs.filter((j) => j.duty === 'railcar') : [blankJob('railcar')];
    if (l.working.trainTypeId !== 'ecs') l.working.trainTypeId = 'railcar';
  } else if (was && !now) {
    if (l.jobs) l.jobs = l.jobs.filter((j) => j.duty !== 'railcar');
    if (l.working.trainTypeId === 'railcar') l.working.trainTypeId = 'ordinary_passenger';
  }
}

/** Encode a Location as a select value. */
/** Forget which roster entry was open, e.g. when all data is reset. */
export function resetRosterUi(): void {
  openId = null;
}

export function locValue(l: Location): string {
  if (l.kind === 'place') return `pl|${l.placeId}|${l.roadId}`;
  if (l.kind === 'atBox') return `bx|${l.boxId}`;
  return 'off';
}

/**
 * Every place a loco can be put, grouped by layout (the active layout first): each road of each
 * place (or the place itself when it has no roads), and boxes that work no place. The roster is
 * shared by every layout, so a loco can be moved to another layout's places.
 */
export function locOptions(state: AppState, current: Location): Array<HTMLOptionElement | HTMLOptGroupElement> {
  const cur = locValue(current);
  const groupFor = (layoutId: string, label: string) => {
    const opts: HTMLOptionElement[] = [];
    for (const p of findLayout(state, layoutId)?.places ?? []) {
      const loose = `pl|${p.id}|`;
      // A train somewhere in a place with roads (no road chosen) keeps that choice.
      if (!p.roads.length || cur === loose) opts.push(option(loose, p.roads.length ? `${p.name} (no road)` : p.name, cur === loose));
      for (const r of p.roads) opts.push(option(`pl|${p.id}|${r.id}`, `${p.name} · ${r.name}`, cur === `pl|${p.id}|${r.id}`));
    }
    for (const b of state.boxes.filter((x) => (layoutId ? x.layoutId === layoutId : !findLayout(state, x.layoutId)))) {
      const v = `bx|${b.id}`;
      if (!placesWorkedBy(state, b.id).length || cur === v) opts.push(option(v, `At ${b.name} box`, cur === v));
    }
    return { label, opts };
  };
  const active = activeLayout(state);
  const groups = [
    ...(active ? [groupFor(active.id, active.name)] : []),
    ...state.layouts.filter((l) => l.id !== active?.id).map((l) => groupFor(l.id, l.name)),
    groupFor('', 'Not on a layout'),
  ].filter((g) => g.opts.length);
  const off = option('off', 'Off layout / shed', cur === 'off');
  if (groups.length <= 1) return [...(groups[0]?.opts ?? []), off];
  return [...groups.map((g) => h('optgroup', { label: g.label }, ...g.opts)), off];
}

export function parseLoc(v: string): Location {
  const [k, a, b] = v.split('|');
  if (k === 'pl') return { kind: 'place', placeId: a, roadId: b ?? '' };
  if (k === 'bx') return { kind: 'atBox', boxId: a };
  return { kind: 'offLayout' };
}

export function rosterScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const set = activeCodeSet(st);
  const upd = (id: string, fn: (l: Loco) => void) =>
    ctx.store.update((s) => {
      const l = s.roster.find((x) => x.id === id);
      if (l) fn(l);
    });

  const text = (l: Loco, key: 'number' | 'name' | 'locoClass' | 'dccAddress' | 'notes', label: string, help?: string) =>
    field(
      label,
      h('input', { id: `r_${l.id}_${key}`, type: key === 'dccAddress' ? 'text' : 'text', inputmode: key === 'dccAddress' ? 'numeric' : undefined, value: l[key], on: { change: (e: Event) => upd(l.id, (x) => (x[key] = (e.target as HTMLInputElement).value.trim())) } }),
      help,
    );

  const card = (l: Loco) => {
    const editor = h(
      'details',
      {
        class: 'loco',
        open: openId === l.id,
        on: { toggle: (e: Event) => { if ((e.target as HTMLDetailsElement).open) openId = l.id; else if (openId === l.id) openId = null; } },
      },
      h(
        'summary',
        null,
        h('span', { class: 'loco-num' }, l.number || '—'),
        // Number, then name (if it has one) and class, the same way for every loco.
        l.name ? h('span', { class: 'loco-name' }, `“${l.name}”`) : null,
        h('span', { class: 'loco-class' }, l.locoClass || (l.name ? '' : '(no class given)')),
        h('span', { class: 'loco-meta' }, `DCC ${l.dccAddress || '—'} · ${trainTypeName(st, l.working.trainTypeId)} · ${locationText(st, l)}${l.jobs?.length ? ` · ${[...new Set(l.jobs.map((j) => dutyInfo(j.duty).name.toLowerCase()))].join(', ')}` : ''}`),
      ),
      h(
        'div',
        { class: 'form-grid' },
        text(l, 'number', 'Number'),
        text(l, 'name', 'Name'),
        text(l, 'locoClass', 'Class / type'),
        field('Power', h('select', { id: `r_${l.id}_power`, on: { change: (e: Event) => upd(l.id, (x) => setPower(x, (e.target as HTMLSelectElement).value)) } }, ...POWER_TYPES.map((p) => option(p, p, p === l.powerType)))),
        text(l, 'dccAddress', 'DCC address'),
        field(
          'Working as',
          h('select', { id: `r_${l.id}_tt`, on: { change: (e: Event) => upd(l.id, (x) => (x.working.trainTypeId = (e.target as HTMLSelectElement).value)) } },
            ...st.trainTypes.map((t) => option(t.id, `${t.name}${set.trainCodes[t.id] ? ` (${set.trainCodes[t.id].code})` : ''}`, t.id === l.working.trainTypeId)),
          ),
          'Sets the bell code used when this train is offered.',
        ),
        field('Consist', h('input', { id: `r_${l.id}_consist`, type: 'text', value: l.working.consist, placeholder: 'e.g. 4 coaches', on: { change: (e: Event) => upd(l.id, (x) => (x.working.consist = (e.target as HTMLInputElement).value)) } })),
        field('Headcode', h('input', { id: `r_${l.id}_hc`, type: 'text', value: l.working.headcode, on: { change: (e: Event) => upd(l.id, (x) => (x.working.headcode = (e.target as HTMLInputElement).value)) } })),
        field('Where it is', h('select', { id: `r_${l.id}_loc`, on: { change: (e: Event) => upd(l.id, (x) => (x.location = parseLoc((e.target as HTMLSelectElement).value))) } }, ...locOptions(st, l.location))),
        text(l, 'notes', 'Notes'),
      ),
      jobsSection(l),
      h('div', { class: 'row end' }, confirmButton('Delete locomotive', 'Press again to delete', () => ctx.store.update((s) => (s.roster = s.roster.filter((x) => x.id !== l.id))))),
    );
    return editor;
  };

  // ---------------------------------------------------------------- timetable duties
  const updJob = (locoId: string, jobId: string, fn: (j: LocoJob) => void) =>
    upd(locoId, (x) => {
      const j = x.jobs?.find((y) => y.id === jobId);
      if (j) fn(j);
    });
  const jobsSection = (l: Loco) => {
    const jobs = l.jobs ?? [];
    const railcar = isRailcar(l);
    const duties = dutiesFor(st, l);
    const placeGroups = st.layouts.filter((lay) => lay.places.length);
    const jobRow = (j: LocoJob) => {
      const jid = `r_${l.id}_job_${j.id}`;
      const types = j.duty === 'pilot' ? [] : dutyTypes(st, j.duty);
      const offered = duties.some((d) => d.id === j.duty) ? duties : [dutyInfo(j.duty), ...duties];
      return h(
        'li',
        { class: 'loco-job' },
        h(
          'div',
          { class: 'form-grid' },
          field(
            'Duty',
            h('select', { id: `${jid}_duty`, on: { change: (e: Event) => updJob(l.id, j.id, (x) => ((x.duty = (e.target as HTMLSelectElement).value as DutyId), (x.trainTypeId = ''))) } }, ...offered.map((d) => option(d.id, d.name, d.id === j.duty))),
            dutyInfo(j.duty).help,
          ),
          types.length > 1
            ? field(
                'Runs as',
                h('select', { id: `${jid}_tt`, on: { change: (e: Event) => updJob(l.id, j.id, (x) => (x.trainTypeId = (e.target as HTMLSelectElement).value)) } }, option('', 'Any of them (the generator chooses)', !j.trainTypeId), ...types.map((id) => option(id, `${trainTypeName(st, id)} only`, id === j.trainTypeId))),
              )
            : null,
          field(
            'How often',
            h('select', { id: `${jid}_w`, on: { change: (e: Event) => updJob(l.id, j.id, (x) => (x.weight = Number((e.target as HTMLSelectElement).value) as LocoJob['weight'])) } }, option('1', 'Sometimes', j.weight === 1), option('2', 'Often', j.weight === 2), option('3', 'Mostly', j.weight === 3)),
          ),
        ),
        railcar && j.duty !== 'railcar' ? h('p', { class: 'config-warn' }, 'A railcar only works railcar services: this duty is not used.') : null,
        placeGroups.length
          ? h(
              'fieldset',
              { class: 'loco-job-places' },
              h('legend', null, j.duty === 'pilot' ? 'Where it shunts' : 'Between (none ticked = anywhere)'),
              ...placeGroups.map((lay) =>
                h(
                  'div',
                  { class: 'loco-job-group' },
                  placeGroups.length > 1 ? h('small', { class: 'help' }, lay.name) : null,
                  ...lay.places.map((p) => {
                    const cid = `${jid}_p_${p.id}`;
                    return h(
                      'label',
                      { class: 'check', for: cid },
                      h('input', { id: cid, type: 'checkbox', checked: j.placeIds.includes(p.id), on: { change: (e: Event) => updJob(l.id, j.id, (x) => (x.placeIds = (e.target as HTMLInputElement).checked ? [...new Set([...x.placeIds, p.id])] : x.placeIds.filter((y) => y !== p.id))) } }),
                      h('span', null, p.name),
                    );
                  }),
                ),
              ),
            )
          : null,
        h('div', { class: 'row end' }, h('button', { class: 'btn danger small', type: 'button', on: { click: () => upd(l.id, (x) => (x.jobs = (x.jobs ?? []).filter((y) => y.id !== j.id))) } }, 'Remove duty')),
      );
    };
    const giveRole = (r: RoleInfo) => {
      const go = () => upd(l.id, (x) => applyRole(x, r.id));
      if (!jobs.length) return go();
      confirmDialog({
        title: `Make ${locoName(l)} ${r.name.toLowerCase().startsWith('railcar') ? 'a railcar' : `a ${r.name.toLowerCase()} engine`}?`,
        body: [`Its ${jobs.length === 1 ? 'duty is' : `${jobs.length} duties are`} replaced by: ${r.jobs.map(([d, w]) => `${dutyInfo(d).name.toLowerCase()} (${WEIGHT[w]})`).join(', ')}. Places are left as anywhere: tick them afterwards if you want.`],
        confirmLabel: 'Replace',
        confirmClass: 'btn primary',
        onDone: (ok) => ok && go(),
      });
    };
    const homeOpts = [option('', 'Wherever it is', !l.homePlaceId), ...st.layouts.flatMap((lay) => lay.places.map((p) => option(p.id, st.layouts.length > 1 ? `${lay.name}: ${p.name}` : p.name, p.id === l.homePlaceId)))];
    return h(
      'section',
      { class: 'loco-jobs' },
      h('h3', { class: 'loco-jobs-head' }, 'Timetable duties'),
      h(
        'p',
        { class: 'muted small' },
        railcar
          ? 'A railcar works railcar services, runs empty (not light) when it moves without passengers, and changes ends at a terminus. A train worked by “any loco” goes to a loco with the duty, and the timetable generator uses these duties.'
          : 'The kinds of work this loco is given in timetables. A train worked by “any loco” goes to a loco with the duty, and the timetable generator uses these duties. Any engine can run light, or with a brake van, without a duty for it.',
      ),
      h(
        'div',
        { class: 'row loco-roles' },
        h('span', { class: 'field-label' }, 'Give it a role:'),
        ...rolesFor(l).map((r) => h('button', { class: 'btn small', type: 'button', title: r.help, on: { click: () => giveRole(r) } }, r.name)),
      ),
      jobs.length ? h('ul', { class: 'plain loco-job-list' }, ...jobs.map(jobRow)) : h('p', { class: 'muted small' }, 'No duties yet: it is chosen for “any loco” trains of the kind it is working as now. Give it a role, or add duties one at a time.'),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn small', type: 'button', on: { click: () => upd(l.id, (x) => (x.jobs = [...(x.jobs ?? []), blankJob(railcar ? 'railcar' : (dutyOf(st, x.working.trainTypeId) ?? 'stopping'))])) } }, '+ Add a duty'),
      ),
      field('Home', h('select', { id: `r_${l.id}_home`, on: { change: (e: Event) => upd(l.id, (x) => ((e.target as HTMLSelectElement).value ? (x.homePlaceId = (e.target as HTMLSelectElement).value) : delete x.homePlaceId)) } }, ...homeOpts), 'Where it stables between jobs.'),
    );
  };

  const add = () => {
    const id = newId('loco');
    openId = id;
    ctx.store.update((s) =>
      s.roster.push({
        id,
        number: '',
        name: '',
        locoClass: '',
        powerType: 'Steam (tank)',
        dccAddress: '',
        notes: '',
        working: { trainTypeId: 'ordinary_passenger', consist: '', headcode: '' },
        location: { kind: 'offLayout' },
      }),
    );
    window.setTimeout(() => document.getElementById(`r_${id}_number`)?.focus(), 50);
  };

  const sorted = [...st.roster].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  return {
    title: 'Roster',
    el: h(
      'main',
      { class: 'page' },
      topBar(ctx, 'Locomotive roster', h('button', { class: 'btn primary', type: 'button', on: { click: add } }, '+ Add locomotive')),
      h('p', { class: 'muted' }, 'Each locomotive has a working (the kind of train it is running as), which sets its bell code. Change the working whenever the loco changes job, for example from a passenger train to light engine for the turntable.'),
      sorted.length ? h('div', { class: 'stack' }, ...sorted.map(card)) : h('p', { class: 'empty' }, 'No locomotives yet. Press "Add locomotive" to start your roster.'),
      h('p', { class: 'muted small' }, `${st.roster.length} locomotives. Bell codes shown are from "${set.name}".`),
    ),
  };
}
