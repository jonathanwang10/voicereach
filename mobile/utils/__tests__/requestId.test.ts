import { newRequestId } from '../requestId';
import { isVersionConflict } from '../saveConflict';

describe('newRequestId', () => {
  it('is a v4 UUID, different every call', () => {
    const a = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(newRequestId()).not.toBe(a);
  });
});

describe('isVersionConflict', () => {
  it('is true only for a 409', () => {
    expect(isVersionConflict({ status: 409 })).toBe(true);
    expect(isVersionConflict({ status: 400 })).toBe(false);
    expect(isVersionConflict(null)).toBe(false);
    expect(isVersionConflict(new Error())).toBe(false);
  });
});
