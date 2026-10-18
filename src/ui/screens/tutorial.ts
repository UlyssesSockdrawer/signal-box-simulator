import { signalCode, trainCode } from '../../core/bellcodes';
import { activeCodeSet, topBar, type Ctx, type Screen } from '../app';
import { h } from '../dom';

export function tutorialScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const cs = activeCodeSet(st);
  const box = st.boxes[0];
  const fy = box.connections[0]?.neighbourName ?? 'Fiddle Yard';
  const CA = signalCode(cs, 'call_attention');
  const TES = signalCode(cs, 'train_entering_section');
  const TOOS = signalCode(cs, 'train_out_of_section');
  const OPEN = signalCode(cs, 'opening');
  const ord = trainCode(cs, 'ordinary_passenger') || '3-1';
  const le = trainCode(cs, 'light_engine') || '2-3';

  const play = (code: string, label = code) =>
    h('button', { class: 'btn small code-play', type: 'button', on: { click: () => { ctx.bell.unlock(); ctx.bell.ring(code); } } }, `▶ ${label}`);

  type Step = [who: string, bell: string, what: string];
  const steps = (rows: Step[]) =>
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'steps' },
        h('thead', null, h('tr', null, h('th', null, 'Step'), h('th', null, 'Who'), h('th', null, 'Bell'), h('th', null, 'What it means and what you do'))),
        h('tbody', null, ...rows.map(([who, bell, what], i) => h('tr', null, h('td', { class: 'num' }, String(i + 1)), h('td', null, who), h('td', { class: 'code-cell' }, bell ? h('strong', null, bell) : '—'), h('td', null, what)))),
      ),
    );

  const tryIt = () => {
    ctx.store.update((s) => (s.settings.strictness = 'learner'));
    ctx.go(`box/${box.id}`);
  };

  return {
    title: 'Tutorial',
    el: h(
      'main',
      { class: 'page prose-page' },
      topBar(ctx, 'Tutorial'),
      h(
        'article',
        { class: 'prose' },
        h('h2', null, '1. Absolute block in one sentence'),
        h('p', null, 'The line between two signal boxes is divided into a ', h('em', null, 'block section'), ', and only one train is allowed in a section at a time. The signaller at the far end (the box ', h('em', null, 'in advance'), ') must agree before a train may enter, and must confirm when it has left.'),
        h('p', null, `Here, you are the signaller at ${box.name}. The app plays the signaller at the ${fy}. You also drive the trains on your DCC controller, and you work the real signals and points on the layout.`),

        h('h2', null, '2. The block instrument'),
        h('p', null, 'Each box has an instrument with three positions, worked by the box the train is travelling ', h('em', null, 'towards'), ':'),
        h(
          'ul',
          null,
          h('li', null, h('strong', null, 'Line Blocked'), ': the normal position. No train may be sent.'),
          h('li', null, h('strong', null, 'Line Clear'), ': a train has been accepted. The box in rear may clear its section signal.'),
          h('li', null, h('strong', null, 'Train On Line'), ': a train is in the section.'),
        ),
        h('p', null, `So for trains coming to ${box.name} you work your own instrument. For trains leaving ${box.name}, the ${fy} works theirs, and you see a repeater of it.`),

        h('h2', null, '3. Bell codes: call and response'),
        h('p', null, 'Signallers talk with a single-stroke bell. Every message is acknowledged by ', h('strong', null, 'repeating it back exactly'), '. If it is repeated wrongly, the sender rings it again. If a signaller cannot agree (the line is not clear), they simply do not answer.'),
        h('p', null, 'Most messages begin with ', h('strong', null, `${CA} beat (call attention)`), ', which must be answered before the real message is sent. The main exception is ', h('strong', null, `${TES} (train entering section)`), ', which is sent straight away.'),
        h('div', { class: 'row' }, play(CA, `${CA}  Call attention`), play(ord, `${ord}  Is line clear for ordinary passenger`), play(TES, `${TES}  Train entering section`), play(TOOS, `${TOOS}  Train out of section`)),
        h('p', null, 'A code like ', h('strong', null, ord), ' means beats in groups: ', h('em', null, ord.split('-').join(', pause, ')), '.'),
        h('h3', null, 'Opening the box'),
        h('p', null, `When you open a box, it starts closed. Before any train can be signalled you open it with each neighbouring box: call attention (${CA}), and when they answer, send `, h('strong', null, `${OPEN} (Opening of signal box)`), '. They repeat it back and the box is open.'),
        h('p', null, 'At the end of a session, close the box the same way with ', h('strong', null, `${signalCode(cs, 'closing')} (Closing of signal box)`), '. The other boxes stop working with you, and your box goes back to its cold, unopened state, ready to be opened again.'),
        h('div', { class: 'row' }, play(OPEN, `${OPEN}  Opening of signal box`), play(signalCode(cs, 'closing'), `${signalCode(cs, 'closing')}  Closing of signal box`)),

        h('h2', null, `4. Example: receiving a train from the ${fy}`),
        steps([
          [fy, CA, 'Call attention. Answer with 1 beat.'],
          ['You', CA, 'You are listening.'],
          [fy, ord, 'Is line clear for an ordinary passenger train? Check your station can take it.'],
          ['You', ord, `Repeat ${ord} to accept, then turn your instrument to LINE CLEAR.`],
          [fy, TES, 'Train entering section: the train has left. Drive it in on your controller.'],
          ['You', TES, 'Acknowledge, and turn your instrument to TRAIN ON LINE.'],
          ['You', '', 'Watch the train arrive complete, with its tail lamp. Press "Train arrived".'],
          ['You', CA, 'Call attention.'],
          [fy, CA, 'They are listening.'],
          ['You', TOOS, 'Train out of section. Turn your instrument back to LINE BLOCKED.'],
          [fy, TOOS, 'Acknowledged. The section is clear for the next train.'],
        ]),

        h('h2', null, `5. Example: sending a light engine to the ${fy}`),
        steps([
          ['You', '', 'Choose the departing loco under "Departure" on the desk. Its working sets the code.'],
          ['You', CA, 'Call attention.'],
          [fy, CA, 'They are listening.'],
          ['You', le, 'Is line clear for a light engine?'],
          [fy, le, 'Accepted. Their instrument (your repeater) shows LINE CLEAR.'],
          ['You', '', 'Clear your starting signal on the layout and drive the loco away.'],
          ['You', TES, 'Train entering section, as it leaves.'],
          [fy, TES, 'Acknowledged. Repeater shows TRAIN ON LINE.'],
          ['You', '', 'Drive it into the fiddle yard. Press "Arrived in fiddle yard" and pick the road.'],
          [fy, CA, `The ${fy} calls attention. Answer ${CA}.`],
          [fy, TOOS, `Train out of section. Repeat ${TOOS}. Repeater returns to LINE BLOCKED.`],
        ]),

        h('h2', null, '6. Token working (optional)'),
        h('p', null, 'On a real single line, the driver must carry a token: a key that only one instrument at a time will release. Turn this on in Settings. The differences are:'),
        h(
          'ul',
          null,
          h('li', null, 'When you accept a train, repeat the Is line clear code and ', h('strong', null, 'hold the last beat down'), '. That releases a token at the far end.'),
          h('li', null, 'When you send a train, wait for the needle to deflect after your offer is repeated, then press ', h('strong', null, 'Withdraw token'), ' and hand it to the driver.'),
          h('li', null, 'When a train arrives, take the token from the driver and press ', h('strong', null, 'Replace token'), ' before sending Train out of section.'),
        ),

        h('h2', null, '7. Using the tapper'),
        h('p', null, 'Press the TAPPER button (or the space bar) in rhythm. Beats close together are one group; a longer pause starts the next group. Stop tapping and the code is sent after a moment. If you prefer, use Quick send to pick a code from a list. Timing can be adjusted in Settings.'),
        h('p', null, 'In Learner mode the box shows the next step and explains mistakes. Strict mode removes the prompts and logs irregularities instead.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: tryIt } }, `Try it now in ${box.name} box (learner mode)`)),
      ),
    ),
  };
}
