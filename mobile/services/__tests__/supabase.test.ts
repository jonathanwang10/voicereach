// C-35: one in-flight sign-in shared by every caller (AuthContext, getAuthToken),
// so a cold start never races several signInWithPassword calls.
// OD-4 (C-58): signOut really signs out and reports a failure.
const mockAuth = {
  getSession: jest.fn(),
  signInWithPassword: jest.fn(),
  signOut: jest.fn(),
};
// A getter: the client is created when supabase.ts loads, before mockAuth is initialised
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ get auth() { return mockAuth; } }) }));

import { autoLogin, signOut, signIn, isSignedOutByUser } from '../supabase';

const session = { access_token: 't', user: { id: 'u1', email: 'demo@sfgov.org' } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('concurrent callers share one sign-in', async () => {
  mockAuth.getSession.mockResolvedValue({ data: { session: null } });
  let finish!: (v: any) => void;
  mockAuth.signInWithPassword.mockReturnValue(new Promise(resolve => { finish = resolve; }));

  const a = autoLogin();
  const b = autoLogin();
  const c = autoLogin();
  finish({ data: { user: session.user, session }, error: null });
  const results = await Promise.all([a, b, c]);

  expect(mockAuth.signInWithPassword).toHaveBeenCalledTimes(1);
  results.forEach(r => expect(r).toMatchObject({ user: session.user, session }));
});

it('a later call after the first settles signs in again (a failure is not cached forever)', async () => {
  mockAuth.getSession.mockResolvedValue({ data: { session: null } });
  mockAuth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: new Error('Invalid login credentials') });
  const first = await autoLogin();
  expect(first.error).toBeTruthy();

  mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { user: session.user, session }, error: null });
  const second = await autoLogin();
  expect(second).toMatchObject({ session });
  expect(mockAuth.signInWithPassword).toHaveBeenCalledTimes(2);
});

it('signOut calls supabase.auth.signOut and returns its error', async () => {
  mockAuth.signOut.mockResolvedValueOnce({ error: null });
  await expect(signOut()).resolves.toEqual({ error: null });
  const failure = new Error('network down');
  mockAuth.signOut.mockResolvedValueOnce({ error: failure });
  await expect(signOut()).resolves.toEqual({ error: failure });
  expect(mockAuth.signOut).toHaveBeenCalledTimes(2);
});

// Fix round 1: every phone shares demo@sfgov.org, and the default 'global' scope
// revokes all of its sessions, signing every other phone out too.
it('signs out this device only (scope local)', async () => {
  mockAuth.signOut.mockResolvedValueOnce({ error: null });
  await signOut();
  expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
});

// Minor 3: after the worker's Sign Out, nothing may sign the device back in on its own.
it('Sign Out marks the device signed out by the user until the next explicit sign-in', async () => {
  mockAuth.signOut.mockResolvedValueOnce({ error: null });
  await signOut();
  expect(isSignedOutByUser()).toBe(true);

  mockAuth.getSession.mockResolvedValue({ data: { session } });
  await signIn();
  expect(isSignedOutByUser()).toBe(false);
});

it('a failed Sign Out leaves the device signed in', async () => {
  mockAuth.signOut.mockResolvedValueOnce({ error: new Error('network down') });
  await signOut();
  expect(isSignedOutByUser()).toBe(false);
});

