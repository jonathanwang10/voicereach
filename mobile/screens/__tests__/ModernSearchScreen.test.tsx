// C-17: a failed load shows "Couldn't load — tap to retry", not "No individuals have been recorded yet".
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
// Runs like a focus on mount; `refocus()` replays the screen's focus callbacks
const mockFocusCallbacks = new Set<() => void>();
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useFocusEffect: (cb: any) => React.useEffect(() => {
      mockFocusCallbacks.add(cb);
      cb();
      return () => { mockFocusCallbacks.delete(cb); };
    }, [cb]),
  };
});
const refocus = () => act(() => { mockFocusCallbacks.forEach(cb => cb()); });
jest.mock('../../services/api', () => ({
  api: {
    searchIndividuals: jest.fn(),
    semanticSearchIndividuals: jest.fn(),
  },
}));

import { Alert, FlatList } from 'react-native';
import Toast from 'react-native-toast-message';
import { act } from '@testing-library/react-native';
import { ModernSearchScreen } from '../ModernSearchScreen';
import { api } from '../../services/api';
import { scheduleDelete, __resetPendingDeletesForTests } from '../../utils/delayedDelete';

const ann = {
  id: 'a1', name: 'Ann Lee', urgency_score: 10, last_seen_days: 1,
  last_interaction_date: new Date().toISOString(),
};
const outage = Object.assign(new Error('Server error. Please try again.'), {
  status: 500, detail: 'Server error. Please try again.', kind: 'http',
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetPendingDeletesForTests();
});
afterEach(() => __resetPendingDeletesForTests());

it('shows a retry state when loading fails, and retries on tap', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (api.searchIndividuals as jest.Mock).mockRejectedValue(outage);
  const { getByText, queryByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);

  await waitFor(() => getByText("Couldn't load — tap to retry"));
  expect(queryByText('No individuals have been recorded yet')).toBeNull();
  expect(alert).not.toHaveBeenCalled();

  (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
  fireEvent.press(getByText("Couldn't load — tap to retry"));
  await waitFor(() => getByText('Ann Lee'));
  expect(queryByText("Couldn't load — tap to retry")).toBeNull();
  alert.mockRestore();
});

it('reads each row as name, urgency and last seen (H2-6.11)', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
  const { getByLabelText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByLabelText('Ann Lee, urgency 10, last seen 1 day ago'));
  expect(getByLabelText('Ann Lee, urgency 10, last seen 1 day ago').props.accessibilityRole).toBe('button');
});

it('still shows the empty state when there really is no one', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([]);
  const { getByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('No individuals have been recorded yet'));
});

it('falls back to text search without an error when semantic search fails', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
  (api.semanticSearchIndividuals as jest.Mock).mockRejectedValue(outage);
  const { getByText, getByPlaceholderText, queryByText } = render(
    <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Ann Lee'));
  fireEvent.changeText(getByPlaceholderText('Search by name, description, or details...'), 'ann');
  await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalled());
  await waitFor(() => expect((api.searchIndividuals as jest.Mock).mock.calls.some(c => c[0] === 'ann')).toBe(true));
  await waitFor(() => getByText('Ann Lee'));
  expect(queryByText("Couldn't load — tap to retry")).toBeNull();
});

it('shows the retry state when both searches fail', async () => {
  (api.searchIndividuals as jest.Mock).mockImplementation(async (q: string) => {
    if (q) throw outage;
    return [ann];
  });
  (api.semanticSearchIndividuals as jest.Mock).mockRejectedValue(outage);
  const { getByText, getByPlaceholderText, queryByText } = render(
    <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Ann Lee'));
  fireEvent.changeText(getByPlaceholderText('Search by name, description, or details...'), 'ann');
  await waitFor(() => getByText("Couldn't load — tap to retry"));
  expect(queryByText('No Results Found')).toBeNull();
});

// OD-3: a person whose delete is pending is hidden; Undo brings them back.
describe('pending deletes', () => {
  const bob = { ...ann, id: 'b2', name: 'Bob Day' };

  it('hides a pending delete that is already scheduled when the list loads', async () => {
    scheduleDelete('a1');
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann, bob]);
    const { getByText, queryByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Bob Day'));
    expect(queryByText('Ann Lee')).toBeNull();
  });

  it('hides on schedule and shows again on Undo, without reloading', async () => {
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann, bob]);
    const { getByText, queryByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));
    const calls = (api.searchIndividuals as jest.Mock).mock.calls.length;

    let handle: { cancel: () => boolean } = { cancel: () => false };
    act(() => { handle = scheduleDelete('a1'); });
    expect(queryByText('Ann Lee')).toBeNull();
    expect(getByText('Bob Day')).toBeTruthy();

    act(() => { handle.cancel(); });
    expect(getByText('Ann Lee')).toBeTruthy();
    expect((api.searchIndividuals as jest.Mock).mock.calls.length).toBe(calls);
  });
});

// C-32: anything seen in the last 24 hours is "today", never "1 day ago".
it('shows "Last seen today" for 0 days', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([{ ...ann, last_seen_days: 0 }]);
  const { getByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Last seen today'));
});

it('shows the display score (override) on the row', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([
    { ...ann, urgency_score: 10, urgency_override: null, display_score: 88 },
  ]);
  const { getByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('88'));
});

// C-06: one search per pause in typing, and stale responses are dropped.
describe('search sequencing', () => {
  const box = 'Search by name, description, or details...';

  it('searches once per pause in typing, not twice per keystroke', async () => {
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
    (api.semanticSearchIndividuals as jest.Mock).mockResolvedValue([ann]);
    const { getByText, getByPlaceholderText } = render(
      <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));
    fireEvent.changeText(getByPlaceholderText(box), 'a');
    fireEvent.changeText(getByPlaceholderText(box), 'an');
    fireEvent.changeText(getByPlaceholderText(box), 'ann');
    await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 400));
    expect((api.semanticSearchIndividuals as jest.Mock).mock.calls).toEqual([['ann']]);
  });

  it('a slow response for "v" never overwrites the results for "veteran"', async () => {
    const vPerson = { ...ann, id: 'v1', name: 'Val Early' };
    const vet = { ...ann, id: 'v2', name: 'Vet Later' };
    let resolveV: (r: any[]) => void = () => {};
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
    (api.semanticSearchIndividuals as jest.Mock).mockImplementation((q: string) =>
      q === 'v' ? new Promise(r => { resolveV = r; }) : Promise.resolve([vet]));
    const { getByText, getByPlaceholderText, queryByText } = render(
      <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));

    fireEvent.changeText(getByPlaceholderText(box), 'v');
    await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledWith('v'));
    fireEvent.changeText(getByPlaceholderText(box), 'veteran');
    await waitFor(() => getByText('Vet Later'));

    await act(async () => { resolveV([vPerson]); });
    expect(queryByText('Val Early')).toBeNull();
    expect(getByText('Vet Later')).toBeTruthy();
  });
});

// C-60: one load on mount; a later (focus) refresh runs in the background.
describe('list reloads', () => {
  it('loads the list once on mount', async () => {
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
    const { getByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));
    await new Promise(r => setTimeout(r, 50));
    expect(api.searchIndividuals).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the last good list and shows a toast instead of the retry state', async () => {
    (api.searchIndividuals as jest.Mock).mockResolvedValueOnce([ann]).mockRejectedValue(outage);
    const { getByText, queryByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));
    refocus();
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    expect(getByText('Ann Lee')).toBeTruthy();
    expect(queryByText("Couldn't load — tap to retry")).toBeNull();
    expect(queryByText('Loading individuals...')).toBeNull();
  });

  // Minor 5: one toast at a time, so a refresh error would replace "Tap to undo".
  it('a failed refresh shows no toast while a delete is waiting for undo', async () => {
    (api.searchIndividuals as jest.Mock).mockResolvedValueOnce([ann]).mockRejectedValue(outage);
    const { getByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));
    act(() => { scheduleDelete('someone-else', { delayMs: 60_000 }); });
    refocus();
    await waitFor(() => expect(api.searchIndividuals).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(Toast.show).not.toHaveBeenCalled();
    expect(getByText('Ann Lee')).toBeTruthy();
  });

  it('a failed search refresh shows no toast while a delete is waiting for undo', async () => {
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
    (api.semanticSearchIndividuals as jest.Mock).mockResolvedValueOnce([ann]).mockRejectedValue(outage);
    const { getByText, getByPlaceholderText } = render(
      <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));
    fireEvent.changeText(getByPlaceholderText('Search by name, description, or details...'), 'ann');
    await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledTimes(1));
    (api.searchIndividuals as jest.Mock).mockResolvedValueOnce([ann]).mockRejectedValue(outage);
    act(() => { scheduleDelete('someone-else', { delayMs: 60_000 }); });
    refocus();
    await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('a refresh shows new data without a full-screen spinner', async () => {
    (api.searchIndividuals as jest.Mock).mockResolvedValueOnce([ann])
      .mockResolvedValue([{ ...ann, name: 'Ann Updated' }]);
    const { getByText, queryByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Ann Lee'));
    refocus();
    expect(queryByText('Loading individuals...')).toBeNull();
    await waitFor(() => getByText('Ann Updated'));
  });
});

// C-60: after Undo, the row comes back and the list scrolls to it.
it('scrolls to a row whose pending delete was undone', async () => {
  const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
  const people = [ann, { ...ann, id: 'b2', name: 'Bob Day' }, { ...ann, id: 'c3', name: 'Cy Moe' }];
  (api.searchIndividuals as jest.Mock).mockResolvedValue(people);
  const { getByText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Cy Moe'));
  let handle: { cancel: () => boolean } = { cancel: () => false };
  act(() => { handle = scheduleDelete('c3'); });
  expect(scroll).not.toHaveBeenCalled();
  act(() => { handle.cancel(); });
  await waitFor(() => expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ index: 2 })));
  scroll.mockRestore();
});

// A similarity score of 0 must not render a bare `0` (it crashes React Native).
// H2-4.5: the semantic leg (3+ characters) waits for a longer pause
it('waits for a 600 ms pause before searching three or more characters', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
  (api.semanticSearchIndividuals as jest.Mock).mockResolvedValue([ann]);
  const { getByText, getByPlaceholderText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Ann Lee'));
  fireEvent.changeText(getByPlaceholderText('Search by name, description, or details...'), 'ann');
  await act(async () => { await new Promise(r => setTimeout(r, 450)); });
  expect(api.semanticSearchIndividuals).not.toHaveBeenCalled();
  await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledWith('ann'));
});

it('searches a one- or two-character query after 300 ms', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
  (api.semanticSearchIndividuals as jest.Mock).mockResolvedValue([ann]);
  const { getByText, getByPlaceholderText } = render(<ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Ann Lee'));
  fireEvent.changeText(getByPlaceholderText('Search by name, description, or details...'), 'an');
  await act(async () => { await new Promise(r => setTimeout(r, 150)); });
  expect(api.semanticSearchIndividuals).not.toHaveBeenCalled();
  await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledWith('an'), { timeout: 1000 });
});

it('shows Name, Details and percentage badges by match type', async () => {
  (api.searchIndividuals as jest.Mock).mockResolvedValue([ann]);
  (api.semanticSearchIndividuals as jest.Mock).mockResolvedValue([
    { ...ann, search_type: 'name', similarity_score: null },
    { ...ann, id: 'b2', name: 'Bob Day', search_type: 'value', similarity_score: null },
    { ...ann, id: 'c3', name: 'Cy Moe', search_type: 'semantic', similarity_score: 0 },
  ]);
  const { getByText, getByPlaceholderText } = render(
    <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
  await waitFor(() => getByText('Ann Lee'));
  fireEvent.changeText(getByPlaceholderText('Search by name, description, or details...'), 'zz');
  await waitFor(() => getByText('0%'));
  expect(getByText('Name')).toBeTruthy();
  expect(getByText('Details')).toBeTruthy(); // a value match is not shown as a percentage
});

// Fix round 1: keep the scroll target while a spinner replaces the list; retry a failed scroll once.
describe('restored-row scroll (fix round 1)', () => {
  const bob = { ...ann, id: 'b2', name: 'Bob Day' };
  const cy = { ...ann, id: 'c3', name: 'Cy Moe' };

  it('waits for the list to come back from a search spinner before scrolling', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    let resolveSearch: (r: any[]) => void = () => {};
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann, bob, cy]);
    (api.semanticSearchIndividuals as jest.Mock).mockImplementation((q: string) =>
      q === 'm' ? Promise.resolve([ann, bob, cy]) : new Promise(r => { resolveSearch = r; }));
    const { getByText, getByPlaceholderText } = render(
      <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Cy Moe'));
    const box = getByPlaceholderText('Search by name, description, or details...');
    fireEvent.changeText(box, 'm'); // results for "m" (Cy at index 2) stay in state under the spinner
    await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledWith('m'));
    await waitFor(() => getByText('Cy Moe'));
    let handle: { cancel: () => boolean } = { cancel: () => false };
    act(() => { handle = scheduleDelete('c3'); });
    fireEvent.changeText(box, 'mo');
    await waitFor(() => getByText('Searching...'));
    act(() => { handle.cancel(); }); // Undo while the spinner hides the list
    expect(scroll).not.toHaveBeenCalled();
    await waitFor(() => expect(api.semanticSearchIndividuals).toHaveBeenCalledWith('mo'));
    await act(async () => { resolveSearch([bob, cy]); });
    await waitFor(() => expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ index: 1 })));
    scroll.mockRestore();
  });

  it('retries a failed scrollToIndex at most once', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    const offset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    (api.searchIndividuals as jest.Mock).mockResolvedValue([ann, bob, cy]);
    const { getByText, UNSAFE_getByType } = render(
      <ModernSearchScreen navigation={{ navigate: jest.fn() }} route={{}} />);
    await waitFor(() => getByText('Cy Moe'));
    const onFailed = UNSAFE_getByType(FlatList).props.onScrollToIndexFailed;
    const info = { index: 2, averageItemLength: 100, highestMeasuredFrameIndex: 0 };
    act(() => { onFailed(info); });
    await act(async () => { await new Promise(r => setTimeout(r, 300)); });
    expect(scroll).toHaveBeenCalledTimes(1);
    act(() => { onFailed(info); }); // the retry failed too: give up
    await act(async () => { await new Promise(r => setTimeout(r, 300)); });
    expect(scroll).toHaveBeenCalledTimes(1);
    scroll.mockRestore();
    offset.mockRestore();
  });
});
