# Changelog

Short notes on what each version brought. Newest first.

## 0.3.42

* Weights: every generic vehicle type has a generic weight (tare, and loaded for wagons and vans), and
  types with no weight of their own use their generic stand-in's (coaching stock scaled by length).
  Rakes show "about" so many tons, and train limits in tons now count. Your own types can have a
  loaded weight as well as a tare.
* Engines in the rake drawings look like engines: a steam tender engine with its tender next to the
  train, a steam tank engine with side tanks and a bunker, a diesel with a cab at each end on two
  bogies, and an electric with a pantograph. Timetables draw the loco working the train by its power
  type; on the Stock tab choose which to draw (Drawn with).

## 0.3.41

* The timetable generator makes up each train's rake from a rake type for its working: a random size
  within the type's counts, short enough for the roads it stands in and within the train limit. Goods
  rakes are marshalled with fitted vehicles next to the engine and a brake van at the tail (fitted when
  the train has a fitted head); pick-up and branch goods are made up unfitted. The rake is kept on the
  train, so the same pattern gives the same rakes and a kept Endless timetable runs them again.
* Goods trains are filled from the railway company's goods mix (for LMS, the numbers of each wagon
  built; a placeholder until goods train make-up is researched). Block trains are rarer in the grouping era.
* Stock tab: a Railway company setting (Generic or LMS; Sigsim Central is LMS), and Rake types, where you
  can copy a built-in type or start a new one, choose its train types, how often it is used and its
  vehicles, see an example drawn to scale, and hide built-in types.
* Settings: Train limits, the most vehicles and tons for each train type, defaulting to the company's
  figures (the LMS 1939 table).

## 0.3.40

* Timetable trains choose their stock: any suitable rake (the default for new trains), a rake type,
  one of your saved rakes, or a written consist (older timetables keep their written consists).
* Built-in generic rake types: local, medium-distance, express, excursion, push-pull, mail and TPO,
  parcels, and placeholder goods recipes.
* The rake is drawn in the train's case and its moves. The checks warn when a rake makes a goods train a
  different class from its working, or when two trains' rakes share vehicles.
* When a timetable runs, the train is given its rake where it is made up: in play mode its vehicles
  come on with it and their real lengths count. In model railway mode a rake sharing vehicles with one
  already on the layout waits.

## 0.3.39

* Play mode: an engine running round (or released by the pilot) no longer gets stuck when a train is
  offered from the other side. Next step now puts the movement's blocking back first, and you can
  refuse a train being offered (call attention instead of repeating it) to block back; the train is held.
* The clearing point is measured exactly: an engine drawing just clear of the points to set back only
  needs blocking back if it really comes within 440 yd of the home signal. Sigsim Central's West inner
  and East inner are now 600 yd, so its run rounds need no blocking back (Reset to defaults to get them).
* Timetables: no train is offered into the station while an engine runs round there, a through train
  waits for a train due to depart on to its line first, and early run rounds wait for a gap.
* Generated timetables plan run rounds for goods trains too, allow 8 minutes for them, and keep the
  lines into the station clear meanwhile.

## 0.3.38

* New **Stock** tab in the layout configurator: a library of vehicle types (LMS grouping-era types from
  research, plus generic types for any company or era), a fleet of individual vehicles with identities
  you can override, and saved rakes built from them.
* The rake builder works out length over buffers ("about" where lengths are approximate), the fitted
  head and goods train class, push-pull and where the guard rides, and notes things a railway would
  avoid without ever blocking a build. A vehicle can be in several rakes.
* Rakes are drawn to scale, with a brake pipe under the fitted head, loads, and a check against a road.
* Play mode: stock left standing in roads is now individual vehicles, and trains' guessed vehicle
  lengths use the generic library lengths (a little shorter than before). Old standing stock in saved
  data is cleared once.
* New tutorial page: Rolling stock.

## 0.3.37

* Off the layout (fiddle yards, the boxes beyond), engines and trains are always turned as an operator
  would, ready for their next journey, on single and double lines alike: a train comes back on
  smokebox first; a light engine faces whichever way the train it goes to work needs.
* A turntable turns an engine to suit its next train rather than just the other way round: it may run
  back to its coaches tender first so as to leave with them smokebox first.
* The box configurator's turntable option now only marks a box that timetables can send engines to
  for turning.

## 0.3.36

* New kinds of place: carriage sidings, carriage shed, turntable, coaling stage, water column or tank,
  and diesel fuelling point.
* Play mode tracks which way each engine faces (smokebox or tender first). A turntable turns it;
  running round does not. Arriving and departing trains say when they run tender first.
* A connected box can be marked as working a turntable off the layout: engines sent to it come back
  smokebox first.
* Generated timetables turn steam engines when a turntable is to hand (on the layout, or at such a
  box), send them for coal and water (diesels for fuel), and sometimes take the empty stock to the
  carriage sidings and back into a platform. Without a turntable they note "runs tender first".
* Released engines are suggested to the turntable or shed first when adding moves by hand.

## 0.3.35

* A track circuit can be a road of several places, e.g. a platform that is also the parcels dock of
  the goods depot. A train on one of them occupies them all.
* Track circuit lengths can be typed in on the layout configurator (blank = worked out as before).
* Play mode tracks which end of its train each engine is at. A loco hauled train leaves engine first;
  one with its engine at the wrong end runs round by itself when its departure is set, or earlier
  when the timetable leaves time for it (blocking back where it needs to).
* A trapped engine (buffer stops, no release, or the release blocked) is released by the station
  pilot: it draws the stock off, the engine gets clear, the pilot puts the stock back and the engine
  backs on at the outer end.
* Timetabled shunts can be marked as a run round, and can say what they move with ("2 vans"), so a
  train can be split into several roads.
* Generated timetables check the track plan for a way round, use the station pilot for trapped
  engines, and sometimes change engines (one goes on shed, another takes the train out).
* README cut down to what the app is for; this changelog added.

## 0.3.34

* Play mode: ground signals stay on for a running train already signalled by a stop signal.

## 0.3.33

* Settings, Bell code reference, Tutorial and Trains in places follow the style guide.

## 0.3.32

* Station limits and clearing point (editable per layout); Sigsim Central gets West and East inner
  circuits.
* Blocking back (2-4, 3-3), shunting into the forward section (3-3-2, 8) and token shunting; trains
  wait for permission, and the Next step says what to ring.

## 0.3.31

* Interlocking worked out from the signals, shown as a locking table, with per-route overrides.
* Play mode trains obey placed signals; arms and lights change on the diagram.

## 0.3.30

* Signals keep their place whatever the labels; diagram zoom; Routes toggle; switch running mode on
  an open box; shorter Next step prompts; Endless clock can start at the time now.

## 0.3.29

* Signals on the layout: placed by hand or generated (semaphore, colour light or mixed), lever
  numbers, facing point locks; Signalling tab; tutorial in tabs with a Signals page.

## 0.3.28

* Simulated running: trains move circuit to circuit, track occupancy on the diagram, routes worked
  out as they go, an automatic signaller, rakes of stock left and picked up.
* Choose Model railway or Signaller play when opening a box.

## 0.3.27

* Groundwork for play mode: the train-event seam, running mode per session, optional lengths and
  speeds.

## 0.3.26

* Timetable generator (Generate and Endless), loco duties and roles, headcode eras (Grouping lamp
  codes, BR lamp codes, 1960 headcodes).

## 0.3.25

* Run a timetable in the box: timetable strip and panel, simulated fiddle yard operator, stepping,
  switching timetables.

## 0.3.24

* Timetables: editor, letterpress poster and train cards, printing.

## 0.3.23

* Sigsim Central catch points turned the right way round.

## 0.3.22

* Sigsim Central: the express runs through west to east in the tutorial; two circuits per line;
  catch points on the goods neck.

## 0.3.21

* Ships the generic Sigsim Central example instead of Becton.

## 0.3.20

* Reset to defaults, with a confirmation and a backup button.

## 0.3.19

* Misdescribing a train is always penalised.

## 0.3.18

* A misdescribed train is reported by the receiving box on arrival (5-3).

## 0.3.17

* Refusing trains (silent refusal), re-offers, and regulating checks.

## 0.3.16

* Clean working bonus judged per train journey; collapsible Places tab using wide screens.

## 0.3.15

* Through trains: offering on from one line to another.

## 0.3.14

* Places: stations, sidings, goods yards, depots and fiddle yards, with named roads tied to track.

## 0.3.13

* Diagram board in the box, restyled desk, and scoring with a score sheet.

## 0.3.12

* Several layouts; boxes on layouts; signal box markers, platforms and up/down lines on the plan.

## 0.3.11

* Curves, double track and turntables in the layout configurator.

## 0.3.10

* Merging track circuits, narrower Y points, nudging.

## 0.3.9

* Zoom and pinch zoom on the track plan; tidier spacing.

## 0.3.8

* Crossovers in one step.

## 0.3.7

* Points that face either way (turn round keeps their hand); catch points; mirror.

## 0.3.6

* Layout configurator: draw the track plan by growing it from the ends.

## 0.3.5

* Box configurator rebuilt; add boxes and connections; lines with no fiddle yard.

## 0.3.4

* Style guide applied to every screen.

## 0.3.3

* Closing the box (7-5-5).

## 0.3.2

* Opening the box (5-5-5); Big Four themes.

## 0.3.1

* Train arrived complete on the instrument case; Box configurator; vertical main menu.

## 0.3.0

* A box console laid out like a real signal box.

## 0.2.1

* Renamed Signal Box Simulator.

## 0.2

* Editable workings from the box; fiddle yard and station panel; bell codes beside the box.

## 0.1

* First version: one box (Becton) and a single line to a fiddle yard, absolute block or electric
  token, learner and strict modes, a rhythm tapper, editable bell code sets, and a recorded bell.
