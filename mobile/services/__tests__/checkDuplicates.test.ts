// C-08: a failed duplicate check must throw (the caller asks before saving as new),
// never quietly come back as "no match". The transport never toasts.
jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
      refreshSession: jest.fn(),
    },
  },
  autoLogin: jest.fn(async () => ({})),
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import Toast from 'react-native-toast-message';
import { api, ApiError } from '../api';

describe('api.checkDuplicates', () => {
  afterEach(() => { (global as any).fetch = undefined; jest.clearAllMocks(); });

  it('returns the potential matches', async () => {
    const matches = [{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'Ann', confidence: 88 }];
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ potential_matches: matches }) }));
    await expect(api.checkDuplicates({ name: 'Ann' })).resolves.toEqual(matches);
  });

  it('throws an ApiError on a 500 instead of returning [] and does not toast', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false, status: 500, text: async () => '{"detail":"Duplicate check failed"}',
    }));
    const err = await api.checkDuplicates({ name: 'Ann' }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.detail).toBe('Duplicate check failed');
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('throws on a network failure (a POST is not retried)', async () => {
    const fetchMock = jest.fn(async () => { throw new TypeError('Network request failed'); });
    (global as any).fetch = fetchMock;
    const err = await api.checkDuplicates({ name: 'Ann' }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
