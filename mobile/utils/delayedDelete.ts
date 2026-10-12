// Delayed delete with undo (OD-3).
//
// Deleting a person hides them at once (Search filters out pending ids) and starts
// a short undo window. The real DELETE /api/individuals/{id} runs only when the
// window expires; Undo cancels it. If the DELETE fails, the person is shown again
// and the user is told.
//
// The pending state lives in memory only: if the app is killed before the window
// expires, the DELETE never runs and the person simply is not deleted.
import { api } from '../services/api';
import { showApiError } from './errorHandler';

export const DELETE_UNDO_MS = 5000;

type PendingEvent = { id: string; type: 'scheduled' | 'cancelled' | 'committed' | 'failed' };
type Listener = (event: PendingEvent) => void;

// `timer` is null once the window has expired and the DELETE is in flight
// (the person stays hidden until it settles, and can no longer be undone).
type Entry = { timer: ReturnType<typeof setTimeout> | null };

const pending = new Map<string, Entry>();
const listeners = new Set<Listener>();

const emit = (event: PendingEvent) => {
  listeners.forEach(cb => {
    try {
      cb(event);
    } catch {
      // one broken listener must not stop the others
    }
  });
};

const commit = async (id: string, entry: Entry, onError?: (e: unknown) => void) => {
  entry.timer = null;
  try {
    await api.deleteIndividual(id);
    if (pending.get(id) === entry) pending.delete(id);
    emit({ id, type: 'committed' });
  } catch (e) {
    if (pending.get(id) === entry) pending.delete(id);
    emit({ id, type: 'failed' });
    showApiError(e, "Couldn't delete — the profile was kept");
    onError?.(e);
  }
};

export function scheduleDelete(
  id: string,
  opts: { delayMs?: number; onError?: (e: unknown) => void } = {}
): { cancel: () => boolean } {
  const existing = pending.get(id);
  if (existing && existing.timer === null) {
    // Already being deleted: nothing to schedule, nothing to undo
    return { cancel: () => false };
  }
  if (existing?.timer) clearTimeout(existing.timer);

  const entry: Entry = { timer: null };
  entry.timer = setTimeout(() => {
    void commit(id, entry, opts.onError);
  }, opts.delayMs ?? DELETE_UNDO_MS);
  pending.set(id, entry);
  emit({ id, type: 'scheduled' });

  return {
    // true if the delete was cancelled; false if it was already sent (or cancelled)
    cancel: () => {
      if (pending.get(id) !== entry || entry.timer === null) return false;
      clearTimeout(entry.timer);
      pending.delete(id);
      emit({ id, type: 'cancelled' });
      return true;
    },
  };
}

export function isPendingDelete(id: string): boolean {
  return pending.has(id);
}

// True while any delete is pending (in its undo window or in flight).
export function hasPendingDeletes(): boolean {
  return pending.size > 0;
}

export function subscribePendingDeletes(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function __resetPendingDeletesForTests(): void {
  pending.forEach(entry => {
    if (entry.timer) clearTimeout(entry.timer);
  });
  pending.clear();
  listeners.clear();
}
