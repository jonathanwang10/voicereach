import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, autoLogin, signIn as signInAsWorker, signOut } from '../services/supabase';
import { errorMessage } from '../utils/errors';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  // True until the launch sign-in (or a retry) settles (C-35)
  loading: boolean;
  // Why the last sign-in failed; null when signed in or signed out on purpose
  error: string | null;
  // Sign in again (the "Retry" / "Sign In" button when there is no user)
  retry: () => Promise<void>;
  // A real sign-out (OD-4). Throws when Supabase reports an error.
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True from the worker's Sign Out until the next sign-in. Only then does a
  // SIGNED_OUT event mean "show the Signed out screen".
  const signedOutByUser = useRef(false);

  // Signs in with the demo account (or keeps the stored session). `loading` stays
  // true until this settles, so no screen mounts and starts its own sign-in.
  const signIn = async () => {
    signedOutByUser.current = false;
    setLoading(true);
    setError(null);
    const result = await signInAsWorker(); // clears a user sign-out, so the API may sign in again
    if (result.user && result.session) {
      setUser(result.user);
      setSession(result.session);
    } else {
      setUser(null);
      setSession(null);
      setError(errorMessage(result.error));
    }
    setLoading(false);
  };

  useEffect(() => {
    signIn();

    // INITIAL_SESSION is ignored: with no stored session it arrives (null) while the
    // sign-in above is still running, and must not end `loading` early.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (next) {
          setSession(prev => (prev?.access_token === next.access_token ? prev : next));
          setUser(next.user);
        }
      } else if (event === 'SIGNED_OUT') {
        if (signedOutByUser.current) {
          setSession(null);
          setUser(null);
        } else {
          // Not the worker's doing (a failed refresh, a revoked session). Keep the
          // screens mounted, so no review or edit is lost, and sign in again quietly
          // (C-37). If that fails, the next request reports it.
          quietSignIn();
        }
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Signs in again without the loading screen, so nothing unmounts
  const quietSignIn = async () => {
    const result = await autoLogin();
    if (result.user && result.session && !signedOutByUser.current) {
      setUser(result.user);
      setSession(result.session);
    }
  };

  const handleSignOut = async () => {
    signedOutByUser.current = true;
    const { error: signOutError } = await signOut();
    if (signOutError) {
      signedOutByUser.current = false;
      throw signOutError;
    }
    setUser(null);
    setSession(null);
    setError(null);
  };

  const value = {
    user,
    session,
    loading,
    error,
    retry: signIn,
    signOut: handleSignOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
