import { createClient } from '@supabase/supabase-js';

// Vite embeds these values in the public bundle. Only public keys belong here.
const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

function isPublicKey(value: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  // Legacy anon JWT keys are still supported by supabase-js v2.
  try {
    const part = value.split('.')[1];
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return value.split('.').length === 3 && payload.role === 'anon';
  } catch { return false; }
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname));
  } catch { return false; }
}

export const setupMessage = !url || !key || /your-project-id|replace_with/.test(url + key)
  ? 'Supabase is not configured. Copy .env.example to .env.local, add your project URL and publishable key, apply the database migration, then restart Vite.'
  : !validUrl(url) || !isPublicKey(key)
    ? 'Invalid Supabase configuration. Use your HTTPS project URL and an sb_publishable_ key (or a legacy anon key). Secret and service-role keys must never be used in this app.'
    : null;

export const supabase = setupMessage ? null : createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
});

// Only fixed, same-origin paths are used; never accept a redirect URL from input.
export function authRedirect(path: '/auth/callback' | '/update-password') {
  return new URL(path, window.location.origin).href;
}
