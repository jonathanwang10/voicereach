// Runtime configuration. Values come from mobile/.env (see .env.example);
// Expo inlines EXPO_PUBLIC_* variables at build time.
const DEFAULT_API_BASE_URL = 'http://localhost:8001';

export const API_CONFIG = {
  // On a physical device, set EXPO_PUBLIC_API_BASE_URL to your machine's LAN IP.
  BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL,
  USE_REAL_API: true,
  SUPABASE: {
    URL: process.env.EXPO_PUBLIC_SUPABASE_URL || '',
    ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '',
  },
};

export const getApiUrl = (endpoint: string): string => `${API_CONFIG.BASE_URL}${endpoint}`;
