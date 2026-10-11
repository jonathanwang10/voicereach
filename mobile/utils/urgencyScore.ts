export const getUrgencyScoreColor = (score: number): string => {
  if (score >= 0 && score <= 33) {
    return '#10B981'; // Green
  } else if (score >= 34 && score <= 66) {
    return '#F59E0B'; // Yellow
  } else {
    return '#EF4444'; // Red
  }
};

export const getDisplayUrgencyScore = (individual: { urgency_score: number; urgency_override?: number | null }): number => {
  return individual.urgency_override !== null && individual.urgency_override !== undefined
    ? individual.urgency_override
    : individual.urgency_score;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days since `iso` (floor), so anything in the last 24 hours is 0 ("today").
// Never negative (a slightly-ahead server clock); an unparseable date counts as 0.
// "Last seen" itself comes from the backend: the latest interaction, else created_at.
export const daysSince = (iso: string, now: Date = new Date()): number => {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.floor(elapsed / DAY_MS);
};

export const formatLastSeen = (days: number): string => {
  if (days <= 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
};
