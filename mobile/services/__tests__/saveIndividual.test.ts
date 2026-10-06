jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
      refreshSession: jest.fn(),
    },
  },
  autoLogin: jest.fn(async () => ({})),
}));

import { api } from '../api';

describe('api.saveIndividual', () => {
  afterEach(() => { (global as any).fetch = undefined; });

  it('throws when the backend rejects the save', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"detail":"height: Invalid number format"}',
    }));
    await expect(api.saveIndividual({ name: 'Ann', height: 70, weight: 150 })).rejects.toThrow();
  });

  it('sends the transcription when present', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ individual: { id: 'x' } }) }));
    (global as any).fetch = fetchMock;
    await api.saveIndividual({ name: 'Ann', height: 70, weight: 150, transcription: 'hello' });
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body.transcription).toBe('hello');
    expect(body.data.transcription).toBeUndefined();
  });
});
