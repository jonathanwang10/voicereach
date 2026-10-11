// C-62: one meaning for match-confidence colours on every screen: a stronger
// match is green, a medium one yellow (MergeUI used to show high confidence as red).
jest.mock('../delayedDelete', () => ({ isPendingDelete: () => false }));

import { confidenceColor, confidenceLevel } from '../duplicateMatches';

it('bands confidence as >= 95 high, 60-94 medium, below 60 low', () => {
  expect(confidenceLevel(100)).toBe('high');
  expect(confidenceLevel(95)).toBe('high');
  expect(confidenceLevel(94.5)).toBe('medium');
  expect(confidenceLevel(60)).toBe('medium');
  expect(confidenceLevel(59)).toBe('low');
});

it('high is green and medium is yellow', () => {
  expect(confidenceColor(97).accent).toBe('#28a745');
  expect(confidenceColor(70).accent).toBe('#ffc107');
  expect(confidenceColor(40).accent).toBe('#dc3545');
});
