import { describe, expect, it } from 'vitest';
import { createDefaultState } from './defaults';
import { HeadcodeAllocator, checkHeadcode, destinationLetters, eraOf, fillHeadcodes, headcodeClassWarning, lampPattern, lampText, wantsHeadcode } from './headcodes';

describe('headcodes', () => {
  it('gives each place a unique destination letter, last word first', () => {
    const s = createDefaultState();
    const letters = destinationLetters(s.layouts[0]);
    expect(letters.get('fy-west')).toBe('W');
    expect(letters.get('fy-east')).toBe('E');
    expect(letters.get('sgc-station')).toBe('C');
    expect(new Set(letters.values()).size).toBe(letters.size);
  });

  it('draws lamp codes per era', () => {
    expect(lampPattern('grouping', 'express_passenger')).toEqual({ left: true, top: false, centre: false, right: true });
    expect(lampText(lampPattern('grouping', 'express_passenger')!)).toBe('lamps over each buffer');
    expect(lampPattern('grouping', 'ordinary_passenger')!.top).toBe(true);
    // Class C and D swapped round by BR.
    expect(lampPattern('grouping', 'parcels')).toEqual({ left: true, top: true, centre: false, right: false });
    expect(lampPattern('brLamps', 'parcels')).toEqual({ left: true, top: false, centre: true, right: false });
    expect(lampPattern('br1960', 'parcels')).toBeNull();
    expect(lampPattern('grouping', 'custom_type')).toBeNull();
  });

  it('allocates headcodes and reporting numbers by era', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    const a = new HeadcodeAllocator('br1960', l, ['2E01']);
    expect(a.next('ordinary_passenger', 'fy-east')).toBe('2E02');
    expect(a.next('express_passenger', 'fy-west')).toBe('1W01');
    expect(a.next('light_engine', 'sgc-goods')).toMatch(/^0[A-Z]01$/);
    expect(a.next('light_engine', 'sgc-goods', 'shunt')).toBe('');
    const g = new HeadcodeAllocator('grouping', l);
    expect(g.next('ordinary_passenger', 'fy-east')).toBe('101');
    expect(g.next('mineral', 'fy-east')).toBe('501');
    expect(g.next('light_engine', 'fy-east')).toBe('');
    expect(wantsHeadcode('grouping', { kind: 'run', trainTypeId: 'light_engine' })).toBe(false);
  });

  it('checks the shape of headcodes', () => {
    expect(checkHeadcode('br1960', '2E11')).toBeNull();
    expect(checkHeadcode('br1960', '123')).not.toBeNull();
    expect(checkHeadcode('grouping', '123')).toBeNull();
    expect(checkHeadcode('grouping', '2E11')).not.toBeNull();
    expect(headcodeClassWarning('br1960', '1E01', 'ordinary_passenger')).not.toBeNull();
  });

  it('fills in a timetable', () => {
    const s = createDefaultState();
    const l = s.layouts[0];
    expect(eraOf(l)).toBe('br1960');
    l.headcodeEra = 'grouping';
    const tt = l.timetables![0];
    const n = fillHeadcodes(s, l, tt, true);
    expect(n).toBeGreaterThan(0);
    for (const e of tt.entries) if (e.headcode) expect(e.headcode).toMatch(/^\d{3}$/);
    expect(fillHeadcodes(s, l, tt, false)).toBe(0);
  });
});
