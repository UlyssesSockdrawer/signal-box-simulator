import { SCORE_RULES, type Scorecard, type ScoreRuleId } from './score';
import type { SectionSession } from './session';

/*
 * The box's referee: collects what each far box scores on its own line and puts it on the
 * box's scorecard, judging the CLEAN WORKING BONUS per train rather than per line.
 *
 * A far box only knows its own line: when a train movement on it finishes, it says whether the
 * line saw any irregularity since it was last clear (movementJudged). A through train is worked
 * on two lines (accepted from A, offered on to C): a mistake on A's line must cost it the bonus
 * even though C's line was clean, and it should earn one bonus for the whole journey, not one
 * per line. So:
 *   - every penalty counts against the train it was about (the far box says which), or, if it
 *     does not say, against every train being worked on that line at the time;
 *   - a train's record starts afresh when it starts a new journey through the box (it was not
 *     being worked on any of the box's lines, and now is);
 *   - a line finishing with the train but not clean counts against it too;
 *   - the bonus is given when the train's last line clears (it is no longer being worked on any
 *     line), and only if its record is clean. A line clearing while the train is still being
 *     worked on another line is not the end of its journey.
 */
export class BoxReferee {
  private faults = new Map<string, number>();
  private active = new Set<string>();
  private offs: Array<() => void> = [];

  constructor(
    private sessions: SectionSession[],
    private card: Scorecard,
  ) {
    this.active = this.activeLocos();
    for (const s of sessions) {
      const c = s.controller;
      this.offs.push(c.events.on('change', () => this.refresh()));
      this.offs.push(c.events.on('score', ({ rule, detail, locoId }) => this.score(s, rule, detail, locoId)));
      this.offs.push(c.events.on('movementJudged', ({ locoId, clean }) => this.judged(s, locoId, clean)));
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
  }

  /** Trains being offered or worked on any of the box's lines. */
  private activeLocos(): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions) {
      const v = s.controller.view;
      if (v.incoming?.locoId) out.add(v.incoming.locoId);
      if (v.outgoing?.locoId) out.add(v.outgoing.locoId);
    }
    return out;
  }

  private refresh(): void {
    const now = this.activeLocos();
    // A train starting a new journey through the box starts with a clean record.
    for (const id of now) if (!this.active.has(id)) this.faults.set(id, 0);
    this.active = now;
  }

  /** A line has finished with a train: give the clean working bonus if the train's whole journey through the box was clean. */
  private judged(s: SectionSession, locoId: string | null, clean: boolean): void {
    this.refresh();
    const line = s.connection.neighbourName;
    if (!locoId) {
      if (clean) this.card.add('clean_working', line);
      return;
    }
    if (!clean) this.faults.set(locoId, (this.faults.get(locoId) ?? 0) + 1);
    // Still being worked on another line: its journey is not over yet.
    if (this.active.has(locoId)) return;
    if (!(this.faults.get(locoId) ?? 0)) this.card.add('clean_working', line);
    this.faults.delete(locoId);
  }

  /** Points for something on line s (from its far box, or judged by the box itself, e.g. regulating). */
  score(s: SectionSession, rule: ScoreRuleId, detail: string, locoId: string | null): void {
    this.refresh();
    this.card.add(rule, s.connection.neighbourName, detail);
    if (SCORE_RULES[rule].points < 0) {
      const v = s.controller.view;
      const ids = locoId ? [locoId] : [v.incoming?.locoId, v.outgoing?.locoId].filter((x): x is string => !!x);
      for (const id of ids) this.faults.set(id, (this.faults.get(id) ?? 0) + 1);
    }
  }
}
