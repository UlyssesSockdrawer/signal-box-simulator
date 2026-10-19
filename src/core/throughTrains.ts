import { describeCode, signalCode, trainCode } from './bellcodes';
import type { SectionSession } from './session';
import type { CodeSet, TrainType } from './types';

/*
 * Through trains: a box that is not the end of the line can OFFER ON a train it has
 * accepted, instead of keeping it in its own station limits.
 *
 *   A (simulated) ── B (you) ── C (simulated)
 *
 * A offers an express to B. B accepts (repeats 4, Line Clear). The train's route at B
 * is "on to C", so B is prompted to offer it to C: call attention (1), then 4. When C
 * accepts and A sends 2 (Train entering section), B acknowledges and shows Train On Line;
 * as the train passes B, B sends 2 to C, then once the tail lamp has passed, B reports it
 * passed complete and sends 2-1 to A. C later sends 2-1 to B when it arrives at C's end.
 *
 * Each incoming line has a ROUTE: '' = stop here (into a road of a place the box works,
 * or at the box), or the id of another of the box's connections to offer it on to. The
 * default: a box that works no place (a junction box) with exactly one other line sends
 * trains on along it; any other box keeps them (a terminus accepts trains into its station
 * limits). The player can change the route at any time before the train has passed.
 */

export type ThroughStage =
  /** Not yet accepted from the box in rear. */
  | 'offered'
  /** Accepted from the box in rear: offer it on to the box in advance. */
  | 'offerOn'
  /** The box in advance has accepted it. */
  | 'acceptedOn'
  /** Sent on into the section ahead (2 sent forward). */
  | 'sentOn'
  /** Passed complete with tail lamp after being sent on. */
  | 'passed'
  /** Arrived complete and standing at this box before being sent on (it departs from here later). */
  | 'standing';

export interface ThroughTrain {
  fromConnId: string;
  toConnId: string;
  locoId: string;
  trainTypeId: string;
  stage: ThroughStage;
  /** The box in advance has accepted it. */
  acceptedOn: boolean;
  /** The onward box's departure has another train chosen, so this one cannot be offered on yet. */
  blocked: boolean;
}

export interface ThroughOptions {
  /** True when the box works at least one place (a station, sidings…): trains stop there by default. */
  worksPlaces: () => boolean;
  codeSet: () => CodeSet;
  trainTypes: () => TrainType[];
  locoLabel: (locoId: string) => string;
}

export class ThroughWorkings {
  /** Chosen routes, by incoming connection id ('' = stop here). Absent = the default. */
  private chosen = new Map<string, string>();
  private listeners = new Set<() => void>();
  private offs: Array<() => void> = [];

  constructor(
    private sessions: SectionSession[],
    private o: ThroughOptions,
  ) {
    for (const s of sessions) this.offs.push(s.controller.events.on('change', () => this.update()));
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.listeners.clear();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private session(connId: string): SectionSession | undefined {
    return this.sessions.find((s) => s.connection.id === connId);
  }

  /** The other lines a train arriving on `fromConnId` could be offered on to. */
  onwardChoices(fromConnId: string): SectionSession[] {
    return this.sessions.filter((s) => s.connection.id !== fromConnId);
  }

  defaultRoute(fromConnId: string): string {
    const others = this.onwardChoices(fromConnId);
    return !this.o.worksPlaces() && others.length === 1 ? others[0].connection.id : '';
  }

  /** The route for the train on `fromConnId`: '' = stop here, else the connection it is offered on to. */
  route(fromConnId: string): string {
    const r = this.chosen.get(fromConnId);
    if (r !== undefined && (r === '' || this.session(r))) return r;
    return this.defaultRoute(fromConnId);
  }

  /** Choose the route. Changing it after the train has been sent on is refused (returns an error). */
  setRoute(fromConnId: string, toConnId: string): string | null {
    const cur = this.through(fromConnId);
    if (cur && (cur.stage === 'sentOn' || cur.stage === 'passed') && toConnId !== cur.toConnId) return 'The train has already been sent on.';
    // Taking the train off a line it was offered on to: forget the declared train there.
    if (cur && cur.toConnId !== toConnId) {
      const out = this.session(cur.toConnId)?.controller;
      if (out?.view.outgoing && !out.view.outgoing.departed && out.view.outgoing.locoId === cur.locoId) out.setOutgoing(null, null);
    }
    this.chosen.set(fromConnId, toConnId);
    this.update();
    return null;
  }

  /** The through train on an incoming line, if its route is on to another line. */
  through(fromConnId: string): ThroughTrain | null {
    const from = this.session(fromConnId)?.controller;
    const inc = from?.view.incoming;
    const toConnId = this.route(fromConnId);
    if (!from || !inc || !toConnId) return null;
    const to = this.session(toConnId)?.controller;
    if (!to) return null;
    const v = from.view;
    const acceptedHere = inc.departed || (v.mode === 'ab' ? v.myInstrument !== 'LB' : v.tokenIndicator === 'coming');
    const out = to.view.outgoing;
    const ours = !!out && out.locoId === inc.locoId;
    const blocked = !!out && !!out.locoId && !ours;
    const ov = to.view;
    const acceptedOn = ours && (out!.departed || (ov.mode === 'ab' ? ov.remoteInstrument !== 'LB' : ov.tokenWithdrawnHere || ov.releaseAvailable));
    let stage: ThroughStage = 'offered';
    if (inc.arrived) stage = ours && out!.departed ? 'passed' : 'standing';
    else if (ours && out!.departed) stage = 'sentOn';
    else if (acceptedOn) stage = 'acceptedOn';
    else if (acceptedHere) stage = 'offerOn';
    return { fromConnId, toConnId, locoId: inc.locoId, trainTypeId: inc.trainTypeId, stage, acceptedOn, blocked };
  }

  /** Through trains on every incoming line. */
  all(): ThroughTrain[] {
    return this.sessions.map((s) => this.through(s.connection.id)).filter((t): t is ThroughTrain => !!t);
  }

  /** The through train being offered on to `toConnId`, if any. */
  throughTo(toConnId: string): ThroughTrain | null {
    return this.all().find((t) => t.toConnId === toConnId) ?? null;
  }

  /**
   * When the train arrives (passes) at this box: should it stay where it is? A through train that
   * has already been sent on into the section ahead is not moved back to the box.
   */
  keepLocoWhereItIs(fromConnId: string): boolean {
    const t = this.through(fromConnId);
    return !!t && t.stage === 'sentOn';
  }

  /** What the signaller should do next for through trains, if anything (learner guidance). */
  guidance(): { text: string; connId: string } | null {
    for (const t of this.all()) {
      const from = this.session(t.fromConnId)!;
      const to = this.session(t.toConnId)!;
      const fromName = from.connection.neighbourName;
      const toName = to.connection.neighbourName;
      const who = this.o.locoLabel(t.locoId);
      const set = this.o.codeSet();
      const code = trainCode(set, t.trainTypeId);
      const what = code ? `${code} (${describeCode(code, set, this.o.trainTypes())})` : 'the Is line clear code';
      const fv = from.controller.view;
      if (t.blocked && t.stage !== 'passed') {
        return { connId: t.toConnId, text: `${who} is routed on to ${toName}, but another train is chosen to depart to ${toName}. Clear that departure, or change the route of ${who} to stop here.` };
      }
      if (t.stage === 'standing') {
        const twoOne = `${signalCode(set, 'call_attention')} then ${signalCode(set, 'train_out_of_section')} (Train out of section) to ${fromName}`;
        return {
          connId: t.toConnId,
          text: t.acceptedOn
            ? `${who} is standing at your box and ${toName} has accepted it. Send ${twoOne}; as it departs, send ${signalCode(set, 'train_entering_section')} to ${toName}.`
            : `${who} is standing at your box. Send ${twoOne}, and offer it on to ${toName}: call attention, then ${what}.`,
        };
      }
      if (t.stage === 'offerOn') {
        return { connId: t.toConnId, text: `Offer ${who} on to ${toName}: on the ${toName} instruments call attention (tap ${signalCode(set, 'call_attention')}), then send ${what}.` };
      }
      if (t.stage === 'acceptedOn' && fv.incoming?.departed && fv.mode === 'ab' && fv.myInstrument !== 'TOL') return null; // let the box in rear's guidance say Train On Line first
      if (t.stage === 'acceptedOn' && fv.incoming?.departed) {
        return {
          connId: t.toConnId,
          text: `${who} is on its way from ${fromName} and ${toName} has accepted it. As it passes your box, send ${signalCode(set, 'train_entering_section')} (Train entering section) to ${toName}${to.controller.view.mode === 'token' ? ' (give the driver the token first)' : ''}.`,
        };
      }
      if (t.stage === 'sentOn') {
        return { connId: t.fromConnId, text: `${who} has gone on towards ${toName}. When its tail lamp has passed, press "passed complete" on the ${fromName} instruments, then call attention (${signalCode(set, 'call_attention')}) and send ${signalCode(set, 'train_out_of_section')} (Train out of section) to ${fromName}.` };
      }
    }
    return null;
  }

  /** What was declared on the onward line for each incoming line, to withdraw it if the train is cancelled. */
  private declared = new Map<string, { toConnId: string; locoId: string; arrived: boolean }>();

  /** Keep the onward line's declared departure in step with the through train. */
  private update(): void {
    for (const s of this.sessions) {
      const t = this.through(s.connection.id);
      const last = this.declared.get(s.connection.id);
      if (!t) {
        // Cancelled (or re-routed to stop here) before it reached the box: withdraw it from the line ahead.
        if (last && !last.arrived) {
          const out = this.session(last.toConnId)?.controller;
          if (out?.view.outgoing && !out.view.outgoing.departed && out.view.outgoing.locoId === last.locoId) out.setOutgoing(null, null);
        }
        this.declared.delete(s.connection.id);
        continue;
      }
      this.declared.set(s.connection.id, { toConnId: t.toConnId, locoId: t.locoId, arrived: t.stage === 'standing' || t.stage === 'passed' });
      if (t.blocked || t.stage === 'passed') continue;
      const to = this.session(t.toConnId)!.controller;
      const out = to.view.outgoing;
      if (!out || (!out.departed && (out.locoId !== t.locoId || out.trainTypeId !== t.trainTypeId))) to.setOutgoing(t.locoId, t.trainTypeId);
    }
    for (const fn of [...this.listeners]) fn();
  }
}
