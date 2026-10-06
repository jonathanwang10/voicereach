describe('API_CONFIG', () => {
  const OLD = process.env;
  beforeEach(() => { jest.resetModules(); process.env = { ...OLD }; });
  afterAll(() => { process.env = OLD; });

  it('defaults to the local backend', () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    const { API_CONFIG } = require('../api');
    expect(API_CONFIG.BASE_URL).toBe('http://localhost:8001');
  });

  it('uses EXPO_PUBLIC_API_BASE_URL when set', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://192.168.1.5:8001';
    const { API_CONFIG } = require('../api');
    expect(API_CONFIG.BASE_URL).toBe('http://192.168.1.5:8001');
  });

  it('reads Supabase settings from env', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    const { API_CONFIG } = require('../api');
    expect(API_CONFIG.SUPABASE).toEqual({ URL: 'https://abc.supabase.co', ANON_KEY: 'anon' });
  });
});
