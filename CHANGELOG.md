# Changelog

Short notes on what each version brought. Newest first.

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
