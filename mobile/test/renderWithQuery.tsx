// Render inside a fresh QueryClientProvider; the client is returned for assertions.
import React from 'react';
import { render, RenderResult } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../services/queryClient';

// The app's options, but gcTime Infinity: a 5-minute garbage-collection timer would
// keep an in-band Jest run alive for 5 minutes after the tests finish
const testQueryClient = (): QueryClient => {
  const client = createQueryClient();
  const { queries, mutations } = client.getDefaultOptions();
  client.setDefaultOptions({ queries: { ...queries, gcTime: Infinity }, mutations: { ...mutations, gcTime: Infinity } });
  return client;
};

export const renderWithQuery = (
  ui: React.ReactElement,
  client: QueryClient = testQueryClient(),
): RenderResult & { client: QueryClient } => ({
  ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  client,
});
