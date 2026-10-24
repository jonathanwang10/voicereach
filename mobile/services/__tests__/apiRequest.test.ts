// One transport for every backend call (C-16, C-17, C-37): a single ApiError carrying
// the backend `detail`, no toasts from the transport, 401 refresh-then-autoLogin retry,
// GET-only network retry, AbortController timeouts, and reads that throw.
const mockGetSession = jest.fn<any, any[]>();
const mockRefreshSession = jest.fn<any, any[]>();
const mockAutoLogin = jest.fn<any, any[]>(async () => ({}));
const mockFrom = jest.fn<any, any[]>();
let mockSignedOut = false;
jest.mock('../supabase', () => ({
  isSignedOutByUser: () => mockSignedOut,
  supabase: {
    auth: {
      getSession: (...a: any[]) => mockGetSession(...a),
      refreshSession: (...a: any[]) => mockRefreshSession(...a),
    },
    from: (...a: any[]) => mockFrom(...a),
  },
  autoLogin: (...a: any[]) => mockAutoLogin(...a),
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../deviceId', () => ({ getDeviceId: async () => 'dev-1' }));

import Toast from 'react-native-toast-message';
import { api, apiRequest, authedFetch, ApiError, getAuthToken } from '../api';

const session = (token: string) => ({ data: { session: { access_token: token } } });
const jsonResponse = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const fetchMock = () => (global as any).fetch as jest.Mock;
const authHeader = (call: number) => fetchMock().mock.calls[call][1].headers.Authorization;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue(session('old-token'));
  mockRefreshSession.mockResolvedValue({ data: { session: { access_token: 'new-token' } }, error: null });
});
afterEach(() => { (global as any).fetch = undefined; });

describe('H2-6.15 device id', () => {
  it('sends X-Device-Id on every request, the 401 retry included', async () => {
    (global as any).fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'Invalid or expired session' }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    await authedFetch('/api/categories');
    expect(fetchMock().mock.calls.map(c => c[1].headers['X-Device-Id'])).toEqual(['dev-1', 'dev-1']);
  });
});

describe('apiRequest errors', () => {
  it('throws one ApiError carrying the backend detail, and never toasts', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(400, { detail: 'gender: Invalid option' }));
    const err = await apiRequest('/api/individuals', { method: 'POST', body: '{}' }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, detail: 'gender: Invalid option', kind: 'http' });
    expect(err.message).toBe('gender: Invalid option');
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('joins a FastAPI 422 list, naming each field by its last loc element', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(422, {
      detail: [{ loc: ['body', 'height'], msg: 'Field required', type: 'missing' },
               { loc: ['body', 'weight'], msg: 'Field required', type: 'missing' }],
    }));
    await expect(apiRequest('/x', { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ status: 422, detail: 'height: Field required; weight: Field required' });
  });

  it('skips list indexes and a bare "body" when naming a 422 field', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(422, {
      detail: [{ loc: ['body', 'location', 'latitude'], msg: 'Input should be a valid number', type: 'x' },
               { loc: ['body', 'tags', 0], msg: 'Input should be a valid string', type: 'x' },
               { loc: ['body'], msg: 'Invalid JSON', type: 'x' },
               { msg: 'No loc at all', type: 'x' }],
    }));
    await expect(apiRequest('/x', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      detail: 'latitude: Input should be a valid number; tags: Input should be a valid string; Invalid JSON; No loc at all',
    });
  });

  it('uses a generic message when the body is not JSON', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(502, '<html>Bad gateway</html>'));
    const err = await apiRequest('/x').catch(e => e);
    expect(err).toMatchObject({ status: 502, kind: 'http' });
    expect(err.detail).not.toContain('html');
  });

  it('returns undefined for 204', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } }));
    await expect(apiRequest('/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('authedFetch auth', () => {
  it('on 401 refreshes the session and retries once with the new token', async () => {
    (global as any).fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'Invalid or expired session' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    await expect(apiRequest('/x')).resolves.toEqual({ ok: 1 });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(authHeader(0)).toBe('Bearer old-token');
    expect(authHeader(1)).toBe('Bearer new-token');
    expect(mockAutoLogin).not.toHaveBeenCalled();
  });

  it('falls back to autoLogin when the refresh fails', async () => {
    mockRefreshSession.mockResolvedValue({ data: { session: null }, error: new Error('refresh token expired') });
    mockGetSession
      .mockResolvedValueOnce(session('old-token'))
      .mockResolvedValueOnce(session('signed-in-token'));
    (global as any).fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'Invalid or expired session' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    await expect(apiRequest('/x')).resolves.toEqual({ ok: 1 });
    expect(mockAutoLogin).toHaveBeenCalledTimes(1);
    expect(authHeader(1)).toBe('Bearer signed-in-token');
  });

  // Minor 3: after the worker's Sign Out, a 401 never signs the device back in.
  it('after Sign Out, a failed refresh is reported instead of signing in again', async () => {
    mockSignedOut = true;
    try {
      mockRefreshSession.mockResolvedValue({ data: { session: null }, error: new Error('signed out') });
      mockGetSession.mockResolvedValueOnce(session('old-token'));
      (global as any).fetch = jest.fn(async () => jsonResponse(401, { detail: 'Invalid or expired session' }));
      await expect(apiRequest('/x')).rejects.toMatchObject({ status: 0, kind: 'auth' });
      expect(mockAutoLogin).not.toHaveBeenCalled();
      expect(fetchMock()).toHaveBeenCalledTimes(1);
    } finally {
      mockSignedOut = false;
    }
  });

  it('a second 401 is reported, not retried again', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(401, { detail: 'Invalid or expired session' }));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 401, kind: 'auth' });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it('getAuthToken throws an auth ApiError when sign-in is impossible', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await expect(getAuthToken()).rejects.toMatchObject({ kind: 'auth', status: 0 });
  });
});

describe('authedFetch network and timeouts', () => {
  it('retries a network failure once for GET', async () => {
    (global as any).fetch = jest.fn()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    await expect(apiRequest('/x')).resolves.toEqual({ ok: 1 });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it('does not retry a network failure for POST', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    await expect(apiRequest('/x', { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ status: 0, kind: 'network' });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('aborts after the timeout with a timeout ApiError', async () => {
    (global as any).fetch = jest.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }));
    await expect(apiRequest('/x', {}, { timeoutMs: 20 })).rejects.toMatchObject({ status: 0, kind: 'timeout' });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('sets a JSON Content-Type only for string bodies', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(200, {}));
    await authedFetch('/a', { method: 'POST', body: '{}' });
    await authedFetch('/b', { method: 'POST', body: new FormData() });
    expect(fetchMock().mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(fetchMock().mock.calls[1][1].headers['Content-Type']).toBeUndefined();
  });
});

describe('reads throw instead of returning empty values', () => {
  it('getIndividualProfile throws ApiError(404) for a missing person', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(404, { detail: 'Individual not found: x' }));
    await expect(api.getIndividualProfile('x')).rejects.toMatchObject({ status: 404 });
  });

  it('getIndividualProfile throws when the history fails to load', async () => {
    (global as any).fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { individual: { id: 'x', name: 'Ann', data: {} } }))
      .mockResolvedValueOnce(jsonResponse(500, { detail: 'Get interactions failed' }));
    await expect(api.getIndividualProfile('x')).rejects.toMatchObject({ status: 500 });
  });

  it('getInteractions throws on failure', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(500, { detail: 'Get interactions failed' }));
    await expect(api.getInteractions('x')).rejects.toMatchObject({ status: 500 });
  });

  it('getCategories throws on failure', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(500, { detail: 'Fetch categories failed' }));
    await expect(api.getCategories()).rejects.toMatchObject({ detail: 'Fetch categories failed' });
  });

  it('semanticSearchIndividuals throws instead of falling back silently', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(500, { detail: 'Search failed' }));
    await expect(api.semanticSearchIndividuals('vet')).rejects.toMatchObject({ status: 500 });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('searchIndividuals throws when the backend fails', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(500, { detail: 'Search individuals failed' }));
    await expect(api.searchIndividuals('')).rejects.toBeInstanceOf(ApiError);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('raw-fetch helpers use the shared transport', () => {
  it('has no assistant transcription call any more', () => {
    expect((api as any).transcribeForAssistant).toBeUndefined();
  });

  it('exportCSV surfaces the backend detail', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(404, { detail: 'No individuals found to export' }));
    await expect(api.exportCSV()).rejects.toMatchObject({ status: 404, detail: 'No individuals found to export' });
  });
});
