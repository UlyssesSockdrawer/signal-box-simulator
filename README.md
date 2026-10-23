# Signal Box Simulator

Signal Box Simulator puts you in a British mechanical signal box. You are the signaller; the app
plays the signallers at the boxes either side of you. You call attention, offer and accept trains
with the block bells, work the block instruments (or electric key tokens on a single line), and
keep the train register, following the absolute block regulations of the steam and early diesel
era.

It is made for model railways, and can be used two ways:

* **Model railway mode**: real trains on a real layout. The app does the signalling and tells you
  which loco to drive (with its DCC address); you drive the trains and tell the app when they have
  arrived. Levers and signals stay on the layout.
* **Signaller play mode**: any layout drawn in the app is run as a real railway, with simulated
  trains moving through the track circuits, signals and interlocking. Nothing needs to move on a
  real layout, so it can be played anywhere, including by visitors at an exhibition.

Everything is set up in the app: layouts and their track plans, stations, sidings and fiddle yards,
signal boxes and the lines between them, signals and interlocking, the loco roster, and timetables
(written by hand, generated, or made up as you go). Sessions can be scored, for have-a-go sessions
at shows.

It comes with an example to try it out: **Sigsim Central**, a station on a single line with a
passing loop, a goods yard, and fiddle yards to the west and east, with eight LMS and ex-Midland
locos. The **Tutorial** in the app walks through a session there. **Settings → Reset to defaults**
brings the example back.

## Running it

* **On a PC:** open `dist/signal-box-simulator.html` in any modern browser. It works offline.
* **On a phone or tablet:** open the hosted copy, or copy the same file to the device. `dist/pwa/` is
  an installable version for when it is served over https (e.g. GitHub Pages).
* Your layouts, roster and settings are saved in the browser on that device. **Settings → Your data**
  copies them between devices.

## Developing

TypeScript with no framework. The signalling and railway logic (`src/core/`) is kept apart from the
screens (`src/ui/`), so it can be tested on its own and reused for an Android app or for linking
boxes over a network later.

```
npm install          # esbuild, typescript, vitest
npm run build        # → dist/
npm test
npm run typecheck
```

(`bun scripts/build.mjs` and `bun test` also work with no install.)

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

Bell code sources: BR Regulations for Train Signalling (1960) as summarised by signalbox.org and
Wikipedia; Rule Book list at davros.org; Bluebell Railway electric token regulations. Codes varied by
region, so check against your own railway's instructions.
