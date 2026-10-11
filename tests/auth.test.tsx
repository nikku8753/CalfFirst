// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthPage, AccountGate, AuthCallback, LogoutButton } from '../src/auth/AuthPages';

const mocks = vi.hoisted(() => ({
  state: { session: null, profile: null, loading: false, recovery: false, error: '', reload: vi.fn() } as any,
  config: { setupMessage: null as string | null },
  signUp: vi.fn(), signInWithPassword: vi.fn(), resetPasswordForEmail: vi.fn(), updateUser: vi.fn(), signOut: vi.fn(),
}));
vi.mock('../src/lib/supabase', () => ({
  get setupMessage() { return mocks.config.setupMessage; },
  supabase: { auth: mocks }, authRedirect: (path: string) => `http://localhost:3000${path}`,
}));
vi.mock('../src/auth/AuthProvider', () => ({
  useAuth: () => mocks.state,
  dashboardPath: (role: string) => `/dashboard/${role.toLowerCase()}`,
}));

function page(mode: 'login' | 'register' | 'forgot' | 'update') {
  return render(<MemoryRouter><Routes><Route path="/" element={<AuthPage mode={mode}/>}/><Route path="/dashboard/:role" element={<p>Protected destination</p>}/><Route path="/update-password" element={<p>Recovery destination</p>}/></Routes></MemoryRouter>);
}
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.state, { session: null, profile: null, loading: false, recovery: false, error: '' });
  mocks.config.setupMessage = null;
  mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
  mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  mocks.resetPasswordForEmail.mockResolvedValue({ error: null });
  mocks.updateUser.mockResolvedValue({ error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});
afterEach(cleanup);

describe('authentication forms', () => {
  it.each(['login', 'register', 'forgot'] as const)('keeps %s fields editable but prevents submission without configuration', (mode) => {
    mocks.config.setupMessage = 'Supabase is not configured. Copy .env.example.';
    page(mode);
    expect(screen.getByText(/Supabase is not configured/)).toBeTruthy();
    const values = { 'Email address': 'owner@example.test', ...(mode !== 'forgot' ? { Password: 'safe-password' } : {}), ...(mode === 'register' ? { 'Full name': 'Farm Owner', 'Confirm password': 'safe-password' } : {}) };
    for (const [label, value] of Object.entries(values)) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.matches(':disabled')).toBe(false);
      fill(label, value!);
      expect(input.value).toBe(value);
    }
    if (mode === 'register') {
      const role = screen.getByLabelText('I am a') as HTMLSelectElement;
      expect(role.matches(':disabled')).toBe(false);
      fill('I am a', 'VETERINARIAN'); expect(role.value).toBe('VETERINARIAN');
    }
    if (mode !== 'forgot') {
      fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
      expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('text');
    }
    const button = screen.getByRole('button', { name: mode === 'login' ? 'Log in' : mode === 'register' ? 'Create account' : 'Send reset email' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Enter/programmatic submits must be guarded independently of the button.
    fireEvent.submit(screen.getByLabelText('Email address').closest('form')!);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it.each(['login', 'register'] as const)('keeps %s inputs editable during session restoration but prevents submission', (mode) => {
    mocks.state.loading = true;
    page(mode);
    const email = screen.getByLabelText('Email address') as HTMLInputElement;
    expect(email.matches(':disabled')).toBe(false);
    fill('Email address', 'owner@example.test'); fill('Password', 'safe-password');
    expect(email.value).toBe('owner@example.test');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('safe-password');
    expect((screen.getByRole('button', { name: mode === 'login' ? 'Log in' : 'Create account' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(email.closest('form')!);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled(); expect(mocks.signUp).not.toHaveBeenCalled();
  });
  it('validates all registration fields without sending a request', () => {
    page('register');
    fill('Full name', 'A'); fill('Email address', 'invalid'); fill('Password', 'short'); fill('Confirm password', 'different');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText(/between 2 and 100/)).toBeTruthy();
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Passwords do not match.')).toBeTruthy();
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'Administrator' })).toBeNull();
  });
  it('submits only an ordinary signup role and supports confirmation/duplicate obfuscation', async () => {
    page('register');
    fill('Full name', '  Farm Owner  '); fill('Email address', 'owner@example.test'); fill('Password', 'safe-password'); fill('Confirm password', 'safe-password'); fill('I am a', 'VETERINARIAN');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(mocks.signUp).toHaveBeenCalledWith({ email: 'owner@example.test', password: 'safe-password', options: { data: { full_name: 'Farm Owner', role: 'VETERINARIAN' }, emailRedirectTo: 'http://localhost:3000/auth/callback' } }));
    expect(await screen.findByText(/If this address is eligible/)).toBeTruthy();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });
  it('submits login and shows helpful errors', async () => {
    mocks.signInWithPassword.mockResolvedValue({ error: { code: 'invalid_credentials' } });
    page('login'); fill('Email address', 'farmer@example.test'); fill('Password', 'wrong-password');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText(/email or password is incorrect/)).toBeTruthy();
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: 'farmer@example.test', password: 'wrong-password' });
  });
  it('routes already authenticated users using the database profile', () => {
    mocks.state.session = { user: { id: 'farmer' } };
    mocks.state.profile = { role: 'FARMER' };
    page('login'); expect(screen.getByText('Protected destination')).toBeTruthy();
  });
  it('does not redirect a recovery session away from password update', () => {
    mocks.state.session = { user: { id: 'farmer' } };
    mocks.state.profile = { role: 'FARMER' }; mocks.state.recovery = true;
    page('login'); expect(screen.getByText('Recovery destination')).toBeTruthy();
  });
  it('sends password recovery to the fixed same-origin update route', async () => {
    page('forgot'); fill('Email address', 'owner@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send reset email' }));
    expect(await screen.findByText(/If an account exists/)).toBeTruthy();
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith('owner@example.test', { redirectTo: 'http://localhost:3000/update-password' });
  });
  it('blocks password updates without an authenticated recovery session', () => {
    page('update');
    expect((screen.getByLabelText('New password') as HTMLInputElement).matches(':disabled')).toBe(true);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it('updates a matching password and signs out locally', async () => {
    mocks.state.session = { user: { id: 'farmer' } }; mocks.state.recovery = true;
    page('update'); fill('New password', 'new-password'); fill('Confirm password', 'new-password');
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('Password updated. Log in with your new password.')).toBeTruthy();
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: 'new-password' });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
  it('toggles password visibility and prevents duplicate in-flight login requests', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.signInWithPassword.mockImplementation(() => new Promise(r => { resolve = r; }));
    page('login'); fill('Email address', 'owner@example.test'); fill('Password', 'safe-password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('text');
    const button = screen.getByRole('button', { name: 'Log in' }); fireEvent.click(button); fireEvent.click(button);
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    resolve({ error: null }); await screen.findByText('Signed in. Loading your workspace…');
  });
});

describe('route guards and logout', () => {
  it('redirects anonymous users to login', () => {
    render(<MemoryRouter><Routes><Route path="/" element={<AccountGate role="admin"><p>Private admin</p></AccountGate>}/><Route path="/login" element={<p>Login destination</p>}/></Routes></MemoryRouter>);
    expect(screen.getByText('Login destination')).toBeTruthy(); expect(screen.queryByText('Private admin')).toBeNull();
  });
  it('redirects a farmer away from the admin workspace', () => {
    mocks.state.session = { user: { id: 'farmer' } }; mocks.state.profile = { role: 'FARMER' };
    render(<MemoryRouter><Routes><Route path="/" element={<AccountGate role="admin"><p>Private admin</p></AccountGate>}/><Route path="/dashboard/farmer" element={<p>Farmer destination</p>}/></Routes></MemoryRouter>);
    expect(screen.getByText('Farmer destination')).toBeTruthy(); expect(screen.queryByText('Private admin')).toBeNull();
  });
  it('fails closed on a missing profile and allows retry/logout', () => {
    mocks.state.session = { user: { id: 'farmer' } }; mocks.state.error = 'Profile missing';
    render(<MemoryRouter><AccountGate role="farmer"><p>Private farm</p></AccountGate></MemoryRouter>);
    expect(screen.queryByText('Private farm')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(mocks.state.reload).toHaveBeenCalled();
  });
  it('shows a callback failure when there is no valid session', () => {
    render(<MemoryRouter><AuthCallback/></MemoryRouter>);
    expect(screen.getByText(/invalid, expired, or already used/)).toBeTruthy();
  });
  it('reports logout failure without pretending the session ended', async () => {
    mocks.signOut.mockResolvedValue({ error: { message: 'network' } });
    render(<LogoutButton/>); fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByText(/Logout failed/)).toBeTruthy();
  });
});
