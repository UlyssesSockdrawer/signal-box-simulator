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
"Next step" guidance sits above the shelf. The commutator follows a Midland Railway instrument:
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
  get there), and trains standing there can be offered back. These locations appear in
  Fiddle yard & station and in the roster's location lists. When the layout configurator arrives
  they will become proper layout locations.
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

## What's in v0.1

* Main menu, box select (Becton), signal box screen, roster, fiddle yard & station, settings,
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
  simulatedNeighbour.ts The far signaller: replies, offers trains, coaches you
  selection.ts         Next-train strategies (manual, random; timetable can be added)
  session.ts           Wires controllers + simulated neighbours for a box
  store.ts, defaults.ts  Saved state, migration, starting data
src/audio/bell.ts      Bell playback (recording or synth)
src/ui/                Screens (plain TypeScript + DOM, no framework)
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
* Track diagram display.
* Timetabled workings (exhibition running plans) as a new `IncomingSelector`.
* More boxes/connections (a `BoxDef` can have several connections; double line is modelled).
* Multiplayer: implement `LinkEnd` over a WebSocket so another tablet plays the far box.
* Android APK via Capacitor wrapping `dist/pwa/`.

Bell code sources: BR Regulations for Train Signalling (1960) as summarised by signalbox.org and
Wikipedia; Rule Book list at davros.org; Bluebell Railway electric token regulations. Codes varied by
region, so check against your own railway's instructions.
