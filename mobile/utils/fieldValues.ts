// One place for how the app enters, sends and shows category field values, so the
// voice-review and manual-entry forms agree with each other and with the backend
// normaliser (backend/services/field_registry.normalize_individual_data).
//
// - Empty values (null, undefined, blank strings, [] and {}) are never sent or shown (C-09).
// - Numbers are sent as numbers, height as inches, single-select labels in the
//   category's case, multi-selects as arrays of labels (C-14, C-15).
import { parseHeightToInches } from './height';
import { categoryLabel } from './categoryPayload';

export interface FieldCategory {
  name: string;
  display_name?: string | null;
  type: string;
  is_required?: boolean;
  options?: any;
}

export const isEmptyValue = (v: any): boolean => {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
};

// A copy of `data` without empty values. 0 and false are values.
export const stripEmpty = (data: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (!isEmptyValue(value)) out[key] = value;
  });
  return out;
};

// Display text for a stored value, or null when there is nothing to show.
// Lists are joined, a location object shows its address (else its coordinates).
export const formatFieldValue = (v: any): string | null => {
  if (isEmptyValue(v)) return null;
  if (Array.isArray(v)) {
    const parts = v.map(formatFieldValue).filter((p): p is string => p !== null);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') {
    if (typeof v.address === 'string' && v.address.trim()) return v.address;
    if (typeof v.latitude === 'number' && typeof v.longitude === 'number') {
      return `${v.latitude.toFixed(6)}, ${v.longitude.toFixed(6)}`;
    }
    return null;
  }
  return String(v);
};

// Tapping a multi-select quick option adds it, or removes it if already chosen.
export const toggleMultiSelect = (list: string[] | undefined, option: string): string[] => {
  const current = list || [];
  const wanted = option.toLowerCase();
  const without = current.filter(item => String(item).toLowerCase() !== wanted);
  return without.length === current.length ? [...current, option] : without;
};

// Same key rule as the backend's category_key: "HIV status" -> "hiv_status".
const categoryKey = (name: string) => String(name).trim().toLowerCase().replace(/[\s-]+/g, '_');

export const optionLabels = (category: FieldCategory): string[] =>
  (Array.isArray(category.options) ? category.options : [])
    .map((o: any) => (o && typeof o === 'object' ? o.label : o))
    .filter((l: any): l is string => typeof l === 'string');

const matchLabel = (value: any, labels: string[]): string | null => {
  const wanted = String(value).trim().toLowerCase();
  return labels.find(l => l.toLowerCase() === wanted) ?? null;
};

const toList = (v: any): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',');
  return isEmptyValue(v) ? [] : [v];
};

// The value to send for one field. A value that cannot be converted is returned as
// typed (trimmed) so the backend's error names it; validateFieldValue catches it first.
export const coerceFieldValue = (category: FieldCategory | undefined, value: any): any => {
  if (typeof value === 'string') value = value.trim();
  if (isEmptyValue(value) || !category) return isEmptyValue(value) ? undefined : value;

  switch (category.type) {
    case 'number': {
      const num = categoryKey(category.name) === 'height'
        ? parseHeightToInches(value)
        : typeof value === 'number' ? value : Number(value);
      return num !== null && Number.isFinite(num) ? num : value;
    }
    case 'single_select':
      return matchLabel(value, optionLabels(category)) ?? value;
    case 'multi_select': {
      const labels = optionLabels(category);
      const items: string[] = [];
      toList(value).forEach(item => {
        if (isEmptyValue(item)) return;
        const label = matchLabel(item, labels) ?? (typeof item === 'string' ? item.trim() : item);
        if (!items.some(i => String(i).toLowerCase() === String(label).toLowerCase())) items.push(label);
      });
      return items.length ? items : undefined;
    }
    default:
      return value;
  }
};

// The `data` to send: every field coerced to its category's type, empties dropped.
// Keys are kept as given; the backend maps them to the category name.
export const coerceFieldData = (data: Record<string, any>, categories: FieldCategory[]): Record<string, any> => {
  const byKey = new Map(categories.map(c => [categoryKey(c.name), c]));
  const out: Record<string, any> = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    out[key] = coerceFieldValue(byKey.get(categoryKey(key)), value);
  });
  return stripEmpty(out);
};

// The label for a `data` key: its category's label (categoryLabel: display_name, else the
// key title-cased), found by the same key rule as the backend. A key with no category is
// title-cased.
export const fieldLabel = (key: string, categories: FieldCategory[] = []): string => {
  const wanted = categoryKey(key);
  return categoryLabel(categories.find(c => categoryKey(c.name) === wanted) ?? { name: key });
};

// The client-side check for one field ('' when fine), mirroring the backend
// normaliser so a value the backend would reject is caught next to its field.
export const validateFieldValue = (category: FieldCategory, value: any): string => {
  const label = categoryLabel(category);
  if (isEmptyValue(value)) return category.is_required ? `${label} is required` : '';

  const key = categoryKey(category.name);
  if (category.type === 'number') {
    if (key === 'height') {
      const inches = parseHeightToInches(value);
      if (inches === null) return `${label} must be in inches or x'y format`;
      if (inches < 0) return `${label} must be a positive number`;
      if (inches > 300) return `${label} must be 300 or less`;
      return '';
    }
    const num = coerceFieldValue(category, value);
    if (typeof num !== 'number') return `${label} must be a number`;
    if (num < 0) return `${label} must be a positive number`;
    if (key === 'weight' && num > 300) return `${label} must be 300 or less`;
    if (key === 'age' && num > 120) return `${label} must be 120 or less`;
    return '';
  }

  const labels = optionLabels(category);
  if (category.type === 'single_select' && labels.length && matchLabel(value, labels) === null) {
    return `Please select a valid ${label.toLowerCase()}`;
  }
  if (category.type === 'multi_select' && labels.length) {
    const unknown = toList(value).filter(item => !isEmptyValue(item) && matchLabel(item, labels) === null);
    if (unknown.length) return `Unknown ${label.toLowerCase()}: ${unknown.map(u => String(u).trim()).join(', ')}`;
  }
  return '';
};
