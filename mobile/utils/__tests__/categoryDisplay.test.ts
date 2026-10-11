// C-69: one sort and one "essential" split shared by the Categories tab, manual entry
// and voice review. Carried item: labels from display_name, and the multiline check
// matches the key "additional_information" (it never matched "additional information").
import {
  sortCategories,
  isEssentialCategory,
  isLongTextCategory,
  fieldPlaceholder,
} from '../categoryDisplay';

const cat = (name: string, priority: string, display_name: string | null = null, type = 'text') =>
  ({ name, priority, display_name, type });

it('puts Name, Height, Weight, Age first in that order, then priority, then label', () => {
  const sorted = sortCategories([
    cat('zebra', 'low'),
    cat('Weight', 'high'),
    cat('apple', 'low'),
    cat('age', 'low'),
    cat('hiv_status', 'high', 'HIV status'),
    cat('name', 'high'),
    cat('housing', 'high'),
    cat('Height', 'low'),
  ]);
  expect(sorted.map(c => c.name)).toEqual(
    ['name', 'Height', 'Weight', 'age', 'hiv_status', 'housing', 'apple', 'zebra']);
});

it('does not mutate its input', () => {
  const input = [cat('b', 'low'), cat('a', 'low')];
  sortCategories(input);
  expect(input.map(c => c.name)).toEqual(['b', 'a']);
});

it('essential means name/height/weight/age, whatever the casing', () => {
  expect(isEssentialCategory(cat('Height', 'low'))).toBe(true);
  expect(isEssentialCategory(cat('age', 'low'))).toBe(true);
  expect(isEssentialCategory(cat('gender', 'high'))).toBe(false);
});

it('long text is a text field keyed notes or additional_information', () => {
  expect(isLongTextCategory(cat('additional_information', 'low'))).toBe(true);
  expect(isLongTextCategory(cat('notes', 'low'))).toBe(true);
  expect(isLongTextCategory(cat('case_notes', 'low'))).toBe(true);
  expect(isLongTextCategory(cat('additional_information', 'low', null, 'number'))).toBe(false);
  expect(isLongTextCategory(cat('name', 'low'))).toBe(false);
});

it('placeholders use the display label', () => {
  expect(fieldPlaceholder(cat('hiv_status', 'low', 'HIV status'))).toBe('Enter hiv status');
  expect(fieldPlaceholder(cat('Height', 'low', null, 'number'))).toBe("Enter height (e.g., 5'10 or 70)");
  expect(fieldPlaceholder(cat('additional_information', 'low'))).toMatch(/other relevant information/);
});
