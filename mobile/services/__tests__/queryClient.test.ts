// H2-6.6: server state lives in TanStack Query, in memory only, refetching on focus and
// when the network returns. Offline, a query still runs and fails rather than pausing.
import { AppState } from 'react-native';
import { act } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { createQueryClient, queryClient, wireQueryManagers } from '../queryClient';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});
const made: ReturnType<typeof createQueryClient>[] = [];
const newClient = () => { const c = createQueryClient(); made.push(c); return c; };
afterEach(() => {
  jest.restoreAllMocks();
  onlineManager.setOnline(true);
  made.splice(0).forEach(c => c.clear()); // no gc timer outlives the test
});

it('the app comes to the foreground: queries see focus (H2-6.6)', () => {
  let handler: (s: string) => void = () => {};
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, h: any) => {
    handler = h;
    return { remove };
  }) as any);
  const cleanup = wireQueryManagers();
  act(() => handler('background'));
  expect(focusManager.isFocused()).toBe(false);
  act(() => handler('active'));
  expect(focusManager.isFocused()).toBe(true);
  cleanup();
  expect(remove).toHaveBeenCalled();
});

it('NetInfo drives onlineManager; unknown connectivity counts as online', () => {
  wireQueryManagers();
  const listener = (NetInfo.addEventListener as jest.Mock).mock.calls.at(-1)[0];
  act(() => listener({ isConnected: false }));
  expect(onlineManager.isOnline()).toBe(false);
  act(() => listener({ isConnected: null }));
  expect(onlineManager.isOnline()).toBe(true);
});

it('a query offline still runs and fails instead of pausing', async () => {
  onlineManager.setOnline(false);
  const client = newClient();
  await expect(client.fetchQuery({ queryKey: ['x'], queryFn: async () => { throw new Error('No connection'); } }))
    .rejects.toThrow('No connection');
});

it('does not retry: the transport already retries a GET once', async () => {
  const client = newClient();
  const queryFn = jest.fn(async () => { throw new Error('boom'); });
  await expect(client.fetchQuery({ queryKey: ['r'], queryFn })).rejects.toThrow('boom');
  expect(queryFn).toHaveBeenCalledTimes(1);
});

it('has no persister: nothing is written to AsyncStorage', async () => {
  const client = newClient();
  await client.fetchQuery({ queryKey: ['p'], queryFn: async () => ({ name: 'Ann Lee' }) });
  expect(await AsyncStorage.getAllKeys()).toEqual([]);
});

it('the app has one client', () => {
  expect(queryClient.getDefaultOptions().queries).toMatchObject({ retry: false, networkMode: 'always' });
});
