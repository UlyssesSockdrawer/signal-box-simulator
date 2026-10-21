import { signalCode, trainCode } from '../../core/bellcodes';
import { activeLayout } from '../../core/layouts';
import { canOpenBox } from '../../core/boxes';
import { placesWorkedBy } from '../../core/places';
import { incomingCandidates, stationLocos } from '../../core/selection';
import { eraInfo, eraOf, usesLamps } from '../../core/headcodes';
import { timetablesOf } from '../../core/timetables';
import type { Loco, SignalKind } from '../../core/types';
import { SIGNAL_KIND_ORDER, SIGNAL_KINDS, signalsOf } from '../../core/signals';
import { drawDiagram, signalSample } from '../planDiagram';
import { activeCodeSet, locoName, topBar, trainTypeName, type Ctx, type Screen } from '../app';
import { h } from '../dom';

/*
 * The tutorial, in tabs: absolute block and bell codes explained, worked examples, the tapper and tokens,
 * a hands-on session at a real box, timetables and signals.
 * Everything is named from the data (the starting data ships Sigsim Central between Fiddle Yard
 * West and Fiddle Yard East), so it still reads correctly after the user has changed things.
 */
export const TUTORIAL_TABS = ['basics', 'examples', 'tapper', 'try', 'timetables', 'signals'] as const;
export type TutorialTab = (typeof TUTORIAL_TABS)[number];
/** The page last shown, so coming back to the tutorial opens where you were. */
let lastTab: TutorialTab = 'basics';

export function tutorialScreen(ctx: Ctx, tab?: string): Screen {
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
      h('h2', null, `Try it yourself at ${boxName}`),
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
              `Under Next arrival choose ${lineA.neighbourName}, pick ${throughTrain ? `${describe(throughTrain)},` : 'a train'} and press Offer next incoming train. Set its Route (in the Next arrival panel) to On to ${lineB.neighbourName}: it runs through ${boxName} without stopping. Answer the ${CA}, repeat the Is line clear code to accept it, and turn your ${lineA.neighbourName} instrument to Line Clear. The Next step bar then asks you to offer it on: on the ${lineB.neighbourName} instruments send ${CA}, then the same code, and ${lineB.neighbourName} accepts it. When ${lineA.neighbourName} sends ${TES}, repeat it and show Train On Line. Drive the train through the station; as it passes your box send ${TES} to ${lineB.neighbourName}. Once its tail lamp has passed, press Train passed complete in the Next arrival panel and send ${CA} and ${TOOS} to ${lineA.neighbourName}, then Line Blocked. Drive it on to ${placeAtEnd(lineB.placeId, lineB.neighbourName)}, press the Arrived button in the Departure panel, and ${lineB.neighbourName} clears back with ${TOOS}.`,
            )
          : null,
        exercise(
          `Receive a train from ${lineA.neighbourName}.`,
          `Under Next arrival choose ${lineA.neighbourName}, pick a train${fromA ? ` (try ${describe(fromA)})` : ''} and press Offer next incoming train. Answer the ${CA}, repeat the Is line clear code and turn your instrument to Line Clear. When ${TES} comes, repeat it and show Train On Line. Drive the train in, press Train arrived complete and choose where it stands${where}, then send ${CA} and ${TOOS} and put the instrument back to Line Blocked (as in the first worked example).`,
        ),
        lineB
          ? exercise(
              `Send a train to ${lineB.neighbourName}.`,
              `Under Departure choose ${lineB.neighbourName} and the departing train${departing ? ` (try ${describe(departing)})` : ''}. Send ${CA}, then its Is line clear code. When the repeater shows Line Clear, clear your signal, send ${TES} as it leaves, drive it to ${placeAtEnd(lineB.placeId, lineB.neighbourName)} and press the Arrived button. ${lineB.neighbourName} clears back with ${TOOS} (as in the second worked example).`,
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
    h('h2', null, 'Timetables'),
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
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: () => ctx.goFrom('timetables', { route: 'tutorial/timetables', label: 'tutorial' }) } }, 'Timetables'), h('button', { class: 'btn', type: 'button', on: { click: () => ctx.goFrom('ttgen', { route: 'tutorial/timetables', label: 'tutorial' }) } }, 'Generate a timetable')),
  ];

  // ---------------------------------------------------------------- signals
  const signalled = layout ? signalsOf(layout).length > 0 : false;
  const SIGNAL_TEXT: Record<SignalKind, string> = {
    distant:
      'A yellow fishtail arm, or a yellow light. It stands well before the home (about 1,000 yards out on the real railway). At caution it tells the driver to be ready to stop at the home; it may be cleared only when every stop signal ahead of it, up to the section signal, is off. A driver may pass it at caution.',
    home: 'The first stop signal at the station, protecting the points and platforms behind it. Where the routes divide there is one arm for each (a bracket or junction signal), so the driver can see which way the points are set. Cleared once the route is set and the train is close, or for a clear run through.',
    starter:
      'A stop signal at the end of a platform or road. The last stop signal before the next block section is the section signal (often an advanced starter, out beyond the points): it may be cleared only when the box ahead has given Line Clear.',
    shunt: 'A ground disc, white with a red band, or a position light (one red and one white lamp). It controls shunting moves: into and out of sidings, across to the other line, back on to a train. Off is the band turned to 45°, or two white lights at 45°. Never passed at danger.',
    shuntYellow:
      'A disc with a yellow band, or a yellow and white position light: the signal at a headshunt or yard exit. At danger a driver may pass it for a move it does not apply to (into the headshunt, along the siding), but not for the route it works, usually out on to a running line.',
    shuntAhead:
      'A small arm marked S, or a position light, below the section signal. With the box ahead’s permission, it lets a train pass the section signal at danger to shunt out into the section, but no further than the limit of shunt. Generated only when you ask for it.',
    limitOfShunt: 'A white board with a red cross, or two red lights, out in the section. Shunting moves under the shunt-ahead signal stop here. It has no lever.',
  };
  const kindRow = (k: SignalKind) =>
    h(
      'tr',
      null,
      h('td', { class: 'sig-sample-cell' }, signalSample(k, 'semaphore', `${SIGNAL_KINDS[k].name}, semaphore`)),
      h('td', { class: 'sig-sample-cell' }, signalSample(k, 'colourLight', `${SIGNAL_KINDS[k].name}, colour light`)),
      h('td', null, h('strong', null, SIGNAL_KINDS[k].name), h('br'), SIGNAL_TEXT[k]),
    );
  const openSignalling = () => layout && ctx.goFrom(`plan/${layout.id}/signals`, { route: 'tutorial/signals', label: 'tutorial' });
  const signalsSection: Array<HTMLElement | null> = [
    h('h2', null, 'Signals'),
    h(
      'p',
      null,
      'Bells and block instruments say whether a train may go; signals tell the driver. Each layout can have its own signals, drawn on the track diagram with the number of the lever that works each one. Plan them on the ',
      h('strong', null, 'Signalling'),
      ' tab of the Layout configurator: let the app generate a set, place your own, or both.',
    ),
    h('p', { class: 'muted' }, 'For now the signals are a plan: the box diagram shows them, but trains do not yet obey them. The interlocking and trains that stop at signals come next.'),
    h('h3', null, 'The kinds of signal'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'sig-kinds' },
        h('thead', null, h('tr', null, h('th', null, 'Semaphore'), h('th', null, 'Colour light'), h('th', null, 'What it does'))),
        h('tbody', null, ...SIGNAL_KIND_ORDER.map(kindRow)),
      ),
    ),
    h('p', { class: 'muted small' }, 'Drawn as they appear on the diagram, pointing the way trains run, at danger.'),
    h('h3', null, 'Semaphore or colour light'),
    h(
      'p',
      null,
      'Semaphores are lower-quadrant arms on posts, with discs on the ground for shunting. Colour lights here are two-aspect: red and green for stop signals, yellow and green for distants, and position lights for shunting. One layout can have both: choose Mixed when generating to give each post a style at random, or change any signal yourself.',
    ),
    h('h3', null, 'Reading the diagram'),
    h(
      'ul',
      null,
      h('li', null, 'A signal stands on the left of the line for the trains it applies to, and points the way they run.'),
      h('li', null, 'Arms that share a post, like a bracket signal with an arm for each route, are drawn side by side along the line.'),
      h('li', null, 'The tag is the lever number. Levers are numbered west to east along each box’s track. Points are numbered in the same run, so the box can be worked from one frame: a facing point lock usually takes the number just below its points.'),
      h('li', null, 'On a box’s diagram, other boxes’ signals are drawn faint.'),
    ),
    h('h3', null, 'Routes'),
    h(
      'p',
      null,
      'A stop signal reads as far as the next stop signal; a shunt signal as far as the next signal of any kind or a limit of shunt. The app follows the track every way the points can lie to find these routes (to P1, to Goods shed, to Fiddle Yard East) and works them out again whenever the plan changes. For an unusual arrangement, select the signal, untick ',
      h('strong', null, 'Every route here not read by another signal'),
      ' and tick the routes that arm should read. A route that no arm reads is listed under Issues.',
    ),
    h('h3', null, 'Facing point locks'),
    h(
      'p',
      null,
      'Points that trains on a running line meet facing (from the toe, where the line divides) need a facing point lock: a bolt, worked by its own lever, that holds the blades so they cannot move under a train. The app works out which points need one. The Points and facing point locks table on the Signalling tab lets you say otherwise for any of them.',
    ),
    h('h3', null, 'Generating and placing your own'),
    h(
      'ul',
      null,
      h('li', null, h('strong', null, 'Generate signals. '), 'Choose semaphore, colour light or mixed, and whether to include shunt signals and shunt-ahead signals. The app puts a distant, a home and a section signal on each line, starters on the station roads and shunt signals where sidings and crossovers join, then numbers the levers.'),
      h('li', null, h('strong', null, 'Place a signal. '), 'Choose its kind and style, press + Place a signal and click the track where it should stand. Click any signal to change its name, lever number, distance from the end of the circuit, the way it faces, or its routes.'),
      h('li', null, h('strong', null, 'Yours and the app’s. '), 'Signals you place, or change, are yours. Generating again keeps them and fills in round them; Remove generated signals takes away only the app’s.'),
      h('li', null, h('strong', null, 'Number the levers '), 'renumbers every signal and set of points from west to east, after you have added or moved things.'),
    ),
    layout ? h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: openSignalling } }, `Signalling for ${layout.name}`)) : null,
  ];
  if (layout && signalled) {
    const svgEl = drawDiagram(st, layout, { labels: 'codes', signals: true });
    if (svgEl) signalsSection.push(h('h3', null, `${layout.name} as signalled`), h('div', { class: 'tut-diagram' }, svgEl));
  }

  // ---------------------------------------------------------------- the pages
  const basics = [
    box && lineA
      ? h('p', { class: 'lead' }, `These pages explain absolute block signalling and the bell codes, take you through a session at ${boxName} step by step, and explain timetables and signals. You can open the box and try it at any point.`)
      : null,
    tryButton(),
    h('h2', null, 'Absolute block'),
    h('p', null, 'The line between two signal boxes is divided into a ', h('em', null, 'block section'), ', and only one train is allowed in a section at a time. The signaller at the far end (the box ', h('em', null, 'in advance'), ') must agree before a train may enter, and must confirm when it has left.'),
    h('p', null, `Here, you are the signaller at ${boxName}. The app plays the signaller${lineB ? 's' : ''} at ${lineB ? `${lineA!.neighbourName} and ${lineB.neighbourName}` : fy}. You also drive the trains on your DCC controller, and you work the real signals and points on the layout.`),

    h('h2', null, 'The block instrument'),
    h('p', null, 'Each box has an instrument with three positions, worked by the box the train is travelling ', h('em', null, 'towards'), ':'),
    h(
      'ul',
      null,
      h('li', null, h('strong', null, 'Line Blocked'), ': the normal position. No train may be sent.'),
      h('li', null, h('strong', null, 'Line Clear'), ': a train has been accepted. The box in rear may clear its section signal.'),
      h('li', null, h('strong', null, 'Train On Line'), ': a train is in the section.'),
    ),
    h('p', null, `So for trains coming to ${boxName} you work your own instrument. For trains leaving ${boxName}, the box at the other end works theirs, and you see a repeater of it.`),

    h('h2', null, 'Bell codes: call and response'),
    h('p', null, 'Signallers talk with a single-stroke bell. Every message is acknowledged by ', h('strong', null, 'repeating it back exactly'), '. If it is repeated wrongly, the sender rings it again. If a signaller cannot accept a train, they simply do not answer its Is line clear: that is a refusal, and the train is offered again later.'),
    h('p', null, 'Most messages begin with ', h('strong', null, `${CA} beat (call attention)`), ', which must be answered before the real message is sent. The main exception is ', h('strong', null, `${TES} (train entering section)`), ', which is sent straight away.'),
    h('div', { class: 'row' }, play(CA, `${CA}  Call attention`), play(ord, `${ord}  Is line clear for ordinary passenger`), play(TES, `${TES}  Train entering section`), play(TOOS, `${TOOS}  Train out of section`)),
    h('p', null, 'A code like ', h('strong', null, ord), ' means beats in groups: ', h('em', null, ord.split('-').join(', pause, ')), '.'),
    h('h3', null, 'Opening the box'),
    h('p', null, `When you open a box, it starts closed. Before any train can be signalled you open it with each neighbouring box: call attention (${CA}), and when they answer, send `, h('strong', null, `${OPEN} (Opening of signal box)`), '. They repeat it back and the box is open.'),
    h('p', null, 'At the end of a session, close the box the same way with ', h('strong', null, `${CLOSE} (Closing of signal box)`), '. The other boxes stop working with you, and your box goes back to its cold, unopened state, ready to be opened again.'),
    h('div', { class: 'row' }, play(OPEN, `${OPEN}  Opening of signal box`), play(CLOSE, `${CLOSE}  Closing of signal box`)),
  ];

  const examples = [
    h('h2', null, `Receiving a train from ${fy}`),
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

    h('h2', null, `Sending a light engine to ${lineB?.neighbourName ?? fy}`),
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
  ];

  const tokenAndTapper = [
    h('h2', null, 'Using the tapper'),
    h('p', null, 'Press the TAPPER button (or the space bar) in rhythm. Beats close together are one group; a longer pause starts the next group. Stop tapping and the code is sent after a moment. The chips beside the tapper send the everyday codes, and the Code card lists them all. Timing can be adjusted in Settings.'),
    h('p', null, 'In Learner mode the box shows the next step and explains mistakes. Strict mode removes the prompts and logs irregularities instead. Either way the score plate counts points for working by the book.'),
    h('h2', null, 'Token working (optional)'),
    h('p', null, 'On a real single line, the driver must carry a token: a key that only one instrument at a time will release. Choose Electric key token as the Working of a connected box in the Box configurator. The differences are:'),
    h(
      'ul',
      null,
      h('li', null, 'When you accept a train, repeat the Is line clear code and ', h('strong', null, 'hold the last beat down'), '. That releases a token at the far end.'),
      h('li', null, 'When you send a train, wait for the needle to deflect after your offer is repeated, then press ', h('strong', null, 'Withdraw token'), ' and hand it to the driver.'),
      h('li', null, 'When a train arrives, take the token from the driver and press ', h('strong', null, 'Replace token'), ' before sending Train out of section.'),
    ),
  ];

  const pages: Record<TutorialTab, Array<HTMLElement | null>> = {
    basics,
    examples,
    tapper: tokenAndTapper,
    try: session.length ? session : [h('p', null, 'Set up a signal box with at least one connected box in the Box configurator, then come back here.'), tryButton()],
    timetables: ttSection,
    signals: signalsSection,
  };
  const TAB_LABELS: Record<TutorialTab, string> = { basics: 'Absolute block', examples: 'Worked examples', tapper: 'Tapper & tokens', try: 'Try it', timetables: 'Timetables', signals: 'Signals' };

  let current: TutorialTab = TUTORIAL_TABS.includes(tab as TutorialTab) ? (tab as TutorialTab) : lastTab;
  const tabsEl = h('nav', { class: 'config-tabs tut-tabs', 'aria-label': 'Tutorial pages' });
  const article = h('article', { class: 'prose' });
  const show = () => {
    lastTab = current;
    tabsEl.replaceChildren(
      ...TUTORIAL_TABS.map((id) =>
        h(
          'button',
          {
            class: 'btn small side-tab',
            type: 'button',
            'aria-selected': String(current === id),
            'aria-current': current === id ? 'page' : undefined,
            on: {
              click: () => {
                if (current === id) return;
                current = id;
                history.replaceState(null, '', `#tutorial/${id}`);
                show();
                window.scrollTo(0, 0);
              },
            },
          },
          TAB_LABELS[id],
        ),
      ),
    );
    const nextIdx = TUTORIAL_TABS.indexOf(current) + 1;
    const next = TUTORIAL_TABS[nextIdx];
    article.replaceChildren(
      ...pages[current].filter((x): x is HTMLElement => !!x),
      ...(next
        ? [
            h(
              'div',
              { class: 'row tut-next' },
              h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  on: {
                    click: () => {
                      current = next;
                      history.replaceState(null, '', `#tutorial/${next}`);
                      show();
                      window.scrollTo(0, 0);
                    },
                  },
                },
                `Next: ${TAB_LABELS[next]} →`,
              ),
            ),
          ]
        : []),
    );
  };
  show();

  return {
    title: 'Tutorial',
    el: h('main', { class: 'page prose-page' }, topBar(ctx, 'Tutorial'), tabsEl, article),
  };
}
