import { createClient, Session, User } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_CONFIG } from '../config/api';

// The app uses Supabase for sign-in only; all data goes through the backend (R-1).

// Demo credentials (hardcoded for hackathon)
const DEMO_EMAIL = 'demo@sfgov.org';
const DEMO_PASSWORD = 'demo123456';

if (!API_CONFIG.SUPABASE.URL || !API_CONFIG.SUPABASE.ANON_KEY) {
  throw new Error(
    'Supabase is not configured. Copy mobile/.env.example to mobile/.env and set ' +
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, then restart Expo.'
  );
}

export const supabase = createClient(
  API_CONFIG.SUPABASE.URL,
  API_CONFIG.SUPABASE.ANON_KEY,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // not a browser: there is no URL to read a session from
    },
  }
);

export type AutoLoginResult =
  | { user: User; session: Session; error?: undefined }
  | { error: unknown; user?: undefined; session?: undefined };

const signInWithDemoAccount = async (): Promise<AutoLoginResult> => {
  try {
    // Keep a stored session if there is one
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      return { user: session.user, session };
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    });
    if (error) {
      console.error('Auto-login failed:', error.message);
      return { error };
    }
    if (data.session && data.user) {
      return { user: data.user, session: data.session };
    }
    return { error: new Error('No session created') };
  } catch (error) {
    console.error('Auto-login error:', error);
    return { error };
  }
};

// One sign-in at a time (C-35): AuthContext at launch and getAuthToken after a 401
// share the same in-flight attempt instead of racing several signInWithPassword
// calls. Once it settles the next call tries again, so a failure is not cached.
let inFlight: Promise<AutoLoginResult> | null = null;

export const autoLogin = (): Promise<AutoLoginResult> => {
  if (!inFlight) {
    inFlight = signInWithDemoAccount().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

// A real sign-out (OD-4). Returns Supabase's error rather than throwing.
export const signOut = async (): Promise<{ error: Error | null }> => {
  const { error } = await supabase.auth.signOut();
  return { error };
};
