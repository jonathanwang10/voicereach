import React, { createContext, useCallback, useContext, useMemo, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { queryKeys } from '../services/queries';
import { errorMessage } from '../utils/errors';
import { Category } from '../utils/categoryPayload';
import { sortCategories } from '../utils/categoryDisplay';

// Categories are create-only on the server, so this context only loads them.
// (Local on/off toggles and a local "edit" used to live here; nothing honoured
// them, so they were removed: C-36.) It is the one place the app reads them (H2-6.5).
interface CategoryContextType {
  categories: Category[];
  isLoading: boolean;
  // Why the last load failed (C-35); the Categories tab shows it with Retry
  error: string | null;
  refreshCategories: () => Promise<void>;
}

const CategoryContext = createContext<CategoryContextType | undefined>(undefined);

interface CategoryProviderProps {
  children: ReactNode;
}

const NO_CATEGORIES: Category[] = [];
const fetchCategories = async (): Promise<Category[]> => (await api.getCategories()) || [];
const sortAll = (categories: Category[]) => sortCategories<Category>(categories);

// Mounted by App only once signed in, so the first load never races the sign-in.
export const CategoryProvider: React.FC<CategoryProviderProps> = ({ children }) => {
  // A failed refetch keeps the categories already loaded (TanStack keeps `data`)
  const query = useQuery({
    queryKey: queryKeys.categories,
    queryFn: fetchCategories,
    select: sortAll,
    staleTime: 5 * 60_000,
  });
  const { refetch } = query;

  const refreshCategories = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Stable while nothing changed, so consumers don't re-render for nothing (H2-6.9)
  const categories = query.data ?? NO_CATEGORIES;
  const error = query.error ? errorMessage(query.error) : null;
  const value = useMemo<CategoryContextType>(
    () => ({ categories, isLoading: query.isPending, error, refreshCategories }),
    [categories, query.isPending, error, refreshCategories]
  );

  return (
    <CategoryContext.Provider value={value}>
      {children}
    </CategoryContext.Provider>
  );
};

export const useCategories = (): CategoryContextType => {
  const context = useContext(CategoryContext);
  if (context === undefined) {
    throw new Error('useCategories must be used within a CategoryProvider');
  }
  return context;
};
