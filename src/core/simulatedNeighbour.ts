import {
  codeToGroups,
  describeCode,
  isTrainDescription,
  REGULATION_SIGNALS,
  ringDurationMs,
  signalCode,
  trainCode,
} from './bellcodes';
import type { LinkEnd, LinkMessage } from './link';
import type { ScoreRuleId } from './score';
import type { Scheduler } from './scheduler';
import type { BellCode, CodeSet, InstrumentState, LineType, Settings, TrainType, WorkingMode } from './types';

export interface NeighbourOptions {
  link: LinkEnd;
  scheduler: Scheduler;
  settings: () => Settings;
  codeSet: () => CodeSet;
  trainTypes: () => TrainType[];
  mode: () => WorkingMode;
  lineType: LineType;
  /** e.g. "Fiddle Yard" */
  name: string;
  /** e.g. "Sigsim Central" — the user's box */
  localName: string;
  /** True (default) when the line runs to a fiddle yard; false when it runs to another place (or none). */
  servesFiddleYard?: boolean;
  /** The place at the far end of the line, for guidance ("Fiddle Yard", "Tansley Spa"); '' = none. */
  placeName?: string;
  /** The button the operator presses when an outgoing train has arrived, e.g. "Arrived in Fiddle Yard". */
  arrivedLabel?: string;
  locoLabel: (locoId: string | null) => string;
  /** What a train is working as (its train type), to judge its description when it was not chosen before it was offered. */
  trainTypeOf?: (locoId: string | null) => string | null;
  /** How many other lines the user's box has (a held train is offered again soon after 2-1 on one of them). */
  otherLines?: number;
  random?: () => number;
}

/** 'held': offered, not accepted in time (a silent refusal); the far box holds the train and offers it again later. */
type Stage = 'calling' | 'offered' | 'held' | 'awaitingLC' | 'accepted' | 'inSection' | 'arrived';

interface Movement {
  locoId: string | null;
  trainTypeId: string | null;
  code: BellCode;
  stage: Stage;
  /** Incoming only: how many times the train has been offered again after being refused. */
  reoffers: number;
  /** Outgoing only: offered with a valid code that is not the train's own description, and not yet corrected. */
  misdescribed?: { sent: BellCode; correct: BellCode };
  /** Outgoing only: the description has been checked against the train (its type is known). */
  judged?: boolean;
  /** Outgoing only: wrong_description has already been scored for this train. */
  descFault?: boolean;
}

interface Awaiting {
  code: BellCode;
  expectHold: boolean;
  onAck: () => void;
  attempts: number;
  repeatTimer: number | null;
  label: string;
  /** Ring the code again after a wrong reply. Default: a fresh exchange (which rings again if unanswered). */
  resend?: () => void;
}

const ATTENTION_VALID_MS = 60_000;
const RELEASE_WINDOW_MS = 15_000;

/**
 * The signaller at the far end of the section, played by the app.
 * It answers the user's bells, offers incoming trains when the operator asks,
 * and coaches (hints) when the user's procedure goes wrong.
 */
export class SimulatedNeighbour {
  /** The neighbour's own instrument: trains travelling from the user's box to it. */
  myInstrument: InstrumentState = 'LB';
  /** Last known state of the user's instrument (trains travelling to the user's box). */
  localInstrument: InstrumentState = 'LB';
  tokenOut: null | 'here' | 'local' = null;
  releaseActive = false;
  /** The user's box must be opened (1, then 5-5-5) before trains are signalled. */
  opened = false;

  incoming: Movement | null = null; // neighbour → user's box
  outgoing: Movement | null = null; // user's box → neighbour
  declaredOutgoing: { locoId: string | null; trainTypeId: string | null } | null = null;

  private attentionAt: number | null = null;
  private awaiting: Awaiting | null = null;
  private localArrived = false;
  private localTokenReplaced = false;
  /** Irregularities since the line was last clear (for the clean working bonus). */
  private faults = 0;
  /** Waiting for the user to put their instrument back to Line Blocked after 2-1. */
  private awaitingLB = false;
  /** Train On Line has been scored for the incoming train. */
  private tolScored = false;
  /** The last incoming train cleared out of section (for scoring while the instrument goes back to Line Blocked). */
  private lastLoco: string | null = null;
  private timers = new Set<number>();
  private releaseTimer: number | null = null;
  /** Offering a held (refused) incoming train again. */
  private reofferTimer: number | null = null;
  /** 5-3 acknowledged for a train already in the section: the next train description is its correct description. */
  private correcting = false;
  private busyUntil = 0;
  private random: () => number;

  constructor(private o: NeighbourOptions) {
    this.random = o.random ?? Math.random;
    o.link.onMessage((m) => this.onMessage(m));
  }

  dispose(): void {
    for (const t of this.timers) this.o.scheduler.clearTimeout(t);
    this.timers.clear();
    if (this.awaiting?.repeatTimer != null) this.o.scheduler.clearTimeout(this.awaiting.repeatTimer);
  }

  /** Called once the UI is listening, to publish initial state. */
  start(): void {
    this.send({ type: 'instrument', state: this.myInstrument });
    this.send({ type: 'boxState', open: this.opened });
    this.guide();
  }

  private setOpened(open: boolean): void {
    this.opened = open;
    this.send({ type: 'boxState', open });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private get set(): CodeSet {
    return this.o.codeSet();
  }
  private sig(id: string): BellCode {
    return signalCode(this.set, id);
  }
  private desc(code: BellCode): string {
    return describeCode(code, this.set, this.o.trainTypes());
  }
  private trainDesc(trainTypeId: string): string {
    const t = this.o.trainTypes().find((x) => x.id === trainTypeId);
    const e = this.set.trainCodes[trainTypeId];
    return `${t ? `${/^[aeiou]/i.test(t.name) ? 'an' : 'a'} ${t.name.toLowerCase()} train` : 'a train'}${e?.classLabel ? ` (${e.classLabel})` : ''}`;
  }
  private send(m: LinkMessage): void {
    this.o.link.send(m);
  }
  private hint(text: string, level: 'info' | 'warn' = 'warn'): void {
    this.send({ type: 'hint', text, level });
  }
  /** An irregularity: logged in the train register and scored against the signaller. */
  private irregular(text: string, rule: ScoreRuleId): void {
    this.faults++;
    this.send({ type: 'irregularity', text });
    this.send({ type: 'score', rule, locoId: this.currentLoco() ?? undefined });
  }
  /** Points for something done by the book. */
  private award(rule: ScoreRuleId): void {
    this.send({ type: 'score', rule, locoId: this.currentLoco() ?? undefined });
  }
  /** The train being worked on this line (or just finished, while the instrument is still to go back to Line Blocked). */
  private currentLoco(): string | null {
    return this.incoming?.locoId ?? this.outgoing?.locoId ?? (this.awaitingLB ? this.lastLoco : null);
  }
  /**
   * A train movement has finished on this line: was it clean (nothing went wrong on this line since
   * it was last clear)? The box gives the clean working bonus, judging a through train once over all its lines.
   */
  private movementDone(locoId: string | null): void {
    this.send({ type: 'movementJudged', locoId: locoId ?? undefined, clean: this.faults === 0 });
    this.faults = 0;
  }
  private status(text: string): void {
    this.send({ type: 'status', text: `${this.o.name}: ${text}` });
  }
  private get token(): boolean {
    return this.o.mode() === 'token';
  }

  private reactionDelay(): number {
    const [a, b] = this.o.settings().responseDelayMs;
    return a + this.random() * Math.max(0, b - a);
  }

  private after(ms: number, fn: () => void): number {
    const id = this.o.scheduler.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private cancel(id: number | null): void {
    if (id == null) return;
    this.o.scheduler.clearTimeout(id);
    this.timers.delete(id);
  }

  /** Ring a code, never overlapping a code we are already ringing. Returns ms until it has finished ringing. */
  private ring(code: BellCode, holdLast = false): number {
    const s = this.o.settings();
    const now = this.o.scheduler.now();
    const start = Math.max(now, this.busyUntil);
    const dur = ringDurationMs(code, s.bellBeatMs, s.bellGroupPauseMs) + (holdLast ? 1200 : 0);
    this.busyUntil = start + dur + 300;
    const go = () => this.send({ type: 'bell', code, holdLast });
    if (start <= now) go();
    else this.after(start - now, go);
    return start - now + dur;
  }

  /** Send a code and wait for the user to repeat it, ringing again if no (or a wrong) reply. */
  private exchange(code: BellCode, label: string, onAck: () => void, holdLast = false, expectHold = false): void {
    if (this.awaiting?.repeatTimer != null) this.cancel(this.awaiting.repeatTimer);
    const aw: Awaiting = { code, expectHold, onAck, attempts: 0, repeatTimer: null, label };
    this.awaiting = aw;
    const fire = () => {
      if (this.awaiting !== aw) return;
      aw.attempts++;
      const dur = this.ring(code, holdLast);
      aw.repeatTimer = this.after(dur + this.o.settings().repeatAfterMs, () => {
        if (this.awaiting !== aw) return;
        this.hint(`${this.o.name} has had no reply and is ringing ${code} (${label}) again. Repeat it back to acknowledge.`, 'info');
        // Scored once per exchange, so a box left unattended does not drain the score.
        if (aw.attempts === 1) {
          this.faults++;
          this.send({ type: 'score', rule: 'no_reply', detail: `${code} (${label})`, locoId: this.currentLoco() ?? undefined });
        }
        fire();
      });
    };
    fire();
  }

  private resendAwaiting(): void {
    const aw = this.awaiting;
    if (!aw) return;
    this.cancel(aw.repeatTimer);
    aw.repeatTimer = this.after(this.reactionDelay() + 1500, () => {
      if (this.awaiting !== aw) return;
      if (aw.resend) aw.resend();
      else this.exchange(aw.code, aw.label, aw.onAck, false, aw.expectHold);
    });
  }

  private hasAttention(): boolean {
    return this.attentionAt !== null && this.o.scheduler.now() - this.attentionAt < ATTENTION_VALID_MS;
  }

  private sectionBusy(): boolean {
    if (this.outgoing || this.tokenOut) return true;
    // A train the user's box has refused (held here) does not occupy the single line: the user may send one the other way first.
    if (this.o.lineType === 'single' && this.incoming && this.incoming.stage !== 'held') return true;
    return false;
  }

  private guide(text?: string, drive?: string): void {
    if (text !== undefined) return this.send({ type: 'guidance', text, drive });
    const idle = this.idleGuidance();
    this.send({ type: 'guidance', text: idle, idle: this.opened && !this.incoming && !this.outgoing });
  }

  private idleGuidance(): string {
    if (this.incoming?.stage === 'held' && !this.outgoing) return this.heldGuidance(this.incoming);
    if (this.incoming || this.outgoing) return '';
    if (!this.opened) {
      return `Box closed. To open it, call attention (1), then send 5-5-5.`;
    }
    return `Line quiet. To receive a train, press "Offer next incoming train"; to send one, choose it under "Departure" and call attention (1). Close with 1, then 7-5-5.`;
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private onMessage(m: LinkMessage): void {
    switch (m.type) {
      case 'bell':
        this.onBell(m.code, m.holdLast);
        break;
      case 'instrument':
        this.onLocalInstrument(m.state);
        break;
      case 'token':
        this.onLocalToken(m.event);
        break;
      case 'operator':
        if (m.action === 'offerIncoming') this.offerIncoming(m.locoId, m.trainTypeId);
        else if (m.action === 'cancelIncoming') this.cancelIncoming();
        else if (m.action === 'declareOutgoing') {
          this.declaredOutgoing = { locoId: m.locoId, trainTypeId: m.trainTypeId };
          this.onDeclared(m.locoId, m.trainTypeId);
        }
        else if (m.action === 'arrivedLocal') this.onArrivedLocal();
        else if (m.action === 'arrivedRemote') this.onArrivedHere(m.locoId, m.roadId);
        else if (m.action === 'promptReoffer') this.promptReoffer();
        break;
      default:
        break;
    }
  }

  private onBell(code: BellCode, hold: boolean): void {
    const set = this.set;
    // While the user's box is closed, the far signaller only listens for it being opened again.
    if (!this.opened && !this.awaiting && code !== this.sig('call_attention') && code !== this.sig('opening')) {
      this.hint(`Your box is closed, so ${this.o.name} is not working with it. Open it first: call attention (1), then send 5-5-5.`);
      return;
    }
    // Emergencies first: always acted on, no call attention needed.
    if (code === this.sig('obstruction_danger')) {
      this.after(this.reactionDelay(), () => this.ring(code));
      this.status('Obstruction danger acknowledged. All trains stopped.');
      return;
    }

    // Is this the reply we are waiting for?
    const aw = this.awaiting;
    if (aw) {
      if (code === aw.code) {
        if (aw.expectHold && !hold) {
          this.hint(
            `You repeated ${code} correctly, but in token working you must HOLD the last beat so ${this.o.name} can withdraw a token. Press and hold the tapper on the final beat (or tick "hold last beat").`,
          );
          this.irregular(`${code} repeated without holding the last beat for the token release.`, 'no_hold');
          this.resendAwaiting();
          return;
        }
        this.cancel(aw.repeatTimer);
        this.awaiting = null;
        aw.onAck();
        return;
      }
      this.hint(`${this.o.name} expected you to repeat ${aw.code} (${aw.label}), but you sent ${code}. They will ring ${aw.code} again.`);
      this.irregular(`Wrong reply: sent ${code} when ${aw.code} (${aw.label}) should have been repeated.`, 'wrong_reply');
      this.resendAwaiting();
      return;
    }

    // The user's box is starting something.
    if (code === this.sig('call_attention')) {
      this.after(this.reactionDelay(), () => {
        this.ring(code);
        this.attentionAt = this.o.scheduler.now();
        if (!this.opened) {
          this.guide(`Send 5-5-5 (Opening of signal box).`);
        } else if ((!this.incoming || this.incoming.stage === 'held') && !this.outgoing) {
          this.guide(`Send the Is line clear code for your train.`);
        }
      });
      return;
    }

    if (code === this.sig('train_entering_section')) {
      this.onTrainEnteringSection();
      return;
    }

    if (code === this.sig('train_out_of_section')) {
      this.onTrainOutOfSection();
      return;
    }

    if (code === this.sig('cancelling')) {
      this.onCancelling();
      return;
    }

    // The correct description following 5-3 for a train already on its way.
    if (this.correcting && this.hasAttention() && isTrainDescription(code, set)) {
      this.onCorrectedDescription(code);
      return;
    }

    // The held train's code repeated after the offer lapsed: the far box takes it you can now accept, and offers it again.
    const held = this.incoming;
    if (held?.stage === 'held' && code === held.code && !this.hasAttention()) {
      this.hint(`${this.o.name} had already taken your silence as a refusal and is holding the train. They will call attention and offer it again now: answer 1, then repeat ${code}.`, 'info');
      this.promptReoffer(500);
      return;
    }

    if (isTrainDescription(code, set)) {
      this.onIsLineClear(code);
      return;
    }

    const reg = REGULATION_SIGNALS.find((r) => set.signals[r.id] === code);
    if (reg) {
      if (reg.needsCallAttention && !this.hasAttention()) {
        this.hint(`Call attention (1) first and wait for it to be acknowledged before sending ${code} (${reg.name}).`);
        this.irregular(`${reg.name} (${code}) sent without call attention.`, 'no_call_attention');
        return;
      }
      this.attentionAt = null;
      if (reg.id === 'opening') {
        this.after(this.reactionDelay(), () => {
          const dur = this.ring(code);
          this.after(dur, () => {
            this.setOpened(true);
            this.faults = 0;
            this.award('box_opened');
            this.status('your box is open.');
            this.guide();
          });
        });
        return;
      }
      if (reg.id === 'closing' || reg.id === 'closing_locked') {
        if (this.incoming || this.outgoing || this.tokenOut) {
          this.hint('You cannot close the box while a train is being signalled. Finish the move first.');
          this.irregular('Tried to close the box with a train in progress.', 'close_with_train');
          return;
        }
        this.after(this.reactionDelay(), () => {
          const dur = this.ring(code);
          this.after(dur, () => {
            this.award('box_closed');
            this.setOpened(false);
            this.status('your box is closed. The box will reset, ready to be opened again.');
            this.guide();
          });
        });
        return;
      }
      this.after(this.reactionDelay(), () => this.ring(code));
      const out = this.outgoing;
      if (reg.id === 'incorrectly_described' && out && (out.stage === 'offered' || out.stage === 'accepted')) {
        // Not yet departed: the offer is withdrawn and the train is offered again with the right code.
        // Misdescribing is a fault even when put right: score it now if it was not already.
        if (!out.descFault) this.descriptionFault(out, `Train offered as ${out.code} was incorrectly described (corrected with 5-3 before it departed).`);
        this.status('acknowledged: last train incorrectly described. Re-offer it with the correct code.');
        this.attentionAt = this.o.scheduler.now() + 3000;
        this.outgoing = null;
        this.setMyInstrument('LB');
      } else if (reg.id === 'incorrectly_described' && out?.stage === 'inSection') {
        // Already on its way: 5-3 is followed by the correct description (no further call attention).
        this.correcting = true;
        this.attentionAt = this.o.scheduler.now() + 3000;
        this.status('acknowledged: last train incorrectly described. Send its correct description.');
        const right = out.trainTypeId ? trainCode(this.set, out.trainTypeId) : '';
        this.guide(`Now send the correct description${right ? `: ${right} (${this.desc(right)})` : ''}.`);
      }
      return;
    }

    this.hint(`${code} is not a code ${this.o.name} recognises in the "${set.name}" code set, so they will not answer it.`);
    this.irregular(`Unrecognised code ${code} sent.`, 'unrecognised_code');
  }

  // -------------------------------------------------------------------------
  // Trains from the user's box (outgoing, from the user's point of view)
  // -------------------------------------------------------------------------

  private onIsLineClear(code: BellCode): void {
    if (!this.hasAttention()) {
      this.hint(`Call attention first: tap 1 beat and wait for ${this.o.name} to answer 1 before offering the train.`);
      this.irregular(`"Is line clear" (${code}) sent without call attention.`, 'no_call_attention');
      return;
    }
    this.attentionAt = null;
    if (!this.opened) {
      this.hint(`${this.o.name} will not accept trains until your box is open. Call attention (1), then send 5-5-5.`);
      this.irregular(`Train offered (${code}) before the box was opened.`, 'box_not_open');
      return;
    }
    if (this.sectionBusy()) {
      this.hint(`${this.o.name} cannot accept: the section is not clear (a train has already been offered or is in the section). They will not reply.`);
      this.irregular(`Train offered (${code}) while the section was not clear.`, 'offered_section_busy');
      return;
    }
    const decl = this.declaredOutgoing;
    this.outgoing = { locoId: decl?.locoId ?? null, trainTypeId: null, code, stage: 'offered', reoffers: 0 };
    // Judged now if the departing train has been chosen; otherwise as soon as it is known (chosen later, or on arrival).
    this.judgeDescription(this.outgoing, decl?.trainTypeId ?? null, 'offer');
    this.after(this.reactionDelay(), () => {
      if (!this.outgoing || this.outgoing.stage !== 'offered') return;
      if (this.token) {
        const dur = this.ring(code, true);
        this.after(Math.max(0, dur - 1200), () => this.setRelease(true));
        this.outgoing.stage = 'accepted';
        this.guide(
          `Accepted. While the needle is deflected, press "Withdraw token". Hand it to the driver, clear your signal, and send 2 as the train leaves.`,
        );
      } else {
        const dur = this.ring(code);
        this.after(dur + 400, () => this.setMyInstrument('LC'));
        this.outgoing.stage = 'accepted';
        this.guide(
          `Accepted: your repeater shows LINE CLEAR. Clear your signal, and send 2 (Train entering section) as the train leaves.`,
        );
      }
    });
  }

  private setRelease(active: boolean): void {
    this.releaseActive = active;
    this.send({ type: 'release', active });
    this.cancel(this.releaseTimer);
    this.releaseTimer = null;
    if (active) {
      this.releaseTimer = this.after(RELEASE_WINDOW_MS, () => {
        this.releaseTimer = null;
        if (!this.releaseActive) return;
        this.setRelease(false);
        if (this.outgoing && this.tokenOut !== 'local') {
          this.outgoing = null;
          this.hint(`No token was withdrawn, so ${this.o.name} has let go of the plunger. Offer the train again (1, then the Is line clear code).`);
          this.guide();
        }
      });
    }
  }

  private setMyInstrument(s: InstrumentState): void {
    this.myInstrument = s;
    this.send({ type: 'instrument', state: s });
  }

  private onLocalToken(ev: 'withdrawn' | 'replaced'): void {
    if (ev === 'withdrawn') {
      this.tokenOut = 'local';
      if (this.releaseActive) this.setRelease(false);
      this.status('token withdrawn at your end. Their indicator shows "Train coming from".');
      if (this.outgoing) {
        this.guide(
          `Hand the token to the driver, clear your signal, and send 2 as the train leaves.`,
        );
      }
    } else {
      // Token replaced at the user's end.
      if (this.tokenOut === 'local' && this.outgoing && this.outgoing.stage !== 'inSection') {
        // Cancelling an outgoing train: token put back.
        this.tokenOut = null;
        this.guide(`To cancel the train, call attention (1) and send 3-5 (Cancelling).`);
      } else if (this.incoming && this.incoming.stage === 'inSection') {
        this.tokenOut = null;
        this.localTokenReplaced = true;
        this.guide(`Call attention (1), then send 2-1 (Train out of section).`);
      }
    }
  }

  private onTrainEnteringSection(): void {
    const out = this.outgoing;
    if (!out || out.stage !== 'accepted') {
      this.hint(`You sent 2 (Train entering section) but no train has been accepted by ${this.o.name}. Never let a train go without line clear!`);
      this.irregular('Train entering section sent without line clear.', 'no_line_clear');
      return;
    }
    if (this.token && this.tokenOut !== 'local') {
      this.hint(`The train has left without a token! In token working the driver must be given the token before departure.`);
      this.irregular('Train despatched without a token.', 'no_token');
    } else this.award('out_departed');
    this.after(this.reactionDelay(), () => {
      const dur = this.ring(this.sig('train_entering_section'));
      this.after(dur + 300, () => {
        if (!this.token) this.setMyInstrument('TOL');
      });
      out.stage = 'inSection';
      this.send({ type: 'trainDeparted', direction: 'outgoing', locoId: out.locoId });
      this.outgoingRunningGuidance(out, '');
    });
  }

  /**
   * Check an outgoing train's description against what the train is, once that is known: at the offer
   * (the departing train was chosen first), when it is chosen or its working changes later, or at the
   * latest when it arrives. Misdescribing costs wrong_description (once per train) and the clean working
   * bonus; if still not corrected when it arrives, the far box reports it with 5-3.
   */
  private judgeDescription(out: Movement, trainTypeId: string | null, when: 'offer' | 'later' | 'arrival'): void {
    if (!trainTypeId) return;
    const expected = trainCode(this.set, trainTypeId);
    if (!expected) return;
    const first = !out.judged;
    out.judged = true;
    out.trainTypeId = trainTypeId;
    if (expected === out.code) {
      out.misdescribed = undefined;
      if (first && !out.descFault) this.award('out_offered');
      return;
    }
    out.misdescribed = { sent: out.code, correct: expected };
    if (when !== 'arrival') {
      const fix =
        out.stage === 'inSection'
          ? `To correct it, call attention (1), send 5-3, then ${expected}.`
          : `If it was a mistake, call attention and send 5-3 (incorrectly described): before it departs, then re-offer it; once it is on its way, follow 5-3 with ${expected}.`;
      this.hint(
        `You offered ${out.code} (${this.desc(out.code)}), but the train ${when === 'offer' ? 'you selected to depart' : 'departing'} is described as ${expected} (${this.desc(expected)}). ${this.o.name} will accept what they heard. ${fix} If you do not correct it, ${this.o.name} will report it with 5-3 when the train arrives.`,
      );
      if (out.stage === 'inSection') this.outgoingRunningGuidance(out, '');
    }
    if (!out.descFault) this.descriptionFault(out, `Train offered as ${out.code} but the train ${when === 'arrival' ? 'that arrived' : 'chosen'} should be ${expected}.`);
  }

  /** wrong_description, once per train. */
  private descriptionFault(out: Movement, text: string): void {
    out.descFault = true;
    this.irregular(text, 'wrong_description');
  }

  /** The departing train was chosen (or its working changed) after it was offered: judge its description now. */
  private onDeclared(locoId: string | null, trainTypeId: string | null): void {
    const out = this.outgoing;
    if (!out || out.stage === 'arrived') return;
    // Once on its way, a different train chosen is the next departure, not this one.
    if (out.stage === 'inSection' && out.locoId && locoId && out.locoId !== locoId) return;
    if (locoId) out.locoId = locoId;
    if (trainTypeId && trainTypeId !== out.trainTypeId) this.judgeDescription(out, trainTypeId, 'later');
  }

  private outgoingRunningGuidance(out: Movement, lead: string): void {
    const drive =
      this.o.servesFiddleYard === false
        ? `When ${this.o.locoLabel(out.locoId)} has reached ${this.o.placeName || this.o.name}, press "${this.o.arrivedLabel ?? `Arrived at ${this.o.name}`}".`
        : `Drive ${this.o.locoLabel(out.locoId)} into ${this.o.placeName || 'the fiddle yard'}, then press "${this.o.arrivedLabel ?? 'Arrived in fiddle yard'}".`;
    const m = out.misdescribed;
    const fix = m
      ? ` Described as ${m.sent} but it is ${m.correct}: to correct it, send 1, 5-3, then ${m.correct}.`
      : '';
    this.guide(`${lead ? `${lead} ` : ''}${drive}${fix}`, drive);
  }

  /** The correct description sent after 5-3 for a train already in the section. */
  private onCorrectedDescription(code: BellCode): void {
    this.correcting = false;
    this.attentionAt = null;
    const out = this.outgoing;
    this.after(this.reactionDelay(), () => this.ring(code));
    if (!out || out.stage !== 'inSection') return;
    // 5-3 says the train was misdescribed: a fault even when put right, scored once.
    if (!out.descFault && code !== out.code) this.descriptionFault(out, `Train offered as ${out.code} was incorrectly described (corrected to ${code} with 5-3 while on its way).`);
    if (!out.judged) {
      out.code = code;
      out.misdescribed = undefined;
      this.status(`description corrected: the train in the section is ${code} (${this.desc(code)}).`);
      this.outgoingRunningGuidance(out, 'Description corrected.');
      return;
    }
    const right = out.trainTypeId ? trainCode(this.set, out.trainTypeId) : '';
    if (right && code !== right) {
      out.misdescribed = { sent: code, correct: right };
      this.hint(`${this.o.name} repeated ${code} (${this.desc(code)}), but the train is ${right} (${this.desc(right)}). Send 1, 5-3 and ${right} to put it right.`);
    } else {
      out.misdescribed = undefined;
      out.code = code;
      this.status(`description corrected: the train in the section is ${code} (${this.desc(code)}).`);
    }
    this.outgoingRunningGuidance(out, out.misdescribed ? '' : 'Description corrected.');
  }

  /**
   * The train has arrived and is not what it was described as: before clearing back, the receiving
   * box calls attention and sends 5-3 (Last train signalled incorrectly described).
   */
  private reportMisdescribed(out: Movement, then: () => void): void {
    const m = out.misdescribed!;
    this.irregular(`${this.o.name} reports ${this.o.locoLabel(out.locoId)} incorrectly described: offered as ${m.sent} (${this.desc(m.sent)}), but it was ${m.correct} (${this.desc(m.correct)}).`, 'misdescribed_not_corrected');
    this.hint(`The train you offered as ${m.sent} has arrived at ${this.o.name}, and it is really ${m.correct} (${this.desc(m.correct)}). ${this.o.name} is telling you with 5-3 (Last train signalled incorrectly described).`);
    this.guide(`Answer 1, then repeat 5-3 (last train incorrectly described).`);
    this.exchange(this.sig('call_attention'), 'Call attention', () => {
      this.after(this.reactionDelay(), () => {
        this.guide(`Repeat 5-3 (last train incorrectly described). You offered ${m.sent}, but it was ${m.correct}.`);
        this.exchange(this.sig('incorrectly_described'), 'Last train incorrectly described', () => {
          out.misdescribed = undefined;
          this.after(this.reactionDelay() + 1000, then);
        });
      });
    });
  }

  private onArrivedHere(locoId: string | null, roadId: string): void {
    const out = this.outgoing;
    if (out && out.stage === 'arrived') return; // already reported; ignore a repeat

    if (!out || out.stage !== 'inSection') {
      this.irregular(`${this.o.locoLabel(locoId)} arrived ${this.o.servesFiddleYard === false ? `at ${this.o.placeName || this.o.name}` : `in ${this.o.placeName || 'the fiddle yard'}`} without being signalled through the section.`, 'unsignalled_train');
      this.hint(`That train was not signalled! Normally you would offer it (1, Is line clear) and send 2 as it departs.`);
      this.send({ type: 'movementComplete', direction: 'outgoing', locoId, roadId });
      return;
    }
    out.stage = 'arrived';
    out.locoId = locoId ?? out.locoId;
    // A train that was never chosen before it ran is judged now, against what it is working as.
    if (!out.judged) this.judgeDescription(out, this.o.trainTypeOf?.(out.locoId) ?? null, 'arrival');
    if (!out.judged && !out.descFault) this.award('out_offered'); // nothing known to judge it by
    this.status(`${this.o.locoLabel(out.locoId)} arrived complete with tail lamp.`);
    this.guide(`Train arrived. Answer ${this.o.name}'s 1, then repeat 2-1.`);
    this.after(this.reactionDelay() + 1000, () => {
      if (this.token && this.tokenOut === 'local') {
        this.tokenOut = null;
        this.send({ type: 'token', event: 'replaced' });
        this.status('token replaced in their instrument.');
      }
      const clearBack = () => {
      this.exchange(this.sig('call_attention'), 'Call attention', () => {
        this.after(this.reactionDelay(), () => {
          this.exchange(this.sig('train_out_of_section'), 'Train out of section', () => {
            if (!this.token) this.setMyInstrument('LB');
            this.outgoing = null;
            this.declaredOutgoing = null;
            this.send({ type: 'movementComplete', direction: 'outgoing', locoId: out.locoId, roadId });
            this.award('out_cleared');
            this.movementDone(out.locoId);
            this.status('section clear.');
            this.guide();
            // A train held here while the user sent theirs (single line): offer it again now the line is clear.
            this.promptReoffer();
          });
          this.guide(`Repeat 2-1 (Train out of section).`);
        });
      });
      this.guide(`Answer 1: ${this.o.name} is calling attention.`);
      };
      // A train that arrived not as described is reported first (5-3), then cleared back with 2-1.
      if (out.misdescribed) this.reportMisdescribed(out, clearBack);
      else clearBack();
    });
  }

  private onCancelling(): void {
    if (!this.hasAttention()) {
      this.hint('Call attention (1) first before sending 3-5 (Cancelling).');
      this.irregular('Cancelling sent without call attention.', 'no_call_attention');
      return;
    }
    this.attentionAt = null;
    const out = this.outgoing;
    if (!out || out.stage === 'inSection' || out.stage === 'arrived') {
      this.hint(out ? 'A train that has entered the section cannot be cancelled.' : 'There is no accepted train to cancel.');
      return;
    }
    if (this.token && this.tokenOut === 'local') {
      this.hint('Replace the token in your instrument before sending 3-5 (Cancelling).');
      return;
    }
    this.after(this.reactionDelay(), () => {
      const dur = this.ring(this.sig('cancelling'));
      this.after(dur + 300, () => {
        if (!this.token) this.setMyInstrument('LB');
      });
      if (this.releaseActive) this.setRelease(false);
      this.outgoing = null;
      this.declaredOutgoing = null;
      this.status('train cancelled.');
      this.guide();
    });
  }

  // -------------------------------------------------------------------------
  // Trains to the user's box (incoming)
  // -------------------------------------------------------------------------

  offerIncoming(locoId: string, trainTypeId: string): void {
    if (!this.opened) {
      this.hint('Open the box first: call attention (1), then send 5-5-5.');
      return;
    }
    if (this.sectionBusy() || this.incoming) {
      this.hint(`${this.o.name} cannot offer a train yet: the section is not clear.`);
      return;
    }
    const code = trainCode(this.set, trainTypeId);
    if (!code) {
      this.hint(`The train type has no bell code in the "${this.set.name}" code set. Set one in Settings → Bell codes.`);
      return;
    }
    const mv: Movement = { locoId, trainTypeId, code, stage: 'calling', reoffers: 0 };
    this.incoming = mv;
    this.localArrived = false;
    this.localTokenReplaced = false;
    this.tolScored = false;
    this.callAndOffer(mv);
  }

  /** Call attention (rung again until answered), then offer the train. */
  private callAndOffer(mv: Movement): void {
    this.after(this.reactionDelay(), () => {
      if (this.incoming !== mv) return;
      mv.stage = 'calling';
      this.guide(`Answer 1: ${this.o.name} is calling attention.`);
      this.exchange(this.sig('call_attention'), 'Call attention', () => {
        this.after(this.reactionDelay(), () => {
          if (this.incoming !== mv) return;
          this.ringOffer(mv);
        });
      });
    });
  }

  /**
   * Ring Is line clear for the train once. Repeating it accepts the train; no reply within the grace
   * period is a refusal (the prototypical way of refusing a train: you simply do not answer), so the
   * far box holds the train and offers it again later. An unanswered offer is not scored as slow.
   */
  private ringOffer(mv: Movement): void {
    const code = mv.code;
    mv.stage = 'offered';
    const what = this.trainDesc(mv.trainTypeId ?? '');
    this.guide(
      (this.token
        ? `Is line clear for ${what}? To accept, repeat ${code} and HOLD the last beat.`
        : `Is line clear for ${what}? To accept, repeat ${code}, then turn your instrument to LINE CLEAR.`) +
        ' Not ready? Don’t reply.',
    );
    const aw: Awaiting = {
      code,
      expectHold: this.token,
      onAck: () => this.onIncomingAccepted(mv),
      attempts: 1,
      repeatTimer: null,
      label: 'Is line clear',
      resend: () => this.ringOffer(mv),
    };
    this.awaiting = aw;
    const dur = this.ring(code);
    this.send({ type: 'offer', state: 'offered', reoffers: mv.reoffers });
    aw.repeatTimer = this.after(dur + this.o.settings().offerRefusedAfterMs, () => {
      if (this.awaiting !== aw) return;
      this.awaiting = null;
      this.refused(mv);
    });
  }

  /** The offer was not repeated in time: the train is refused for now and held at the far box. */
  private refused(mv: Movement): void {
    if (this.incoming !== mv) return;
    mv.stage = 'held';
    const wait = Math.max(5000, this.o.settings().reofferAfterMs);
    this.scheduleReoffer(mv, wait);
    this.status(`no reply to ${mv.code}: the train is refused for now. ${this.o.name} is holding ${this.o.locoLabel(mv.locoId)}.`);
    this.hint(
      `You did not repeat ${mv.code}, so ${this.o.name} takes it that you cannot accept the train yet (a refusal). They are holding it and will offer it again in about ${Math.round(wait / 1000)} s${this.o.otherLines ? ', or soon after you next send 2-1 on another line' : ''}.`,
      'info',
    );
    this.guide(this.heldGuidance(mv));
  }

  private heldGuidance(mv: Movement): string {
    const sendFirst = this.o.lineType === 'single' ? ` You may send a train to ${this.o.name} first.` : '';
    return `${this.o.name} is holding ${this.o.locoLabel(mv.locoId)} (${mv.code}). When they offer it again, answer 1 and repeat ${mv.code}.${sendFirst}`;
  }

  private scheduleReoffer(mv: Movement, ms: number): void {
    this.cancel(this.reofferTimer);
    const nextAt = this.o.scheduler.now() + ms;
    this.reofferTimer = this.after(ms, () => {
      this.reofferTimer = null;
      this.reoffer(mv);
    });
    this.send({ type: 'offer', state: 'held', reoffers: mv.reoffers, nextAt });
  }

  /** Offer the held train again, once the line and the user are free. */
  private reoffer(mv: Movement): void {
    if (this.incoming !== mv || mv.stage !== 'held') return;
    // Wait while the user is sending a train this way on the single line, or is in the middle of a bell exchange here.
    if (this.sectionBusy() || this.awaiting || this.hasAttention()) {
      this.scheduleReoffer(mv, 10_000);
      return;
    }
    mv.reoffers++;
    this.status(`offering ${this.o.locoLabel(mv.locoId)} again.`);
    this.callAndOffer(mv);
  }

  /** The user's box is free (it has just cleared a line): offer a held train again soon, rather than at the next interval. */
  promptReoffer(delayMs?: number): void {
    const mv = this.incoming;
    if (!mv || mv.stage !== 'held') return;
    this.scheduleReoffer(mv, delayMs ?? this.reactionDelay() + 2500);
  }

  private onIncomingAccepted(mv: Movement): void {
    if (this.incoming !== mv) return;
    this.award('in_accepted');
    this.send({ type: 'offer', state: 'accepted', reoffers: mv.reoffers });
    if (this.token) {
      mv.stage = 'accepted';
      this.after(800, () => {
        if (this.incoming !== mv) return;
        this.tokenOut = 'here';
        this.send({ type: 'token', event: 'withdrawn' });
        this.status('token withdrawn. Your indicator shows "Train coming from".');
        this.scheduleDespatch(mv);
      });
      this.guide(`Token released: ${this.o.name} will send the train.`);
    } else {
      mv.stage = 'awaitingLC';
      if (this.localInstrument === 'LC') {
        // Already at Line Clear (turned early, which was scored as an irregularity at the time).
        this.onLineClearShown(mv);
      } else {
        this.guide(`Accepted. Turn your instrument to LINE CLEAR.`);
        this.after(this.o.settings().repeatAfterMs, () => {
          if (this.incoming === mv && mv.stage === 'awaitingLC') {
            this.hint(`${this.o.name} is waiting: their section signal is locked until your instrument shows LINE CLEAR.`);
          }
        });
      }
    }
  }

  private onLineClearShown(mv: Movement): void {
    mv.stage = 'accepted';
    this.guide(`Line Clear given: ${this.o.name} will send the train.`);
    this.scheduleDespatch(mv);
  }

  private scheduleDespatch(mv: Movement): void {
    const [a, b] = this.o.settings().despatchDelayMs;
    this.after(a + this.random() * Math.max(0, b - a), () => {
      if (this.incoming !== mv || mv.stage !== 'accepted') return;
      this.status(`${this.o.locoLabel(mv.locoId)} has departed.`);
      this.guide(
        this.token
          ? `Repeat 2 (Train entering section). Then drive ${this.o.locoLabel(mv.locoId)} into the station.`
          : `Repeat 2 (Train entering section), then turn your instrument to TRAIN ON LINE.`,
      );
      this.exchange(this.sig('train_entering_section'), 'Train entering section', () => {
        mv.stage = 'inSection';
        this.award('in_entering');
        this.send({ type: 'trainDeparted', direction: 'incoming', locoId: mv.locoId });
        this.incomingRunningGuidance(mv);
        if (!this.token) {
          this.after(this.o.settings().repeatAfterMs, () => {
            if (this.incoming === mv && mv.stage === 'inSection' && this.localInstrument !== 'TOL') {
              this.tolScored = true; // no points for turning it now
              this.hint('Your block instrument should show TRAIN ON LINE while the train is in the section.');
              this.irregular('Instrument not turned to Train On Line after acknowledging Train entering section.', 'tol_late');
            }
          });
        }
      });
    });
  }

  private incomingRunningGuidance(mv: Movement): void {
    const turnTol = !this.token && this.localInstrument !== 'TOL' ? 'Turn your instrument to TRAIN ON LINE. ' : '';
    const tokenBit = this.token ? ' take the token, press "Replace token",' : '';
    this.guide(
      `${turnTol}Drive ${this.o.locoLabel(mv.locoId)} into ${this.o.localName}. When it is in complete with its tail lamp, press "Train arrived",${tokenBit} then send 1 and 2-1.`,
    );
  }

  private scoreTol(): void {
    if (this.tolScored) return;
    this.tolScored = true;
    this.award('in_tol');
  }

  private onArrivedLocal(): void {
    this.localArrived = true;
  }

  private onTrainOutOfSection(): void {
    if (!this.hasAttention()) {
      this.hint('Call attention (1) first and wait for the reply before sending 2-1 (Train out of section).');
      this.irregular('Train out of section sent without call attention.', 'no_call_attention');
      return;
    }
    const mv = this.incoming;
    if (!mv || mv.stage !== 'inSection') {
      this.hint('There is no train in the section from ' + this.o.name + ', so 2-1 is not expected.');
      this.irregular('Train out of section sent with no train in the section.', 'unexpected_out_of_section');
      this.attentionAt = null;
      return;
    }
    if (this.token && !this.localTokenReplaced) {
      this.hint('Replace the token in your instrument before sending 2-1 (Train out of section).');
      return;
    }
    const early = !this.localArrived;
    if (early) {
      this.irregular('Train out of section sent before the train was confirmed arrived complete with tail lamp.', 'out_of_section_early');
      if (this.o.settings().strictness === 'learner') {
        this.hint('Only send 2-1 once the train has arrived complete with its tail lamp. Press "Train arrived" first, then send 2-1 again.');
        return;
      }
    }
    this.attentionAt = null;
    this.after(this.reactionDelay(), () => {
      this.ring(this.sig('train_out_of_section'));
      this.lastLoco = mv.locoId;
      if (!early) this.award('in_cleared');
      this.incoming = null;
      this.tokenOut = null;
      this.send({ type: 'movementComplete', direction: 'incoming', locoId: mv.locoId });
      if (!this.token && this.localInstrument !== 'LB') {
        this.awaitingLB = true;
        this.guide('Return your instrument to LINE BLOCKED.');
        this.after(this.o.settings().repeatAfterMs, () => {
          if (this.awaitingLB) {
            this.awaitingLB = false;
            this.hint('Your instrument should be returned to LINE BLOCKED once 2-1 has been sent.');
            this.irregular('Block instrument not returned to Line Blocked after Train out of section.', 'lb_late');
            this.movementDone(this.lastLoco);
          } else if (!this.incoming && !this.outgoing) this.guide();
        });
      } else {
        this.movementDone(mv.locoId);
        this.guide();
      }
    });
  }

  cancelIncoming(): void {
    const mv = this.incoming;
    if (!mv) return;
    if (mv.stage === 'inSection' || mv.stage === 'arrived') {
      this.hint('That train has already left and cannot be cancelled.');
      return;
    }
    if (this.awaiting?.repeatTimer != null) this.cancel(this.awaiting.repeatTimer);
    this.awaiting = null;
    if (mv.stage === 'calling' || mv.stage === 'offered' || mv.stage === 'held') {
      this.cancel(this.reofferTimer);
      this.reofferTimer = null;
      this.incoming = null;
      this.status('offer withdrawn.');
      this.guide();
      return;
    }
    // Accepted: needs a Cancelling exchange.
    this.after(this.reactionDelay(), () => {
      if (this.token && this.tokenOut === 'here') {
        this.tokenOut = null;
        this.send({ type: 'token', event: 'replaced' });
      }
      this.guide(`Answer 1, then repeat 3-5 (Cancelling).`);
      this.exchange(this.sig('call_attention'), 'Call attention', () => {
        this.after(this.reactionDelay(), () =>
          this.exchange(this.sig('cancelling'), 'Cancelling', () => {
            this.incoming = null;
            this.guide(this.token ? undefined : 'Train cancelled. Return your instrument to LINE BLOCKED.');
          }),
        );
      });
    });
  }

  // -------------------------------------------------------------------------
  // The user's instrument
  // -------------------------------------------------------------------------

  private onLocalInstrument(s: InstrumentState): void {
    const prev = this.localInstrument;
    this.localInstrument = s;
    if (prev === s) return;
    const mv = this.incoming;
    if (s === 'LC') {
      if (mv && mv.stage === 'awaitingLC') {
        this.award('in_line_clear');
        this.onLineClearShown(mv);
      } else if (!mv || mv.stage === 'calling' || mv.stage === 'offered' || mv.stage === 'held') {
        this.hint('Only turn the instrument to LINE CLEAR after you have accepted a train by repeating its "Is line clear" code.');
        this.irregular('Instrument turned to Line Clear without accepting a train.', 'lc_without_accept');
      }
    } else if (s === 'TOL') {
      if (!mv || mv.stage !== 'inSection') {
        if (mv && mv.stage === 'accepted' && this.awaiting) {
          // Turned as the 2 was heard, before repeating it: fine.
          this.scoreTol();
        } else {
          this.hint('TRAIN ON LINE is set after you acknowledge 2 (Train entering section).');
          this.irregular('Instrument turned to Train On Line before Train entering section.', 'tol_early');
        }
      } else {
        this.scoreTol();
        this.incomingRunningGuidance(mv);
      }
    } else if (s === 'LB') {
      if (mv && (mv.stage === 'accepted' || mv.stage === 'inSection')) {
        this.hint('A train is in (or about to enter) the section! The instrument must stay at LINE CLEAR or TRAIN ON LINE until Train out of section has been sent.');
        this.irregular('Instrument returned to Line Blocked with a train in or approaching the section.', 'lb_with_train');
      } else if (this.awaitingLB) {
        this.award('in_blocked');
        this.awaitingLB = false;
        this.movementDone(this.lastLoco);
        if (!mv && !this.outgoing) this.guide();
      } else if (!mv && !this.outgoing) {
        this.guide();
      }
    }
  }
}

/** For UI: count of beats as dots, e.g. "3-1" → "••• •" */
export function beatDots(code: BellCode): string {
  return codeToGroups(code)
    .map((n) => '•'.repeat(n))
    .join(' ');
}
