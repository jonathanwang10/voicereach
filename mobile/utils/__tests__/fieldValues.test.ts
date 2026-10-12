// C-09, C-14, C-15: empty values are never saved or shown, values are sent with real
// types (numbers, multi-select arrays, canonical select labels), and the voice and
// manual paths validate a field the same way.
import {
  isEmptyValue,
  stripEmpty,
  formatFieldValue,
  toggleMultiSelect,
  coerceFieldData,
  validateFieldValue,
  fieldLabel,
} from '../fieldValues';

const categories = [
  { name: 'name', type: 'text', is_required: true },
  { name: 'height', type: 'number', is_required: true },
  { name: 'weight', type: 'number', is_required: true },
  { name: 'age', type: 'number', is_required: false },
  { name: 'gender', type: 'single_select', is_required: false,
    options: [{ label: 'Male', value: 0 }, { label: 'Female', value: 0 }] },
  { name: 'medical_conditions', type: 'multi_select', is_required: false,
    options: ['Diabetes', 'Heart Disease', 'Mental Health'] },
  { name: 'notes', type: 'text', is_required: false },
];
const cat = (name: string) => categories.find(c => c.name === name)!;

describe('isEmptyValue', () => {
  it.each([[null], [undefined], [''], ['   '], [[]], [{}]])('%p is empty', v => {
    expect(isEmptyValue(v)).toBe(true);
  });
  it.each([[0], [false], ['x'], [['a']], [{ address: 'Market St' }]])('%p is not empty', v => {
    expect(isEmptyValue(v)).toBe(false);
  });
});

describe('stripEmpty', () => {
  it('drops null, blank strings and empty lists but keeps 0 and false', () => {
    expect(stripEmpty({ a: null, b: '', c: '  ', d: [], e: 0, f: false, g: 'x', h: ['y'] }))
      .toEqual({ e: 0, f: false, g: 'x', h: ['y'] });
  });
  it('handles a missing object', () => {
    expect(stripEmpty(undefined as any)).toEqual({});
  });
});

describe('formatFieldValue', () => {
  it('returns null for empty values so renderers can skip them', () => {
    expect(formatFieldValue(null)).toBeNull();
    expect(formatFieldValue('')).toBeNull();
    expect(formatFieldValue([])).toBeNull();
  });
  it('joins arrays, shows a location object as its address, and keeps 0', () => {
    expect(formatFieldValue(['Diabetes', 'Mental Health'])).toBe('Diabetes, Mental Health');
    expect(formatFieldValue({ latitude: 1, longitude: 2, address: '5th & Market' })).toBe('5th & Market');
    expect(formatFieldValue(0)).toBe('0');
    expect(formatFieldValue(true)).toBe('Yes');
  });
  it('never renders [object Object]', () => {
    expect(formatFieldValue({ latitude: 37.7749, longitude: -122.4194 })).toBe('37.774900, -122.419400');
    expect(formatFieldValue({ foo: 'bar' })).toBeNull();
  });
});

describe('toggleMultiSelect', () => {
  it('adds a missing option and removes a present one (case-insensitive)', () => {
    expect(toggleMultiSelect(undefined, 'Diabetes')).toEqual(['Diabetes']);
    expect(toggleMultiSelect(['Diabetes'], 'Mental Health')).toEqual(['Diabetes', 'Mental Health']);
    expect(toggleMultiSelect(['diabetes', 'Mental Health'], 'Diabetes')).toEqual(['Mental Health']);
  });
});

describe('coerceFieldData', () => {
  it('sends numbers as numbers, matched labels, multi-select arrays, and drops empties', () => {
    const out = coerceFieldData({
      name: '  Ann  ',
      height: '6',
      weight: '180',
      age: '',
      gender: 'male',
      medical_conditions: 'diabetes, Mental health',
      notes: null,
      custom_unknown: 'kept',
    }, categories);
    expect(out).toEqual({
      name: 'Ann',
      height: 72,
      weight: 180,
      gender: 'Male',
      medical_conditions: ['Diabetes', 'Mental Health'],
      custom_unknown: 'kept',
    });
  });
  it('keeps a numeric height as inches (already normalised by the backend)', () => {
    expect(coerceFieldData({ height: 70 }, categories)).toEqual({ height: 70 });
  });
  it('leaves an unparseable value as typed so the backend error names it', () => {
    expect(coerceFieldData({ weight: 'heavy', gender: 'robot' }, categories))
      .toEqual({ weight: 'heavy', gender: 'robot' });
  });
  it('matches category keys regardless of case', () => {
    expect(coerceFieldData({ Weight: '150' }, categories)).toEqual({ Weight: 150 });
  });
});

describe('validateFieldValue', () => {
  it('accepts a single-select label in any case (the dead "select" branch, C-15)', () => {
    expect(validateFieldValue(cat('gender'), 'male')).toBe('');
    expect(validateFieldValue(cat('gender'), 'robot')).toMatch(/valid gender/i);
  });
  it('checks every multi-select item', () => {
    expect(validateFieldValue(cat('medical_conditions'), 'diabetes, mental health')).toBe('');
    expect(validateFieldValue(cat('medical_conditions'), ['Diabetes', 'Cancer'])).toMatch(/Cancer/);
  });
  it('treats a blank required field as missing', () => {
    expect(validateFieldValue(cat('name'), '   ')).toBe('Name is required');
  });
  it('checks numbers and height the way the backend does', () => {
    expect(validateFieldValue(cat('weight'), 'abc')).toMatch(/number/);
    expect(validateFieldValue(cat('weight'), '301')).toMatch(/300 or less/);
    expect(validateFieldValue(cat('height'), '6')).toBe('');
    expect(validateFieldValue(cat('height'), 'tall')).toMatch(/inches/);
    expect(validateFieldValue(cat('age'), '-1')).toMatch(/positive/);
  });
});

// Minor 1: messages and labels use the category's display_name, not the key title-cased.
describe('labels from display_name', () => {
  const hiv = { name: 'hiv_status', display_name: 'HIV status', type: 'text', is_required: true };
  const shoes = { name: 'shoe_size', display_name: 'Shoe size (US)', type: 'number', is_required: false };

  it('validateFieldValue names the field by its label', () => {
    expect(validateFieldValue(hiv, '')).toBe('HIV status is required');
    expect(validateFieldValue(shoes, 'big')).toBe('Shoe size (US) must be a number');
  });

  it('validateFieldValue falls back to the key title-cased', () => {
    expect(validateFieldValue({ name: 'hiv_status', type: 'text', is_required: true }, '')).toBe('Hiv Status is required');
  });

  it('fieldLabel maps a data key to its category label, matching keys like the backend', () => {
    expect(fieldLabel('hiv_status', [hiv])).toBe('HIV status');
    expect(fieldLabel('HIV status', [hiv])).toBe('HIV status');
    expect(fieldLabel('veteran_status', [hiv])).toBe('Veteran Status');
    expect(fieldLabel('veteran_status')).toBe('Veteran Status');
  });
});

