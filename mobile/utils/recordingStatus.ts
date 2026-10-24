// What the Record tab says about a recording (H2-7.7): on the phone (queued or
// uploading), then on the server (processing, ready, failed). Pure, so it is tested
// directly.
import type { RecordingState } from '../services/api';
import type { QueuedRecording } from '../services/recordingQueueStore';

export const IN_PROGRESS: RecordingState[] = ['queued', 'transcribing', 'extracting', 'checking_duplicates'];
export const POLL_MS = 2000;

// Poll while the server is still working on it (or before its status is known)
export function recordingPollInterval(status: RecordingState | undefined): number | false {
  return status === undefined || IN_PROGRESS.includes(status) ? POLL_MS : false;
}

export interface StatusView {
  label: string;
  tone: 'progress' | 'ready' | 'error';
  detail?: string;
}

export function recordingStatusView(
  local: QueuedRecording | null,
  online: boolean,
  server: { status: RecordingState; error: string | null } | null,
): StatusView {
  if (server) {
    if (server.status === 'ready') return { label: 'Ready to review', tone: 'ready' };
    if (server.status === 'failed') {
      return { label: "Couldn't process this recording", tone: 'error', detail: server.error ?? undefined };
    }
    return { label: 'Transcribing', tone: 'progress' };
  }
  if (local?.state === 'rejected') {
    return { label: "Couldn't upload this recording", tone: 'error', detail: local.lastError ?? undefined };
  }
  return { label: online ? 'Uploading' : 'Queued: no connection', tone: 'progress' };
}
