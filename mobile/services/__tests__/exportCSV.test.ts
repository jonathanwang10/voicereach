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

it('returns CSV text', async () => {
  (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'Name,Height\nAnn,60\n' }));
  await expect(api.exportCSV()).resolves.toBe('Name,Height\nAnn,60\n');
});

it('goes through authedFetch: bearer token, and one retry after a 401', async () => {
  (global as any).fetch = jest.fn()
    .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"detail":"Invalid or expired session"}' })
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'Name\n' });
  await expect(api.exportCSV()).resolves.toBe('Name\n');
  const calls = ((global as any).fetch as jest.Mock).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][1].headers.Authorization).toBe('Bearer test-token');
});

it('throws an ApiError with the backend detail instead of a bare status', async () => {
  (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => '{"detail":"Export CSV failed"}' }));
  await expect(api.exportCSV()).rejects.toMatchObject({ status: 500, detail: 'Export CSV failed' });
});
