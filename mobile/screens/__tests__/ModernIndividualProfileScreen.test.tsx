// C-17: only a real 404 is "not found"; any other failure offers a retry, and a failed
// pull-to-refresh keeps the profile on screen instead of navigating away.
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../components/IndividualLocationMap', () => () => null);
jest.mock('../../components/UrgencyScore', () => () => null);
jest.mock('../../components/InteractionDetailModal', () => () => null);
jest.mock('../../services/api', () => ({
  api: { getIndividualProfile: jest.fn() },
}));

import Toast from 'react-native-toast-message';
import { ModernIndividualProfileScreen } from '../ModernIndividualProfileScreen';
import { api } from '../../services/api';

const apiError = (status: number, detail: string) =>
  Object.assign(new Error(detail), { status, detail, kind: status ? 'http' : 'network' });
const profile = {
  id: 'p1', name: 'Ann Lee', urgency_score: 10, urgency_override: null, data: { height: 60 },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  interactions: [], total_interactions: 0, last_location: null,
};
const nav = () => ({ goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() });
const route = { params: { individualId: 'p1' } };

beforeEach(() => jest.clearAllMocks());

it('a 404 says "not found" and goes back', async () => {
  (api.getIndividualProfile as jest.Mock).mockRejectedValue(apiError(404, 'Individual not found: p1'));
  const navigation = nav();
  render(<ModernIndividualProfileScreen navigation={navigation} route={route} />);
  await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
  expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({ text1: 'Individual not found' });
});

it('an outage offers a retry and does not go back', async () => {
  (api.getIndividualProfile as jest.Mock).mockRejectedValue(apiError(0, 'No connection to the server.'));
  const navigation = nav();
  const { getByText, queryByText } = render(<ModernIndividualProfileScreen navigation={navigation} route={route} />);
  await waitFor(() => getByText("Couldn't load profile"));
  expect(queryByText('Profile not found')).toBeNull();
  expect(navigation.goBack).not.toHaveBeenCalled();

  (api.getIndividualProfile as jest.Mock).mockResolvedValue(profile);
  fireEvent.press(getByText('Retry'));
  await waitFor(() => getByText('Ann Lee'));
});

it('a failed refresh keeps the profile and shows one error', async () => {
  (api.getIndividualProfile as jest.Mock).mockResolvedValueOnce(profile);
  const navigation = nav();
  const screen = render(<ModernIndividualProfileScreen navigation={navigation} route={route} />);
  await waitFor(() => screen.getByText('Ann Lee'));

  (api.getIndividualProfile as jest.Mock).mockRejectedValue(apiError(500, 'Get individual failed'));
  await act(async () => {
    await screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
  });
  expect(screen.getByText('Ann Lee')).toBeTruthy();
  expect(screen.queryByText('Loading profile...')).toBeNull();
  expect(navigation.goBack).not.toHaveBeenCalled();
  expect(Toast.show).toHaveBeenCalledTimes(1);
  expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({ text2: 'Get individual failed' });
});

it('does not flip to the full-screen spinner while refreshing', async () => {
  (api.getIndividualProfile as jest.Mock).mockResolvedValueOnce(profile);
  const screen = render(<ModernIndividualProfileScreen navigation={nav()} route={route} />);
  await waitFor(() => screen.getByText('Ann Lee'));

  let finish: (p: any) => void = () => {};
  (api.getIndividualProfile as jest.Mock).mockReturnValue(new Promise(r => { finish = r; }));
  let refreshing: Promise<any> = Promise.resolve();
  act(() => { refreshing = screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  expect(screen.queryByText('Loading profile...')).toBeNull();
  expect(screen.getByText('Ann Lee')).toBeTruthy();
  await act(async () => { finish(profile); await refreshing; });
});
