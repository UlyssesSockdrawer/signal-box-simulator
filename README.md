# Signal Box Simulator

A signal box bell and block instrument simulator for model railways. Boxes, connections, rosters and
fiddle yards are all set up in the app. It is configured first for **Becton** box on the
**Becton and Tansley Spa Steam Railway** (OO gauge), where you are the Becton signaller. The app plays the signaller at the fiddle yard, answers your bells,
offers you incoming trains, and tells you which loco to drive (with its DCC address). The levers,
interlocking and signals stay on the physical layout.

## Running it

* **On a PC:** double-click `dist/signal-box-simulator.html`. It runs in any modern browser, offline.
  Fonts come from Google Fonts when online; it falls back to system fonts otherwise.
* **On an Android phone/tablet:** open the hosted copy, or copy the same HTML file to the device.
  `dist/pwa/` is an installable app version that will work once it is served over https
  (e.g. GitHub Pages); then use Chrome's "Add to Home screen".
* `dist/claude-hosted/artifact.html` is only for publishing the hosted copy on claude.ai
  (the same app without the outer page wrapper). You don't need to open it.
* Your roster, fiddle yard and settings are saved in the browser on that device.
  Use **Settings → Your data** to copy/export them between PC and phone.

## The signal box screen (v0.3)

Laid out like a real box: a **block shelf** with one instrument group per neighbouring box
(brass nameplate, train describer, block bell, your instrument and commutator, the far box's
repeater or a token instrument, and the tapper with a bell code card), above a **desk** with the
next arrival, the departure, the fiddle yard and station, and the train register. Learner-mode
"Next step" guidance sits above the shelf (below the diagram board when it is shown). The commutator follows a Midland Railway instrument:
Train On Line left, Line Blocked centre, Line Clear right.

Each box sets how many shelf positions it has, and each connection sets its position, in the
**Box configurator** (main menu). Becton has three, with the Fiddle Yard on the right. Settings holds
app-wide options (layout name, learner/strict, bell code set, sound, tapper timing).

The box keeps running while you visit other screens (the bell still rings), so you can open
Settings from the box and come straight back mid-train. A "Train arrived complete" button appears
on the instrument case while an incoming train is on its way.
On phones the shelf shows one instrument group at a time and the desk becomes tabs.

## Opening the box and themes (v0.3.2)

* A box starts closed each time the app starts. Open it with each neighbouring box by calling
  attention (1) and sending 5-5-5 (Opening of signal box). Until then the far box will not offer or
  accept trains. 7-5-5 closes it again when no train is being signalled: the other boxes go quiet
  (they answer only 1 and 5-5-5) and the box resets to its cold state, register cleared.
* Settings → Appearance offers five themes: Device (follows light/dark), Great Western, LMS,
  LNER and Southern, each based on that company's 1930s colours. The signal box furniture (wood,
  brass, enamel) stays the same in every theme.

## Style guide (v0.3.4)

* Page titles and proper names at the head of a page (box, layout, fiddle yard, station) use the
  white-on-black nameboard in Josefin Sans.
* The key call to action on a screen is brass (`.btn.primary`); every other button is white on
  brown (`.btn`). Lists of choices (main menu, box list, roster) sit on the teak shelf as
  mahogany cases.
* In the Device theme that means wood and brass throughout. The Big Four themes swap the shelf and
  button colours for the company's livery (`--shelf-bg`, `--btn-*` tokens in styles.css); the
  instrument cases on the block shelf stay wood and brass in every theme.

## Adding boxes and connections (v0.3.5)

* **Open a signal box** lists every box on the shelf, with a **+ Add a signal box** tile at the
  bottom. A new box starts as "New box" (short name NEW; numbered if that is taken) and opens
  straight in the Box configurator. Box names and short names must be unique.
* The **Box configurator** shows one box at a time (tabs switch between boxes) in the main-menu
  style: the box's mahogany case (name, short name, shelf positions 1–8, checked as you type),
  then one case per connected box and a **+ Add a connected signal box** tile. A new connection
  goes in the first free shelf position (the shelf gains a position if it is full). Choosing an
  occupied position swaps the two instruments. Connections and boxes can be removed (press twice).
* **Fiddle yard served** is Yes/No. Yes: choose the yard; incoming trains come from it and
  departures run into it. No: the far box serves a location on the layout (another scene).
  Trains you send there stay on the layout at that location (press "Arrived at <box>" when they
  get there), and trains standing there can be offered back. (Since v0.3.14 both are replaced by
  **Trains run to and from**: a place on the box's layout, see Places below.)
* A box with no connected boxes cannot be opened.

## Layout configurator (v0.3.6)

**Layout configurator** on the main menu draws the layout's track plan as simple track circuits
joined by junctions. The plan starts empty: build your own.

* **Lay the first track**, then grow the plan from its ends. Every unfinished end has a brass **+**;
  tap it to add the next piece: another track circuit, buffer stops (the track terminates: bays,
  terminus roads, sidings), "leaves the scene" (to a fiddle yard or another box's line), right- or
  left-hand points, Y points, three-way points, single or double slips, a diamond crossing or a
  scissors crossover. "Join to another end" links two unfinished ends.
* **Connecting tracks laid side by side:** select one and choose **Connect to a parallel track**,
  tap the other, then pick a crossover rising or falling to the right. Two sets of points and the
  track between them are added. Tracks must be at least two grid squares apart.
* Select a track circuit to give it a code and name, choose its signal box (or the line between
  two boxes), set what each end does, put points into the middle of it, split it or delete it.
  Select points to number them, change their type, turn them round, or see and finish their roads.
* Drag points and track ends to tidy the drawing (or select and use the arrow keys). Undo/Redo,
  zoom and Fit are on the toolbar. The strip under the plan says what is still unfinished.
* **Box areas** colours the plan by signal box. Select a track circuit and **Give this branch to**
  a box: it takes that track and everything joined to it, stopping at lines between boxes and at
  track already given to another box.
* Track circuits have no length or capacity. The plan is stored as a graph (circuits are edges,
  junctions are nodes with named ends and routes), so a later version can light circuits up to
  show where trains are without a physical layout.

## Points that face either way (v0.3.7)

* **Facing or trailing:** the + menu has a "New points and slips" choice. Facing (the default): the
  track you are on joins the toe and the line divides. Trailing: your track joins a road and the
  toe faces onward, so lines join. Use it for a double track narrowing to a single line, the end of
  a passing loop, or a siding joining the main line.
* **Turn round** turns points half a turn and keeps their hand (right-hand points stay right-hand
  for a train passing through them). If one road is joined, that track stays put and moves to the
  road that now faces it, so facing points become trailing points and back. With two or more roads
  joined, unjoin the others first. To change hand, change the type.
* **Catch points** (trap points) can be added at an end or put into a track. Crossings, slips,
  scissors and catch points also have **Mirror** (top to bottom).
* Roads of points can be unjoined from the points' own case.
* Plans saved by v0.3.6 load with turned-round points shown the same way but labelled with their
  true hand (a "turned round" right-hand set from 0.3.6 was really left-hand).

## Crossovers in one step (v0.3.8)

* Tap the **+** on a turnout road and choose **Crossover to a track alongside**: a short 45° track
  and opposing points of the same hand are added three squares away, with their toe facing onward.
  Carry on from the new points in both directions (toe one way, straight road the other). This is
  how a single line widens to two tracks, or how a loop or siding is reached by a crossover.
* From the end of a level track the menu offers **Right-hand crossover** and **Left-hand
  crossover**, which add the facing points as well.
* If a track already runs where the second points land, they are put into that track.
* **Turn round** now recognises a track that came off another junction's turnout road (even though
  it levels out) and joins it to the turnout road, making the same crossover.

## Zooming and clear rows (v0.3.9)

* **Pinch to zoom** the track plan on a phone or tablet (two fingers; one finger still scrolls).
  On a computer, hold Ctrl and use the mouse wheel, or pinch on a trackpad. The − / Fit / +
  buttons still work. Phones start zoomed further out so more of the plan fits.
* A new track off a turnout road normally lands one track spacing (three squares) away. If that row
  is already taken, or an unfinished line on it is heading that way (for example the left road of
  Y points on a branch would land back on the main line), it levels out sooner on a clear row.
  Drag its end if you want it somewhere else.

## Merging track circuits, narrower Y points, nudging (v0.3.10)

* **Merge:** track circuits that meet at a joint (the short tick across the line) can be made into
  one. Select either and press **Merge with T9** on that end (or select the joint and press
  Merge). The circuit you selected keeps its code, name and box; the joint goes. Repeat to merge a
  whole platform road laid in several pieces.
* **Y and three-way points** now fan out by half a spacing each, so their two outer roads end up
  one track spacing apart, like the two roads of an ordinary turnout. A new road also keeps a clear
  row between itself and any track alongside where it can.
* **Move buttons:** a selected set of points (or a track's free ends) has ◀ ▲ ▼ ▶ buttons to move it
  one square at a time, easier than dragging on a phone.
* A road that heads up but has to reach an end below it now leaves level and drops, instead of
  zig-zagging.

## Curves, double track and turntables (v0.3.11)

* **Curves:** the + menu has **Curve left** and **Curve right**: the line runs on a little, turns a
  quarter turn (drawn as a curve) and carries on up or down the plan. Points, slips and the rest
  can go on lines that run up and down; they turn to suit. Any track circuit can also be given
  bends: select it and press **Add a bend**, then drag the round handle (or tap it and use the
  arrows). Every corner in a track is drawn rounded. **Straighten** removes the bends.
  Curving both lines of a double track at the same place pulls the inner line back so the two
  curves run side by side.
* **Double track:** **+ Lay double track** on the toolbar lays two parallel tracks at once. Select
  any track and press **Lay a parallel track above/below** (or left/right) for a new track the same
  shape, one spacing away, round its corners too. Use Connect to a parallel track for crossovers.
* **Turntables:** add one from the + menu (or put one into a track). Choose which of the eight
  roads round the deck are in use in its case; roads are numbered clockwise from the entry road.
  Turntables are not counted as unassigned if no box works them.
* **Turn 90°** turns points (or a turntable) a quarter turn; with one road joined, that road stays put.
* Track that runs mostly up or down the plan is now drawn upright with a 45° section, like level
  track, rather than as a steep straight line.

## Layouts (v0.3.12)

* **Several layouts:** each layout has its own name, fiddle yards and track plan. The locomotive
  roster is shared by every layout (a loco's location names the layout when it is on another one).
* **Layout configurator** opens on a list of layouts (or a prompt to create the first). **Open
  layout** to edit it; **+ Create a new layout** opens its **Details** tab.
* **Details** tab: the layout's name, **Make this the active layout**, which signal boxes stand on
  it (a box is on one layout at a time; **+ Add a signal box** adds one to this layout), and its
  fiddle yards: **+ Add a fiddle yard**, its name and its number of roads (e.g. an Up and a Down
  yard of four roads each). Removing a yard or road, or cutting the number of roads, sends any
  trains standing there off the layout (they stay in the roster); you are shown which trains and
  asked to confirm first.
* **Active layout:** its name is on the main menu (the layout name is no longer in Settings), and
  **Open a signal box** lists its boxes, then any boxes **not on a layout** in their own group.
  Boxes on other layouts are listed by name only; change the active layout (switcher at the top
  of the box list when there is more than one layout) to work them. A box with no layout can
  still be opened.
* **Moving a box to another layout** (Box configurator, Details tick boxes, or Put on <layout>)
  clears its track assignments on the layout it leaves: its track, its lines, track given to its
  connected boxes, its points, exits to its lines and its signal box on the plan. When it has any,
  a dialog lists what will be cleared and asks you to confirm. Its connections move to the new
  layout's first fiddle yard (or serve a location on the layout if it has none).
* **Box configurator:** each box has a **Layout** choice. A connection's fiddle yard is chosen from
  the box's own layout. Trains in places (formerly Fiddle yard & station) shows the active layout.
* **Track worked by connected boxes:** track circuits and points can be given to the far box of a
  connection (worked by the simulated signaller), e.g. sidings it controls. Box areas colours them
  and lists them in the key; Give this branch to works for them too.
* **Signal boxes on the plan:** **+ Signal box** places a signal box (yours, or a connected box)
  beside a track circuit — it then follows that track, with a dashed lead — or on its own. Drag it,
  nudge it, choose the track it stands beside, or remove it from the plan in its case.
* **Platform roads:** select a track circuit and tick **This track is a platform road**, then give
  its platform number (e.g. 1, 2, 3 bay) and the side the platform is on. The platform is drawn
  beside the track's straight stretch with its number. New platforms get the next free number for
  their box; the same number twice for one box is listed as something to fix. (The signal box will
  use these later to say where an arriving train stands.)
* **Up and down lines:** a track circuit's **Traffic** is Both ways (the default: single lines,
  sidings), Up line or Down line, with the end trains run towards. Changes apply along the whole
  running line (straight on through joints, points and crossings), unless you tick "Change this
  track circuit only". Arrows on the track show the way trains run; with Codes + names the label
  says Up or Down. On double track, **Double line with T2** sets both lines and their directions
  at once from the layout's running side (Details tab: trains keep to the **Left (British)** or
  **Right**). Tracks running straight on into each other with opposite directions are listed as
  something to fix.
* Exit names on tracks that leave the scene upwards or downwards now run along the line, so exits
  side by side no longer print over each other.
* Joints left with no track on either side (after deleting or unjoining the tracks) are removed
  automatically, including any already in saved plans.
* Saves from earlier versions become one layout (named from the old layout name) holding all the
  boxes, the fiddle yard and the track plan, and it is the active layout.

## Fixes and a roomier Places tab (v0.3.16)

* **Clean working bonus is judged per train.** A through train worked on two lines gets one bonus
  for its whole journey through the box, and only if neither line had an irregularity while it
  was being worked (before, a mistake on the line in rear still left the bonus on the line ahead).
  The far boxes report each finished movement as clean or not; the box's referee
  (`src/core/referee.ts`) decides.
* **Places tab:** each place collapses to one line (name, kind, roads, trains, who works it) and
  expands again; **Expand all / Collapse all**. Road lists collapse too (fiddle yards start
  collapsed), and each road is one compact row (name, track circuit, notes, trains, remove). The
  tab uses the full width of a big monitor or landscape tablet, with places flowing into as many
  columns as fit.
* Choosing another place for a line now stops its far box being listed as working the old place.

## Through trains: offering on (v0.3.15)

* A box with more than one line can **offer on** a train it accepts, instead of keeping it.
  Example: A (simulated) ── B (you) ── C (simulated). A offers an express; you accept it (repeat
  4, Line Clear); the next step then tells you to offer it on to C (call attention, then 4) and
  selects C's instruments. When C has accepted and A sends 2, acknowledge it and show Train On
  Line; as the train passes your box send 2 to C; when its tail lamp has passed press **passed
  complete** on A's instruments and send 2-1 to A. C clears back with 2-1 when it arrives at C's
  end (its fiddle yard or station).
* Each incoming train has a **Route** (in the Next arrival panel): **Stop at <box>** (into a road
  of the places the box works, or standing at the box) or **On to <line>**. A box that works no
  place (a junction box) with one other line sends trains on by default; any other box (a
  terminus, or a station) keeps them, and you can choose to send them on. The Departure panel
  follows the line the train is being offered on to, and lists it as "Through from <line>".
* A train routed on can also be stopped at the box first (Train arrived, standing here), cleared
  back with 2-1, and sent on later. Re-routing a train to stop here withdraws it from the line
  ahead. A through train never takes over a departure you have already chosen for that line.
* The Next step bar no longer changes height while a finger or mouse button is down, so tapping a
  chip on another line's instruments is not lost when the instruments move. A quiet line that is
  selected while a train is still being worked on another line shows that line's next step.

## Places: stations, sidings, goods yards, depots and fiddle yards (v0.3.14)

* Every layout has **places**: everywhere trains stand or are worked. Kinds: station, sidings,
  goods yard or shed, loco shed or depot, fiddle yard (fiddle yards are now places too), other.
  Set them up in the layout configurator's new **Places** tab: name, short name, notes, the
  **signal boxes that work it** (a station can be worked by several boxes, e.g. North and South;
  a junction box need not work any place), the **lines that run here** (trains sent along them
  arrive here and trains here can be offered back), and its **roads** (platforms, siding roads,
  shed and yard roads), each with notes and optionally tied to a track circuit. Selecting a track
  circuit on the plan also offers **Road of a place** (or a new road named from its platform).
* In the box configurator a connection's **Trains run to and from** chooses its place (or none:
  trains come from, and go back to, the roster). The box case lists the places the box works.
* In the signal box, **Train arrived complete** now asks which road of the box's places the train
  is in (a box working no place keeps arrivals "at the box"); departures list trains in the box's
  places; sending a train shows "Arrived in <place>" and its roads; Trains on layout is grouped by
  place, the box's own first.
* **Trains in places** (main menu, and Places in the box's top ribbon) shows what stands on each
  road of each place, and lets you move trains.
* Saves from earlier versions are converted: fiddle yards become places; each box's implied
  station becomes a station worked by it, with platform roads taken from its station notes
  ("P1: …" lines become road P1 with that note, the rest stays as the station's notes) and trains
  there put on the matching road; a line with no fiddle yard gets a place named after its far box.
  Becton's notes no longer live in the app's code: they are ordinary place and road notes.

## Diagram board, desk and scoring (v0.3.13)

* **Diagram board:** the **Diagram** button on the box's top ribbon shows or hides the layout's
  track plan as a diagram board above the block shelf (remembered between sessions). The box's own
  track, its block sections and the points it works are drawn in black; track worked by other
  boxes is drawn faintly. Labels can be turned off or show codes or names. The **Next step** bar
  now sits between the diagram and the block shelf. On phones the diagram scrolls sideways.
  Each track circuit on the diagram is tagged, ready for a later simulated running mode that
  lights up occupied track.
* **Desk:** Next arrival, Departure, Trains on layout and the Train register are now mahogany cases
  on the teak shelf, like the configurators, so the Big Four themes recolour them.
* **Scoring** (Settings → Signalling → Keep score; on by default): the far box referees. Each part
  of a train working done by the book scores points (opening and closing the box, offering,
  accepting, Line Clear, Train entering section, Train On Line, Train out of section, Line Blocked
  again), with a 20-point bonus for a whole train movement with no irregularity. Irregularities
  lose points, and safety breaches (a train sent without Line Clear or a token, 2-1 before the train
  has arrived complete, Line Blocked with a train in section, offering into an occupied section,
  an unsignalled train) lose the most. The running total is the brass **Score** plate on the top
  ribbon; press it for the score sheet: the total, a verdict, trains received and sent, clean
  workings, safety breaches, time on duty, points by category and the log of every entry. Start a
  new score there for the next visitor, or print it. Closing the box (7-5-5) shows the final score
  sheet. The point values are in `src/core/score.ts`.

## What's in v0.1

* Main menu, box select (Becton), signal box screen, roster, fiddle yard & station (now Trains in places), settings,
  bell code reference, tutorial.
* Single line Becton – Fiddle Yard, worked either as **simplified absolute block** (one 3-position
  instrument) or **electric key token** (hold the last beat to give a release; withdraw/replace tokens).
  Chosen in Settings.
* **Learner** mode (next-step prompts, explains mistakes) or **Strict** mode (no prompts; mistakes logged as irregularities).
* Tapper that reads your rhythm (pauses split groups; a long last beat = held), plus a quick-send list.
* Bell code sets as editable data: BR 1960 (classes A–K, default) and later BR/Rule Book (classes 0–9).
  Make an editable copy to change codes or add your own train types.
* Next incoming train: manual or random choice.
* Built-in bell: the freesound "ding" recording, trimmed to a single 3 s strike (`assets/bell-trimmed.mp3`).
  Settings can swap in another file or a synthesised bell.

## Project layout

```
src/core/      Pure logic, no browser code (reusable for Android wrapper / networking / tests)
  types.ts             Data model (locos, workings, fiddle yards, boxes, settings)
  shelf.ts             Block shelf positions for a box
src/ui/boxRuntime.ts   Keeps a box's controllers and simulated neighbours running between screens
  bellcodes.ts         Train types, regulation signals, built-in code sets
  tapDecoder.ts        Tapper rhythm → bell code
  link.ts              Messages between two boxes (the seam for future multiplayer)
  sectionController.ts Your end of a block section: instruments, tokens, log
  score.ts             Scoring rules (points) and the Scorecard for a box session
  places.ts            Places (stations, sidings, goods, depots, fiddle yards), their roads and workers
  throughTrains.ts     Offering trains on from one line to another (routes, stages, guidance)
  referee.ts           Puts each line's points on the box's scorecard; clean working judged per train
  simulatedNeighbour.ts The far signaller: replies, offers trains, coaches you
  selection.ts         Next-train strategies (manual, random; timetable can be added)
  session.ts           Wires controllers + simulated neighbours for a box
  store.ts, defaults.ts  Saved state, migration, starting data
src/audio/bell.ts      Bell playback (recording or synth)
src/ui/                Screens (plain TypeScript + DOM, no framework)
  planDiagram.ts       Read-only track diagram (the box's diagram board)
  scoreSheet.ts        The score sheet dialog
  screens/places.ts    The layout configurator's Places tab
scripts/build.mjs      Builds dist/ (single HTML file, PWA folder, and claude-hosted/ for the hosted copy)
```

## Developing

```
npm install          # esbuild, typescript, vitest
npm run build        # → dist/
npm test             # core logic tests
npm run typecheck
```

(`bun scripts/build.mjs` and `bun test` also work with no install.)

## Where it goes next

* Replace buttons with graphics (instrument faces, a bell, a tapper) — the UI is separate from the logic.
* Simulated running: light up occupied track circuits on the diagram board (`setOccupied` in ui/planDiagram.ts) so trains need not move on a real layout.
* Timetabled workings (exhibition running plans) as a new `IncomingSelector`.
* More boxes/connections (a `BoxDef` can have several connections; double line is modelled).
* Multiplayer: implement `LinkEnd` over a WebSocket so another tablet plays the far box.
* Android APK via Capacitor wrapping `dist/pwa/`.

Bell code sources: BR Regulations for Train Signalling (1960) as summarised by signalbox.org and
Wikipedia; Rule Book list at davros.org; Bluebell Railway electric token regulations. Codes varied by
region, so check against your own railway's instructions.
