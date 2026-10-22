/*
 * Scoring: for have-a-go sessions (exhibitions, visitors), the signaller earns
 * points for each part of a train working done by the book and loses points
 * for irregularities, with the heaviest losses for safety breaches.
 *
 * The far signaller (SimulatedNeighbour) is the referee: it already notices
 * the user's mistakes, so it also reports what was done well. It sends
 * { type: 'score', rule } messages; a Scorecard (one per running box) adds
 * them up and keeps the log shown on the score sheet.
 */

export type ScoreCategory = 'working' | 'procedure' | 'safety';

export interface ScoreRule {
  points: number;
  /** Shown in the score sheet's log. */
  label: string;
  category: ScoreCategory;
}

export const SCORE_RULES = {
  // ---- Box working done correctly (procedure) ----
  box_opened: { points: 10, label: 'Box opened (1, then 5-5-5)', category: 'procedure' },
  box_closed: { points: 10, label: 'Box closed (1, then 7-5-5)', category: 'procedure' },
  // ---- Train workings done correctly ----
  out_offered: { points: 10, label: 'Train offered correctly (call attention, then Is line clear)', category: 'working' },
  out_departed: { points: 10, label: 'Train sent on its way with the line clear (2, Train entering section)', category: 'working' },
  out_cleared: { points: 10, label: 'Train out of section acknowledged (2-1)', category: 'working' },
  in_accepted: { points: 10, label: 'Train accepted: Is line clear repeated', category: 'working' },
  in_line_clear: { points: 5, label: 'Block instrument turned to Line Clear', category: 'working' },
  in_entering: { points: 5, label: 'Train entering section acknowledged (2)', category: 'working' },
  in_tol: { points: 5, label: 'Block instrument turned to Train On Line', category: 'working' },
  in_cleared: { points: 10, label: 'Train out of section sent after the train arrived complete (2-1)', category: 'working' },
  in_blocked: { points: 5, label: 'Block instrument returned to Line Blocked', category: 'working' },
  clean_working: { points: 20, label: 'Clean working bonus: the whole train movement without an irregularity', category: 'working' },
  // ---- Regulating (two or more trains offered at once) ----
  block_given: { points: 5, label: 'Permission to shunt on the line asked for and given (2-4, 3-3, 3-3-2 or 5-2)', category: 'working' },
  block_cleared: { points: 5, label: 'Line given back after shunting (2-1 Obstruction removed, 8 Shunt withdrawn or 2-5)', category: 'working' },
  regulated_ok: { points: 5, label: 'Regulated correctly: accepted the higher class train first', category: 'procedure' },

  // ---- Procedure irregularities: mistakes that do not put a train at risk ----
  no_reply: { points: -3, label: 'Slow to answer: the far box had to ring again', category: 'procedure' },
  wrong_reply: { points: -5, label: 'Wrong code sent in reply', category: 'procedure' },
  no_call_attention: { points: -5, label: 'Code sent without calling attention first', category: 'procedure' },
  unrecognised_code: { points: -5, label: 'Unrecognised bell code', category: 'procedure' },
  box_not_open: { points: -5, label: 'Train offered before the box was opened', category: 'procedure' },
  no_hold: { points: -5, label: 'Last beat not held for a token release', category: 'procedure' },
  wrong_description: { points: -10, label: 'Train offered with the wrong description', category: 'procedure' },
  misdescribed_not_corrected: { points: -10, label: 'Wrong description not corrected: the receiving box reported it on arrival (5-3)', category: 'procedure' },
  close_with_train: { points: -10, label: 'Tried to close the box with a train being signalled', category: 'procedure' },
  tol_early: { points: -10, label: 'Train On Line shown before the train entered the section', category: 'procedure' },
  tol_late: { points: -10, label: 'Train On Line not shown while the train was in the section', category: 'procedure' },
  lb_late: { points: -5, label: 'Instrument left off Line Blocked after the train cleared', category: 'procedure' },
  unexpected_out_of_section: { points: -10, label: 'Train out of section sent with no train in the section', category: 'procedure' },
  block_busy: { points: -10, label: 'Asked to block the line while a train was signalled on it', category: 'procedure' },
  block_not_expected: { points: -5, label: 'Gave back a line that had not been blocked', category: 'procedure' },
  regulated_wrong: { points: -10, label: 'Regulating: accepted a lower class train while a higher class one was waiting', category: 'procedure' },

  // ---- Safety: the ones that matter on a real railway ----
  lc_without_accept: { points: -20, label: 'Line Clear given without accepting a train', category: 'safety' },
  offered_section_busy: { points: -25, label: 'Train offered into a section that was not clear', category: 'safety' },
  out_of_section_early: { points: -40, label: 'Train out of section sent before the train arrived complete with tail lamp', category: 'safety' },
  lb_with_train: { points: -40, label: 'Line Blocked shown with a train in or approaching the section', category: 'safety' },
  lb_while_blocked: { points: -20, label: 'Line Blocked shown while the line was blocked back for shunting', category: 'safety' },
  shunt_without_permission: { points: -40, label: 'Shunted out on to the line without permission (blocking back, 3-3-2 or a token)', category: 'safety' },
  lc_clearing_point: { points: -25, label: 'Line Clear given with the line inside the home signal obstructed (clearing point not clear)', category: 'safety' },
  no_line_clear: { points: -50, label: 'Train sent without Line Clear', category: 'safety' },
  no_token: { points: -50, label: 'Train sent without a token', category: 'safety' },
  unsignalled_train: { points: -50, label: 'Train ran without being signalled', category: 'safety' },
} satisfies Record<string, ScoreRule>;

export type ScoreRuleId = keyof typeof SCORE_RULES;

export const CATEGORY_NAMES: Record<ScoreCategory, string> = {
  working: 'Train workings',
  procedure: 'Procedure',
  safety: 'Safety',
};

export interface ScoreEntry {
  t: number;
  rule: ScoreRuleId;
  points: number;
  label: string;
  category: ScoreCategory;
  /** The line it happened on (the connected box's name). */
  line: string;
  /** Extra detail, e.g. the code that was sent. */
  detail: string;
}

export interface ScoreSummary {
  total: number;
  /** Sum of points gained and lost per category. */
  byCategory: Record<ScoreCategory, { gained: number; lost: number; count: number }>;
  trainsIn: number;
  trainsOut: number;
  cleanWorkings: number;
  safetyBreaches: number;
  startedAt: number;
  lastAt: number;
}

/** The running score for one signal box session. */
export class Scorecard {
  readonly entries: ScoreEntry[] = [];
  startedAt: number;
  private listeners = new Set<(e: ScoreEntry | null) => void>();

  constructor(private now: () => number = Date.now) {
    this.startedAt = now();
  }

  add(rule: ScoreRuleId, line: string, detail = ''): ScoreEntry | null {
    const r = SCORE_RULES[rule] as ScoreRule | undefined;
    if (!r) return null;
    const e: ScoreEntry = { t: this.now(), rule, points: r.points, label: r.label, category: r.category, line, detail };
    this.entries.push(e);
    for (const fn of [...this.listeners]) fn(e);
    return e;
  }

  get total(): number {
    return this.entries.reduce((n, e) => n + e.points, 0);
  }

  summary(): ScoreSummary {
    const byCategory: ScoreSummary['byCategory'] = {
      working: { gained: 0, lost: 0, count: 0 },
      procedure: { gained: 0, lost: 0, count: 0 },
      safety: { gained: 0, lost: 0, count: 0 },
    };
    for (const e of this.entries) {
      const c = byCategory[e.category];
      c.count++;
      if (e.points >= 0) c.gained += e.points;
      else c.lost += -e.points;
    }
    const n = (rule: ScoreRuleId) => this.entries.filter((e) => e.rule === rule).length;
    return {
      total: this.total,
      byCategory,
      trainsIn: n('in_cleared') + n('out_of_section_early'),
      trainsOut: n('out_cleared'),
      cleanWorkings: n('clean_working'),
      safetyBreaches: byCategory.safety.count,
      startedAt: this.startedAt,
      lastAt: this.entries.at(-1)?.t ?? this.startedAt,
    };
  }

  /** Start a fresh score (e.g. for the next visitor) without touching the box. */
  reset(): void {
    this.entries.length = 0;
    this.startedAt = this.now();
    for (const fn of [...this.listeners]) fn(null);
  }

  /** Called with each new entry, or null when the score is reset. */
  onChange(fn: (e: ScoreEntry | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A copy that no longer changes, e.g. the final score when the box closes. */
  snapshot(): Scorecard {
    const c = new Scorecard(this.now);
    c.startedAt = this.startedAt;
    c.entries.push(...this.entries.map((e) => ({ ...e })));
    return c;
  }
}

/** "+10" / "−5" (with a true minus sign). */
export function pointsText(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}
