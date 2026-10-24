// C-35: `loading` stays true until the auto sign-in settles (a null INITIAL_SESSION
// must not end it early), a failure is exposed with a retry, and sign-out is real (OD-4).
import React from 'react';
import { Text } from 'react-native';
import { render, act, waitFor } from '@testing-library/react-native';

let mockAuthListener: ((event: string, session: any) => void) | null = null;
const mockAutoLogin = jest.fn();
const mockSignIn = jest.fn((...a: any[]) => mockAutoLogin(...a));
const mockSignOut = jest.fn();
jest.mock('../../services/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: any) => {
        mockAuthListener = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      },
    },
  },
  autoLogin: (...a: any[]) => mockAutoLogin(...a),
  signIn: (...a: any[]) => mockSignIn(...a),
  signOut: (...a: any[]) => mockSignOut(...a),
}));

import { AuthProvider, useAuth } from '../AuthContext';

const user = { id: 'u1', email: 'demo@sfgov.org' };
const session = { access_token: 't', user };

let latest: ReturnType<typeof useAuth>;
const Probe = () => {
  latest = useAuth();
  return <Text>{latest.loading ? 'loading' : latest.user ? `user:${latest.user.email}` : `none:${latest.error ?? ''}`}</Text>;
};
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthListener = null;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('keeps loading until the sign-in settles, even after a null INITIAL_SESSION', async () => {
  let finish!: (v: any) => void;
  mockAutoLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const screen = mount();
  act(() => { mockAuthListener?.('INITIAL_SESSION', null); });
  expect(screen.getByText('loading')).toBeTruthy();

  await act(async () => { finish({ user, session }); });
  expect(screen.getByText('user:demo@sfgov.org')).toBeTruthy();
});

it('a failed sign-in ends loading with an error, and retry signs in again', async () => {
  mockAutoLogin.mockResolvedValueOnce({ error: new Error('Invalid login credentials') });
  const screen = mount();
  await waitFor(() => screen.getByText(/^none:.*Invalid login credentials/));

  mockAutoLogin.mockResolvedValueOnce({ user, session });
  await act(async () => { await latest.retry(); });
  expect(screen.getByText('user:demo@sfgov.org')).toBeTruthy();
  expect(latest.error).toBeNull();
  expect(mockAutoLogin).toHaveBeenCalledTimes(2);
});

it('signOut really signs out and does not sign straight back in', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  mockSignOut.mockResolvedValue({ error: null });
  const screen = mount();
  await waitFor(() => screen.getByText('user:demo@sfgov.org'));

  await act(async () => { await latest.signOut(); });
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(screen.getByText('none:')).toBeTruthy();
  expect(mockAutoLogin).toHaveBeenCalledTimes(1);
});

it('a failed sign-out is reported, not swallowed, and keeps the user', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  mockSignOut.mockResolvedValue({ error: new Error('network down') });
  const screen = mount();
  await waitFor(() => screen.getByText('user:demo@sfgov.org'));

  let thrown: unknown;
  await act(async () => {
    try { await latest.signOut(); } catch (e) { thrown = e; }
  });
  expect(thrown).toBeInstanceOf(Error);
  expect(screen.getByText('user:demo@sfgov.org')).toBeTruthy();
});

// Fix round 1: a SIGNED_OUT the worker didn't ask for (another phone's sign-out, a
// failed refresh) must not drop to the "Signed out" screen and lose work: the user
// stays set and the app quietly signs in again.
it('an unrequested SIGNED_OUT keeps the user and quietly signs in again', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const screen = mount();
  await waitFor(() => screen.getByText('user:demo@sfgov.org'));

  await act(async () => { mockAuthListener?.('SIGNED_OUT', null); });
  expect(screen.getByText('user:demo@sfgov.org')).toBeTruthy();
  expect(latest.loading).toBe(false);
  expect(mockAutoLogin).toHaveBeenCalledTimes(2);
});

it('a requested sign-out stays signed out when its SIGNED_OUT arrives', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  mockSignOut.mockImplementation(async () => {
    mockAuthListener?.('SIGNED_OUT', null); // Supabase emits it before resolving
    return { error: null };
  });
  const screen = mount();
  await waitFor(() => screen.getByText('user:demo@sfgov.org'));

  await act(async () => { await latest.signOut(); });
  expect(screen.getByText('none:')).toBeTruthy();
  expect(mockAutoLogin).toHaveBeenCalledTimes(1);
});

// Minor 3: the launch sign-in and Retry are the worker's own sign-in, so they clear the
// signed-out state (services/supabase signIn); a quiet re-sign-in after a revoked
// session does not.
it('launch and Retry sign in through signIn, which clears a user sign-out', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  mount();
  await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1));
  await act(async () => { await latest.retry(); });
  expect(mockSignIn).toHaveBeenCalledTimes(2);
});


it('keeps the same context value across a re-render (H2-6.9)', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const seen: any[] = [];
  const Spy = () => { seen.push(useAuth()); return null; };
  const s = render(<AuthProvider><Spy /></AuthProvider>);
  await waitFor(() => expect(seen.at(-1).loading).toBe(false));
  s.rerender(<AuthProvider><Spy /></AuthProvider>);
  expect(seen.at(-1)).toBe(seen.at(-2));
});
