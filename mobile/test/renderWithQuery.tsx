// Render inside a fresh QueryClientProvider; the client is returned for assertions.
import React from 'react';
import { render, RenderResult } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../services/queryClient';

export const renderWithQuery = (
  ui: React.ReactElement,
  client: QueryClient = createQueryClient(),
): RenderResult & { client: QueryClient } => ({
  ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  client,
});
