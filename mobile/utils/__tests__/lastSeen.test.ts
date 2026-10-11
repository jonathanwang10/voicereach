// C-32: "last seen" is whole days elapsed (floor), so anything in the last 24 h is
// "today", never "1 day ago".
import { daysSince, formatLastSeen } from '../urgencyScore';

const NOW = new Date('2026-10-11T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('daysSince', () => {
  it('is 0 for anything within the last 24 hours', () => {
    expect(daysSince(hoursAgo(0), NOW)).toBe(0);
    expect(daysSince(hoursAgo(1), NOW)).toBe(0);
    expect(daysSince(hoursAgo(23.9), NOW)).toBe(0);
  });

  it('floors whole days', () => {
    expect(daysSince(hoursAgo(24), NOW)).toBe(1);
    expect(daysSince(hoursAgo(47), NOW)).toBe(1);
    expect(daysSince(hoursAgo(24 * 10 + 5), NOW)).toBe(10);
  });

  it('never goes negative for a timestamp slightly in the future (clock skew)', () => {
    expect(daysSince(hoursAgo(-2), NOW)).toBe(0);
  });

  it('is 0 for an unparseable date instead of NaN', () => {
    expect(daysSince('not a date', NOW)).toBe(0);
  });
});

describe('formatLastSeen', () => {
  it('says today, 1 day ago, or N days ago', () => {
    expect(formatLastSeen(0)).toBe('today');
    expect(formatLastSeen(1)).toBe('1 day ago');
    expect(formatLastSeen(7)).toBe('7 days ago');
  });
});
