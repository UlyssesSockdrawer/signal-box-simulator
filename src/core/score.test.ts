import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { FakeScheduler } from './scheduler';
import { pointsText, SCORE_RULES, Scorecard, type ScoreRuleId } from './score';
import { createBoxSession } from './session';
import { BoxReferee } from './referee';
import type { AppState, WorkingMode } from './types';

function setup(mode: WorkingMode = 'ab') {
  const state: AppState = createDefaultState();
  state.settings.workingModes['becton-fy'] = mode;
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  const sched = new FakeScheduler();
  const [sess] = createBoxSession(state.boxes[0], () => state, sched);
  const c = sess.controller;
  const card = new Scorecard(() => sched.now());
  const rules: ScoreRuleId[] = [];
  new BoxReferee([sess], card);
  card.onChange((e) => e && rules.push(e.rule));
  c.events.on('locoMoved', (m) => {
    const l = state.roster.find((x) => x.id === m.locoId);
    if (l) l.location = m.location;
  });
  sess.neighbour!.start();
  const tick = (ms = 4000) => sched.advance(ms);
  return { state, sched, c, card, rules, tick };
}

function open(t: ReturnType<typeof setup>) {
  t.c.sendBell('1');
  t.tick();
  t.c.sendBell('5-5-5');
  t.tick(8000);
}

function incoming(t: ReturnType<typeof setup>, arriveFirst = true) {
  t.c.requestIncoming('ex1', 'ordinary_passenger');
  t.tick();
  t.c.sendBell('1');
  t.tick();
  t.c.sendBell('3-1');
  t.c.setInstrument('LC');
  t.tick(8000);
  t.c.sendBell('2');
  t.c.setInstrument('TOL');
  t.tick();
  if (arriveFirst) t.c.confirmIncomingArrived({ placeId: 'becton-station', roadId: 'becton-p1' });
  t.c.sendBell('1');
  t.tick();
  t.c.sendBell('2-1');
  t.tick();
}

describe('Scorecard', () => {
  it('adds up points by category and can start again', () => {
    let now = 1000;
    const card = new Scorecard(() => now);
    card.add('box_opened', 'FY');
    now = 2000;
    card.add('wrong_reply', 'FY', '2');
    card.add('no_line_clear', 'FY');
    expect(card.total).toBe(10 - 5 - 50);
    const s = card.summary();
    expect(s.byCategory.working).toEqual({ gained: 0, lost: 0, count: 0 });
    expect(s.byCategory.procedure).toEqual({ gained: 10, lost: 5, count: 2 });
    expect(s.safetyBreaches).toBe(1);
    expect(s.lastAt).toBe(2000);
    const snap = card.snapshot();
    card.reset();
    expect(card.total).toBe(0);
    expect(snap.total).toBe(-45);
  });

  it('has a rule for every scored event, and words points with a true minus sign', () => {
    for (const r of Object.values(SCORE_RULES)) expect(r.label.length).toBeGreaterThan(5);
    expect(pointsText(10)).toBe('+10');
    expect(pointsText(-5)).toBe('−5');
  });
});

describe('Scoring a session (absolute block)', () => {
  it('scores opening the box, a clean incoming train and closing the box', () => {
    const t = setup();
    open(t);
    expect(t.rules).toEqual(['box_opened']);
    incoming(t);
    t.c.setInstrument('LB');
    t.tick();
    expect(t.rules).toEqual(['box_opened', 'in_accepted', 'in_line_clear', 'in_entering', 'in_tol', 'in_cleared', 'in_blocked', 'clean_working']);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('7-5-5');
    t.tick(8000);
    expect(t.rules.at(-1)).toBe('box_closed');
    expect(t.card.total).toBe(10 + 10 + 5 + 5 + 5 + 10 + 5 + 20 + 10);
    expect(t.c.irregularities).toEqual([]);
  });

  it('scores a clean outgoing train', () => {
    const t = setup();
    open(t);
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-3');
    t.tick();
    t.c.sendBell('2');
    t.tick();
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.rules).toEqual(['box_opened', 'out_offered', 'out_departed', 'out_cleared', 'clean_working']);
  });

  it('takes points off for a wrong description and gives no clean working bonus', () => {
    const t = setup();
    open(t);
    t.c.setOutgoing('ex4', 'light_engine');
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick();
    t.c.sendBell('2');
    t.tick();
    t.c.confirmOutgoingArrived('road5', null);
    t.tick(5000);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.rules).toEqual(['box_opened', 'wrong_description', 'out_departed', 'out_cleared']);
  });

  it('treats sending a train without line clear as a safety breach', () => {
    const t = setup();
    open(t);
    t.c.sendBell('2');
    t.tick();
    expect(t.rules.at(-1)).toBe('no_line_clear');
    expect(t.card.summary().safetyBreaches).toBe(1);
  });

  it('penalises 2-1 before the train has arrived complete', () => {
    const t = setup();
    t.state.settings.strictness = 'strict';
    open(t);
    incoming(t, false);
    expect(t.rules).toContain('out_of_section_early');
    expect(t.rules).not.toContain('in_cleared');
  });

  it('penalises leaving the instrument off Line Blocked, once', () => {
    const t = setup();
    open(t);
    incoming(t);
    t.tick(30000);
    expect(t.rules.filter((r) => r === 'lb_late')).toHaveLength(1);
    expect(t.rules).not.toContain('in_blocked');
    expect(t.rules).not.toContain('clean_working');
  });

  it('takes points off once when the far box has to ring again, not every time', () => {
    const t = setup();
    open(t);
    t.c.requestIncoming('ex1', 'ordinary_passenger');
    t.tick(70000); // no answer: the far box rings 1 again and again
    expect(t.rules.filter((r) => r === 'no_reply')).toHaveLength(1);
  });
});

describe('Scoring a session (key token)', () => {
  it('scores an incoming token train, and a missing held beat', () => {
    const t = setup('token');
    open(t);
    t.c.requestIncoming('ex1', 'ordinary_passenger');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1'); // not held
    t.tick();
    expect(t.rules).toContain('no_hold');
    t.c.sendBell('3-1', true);
    t.tick(9000);
    t.c.sendBell('2');
    t.tick();
    t.c.confirmIncomingArrived();
    t.c.replaceToken();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('2-1');
    t.tick();
    expect(t.rules).toEqual(['box_opened', 'no_hold', 'in_accepted', 'in_entering', 'in_cleared']);
  });
});
