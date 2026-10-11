jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
      refreshSession: jest.fn(),
    },
  },
  autoLogin: jest.fn(async () => ({})),
}));

import { api, ApiError } from '../api';

const okResponse = (body: any) => ({ ok: true, status: 200, json: async () => body });
const sentBody = (fetchMock: jest.Mock) => JSON.parse((fetchMock.mock.calls[0] as any)[1].body);

describe('api.saveIndividual', () => {
  afterEach(() => { (global as any).fetch = undefined; });

  it('throws an ApiError carrying the backend detail when the save is rejected', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"detail":"height: Invalid number format"}',
    }));
    const err = await api.saveIndividual({ data: { name: 'Ann', height: 70, weight: 150 } }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.detail).toBe('height: Invalid number format');
  });

  it('sends the explicit request shape: data, merge_with_id, location, transcription at the root', async () => {
    const fetchMock = jest.fn(async () => okResponse({ individual: { id: 'x', name: 'Ann' } }));
    (global as any).fetch = fetchMock;
    const location = { latitude: 37.78, longitude: -122.41, address: '5th & Market' };
    const result = await api.saveIndividual({
      data: { name: 'Ann', height: 70, weight: 150 },
      merge_with_id: '550e8400-e29b-41d4-a716-446655440000',
      location,
      transcription: 'hello',
    });
    expect(sentBody(fetchMock)).toEqual({
      data: { name: 'Ann', height: 70, weight: 150 },
      merge_with_id: '550e8400-e29b-41d4-a716-446655440000',
      location,
      transcription: 'hello',
    });
    expect(result).toEqual({ id: 'x', individual: { id: 'x', name: 'Ann' } });
  });

  it('strips null and empty values from data (C-09)', async () => {
    const fetchMock = jest.fn(async () => okResponse({ individual: { id: 'x' } }));
    (global as any).fetch = fetchMock;
    await api.saveIndividual({
      data: { name: 'Ann', height: 70, weight: 150, gender: null, notes: '', medical_conditions: [], age: 0 },
    });
    expect(sentBody(fetchMock).data).toEqual({ name: 'Ann', height: 70, weight: 150, age: 0 });
  });

  it('never treats a data key as a request field (no destructuring of category keys)', async () => {
    const fetchMock = jest.fn(async () => okResponse({ individual: { id: 'x' } }));
    (global as any).fetch = fetchMock;
    // A custom category could legitimately be called "location" or "id"
    await api.saveIndividual({ data: { name: 'Ann', height: 70, weight: 150, id: 'badge-7', location: 'Shelter' } });
    const body = sentBody(fetchMock);
    expect(body.data).toEqual({ name: 'Ann', height: 70, weight: 150, id: 'badge-7', location: 'Shelter' });
    expect(Object.keys(body).sort()).toEqual(['data']);
  });

  it('omits merge_with_id, location and transcription when they are null', async () => {
    const fetchMock = jest.fn(async () => okResponse({ individual: { id: 'x' } }));
    (global as any).fetch = fetchMock;
    await api.saveIndividual({ data: { name: 'Ann' }, merge_with_id: null, location: null, transcription: null });
    expect(Object.keys(sentBody(fetchMock))).toEqual(['data']);
  });
});

describe('apiRequest headers', () => {
  afterEach(() => { (global as any).fetch = undefined; });

  it('sends the bearer token on apiRequest-backed calls', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ categories: [] }) }));
    (global as any).fetch = fetchMock;
    await api.getCategories();
    const headers = (fetchMock.mock.calls[0] as any)[1].headers;
    expect(headers.Authorization).toBe('Bearer test-token');
  });
});
