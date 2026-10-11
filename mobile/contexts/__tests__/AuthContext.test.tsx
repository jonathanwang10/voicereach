// C-35: `loading` stays true until the auto sign-in settles (a null INITIAL_SESSION
// must not end it early), a failure is exposed with a retry, and sign-out is real (OD-4).
import React from 'react';
import { Text } from 'react-native';
import { render, act, waitFor } from '@testing-library/react-native';

let mockAuthListener: ((event: string, session: any) => void) | null = null;
const mockAutoLogin = jest.fn();
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
