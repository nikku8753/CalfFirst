import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export type Role = 'FARMER' | 'VETERINARIAN' | 'ADMIN';
export type Profile = { id: string; full_name: string; email: string; role: Role };
export const dashboardPath = (role: Role) => `/dashboard/${role.toLowerCase()}`;
type AuthState = {
  session: Session | null; profile: Profile | null; loading: boolean;
  error: string; recovery: boolean; reload: () => Promise<void>;
};
const Context = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(!!supabase);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const version = useRef(0);
  const profileUser = useRef<string | null>(null);
  const load = useCallback(async (next: Session | null) => {
    const request = ++version.current;
    setSession(next); setError('');
    // Auth emits SIGNED_IN on tab focus and TOKEN_REFRESHED periodically.
    // Keep active forms mounted while refreshing the same user's DB profile.
    if (!next || profileUser.current !== next.user.id) { setProfile(null); setLoading(true); profileUser.current = null; }
    if (!next || !supabase) { setLoading(false); return; }
    try {
      const { data, error: profileError } = await supabase.from('profiles')
        .select('id, full_name, email, role').eq('id', next.user.id).single();
      if (request !== version.current) return;
      if (profileError || !data || !['FARMER', 'VETERINARIAN', 'ADMIN'].includes(data.role)) {
        setError('Your account profile could not be loaded. Check that the CalfFirst migration is applied, then retry.');
      } else { profileUser.current = next.user.id; setProfile(data as Profile); }
    } catch {
      if (request === version.current) setError('Unable to reach Supabase. Check your connection and retry.');
    } finally { if (request === version.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let eventReceived = false;
    // Do not await other Supabase calls inside the auth callback (SDK lock).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      eventReceived = true;
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') setRecovery(false);
      queueMicrotask(() => { if (alive) void load(next); });
    });
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!alive || eventReceived) return;
      if (sessionError) { setError('Unable to restore your session. Please log in again.'); setLoading(false); }
      else void load(data.session);
    }).catch(() => {
      if (alive && !eventReceived) { setError('Unable to connect to Supabase. Please retry.'); setLoading(false); }
    });
    return () => { alive = false; version.current++; subscription.unsubscribe(); };
  }, [load]);

  return <Context.Provider value={{ session, profile, loading, error, recovery, reload: async () => {
    if (!supabase) return;
    const { data, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) { setError('Unable to restore your session. Please log in again.'); return; }
    await load(data.session);
  } }}>{children}</Context.Provider>;
}

export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error('useAuth requires AuthProvider');
  return value;
}
