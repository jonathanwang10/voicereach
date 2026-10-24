// Runtime configuration. Values come from mobile/.env (see .env.example);
// Expo inlines EXPO_PUBLIC_* variables at build time.
const DEFAULT_API_BASE_URL = 'http://localhost:8001';

// A release build without a backend URL would talk to localhost on the phone and fail
// every call: stop at startup instead (H2-6.4). The default is for development only.
if (!__DEV__ && !process.env.EXPO_PUBLIC_API_BASE_URL) {
  throw new Error('The backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL in mobile/.env, then rebuild the app.');
}

export const API_CONFIG = {
  // On a physical device, set EXPO_PUBLIC_API_BASE_URL to your machine's LAN IP.
  BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL,
  // Optional error reports (H2-8.2); empty means off
  SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN || '',
  SUPABASE: {
    URL: process.env.EXPO_PUBLIC_SUPABASE_URL || '',
    // The new publishable key, else the legacy anon key until legacy keys are disabled (H2-8.3)
    KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '',
  },
};

export const getApiUrl = (endpoint: string): string => `${API_CONFIG.BASE_URL}${endpoint}`;
