import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_CONFIG } from '../config/api';

// Demo credentials (hardcoded for hackathon)
const DEMO_EMAIL = 'demo@sfgov.org';
const DEMO_PASSWORD = 'demo123456';

if (!API_CONFIG.SUPABASE.URL || !API_CONFIG.SUPABASE.ANON_KEY) {
  throw new Error(
    'Supabase is not configured. Copy mobile/.env.example to mobile/.env and set ' +
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, then restart Expo.'
  );
}

// Create Supabase client with configuration from API config
export const supabase = createClient(
  API_CONFIG.SUPABASE.URL,
  API_CONFIG.SUPABASE.ANON_KEY,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
    },
  }
);

// Auto-login function
export const autoLogin = async () => {
  try {
    // First check if already logged in
    const { data: { session } } = await supabase.auth.getSession();
    
    if (session) {
      return { user: session.user, session };
    }
    
    // Auto sign in with demo credentials
    console.log('Attempting auto-login with demo credentials...');
    const { data, error } = await supabase.auth.signInWithPassword({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    });
    
    if (error) {
      console.error('Auto-login failed:', error.message);
      return { error };
    }
    
    if (data.session) {
      return { user: data.user, session: data.session };
    }
    
    return { error: new Error('No session created') };
  } catch (error) {
    console.error('Auto-login error:', error);
    return { error };
  }
};

// Get current user
export const getCurrentUser = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
};

// Sign out
export const signOut = async () => {
  const { error } = await supabase.auth.signOut();
  return { error };
};
