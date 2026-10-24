// R-1 / C-10 / C-41 / C-32: every data read and write goes through a backend route;
// the Supabase client is used for auth only, so its table API (`from`) is never called.
const mockFrom = jest.fn<any, any[]>(() => {
  throw new Error('Direct table access must not be used: go through the backend');
});
jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } }, error: null }),
    },
    from: (...a: any[]) => mockFrom(...a),
  },
  autoLogin: async () => ({}),
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import { api, ApiError } from '../api';

const jsonResponse = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const fetchMock = () => (global as any).fetch as jest.Mock;
const lastCall = () => {
  const [url, init] = fetchMock().mock.calls[fetchMock().mock.calls.length - 1];
  return { url: new URL(url), method: (init?.method || 'GET').toUpperCase(), body: init?.body };
};

const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  expect(mockFrom).not.toHaveBeenCalled();
  (global as any).fetch = undefined;
});

describe('searchIndividuals', () => {
  const listBody = (individuals: any[]) => ({ individuals, total: individuals.length, offset: 0, limit: 100 });

  it('the default list is GET /api/individuals?limit=50, then the next page by cursor (H2-6.10)', async () => {
    (global as any).fetch = jest.fn(async () =>
      jsonResponse(200, { individuals: [], total: 0, next_cursor: '2026-01-02T00:00:00+00:00,abc' }));
    const page = await api.listIndividuals(null);
    const { url, method } = lastCall();
    expect(method).toBe('GET');
    expect(url.pathname).toBe('/api/individuals');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('search')).toBe(false);
    expect(page).toEqual({ items: [], nextCursor: '2026-01-02T00:00:00+00:00,abc', total: 0 });
    await api.listIndividuals(page.nextCursor);
    expect(lastCall().url.searchParams.get('cursor')).toBe('2026-01-02T00:00:00+00:00,abc');
  });

  it('sends free text URL-encoded, with no PostgREST filter grammar (C-41)', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(200, listBody([])));
    await api.searchIndividuals('Smith, John (50%_)');
    expect(lastCall().url.searchParams.get('search')).toBe('Smith, John (50%_)');
  });

  it("maps the backend's last_seen, scores and address; no mock address (C-32)", async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(200, listBody([{
      id: 'a1', name: 'Ann Lee', urgency_score: 20, urgency_override: 80, display_score: 80,
      last_seen: iso(3 * HOUR), last_location: { latitude: 1, longitude: 2, address: 'Mission St & 16th' },
    }, {
      id: 'b2', name: 'Bob', urgency_score: 30, urgency_override: null, display_score: 30,
      last_seen: iso(50 * HOUR), last_location: null,
    }])));
    const [ann, bob] = await api.searchIndividuals('');
    expect(ann).toMatchObject({
      id: 'a1', name: 'Ann Lee', urgency_score: 20, urgency_override: 80, display_score: 80,
      last_seen_days: 0, abbreviated_address: 'Mission St & 16th',
    });
    expect(ann.last_seen).toBe(ann.last_interaction_date);
    expect(bob.last_seen_days).toBe(2);
    expect(bob.abbreviated_address).toBeUndefined();
  });

  it('throws ApiError when the backend fails', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(500, { detail: 'Search individuals failed' }));
    await expect(api.searchIndividuals('')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('semanticSearchIndividuals', () => {
  it("uses the backend's last_seen and address, not 'now' and a mock address (C-32)", async () => {
    const seen = iso(30 * HOUR);
    (global as any).fetch = jest.fn(async () => jsonResponse(200, { results: [{
      id: 'a1', name: 'Ann', urgency_score: 10, urgency_override: null, display_score: 10,
      last_seen: seen, abbreviated_address: null, search_type: 'semantic', similarity_score: 0.4,
    }] }));
    const [hit] = await api.semanticSearchIndividuals('vet');
    expect(lastCall()).toMatchObject({ method: 'POST' });
    expect(lastCall().url.pathname).toBe('/api/embeddings/search');
    expect(hit).toMatchObject({ last_seen: seen, last_interaction_date: seen, last_seen_days: 1, display_score: 10 });
    expect(hit.abbreviated_address).toBeUndefined();
  });
});

describe('updateUrgencyOverride (C-10)', () => {
  it('PUTs the override to the backend and returns its scores', async () => {
    const scores = { urgency_score: 20, urgency_override: 75, display_score: 75 };
    (global as any).fetch = jest.fn(async () => jsonResponse(200, scores));
    await expect(api.updateUrgencyOverride('p1', 75)).resolves.toEqual(scores);
    const { url, method, body } = lastCall();
    expect(method).toBe('PUT');
    expect(url.pathname).toBe('/api/individuals/p1/urgency-override');
    expect(JSON.parse(body)).toEqual({ urgency_override: 75 });
  });

  it('sends null to clear the override', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(200, { urgency_score: 20, urgency_override: null, display_score: 20 }));
    await api.updateUrgencyOverride('p1', null);
    expect(JSON.parse(lastCall().body)).toEqual({ urgency_override: null });
  });

  it('throws ApiError on failure instead of returning false', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(422, { detail: [{ msg: 'Input should be less than or equal to 100' }] }));
    await expect(api.updateUrgencyOverride('p1', 101)).rejects.toMatchObject({ status: 422 });
  });
});

describe('deleteIndividual (C-10, C-45)', () => {
  it('calls DELETE /api/individuals/{id}', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(200, { id: 'p1', deleted: true }));
    await expect(api.deleteIndividual('p1')).resolves.toBeUndefined();
    const { url, method } = lastCall();
    expect(method).toBe('DELETE');
    expect(url.pathname).toBe('/api/individuals/p1');
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('treats 404 as already deleted', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(404, { detail: 'Individual not found: p1' }));
    await expect(api.deleteIndividual('p1')).resolves.toBeUndefined();
  });

  it('throws ApiError on any other failure (no silent false)', async () => {
    (global as any).fetch = jest.fn(async () => jsonResponse(500, { detail: 'Delete individual failed' }));
    await expect(api.deleteIndividual('p1')).rejects.toMatchObject({ status: 500, detail: 'Delete individual failed' });
  });
});

describe('getIndividualProfile', () => {
  const individual = {
    id: 'p1', name: 'Ann', urgency_score: 10, urgency_override: null, display_score: 10, data: {},
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', last_location: null,
  };

  it("last_seen is the latest interaction, like the list's (not updated_at)", async () => {
    (global as any).fetch = jest.fn(async (u: string) => jsonResponse(200, u.endsWith('/interactions')
      ? { interactions: [
          { id: 'i1', created_at: '2026-03-01T00:00:00Z', changes: {} },
          { id: 'i2', created_at: '2026-05-01T00:00:00Z', changes: {} },
        ] }
      : { individual, recent_interactions: [] }));
    const profile = await api.getIndividualProfile('p1');
    expect(profile.last_seen).toBe('2026-05-01T00:00:00Z');
  });

  it('carries the version the merge sends back, 1 when absent (H2-2.3)', async () => {
    const respond = (ind: any) => jest.fn(async (u: string) => jsonResponse(200, u.endsWith('/interactions')
      ? { interactions: [] } : { individual: ind, recent_interactions: [] }));
    (global as any).fetch = respond({ ...individual, version: 4 });
    expect((await api.getIndividualProfile('p1')).version).toBe(4);
    (global as any).fetch = respond(individual);
    expect((await api.getIndividualProfile('p1')).version).toBe(1);
  });

  it('falls back to created_at when there are no interactions', async () => {
    (global as any).fetch = jest.fn(async (u: string) => jsonResponse(200, u.endsWith('/interactions')
      ? { interactions: [] }
      : { individual, recent_interactions: [] }));
    const profile = await api.getIndividualProfile('p1');
    expect(profile.last_seen).toBe('2026-01-01T00:00:00Z');
  });
});
