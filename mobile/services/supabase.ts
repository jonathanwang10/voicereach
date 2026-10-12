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
      if (__DEV__) console.error('Auto-login failed:', error.message);
      return { error };
    }
    if (data.session && data.user) {
      return { user: data.user, session: data.session };
    }
    return { error: new Error('No session created') };
  } catch (error) {
    if (__DEV__) console.error('Auto-login error:', error);
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

// True from the worker's Sign Out until their next sign-in (launch, Retry or Sign In).
// While set, the API layer never signs in on its own (getAuthToken, the 401 retry), so a
// request that runs after Sign Out, such as a delayed delete committing, fails instead of
// signing the device back in.
let signedOutByUser = false;

export const isSignedOutByUser = (): boolean => signedOutByUser;

// The worker's own sign-in: clears the signed-out state, then signs in as autoLogin does.
export const signIn = (): Promise<AutoLoginResult> => {
  signedOutByUser = false;
  return autoLogin();
};

// A real sign-out of THIS device (OD-4). Every phone shares the demo account, and
// the default 'global' scope would revoke all of its sessions, signing every other
// phone out too. Returns Supabase's error rather than throwing; on an error the
// device stays signed in.
export const signOut = async (): Promise<{ error: Error | null }> => {
  signedOutByUser = true;
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) signedOutByUser = false;
  return { error };
};
