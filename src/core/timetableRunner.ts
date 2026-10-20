import { signalCode, trainCode } from './bellcodes';
import { Emitter, type Scheduler } from './scheduler';
import type { SectionController } from './sectionController';
import type { SectionSession } from './session';
import type { ThroughWorkings } from './throughTrains';
import { eraOf, HeadcodeAllocator } from './headcodes';
import { toSequence, type TimetableGenerator } from './timetableGenerator';
import { findTrain, locosFor, refText, routeBetween, walkTimetable, type RouteLeg, type TtPos } from './timetables';
import type { AppState, Layout, Location, Loco, PlaceRef, Timetable, TimetableEntry, TimetableTrain, Working } from './types';

/*
 * RUNNING A TIMETABLE (v0.3.25). One runner per layout, shared by every box being worked on it.
 *
 * Each timetable entry becomes a run ITEM. Items are RELEASED in order: in an operations sequence
 * once every item of the step before has finished (moves "released with the previous" share a
 * step); in a timed timetable when the clock reaches the entry's time. A train's moves always
 * follow one another (a loco cannot start its next move before the last one has finished).
 *
 * An item that is released becomes ACTIVE: its loco is chosen ("any loco" trains get a loco with
 * the job), its working is set (so the description and bell code follow), and it is worked as a
 * chain of SEGMENTS, from the route its places take through the signal boxes:
 *   incoming  the far (simulated) box offers it to a box you work; ends when it is out of section
 *   through   offered by one far box and sent on to another (offering on); ends at the far end
 *   outgoing  it departs from your box to a far box (declared in the Departure panel); ends when
 *             the far box has cleared it back
 *   shunt     a move within your box's area: a card you press Done on
 *   auto      a move no box you work signals (entering or leaving the layout, moves between places
 *             only simulated boxes work): it happens by itself after a while with a simulated
 *             fiddle yard operator, or is a card you press Done on when you are the operator
 *   note      an instruction card (OK)
 * A segment through a box you are not working (its screen has not been opened) is done as auto.
 *
 * ENDLESS (v0.3.26): the timetable is made up as it runs by the timetable generator. The runner keeps
 * it topped up: on a clock, everything due in the next 15 minutes is planned; in an operations
 * sequence, six moves wait beyond those under way. Locos with nothing booked are lined up with where
 * they really are first, so a train moved by hand is picked up from there. It never finishes.
 *
 * Stepping: Release now (do not wait), Skip, Mark done (as if it had run). Pausing stops new
 * releases and the session clock. Switching to another timetable lets moves already under way
 * finish, then starts the new one, optionally with positioning moves first that bring each loco
 * from where it stands to where the new timetable starts it.
 */

export type RunOperator = 'simulated' | 'me';
export type PastMode = 'skip' | 'late';
export type ItemState = 'waiting' | 'active' | 'done' | 'skipped';

export interface RunnerBox {
  sessions: SectionSession[];
  workings: ThroughWorkings;
}

export interface RunnerOptions {
  getState: () => AppState;
  scheduler: Scheduler;
  layoutId: string;
  /** A box you are working (its running state exists), or null when nobody is working it. */
  box: (boxId: string) => RunnerBox | null;
  moveLoco: (locoId: string, loc: Location) => void;
  setWorking: (locoId: string, w: Partial<Working>) => void;
  /** Time of day in minutes for a scheduler time (real time timetables). */
  minutesOfDay?: (ms: number) => number;
  /** How long a simulated move takes when the timetable gives no running time (ms). */
  autoMoveMs?: number;
}

type Phase = 'wait' | 'requested' | 'cancelled';

export type Segment =
  | ({ kind: 'incoming'; boxId: string; connId: string; dest: TtPos; phase: Phase; ctrl?: SectionController; off?: () => void } & AtBox)
  | ({ kind: 'through'; boxId: string; fromConnId: string; toConnId: string; dest: TtPos; phase: Phase; ctrl?: SectionController; off?: () => void } & AutoArrival & AtBox)
  | ({ kind: 'outgoing'; boxId: string; connId: string; dest: TtPos; phase: Phase; ctrl?: SectionController; off?: () => void } & AutoArrival)
  | { kind: 'shunt'; boxId: string; dest: TtPos }
  | { kind: 'auto'; dest: TtPos; ms: number; timer?: number; endsAt?: number }
  | { kind: 'note' };

/** A train coming to your box: when it left the box in rear, and when it should reach (or pass) your box. */
interface AtBox {
  departedAt?: number;
  atBoxAt?: number;
}

/** A train sent to a simulated box's place: with a simulated fiddle yard operator it is reported arrived by itself. */
interface AutoArrival {
  arriveTimer?: number;
  /** When the simulated operator will report it arrived (scheduler time). */
  arriveAt?: number;
}

export interface RunItem {
  id: string;
  entry: TimetableEntry;
  train: TimetableTrain | null;
  /** A move the runner added to bring a loco to where the timetable starts it. */
  positioning: boolean;
  /** Belongs to the timetable switched away from: finishing before the new one's moves for its loco. */
  finishing: boolean;
  /** Sequence step (moves released together share one); 0 for positioning moves. */
  step: number;
  state: ItemState;
  locoId: string | null;
  segs: Segment[];
  seg: number;
  /** What is happening, in words. */
  status: string;
  /** Waiting for someone to press Done (a shunt, an operator's move, a note). */
  card: { kind: 'shunt' | 'operator' | 'note'; text: string } | null;
  /** Minutes late when released (timed timetables). */
  late: number | null;
  /** Released by hand (Release now): does not wait for its time or step. */
  forced: boolean;
  /** When it became active / finished (scheduler time). */
  startedAt: number | null;
  doneAt: number | null;
  /** The last status written to the timetable log (each change of a move's progress is logged once). */
  logged?: string;
}

export interface RunLog {
  t: number;
  text: string;
}

export interface RunEvents extends Record<string, unknown> {
  change: void;
  log: RunLog;
}

/** A move proposed to bring a loco to where a timetable starts it. */
export interface Positioning {
  locoId: string;
  entry: TimetableEntry;
  text: string;
}

const AUTO_MS = 20_000;
const TICK_MS = 1000;
const nid = () => `pos_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class TimetableRunner {
  readonly events = new Emitter<RunEvents>();
  readonly log: RunLog[] = [];
  tt: Timetable | null = null;
  items: RunItem[] = [];
  started = false;
  paused = false;
  finished = false;
  operator: RunOperator = 'simulated';
  /** Locos chosen for "any loco" trains, by train id. */
  private anyLoco = new Map<string, string>();
  private startedAt = 0;
  /** False until every box being worked on the layout is open on all its lines: nothing is released, the clock waits. */
  private begun = false;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private timer: number | null = null;
  private disposed = false;
  /** Endless running: the generator that keeps the timetable topped up. */
  private endless: { gen: TimetableGenerator; alloc: HeadcodeAllocator } | null = null;

  constructor(private o: RunnerOptions) {}

  private get state(): AppState {
    return this.o.getState();
  }

  private get layout(): Layout | undefined {
    return this.state.layouts.find((l) => l.id === this.o.layoutId);
  }

  // ------------------------------------------------------------------ clock

  /** The timetable's clock now, in minutes (null for an operations sequence or before starting). */
  clockNow(): number | null {
    const tt = this.tt;
    if (!tt || tt.timing === 'sequence') return null;
    const now = this.o.scheduler.now();
    if (tt.timing === 'clock') return (this.o.minutesOfDay ?? defaultMinutesOfDay)(now);
    if (!this.started || !this.begun) return tt.elapsed ? 0 : tt.startAt;
    const run = (this.pausedAt ?? now) - this.startedAt - this.pausedTotal;
    return (tt.elapsed ? 0 : tt.startAt) + (run * tt.speed) / 60_000;
  }

  /** Moves whose time has already passed (real time timetables), for the Start dialog. */
  pastCount(tt: Timetable): number {
    if (tt.timing !== 'clock') return 0;
    const now = (this.o.minutesOfDay ?? defaultMinutesOfDay)(this.o.scheduler.now());
    return tt.entries.filter((e) => e.dep !== null && e.dep < Math.floor(now)).length;
  }

  // ------------------------------------------------------------------ starting, stopping

  /** Load a timetable (not started): its items wait until Start. */
  load(tt: Timetable): void {
    this.clear();
    this.tt = tt;
    this.items = this.itemsFor(tt);
    this.emit();
  }

  /** Load an Endless timetable: `tt` starts empty (or nearly) and `gen` keeps adding to it as it runs. */
  loadEndless(tt: Timetable, gen: TimetableGenerator): void {
    this.load(tt);
    this.setEndless(gen);
    this.topUp();
    this.emit();
  }

  /** True while running Endless. */
  get isEndless(): boolean {
    return !!this.endless;
  }

  private setEndless(gen: TimetableGenerator | null): void {
    const layout = this.layout;
    this.endless = gen && layout ? { gen, alloc: new HeadcodeAllocator(eraOf(layout), layout, this.tt?.entries.map((e) => e.headcode) ?? []) } : null;
  }

  /** Where locos will stand once the moves under way have finished (for starting Endless part way through). */
  positionsAfterUnderWay(): Map<string, TtPos> {
    const out = new Map<string, TtPos>();
    for (const it of this.items) {
      if (it.state !== 'active' || !it.locoId || !this.underWay(it)) continue;
      const p = endPos(it.entry);
      if (p) out.set(it.locoId, p);
    }
    return out;
  }

  /**
   * Endless: plan more moves when the lookahead runs short (15 minutes of clock, or six moves waiting
   * in a sequence) and add them to the timetable and the run.
   */
  private topUp(): void {
    const e = this.endless;
    const tt = this.tt;
    if (!e || !tt) return;
    const { gen } = e;
    const seq = tt.timing === 'sequence';
    const at = seq ? gen.now : (this.clockNow() ?? gen.now);
    // Locos with nothing booked: start them from where they really are.
    for (const u of gen.units) {
      if (gen.hasPending(u.loco.id)) continue;
      const booked = this.items.some((it) => (it.state === 'waiting' || it.state === 'active') && (it.locoId ?? it.train?.locoId) === u.loco.id);
      if (booked) continue;
      const loco = this.state.roster.find((l) => l.id === u.loco.id);
      const p = loco ? locPos(loco.location) : null;
      if (p) gen.resync(u.loco.id, p, at);
    }
    const fresh: TimetableEntry[] = [];
    if (seq) {
      const waiting = () => this.items.filter((it) => it.state === 'waiting' && !it.positioning).length + fresh.length;
      for (let guard = 0; waiting() < 6 && guard < 30; guard++) {
        if (!gen.addChain() && !gen.pending()) break;
        fresh.push(...gen.take(Number.POSITIVE_INFINITY, e.alloc));
      }
      const unit = new Map(gen.trains.map((t) => [t.id, t.locoId]));
      toSequence(fresh, (x) => unit.get(x.trainId) ?? x.trainId);
    } else {
      const horizon = at + 15;
      for (let guard = 0; gen.now <= horizon && guard < 30; guard++) if (!gen.addChain()) break;
      fresh.push(...gen.take(horizon, e.alloc));
    }
    if (!fresh.length) return;
    for (const t of gen.trains) if (!tt.trains.some((x) => x.id === t.id)) tt.trains.push(structuredClone(t));
    let step = Math.max(0, ...this.items.map((x) => x.step));
    for (const entry of fresh) {
      tt.entries.push(entry);
      if (!entry.withPrevious || !seq) step++;
      this.items.push(this.itemFor(tt, entry, step));
    }
  }

  /** Start the loaded timetable, optionally with positioning moves first and earlier real-time moves skipped. */
  start(opts: { operator?: RunOperator; past?: PastMode; positioning?: Positioning[] } = {}): void {
    if (!this.tt) return;
    this.operator = opts.operator ?? this.operator;
    if (opts.positioning?.length) {
      // After any moves still finishing from a timetable switched away from (they free the locos first).
      const at = this.items.findIndex((x) => !x.finishing);
      this.items.splice(at < 0 ? this.items.length : at, 0, ...opts.positioning.map((p) => this.positioningItem(p)));
    }
    this.started = true;
    this.begun = false;
    this.paused = false;
    this.finished = false;
    this.startedAt = this.o.scheduler.now();
    this.pausedAt = null;
    this.pausedTotal = 0;
    if (this.tt.timing === 'clock' && opts.past === 'skip') {
      const now = Math.floor(this.clockNow() ?? 0);
      for (const it of this.items) if (!it.positioning && it.entry.dep !== null && it.entry.dep < now) this.setState(it, 'skipped', 'Skipped: its time had passed when the timetable started.');
    }
    this.note(`Started ${this.tt.name}${this.tt.timing === 'session' ? ` (session clock ${fmt(this.clockNow())})` : ''}.`);
    this.loop();
    this.tick();
  }

  /** Stop running (moves under way in the boxes carry on as ordinary trains). */
  stop(): void {
    if (this.tt && this.started) this.note(`Stopped ${this.tt.name}.`);
    this.clear();
    this.emit();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  pause(on: boolean): void {
    if (!this.started || this.paused === on) return;
    const now = this.o.scheduler.now();
    if (on) this.pausedAt = now;
    else if (this.pausedAt !== null) {
      this.pausedTotal += now - this.pausedAt;
      this.pausedAt = null;
    }
    this.paused = on;
    this.note(on ? 'Paused: no more moves are released until you resume.' : 'Resumed.');
    this.tick();
  }

  private clear(): void {
    for (const it of this.items) for (const s of it.segs) this.detach(s);
    if (this.timer !== null) this.o.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.items = [];
    this.tt = null;
    this.started = false;
    this.paused = false;
    this.finished = false;
    this.anyLoco.clear();
    this.endless = null;
  }

  private loop(): void {
    if (this.timer !== null) this.o.scheduler.clearTimeout(this.timer);
    this.timer = this.o.scheduler.setTimeout(() => {
      this.timer = null;
      if (this.disposed || !this.started) return;
      this.tick();
      this.loop();
    }, TICK_MS);
  }

  // ------------------------------------------------------------------ switching

  /**
   * Positioning moves that would bring each named loco from where it stands (or where a move under
   * way will leave it) to where `tt` starts it.
   */
  positioningFor(tt: Timetable): Positioning[] {
    const st = this.state;
    const layout = this.layout;
    if (!layout) return [];
    const w = walkTimetable(st, layout, tt);
    const out: Positioning[] = [];
    for (const u of w.units) {
      if (!u.locoId) continue;
      const loco = st.roster.find((l) => l.id === u.locoId);
      if (!loco) continue;
      const under = [...this.items].reverse().find((it) => it.state === 'active' && it.locoId === loco.id && this.underWay(it));
      const now: TtPos | null = under ? endPos(under.entry) : locPos(loco.location);
      if (!now) continue;
      const start = u.start;
      if (samePos(now, start)) continue;
      const e: TimetableEntry = { id: nid(), trainId: u.trainIds[0] ?? '', kind: 'shunt', dep: null, arr: null, withPrevious: false, trainTypeId: 'light_engine', headcode: '', from: { placeId: '', roadId: '' }, to: { placeId: '', roadId: '' }, calls: [], notes: 'Positioning move: brings the loco to where the timetable starts it.' };
      if (now.kind === 'off' && start.kind === 'place') {
        e.kind = 'enter';
        e.to = { placeId: start.placeId, roadId: start.roadId };
        e.trainTypeId = loco.working.trainTypeId;
      } else if (now.kind === 'place' && start.kind === 'off') {
        e.kind = 'leave';
        e.from = { placeId: now.placeId, roadId: now.roadId };
      } else if (now.kind === 'place' && start.kind === 'place') {
        e.from = { placeId: now.placeId, roadId: now.roadId };
        e.to = { placeId: start.placeId, roadId: start.roadId };
        const legs = routeBetween(st, layout, now.placeId, start.placeId);
        e.kind = legs?.some((l) => l.kind === 'line') ? 'run' : 'shunt';
      } else continue;
      const where = (p: TtPos) => (p.kind === 'off' ? 'off the layout' : refText(st, p));
      out.push({ locoId: loco.id, entry: e, text: `${locoLabel(loco)}: ${e.kind === 'enter' ? 'on to the layout at' : e.kind === 'leave' ? 'off the layout from' : 'light engine from'} ${e.kind === 'enter' ? where(start) : where(now)}${e.kind === 'run' || e.kind === 'shunt' ? ` to ${where(start)}` : ''}` });
    }
    return out;
  }

  /**
   * Switch to another timetable on the fly. Moves under way finish (under the old timetable); moves
   * not yet started are dropped. The new timetable starts now, after any positioning moves.
   */
  switchTo(tt: Timetable, opts: { positioning?: Positioning[]; past?: PastMode; operator?: RunOperator; endless?: TimetableGenerator } = {}): void {
    const old = this.tt;
    const finishing = this.items.filter((it) => it.state === 'active' && this.underWay(it));
    for (const it of this.items) {
      if (finishing.includes(it)) continue;
      // Not yet under way: take it back out of the boxes (an offer not yet accepted, a departure not yet offered).
      if (it.state === 'active') this.withdraw(it);
      for (const s of it.segs) this.detach(s);
    }
    for (const it of finishing) it.finishing = true;
    const operator = opts.operator ?? this.operator;
    if (this.timer !== null) this.o.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.tt = tt;
    this.anyLoco = new Map([...this.anyLoco].filter(([trainId]) => finishing.some((f) => f.train?.id === trainId)));
    this.items = [...finishing, ...this.itemsFor(tt)];
    this.setEndless(opts.endless ?? null);
    this.topUp();
    this.note(`Switched from ${old?.name ?? 'no timetable'} to ${tt.name}${finishing.length ? `: ${finishing.length} move${finishing.length === 1 ? '' : 's'} under way will finish first` : ''}.`);
    this.started = false;
    this.start({ operator, past: opts.past, positioning: opts.positioning });
  }

  // ------------------------------------------------------------------ stepping

  /** Release a waiting move now, without waiting for its time or step. */
  releaseNow(id?: string): string | null {
    const it = id ? this.items.find((x) => x.id === id) : this.items.find((x) => x.state === 'waiting' && !this.blockedByTrain(x));
    if (!it) return 'Nothing is waiting to be released.';
    if (it.state === 'active') {
      // A move cancelled in the box: offer it again.
      const s = it.segs[it.seg];
      if (s && 'phase' in s && s.phase === 'cancelled') {
        s.phase = 'wait';
        this.startSeg(it);
        this.emit();
        return null;
      }
      return 'That move is already under way.';
    }
    if (it.state !== 'waiting') return 'That move has finished.';
    const blocker = this.blockedByTrain(it);
    if (blocker) return `${trainName(it)} has not finished its move before this one yet${blocker.state === 'active' ? '' : ' (release that first)'}.`;
    it.forced = true;
    this.note(`Released by hand: ${this.describe(it)}.`);
    this.activate(it);
    this.tick();
    return null;
  }

  /** Skip a move: it does not run (the loco stays where it is). Not once it is under way on a line. */
  skip(id: string): string | null {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.state === 'done' || it.state === 'skipped') return null;
    const err = this.withdraw(it);
    if (err) return err;
    this.setState(it, 'skipped', 'Skipped.');
    this.note(`Skipped: ${this.describe(it)}.`);
    this.tick();
    return null;
  }

  /** Mark a move done as if it had run: the loco is moved to where it ends. */
  markDone(id: string): string | null {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.state === 'done' || it.state === 'skipped') return null;
    const err = this.withdraw(it);
    if (err) return err;
    if (!it.locoId) this.resolveLoco(it);
    if (it.locoId) {
      this.applyWorking(it);
      const end = endPos(it.entry);
      if (end) this.o.moveLoco(it.locoId, posLocation(end));
    }
    this.setState(it, 'done', 'Marked done.');
    this.note(`Marked done: ${this.describe(it)}.`);
    this.tick();
    return null;
  }

  /** The operator's Done for a card (a shunt, a fiddle yard move, a note). */
  done(id: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.state !== 'active' || !it.card) return;
    this.completeSeg(it);
  }

  /**
   * Under way: the train is moving (in a section, or a simulated move in progress), its offer has
   * been accepted or its departure accepted ahead, or it is part way through a move of several stages.
   */
  underWay(it: RunItem): boolean {
    if (it.state !== 'active') return false;
    if (it.seg > 0) return true;
    const s = it.segs[0];
    if (!s) return false;
    if (s.kind === 'auto') return s.timer !== undefined;
    if (s.kind !== 'incoming' && s.kind !== 'through' && s.kind !== 'outgoing') return false;
    if (s.phase !== 'requested' || !s.ctrl) return false;
    const v = s.ctrl.view;
    if (s.kind === 'outgoing') {
      const out = v.outgoing;
      return !!out && out.locoId === it.locoId && (out.departed || (v.mode === 'ab' ? v.remoteInstrument !== 'LB' : v.tokenWithdrawnHere));
    }
    const inc = v.incoming;
    return !!inc && inc.locoId === it.locoId && (inc.departed || inc.acceptedAt !== null);
  }

  /** Take a move back out of the boxes before it has left: cancel its offer or its declared departure. */
  private withdraw(it: RunItem): string | null {
    if (it.state !== 'active') return null;
    const s = it.segs[it.seg];
    if (s && (s.kind === 'incoming' || s.kind === 'through')) {
      const c = s.ctrl;
      const inc = c?.view.incoming;
      if (inc && inc.locoId === it.locoId) {
        if (inc.departed) return 'It is already on its way: let it finish.';
        c!.cancelIncoming();
      }
    }
    if (s && s.kind === 'outgoing') {
      const out = s.ctrl?.view.outgoing;
      if (out && out.locoId === it.locoId) {
        if (out.departed) return 'It is already on its way: let it finish.';
        s.ctrl!.setOutgoing(null, null);
      }
    }
    for (const x of it.segs) this.detach(x);
    return null;
  }

  // ------------------------------------------------------------------ the loop

  /** Release what is due and move active items on. Called every second and on demand (poke). */
  tick(): void {
    if (!this.tt || !this.started || this.disposed) return;
    // Offering a train changes the box, which pokes the runner again: finish this pass first.
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        this.pass();
      } while (this.again);
    } finally {
      this.ticking = false;
    }
    this.emit();
  }

  private ticking = false;
  private again = false;

  private pass(): void {
    if (!this.tt) return;
    // Nothing happens until the boxes being worked are open with every neighbour: a train offered while
    // the signaller is still opening the box on another line would be refused before they could answer.
    if (!this.begun) {
      if (this.waitingForOpen()) return;
      this.begun = true;
      this.startedAt = this.o.scheduler.now();
      this.pausedTotal = 0;
      if (this.pausedAt !== null) this.pausedAt = this.startedAt;
      if (this.layoutBoxes().length) this.note(`${this.layoutBoxes().map((b) => b.name).join(' and ')} open: ${this.tt.name} begins${this.tt.timing === 'session' ? ` (clock ${fmt(this.clockNow())})` : ''}.`);
    }
    this.topUp();
    for (const it of this.items) if (it.state === 'active') this.checkSeg(it);
    if (!this.paused) {
      for (const it of this.items) {
        if (it.state !== 'waiting') continue;
        if (this.canRelease(it)) this.activate(it);
      }
    }
    this.logProgress();
    if (!this.endless && !this.finished && this.items.length && this.items.every((it) => it.state === 'done' || it.state === 'skipped')) {
      this.finished = true;
      this.note(`${this.tt.name}: every move has run.`);
    }
  }

  /** Something changed in a box (a line cleared, the box opened): check now rather than at the next tick. */
  poke(): void {
    this.tick();
  }

  /**
   * The timetable log follows each move as it is worked: every change in a move's progress (offered,
   * accepted, on its way, sent on, arrived, waiting for the line…) is written once.
   */
  private logProgress(): void {
    for (const it of this.items) {
      if (it.state !== 'active' || !it.status || it.status === it.logged) continue;
      it.logged = it.status;
      this.note(`${this.shortName(it)}: ${it.card ? it.card.text : it.status}`);
    }
  }

  /** "1E01", else the train's name, else "Positioning". */
  private shortName(it: RunItem): string {
    return it.entry.headcode || it.train?.name || (it.positioning ? 'Positioning' : 'Note');
  }

  /** Boxes on the layout that are being worked (their screens have been opened). */
  private layoutBoxes() {
    return this.state.boxes.filter((b) => b.layoutId === this.o.layoutId && this.o.box(b.id));
  }

  /** The name of a box being worked that is not yet open on every line, while the timetable waits for it; else null. */
  waitingForOpen(): string | null {
    if (!this.started || this.begun) return null;
    for (const b of this.layoutBoxes()) {
      const rb = this.o.box(b.id);
      if (rb && !rb.sessions.every((x) => x.controller.view.boxOpen)) return b.name;
    }
    return null;
  }

  private blockedByTrain(it: RunItem): RunItem | null {
    const key = this.unitOf(it);
    const i = this.items.indexOf(it);
    for (let j = 0; j < i; j++) {
      const x = this.items[j];
      if ((x.state === 'waiting' || x.state === 'active') && key && this.unitOf(x) === key) return x;
    }
    return null;
  }

  private canRelease(it: RunItem): boolean {
    if (this.blockedByTrain(it)) return false;
    if (it.positioning) return true;
    const tt = this.tt!;
    // Positioning moves come first.
    if (this.items.some((x) => x.positioning && (x.state === 'waiting' || x.state === 'active'))) return false;
    if (tt.timing === 'sequence') {
      return this.items.every((x) => x.positioning || x.finishing || x.step >= it.step || x.state === 'done' || x.state === 'skipped');
    }
    if (it.entry.dep === null) {
      const i = this.items.indexOf(it);
      const prev = this.items.slice(0, i).reverse().find((x) => !x.positioning && !x.finishing);
      return !prev || prev.state === 'done' || prev.state === 'skipped';
    }
    const now = this.clockNow() ?? 0;
    return it.entry.dep <= now + 1e-9;
  }

  private activate(it: RunItem): void {
    if (!this.resolveLoco(it)) {
      it.status = `Waiting for a loco: none with a job for ${this.typeName(it.train?.anyWorking ?? it.entry.trainTypeId).toLowerCase()} is free${it.entry.from.placeId ? ` at ${refText(this.state, it.entry.from)}` : ''}.`;
      return;
    }
    const now = this.clockNow();
    it.late = now !== null && it.entry.dep !== null ? Math.max(0, Math.floor(now - it.entry.dep)) : null;
    it.state = 'active';
    it.startedAt = this.o.scheduler.now();
    this.applyWorking(it);
    it.segs = this.segmentsFor(it);
    it.seg = 0;
    this.note(`${it.forced ? 'Released' : 'Due'}${it.late ? ` (${it.late} min late)` : ''}: ${this.describe(it)}.`);
    if (!it.segs.length) return this.finish(it);
    this.startSeg(it);
  }

  private finish(it: RunItem): void {
    for (const s of it.segs) this.detach(s);
    this.setState(it, 'done', 'Done.');
    this.note(`Done: ${this.describe(it)}.`);
    // A through route set for this train goes back to the box's default afterwards.
    this.emit();
  }

  // ------------------------------------------------------------------ locos and workings

  private unitOf(it: RunItem): string {
    if (it.locoId) return `loco:${it.locoId}`;
    if (it.train?.locoId) return `loco:${it.train.locoId}`;
    const chosen = it.train ? this.anyLoco.get(it.train.id) : undefined;
    if (chosen) return `loco:${chosen}`;
    return it.train ? `train:${it.train.id}` : '';
  }

  /** Choose the loco for a move (an "any loco" train gets one with the job, preferably where the move starts). */
  private resolveLoco(it: RunItem): boolean {
    if (it.locoId) return true;
    if (it.entry.kind === 'note' && !it.train) return true;
    const st = this.state;
    if (it.train?.locoId) {
      it.locoId = st.roster.some((l) => l.id === it.train!.locoId) ? it.train.locoId : null;
      return !!it.locoId || it.entry.kind === 'note';
    }
    if (!it.train) return it.entry.kind === 'note';
    const chosen = this.anyLoco.get(it.train.id);
    if (chosen) {
      it.locoId = chosen;
      return true;
    }
    const busy = new Set<string>();
    for (const x of this.items) if ((x.state === 'active' || x.state === 'waiting') && x !== it) {
      const id = x.locoId ?? x.train?.locoId ?? (x.train ? this.anyLoco.get(x.train.id) : undefined);
      if (id) busy.add(id);
    }
    const cands = locosFor(st, it.train.anyWorking).filter((l) => !busy.has(l.id));
    const at = (l: Loco) => {
      const loc = l.location;
      if (it.entry.kind === 'enter') return loc.kind === 'offLayout' ? 2 : 0;
      if (loc.kind !== 'place' || loc.placeId !== it.entry.from.placeId) return 0;
      return !it.entry.from.roadId || loc.roadId === it.entry.from.roadId ? 2 : 1;
    };
    const best = [...cands].sort((a, b) => at(b) - at(a))[0];
    if (!best || at(best) === 0) return false;
    this.anyLoco.set(it.train.id, best.id);
    it.locoId = best.id;
    return true;
  }

  private applyWorking(it: RunItem): void {
    if (!it.locoId || it.entry.kind === 'note') return;
    const w: Partial<Working> = { trainTypeId: it.entry.trainTypeId, headcode: it.entry.headcode };
    if (it.train?.consist && it.entry.trainTypeId !== 'light_engine') w.consist = it.train.consist;
    this.o.setWorking(it.locoId, w);
  }

  // ------------------------------------------------------------------ segments

  /** The segments a move is worked as, from its route through the boxes (stopping where it calls). */
  segmentsFor(it: RunItem): Segment[] {
    const e = it.entry;
    const st = this.state;
    const layout = this.layout;
    const autoMs = (from: number | null, to: number | null) => (from !== null && to !== null && this.tt && this.tt.timing !== 'sequence' ? Math.max(5_000, ((to - from) * 60_000) / Math.max(1, this.tt.speed)) : (this.o.autoMoveMs ?? AUTO_MS));
    if (e.kind === 'note') return [{ kind: 'note' }];
    if (e.kind === 'enter') return [{ kind: 'auto', dest: refPos(e.to), ms: autoMs(e.dep, e.arr) }];
    if (e.kind === 'leave') return [{ kind: 'auto', dest: { kind: 'off' }, ms: autoMs(e.dep, e.arr) }];
    if (!layout) return [];
    const target = e.to.placeId ? e.to : e.from;
    // Stop points: where it starts, places it stops at on the way, where it ends.
    const points: PlaceRef[] = [e.from, ...(e.kind === 'run' ? e.calls.filter((c) => c.stop && c.placeId) : []), target];
    const segs: Segment[] = [];
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k];
      const b = points[k + 1];
      if (a.placeId === b.placeId && a.roadId === b.roadId && k + 1 < points.length - 1) continue;
      const legs = routeBetween(st, layout, a.placeId, b.placeId);
      if (!legs) {
        segs.push({ kind: 'auto', dest: refPos(b), ms: autoMs(e.dep, e.arr) });
        continue;
      }
      if (!legs.length) {
        // Within one place (another road, or a change of working where it stands).
        const box = this.boxWorking(b.placeId);
        segs.push(box ? { kind: 'shunt', boxId: box, dest: refPos(b) } : { kind: 'auto', dest: refPos(b), ms: autoMs(e.dep, e.arr) });
        continue;
      }
      segs.push(...this.legsToSegments(legs, b));
    }
    return segs;
  }

  private legsToSegments(legs: RouteLeg[], target: PlaceRef): Segment[] {
    const st = this.state;
    const out: Segment[] = [];
    const farOf = (boxId: string, connId: string): TtPos => {
      const placeId = st.boxes.find((b) => b.id === boxId)?.connections.find((c) => c.id === connId)?.placeId ?? '';
      return placeId ? { kind: 'place', placeId, roadId: placeId === target.placeId ? target.roadId : '' } : { kind: 'off' };
    };
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const next = legs[i + 1];
      if (l.kind === 'line' && l.dir === 'in') {
        if (next?.kind === 'line' && next.dir === 'out' && next.boxId === l.boxId) {
          out.push({ kind: 'through', boxId: l.boxId, fromConnId: l.connectionId, toConnId: next.connectionId, dest: farOf(next.boxId, next.connectionId), phase: 'wait' });
          i++;
          continue;
        }
        // Stops at the box: in to one of its places (the next local leg), or at the box.
        const placeId = next?.kind === 'local' && next.boxId === l.boxId ? next.toPlaceId : '';
        if (placeId) i++;
        const dest: TtPos = placeId ? { kind: 'place', placeId, roadId: placeId === target.placeId ? target.roadId : '' } : { kind: 'place', placeId: target.placeId, roadId: target.roadId };
        out.push({ kind: 'incoming', boxId: l.boxId, connId: l.connectionId, dest, phase: 'wait' });
        continue;
      }
      if (l.kind === 'local') {
        if (next?.kind === 'line' && next.dir === 'out' && next.boxId === l.boxId) {
          out.push({ kind: 'outgoing', boxId: l.boxId, connId: next.connectionId, dest: farOf(next.boxId, next.connectionId), phase: 'wait' });
          i++;
          continue;
        }
        if (l.toPlaceId) out.push({ kind: 'shunt', boxId: l.boxId, dest: { kind: 'place', placeId: l.toPlaceId, roadId: l.toPlaceId === target.placeId ? target.roadId : '' } });
        continue;
      }
      // A line out with no local stage first (the train stands at the box).
      out.push({ kind: 'outgoing', boxId: l.boxId, connId: l.connectionId, dest: farOf(l.boxId, l.connectionId), phase: 'wait' });
    }
    return out;
  }

  /** A box you work that works this place, if any. */
  private boxWorking(placeId: string): string | null {
    const p = this.layout?.places.find((x) => x.id === placeId);
    return p?.workedBy.find((w) => w.kind === 'box')?.boxId ?? null;
  }

  private startSeg(it: RunItem): void {
    const s = it.segs[it.seg];
    if (!s) return this.finish(it);
    it.card = null;
    const st = this.state;
    const who = this.locoName(it.locoId);
    switch (s.kind) {
      case 'note':
        it.card = { kind: 'note', text: it.entry.notes || 'Timetable note.' };
        it.status = 'Note: press OK once done.';
        break;
      case 'shunt': {
        const rb = this.o.box(s.boxId);
        if (!rb) return this.startAuto(it, { kind: 'auto', dest: s.dest, ms: this.o.autoMoveMs ?? AUTO_MS }, s);
        const same = it.entry.from.placeId === it.entry.to.placeId && it.entry.from.roadId === it.entry.to.roadId;
        it.card = { kind: 'shunt', text: same ? `${who}: now ${this.typeName(it.entry.trainTypeId).toLowerCase()} where it stands (${refText(st, it.entry.from)}).${it.entry.notes ? ` ${it.entry.notes}` : ''}` : `Shunt ${who} (${this.typeName(it.entry.trainTypeId).toLowerCase()}) from ${refText(st, it.entry.from)} to ${posText(st, s.dest)}.${it.entry.notes ? ` ${it.entry.notes}` : ''}` };
        it.status = 'Shunt: press Done once it is there.';
        break;
      }
      case 'auto':
        return this.startAuto(it, s, null);
      case 'incoming':
      case 'through':
      case 'outgoing':
        if (!this.o.box(s.boxId)) {
          const auto: Segment = { kind: 'auto', dest: s.dest, ms: this.o.autoMoveMs ?? AUTO_MS };
          it.segs[it.seg] = auto;
          return this.startAuto(it, auto, null);
        }
        this.checkSeg(it);
        break;
    }
    this.emit();
  }

  private startAuto(it: RunItem, s: Extract<Segment, { kind: 'auto' }>, replaced: Segment | null): void {
    if (replaced) it.segs[it.seg] = s;
    const st = this.state;
    const who = this.locoName(it.locoId);
    const what =
      it.entry.kind === 'enter'
        ? `Put ${who} on to the layout at ${posText(st, s.dest)}`
        : it.entry.kind === 'leave' || s.dest.kind === 'off'
          ? `Take ${who} off the layout (from ${refText(st, it.entry.from)})`
          : `Move ${who} to ${posText(st, s.dest)}`;
    if (this.operator === 'me') {
      it.card = { kind: 'operator', text: `${what}${it.entry.notes ? `. ${it.entry.notes}` : ''}.` };
      it.status = 'Waiting for you (fiddle yard operator): press Done once it is there.';
    } else {
      s.endsAt = this.o.scheduler.now() + s.ms;
      s.timer = this.o.scheduler.setTimeout(() => {
        s.timer = undefined;
        if (it.state === 'active' && it.segs[it.seg] === s) this.completeSeg(it);
      }, s.ms);
      it.status = `${what} (simulated operator).`;
    }
    this.emit();
  }

  /** Work a signalled segment on: offer it, declare it, and notice when it has finished. */
  private checkSeg(it: RunItem): void {
    const s = it.segs[it.seg];
    if (!s || !it.locoId) return;
    if (s.kind !== 'incoming' && s.kind !== 'through' && s.kind !== 'outgoing') return;
    const rb = this.o.box(s.boxId);
    const st = this.state;
    const box = st.boxes.find((b) => b.id === s.boxId);
    if (!rb) {
      // The box stopped being worked (closed and reset): start this stage again when it is.
      this.detach(s);
      s.phase = 'wait';
      it.status = `Waiting for ${box?.name ?? 'the box'} to be opened.`;
      return;
    }
    const connId = s.kind === 'through' ? s.fromConnId : s.connId;
    const sess = rb.sessions.find((x) => x.connection.id === connId);
    if (!sess) {
      it.status = 'The line it runs on is no longer there.';
      return;
    }
    const c = sess.controller;
    if (s.ctrl && s.ctrl !== c) {
      // The box was rebuilt (closed, or its configuration changed): the move starts again.
      this.detach(s);
      s.phase = 'wait';
    }
    const name = sess.connection.neighbourName;
    const v = c.view;
    const allOpen = rb.sessions.every((x) => x.controller.view.boxOpen);
    const notOpen = `Waiting for ${box?.name ?? 'the box'} to be opened on every line (call attention, then 5-5-5 to each box).`;
    if (s.phase === 'cancelled') {
      it.status = `Cancelled in the box. Release it to offer it again, or skip it.`;
      return;
    }
    if (s.kind === 'incoming' || s.kind === 'through') {
      if (s.phase === 'requested') {
        const toSess = s.kind === 'through' ? rb.sessions.find((x) => x.connection.id === s.toConnId) : undefined;
        const out = toSess?.controller.view.outgoing;
        const onward = !!out && out.locoId === it.locoId;
        const toName = toSess?.connection.neighbourName ?? '';
        if (s.kind === 'through' && onward && out!.departed) {
          // Sent on into the section ahead: it is on its way to the far end.
          this.autoArrive(it, s, toSess!.controller, toName);
          if (v.incoming && v.incoming.locoId === it.locoId && !v.incoming.arrived) it.status = `Sent on to ${toName}: report it passed complete and send 2-1 to ${name}. ${it.status}`;
          return;
        }
        if (v.incoming && v.incoming.locoId === it.locoId) {
          const inc = v.incoming;
          const accepted = inc.acceptedAt !== null || inc.departed;
          if (inc.departed) {
            // When it should reach the box: from its timetabled running time (there is no track to watch it on yet).
            if (s.departedAt === undefined) {
              s.departedAt = this.o.scheduler.now();
              s.atBoxAt = s.departedAt + this.runToBox(it, s.boxId, s.kind === 'through');
            }
            const at = s.atBoxAt ?? 0;
            const here = box?.name ?? 'your box';
            const now = this.o.scheduler.now();
            it.status =
              s.kind === 'through'
                ? now < at
                  ? `On its way from ${name}, through to ${toName}: due to pass ${here} at about ${clock(at)}.`
                  : `Passing ${here} now: send 2 (Train entering section) to ${toName}, then report it passed complete.`
                : now < at
                  ? `On its way from ${name}: due at ${here} at about ${clock(at)}.`
                  : inc.arrived
                    ? `Arrived at ${here}: send 2-1 to ${name}.`
                    : `Due at ${here} now: report "Train arrived complete" once its tail lamp is in.`;
          }
          else if (inc.held) it.status = `Held at ${name}: offered, not yet accepted.`;
          else if (accepted) it.status = s.kind === 'through' ? `Accepted from ${name}: offer it on to ${toName}.` : `Accepted from ${name}.`;
          else it.status = `Being offered by ${name}.`;
          return;
        }
        if (s.kind === 'through' && onward) {
          it.status = `Standing at ${box?.name ?? 'the box'}: offer it on to ${toName}.`;
          return;
        }
        // Gone from the line without clearing: the signaller (or operator) cancelled it.
        const loco = st.roster.find((l) => l.id === it.locoId);
        if (loco?.location.kind !== 'section') {
          this.detach(s);
          s.phase = 'cancelled';
          it.status = `Cancelled in the box. Release it to offer it again, or skip it.`;
          this.note(`Cancelled in ${box?.name ?? 'the box'}: ${this.describe(it)}.`);
        }
        return;
      }
      if (!allOpen) {
        it.status = notOpen;
        return;
      }
      if (v.incoming) {
        it.status = `Waiting: ${name} is already offering another train.`;
        return;
      }
      const err = c.requestIncoming(it.locoId, it.entry.trainTypeId);
      if (err) {
        it.status = `Waiting: ${err}`;
        return;
      }
      rb.workings.setRoute(connId, s.kind === 'through' ? s.toConnId : '');
      s.phase = 'requested';
      s.ctrl = c;
      if (s.kind === 'incoming') {
        s.off = c.events.on('sectionCleared', (e) => {
          if (e.direction === 'incoming' && it.state === 'active' && it.segs[it.seg] === s) this.completeSeg(it);
        });
      } else {
        const toSess = rb.sessions.find((x) => x.connection.id === s.toConnId);
        s.off = toSess?.controller.events.on('sectionCleared', (e) => {
          if (e.direction === 'outgoing' && e.locoId === it.locoId && it.state === 'active' && it.segs[it.seg] === s) {
            rb.workings.setRoute(connId, rb.workings.defaultRoute(connId));
            this.completeSeg(it);
          }
        });
      }
      it.status = `Being offered by ${name}.`;
      c.note('status', `Timetable: ${this.registerText(it)}`);
      this.note(`${name} offers ${this.locoName(it.locoId)} (${this.typeName(it.entry.trainTypeId).toLowerCase()}).`);
      return;
    }
    // Outgoing: declare it for the Departure panel; it ends when the far box clears it back.
    if (s.phase === 'requested') {
      const out = v.outgoing;
      if (out?.departed && out.locoId === it.locoId) this.autoArrive(it, s, c, name);
      else if (!out) {
        // The departure was cleared in the box before it left: declare it again.
        c.setOutgoing(it.locoId, it.entry.trainTypeId);
        it.status = `Due to depart to ${name}.`;
      } else if (out.locoId !== it.locoId) it.status = `Waiting: another train is chosen to depart to ${name}.`;
      else it.status = `Due to depart to ${name}: offer it.`;
      return;
    }
    if (!allOpen) {
      it.status = notOpen;
      return;
    }
    if (v.outgoing && v.outgoing.locoId !== it.locoId) {
      it.status = `Waiting: another train is chosen to depart to ${name}.`;
      return;
    }
    if (!v.outgoing) c.setOutgoing(it.locoId, it.entry.trainTypeId);
    s.phase = 'requested';
    s.ctrl = c;
    s.off = c.events.on('sectionCleared', (e) => {
      if (e.direction === 'outgoing' && e.locoId === it.locoId && it.state === 'active' && it.segs[it.seg] === s) this.completeSeg(it);
    });
    it.status = `Due to depart to ${name}: offer it.`;
    c.note('status', `Timetable: ${this.registerText(it)}`);
    this.note(`Due to depart: ${this.locoName(it.locoId)} to ${name}.`);
  }

  /**
   * A train on its way to a simulated box's place (sent from your box, or sent on through it). With a
   * simulated fiddle yard operator it is reported arrived (on its timetabled road, else a free one)
   * after its running time; with you as operator you press "Arrived in …" yourself.
   */
  private autoArrive(it: RunItem, s: Extract<Segment, { kind: 'through' | 'outgoing' }>, c: SectionController, name: string): void {
    const out = c.view.outgoing;
    if (!out || out.locoId !== it.locoId) return;
    const dest = s.dest;
    const where = dest.kind === 'place' ? (this.layout?.places.find((p) => p.id === dest.placeId)?.name ?? name) : name;
    if (out.arrived) {
      if (s.arriveTimer !== undefined) this.o.scheduler.clearTimeout(s.arriveTimer);
      s.arriveTimer = undefined;
      it.status = `Arrived at ${where}: waiting for ${name} to clear it back (answer 1, then repeat 2-1).`;
      return;
    }
    if (this.operator !== 'simulated') {
      it.status = `On its way to ${where}. Press "Arrived" in the Departure panel once it is there.`;
      return;
    }
    if (s.arriveTimer === undefined) {
      const tt = this.tt;
      const e = it.entry;
      const run = tt && tt.timing !== 'sequence' && e.dep !== null && e.arr !== null ? ((e.arr - e.dep) * 60_000) / Math.max(1, tt.speed) : (this.o.autoMoveMs ?? AUTO_MS);
      const ms = Math.max(8_000, s.kind === 'through' ? run / 2 : run);
      s.arriveAt = this.o.scheduler.now() + ms;
      s.arriveTimer = this.o.scheduler.setTimeout(() => {
        s.arriveTimer = undefined;
        const o2 = c.view.outgoing;
        if (it.state !== 'active' || it.segs[it.seg] !== s || !o2 || o2.locoId !== it.locoId || !o2.departed || o2.arrived) return;
        c.confirmOutgoingArrived(this.arrivalRoad(s.dest, c), it.locoId);
        this.note(`Simulated fiddle yard operator: ${this.locoName(it.locoId)} arrived at ${where}.`);
        this.tick();
      }, ms);
    }
    it.status = `On its way to ${where}: the simulated operator reports it arrived at about ${clock(s.arriveAt ?? this.o.scheduler.now())} (or press "Arrived" yourself).`;
  }

  /** The road a train sent to a far place arrives on: its timetabled road if free, else the first free road. */
  private arrivalRoad(dest: TtPos, c: SectionController): string {
    const st = this.state;
    if (dest.kind !== 'place') return '';
    const place = this.layout?.places.find((p) => p.id === dest.placeId);
    if (!place?.roads.length) return '';
    const taken = new Set(st.roster.flatMap((l) => (l.location.kind === 'place' && l.location.placeId === place.id ? [l.location.roadId] : [])));
    void c;
    if (dest.roadId && place.roads.some((r) => r.id === dest.roadId) && !taken.has(dest.roadId)) return dest.roadId;
    return place.roads.find((r) => !taken.has(r.id))?.id ?? dest.roadId ?? place.roads[0].id;
  }

  /**
   * How long after leaving the box in rear a train reaches (or passes) your box: from the timetable
   * (the time it calls at or passes your box's place, else its arrival; a through train with no call
   * there is taken to be half way), at the session clock's speed; 20 s (10 s through) in a sequence.
   */
  private runToBox(it: RunItem, boxId: string, through: boolean): number {
    const tt = this.tt;
    const e = it.entry;
    const auto = this.o.autoMoveMs ?? AUTO_MS;
    if (!tt || tt.timing === 'sequence' || e.dep === null) return Math.max(8_000, through ? auto / 2 : auto);
    const mine = new Set(this.layout?.places.filter((p) => p.workedBy.some((w) => w.kind === 'box' && w.boxId === boxId)).map((p) => p.id));
    const call = e.calls.find((c) => mine.has(c.placeId));
    const t = call ? (call.arr ?? call.dep) : null;
    const min = t !== null ? t - e.dep : e.arr !== null ? (through ? (e.arr - e.dep) / 2 : e.arr - e.dep) : null;
    if (min === null || min <= 0) return Math.max(8_000, through ? auto / 2 : auto);
    return Math.max(8_000, (min * 60_000) / Math.max(1, tt.speed));
  }

  /** When the timetabled train on a line should reach or pass your box, if it is on its way. */
  dueAtBox(boxId: string, connId: string): { at: number; through: boolean } | null {
    const f = this.forLine(boxId, connId);
    if (!f || (f.seg.kind !== 'incoming' && f.seg.kind !== 'through')) return null;
    if (f.seg.kind === 'through' && f.seg.fromConnId !== connId) return null;
    return f.seg.atBoxAt !== undefined ? { at: f.seg.atBoxAt, through: f.seg.kind === 'through' } : null;
  }

  /** When the simulated operator will report the train on a line arrived, if they will. */
  autoArrivalAt(boxId: string, connId: string): number | null {
    const f = this.forLine(boxId, connId);
    if (!f || (f.seg.kind !== 'outgoing' && f.seg.kind !== 'through')) return null;
    if (f.seg.kind === 'through' && f.seg.toConnId !== connId) return null;
    return f.seg.arriveTimer !== undefined ? (f.seg.arriveAt ?? null) : null;
  }

  /** "1E01 The Express (6233), due 09:00": for the train register. */
  private registerText(it: RunItem): string {
    const due = this.tt && this.tt.timing !== 'sequence' && it.entry.dep !== null ? `, due ${fmt(it.entry.dep)}` : '';
    return `${[it.entry.headcode, it.train?.name ?? (it.positioning ? 'positioning move' : '')].filter(Boolean).join(' ')} (${this.locoName(it.locoId)}) to ${refText(this.state, it.entry.to.placeId ? it.entry.to : it.entry.from)}${due}${it.late ? `, ${it.late} min late` : ''}`;
  }

  private completeSeg(it: RunItem): void {
    const s = it.segs[it.seg];
    if (!s) return;
    this.detach(s);
    // Moves the boxes do not signal: the runner moves the loco itself.
    if ((s.kind === 'auto' || s.kind === 'shunt') && it.locoId) this.o.moveLoco(it.locoId, posLocation(s.dest));
    it.card = null;
    it.seg++;
    if (it.seg >= it.segs.length) this.finish(it);
    else this.startSeg(it);
    this.tick();
  }

  private detach(s: Segment): void {
    if ('off' in s && s.off) {
      s.off();
      s.off = undefined;
    }
    if (s.kind === 'auto' && s.timer !== undefined) {
      this.o.scheduler.clearTimeout(s.timer);
      s.timer = undefined;
    }
    if ((s.kind === 'outgoing' || s.kind === 'through') && s.arriveTimer !== undefined) {
      this.o.scheduler.clearTimeout(s.arriveTimer);
      s.arriveTimer = undefined;
    }
  }

  // ------------------------------------------------------------------ for the box screen

  /** The move a box's line is working for the timetable, if any (for the desk and next step). */
  forLine(boxId: string, connId: string): { item: RunItem; seg: Segment } | null {
    for (const it of this.items) {
      if (it.state !== 'active') continue;
      const s = it.segs[it.seg];
      if (!s || !('boxId' in s) || s.boxId !== boxId) continue;
      if ((s.kind === 'incoming' || s.kind === 'outgoing') && s.connId === connId) return { item: it, seg: s };
      if (s.kind === 'through' && (s.fromConnId === connId || s.toConnId === connId)) return { item: it, seg: s };
    }
    return null;
  }

  /** Where an arriving train should go (its timetabled road), if the timetable says. */
  arrivalHint(boxId: string, connId: string, locoId: string): PlaceRef | null {
    const f = this.forLine(boxId, connId);
    if (!f || f.item.locoId !== locoId || f.seg.kind !== 'incoming' || f.seg.dest.kind !== 'place') return null;
    return { placeId: f.seg.dest.placeId, roadId: f.seg.dest.roadId };
  }

  /** The road a departing train should be put on at the far end, if the timetable says. */
  departureRoad(boxId: string, connId: string, locoId: string): string {
    const f = this.forLine(boxId, connId);
    if (!f || f.item.locoId !== locoId || (f.seg.kind !== 'outgoing' && f.seg.kind !== 'through') || f.seg.dest.kind !== 'place') return '';
    return f.seg.dest.roadId;
  }

  /** Next step guidance for a box (learner): a departure that is due and not yet offered. */
  guidance(boxId: string): { text: string; connId: string } | null {
    const st = this.state;
    const set = st.codeSets.find((c) => c.id === st.settings.codeSetId) ?? st.codeSets[0];
    for (const it of this.items) {
      if (it.state !== 'active') continue;
      const s = it.segs[it.seg];
      if (s?.kind !== 'outgoing' || s.boxId !== boxId || s.phase !== 'requested' || !s.ctrl) continue;
      const v = s.ctrl.view;
      const accepted = v.mode === 'ab' ? v.remoteInstrument !== 'LB' : v.tokenWithdrawnHere || v.releaseAvailable;
      if (v.outgoing?.locoId !== it.locoId || v.outgoing.departed || accepted || v.incoming) continue;
      const code = trainCode(set, it.entry.trainTypeId);
      const conn = st.boxes.find((b) => b.id === boxId)?.connections.find((c) => c.id === s.connId);
      return { connId: s.connId, text: `Timetable: ${it.entry.headcode ? `${it.entry.headcode} ` : ''}${this.locoName(it.locoId)} is due to depart to ${conn?.neighbourName ?? 'the next box'}. Offer it: call attention (${signalCode(set, 'call_attention')}), then ${code || 'its Is line clear code'}.` };
    }
    return null;
  }

  // ------------------------------------------------------------------ helpers

  private itemsFor(tt: Timetable): RunItem[] {
    const layout = this.layout;
    const w = layout ? walkTimetable(this.state, layout, tt) : null;
    return tt.entries.map((e, i) => this.itemFor(tt, e, w?.steps[i]?.step ?? i + 1));
  }

  private itemFor(tt: Timetable, e: TimetableEntry, step: number): RunItem {
    return {
      id: e.id,
      entry: structuredClone(e),
      train: findTrain(tt, e.trainId) ?? null,
      positioning: false,
      finishing: false,
      step,
      state: 'waiting',
      locoId: null,
      segs: [],
      seg: 0,
      status: '',
      card: null,
      late: null,
      forced: false,
      startedAt: null,
      doneAt: null,
    };
  }

  private positioningItem(p: Positioning): RunItem {
    return { id: p.entry.id, entry: p.entry, train: null, positioning: true, finishing: false, step: 0, state: 'waiting', locoId: p.locoId, segs: [], seg: 0, status: '', card: null, late: null, forced: false, startedAt: null, doneAt: null };
  }

  private setState(it: RunItem, s: ItemState, status: string): void {
    it.state = s;
    it.status = status;
    it.card = null;
    if (s === 'done' || s === 'skipped') it.doneAt = this.o.scheduler.now();
  }

  private locoName(id: string | null): string {
    const l = id ? this.state.roster.find((x) => x.id === id) : undefined;
    return l ? locoLabel(l) : 'the train';
  }

  private typeName(id: string): string {
    return this.state.trainTypes.find((t) => t.id === id)?.name ?? id;
  }

  /** "2W10 The Stopper (5025): ordinary passenger Fiddle Yard East · Road 1 → Sigsim Central · P2" */
  describe(it: RunItem): string {
    const st = this.state;
    const e = it.entry;
    const who = [e.headcode, it.train?.name ?? (it.positioning ? 'Positioning' : ''), it.locoId ? `(${this.locoName(it.locoId)})` : ''].filter(Boolean).join(' ');
    if (e.kind === 'note') return `${who ? `${who}: ` : ''}note${e.notes ? ` – ${e.notes}` : ''}`;
    if (e.kind === 'enter') return `${who}: on to the layout at ${refText(st, e.to)}`;
    if (e.kind === 'leave') return `${who}: off the layout from ${refText(st, e.from)}`;
    return `${who}: ${this.typeName(e.trainTypeId).toLowerCase()} ${refText(st, e.from)} → ${refText(st, e.to.placeId ? e.to : e.from)}`;
  }

  private note(text: string): void {
    const e = { t: this.o.scheduler.now(), text };
    this.log.push(e);
    if (this.log.length > 300) this.log.shift();
    this.events.emit('log', e);
  }

  private emit(): void {
    this.events.emit('change', undefined);
  }
}

/** "19:49:10" (local time) for a scheduler time. */
function clock(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function trainName(it: RunItem): string {
  return it.train?.name ?? 'The train';
}

function defaultMinutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export function fmt(min: number | null): string {
  if (min === null) return '';
  const m = Math.floor(((min % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function locoLabel(l: Loco): string {
  return [l.number, l.name].filter(Boolean).join(' ') || 'the loco';
}

const refPos = (r: PlaceRef): TtPos => ({ kind: 'place', placeId: r.placeId, roadId: r.roadId });

function posText(st: AppState, p: TtPos): string {
  return p.kind === 'off' ? 'off the layout' : refText(st, p);
}

function posLocation(p: TtPos): Location {
  return p.kind === 'off' ? { kind: 'offLayout' } : { kind: 'place', placeId: p.placeId, roadId: p.roadId };
}

function locPos(loc: Location): TtPos | null {
  if (loc.kind === 'offLayout') return { kind: 'off' };
  if (loc.kind === 'place') return { kind: 'place', placeId: loc.placeId, roadId: loc.roadId };
  return null;
}

/** Where a move leaves its loco. */
function endPos(e: TimetableEntry): TtPos | null {
  if (e.kind === 'note') return null;
  if (e.kind === 'leave') return { kind: 'off' };
  if (e.kind === 'shunt' && !e.to.placeId) return refPos(e.from);
  return refPos(e.to);
}

function samePos(a: TtPos, b: TtPos): boolean {
  if (a.kind === 'off' || b.kind === 'off') return a.kind === b.kind;
  return a.placeId === b.placeId && (!b.roadId || a.roadId === b.roadId);
}
