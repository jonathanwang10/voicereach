// C-35: a failed category load is exposed as `error` (not silently an empty list for
// the whole session), and refreshCategories retries. C-69: one shared sort.
import React from 'react';
import { Text } from 'react-native';
import { act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderWithQuery } from '../../test/renderWithQuery';

jest.mock('../../services/api', () => ({ api: { getCategories: jest.fn() } }));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import { api } from '../../services/api';
import { CategoryProvider, useCategories } from '../CategoryContext';

let latest: ReturnType<typeof useCategories>;
const Probe = () => {
  latest = useCategories();
  return <Text>{latest.isLoading ? 'loading' : latest.error ? `error:${latest.error}` : latest.categories.map(c => c.name).join(',')}</Text>;
};

const cat = (name: string, priority = 'medium', display_name: string | null = null) =>
  ({ id: name, name, display_name, type: 'text', priority, urgency_weight: 0, auto_trigger: false, is_required: false, is_preset: false });

beforeEach(() => jest.clearAllMocks());

it('exposes a load failure and recovers on refresh', async () => {
  (api.getCategories as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('No connection'), { status: 0, detail: 'No connection', kind: 'network' }));
  const screen = renderWithQuery(<CategoryProvider><Probe /></CategoryProvider>);
  await waitFor(() => screen.getByText('error:No connection'));
  expect(latest.categories).toEqual([]);

  (api.getCategories as jest.Mock).mockResolvedValueOnce([cat('notes'), cat('name')]);
  await act(async () => { await latest.refreshCategories(); });
  expect(latest.error).toBeNull();
  expect(screen.getByText('name,notes')).toBeTruthy();
});

it('a failed refresh keeps the categories already loaded', async () => {
  (api.getCategories as jest.Mock).mockResolvedValueOnce([cat('name')]);
  const screen = renderWithQuery(<CategoryProvider><Probe /></CategoryProvider>);
  await waitFor(() => screen.getByText('name'));

  (api.getCategories as jest.Mock).mockRejectedValueOnce(new Error('boom'));
  await act(async () => { await latest.refreshCategories(); });
  expect(latest.error).toBe('boom');
  expect(latest.categories.map(c => c.name)).toEqual(['name']);
});

it('keeps the same context value across a re-render (H2-6.9)', async () => {
  (api.getCategories as jest.Mock).mockResolvedValue([cat('name')]);
  const seen: any[] = [];
  const Spy = () => { seen.push(useCategories()); return null; };
  const screen = renderWithQuery(<CategoryProvider><Spy /></CategoryProvider>);
  await waitFor(() => expect(seen.at(-1).categories).toHaveLength(1));
  screen.rerender(<QueryClientProvider client={screen.client}><CategoryProvider><Spy /></CategoryProvider></QueryClientProvider>);
  expect(seen.at(-1)).toBe(seen.at(-2));
});
