import { describeCode } from './bellcodes';
import type { ForwardBlock, LinkEnd, LinkMessage, RearBlock } from './link';
import type { ScoreRuleId } from './score';
import { Emitter, type Scheduler } from './scheduler';
import type { BellCode, CodeSet, InstrumentState, LineType, Location, TrainType, WorkingMode } from './types';

export interface LogEntry {
  t: number;
  /** register: the train register's entries (time offered, time accepted). */
  kind: 'bellIn' | 'bellOut' | 'status' | 'hint' | 'irregularity' | 'action' | 'register';
  text: string;
  code?: BellCode;
}

export type TokenIndicator = 'normal' | 'coming' | 'going';

export interface SectionView {
  mode: WorkingMode;
  lineType: LineType;
  neighbourName: string;
  neighbourShort: string;
  /** User's own instrument, for trains travelling towards the user's box. */
  myInstrument: InstrumentState;
  /** Repeater of the neighbour's instrument, for trains leaving the user's box. */
  remoteInstrument: InstrumentState;
  tokenIndicator: TokenIndicator;
  tokensInInstrument: number;
  /** A token has been withdrawn here and is with the signaller / driver. */
  tokenWithdrawnHere: boolean;
  /** Token received from an arriving driver, not yet put back in the instrument. */
  tokenInHand: boolean;
  /** Galvanometer needle deflected: neighbour holding plunger, a token can be withdrawn. */
  releaseAvailable: boolean;
  incoming: IncomingView | null;
  /** arrived: the operator has reported it arrived at the far end (reported once only). */
  outgoing: { locoId: string | null; trainTypeId: string | null; departed: boolean; arrived?: boolean } | null;
  guidance: string;
  /** The part of `guidance` about driving the train to the far end and reporting it arrived ('' if none). */
  guidanceDrive: string;
  /** The guidance is the idle "section is clear" kind: nothing being signalled on this line. */
  guidanceIdle: boolean;
  /** False until the box has been opened with the far box (5-5-5). */
  boxOpen: boolean;
  /**
   * Permission the far box has given to obstruct the line (v0.3.32): rear = this line blocked back
   * (2-4 inside the home signal, 3-3 outside it); forward = a shunt into the section (3-3-2) or a
   * token released for shunting (5-2). null = not given.
   */
  permission: { rear: RearBlock | null; forward: ForwardBlock | null };
}

/** The next incoming train, from being requested of the far box until it is out of section. */
export interface IncomingView {
  locoId: string;
  trainTypeId: string;
  departed: boolean;
  arrived: boolean;
  /** When its Is line clear first rang (scheduler time); null while the far box is still calling attention. */
  offeredAt: number | null;
  /** When it was accepted (Is line clear repeated); null until then. */
  acceptedAt: number | null;
  /** Refused (not accepted in time): the far box is holding it and will offer it again. */
  held: boolean;
  /** How many times it has been offered again after a refusal. */
  reoffers: number;
  /** While held: when the far box means to offer it again (scheduler time). */
  nextOfferAt: number | null;
}

export interface ControllerEvents extends Record<string, unknown> {
  change: SectionView;
  bellIn: { code: BellCode; holdLast: boolean };
  bellOut: { code: BellCode; holdLast: boolean };
  log: LogEntry;
  hint: { text: string; level: 'info' | 'warn' };
  locoMoved: { locoId: string; location: Location };
  /** Points gained or lost, as judged by the far box. */
  score: { rule: ScoreRuleId; detail: string; locoId: string | null };
  /** A train movement on this line has finished, judged clean or not by the far box. */
  movementJudged: { locoId: string | null; clean: boolean };
  /** The operator asked the far box to offer a train (Offer next incoming train). */
  incomingRequested: { locoId: string; trainTypeId: string };
  /** The signaller accepted the incoming train (repeated its Is line clear). */
  offerAccepted: { locoId: string; trainTypeId: string; offeredAt: number | null; at: number };
  /** A train movement on this line is complete (Train out of section exchanged). */
  sectionCleared: { direction: 'incoming' | 'outgoing'; locoId: string | null };
}

export interface ControllerOptions {
  link: LinkEnd;
  scheduler: Scheduler;
  boxId: string;
  connectionId: string;
  /** Fiddle yard at the far end, or '' when the far box serves a location on the layout. */
  farPlaceId: string;
  /** Words for the log: where trains sent along this line go ("Fiddle Yard", "Tansley Spa"). */
  farPlaceName?: string;
  mode: WorkingMode;
  lineType: LineType;
  neighbourName: string;
  neighbourShort: string;
  localShort: string;
  codeSet: () => CodeSet;
  trainTypes: () => TrainType[];
  /** Words for a train in the register, e.g. '7812 "Erlestoke Manor"'. */
  locoLabel?: (locoId: string | null) => string;
  tokensPerInstrument?: number;
}

/**
 * The user's end of one block section. It holds the user's instruments,
 * passes bells to/from the far box, and reports what happens.
 * Procedure checking lives in the far box (SimulatedNeighbour), as it would
 * in real life: the other signaller notices your mistakes.
 */
export class SectionController {
  readonly events = new Emitter<ControllerEvents>();
  readonly log: LogEntry[] = [];
  readonly irregularities: string[] = [];
  private v: SectionView;

  constructor(private o: ControllerOptions) {
    this.v = {
      mode: o.mode,
      lineType: o.lineType,
      neighbourName: o.neighbourName,
      neighbourShort: o.neighbourShort,
      myInstrument: 'LB',
      remoteInstrument: 'LB',
      tokenIndicator: 'normal',
      tokensInInstrument: o.tokensPerInstrument ?? 6,
      tokenWithdrawnHere: false,
      tokenInHand: false,
      releaseAvailable: false,
      incoming: null,
      outgoing: null,
      guidance: '',
      guidanceDrive: '',
      guidanceIdle: false,
      boxOpen: false,
      permission: { rear: null, forward: null },
    };
    o.link.onMessage((m) => this.onMessage(m));
  }

  get view(): SectionView {
    return this.v;
  }

  // -------------------------------------------------------------------------
  // User (signaller) actions
  // -------------------------------------------------------------------------

  sendBell(code: BellCode, holdLast = false): void {
    if (!code) return;
    this.addLog('bellOut', `${this.o.localShort} → ${this.o.neighbourShort}: ${code}${holdLast ? ' (last beat held)' : ''}  ${this.describe(code)}`, code);
    this.events.emit('bellOut', { code, holdLast });
    this.o.link.send({ type: 'bell', code, holdLast });
  }

  setInstrument(state: InstrumentState): void {
    if (this.v.myInstrument === state) return;
    this.v.myInstrument = state;
    this.addLog('action', `Block instrument turned to ${instrumentName(state)}`);
    this.o.link.send({ type: 'instrument', state });
    this.changed();
  }

  /** Returns an error message if the instrument is locked. */
  withdrawToken(): string | null {
    if (this.v.mode !== 'token') return 'Not in token working.';
    if (!this.v.releaseAvailable) return `The token instrument is locked. ${this.o.neighbourName} must give a release (hold the last beat of the Is line clear reply) first.`;
    if (this.v.tokensInInstrument <= 0) return 'No tokens left in this instrument.';
    this.v.tokensInInstrument--;
    this.v.tokenWithdrawnHere = true;
    this.v.releaseAvailable = false;
    this.v.tokenIndicator = 'going';
    this.addLog('action', 'Token withdrawn');
    this.o.link.send({ type: 'token', event: 'withdrawn' });
    this.changed();
    return null;
  }

  replaceToken(): string | null {
    if (this.v.mode !== 'token') return 'Not in token working.';
    if (this.v.tokenInHand) {
      this.v.tokenInHand = false;
      this.v.tokensInInstrument++;
      this.v.tokenIndicator = 'normal';
      this.addLog('action', 'Token from arriving train replaced in instrument');
      this.o.link.send({ type: 'token', event: 'replaced' });
      this.changed();
      return null;
    }
    if (this.v.tokenWithdrawnHere && !(this.v.outgoing?.departed ?? false)) {
      this.v.tokenWithdrawnHere = false;
      this.v.tokensInInstrument++;
      this.v.tokenIndicator = 'normal';
      this.addLog('action', 'Unused token replaced in instrument');
      this.o.link.send({ type: 'token', event: 'replaced' });
      this.changed();
      return null;
    }
    return 'You have no token to replace.';
  }

  /** Empty the train register / bell log and the irregularity count. */
  clearLog(): void {
    this.log.length = 0;
    this.irregularities.length = 0;
  }

  // -------------------------------------------------------------------------
  // Operator (layout) actions
  // -------------------------------------------------------------------------

  /** Ask the far box to offer this train to us. Returns an error message if not possible now. */
  requestIncoming(locoId: string, trainTypeId: string): string | null {
    if (!this.v.boxOpen) return 'Open the box first: tap 1 (call attention), then send 5-5-5 (Opening of signal box).';
    if (this.v.incoming) return 'An incoming train is already on its way.';
    const singleBusy = this.v.lineType === 'single' && (this.v.outgoing || this.v.tokenWithdrawnHere || this.v.remoteInstrument !== 'LB');
    if (singleBusy) return 'The single line is in use by an outgoing train. Wait until it is out of section.';
    this.v.incoming = { locoId, trainTypeId, departed: false, arrived: false, offeredAt: null, acceptedAt: null, held: false, reoffers: 0, nextOfferAt: null };
    this.addLog('action', `Next incoming train requested from ${this.o.neighbourName}`);
    this.o.link.send({ type: 'operator', action: 'offerIncoming', locoId, trainTypeId });
    this.changed();
    this.events.emit('incomingRequested', { locoId, trainTypeId });
    return null;
  }

  /** Tell the far box the signaller is free (another line has just been cleared): a train it is holding may be offered again now. */
  promptReoffer(): void {
    if (this.v.incoming?.held) this.o.link.send({ type: 'operator', action: 'promptReoffer' });
  }

  /** An entry in this line's train register made by the box itself (e.g. a regulating decision). */
  note(kind: 'irregularity' | 'status', text: string): void {
    if (kind === 'irregularity') this.irregularities.push(text);
    this.addLog(kind, text);
  }

  /** An irregularity seen on the layout itself (by the railway): kept in the register and scored, as if the far box had reported it. */
  penalise(rule: ScoreRuleId, text: string, locoId: string | null = null): void {
    this.irregularities.push(text);
    this.addLog('irregularity', text);
    this.events.emit('score', { rule, detail: '', locoId });
  }

  cancelIncoming(): void {
    if (!this.v.incoming || this.v.incoming.departed) return;
    this.o.link.send({ type: 'operator', action: 'cancelIncoming' });
    this.v.incoming = null;
    this.addLog('action', 'Incoming train cancelled by operator');
    this.changed();
  }

  // Train movements below are applied by the box's TrainEventRouter (core/trainEvents.ts): buttons and
  // the simulated fiddle yard operator report them through the box's source of train events, not here.

  /**
   * Operator has seen the incoming train arrive complete with tail lamp. `at` is where it now
   * stands: a road (or '' for anywhere) in a place this box works; null = at the box itself
   * (a box that works no place, or a through train standing at the box before it is sent on).
   */
  confirmIncomingArrived(at: { placeId: string; roadId: string } | null = null, opts: { moveLoco?: boolean } = {}): void {
    const inc = this.v.incoming;
    if (!inc || inc.arrived) return;
    inc.arrived = true;
    if (this.v.mode === 'token' && this.v.tokenIndicator === 'coming') this.v.tokenInHand = true;
    this.addLog('action', 'Incoming train arrived complete with tail lamp');
    this.o.link.send({ type: 'operator', action: 'arrivedLocal', locoId: inc.locoId });
    // A through train already sent on into the section ahead stays there (moveLoco false).
    if (opts.moveLoco !== false) this.events.emit('locoMoved', { locoId: inc.locoId, location: at?.placeId ? { kind: 'place', placeId: at.placeId, roadId: at.roadId } : { kind: 'atBox', boxId: this.o.boxId } });
    this.changed();
  }

  setOutgoing(locoId: string | null, trainTypeId: string | null): void {
    this.v.outgoing = locoId || trainTypeId ? { locoId, trainTypeId, departed: this.v.outgoing?.departed ?? false } : null;
    this.o.link.send({ type: 'operator', action: 'declareOutgoing', locoId, trainTypeId });
    this.changed();
  }

  /** Operator has driven the outgoing train into a fiddle yard road. */
  confirmOutgoingArrived(roadId: string, locoId: string | null): void {
    // Report an arrival once only: a second press would tell the far box about a train it has already seen arrive.
    // (Also ignored once the movement is complete, e.g. a press on a button that has not yet redrawn.)
    if (!this.v.outgoing || this.v.outgoing.arrived) return;
    this.v.outgoing.arrived = true;
    const id = locoId ?? this.v.outgoing?.locoId ?? null;
    this.addLog('action', `Outgoing train arrived ${this.o.farPlaceId ? `at ${this.o.farPlaceName ?? 'its place'}` : `at ${this.o.neighbourName}`}`);
    this.o.link.send({ type: 'operator', action: 'arrivedRemote', locoId: id, roadId });
    this.changed();
  }

  // -------------------------------------------------------------------------
  // From the far box
  // -------------------------------------------------------------------------

  private onMessage(m: LinkMessage): void {
    switch (m.type) {
      case 'bell':
        this.addLog('bellIn', `${this.o.neighbourShort} → ${this.o.localShort}: ${m.code}${m.holdLast ? ' (last beat held)' : ''}  ${this.describe(m.code)}`, m.code);
        this.events.emit('bellIn', { code: m.code, holdLast: m.holdLast });
        break;
      case 'instrument':
        this.v.remoteInstrument = m.state;
        this.changed();
        break;
      case 'release':
        this.v.releaseAvailable = m.active;
        this.changed();
        break;
      case 'permission': {
        const before = this.v.permission;
        this.v.permission = { rear: m.rear, forward: m.forward };
        if (before.rear !== m.rear) this.addLog('status', m.rear ? `Line blocked back (${m.rear === 'inside' ? 'inside the home signal' : 'outside the home signal'})` : 'Obstruction removed: line no longer blocked back');
        if (before.forward !== m.forward) this.addLog('status', m.forward ? (m.forward === 'shunt' ? 'Shunt into the forward section accepted' : 'Token released for shunting') : before.forward === 'shunt' ? 'Shunt withdrawn: section clear' : 'Shunting token replaced');
        this.changed();
        break;
      }
      case 'boxState':
        this.v.boxOpen = m.open;
        this.changed();
        break;
      case 'token':
        if (m.event === 'withdrawn') {
          this.v.tokenIndicator = 'coming';
        } else if (this.v.tokenWithdrawnHere) {
          // Our token has been put into the far instrument (train arrived there).
          this.v.tokenWithdrawnHere = false;
          this.v.tokenIndicator = 'normal';
        } else if (this.v.tokenIndicator === 'coming' && !this.v.tokenInHand) {
          this.v.tokenIndicator = 'normal'; // far box replaced its own token (cancelled)
        }
        this.changed();
        break;
      case 'trainDeparted':
        if (m.direction === 'incoming' && this.v.incoming) {
          this.v.incoming.departed = true;
          this.events.emit('locoMoved', { locoId: this.v.incoming.locoId, location: { kind: 'section', connectionId: this.o.connectionId } });
        } else if (m.direction === 'outgoing') {
          if (!this.v.outgoing) this.v.outgoing = { locoId: m.locoId, trainTypeId: null, departed: true };
          this.v.outgoing.departed = true;
          if (this.v.outgoing.locoId) {
            this.events.emit('locoMoved', { locoId: this.v.outgoing.locoId, location: { kind: 'section', connectionId: this.o.connectionId } });
          }
        }
        this.changed();
        break;
      case 'movementComplete':
        if (m.direction === 'incoming') {
          this.v.incoming = null;
          this.addLog('status', 'Incoming train complete: section clear of it.');
          this.events.emit('sectionCleared', { direction: 'incoming', locoId: m.locoId });
        } else {
          if (m.locoId) {
            // Into the place at the far end of the line (on the road chosen), or back to the roster when the line has none.
            this.events.emit('locoMoved', {
              locoId: m.locoId,
              location: this.o.farPlaceId ? { kind: 'place', placeId: this.o.farPlaceId, roadId: m.roadId ?? '' } : { kind: 'offLayout' },
            });
          }
          this.v.outgoing = null;
          this.addLog('status', 'Outgoing train complete: section clear of it.');
          this.events.emit('sectionCleared', { direction: 'outgoing', locoId: m.locoId });
        }
        this.changed();
        break;
      case 'offer':
        this.onOffer(m.state, m.reoffers, m.nextAt);
        break;
      case 'guidance':
        this.v.guidance = m.text;
        this.v.guidanceDrive = m.drive ?? '';
        this.v.guidanceIdle = !!m.idle;
        this.changed();
        break;
      case 'hint':
        this.addLog('hint', m.text);
        this.events.emit('hint', { text: m.text, level: m.level });
        break;
      case 'irregularity':
        this.irregularities.push(m.text);
        this.addLog('irregularity', m.text);
        break;
      case 'status':
        this.addLog('status', m.text);
        break;
      case 'movementJudged':
        this.events.emit('movementJudged', { locoId: m.locoId ?? null, clean: m.clean });
        break;
      case 'score':
        this.events.emit('score', { rule: m.rule, detail: m.detail ?? '', locoId: m.locoId ?? null });
        break;
      default:
        break;
    }
  }

  /** The far box's offer of the incoming train: offered, refused and held, or accepted. Kept in the train register. */
  private onOffer(state: 'offered' | 'held' | 'accepted', reoffers: number, nextAt?: number): void {
    const inc = this.v.incoming;
    if (!inc) return;
    const now = this.o.scheduler.now();
    const set = this.o.codeSet();
    const code = set.trainCodes[inc.trainTypeId]?.code ?? '';
    const train = `${this.o.locoLabel?.(inc.locoId) ?? 'train'}, ${(this.o.trainTypes().find((t) => t.id === inc.trainTypeId)?.name ?? 'train').toLowerCase()}`;
    inc.reoffers = reoffers;
    if (state === 'offered') {
      const first = inc.offeredAt === null;
      if (first) inc.offeredAt = now;
      inc.held = false;
      inc.nextOfferAt = null;
      this.addLog('register', first ? `Offered ${code}: ${train}` : `Offered again (${ordinal(reoffers + 1)} time) ${code}: ${train}`);
    } else if (state === 'held') {
      if (!inc.held) this.addLog('register', `Not accepted: ${train} held at ${this.o.neighbourName}`);
      inc.held = true;
      inc.nextOfferAt = nextAt ?? null;
    } else {
      inc.held = false;
      inc.nextOfferAt = null;
      inc.acceptedAt = now;
      const offered = inc.offeredAt ?? now;
      const waited = waitingText(now - offered);
      this.addLog('register', `Accepted ${code}: ${train} · offered ${clockTime(offered, true)} · accepted ${clockTime(now, true)}${waited ? ` · waited ${waited}` : ''}${reoffers ? ` · offered ${reoffers + 1} times` : ''}`);
      this.events.emit('offerAccepted', { locoId: inc.locoId, trainTypeId: inc.trainTypeId, offeredAt: inc.offeredAt, at: now });
    }
    this.changed();
  }

  // -------------------------------------------------------------------------

  private describe(code: BellCode): string {
    const d = describeCode(code, this.o.codeSet(), this.o.trainTypes());
    return d === 'Unrecognised code' ? '(unrecognised)' : `(${d})`;
  }

  private addLog(kind: LogEntry['kind'], text: string, code?: BellCode): void {
    const e: LogEntry = { t: this.o.scheduler.now(), kind, text, code };
    this.log.push(e);
    if (this.log.length > 500) this.log.shift();
    this.events.emit('log', e);
  }

  private changed(): void {
    this.events.emit('change', this.v);
  }
}

export function instrumentName(s: InstrumentState): string {
  return s === 'LB' ? 'Line Blocked' : s === 'LC' ? 'Line Clear' : 'Train On Line';
}

/** "14:02" (or "14:02:31") in local time. */
export function clockTime(t: number, seconds = false): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), ...(seconds ? [d.getSeconds()] : [])].map((n) => String(n).padStart(2, '0')).join(':');
}

/** How long a train has waited, in words: '' under a minute, else "3 min". */
export function waitingText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? '' : `${m} min`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}
