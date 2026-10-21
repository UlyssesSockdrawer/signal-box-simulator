import { playReadiness } from '../core/routing';
import { RUNNING_MODES, type RunningMode } from '../core/trainEvents';
import type { BoxDef } from '../core/types';
import type { Ctx } from './app';
import { peekBoxRuntime, setOpeningMode } from './boxRuntime';
import { h } from './dom';

/**
 * Open a signal box. A box already running opens as it is; otherwise you choose how to run this
 * session: model railway mode (your trains on your layout) or signaller play mode (simulated trains
 * on the layout's plan). Play mode is offered only when the plan has what it needs; if not, it says why.
 */
export function openBox(ctx: Ctx, box: BoxDef): void {
  if (peekBoxRuntime(box.id)) return ctx.go(`box/${box.id}`);
  const problems = playReadiness(ctx.store.state, box);
  const dlg = h('dialog', { class: 'config-case confirm-dialog open-box-dialog', 'aria-labelledby': 'ob_title' });
  const finish = (mode: RunningMode | null) => {
    dlg.close();
    dlg.remove();
    if (!mode) return;
    setOpeningMode(box.id, mode);
    ctx.go(`box/${box.id}`);
  };
  const choice = (mode: RunningMode) => {
    const info = RUNNING_MODES.find((m) => m.id === mode)!;
    const blocked = mode === 'play' && problems.length > 0;
    return h(
      'button',
      { class: 'menu-item mode-choice', type: 'button', disabled: blocked, on: { click: () => finish(mode) } },
      h('span', { class: 'mi-label' }, info.name),
      h('span', { class: 'mi-sub' }, info.description),
      blocked ? h('span', { class: 'mi-sub mode-blocked' }, `Not available yet: ${problems.join(' ')}`) : null,
    );
  };
  dlg.append(
    h('h2', { class: 'plate', id: 'ob_title' }, `Open ${box.name}`),
    h('p', null, 'How do you want to run this session of the box?'),
    h('div', { class: 'menu-grid menu-shelf mode-choices' }, choice('model'), choice('play')),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', on: { click: () => finish(null) } }, 'Cancel')),
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(null);
  });
  document.body.append(dlg);
  dlg.showModal();
  (dlg.querySelector('.mode-choice') as HTMLButtonElement | null)?.focus();
}
