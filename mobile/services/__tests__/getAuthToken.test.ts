const mockGetSession = jest.fn<any, any[]>();
const mockAutoLogin = jest.fn<any, any[]>(async () => ({}));
jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: (...a: any[]) => mockGetSession(...a), refreshSession: jest.fn() } },
  autoLogin: (...a: any[]) => mockAutoLogin(...a),
}));

import { getAuthToken } from '../api';

beforeEach(() => { mockGetSession.mockReset(); mockAutoLogin.mockClear(); });

it('returns the current session token', async () => {
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'abc' } } });
  await expect(getAuthToken()).resolves.toBe('abc');
  expect(mockAutoLogin).not.toHaveBeenCalled();
});

it('signs in first when there is no session', async () => {
  mockGetSession
    .mockResolvedValueOnce({ data: { session: null } })
    .mockResolvedValueOnce({ data: { session: { access_token: 'fresh' } } });
  await expect(getAuthToken()).resolves.toBe('fresh');
  expect(mockAutoLogin).toHaveBeenCalledTimes(1);
});

it('explains what to fix when sign-in is impossible', async () => {
  mockGetSession.mockResolvedValue({ data: { session: null } });
  await expect(getAuthToken()).rejects.toThrow(/demo user/);
});
