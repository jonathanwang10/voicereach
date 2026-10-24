// Query keys and helpers shared by the screens (H2-6.6)
import { useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';

export const queryKeys = {
  categories: ['categories'],
  individualsList: ['individuals', 'list'],
  individualSearch: (q: string) => ['individuals', 'search', q],
  individual: (id: string) => ['individual', id],
} as const;

// Refetch when the screen comes back into view, but not on its first focus (the
// query has just loaded). TanStack's React Native recipe.
export const useRefreshOnFocus = (refetch: () => unknown): void => {
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      refetch();
    }, [refetch])
  );
};
