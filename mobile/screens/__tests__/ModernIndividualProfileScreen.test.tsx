// C-17: only a real 404 is "not found"; any other failure offers a retry, and a failed
// pull-to-refresh keeps the profile on screen instead of navigating away.
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn(), hide: jest.fn() } }));
jest.mock('../../components/IndividualLocationMap', () => () => null);
const mockUrgencyProps: any = {};
jest.mock('../../components/UrgencyScore', () => (props: any) => {
  Object.assign(mockUrgencyProps, props);
  return null;
});
jest.mock('../../components/InteractionDetailModal', () => () => null);
jest.mock('../../services/api', () => ({
  api: { getIndividualProfile: jest.fn(), updateUrgencyOverride: jest.fn(), deleteIndividual: jest.fn(), saveIndividual: jest.fn() },
}));

import Toast from 'react-native-toast-message';
import { Alert } from 'react-native';
import { ModernIndividualProfileScreen } from '../ModernIndividualProfileScreen';
import { api } from '../../services/api';
import { isPendingDelete, __resetPendingDeletesForTests } from '../../utils/delayedDelete';

const apiError = (status: number, detail: string) =>
  Object.assign(new Error(detail), { status, detail, kind: status ? 'http' : 'network' });
const profile = {
  id: 'p1', name: 'Ann Lee', urgency_score: 10, urgency_override: null, data: { height: 60 },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  interactions: [], total_interactions: 0, last_location: null,
};
const nav = () => ({ goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() });
const route = { params: { individualId: 'p1' } };

beforeEach(() => {
  jest.clearAllMocks();
  __resetPendingDeletesForTests();
});
afterEach(() => __resetPendingDeletesForTests());

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

// OD-3 (C-45): Delete hides and goes back at once; the DELETE waits for the undo window.
describe('delayed delete', () => {
  const openDeleteDialog = async () => {
    (api.getIndividualProfile as jest.Mock).mockResolvedValue(profile);
    const navigation = nav();
    const screen = render(<ModernIndividualProfileScreen navigation={navigation} route={route} />);
    await waitFor(() => screen.getByText('Ann Lee'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const headerRight = navigation.setOptions.mock.calls[navigation.setOptions.mock.calls.length - 1][0].headerRight;
    act(() => { headerRight().props.onPress(); });
    const [title, message, buttons] = alert.mock.calls[0] as any[];
    alert.mockRestore();
    return { navigation, title, message, buttons };
  };

  it('does not claim "cannot be undone" while offering Undo', async () => {
    const { message } = await openDeleteDialog();
    expect(message).not.toMatch(/cannot be undone/i);
    expect(message).toMatch(/undo/i);
  });

  it('Delete schedules the delete, goes back and offers Undo; nothing is deleted yet', async () => {
    const { navigation, buttons } = await openDeleteDialog();
    act(() => { buttons.find((b: any) => b.style === 'destructive').onPress(); });

    expect(navigation.goBack).toHaveBeenCalled();
    expect(isPendingDelete('p1')).toBe(true);
    expect(api.deleteIndividual).not.toHaveBeenCalled();
    const undoToast = (Toast.show as jest.Mock).mock.calls[0][0];
    expect(undoToast.text2).toMatch(/undo/i);
    expect(undoToast.visibilityTime).toBe(5000);

    act(() => { undoToast.onPress(); });
    expect(isPendingDelete('p1')).toBe(false);
    expect(api.deleteIndividual).not.toHaveBeenCalled();
    expect(api.saveIndividual).not.toHaveBeenCalled(); // undo no longer re-creates a lossy copy
  });
});

describe('urgency override (C-10)', () => {
  it('shows the scores the PUT returns', async () => {
    (api.getIndividualProfile as jest.Mock).mockResolvedValue(profile);
    (api.updateUrgencyOverride as jest.Mock).mockResolvedValue({ urgency_score: 10, urgency_override: 75, display_score: 75 });
    const screen = render(<ModernIndividualProfileScreen navigation={nav()} route={route} />);
    await waitFor(() => screen.getByText('Ann Lee'));
    await act(async () => { await mockUrgencyProps.onOverrideChange(75); });
    expect(api.updateUrgencyOverride).toHaveBeenCalledWith('p1', 75);
    expect(screen.getByText('75')).toBeTruthy();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('reverts and shows the backend error once when the PUT fails', async () => {
    (api.getIndividualProfile as jest.Mock).mockResolvedValue(profile);
    (api.updateUrgencyOverride as jest.Mock).mockRejectedValue(apiError(422, 'Input should be less than or equal to 100'));
    const screen = render(<ModernIndividualProfileScreen navigation={nav()} route={route} />);
    await waitFor(() => screen.getByText('Ann Lee'));
    await act(async () => { await mockUrgencyProps.onOverrideChange(75); });
    expect(screen.queryByText('75')).toBeNull();
    expect(screen.getByText('10')).toBeTruthy();
    expect(Toast.show).toHaveBeenCalledTimes(1);
    expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({ text2: 'Input should be less than or equal to 100' });
  });
});
