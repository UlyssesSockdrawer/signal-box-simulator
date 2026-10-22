import { describe, expect, it } from 'vitest';
import { BR_1960, describeCode } from './bellcodes';
import { createDefaultState } from './defaults';
import { BoxReferee } from './referee';
import { FakeScheduler } from './scheduler';
import { Scorecard, type ScoreRuleId } from './score';
import { createBoxSession } from './session';
import { migrate } from './store';
import type { AppState, WorkingMode } from './types';

/** Sigsim Central's line to Fiddle Yard West, worked by hand: the far box is simulated. */
function setup(mode: WorkingMode = 'ab') {
  const state: AppState = createDefaultState();
  state.settings.workingModes['sgc-west'] = mode;
  state.settings.responseDelayMs = [1000, 1000];
  state.settings.despatchDelayMs = [5000, 5000];
  const sched = new FakeScheduler();
  const sessions = createBoxSession(state.boxes[0], () => state, sched);
  const sess = sessions.find((x) => x.connection.id === 'sgc-west')!;
  const c = sess.controller;
  const card = new Scorecard(() => sched.now());
  const rules: ScoreRuleId[] = [];
  new BoxReferee([sess], card);
  card.onChange((e) => e && rules.push(e.rule));
  const bells: string[] = [];
  c.events.on('bellIn', (b) => bells.push(b.code + (b.holdLast ? '!' : '')));
  sess.neighbour!.start();
  const tick = (ms = 4000) => sched.advance(ms);
  const ring = (code: string) => {
    c.sendBell('1');
    tick();
    c.sendBell(code);
    tick(8000);
  };
  ring('5-5-5');
  bells.length = 0;
  rules.length = 0;
  return { state, sched, c, rules, bells, tick, ring, n: sess.neighbour! };
}

describe('permission to shunt on the line', () => {
  it('has bell codes for blocking back inside and outside the home, shunting into the section and shunt withdrawn, clashing with no train code', () => {
    for (const [code, name] of [
      ['2-4', 'Blocking back inside home signal'],
      ['3-3', 'Blocking back outside home signal'],
      ['3-3-2', 'Shunt into forward section'],
      ['8', 'Shunt withdrawn'],
      ['5-2', 'Release token for shunting'],
      ['2-5', 'Train withdrawn / token replaced'],
    ])
      expect(describeCode(code, BR_1960, createDefaultState().trainTypes)).toBe(name);
    // A code set saved before these signals existed gets them (unless it already uses the code).
    const old = JSON.parse(JSON.stringify(createDefaultState()));
    for (const cs of old.codeSets) for (const id of ['blocking_back_inside', 'shunt_into_forward', 'shunt_withdrawn']) delete cs.signals[id];
    old.codeSets[0].signals.testing = '8';
    const s = migrate(old);
    expect(s.codeSets[0].signals.blocking_back_inside).toBe('2-4');
    expect(s.codeSets[0].signals.shunt_withdrawn).toBeUndefined();
    expect(s.codeSets[1].signals.shunt_withdrawn).toBe('8');
  });

  it('2-4: blocked back inside the home signal, trains held, then 2-1 (Obstruction removed) gives the line back', () => {
    const t = setup();
    t.ring('2-4');
    expect(t.bells).toEqual(['1', '2-4']);
    expect(t.c.view.permission).toEqual({ rear: 'inside', forward: null });
    t.c.setInstrument('TOL');
    expect(t.c.view.guidance).toMatch(/2-1 \(Obstruction removed\)/);
    // The fiddle yard holds its next train while the line is blocked back.
    t.c.requestIncoming('lms5025', 'ordinary_passenger');
    t.tick(30_000);
    expect(t.bells).toEqual(['1', '2-4']);
    expect(t.c.view.incoming?.held).toBe(true);
    // Line Blocked too soon is a safety breach.
    t.c.setInstrument('LB');
    expect(t.rules).toContain('lb_while_blocked');
    t.c.setInstrument('TOL');
    t.ring('2-1');
    expect(t.c.view.permission).toEqual({ rear: null, forward: null });
    t.c.setInstrument('LB');
    expect(t.rules).toEqual(expect.arrayContaining(['block_given', 'block_cleared', 'in_blocked']));
    // ...and then offers the train it was holding.
    t.tick(8000);
    t.c.sendBell('1');
    t.tick();
    expect(t.bells.at(-1)).toBe('3-1');
  });

  it('3-3: not given while a train is accepted from the box in rear', () => {
    const t = setup();
    t.c.requestIncoming('lms5025', 'ordinary_passenger');
    t.tick();
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('3-1');
    t.tick(3000);
    t.c.setInstrument('LC');
    t.bells.length = 0;
    t.c.sendBell('1');
    t.tick(1500);
    t.c.sendBell('3-3');
    t.tick(1500);
    expect(t.bells).not.toContain('3-3');
    expect(t.c.view.permission.rear).toBeNull();
    expect(t.rules).toContain('block_busy');
  });

  it('3-3-2: a shunt into the forward section shows Train On Line on the repeater until 8 (Shunt withdrawn)', () => {
    const t = setup();
    t.ring('3-3-2');
    expect(t.bells).toEqual(['1', '3-3-2']);
    expect(t.c.view.remoteInstrument).toBe('TOL');
    expect(t.c.view.permission).toEqual({ rear: null, forward: 'shunt' });
    // No train may be offered into the section meanwhile.
    t.ring('3-1');
    expect(t.rules).toContain('offered_section_busy');
    t.ring('8');
    expect(t.c.view.remoteInstrument).toBe('LB');
    expect(t.c.view.permission.forward).toBeNull();
    expect(t.rules).toEqual(expect.arrayContaining(['block_given', 'block_cleared']));
    // 8 again, with no shunt out, is not expected.
    t.ring('8');
    expect(t.rules).toContain('block_not_expected');
  });

  it('token lines: 3-3-2 is not answered; 5-2 releases a shunting token, 2-5 once it is back in the instrument', () => {
    const t = setup('token');
    t.ring('3-3-2');
    expect(t.bells).toEqual(['1']);
    t.c.sendBell('1');
    t.tick();
    t.c.sendBell('5-2');
    t.tick(6000);
    expect(t.bells).toContain('5-2!');
    expect(t.c.view.releaseAvailable).toBe(true);
    expect(t.c.withdrawToken()).toBeNull();
    expect(t.c.view.permission.forward).toBe('token');
    expect(t.c.view.guidance).toMatch(/Replace token/);
    t.tick(30_000);
    expect(t.c.replaceToken()).toBeNull();
    t.ring('2-5');
    expect(t.bells.at(-1)).toBe('2-5');
    expect(t.c.view.permission.forward).toBeNull();
    expect(t.rules).toEqual(expect.arrayContaining(['block_given', 'block_cleared']));
  });
});
