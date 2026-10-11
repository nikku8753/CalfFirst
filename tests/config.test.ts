// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const createClient = vi.hoisted(() => vi.fn(() => ({ auth: {} })));
vi.mock('@supabase/supabase-js', () => ({ createClient }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); createClient.mockClear(); });

async function config(url: string, key: string) {
  vi.stubEnv('VITE_SUPABASE_URL', url); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', key);
  return import('../src/lib/supabase');
}
it('does not construct a client for missing configuration', async () => {
  const result = await config('', ''); expect(result.supabase).toBeNull(); expect(result.setupMessage).toMatch(/not configured/); expect(createClient).not.toHaveBeenCalled();
});
it('accepts publishable keys and enables SDK persistence', async () => {
  const result = await config('https://example.supabase.co', 'sb_publishable_valid-test');
  expect(result.setupMessage).toBeNull();
  expect(createClient).toHaveBeenCalledWith('https://example.supabase.co', 'sb_publishable_valid-test', { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
});
it('accepts legacy anon JWTs', async () => {
  const key = `header.${btoa(JSON.stringify({ role: 'anon' }))}.signature`;
  expect((await config('https://example.supabase.co', key)).setupMessage).toBeNull();
});
it.each(['sb_secret_do-not-expose', `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`])('refuses privileged key %s', async key => {
  const result = await config('https://example.supabase.co', key); expect(result.supabase).toBeNull(); expect(createClient).not.toHaveBeenCalled();
});
it('rejects malformed URLs and nonlocal HTTP endpoints', async () => {
  expect((await config('http://example.supabase.co', 'sb_publishable_valid')).supabase).toBeNull();
});
