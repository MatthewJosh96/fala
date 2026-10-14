import { describe, expect, it } from 'vitest';
import { greeting } from './greeting';

describe('greeting by time of day', () => {
  it.each([
    [5, 'Dzień dobry'],
    [11, 'Dzień dobry'],
    [12, 'Dzień dobry'],
    [17, 'Dzień dobry'],
    [18, 'Dobry wieczór'],
    [21, 'Dobry wieczór'],
    [22, 'Dobrej nocy'],
    [0, 'Dobrej nocy'],
    [4, 'Dobrej nocy'],
  ])('%i:00 → %s', (hour, title) => {
    expect(greeting(hour).title).toBe(title);
  });

  it('has a different subtitle for morning, afternoon, evening and night', () => {
    const subs = new Set([5, 13, 19, 23].map((h) => greeting(h).subtitle));
    expect(subs.size).toBe(4);
  });
});
