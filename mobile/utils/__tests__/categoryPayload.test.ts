import { buildCategoryPayload } from '../categoryPayload';

const base = { name: ' Age ', priority: 'high', options: [], dangerWeight: 40, autoTrigger: true };

describe('buildCategoryPayload', () => {
  it('sends weight and auto_trigger for number categories', () => {
    const p = buildCategoryPayload({ ...base, type: 'number' });
    expect(p.urgency_weight).toBe(40);
    expect(p.auto_trigger).toBe(true);
    expect(p.name).toBe('Age');
  });

  it('coerces a string weight to a number', () => {
    expect(buildCategoryPayload({ ...base, type: 'number', dangerWeight: '25' }).urgency_weight).toBe(25);
  });

  it('sends 0 / false for types that cannot carry a weight', () => {
    const p = buildCategoryPayload({ ...base, type: 'text' });
    expect(p.urgency_weight).toBe(0);
    expect(p.auto_trigger).toBe(false);
  });
});
