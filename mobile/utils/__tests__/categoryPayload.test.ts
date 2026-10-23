import {
  buildCategoryPayload,
  categoryLabel,
  parseOptionsInput,
  validateCategoryForm,
} from '../categoryPayload';

const base = { name: ' Age ', priority: 'high', optionsText: '', weight: 40, autoTrigger: true };

describe('buildCategoryPayload', () => {
  it('sends weight and auto_trigger for number categories', () => {
    const p = buildCategoryPayload({ ...base, type: 'number' });
    expect(p.urgency_weight).toBe(40);
    expect(p.auto_trigger).toBe(true);
    expect(p.name).toBe('Age');
    expect(p.options).toBeNull();
  });

  it('coerces a string weight to a number and clamps it to 0-100', () => {
    expect(buildCategoryPayload({ ...base, type: 'number', weight: '25' }).urgency_weight).toBe(25);
    expect(buildCategoryPayload({ ...base, type: 'number', weight: '250' }).urgency_weight).toBe(100);
    expect(buildCategoryPayload({ ...base, type: 'number', weight: '-5' }).urgency_weight).toBe(0);
    expect(buildCategoryPayload({ ...base, type: 'number', weight: '12.6' }).urgency_weight).toBe(13);
    expect(buildCategoryPayload({ ...base, type: 'number', weight: '' }).urgency_weight).toBe(0);
  });

  it('sends 0 / false for types that cannot carry a weight', () => {
    const p = buildCategoryPayload({ ...base, type: 'text' });
    expect(p.urgency_weight).toBe(0);
    expect(p.auto_trigger).toBe(false);
  });

  it('keeps the user casing and collapses spaces in the name', () => {
    expect(buildCategoryPayload({ ...base, name: '  HIV   status ', type: 'text' }).name).toBe('HIV status');
  });

  // C-07: select types could never be created (options were never set)
  it('sends {label, value} options for single-select', () => {
    const p = buildCategoryPayload({ ...base, type: 'single_select', optionsText: 'Calm, Agitated=0.5, Violent=1' });
    expect(p.options).toEqual([
      { label: 'Calm', value: 0 },
      { label: 'Agitated', value: 0.5 },
      { label: 'Violent', value: 1 },
    ]);
    expect(p.urgency_weight).toBe(40);
  });

  it('sends plain string options for multi-select, with no weight or trigger', () => {
    const p = buildCategoryPayload({ ...base, type: 'multi_select', optionsText: 'Dog, Cat ,Bird' });
    expect(p.options).toEqual(['Dog', 'Cat', 'Bird']);
    expect(p.urgency_weight).toBe(0);
    expect(p.auto_trigger).toBe(false);
  });
});

describe('parseOptionsInput', () => {
  it('defaults single-select values to 0 and reads Label=value', () => {
    expect(parseOptionsInput('Low, High=0.8', 'single_select')).toEqual({
      options: [{ label: 'Low', value: 0 }, { label: 'High', value: 0.8 }],
    });
  });

  it('drops empty items', () => {
    expect(parseOptionsInput(' , Dog,, ', 'multi_select')).toEqual({ options: ['Dog'] });
  });

  it('requires at least one option for select types', () => {
    expect(parseOptionsInput('  ', 'single_select').error).toMatch(/at least one option/i);
    expect(parseOptionsInput(',', 'multi_select').error).toMatch(/at least one option/i);
  });

  it('returns null options for other types', () => {
    expect(parseOptionsInput('a, b', 'text')).toEqual({ options: null });
  });

  it.each([
    ['High=2', /between 0 and 1/],
    ['High=-0.5', /between 0 and 1/],
    ['High=abc', /between 0 and 1/],
    ['High=', /between 0 and 1/],
    ['=0.5', /label/i],
    ['Low, low', /duplicate/i],
  ])('rejects %s for single-select', (text, message) => {
    const result = parseOptionsInput(text, 'single_select');
    expect(result.error).toMatch(message);
  });

  it('rejects duplicate and over-long multi-select options', () => {
    expect(parseOptionsInput('Dog, dog', 'multi_select').error).toMatch(/duplicate/i);
    expect(parseOptionsInput('x'.repeat(51), 'multi_select').error).toMatch(/50 characters/);
  });
});

describe('validateCategoryForm', () => {
  const ok = { name: 'Mood', type: 'single_select', priority: 'high', optionsText: 'Calm', weight: '30', autoTrigger: false };

  it('accepts a valid form', () => {
    expect(validateCategoryForm(ok)).toBeNull();
  });

  it.each(['', '   ', '---', '_'])('rejects the blank name %p', (name) => {
    expect(validateCategoryForm({ ...ok, name })).toMatch(/letter or digit/);
  });

  it('rejects names over 50 characters', () => {
    expect(validateCategoryForm({ ...ok, name: 'x'.repeat(51) })).toMatch(/50 characters/);
  });

  it('reports option errors', () => {
    expect(validateCategoryForm({ ...ok, optionsText: '' })).toMatch(/at least one option/i);
  });

  it('rejects a weight that is not a number, only for weighted types', () => {
    expect(validateCategoryForm({ ...ok, weight: 'lots' })).toMatch(/0 to 100/);
    expect(validateCategoryForm({ ...ok, type: 'text', optionsText: '', weight: 'lots' })).toBeNull();
  });
});

describe('categoryLabel', () => {
  it('uses display_name, else title-cases the key', () => {
    expect(categoryLabel({ name: 'hiv_status', display_name: 'HIV status' })).toBe('HIV status');
    expect(categoryLabel({ name: 'additional_information' })).toBe('Additional Information');
    expect(categoryLabel({ name: 'age', display_name: null })).toBe('Age');
  });
});

// H2-2.8: a number category's optional "Scale max"
describe('scale max', () => {
  const numberForm = { ...base, type: 'number' };
  it('sends number_scale_max for a number type with a value, else null', () => {
    expect(buildCategoryPayload({ ...numberForm, scaleMax: '10' }).number_scale_max).toBe(10);
    expect(buildCategoryPayload({ ...numberForm, scaleMax: ' ' }).number_scale_max).toBeNull();
    expect(buildCategoryPayload(numberForm).number_scale_max).toBeNull();
    expect(buildCategoryPayload({ ...base, type: 'single_select', optionsText: 'A', scaleMax: '10' })
      .number_scale_max).toBeNull();
  });

  it('rejects a scale max that is not a number greater than 0', () => {
    for (const scaleMax of ['0', '-2', 'abc']) {
      expect(validateCategoryForm({ ...numberForm, scaleMax })).toBe('Scale max must be a number greater than 0');
    }
    expect(validateCategoryForm({ ...numberForm, scaleMax: '' })).toBeNull();
  });
});
