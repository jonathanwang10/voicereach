// C-35: when sign-in fails the app shows a blocking "Can't sign in" screen with Retry
// instead of tabs that each fail on their own; categories load only once signed in.
// OD-4: after a real Sign Out the app stays signed out until the worker signs in again.
import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

let mockAuthListener: ((event: string, session: any) => void) | null = null;
const mockAutoLogin = jest.fn();
jest.mock('../services/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: any) => {
        mockAuthListener = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      },
    },
  },
  autoLogin: (...a: any[]) => mockAutoLogin(...a),
  signIn: (...a: any[]) => mockAutoLogin(...a),
  signOut: jest.fn(async () => {
    mockAuthListener?.('SIGNED_OUT', null); // Supabase emits it before resolving
    return { error: null };
  }),
}));
jest.mock('../services/api', () => ({
  api: { getCategories: jest.fn(async () => []), listRecordings: jest.fn(async () => []) },
}));
// The recording queue (H2-7.6): started once signed in; `mockQueueEmit` plays its events
const mockQueueStop = jest.fn();
const mockQueueOff = jest.fn();
let mockQueueEmit: (e: any) => void = () => {};
jest.mock('../services/recordingQueue', () => ({
  startRecordingQueue: jest.fn(() => mockQueueStop),
  subscribe: jest.fn((listener: any) => { mockQueueEmit = listener; return mockQueueOff; }),
}));
jest.mock('react-native-toast-message', () => {
  const Toast = () => null;
  Toast.show = jest.fn();
  return { __esModule: true, default: Toast };
});
let mockRecordMounts = 0;
jest.mock('../screens/ModernRecordScreen', () => {
  const React = require('react');
  return {
    ModernRecordScreen: () => {
      React.useEffect(() => { mockRecordMounts += 1; }, []);
      return mockScreen('Record screen');
    },
  };
});
jest.mock('../screens/ModernSearchScreen', () => ({ ModernSearchScreen: () => mockScreen('Search screen') }));
jest.mock('../screens/ModernIndividualProfileScreen', () => ({ ModernIndividualProfileScreen: () => null }));
jest.mock('../screens/ModernVoiceAssistantScreen', () => ({ ModernVoiceAssistantScreen: () => null }));
jest.mock('../screens/CategoriesScreen', () => () => null);
// A stand-in Profile tab whose button calls the real AuthContext signOut
jest.mock('../screens/UserProfileScreen', () => () => {
  const { Text } = require('react-native');
  const { useAuth } = require('../contexts/AuthContext');
  const { signOut } = useAuth();
  return <Text onPress={() => signOut()}>Profile Sign Out</Text>;
});

function mockScreen(label: string) {
  return <Text>{label}</Text>;
}

import App, { FROZEN_TABS } from '../App';
import { api } from '../services/api';
import { queryClient } from '../services/queryClient';
import { startRecordingQueue } from '../services/recordingQueue';

const user = { id: 'u1', email: 'demo@sfgov.org' };
const session = { access_token: 't', user };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  (api.listRecordings as jest.Mock).mockResolvedValue([]);
});

it('a failed sign-in blocks the app with Retry, and Retry opens the tabs', async () => {
  mockAutoLogin.mockResolvedValueOnce({ error: new Error('Invalid login credentials') });
  const screen = render(<App />);
  await waitFor(() => screen.getByText("Can't sign in"));
  expect(screen.getByText(/Invalid login credentials/)).toBeTruthy();
  expect(screen.queryByText('Record screen')).toBeNull();
  expect(api.getCategories).not.toHaveBeenCalled();

  mockAutoLogin.mockResolvedValueOnce({ user, session });
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => screen.getByText('Record screen'));
  expect(api.getCategories).toHaveBeenCalledTimes(1);
});

it('after the worker signs out the app stays signed out until they sign in again', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const screen = render(<App />);
  await waitFor(() => screen.getByText('Record screen'));

  // Tab screens are lazy, so the Profile stand-in is reached through its tab
  fireEvent.press(screen.getByText('Profile'));
  await act(async () => { fireEvent.press(await screen.findByText('Profile Sign Out')); });
  await waitFor(() => screen.getByText('Signed out'));
  expect(mockAutoLogin).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByText('Sign In'));
  await waitFor(() => screen.getByText('Record screen'));
  expect(mockAutoLogin).toHaveBeenCalledTimes(2);
});

it('Sign Out clears cached case data from memory (H2-6.6)', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const screen = render(<App />);
  await waitFor(() => screen.getByText('Record screen'));
  queryClient.setQueryData(['individual', 'p1'], { name: 'Ann Lee' });
  fireEvent.press(screen.getByText('Profile'));
  await act(async () => { fireEvent.press(await screen.findByText('Profile Sign Out')); });
  await waitFor(() => expect(queryClient.getQueryData(['individual', 'p1'])).toBeUndefined());
});

it('freezes only the tabs whose hidden work need not run (H2-6.8)', () => {
  expect(FROZEN_TABS).toEqual(['Search', 'Categories', 'Profile']);
});

it('the Search tab renders its stack', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const screen = render(<App />);
  await waitFor(() => screen.getByText('Record screen'));
  fireEvent.press(screen.getByText('Search'));
  expect(await screen.findByText('Search screen')).toBeTruthy();
});

// --- H2-7.7: drafts --------------------------------------------------------------

const draft = (id: string, status: string) =>
  ({ id, status, error: null, name: null, duration_ms: 6000, created_at: '2026-11-07T10:00:00Z' });

it('badges the Record tab with the number of ready drafts', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  (api.listRecordings as jest.Mock).mockResolvedValue([draft('r1', 'ready'), draft('r2', 'ready'), draft('r3', 'failed')]);
  const screen = render(<App />);
  await waitFor(() => screen.getByText('Record screen'));
  expect(await screen.findByText('2')).toBeTruthy();
  expect(screen.getByLabelText(/2 drafts ready to review/)).toBeTruthy();
});

it('starts the recording queue once signed in and stops it on sign-out', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const screen = render(<App />);
  await waitFor(() => screen.getByText('Record screen'));
  expect(startRecordingQueue).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('Profile'));
  await act(async () => { fireEvent.press(await screen.findByText('Profile Sign Out')); });
  await waitFor(() => screen.getByText('Signed out'));
  expect(mockQueueStop).toHaveBeenCalled();
  expect(mockQueueOff).toHaveBeenCalled();
});

it('refreshes the drafts when the queue reports an upload', async () => {
  mockAutoLogin.mockResolvedValue({ user, session });
  const screen = render(<App />);
  await waitFor(() => screen.getByText('Record screen'));
  await waitFor(() => expect(api.listRecordings).toHaveBeenCalled());
  const calls = (api.listRecordings as jest.Mock).mock.calls.length;
  await act(async () => { mockQueueEmit({ type: 'uploaded', clientRecordingId: 'c1', recordingId: 'r1' }); });
  await waitFor(() => expect((api.listRecordings as jest.Mock).mock.calls.length).toBeGreaterThan(calls));
});

// Fix round 1: another phone signing out (or a failed refresh) emits SIGNED_OUT
// here. The tabs stay mounted (no lost review) and the app signs in again quietly.
it('an unrequested SIGNED_OUT keeps the tabs mounted and signs in again quietly', async () => {
  mockRecordMounts = 0;
  mockAutoLogin.mockResolvedValue({ user, session });
  const screen = render(<App />);
  await waitFor(() => screen.getByText('Record screen'));
  expect(mockRecordMounts).toBe(1);

  await act(async () => { mockAuthListener?.('SIGNED_OUT', null); });
  expect(screen.getByText('Record screen')).toBeTruthy();
  expect(screen.queryByText('Signed out')).toBeNull();
  expect(mockRecordMounts).toBe(1);
  expect(mockAutoLogin).toHaveBeenCalledTimes(2);
});
