import type { BellCode, InstrumentState } from './types';

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
  // ---- Bookkeeping / coaching ----
  | { type: 'movementComplete'; direction: 'incoming' | 'outgoing'; locoId: string | null; roadId?: string }
  | { type: 'trainDeparted'; direction: 'incoming' | 'outgoing'; locoId: string | null }
  | { type: 'guidance'; text: string }
  | { type: 'hint'; text: string; level: 'info' | 'warn' }
  | { type: 'irregularity'; text: string }
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
