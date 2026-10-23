/*
 * TRACK OCCUPANCY: which track circuits are occupied, and by what.
 *
 * One board per layout (occupancy is a fact about the railway, not about one signal box). It is
 * fed only by train events through a box's source of train events (core/trainEvents.ts):
 * enteredCircuit / clearedCircuit, reported by the simulated railway (signaller play mode), by the
 * person tapping a circuit on the diagram (model railway mode), or one day by train detection.
 *
 * Each circuit holds a set of occupants: a loco id, a rake of stock ('rake:<id>'), or 'person'
 * (marked by hand). A circuit is occupied while it holds anything.
 */

/** The occupant used for a circuit marked occupied by hand. */
export const MARKED = 'person';

export class OccupancyBoard {
  private occ = new Map<string, Set<string>>();
  private listeners = new Set<() => void>();

  /** Something has entered a circuit (`who`: a loco id, 'rake:<id>', or MARKED). */
  enter(circuitId: string, who: string): void {
    let s = this.occ.get(circuitId);
    if (!s) this.occ.set(circuitId, (s = new Set()));
    if (s.has(who)) return;
    s.add(who);
    this.changed();
  }

  /** Something has left a circuit. `who` omitted: clear it of everything (e.g. a detection section showing clear). */
  clear(circuitId: string, who?: string): void {
    const s = this.occ.get(circuitId);
    if (!s) return;
    if (who === undefined) s.clear();
    else if (!s.delete(who)) return;
    if (!s.size) this.occ.delete(circuitId);
    this.changed();
  }

  /** Take one occupant off every circuit (e.g. a simulated railway being stopped). */
  forget(who: (id: string) => boolean): void {
    let any = false;
    for (const [c, s] of this.occ) {
      for (const id of [...s]) if (who(id)) any = s.delete(id) || any;
      if (!s.size) this.occ.delete(c);
    }
    if (any) this.changed();
  }

  occupied(circuitId: string): boolean {
    return (this.occ.get(circuitId)?.size ?? 0) > 0;
  }

  /** What is in a circuit. */
  occupants(circuitId: string): string[] {
    return [...(this.occ.get(circuitId) ?? [])];
  }

  /** Is the circuit occupied by anything other than these? */
  occupiedBesides(circuitId: string, mine: (id: string) => boolean): boolean {
    for (const id of this.occ.get(circuitId) ?? []) if (!mine(id)) return true;
    return false;
  }

  /** Every occupied circuit. */
  occupiedIds(): string[] {
    return [...this.occ.keys()];
  }

  /** Marked by hand (model railway mode)? */
  marked(circuitId: string): boolean {
    return this.occ.get(circuitId)?.has(MARKED) ?? false;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
