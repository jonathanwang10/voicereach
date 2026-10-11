// How category fields are ordered, labelled and shown, in one place for the
// Categories tab, manual entry and voice review (C-69).
import { categoryLabel } from './categoryPayload';

type DisplayCategory = { name: string; display_name?: string | null; priority?: string; type?: string };

// Shown first, in this order, under "Essential Information" (display order only;
// which fields are required comes from each category's is_required).
const ESSENTIAL_KEYS = ['name', 'height', 'weight', 'age'];
const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

const essentialIndex = (category: DisplayCategory) => ESSENTIAL_KEYS.indexOf(category.name.trim().toLowerCase());

export const isEssentialCategory = (category: DisplayCategory): boolean => essentialIndex(category) !== -1;

// Name, Height, Weight, Age first, then by priority (high first), then by label.
// Returns a new array.
export const sortCategories = <T extends DisplayCategory>(categories: T[]): T[] =>
  [...categories].sort((a, b) => {
    const aIndex = essentialIndex(a);
    const bIndex = essentialIndex(b);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;

    const priorityDiff = (PRIORITY_RANK[b.priority ?? ''] || 0) - (PRIORITY_RANK[a.priority ?? ''] || 0);
    if (priorityDiff !== 0) return priorityDiff;

    return categoryLabel(a).localeCompare(categoryLabel(b));
  });

const isHeight = (category: DisplayCategory) => category.name.trim().toLowerCase() === 'height';

// Free-text fields that get a multi-line box. Matches the key ("additional_information"),
// not the label, so it no longer depends on how the name was typed.
export const isLongTextCategory = (category: DisplayCategory): boolean => {
  const key = category.name.trim().toLowerCase();
  return category.type === 'text' && (key.includes('notes') || key === 'additional_information');
};

export const fieldPlaceholder = (category: DisplayCategory): string => {
  if (isHeight(category)) return "Enter height (e.g., 5'10 or 70)";
  if (category.name.trim().toLowerCase() === 'additional_information') {
    return 'Enter any other relevant information not covered by other categories...';
  }
  return `Enter ${categoryLabel(category).toLowerCase()}`;
};

// Height takes text like 5'10, so only other numbers get the numeric keyboard
export const fieldKeyboardType = (category: DisplayCategory): 'numeric' | 'default' =>
  category.type === 'number' && !isHeight(category) ? 'numeric' : 'default';
