import type { ScoreRuleId } from './score';
import type { BellCode, InstrumentState } from './types';

/** Blocking back: 'inside' the home signal (2-4) or 'outside' it on to the line (3-3). */
export type RearBlock = 'inside' | 'outside';
/** A shunt into the forward section (3-3-2), or a token released for shunting (5-2). */
export type ForwardBlock = 'shunt' | 'token';

/**
 * Messages exchanged between two signal boxes along one section.
 *
 * Today the far end is a SimulatedNeighbour running in the same app. Because
 * everything goes through these messages, a future networked box (another
 * tablet running this app) can be dropped in by sending the same messages
 * over a WebSocket instead.
 */
export type LinkMessage =
  /** A bell code tapped by the sender. holdLast = plunger held on the final beat (token release). */
  | { type: 'bell'; code: BellCode; holdLast: boolean }
  /** The sender's own block instrument (the one it works for trains coming TO it). */
  | { type: 'instrument'; state: InstrumentState }
  /** The sender withdrew a token from, or replaced one into, its token instrument. */
  | { type: 'token'; event: 'withdrawn' | 'replaced' }
  /** The sender is (or stops) holding its plunger to release a token at the other end. */
  | { type: 'release'; active: boolean }
  /** Whether the sender regards the user's box as open (5-5-5 exchanged) or closed. */
  | { type: 'boxState'; open: boolean }
  // ---- Operator (layout) actions: things the model railway operator does, not the signaller ----
  | { type: 'operator'; action: 'offerIncoming'; locoId: string; trainTypeId: string }
  | { type: 'operator'; action: 'cancelIncoming' }
  | { type: 'operator'; action: 'declareOutgoing'; locoId: string | null; trainTypeId: string | null }
  | { type: 'operator'; action: 'arrivedLocal'; locoId: string | null }
  | { type: 'operator'; action: 'arrivedRemote'; locoId: string | null; roadId: string }
  /** The box has just cleared another line (sent 2-1): a train the far box is holding may be offered again now. */
  | { type: 'operator'; action: 'promptReoffer' }
  /**
   * Where the far box's offer of the next incoming train stands: its Is line clear has rung (offered),
   * it took no reply as a refusal and is holding the train (held, offering again at nextAt),
   * or the train has been accepted. reoffers = how many times it has been offered again.
   */
  | { type: 'offer'; state: 'offered' | 'held' | 'accepted'; reoffers: number; nextAt?: number }
  /**
   * Permissions the far box has given the user's box to obstruct the line between them (v0.3.32):
   * rear = the line from the far box is blocked back (2-4, inside the home signal within the clearing
   * point; 3-3, outside the home signal); forward = a shunt has been let into the section towards the
   * far box (3-3-2), or a token released for shunting (5-2). null when not given (or given up again).
   */
  | { type: 'permission'; rear: RearBlock | null; forward: ForwardBlock | null }
  // ---- Bookkeeping / coaching ----
  | { type: 'movementComplete'; direction: 'incoming' | 'outgoing'; locoId: string | null; roadId?: string }
  | { type: 'trainDeparted'; direction: 'incoming' | 'outgoing'; locoId: string | null }
  /**
   * Learner guidance. `drive`: the part that tells you to drive the train to the far end and report it
   * arrived (left out when someone else, e.g. a simulated fiddle yard operator, does that); `idle`: the
   * section is clear and nothing is being signalled on this line.
   */
  | { type: 'guidance'; text: string; drive?: string; idle?: boolean }
  | { type: 'hint'; text: string; level: 'info' | 'warn' }
  | { type: 'irregularity'; text: string }
  /** Points gained or lost by the signaller (the far box referees). */
  | { type: 'score'; rule: ScoreRuleId; detail?: string; locoId?: string }
  /** A train movement on this line has finished; clean = no irregularity on the line since it was last clear. */
  | { type: 'movementJudged'; locoId?: string; clean: boolean }
  | { type: 'status'; text: string };

export interface LinkEnd {
  send(msg: LinkMessage): void;
  onMessage(fn: (msg: LinkMessage) => void): void;
}

/** Two connected in-memory link ends. Delivery is synchronous. */
export function createLinkPair(): [LinkEnd, LinkEnd] {
  const handlers: [Array<(m: LinkMessage) => void>, Array<(m: LinkMessage) => void>] = [[], []];
  const end = (mine: 0 | 1): LinkEnd => ({
    send: (msg) => {
      for (const h of handlers[mine === 0 ? 1 : 0]) h(msg);
    },
    onMessage: (fn) => {
      handlers[mine].push(fn);
    },
  });
  return [end(0), end(1)];
}
