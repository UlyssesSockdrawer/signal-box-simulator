import { playReadiness } from '../core/routing';
import { RUNNING_MODES, type RunningMode } from '../core/trainEvents';
import type { BoxDef } from '../core/types';
import type { Ctx } from './app';
import { disposeBoxRuntime, peekBoxRuntime, setOpeningMode } from './boxRuntime';
import { h } from './dom';

/**
 * Open a signal box. You choose how to run this session: model railway mode (your trains on your
 * layout) or signaller play mode (simulated trains on the layout's plan). Play mode is offered only
 * when the plan has what it needs; if not, it says why. A box already being worked offers to carry
 * on as it is, or to switch mode (which ends that session, as closing the box would).
 */
export function openBox(ctx: Ctx, box: BoxDef): void {
  modeDialog(ctx, box, false);
}

/** From the box itself: carry on, or switch to the other mode. */
export function changeBoxMode(ctx: Ctx, box: BoxDef): void {
  modeDialog(ctx, box, true);
}

function modeDialog(ctx: Ctx, box: BoxDef, fromBox: boolean): void {
  const running = peekBoxRuntime(box.id);
  const problems = playReadiness(ctx.store.state, box);
  const dlg = h('dialog', { class: 'config-case confirm-dialog open-box-dialog', 'aria-labelledby': 'ob_title' });
  const finish = (mode: RunningMode | null) => {
    dlg.close();
    dlg.remove();
    if (!mode) return;
    if (running && running.mode !== mode) disposeBoxRuntime(box.id);
    if (!running || running.mode !== mode) setOpeningMode(box.id, mode);
    ctx.go(`box/${box.id}`);
  };
  const choice = (mode: RunningMode) => {
    const info = RUNNING_MODES.find((m) => m.id === mode)!;
    const blocked = mode === 'play' && problems.length > 0;
    const current = running?.mode === mode;
    const label = !running ? info.name : current ? `Carry on in ${info.name.toLowerCase()} mode` : `Switch to ${info.name.toLowerCase()} mode`;
    const sub = !running ? info.description : current ? 'Everything stays as it is.' : `${info.description} This ends the session now running: the other boxes stop working with you, and trains being signalled go back where they started.`;
    return h(
      'button',
      { class: `menu-item mode-choice${current ? ' primary' : ''}`, type: 'button', disabled: blocked && !current, on: { click: () => finish(mode) } },
      h('span', { class: 'mi-label' }, label),
      h('span', { class: 'mi-sub' }, sub),
      blocked && !current ? h('span', { class: 'mi-sub mode-blocked' }, `Not available yet: ${problems.join(' ')}`) : null,
    );
  };
  const now = running ? RUNNING_MODES.find((m) => m.id === running.mode)?.name.toLowerCase() : '';
  const order: RunningMode[] = running?.mode === 'play' ? ['play', 'model'] : ['model', 'play'];
  dlg.append(
    h('h2', { class: 'plate', id: 'ob_title' }, fromBox ? 'Change mode' : `Open ${box.name}`),
    h('p', null, running ? `${box.name} is open in ${now} mode.` : 'How do you want to run this session of the box?'),
    h('div', { class: 'menu-grid menu-shelf mode-choices' }, ...order.map(choice)),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', on: { click: () => finish(null) } }, 'Cancel')),
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(null);
  });
  document.body.append(dlg);
  dlg.showModal();
  (dlg.querySelector('.mode-choice:not([disabled])') as HTMLButtonElement | null)?.focus();
}
