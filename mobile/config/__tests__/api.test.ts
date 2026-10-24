// Expo's babel plugin rewrites `process.env.EXPO_PUBLIC_X` reads (and deletes) to its
// own env module; a computed key keeps this delete on the process.env api.ts reads
const unset = (name: string) => { delete process.env[name]; };

describe('API_CONFIG', () => {
  const OLD = process.env;
  beforeEach(() => { jest.resetModules(); process.env = { ...OLD }; });
  afterAll(() => { process.env = OLD; });

  it('throws at startup in a release build when EXPO_PUBLIC_API_BASE_URL is unset (H2-6.4)', () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    (global as any).__DEV__ = false;
    try {
      expect(() => require('../api')).toThrow(/EXPO_PUBLIC_API_BASE_URL/);
    } finally {
      (global as any).__DEV__ = true;
    }
  });

  it('a release build with the URL set starts normally', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.org';
    (global as any).__DEV__ = false;
    try {
      expect(require('../api').API_CONFIG.BASE_URL).toBe('https://api.example.org');
    } finally {
      (global as any).__DEV__ = true;
    }
  });

  it('defaults to the local backend in development', () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    const { API_CONFIG } = require('../api');
    expect(API_CONFIG.BASE_URL).toBe('http://localhost:8001');
  });

  it('uses EXPO_PUBLIC_API_BASE_URL when set', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://192.168.1.5:8001';
    const { API_CONFIG } = require('../api');
    expect(API_CONFIG.BASE_URL).toBe('http://192.168.1.5:8001');
  });

  it('reads Supabase settings from env, the publishable key first (H2-8.3)', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    const { API_CONFIG } = require('../api');
    expect(API_CONFIG.SUPABASE).toEqual({ URL: 'https://abc.supabase.co', KEY: 'sb_publishable_x' });
  });

  it('falls back to the legacy anon key', () => {
    unset('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    expect(require('../api').API_CONFIG.SUPABASE.KEY).toBe('anon');
  });

  it('has no key when neither is set', () => {
    unset('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    unset('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    expect(require('../api').API_CONFIG.SUPABASE.KEY).toBe('');
  });
});
