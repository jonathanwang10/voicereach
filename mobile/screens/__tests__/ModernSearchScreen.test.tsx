// C-17: a failed load shows "Couldn't load — tap to retry", not "No individuals have been recorded yet".
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return { useFocusEffect: (cb: any) => React.useEffect(cb, [cb]) };
});
jest.mock('../../services/api', () => ({
  api: {
    searchIndividuals: jest.fn(),
    semanticSearchIndividuals: jest.fn(),
  },
}));

import { Alert } from 'react-native';
import { ModernSearchScreen } from '../ModernSearchScreen';
import { api } from '../../services/api';

const ann = {
  id: 'a1', name: 'Ann Lee', urgency_score: 10, last_seen_days: 1,
  last_interaction_date: new Date().toISOString(),
};
const outage = Object.assign(new Error('Server error. Please try again.'), {
  status: 500, detail: 'Server error. Please try again.', kind: 'http',
});

beforeEach(() => jest.clearAllMocks());

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
