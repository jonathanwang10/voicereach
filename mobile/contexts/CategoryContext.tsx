import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../services/api';
import { errorMessage } from '../utils/errors';
import { Category } from '../utils/categoryPayload';
import { sortCategories } from '../utils/categoryDisplay';

// Categories are create-only on the server, so this context only loads them.
// (Local on/off toggles and a local "edit" used to live here; nothing honoured
// them, so they were removed: C-36.)
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

// Mounted by App only once signed in, so the first load never races the sign-in.
export const CategoryProvider: React.FC<CategoryProviderProps> = ({ children }) => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = async () => {
    try {
      setIsLoading(true);
      const response: Category[] = (await api.getCategories()) || [];
      setCategories(sortCategories(response));
      setError(null);
    } catch (e) {
      // Keep what was loaded before; the screen shows the error with Retry
      setError(errorMessage(e));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  const value: CategoryContextType = {
    categories,
    isLoading,
    error,
    refreshCategories: fetchCategories,
  };

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
