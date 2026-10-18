import { describeCode } from './bellcodes';
import type { LinkEnd, LinkMessage } from './link';
import { Emitter, type Scheduler } from './scheduler';
import type { BellCode, CodeSet, InstrumentState, LineType, Location, TrainType, WorkingMode } from './types';

export interface LogEntry {
  t: number;
  kind: 'bellIn' | 'bellOut' | 'status' | 'hint' | 'irregularity' | 'action';
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
  incoming: { locoId: string; trainTypeId: string; departed: boolean; arrived: boolean } | null;
  /** arrived: the operator has reported it arrived at the far end (reported once only). */
  outgoing: { locoId: string | null; trainTypeId: string | null; departed: boolean; arrived?: boolean } | null;
  guidance: string;
  /** False until the box has been opened with the far box (5-5-5). */
  boxOpen: boolean;
}

export interface ControllerEvents extends Record<string, unknown> {
  change: SectionView;
  bellIn: { code: BellCode; holdLast: boolean };
  bellOut: { code: BellCode; holdLast: boolean };
  log: LogEntry;
  hint: { text: string; level: 'info' | 'warn' };
  locoMoved: { locoId: string; location: Location };
}

export interface ControllerOptions {
  link: LinkEnd;
  scheduler: Scheduler;
  boxId: string;
  connectionId: string;
  /** Fiddle yard at the far end, or '' when the far box serves a location on the layout. */
  fiddleYardId: string;
  mode: WorkingMode;
  lineType: LineType;
  neighbourName: string;
  neighbourShort: string;
  localShort: string;
  codeSet: () => CodeSet;
  trainTypes: () => TrainType[];
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
      boxOpen: false,
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
    this.v.incoming = { locoId, trainTypeId, departed: false, arrived: false };
    this.addLog('action', `Next incoming train requested from ${this.o.neighbourName}`);
    this.o.link.send({ type: 'operator', action: 'offerIncoming', locoId, trainTypeId });
    this.changed();
    return null;
  }

  cancelIncoming(): void {
    if (!this.v.incoming || this.v.incoming.departed) return;
    this.o.link.send({ type: 'operator', action: 'cancelIncoming' });
    this.v.incoming = null;
    this.addLog('action', 'Incoming train cancelled by operator');
    this.changed();
  }

  /** Operator has seen the incoming train arrive complete with tail lamp. */
  confirmIncomingArrived(note = ''): void {
    const inc = this.v.incoming;
    if (!inc || inc.arrived) return;
    inc.arrived = true;
    if (this.v.mode === 'token' && this.v.tokenIndicator === 'coming') this.v.tokenInHand = true;
    this.addLog('action', 'Incoming train arrived complete with tail lamp');
    this.o.link.send({ type: 'operator', action: 'arrivedLocal', locoId: inc.locoId });
    this.events.emit('locoMoved', { locoId: inc.locoId, location: { kind: 'station', boxId: this.o.boxId, note } });
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
    this.addLog('action', this.o.fiddleYardId ? 'Outgoing train arrived in fiddle yard' : `Outgoing train arrived at ${this.o.neighbourName}`);
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
        } else {
          if (m.locoId && this.o.fiddleYardId && m.roadId) {
            this.events.emit('locoMoved', { locoId: m.locoId, location: { kind: 'fiddleYard', yardId: this.o.fiddleYardId, roadId: m.roadId } });
          } else if (m.locoId && !this.o.fiddleYardId) {
            // No fiddle yard on this line: the train stays on the layout, at the location the far box serves.
            this.events.emit('locoMoved', { locoId: m.locoId, location: { kind: 'farBox', boxId: this.o.boxId, connectionId: this.o.connectionId, note: '' } });
          }
          this.v.outgoing = null;
          this.addLog('status', 'Outgoing train complete: section clear of it.');
        }
        this.changed();
        break;
      case 'guidance':
        this.v.guidance = m.text;
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
      default:
        break;
    }
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
