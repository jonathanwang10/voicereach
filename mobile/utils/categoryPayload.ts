// Building and checking the "Add New Category" form. The rules mirror the
// backend's CreateCategoryRequest (backend/db/models.py), so a form that passes
// here is accepted there (apart from a name that already exists: 409).

export type CategoryType = 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'location';

export type SelectOption = { label: string; value: number };

export interface Category {
  id: string;
  name: string;               // the key used in each person's data, e.g. "hiv_status"
  display_name?: string | null; // the label as typed, e.g. "HIV status"
  type: CategoryType;
  options?: SelectOption[] | string[] | null;
  priority: 'high' | 'medium' | 'low';
  urgency_weight: number;
  auto_trigger: boolean;
  is_required: boolean;
  is_preset: boolean;
}

export interface CategoryForm {
  name: string;
  type: string;
  priority: string;
  optionsText: string;
  weight: string | number;
  autoTrigger: boolean;
}

export const MAX_CATEGORY_NAME_LENGTH = 50;
export const MAX_OPTION_LABEL_LENGTH = 50;
export const MAX_OPTIONS = 50;

const isSelect = (type: string) => type === 'single_select' || type === 'multi_select';
const isWeighted = (type: string) => type === 'number' || type === 'single_select';

// The label people see: display_name, else the key title-cased ("hiv_status" -> "Hiv Status").
export const categoryLabel = (category: { name: string; display_name?: string | null }): string =>
  category.display_name?.trim() ||
  category.name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

// Trimmed, with runs of whitespace collapsed (as the backend does).
const cleanName = (name: string) => name.trim().split(/\s+/).join(' ');

/**
 * Parse the comma-separated options box.
 * - single_select: "Calm, Agitated=0.5, Violent=1" -> [{label, value}], value
 *   defaults to 0 and must be from 0 to 1 (the share of the weight it adds).
 * - multi_select: "Dog, Cat" -> ["Dog", "Cat"].
 * - other types: options are null.
 * Labels are trimmed, non-empty, at most 50 characters and unique (ignoring case).
 */
export const parseOptionsInput = (
  text: string,
  type: string,
): { options: SelectOption[] | string[] | null; error?: string } => {
  if (!isSelect(type)) return { options: null };
  const items = (text || '').split(',').map(s => s.trim()).filter(Boolean);
  if (items.length === 0) return { options: null, error: 'Add at least one option, separated by commas' };
  if (items.length > MAX_OPTIONS) return { options: null, error: `At most ${MAX_OPTIONS} options are allowed` };

  const seen = new Set<string>();
  const single: SelectOption[] = [];
  const multi: string[] = [];
  for (const item of items) {
    let label = item;
    let value = 0;
    if (type === 'single_select') {
      const eq = item.lastIndexOf('=');
      if (eq !== -1) {
        label = item.slice(0, eq).trim();
        const raw = item.slice(eq + 1).trim();
        value = raw === '' ? NaN : Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          return { options: null, error: `Option "${item}": the value must be a number between 0 and 1` };
        }
      }
    }
    if (!label) return { options: null, error: `Option "${item}" needs a label` };
    if (label.length > MAX_OPTION_LABEL_LENGTH) {
      return { options: null, error: `Option labels must be at most ${MAX_OPTION_LABEL_LENGTH} characters` };
    }
    if (seen.has(label.toLowerCase())) return { options: null, error: `Duplicate option "${label}"` };
    seen.add(label.toLowerCase());
    single.push({ label, value });
    multi.push(label);
  }
  return { options: type === 'single_select' ? single : multi };
};

// The urgency weight as an integer from 0 to 100 (blank or junk is 0).
const clampWeight = (weight: string | number): number => {
  const n = Number(weight);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
};

// The first problem with the form, or null if it can be sent.
export const validateCategoryForm = (form: CategoryForm): string | null => {
  const name = cleanName(form.name);
  if (!/[A-Za-z0-9]/.test(name)) return 'Category name must contain a letter or digit';
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    return `Category name must be at most ${MAX_CATEGORY_NAME_LENGTH} characters`;
  }
  const { error } = parseOptionsInput(form.optionsText, form.type);
  if (error) return error;
  if (isWeighted(form.type) && String(form.weight).trim() !== '' && !Number.isFinite(Number(form.weight))) {
    return 'Weight must be a number from 0 to 100';
  }
  return null;
};

export type CreateCategoryPayload = ReturnType<typeof buildCategoryPayload>;

export const buildCategoryPayload = (form: CategoryForm) => {
  // Only number and single_select categories may carry an urgency weight.
  const weighted = isWeighted(form.type);
  return {
    name: cleanName(form.name),
    type: form.type,
    is_required: false,
    priority: form.priority,
    urgency_weight: weighted ? clampWeight(form.weight) : 0,
    auto_trigger: weighted ? form.autoTrigger : false,
    options: parseOptionsInput(form.optionsText, form.type).options,
  };
};
