// Query keys and helpers shared by the screens (H2-6.6)
import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  InfiniteData,
  QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, IndividualsPage } from './api';
import { SearchResult } from '../types';
import { subscribePendingDeletes } from '../utils/delayedDelete';

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

// The default list, a page at a time by cursor (H2-6.10)
export const useIndividualsList = () =>
  useInfiniteQuery({
    queryKey: queryKeys.individualsList,
    queryFn: ({ pageParam }) => api.listIndividuals(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: IndividualsPage) => last.nextCursor ?? undefined,
  });

// Semantic search, falling back to text search when it fails. Each query has its own
// cache entry, so a slow answer for "v" can never show under "veteran" (C-06).
const searchFor = async (query: string): Promise<SearchResult[]> => {
  try {
    return await api.semanticSearchIndividuals(query);
  } catch {
    return api.searchIndividuals(query);
  }
};

export const useIndividualSearch = (query: string) =>
  useQuery({
    queryKey: queryKeys.individualSearch(query),
    queryFn: () => searchFor(query),
    enabled: query !== '',
  });

// A deleted person leaves every cached list, search and profile
export const removeIndividualFromCache = (client: QueryClient, id: string): void => {
  client.setQueryData<InfiniteData<IndividualsPage>>(queryKeys.individualsList, data =>
    data && {
      ...data,
      pages: data.pages.map(page => {
        const items = page.items.filter(r => r.id !== id);
        return items.length === page.items.length ? page : { ...page, items, total: page.total - 1 };
      }),
    });
  client.setQueriesData<SearchResult[]>({ queryKey: ['individuals', 'search'] }, results =>
    results?.filter(r => r.id !== id));
  client.removeQueries({ queryKey: queryKeys.individual(id) });
};

// Mounted once (App): a committed delete is dropped from the cache instead of reloading
export const useEvictCommittedDeletes = (): void => {
  const client = useQueryClient();
  useEffect(() => subscribePendingDeletes(({ id, type }) => {
    if (type === 'committed') removeIndividualFromCache(client, id);
  }), [client]);
};
