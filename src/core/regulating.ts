import { trainCode, trainRank } from './bellcodes';
import type { Scheduler } from './scheduler';
import type { ScoreRuleId } from './score';
import type { SectionSession } from './session';
import type { CodeSet, ConnectionDef, Settings, TrainType } from './types';

/*
 * REFUSALS AND REGULATING, across all the lines of one box.
 *
 * Refusing a train is done the prototypical way, by not answering its Is line clear: the far box
 * (SimulatedNeighbour) takes the silence as a refusal, holds the train and offers it again later.
 * This class watches every line of the box:
 *   - the refusal tracker: each train held at a far box (line, train, first offered, re-offers),
 *     cleared when the train is accepted or withdrawn;
 *   - after the signaller's Train out of section on one line, a train held on another line is
 *     offered again promptly (the box is free now);
 *   - REGULATING CHECKS (incoming offers only): when two or more offers are outstanding at once,
 *     accepting the higher class (code set rank) scores regulated_ok, accepting a lower class while
 *     a higher one is waiting scores regulated_wrong. Equal ranks are not judged; a higher class
 *     offered after an acceptance is no fault (only offers outstanding at the moment count);
 *   - "Offers can coincide" (setting): when a train is asked for on one line, another line offers
 *     one at about the same time, so regulating comes up in practice.
 * Departures, through trains offered on and timetable lateness are for the future simulated
 * running module.
 */

export interface OutstandingOffer {
  session: SectionSession;
  connId: string;
  /** The far box's name. */
  line: string;
  locoId: string;
  trainTypeId: string;
  code: string;
  classLabel: string;
  rank: number | undefined;
  /** Refused and held at the far box (not ringing now). */
  held: boolean;
  offeredAt: number;
}

export interface HeldOffer {
  connId: string;
  line: string;
  locoId: string;
  trainTypeId: string;
  firstOfferedAt: number;
  reoffers: number;
  nextOfferAt: number | null;
}

export interface RegulatorOptions {
  scheduler: Scheduler;
  codeSet: () => CodeSet;
  trainTypes: () => TrainType[];
  settings: () => Settings;
  locoLabel: (locoId: string | null) => string;
  /** Trains that could be offered over a line now (for coinciding offers). */
  candidates: (conn: ConnectionDef) => Array<{ id: string; trainTypeId: string }>;
  /** Points through the box's referee, so a penalty counts against the train it names. */
  score: (s: SectionSession, rule: ScoreRuleId, detail: string, locoId: string | null) => void;
  random?: () => number;
}

export class BoxRegulator {
  private offs: Array<() => void> = [];
  private timers = new Set<number>();
  /** True while this class itself asks for a coinciding offer (so it does not set off another). */
  private coinciding = false;
  private random: () => number;

  constructor(
    private sessions: SectionSession[],
    private o: RegulatorOptions,
  ) {
    this.random = o.random ?? Math.random;
    for (const s of sessions) {
      const c = s.controller;
      this.offs.push(c.events.on('offerAccepted', (e) => this.onAccepted(s, e.locoId, e.trainTypeId)));
      this.offs.push(c.events.on('sectionCleared', (e) => this.onCleared(s, e.direction)));
      this.offs.push(c.events.on('incomingRequested', (e) => this.onRequested(s, e.trainTypeId)));
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    for (const t of this.timers) this.o.scheduler.clearTimeout(t);
    this.timers.clear();
  }

  /** Incoming trains whose Is line clear has been rung and which have not been accepted yet (ringing now, or held). */
  outstanding(): OutstandingOffer[] {
    const set = this.o.codeSet();
    const out: OutstandingOffer[] = [];
    for (const s of this.sessions) {
      const inc = s.controller.view.incoming;
      if (!inc || inc.offeredAt === null || inc.acceptedAt !== null || inc.departed) continue;
      out.push({
        session: s,
        connId: s.connection.id,
        line: s.connection.neighbourName,
        locoId: inc.locoId,
        trainTypeId: inc.trainTypeId,
        code: trainCode(set, inc.trainTypeId),
        classLabel: set.trainCodes[inc.trainTypeId]?.classLabel ?? '',
        rank: trainRank(set, inc.trainTypeId),
        held: inc.held,
        offeredAt: inc.offeredAt,
      });
    }
    return out;
  }

  /** The refusal tracker: every train held at a far box because it was not accepted. */
  held(): HeldOffer[] {
    return this.sessions.flatMap((s) => {
      const inc = s.controller.view.incoming;
      if (!inc?.held || inc.offeredAt === null) return [];
      return [{ connId: s.connection.id, line: s.connection.neighbourName, locoId: inc.locoId, trainTypeId: inc.trainTypeId, firstOfferedAt: inc.offeredAt, reoffers: inc.reoffers, nextOfferAt: inc.nextOfferAt }];
    });
  }

  /**
   * Learner advice before a lower class acceptance: with two or more offers outstanding and a
   * higher class among them, say which to accept first. connId = the line of the train to take first.
   */
  advice(): { text: string; connId: string } | null {
    const offers = this.outstanding().filter((x) => x.rank !== undefined);
    if (offers.length < 2) return null;
    const top = Math.max(...offers.map((x) => x.rank!));
    const firsts = offers.filter((x) => x.rank === top);
    const lower = offers.filter((x) => x.rank! < top);
    if (!lower.length) return null;
    const words = (x: OutstandingOffer) => `${x.code} (${this.trainWords(x.trainTypeId)}${x.classLabel ? `, ${x.classLabel}` : ''})`;
    const first = firsts.find((x) => !x.held) ?? firsts[0];
    const lowerText = lower.map((x) => `${x.line}'s ${words(x)}`).join(' and ');
    const take = first.held
      ? `${first.line} is holding ${words(first)}, a higher class: accept it first when it is offered again. Don’t accept ${lowerText} before it.`
      : `Accept ${first.line}’s ${words(first)} first (higher class): repeat ${first.code}. Let ${lowerText} wait.`;
    return { text: `Regulating: ${take}`, connId: first.connId };
  }

  private trainWords(trainTypeId: string): string {
    return (this.o.trainTypes().find((t) => t.id === trainTypeId)?.name ?? 'train').toLowerCase();
  }

  /** A train has just been accepted: judge the choice against the other offers outstanding at this moment. */
  private onAccepted(s: SectionSession, locoId: string, trainTypeId: string): void {
    const set = this.o.codeSet();
    const rank = trainRank(set, trainTypeId);
    if (rank === undefined) return;
    const others = this.outstanding().filter((x) => x.session !== s && x.rank !== undefined);
    if (!others.length) return;
    const code = trainCode(set, trainTypeId);
    const mine = `${code || this.trainWords(trainTypeId)} from ${s.connection.neighbourName}`;
    const higher = others.filter((x) => x.rank! > rank);
    const lower = others.filter((x) => x.rank! < rank);
    if (higher.length) {
      const h = higher.sort((a, b) => b.rank! - a.rank!)[0];
      const detail = `accepted ${mine} while ${h.code}${h.classLabel ? ` (${h.classLabel})` : ''} from ${h.line} was waiting`;
      s.controller.note('irregularity', `Regulating: ${detail}. The higher class train should have been accepted first.`);
      this.o.score(s, 'regulated_wrong', detail, locoId);
    } else if (lower.length) {
      const l = lower[0];
      const detail = `accepted ${mine} before ${l.code}${l.classLabel ? ` (${l.classLabel})` : ''} from ${l.line}`;
      s.controller.note('status', `Regulated: ${detail}.`);
      this.o.score(s, 'regulated_ok', detail, locoId);
    }
  }

  /** The signaller's Train out of section on one line: the box is free, so trains held on other lines are offered again soon. */
  private onCleared(s: SectionSession, direction: 'incoming' | 'outgoing'): void {
    if (direction !== 'incoming') return;
    for (const x of this.sessions) if (x !== s) x.controller.promptReoffer();
  }

  /** "Offers can coincide": another line offers a train at about the same time as the one just asked for. */
  private onRequested(s: SectionSession, trainTypeId: string): void {
    if (this.coinciding || !this.o.settings().coincidingOffers) return;
    const lines = this.sessions.filter((x) => x !== s && this.canOffer(x) && this.choices(x).length);
    if (!lines.length) return;
    const line = lines[Math.floor(this.random() * lines.length)];
    const delay = 1500 + this.random() * 3500;
    const id = this.o.scheduler.setTimeout(() => {
      this.timers.delete(id);
      if (!this.canOffer(line)) return;
      const all = this.choices(line);
      // A different class makes the offers worth regulating.
      const set = this.o.codeSet();
      const r = trainRank(set, trainTypeId);
      const differ = all.filter((l) => trainRank(set, l.trainTypeId) !== r);
      const pool = differ.length ? differ : all;
      if (!pool.length) return;
      const pick = pool[Math.floor(this.random() * pool.length)];
      this.coinciding = true;
      try {
        line.controller.requestIncoming(pick.id, pick.trainTypeId);
      } finally {
        this.coinciding = false;
      }
    }, delay);
    this.timers.add(id);
  }

  private canOffer(s: SectionSession): boolean {
    const v = s.controller.view;
    if (!v.boxOpen || v.incoming) return false;
    if (v.lineType === 'single' && (v.outgoing || v.tokenWithdrawnHere || v.remoteInstrument !== 'LB')) return false;
    return true;
  }

  /** Trains that could be offered on a line, leaving out any already being worked on another line. */
  private choices(s: SectionSession): Array<{ id: string; trainTypeId: string }> {
    const busy = new Set(this.sessions.flatMap((x) => [x.controller.view.incoming?.locoId, x.controller.view.outgoing?.locoId]).filter(Boolean));
    return this.o.candidates(s.connection).filter((l) => !busy.has(l.id) && trainCode(this.o.codeSet(), l.trainTypeId));
  }
}
