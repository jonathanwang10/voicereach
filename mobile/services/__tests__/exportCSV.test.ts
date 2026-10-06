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
