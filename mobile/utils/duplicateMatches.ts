// Shared duplicate-match handling for voice review and manual entry.
import { Alert } from 'react-native';
import type { DuplicateMatch } from '../services/api';
import { isPendingDelete } from './delayedDelete';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Matches the worker can merge into: a real UUID, and not someone whose delayed
// delete is pending (merging into them would be lost when the delete cascades).
export const mergeableMatches = (matches?: DuplicateMatch[] | null): DuplicateMatch[] =>
  (matches ?? []).filter(m => UUID_RE.test(m.id) && !isPendingDelete(m.id));

// Both lists as one: one entry per id at its highest confidence, best first.
export const unionMatches = (...lists: Array<DuplicateMatch[] | null | undefined>): DuplicateMatch[] => {
  const byId = new Map<string, DuplicateMatch>();
  lists.forEach(list => (list ?? []).forEach(m => {
    const seen = byId.get(m.id);
    if (!seen || m.confidence > seen.confidence) byId.set(m.id, m);
  }));
  return Array.from(byId.values()).sort((a, b) => b.confidence - a.confidence);
};

// At most this many matches are shown: the backend returns up to 3, and voice
// review's re-check may add its own (H2-3.5).
export const MAX_SHOWN_MATCHES = 3;

// The lists as one: de-duplicated at the highest confidence, only mergeable
// matches, best first, at most MAX_SHOWN_MATCHES.
export const topMatches = (...lists: Array<DuplicateMatch[] | null | undefined>): DuplicateMatch[] =>
  mergeableMatches(unionMatches(...lists)).slice(0, MAX_SHOWN_MATCHES);

// The highest-confidence mergeable match, or null.
export const bestMergeableMatch = (matches?: DuplicateMatch[] | null): DuplicateMatch | null =>
  mergeableMatches(matches).reduce<DuplicateMatch | null>(
    (best, m) => (!best || m.confidence > best.confidence ? m : best), null);

// One meaning for match-confidence colours on every screen (C-62): how sure the
// check is that this is the same person. >= 95 high (green), 60-94 medium (yellow),
// below 60 low (red; the backend drops those, so they rarely reach the app).
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export const confidenceLevel = (confidence: number): ConfidenceLevel =>
  confidence >= 95 ? 'high' : confidence >= 60 ? 'medium' : 'low';

const CONFIDENCE_COLORS: Record<ConfidenceLevel, { accent: string; background: string; text: string }> = {
  high: { accent: '#28a745', background: '#d4edda', text: '#155724' },
  medium: { accent: '#ffc107', background: '#fff3cd', text: '#856404' },
  low: { accent: '#dc3545', background: '#f8d7da', text: '#721c24' },
};

// accent: borders; background: a tinted row; text: readable text on white or the tint
export const confidenceColor = (confidence: number) => CONFIDENCE_COLORS[confidenceLevel(confidence)];

// When the duplicate check fails, ask instead of silently saving a possible
// duplicate (C-08). Resolves true for "Save as new", false otherwise.
export const confirmSaveAsNew = (): Promise<boolean> =>
  new Promise(resolve => {
    Alert.alert(
      'Duplicate check unavailable',
      'Save as new anyway?',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Save as new', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
