// C-62: one meaning for match-confidence colours on every screen: a stronger
// match is green, a medium one yellow (MergeUI used to show high confidence as red).
jest.mock('../delayedDelete', () => ({ isPendingDelete: () => false }));

import { confidenceColor, confidenceLevel, topMatches } from '../duplicateMatches';

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

// H2-3.5: the backend returns up to 3; voice review may add its re-check's
const uuid = (tag: string) => `00000000-0000-4000-8000-${tag.charCodeAt(0).toString(16).padStart(12, '0')}`;

it('topMatches de-duplicates, drops non-UUIDs and pending deletes, and keeps the best 3', () => {
  const m = (id: string, c: number) => ({ id: uuid(id), name: id, confidence: c });
  expect(topMatches([m('a', 70), m('b', 90)], [m('a', 95), m('c', 61), m('d', 80), { id: 'mock', name: 'x', confidence: 99 }])
    .map(x => x.confidence)).toEqual([95, 90, 80]);
});
