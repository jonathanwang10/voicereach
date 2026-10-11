import { colors } from '../theme/colors';

export type UrgencyLevel = 'low' | 'medium' | 'high';

// One set of bands everywhere: 0-33 low (green), 34-66 medium (yellow), 67-100 high
// (red), as half-open ranges [0, 34), [34, 67), [67, 100] so a non-integer such as
// 33.5 or 66.5 lands in the band below instead of falling through to red (C-62).
// A missing or invalid score (NaN, undefined, negative) counts as low.
export const getUrgencyLevel = (score: number): UrgencyLevel => {
  if (!(score >= 34)) return 'low';
  return score < 67 ? 'medium' : 'high';
};

export const getUrgencyScoreColor = (score: number): string => colors.urgencyScore[getUrgencyLevel(score)];

export const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  low: 'Low Urgency',
  medium: 'Medium Urgency',
  high: 'High Urgency',
};

// The Badge variant for each band (same green/yellow/red meaning)
export const URGENCY_BADGE_VARIANT = { low: 'success', medium: 'warning', high: 'danger' } as const;

// The manual override when one is set (0 counts), else the calculated score.
export const getDisplayUrgencyScore = (individual: { urgency_score: number; urgency_override?: number | null }): number =>
  individual.urgency_override != null ? individual.urgency_override : individual.urgency_score;

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
