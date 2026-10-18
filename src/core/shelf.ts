import type { BoxDef, ConnectionDef } from './types';

/** Name for a shelf position, e.g. Left / Centre / Right, or "Position 4". */
export function positionLabel(index: number, count: number): string {
  if (count === 1) return 'Centre';
  if (count === 2) return index === 0 ? 'Left' : 'Right';
  if (count === 3) return ['Left', 'Centre', 'Right'][index] ?? `Position ${index + 1}`;
  if (index === 0) return 'Position 1 (left)';
  if (index === count - 1) return `Position ${count} (right)`;
  return `Position ${index + 1}`;
}

/**
 * Lay a box's connections out on its shelf. Returns one entry per position:
 * the connection placed there, or null for an empty position. Two connections
 * asking for the same position, or one beyond the end, move to the nearest free one.
 */
export function layoutShelf(box: BoxDef): Array<ConnectionDef | null> {
  const count = Math.max(box.shelfPositions || 1, box.connections.length);
  const slots: Array<ConnectionDef | null> = new Array(count).fill(null);
  const pending: ConnectionDef[] = [];
  for (const c of box.connections) {
    const p = Math.min(Math.max(0, Math.round(c.shelfPosition ?? 0)), count - 1);
    if (slots[p] === null) slots[p] = c;
    else pending.push(c);
  }
  for (const c of pending) {
    const want = Math.min(Math.max(0, c.shelfPosition ?? 0), count - 1);
    let best = -1;
    for (let i = 0; i < count; i++) if (slots[i] === null && (best < 0 || Math.abs(i - want) < Math.abs(best - want))) best = i;
    if (best >= 0) slots[best] = c;
  }
  return slots;
}
