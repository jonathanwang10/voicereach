const mockGetSession = jest.fn<any, any[]>();
const mockAutoLogin = jest.fn<any, any[]>(async () => ({}));
let mockSignedOut = false;
jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: (...a: any[]) => mockGetSession(...a), refreshSession: jest.fn() } },
  autoLogin: (...a: any[]) => mockAutoLogin(...a),
  isSignedOutByUser: () => mockSignedOut,
}));

import { getAuthToken } from '../api';

beforeEach(() => { mockGetSession.mockReset(); mockAutoLogin.mockClear(); mockSignedOut = false; });

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

it('the sign-in failure is an ApiError of kind auth', async () => {
  mockGetSession.mockResolvedValue({ data: { session: null } });
  await expect(getAuthToken()).rejects.toMatchObject({ name: 'ApiError', kind: 'auth', status: 0 });
});

// Minor 3: a request after the worker's Sign Out (a delayed delete committing) must fail,
// not sign the device back in (autoLogin emits SIGNED_IN and the tabs come back).
it('after Sign Out, a request without a session fails instead of signing in again', async () => {
  mockSignedOut = true;
  mockGetSession.mockResolvedValue({ data: { session: null } });
  await expect(getAuthToken()).rejects.toMatchObject({ name: 'ApiError', kind: 'auth', status: 0 });
  expect(mockAutoLogin).not.toHaveBeenCalled();
});

