// Server state (H2-6.6): TanStack Query, in memory only. There is no persister, so
// nothing about a person is written to the phone's storage; App clears the cache on
// Sign Out. Queries refetch when the app returns to the foreground and when the
// network comes back.
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      // No retry: authedFetch already retries a GET once. networkMode 'always': a
      // request offline runs and fails, so screens show their retry state instead of
      // a paused spinner (NetInfo can be wrong, or unknown at launch).
      queries: { retry: false, networkMode: 'always', staleTime: 0, gcTime: 5 * 60_000 },
      mutations: { retry: false, networkMode: 'always' },
    },
  });

export const queryClient = createQueryClient();

export const wireQueryManagers = (): (() => void) => {
  const appState = AppState.addEventListener('change', state => focusManager.setFocused(state === 'active'));
  // null (unknown, e.g. at launch) counts as online
  onlineManager.setEventListener(setOnline =>
    NetInfo.addEventListener(state => setOnline(state.isConnected !== false)));
  return () => {
    appState.remove();
    onlineManager.setEventListener(() => undefined);
  };
};
