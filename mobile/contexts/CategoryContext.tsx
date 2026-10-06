import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { api } from '../services/api';

interface Category {
  id: string;
  name: string;
  type: 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'location';
  is_required: boolean;
  priority: 'high' | 'medium' | 'low';
  urgency_weight?: number;
  auto_trigger?: boolean;
  options?: string[] | Array<{label: string, value: number}>;
  active: boolean; // For UI state management
}

interface CategoryContextType {
  categories: Category[];
  isLoading: boolean;
  toggleCategoryActive: (categoryId: string) => void;
  getActiveCategories: () => Category[];
  refreshCategories: () => Promise<void>;
  updateCategoryLocal: (id: string, patch: Partial<Category>) => void;
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
      console.log('📋 CategoryContext - Fetching categories from API...');
      const response = await api.getCategories();
      console.log('📋 CategoryContext - Raw API response:', response);
      console.log('📋 CategoryContext - Categories count:', response?.length || 0);
      
      // Add active state for UI (defaulting to true for all categories)
      const categoriesWithActiveState = (response || []).map((cat: any) => ({
        ...cat,
        active: true // Default all categories to active for UI
      }));
      
      console.log('📋 CategoryContext - Categories with active state:', categoriesWithActiveState.map(c => c.name));
      
      // Sort categories with essential categories first in specific order
      const sortedCategories = categoriesWithActiveState.sort((a, b) => {
        // Define essential categories order: Name, Height, Weight, Age
        const essentialOrder = ['name', 'height', 'weight', 'age'];
        const aIndex = essentialOrder.indexOf(a.name.toLowerCase());
        const bIndex = essentialOrder.indexOf(b.name.toLowerCase());
        
        // If both are essential categories, sort by their defined order
        if (aIndex !== -1 && bIndex !== -1) {
          return aIndex - bIndex;
        }
        
        // Essential categories always come first
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        
        // For non-essential categories, sort by priority then alphabetically
        const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
        const priorityDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
        if (priorityDiff !== 0) return priorityDiff;
        
        // Finally sort alphabetically by name
        return a.name.localeCompare(b.name);
      });
      
      setCategories(sortedCategories);
      console.log('📋 CategoryContext - Sorted categories:', sortedCategories?.map(c => c.name) || []);
      
    } catch (error) {
      console.error('❌ CategoryContext - Failed to fetch categories:', error);
      setCategories([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch categories on mount
  useEffect(() => {
    fetchCategories();
  }, []);

  const isEssentialCategory = (categoryName: string): boolean => {
    const essentialNames = ['name', 'height', 'weight', 'age'];
    return essentialNames.includes(categoryName.toLowerCase());
  };

  const toggleCategoryActive = (categoryId: string) => {
    setCategories(prev => 
      prev.map(cat => {
        if (cat.id === categoryId) {
          // Prevent toggling off essential categories
          if (isEssentialCategory(cat.name) && cat.active) {
            console.log('📋 CategoryContext - Cannot toggle off essential category:', cat.name);
            return cat;
          }
          const newActiveState = !cat.active;
          console.log('📋 CategoryContext - Toggling category:', cat.name, 'to', newActiveState ? 'ON' : 'OFF');
          return { ...cat, active: newActiveState };
        }
        return cat;
      })
    );
  };

  const getActiveCategories = (): Category[] => {
    return categories.filter(cat => cat.active);
  };

  const updateCategoryLocal = (id: string, patch: Partial<Category>) =>
    setCategories(prev => prev.map(cat => (cat.id === id ? { ...cat, ...patch } : cat)));

  const refreshCategories = async () => {
    await fetchCategories();
  };

  const value: CategoryContextType = {
    categories,
    isLoading,
    toggleCategoryActive,
    getActiveCategories,
    refreshCategories,
    updateCategoryLocal,
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
