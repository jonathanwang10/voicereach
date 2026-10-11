// C-62: urgency colours use half-open bands, 0-33 green, 34-66 yellow, 67-100 red,
// so non-integers land in the right band instead of falling through to red; an
// undefined override is "no override".
import { getUrgencyLevel, getUrgencyScoreColor, getDisplayUrgencyScore } from '../urgencyScore';

const GREEN = '#10B981';
const YELLOW = '#F59E0B';
const RED = '#EF4444';

it.each([
  [0, GREEN], [33, GREEN], [33.5, GREEN], [33.99, GREEN],
  [34, YELLOW], [50, YELLOW], [66, YELLOW], [66.5, YELLOW],
  [67, RED], [100, RED],
])('score %p is %p', (score, colour) => {
  expect(getUrgencyScoreColor(score)).toBe(colour);
});

it('a missing or invalid score is not shown as red', () => {
  expect(getUrgencyScoreColor(NaN)).toBe(GREEN);
  expect(getUrgencyScoreColor(undefined as any)).toBe(GREEN);
  expect(getUrgencyScoreColor(-5)).toBe(GREEN);
});

it('levels match the colours (used for badges and labels)', () => {
  expect(getUrgencyLevel(33.5)).toBe('low');
  expect(getUrgencyLevel(66.5)).toBe('medium');
  expect(getUrgencyLevel(67)).toBe('high');
});

it('an undefined or null override falls back to the calculated score; 0 is a real override', () => {
  expect(getDisplayUrgencyScore({ urgency_score: 40 })).toBe(40);
  expect(getDisplayUrgencyScore({ urgency_score: 40, urgency_override: undefined })).toBe(40);
  expect(getDisplayUrgencyScore({ urgency_score: 40, urgency_override: null })).toBe(40);
  expect(getDisplayUrgencyScore({ urgency_score: 40, urgency_override: 0 })).toBe(0);
});
