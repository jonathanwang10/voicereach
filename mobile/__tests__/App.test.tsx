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
  signOut: jest.fn(async () => {
    mockAuthListener?.('SIGNED_OUT', null); // Supabase emits it before resolving
    return { error: null };
  }),
}));
jest.mock('../services/api', () => ({ api: { getCategories: jest.fn(async () => []) } }));
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

import App from '../App';
import { api } from '../services/api';

const user = { id: 'u1', email: 'demo@sfgov.org' };
const session = { access_token: 't', user };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

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
