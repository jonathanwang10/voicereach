// H2-7.7: the Record tab's status copy for a queued or processing recording.
import { recordingPollInterval, recordingStatusView, POLL_MS, IN_PROGRESS } from '../recordingStatus';

const local = (state: 'pending' | 'uploading' | 'rejected', lastError: string | null = null): any => ({
  clientRecordingId: 'c1', fileUri: 'file:///docs/recordings/c1.m4a', durationMs: 6000, location: null,
  createdAt: '2026-11-07T10:00:00.000Z', state, attempts: 0, nextAttemptAt: 0, lastError,
});

it.each(['pending', 'uploading'] as const)('local %s offline is "Queued: no connection"', (state) => {
  expect(recordingStatusView(local(state), false, null)).toEqual({ label: 'Queued: no connection', tone: 'progress' });
});

it.each(['pending', 'uploading'] as const)('local %s online is "Uploading"', (state) => {
  expect(recordingStatusView(local(state), true, null)).toEqual({ label: 'Uploading', tone: 'progress' });
});

it('a rejected upload says so with the server reason', () => {
  expect(recordingStatusView(local('rejected', 'File is not in M4A format'), true, null))
    .toEqual({ label: "Couldn't upload this recording", tone: 'error', detail: 'File is not in M4A format' });
});

it.each(IN_PROGRESS)('server %s is "Transcribing"', (status) => {
  expect(recordingStatusView(null, true, { status, error: null })).toEqual({ label: 'Transcribing', tone: 'progress' });
});

it('server ready is "Ready to review"', () => {
  expect(recordingStatusView(null, false, { status: 'ready', error: null })).toEqual({ label: 'Ready to review', tone: 'ready' });
});

it('server failed says so with its error', () => {
  expect(recordingStatusView(null, true, { status: 'failed', error: 'Processing failed. Please record again.' }))
    .toEqual({ label: "Couldn't process this recording", tone: 'error', detail: 'Processing failed. Please record again.' });
});

it('polls every 2 s while in progress or unknown, and stops once done', () => {
  expect(POLL_MS).toBe(2000);
  expect(IN_PROGRESS).toEqual(['queued', 'transcribing', 'extracting', 'checking_duplicates']);
  expect(recordingPollInterval('transcribing')).toBe(2000);
  expect(recordingPollInterval(undefined)).toBe(2000);
  expect(recordingPollInterval('ready')).toBe(false);
  expect(recordingPollInterval('failed')).toBe(false);
});
