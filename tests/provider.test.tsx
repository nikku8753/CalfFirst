// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), onAuthStateChange: vi.fn(), from: vi.fn(), single: vi.fn(), unsubscribe: vi.fn(), callback: null as any }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: mocks, from: mocks.from } }));

function Probe() {
  const state = useAuth();
  return <div>{state.loading ? 'Loading' : state.error || state.profile?.role || 'Signed out'}{state.recovery && <span>Recovery session</span>}</div>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1', user_metadata: { role: 'ADMIN' } } } }, error: null });
  mocks.single.mockResolvedValue({ data: { id: 'user-1', full_name: 'Farmer', email: 'farmer@example.test', role: 'FARMER' }, error: null });
  mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ single: mocks.single }) }) });
  mocks.onAuthStateChange.mockImplementation((cb) => { mocks.callback = cb; return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }; });
});
afterEach(cleanup);

it('restores persisted sessions and reads the DB role instead of user metadata', async () => {
  render(<AuthProvider><Probe/></AuthProvider>);
  expect(await screen.findByText('FARMER')).toBeTruthy();
  expect(mocks.getSession).toHaveBeenCalled(); expect(mocks.from).toHaveBeenCalledWith('profiles');
});
it('clears profile and recovery state on sign out', async () => {
  render(<AuthProvider><Probe/></AuthProvider>); await screen.findByText('FARMER');
  await act(async () => { mocks.callback('PASSWORD_RECOVERY', { user: { id: 'user-1' } }); });
  expect(await screen.findByText('Recovery session')).toBeTruthy();
  await act(async () => { mocks.callback('SIGNED_OUT', null); });
  expect(await screen.findByText('Signed out')).toBeTruthy(); expect(screen.queryByText('Recovery session')).toBeNull();
});
it('discards a stale profile response after logout', async () => {
  let resolve: any;
  mocks.single.mockImplementation(() => new Promise(r => { resolve = r; }));
  render(<AuthProvider><Probe/></AuthProvider>);
  await waitFor(() => expect(mocks.single).toHaveBeenCalled());
  await act(async () => { mocks.callback('SIGNED_OUT', null); });
  await act(async () => { resolve({ data: { role: 'ADMIN' }, error: null }); });
  expect(screen.getByText('Signed out')).toBeTruthy(); expect(screen.queryByText('ADMIN')).toBeNull();
});
it('fails closed on an unavailable profile', async () => {
  mocks.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
  render(<AuthProvider><Probe/></AuthProvider>);
  expect(await screen.findByText(/profile could not be loaded/)).toBeTruthy();
});
it('keeps active forms mounted during a same-user token refresh', async () => {
  render(<AuthProvider><Probe/></AuthProvider>); await screen.findByText('FARMER');
  let resolve: any; mocks.single.mockImplementation(() => new Promise(r => { resolve = r; }));
  await act(async () => { mocks.callback('TOKEN_REFRESHED', { user: { id: 'user-1' } }); });
  expect(screen.getByText('FARMER')).toBeTruthy(); expect(screen.queryByText('Loading')).toBeNull();
  await act(async () => { resolve({ data: { id: 'user-1', role: 'FARMER' }, error: null }); });
});
