import { signalCode, trainCode } from '../../core/bellcodes';
import { activeLayout } from '../../core/layouts';
import { canOpenBox } from '../../core/boxes';
import { placesWorkedBy } from '../../core/places';
import { incomingCandidates, stationLocos } from '../../core/selection';
import { eraInfo, eraOf, usesLamps } from '../../core/headcodes';
import { timetablesOf } from '../../core/timetables';
import type { Loco } from '../../core/types';
import { activeCodeSet, locoName, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { h } from '../dom';

/*
 * The tutorial: absolute block and bell codes explained, then a hands-on session at a real box.
 * Everything is named from the data (the starting data ships Sigsim Central between Fiddle Yard
 * West and Fiddle Yard East), so it still reads correctly after the user has changed things.
 */
export function tutorialScreen(ctx: Ctx): Screen {
  const st = ctx.store.state;
  const cs = activeCodeSet(st);
  // The box to practise on: the first box on the active layout that can be opened, else any.
  const layout = activeLayout(st);
  const onLayout = st.boxes.filter((b) => layout && b.layoutId === layout.id);
  const box = onLayout.find((b) => canOpenBox(b)) ?? st.boxes.find((b) => canOpenBox(b)) ?? st.boxes[0];
  const lines = [...(box?.connections ?? [])].sort((a, b) => a.shelfPosition - b.shelfPosition);
  const lineA = lines[0];
  const lineB = lines.length > 1 ? lines[lines.length - 1] : undefined;
  const fy = lineA?.neighbourName ?? 'Fiddle Yard';
  const boxName = box?.name ?? 'your box';
  const CA = signalCode(cs, 'call_attention');
  const TES = signalCode(cs, 'train_entering_section');
  const TOOS = signalCode(cs, 'train_out_of_section');
  const OPEN = signalCode(cs, 'opening');
  const CLOSE = signalCode(cs, 'closing');
  const MISDESC = signalCode(cs, 'incorrectly_described');
  const ord = trainCode(cs, 'ordinary_passenger') || '3-1';
  const le = trainCode(cs, 'light_engine') || '2-3';

  // Trains named in the exercises, from where they stand now.
  const describe = (l: Loco | undefined) => {
    if (!l) return '';
    const code = trainCode(cs, l.working.trainTypeId);
    return `${locoName(l)}, ${trainTypeName(st, l.working.trainTypeId).toLowerCase()}${code ? `, bell ${code}` : ''}`;
  };
  // At the first line's far end, the highest class train runs through to the other line (the express), the next is received here.
  const rank = (l: Loco) => cs.trainCodes[l.working.trainTypeId]?.rank ?? 0;
  const candA = lineA ? [...incomingCandidates(st, lineA)].sort((a, b) => rank(b) - rank(a)) : [];
  const throughTrain = lineB ? candA[0] : undefined;
  const fromA = (lineB ? candA[1] : candA[0]) ?? candA[0];
  const fromB = lineB ? incomingCandidates(st, lineB)[0] : undefined;
  const departing = box ? stationLocos(st, box.id)[0] : undefined;
  const places = box ? placesWorkedBy(st, box.id) : [];
  const roads = places.flatMap((p) => p.roads.map((r) => r.name));
  const placeAtEnd = (placeId: string | undefined, fallback: string) => layout?.places.find((p) => p.id === placeId)?.name ?? fallback;

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
    if (!box) return;
    ctx.store.update((s) => (s.settings.strictness = 'learner'));
    ctx.go(`box/${box.id}`);
  };
  const tryButton = () =>
    box && canOpenBox(box) ? h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: tryIt } }, `Open ${boxName} box (learner mode)`)) : null;

  // ---------------------------------------------------------------- the hands-on session
  const exercise = (title: string, ...body: Array<string | HTMLElement | null>) => h('li', null, h('strong', null, title), ' ', ...body);
  const session: HTMLElement[] = [];
  if (box && lineA) {
    const both = lineB ? `${lineA.neighbourName} and ${lineB.neighbourName}` : lineA.neighbourName;
    const where = roads.length ? ` (${roads.join(', ')})` : '';
    session.push(
      h('h2', null, `8. Try it yourself at ${boxName}`),
      h(
        'p',
        null,
        layout && box.layoutId === layout.id ? `${layout.name}: ` : '',
        box.description || `${boxName} works ${places.map((p) => p.name).join(' and ') || 'no places'}.`,
        ` You work ${boxName}; the app works ${both}. Press `,
        h('strong', null, 'Diagram'),
        ' on the box’s top bar to see the track plan. Learner mode shows the next step in the cream bar above the instruments, so you can follow along without this page.',
      ),
      h(
        'ol',
        { class: 'try-list' },
        exercise('Open the box.', `On each instrument case (${both}), tap ${CA} (call attention), wait for the reply, then send ${OPEN}.`),
        lineB
          ? exercise(
              `Run ${throughTrain ? locoName(throughTrain) : 'a train'} through from ${lineA.neighbourName} to ${lineB.neighbourName}.`,
              `Under Next arrival choose ${lineA.neighbourName}, pick ${throughTrain ? `${describe(throughTrain)},` : 'a train'} and press Offer next incoming train. Set its Route (in the Next arrival panel) to On to ${lineB.neighbourName}: it runs through ${boxName} without stopping. Answer the ${CA}, repeat the Is line clear code to accept it, and turn your ${lineA.neighbourName} instrument to Line Clear. The Next step bar then asks you to offer it on: on the ${lineB.neighbourName} instruments send ${CA}, then the same code, and ${lineB.neighbourName} accepts it. When ${lineA.neighbourName} sends ${TES}, repeat it and show Train On Line. Drive the train through the station; as it passes your box send ${TES} to ${lineB.neighbourName}. Once its tail lamp has passed, press Train passed complete on the ${lineA.neighbourName} instruments and send ${CA} and ${TOOS} to ${lineA.neighbourName}, then Line Blocked. Drive it on to ${placeAtEnd(lineB.placeId, lineB.neighbourName)}, press the Arrived button in the Departure panel, and ${lineB.neighbourName} clears back with ${TOOS}.`,
            )
          : null,
        exercise(
          `Receive a train from ${lineA.neighbourName}.`,
          `Under Next arrival choose ${lineA.neighbourName}, pick a train${fromA ? ` (try ${describe(fromA)})` : ''} and press Offer next incoming train. Answer the ${CA}, repeat the Is line clear code and turn your instrument to Line Clear. When ${TES} comes, repeat it and show Train On Line. Drive the train in, press Train arrived complete and choose where it stands${where}, then send ${CA} and ${TOOS} and put the instrument back to Line Blocked (section 4 above).`,
        ),
        lineB
          ? exercise(
              `Send a train to ${lineB.neighbourName}.`,
              `Under Departure choose ${lineB.neighbourName} and the departing train${departing ? ` (try ${describe(departing)})` : ''}. Send ${CA}, then its Is line clear code. When the repeater shows Line Clear, clear your signal, send ${TES} as it leaves, drive it to ${placeAtEnd(lineB.placeId, lineB.neighbourName)} and press the Arrived button. ${lineB.neighbourName} clears back with ${TOOS} (section 5 above).`,
            )
          : null,
        exercise(
          'Refuse a train.',
          `Offer another train${fromB ? ` from ${lineB!.neighbourName} (try ${describe(fromB)})` : ''}. Answer the ${CA}, but do not repeat the Is line clear code: after a few seconds the train counts as refused. The far box holds it (the describer shows HELD AT … and how long it has waited) and offers it again later, or soon after you next send ${TOOS} on another line. Accept it when it comes again.`,
        ),
        lineB
          ? exercise(
              'Regulate two trains.',
              'In Settings → Simulated signaller, tick Offers can coincide. Now when you ask for a train on one line, the other line offers one too. Accept the higher class first (the Next step bar tells you which) and let the other wait: accepting the lower class first loses points.',
            )
          : null,
        exercise(
          'Make a mistake on purpose.',
          `Offer a train with the wrong code (say ${ord} for a light engine). The far box accepts what it heard, but when the train arrives it tells you with ${MISDESC} (last train incorrectly described). To put it right yourself, send ${CA}, ${MISDESC} and the correct code.`,
        ),
        exercise('Close the box.', `With no train being signalled, send ${CA} then ${CLOSE} on each line. The box resets and your score sheet opens.`),
      ),
      h('p', { class: 'muted small' }, 'Want to start again with the example layout and trains? Settings → Reset to defaults puts everything back as the app first came.'),
      tryButton() ?? h('p', null, 'Set up a signal box with at least one connected box in the Box configurator, then come back here.'),
    );
  }

  // ---------------------------------------------------------------- timetables
  const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const tts = layout ? timetablesOf(layout) : [];
  const era = eraOf(layout);
  const sample = tts[0];
  const ttSection: HTMLElement[] = [
    h('h2', null, '9. Timetables'),
    h(
      'p',
      null,
      `A timetable says which trains run, in what order or at what times, and which loco works each. It belongs to a layout${layout ? ` (${layout.name} has ${tts.length ? `${NUMBER_WORDS[tts.length] ?? tts.length} timetable${tts.length === 1 ? '' : 's'}` : 'none yet'})` : ''}. Open `,
      h('strong', null, 'Timetables'),
      ' on the main menu to see them.',
    ),
    h(
      'ul',
      null,
      h('li', null, h('strong', null, 'Trains and moves. '), 'A train is a chain of moves worked by one loco: say an ordinary passenger into a platform, the engine running light to a siding and back on to its coaches, and the train working back to the fiddle yard. Add a train with + New train, and its next move with + Then this train…, which starts where the last move ended.'),
      h('li', null, h('strong', null, 'How it runs. '), 'An operations sequence has no times: each move is released when the one before has finished (like a card order). Real time runs by the clock on the wall. A session clock starts when you begin, from a time you choose, and can run fast.'),
      h('li', null, h('strong', null, 'Checks. '), 'As you edit, the timetable is walked through move by move: a loco starting somewhere its last move did not leave it, no route between two places, two trains on one road. Step through shows where everything stands after each move.'),
      h(
        'li',
        null,
        h('strong', null, 'Headcodes. '),
        `${layout ? `${layout.name} uses` : 'Each layout chooses'} the ${eraInfo(era).label} (${eraInfo(era).years}). ${eraInfo(era).description}${usesLamps(era) ? ' The lamps are drawn on the moves, the poster and the train cards.' : ''} Choose the era on the layout’s Details tab. The `,
        h('strong', null, `Fill in ${usesLamps(era) ? 'reporting numbers' : 'headcodes'}`),
        ' button under the moves numbers them for you.',
      ),
      h('li', null, h('strong', null, 'Printing. '), 'The Poster tab is a letterpress public timetable, fitted to the paper you choose (right to the edges if you like, for exhibition props). Train cards gives one card per move to hand to operators.'),
    ),
    h('h3', null, 'Let the app make one'),
    h(
      'p',
      null,
      'Give locos ',
      h('strong', null, 'timetable duties'),
      ' in the roster: express passenger, stopping passenger, parcels and empty stock, express goods, through goods and mineral, pick-up goods, station pilot, or railcar services, each between the places you tick and as often as you say. A role (Express passenger, Mixed traffic, Local passenger, Goods, Shunter, Railcar) fills in a sensible set in one go. Any engine can run light, or with a brake van, without a duty for it. Then ',
      h('strong', null, 'Generate a timetable'),
      ' on the Timetables screen makes one from the layout’s places, its signal boxes and those duties: through trains, trains that terminate and have their engine released (railcars just change ends), goods out and back, pilot shunts, light engines home at the end. Choose how it runs, how long and how busy, and the traffic mix; the preview shows what it would make, and Try another gives a different pattern. It saves as an ordinary timetable, to edit as you like.',
    ),
    h('h3', null, 'Running a timetable'),
    h(
      'p',
      null,
      `Open ${boxName} box and press `,
      h('strong', null, 'Timetable'),
      ` on its top bar. Choose a timetable${sample ? ` (try ${sample.name})` : ''} and who works the fiddle yards: simulated (trains come and go by themselves) or you (press Done when you have moved them). Start it, and open the box with each neighbour: nothing happens until then. Trains are then offered to you when due, the Departure panel picks the train that is due away, and shunts come up as cards in the strip under the Next step bar. The panel lets you release a move early, skip one, mark one done, pause, or switch to another timetable (moves under way finish first).`,
    ),
    h(
      'p',
      null,
      h('strong', null, 'Endless'),
      ' in the same list makes the timetable up as it runs, from the same duties: on a clock it plans the next 15 minutes, in a sequence it keeps six moves lined up. It carries on until you stop it, and ',
      h('strong', null, 'Keep this as a timetable'),
      ' saves what it has made to run again or print.',
    ),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.goFrom('timetables', { route: 'tutorial', label: 'tutorial' }) } }, 'Timetables'), h('button', { class: 'btn', type: 'button', on: { click: () => ctx.goFrom('ttgen', { route: 'tutorial', label: 'tutorial' }) } }, 'Generate a timetable')),
  ];

  return {
    title: 'Tutorial',
    el: h(
      'main',
      { class: 'page prose-page' },
      topBar(ctx, 'Tutorial'),
      h(
        'article',
        { class: 'prose' },
        box && lineA
          ? h(
              'p',
              { class: 'lead' },
              `This page explains absolute block signalling and the bell codes, then takes you through a session at ${boxName} step by step (section 8) and explains timetables (section 9). You can open the box and try it at any point.`,
            )
          : null,
        tryButton(),
        h('h2', null, '1. Absolute block'),
        h('p', null, 'The line between two signal boxes is divided into a ', h('em', null, 'block section'), ', and only one train is allowed in a section at a time. The signaller at the far end (the box ', h('em', null, 'in advance'), ') must agree before a train may enter, and must confirm when it has left.'),
        h('p', null, `Here, you are the signaller at ${boxName}. The app plays the signaller${lineB ? 's' : ''} at ${lineB ? `${lineA!.neighbourName} and ${lineB.neighbourName}` : fy}. You also drive the trains on your DCC controller, and you work the real signals and points on the layout.`),

        h('h2', null, '2. The block instrument'),
        h('p', null, 'Each box has an instrument with three positions, worked by the box the train is travelling ', h('em', null, 'towards'), ':'),
        h(
          'ul',
          null,
          h('li', null, h('strong', null, 'Line Blocked'), ': the normal position. No train may be sent.'),
          h('li', null, h('strong', null, 'Line Clear'), ': a train has been accepted. The box in rear may clear its section signal.'),
          h('li', null, h('strong', null, 'Train On Line'), ': a train is in the section.'),
        ),
        h('p', null, `So for trains coming to ${boxName} you work your own instrument. For trains leaving ${boxName}, the box at the other end works theirs, and you see a repeater of it.`),

        h('h2', null, '3. Bell codes: call and response'),
        h('p', null, 'Signallers talk with a single-stroke bell. Every message is acknowledged by ', h('strong', null, 'repeating it back exactly'), '. If it is repeated wrongly, the sender rings it again. If a signaller cannot accept a train, they simply do not answer its Is line clear: that is a refusal, and the train is offered again later.'),
        h('p', null, 'Most messages begin with ', h('strong', null, `${CA} beat (call attention)`), ', which must be answered before the real message is sent. The main exception is ', h('strong', null, `${TES} (train entering section)`), ', which is sent straight away.'),
        h('div', { class: 'row' }, play(CA, `${CA}  Call attention`), play(ord, `${ord}  Is line clear for ordinary passenger`), play(TES, `${TES}  Train entering section`), play(TOOS, `${TOOS}  Train out of section`)),
        h('p', null, 'A code like ', h('strong', null, ord), ' means beats in groups: ', h('em', null, ord.split('-').join(', pause, ')), '.'),
        h('h3', null, 'Opening the box'),
        h('p', null, `When you open a box, it starts closed. Before any train can be signalled you open it with each neighbouring box: call attention (${CA}), and when they answer, send `, h('strong', null, `${OPEN} (Opening of signal box)`), '. They repeat it back and the box is open.'),
        h('p', null, 'At the end of a session, close the box the same way with ', h('strong', null, `${CLOSE} (Closing of signal box)`), '. The other boxes stop working with you, and your box goes back to its cold, unopened state, ready to be opened again.'),
        h('div', { class: 'row' }, play(OPEN, `${OPEN}  Opening of signal box`), play(CLOSE, `${CLOSE}  Closing of signal box`)),

        h('h2', null, `4. Example: receiving a train from ${fy}`),
        steps([
          [fy, CA, 'Call attention. Answer with 1 beat.'],
          ['You', CA, 'You are listening.'],
          [fy, ord, 'Is line clear for an ordinary passenger train? Check your station can take it. If it cannot yet, do not reply.'],
          ['You', ord, `Repeat ${ord} to accept, then turn your instrument to LINE CLEAR.`],
          [fy, TES, 'Train entering section: the train has left. Drive it in on your controller.'],
          ['You', TES, 'Acknowledge, and turn your instrument to TRAIN ON LINE.'],
          ['You', '', 'Watch the train arrive complete, with its tail lamp. Press "Train arrived" and choose where it stands.'],
          ['You', CA, 'Call attention.'],
          [fy, CA, 'They are listening.'],
          ['You', TOOS, 'Train out of section. Turn your instrument back to LINE BLOCKED.'],
          [fy, TOOS, 'Acknowledged. The section is clear for the next train.'],
        ]),

        h('h2', null, `5. Example: sending a light engine to ${lineB?.neighbourName ?? fy}`),
        steps([
          ['You', '', 'Choose the departing loco under "Departure" on the desk. Its working sets the code.'],
          ['You', CA, 'Call attention.'],
          [lineB?.neighbourName ?? fy, CA, 'They are listening.'],
          ['You', le, 'Is line clear for a light engine?'],
          [lineB?.neighbourName ?? fy, le, 'Accepted. Their instrument (your repeater) shows LINE CLEAR.'],
          ['You', '', 'Clear your starting signal on the layout and drive the loco away.'],
          ['You', TES, 'Train entering section, as it leaves.'],
          [lineB?.neighbourName ?? fy, TES, 'Acknowledged. Repeater shows TRAIN ON LINE.'],
          ['You', '', 'Drive it into the fiddle yard. Press the "Arrived" button and pick the road.'],
          [lineB?.neighbourName ?? fy, CA, `They call attention. Answer ${CA}.`],
          [lineB?.neighbourName ?? fy, TOOS, `Train out of section. Repeat ${TOOS}. Repeater returns to LINE BLOCKED.`],
        ]),

        h('h2', null, '6. Token working (optional)'),
        h('p', null, 'On a real single line, the driver must carry a token: a key that only one instrument at a time will release. Choose Electric key token as the Working of a connected box in the Box configurator. The differences are:'),
        h(
          'ul',
          null,
          h('li', null, 'When you accept a train, repeat the Is line clear code and ', h('strong', null, 'hold the last beat down'), '. That releases a token at the far end.'),
          h('li', null, 'When you send a train, wait for the needle to deflect after your offer is repeated, then press ', h('strong', null, 'Withdraw token'), ' and hand it to the driver.'),
          h('li', null, 'When a train arrives, take the token from the driver and press ', h('strong', null, 'Replace token'), ' before sending Train out of section.'),
        ),

        h('h2', null, '7. Using the tapper'),
        h('p', null, 'Press the TAPPER button (or the space bar) in rhythm. Beats close together are one group; a longer pause starts the next group. Stop tapping and the code is sent after a moment. The chips beside the tapper send the everyday codes, and the Code card lists them all. Timing can be adjusted in Settings.'),
        h('p', null, 'In Learner mode the box shows the next step and explains mistakes. Strict mode removes the prompts and logs irregularities instead. Either way the score plate counts points for working by the book.'),
        ...session,
        session.length ? null : tryButton(),
        ...ttSection,
      ),
    ),
  };
}
