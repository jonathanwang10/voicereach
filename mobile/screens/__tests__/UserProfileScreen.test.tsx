// OD-4 (C-58): the Profile tab shows the real signed-in account, not an invented
// worker, and Sign Out really signs out (and says so when it fails).
// R-10 (C-62): no placeholder buttons that only say "would be implemented here".
import React from 'react';
import { Alert } from 'react-native';
import { render, act, fireEvent } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
const mockSignOut = jest.fn();
const mockUser: any = { id: 'u1', email: 'demo@sfgov.org', last_sign_in_at: '2026-10-11T09:30:00Z' };
jest.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, signOut: mockSignOut }),
}));

import UserProfileScreen from '../UserProfileScreen';

let alert: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

const lastAlertButton = (label: string) =>
  (alert.mock.calls[alert.mock.calls.length - 1][2] as any[]).find(b => b.text === label);

it('shows the signed-in email and last sign-in, and no invented worker', () => {
  const screen = render(<UserProfileScreen />);
  expect(screen.getAllByText('demo@sfgov.org').length).toBeGreaterThan(0);
  expect(screen.queryByText(/John Street/)).toBeNull();
  expect(screen.queryByText(/sfoutreach\.org/)).toBeNull();
  expect(screen.queryByText('San Francisco Homeless Outreach')).toBeNull();
  expect(screen.queryByText('2024-01-15 09:30 AM')).toBeNull();
  const shown = new Date('2026-10-11T09:30:00Z').toLocaleString();
  expect(screen.getByText(shown)).toBeTruthy();
});

it('has no placeholder Change Password or Contact Support rows', () => {
  const screen = render(<UserProfileScreen />);
  expect(screen.queryByText('Change Password')).toBeNull();
  expect(screen.queryByText('Contact Support')).toBeNull();
});

it('Sign Out asks, then calls the real sign-out and does not claim success itself', async () => {
  mockSignOut.mockResolvedValue(undefined);
  const screen = render(<UserProfileScreen />);
  fireEvent.press(screen.getByText('Sign Out'));
  const [title, message] = alert.mock.calls[alert.mock.calls.length - 1];
  expect(title).toBe('Sign Out');
  expect(message).toMatch(/next time the app starts/i);
  await act(async () => { await lastAlertButton('Sign Out').onPress(); });
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls.some(c => /successfully/i.test(String(c[1])))).toBe(false);
});

it('a failed sign-out is reported', async () => {
  mockSignOut.mockRejectedValue(new Error('network down'));
  const screen = render(<UserProfileScreen />);
  fireEvent.press(screen.getByText('Sign Out'));
  await act(async () => { await lastAlertButton('Sign Out').onPress(); });
  const [title, message] = alert.mock.calls[alert.mock.calls.length - 1];
  expect(title).toBe("Couldn't sign out");
  expect(message).toBe('network down');
});
