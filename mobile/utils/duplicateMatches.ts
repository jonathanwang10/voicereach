// Shared duplicate-match handling for voice review and manual entry.
import { Alert } from 'react-native';
import type { DuplicateMatch } from '../services/api';
import { isPendingDelete } from './delayedDelete';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Matches the worker can merge into: a real UUID, and not someone whose delayed
// delete is pending (merging into them would be lost when the delete cascades).
export const mergeableMatches = (matches?: DuplicateMatch[] | null): DuplicateMatch[] =>
  (matches ?? []).filter(m => UUID_RE.test(m.id) && !isPendingDelete(m.id));

// The highest-confidence mergeable match, or null.
export const bestMergeableMatch = (matches?: DuplicateMatch[] | null): DuplicateMatch | null =>
  mergeableMatches(matches).reduce<DuplicateMatch | null>(
    (best, m) => (!best || m.confidence > best.confidence ? m : best), null);

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
