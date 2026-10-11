import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../services/api';
import { showApiError } from '../utils/errorHandler';
import { Category, categoryLabel } from '../utils/categoryPayload';

// Categories are create-only on the server, so this context only loads them.
// (Local on/off toggles and a local "edit" used to live here; nothing honoured
// them, so they were removed: C-36.)
interface CategoryContextType {
  categories: Category[];
  isLoading: boolean;
  refreshCategories: () => Promise<void>;
}

const CategoryContext = createContext<CategoryContextType | undefined>(undefined);

interface CategoryProviderProps {
  children: ReactNode;
}

export const CategoryProvider: React.FC<CategoryProviderProps> = ({ children }) => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchCategories = async () => {
    try {
      setIsLoading(true);
      const response: Category[] = (await api.getCategories()) || [];

      // Name, Height, Weight, Age first (display order only), then by priority, then label
      const firstOrder = ['name', 'height', 'weight', 'age'];
      const sortedCategories = [...response].sort((a, b) => {
        const aIndex = firstOrder.indexOf(a.name.toLowerCase());
        const bIndex = firstOrder.indexOf(b.name.toLowerCase());
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;

        const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
        const priorityDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
        if (priorityDiff !== 0) return priorityDiff;

        return categoryLabel(a).localeCompare(categoryLabel(b));
      });

      setCategories(sortedCategories);
    } catch (error) {
      // services/api no longer toasts, so say it here once (C-16/C-17)
      showApiError(error, "Couldn't load categories");
      setCategories([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch categories on mount
  useEffect(() => {
    fetchCategories();
  }, []);

  const refreshCategories = async () => {
    await fetchCategories();
  };

  const value: CategoryContextType = {
    categories,
    isLoading,
    refreshCategories,
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
