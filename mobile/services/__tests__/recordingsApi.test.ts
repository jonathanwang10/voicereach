// H2-7.6: the recordings client. The upload is a background multipart request, so it
// carries on while the app is suspended.
const mockGetSession = jest.fn<any, any[]>();
const mockRefreshSession = jest.fn<any, any[]>();
jest.mock('../supabase', () => ({
  isSignedOutByUser: () => false,
  supabase: {
    auth: {
      getSession: (...a: any[]) => mockGetSession(...a),
      refreshSession: (...a: any[]) => mockRefreshSession(...a),
    },
  },
  autoLogin: jest.fn(async () => ({})),
}));
jest.mock('../deviceId', () => ({ getDeviceId: async () => 'dev-1' }));
jest.mock('expo-file-system', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { BACKGROUND: 0 },
}));

import * as FileSystem from 'expo-file-system';
import { api, ApiError } from '../api';
import { getApiUrl } from '../../config/api';

const LOC = { latitude: 37.78, longitude: -122.41, address: 'Market St' };
const UPLOAD = { clientRecordingId: 'c1', fileUri: 'file:///docs/recordings/c1.m4a', durationMs: 61000, location: LOC };
const upload = FileSystem.uploadAsync as jest.Mock;
const jsonResponse = (status: number, body: any) => ({
  ok: status >= 200 && status < 300, status, statusText: '',
  json: async () => body, text: async () => JSON.stringify(body),
});
const fetchMock = () => (global as any).fetch as jest.Mock;
const lastUrl = () => new URL(fetchMock().mock.calls.at(-1)[0]);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
  mockRefreshSession.mockResolvedValue({ data: { session: { access_token: 'new-tok' } }, error: null });
});
afterEach(() => { (global as any).fetch = undefined; });

describe('uploadRecording', () => {
  it('uploads as a background multipart request with the fields the server reads', async () => {
    upload.mockResolvedValue({ status: 202, body: '{"id":"r1","status":"queued"}' });
    await expect(api.uploadRecording(UPLOAD)).resolves.toEqual({ id: 'r1', status: 'queued' });
    expect(upload).toHaveBeenCalledWith(getApiUrl('/api/recordings'), 'file:///docs/recordings/c1.m4a', {
      httpMethod: 'POST', uploadType: 1, sessionType: 0, fieldName: 'audio', mimeType: 'audio/mp4',
      parameters: { client_recording_id: 'c1', duration_ms: '61000', location: JSON.stringify(LOC) },
      headers: { Authorization: 'Bearer tok', 'X-Device-Id': 'dev-1' },
    });
  });

  it('leaves location out when there is none', async () => {
    upload.mockResolvedValue({ status: 202, body: '{"id":"r1","status":"queued"}' });
    await api.uploadRecording({ ...UPLOAD, location: null });
    expect(upload.mock.calls[0][2].parameters).toEqual({ client_recording_id: 'c1', duration_ms: '61000' });
  });

  it('renews the session and retries once after a 401', async () => {
    upload.mockResolvedValueOnce({ status: 401, body: '{"detail":"Invalid or expired session"}' })
      .mockResolvedValueOnce({ status: 202, body: '{"id":"r1","status":"queued"}' });
    await expect(api.uploadRecording(UPLOAD)).resolves.toEqual({ id: 'r1', status: 'queued' });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][2].headers.Authorization).toBe('Bearer new-tok');
  });

  it("throws the server's detail for a 4xx", async () => {
    upload.mockResolvedValue({ status: 400, body: '{"detail":"File is not in M4A format"}' });
    const err = await api.uploadRecording(UPLOAD).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, detail: 'File is not in M4A format', kind: 'http' });
  });

  it('a body that is not JSON gets the generic message', async () => {
    upload.mockResolvedValue({ status: 502, body: '<html>bad gateway</html>' });
    const err = await api.uploadRecording(UPLOAD).catch(e => e);
    expect(err).toMatchObject({ status: 502, kind: 'http' });
    expect(err.detail).toBeTruthy();
  });

  it('a rejected upload is a network ApiError (status 0)', async () => {
    upload.mockRejectedValue(new Error('The Internet connection appears to be offline.'));
    const err = await api.uploadRecording(UPLOAD).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, kind: 'network' });
  });
});

describe('reading and deleting recordings', () => {
  it('getRecording reads GET /api/recordings/{id}', async () => {
    const detail = { id: 'r1', status: 'ready', error: null, result: null, location: null, duration_ms: 1, created_at: 'x' };
    (global as any).fetch = jest.fn(async () => jsonResponse(200, detail));
    await expect(api.getRecording('r1')).resolves.toEqual(detail);
    expect(lastUrl().pathname).toBe('/api/recordings/r1');
  });

  it('listRecordings passes the status filter', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(200, { recordings: [{ id: 'r1' }] }));
    await expect(api.listRecordings('ready')).resolves.toEqual([{ id: 'r1' }]);
    expect(lastUrl().pathname).toBe('/api/recordings');
    expect(lastUrl().searchParams.get('status')).toBe('ready');
    await api.listRecordings();
    expect(lastUrl().search).toBe('');
  });

  it('deleteRecording treats 404 as done', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(404, { detail: 'Recording not found' }));
    await expect(api.deleteRecording('r1')).resolves.toBeUndefined();
    expect(fetchMock().mock.calls[0][1].method).toBe('DELETE');
  });

  it('deleteRecording throws other failures', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(500, { detail: 'Delete recording failed' }));
    await expect(api.deleteRecording('r1')).rejects.toMatchObject({ status: 500 });
  });
});
