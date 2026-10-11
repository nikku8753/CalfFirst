import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowRight, CircleHelp, Eye, EyeOff, Heart, Sprout } from 'lucide-react';
import { authRedirect, setupMessage, supabase } from '../lib/supabase';
import { dashboardPath, useAuth } from './AuthProvider';

type Mode = 'login' | 'register' | 'forgot' | 'update';
export function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="auth-layout"><aside className="auth-aside">
    <Link to="/" className="brand"><span className="brand-mark"><Sprout size={24}/></span>Calf<span>First</span><span className="brand-dot">.</span></Link>
    <div><span className="eyebrow">A BETTER FUTURE STARTS WITH CARE</span><h1>For the animals.<br/>For the farmers.<br/><em>For all of us.</em></h1><p>One connected place for responsible dairy and the people who make it possible.</p><div className="auth-quote"><Heart/><span>Because every calf deserves a better start.</span></div></div><small>CALFFIRST · CARE COMES FIRST</small>
  </aside><main className="auth-main"><Link className="back-link" to="/">← Back to home</Link><div className="auth-form">{children}</div></main></div>;
}

function Field({ name, label, error, ...props }: { name: string; label: string; error?: string; type?: string; placeholder?: string; autoComplete?: string; maxLength?: number }) {
  return <label className="field" htmlFor={name}>{label}<input id={name} name={name} {...props} required aria-invalid={!!error} aria-describedby={error ? `${name}-error` : undefined}/>{error && <small id={`${name}-error`} className="error">{error}</small>}</label>;
}

function errorMessage(error: unknown) {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    invalid_credentials: 'The email or password is incorrect. Please try again.',
    email_not_confirmed: 'Please confirm your email before logging in. Check your inbox and spam folder.',
    user_already_exists: 'An account with this email already exists. Log in or reset your password.',
    email_exists: 'An account with this email already exists. Log in or reset your password.',
    weak_password: 'Choose a stronger password that meets the project password requirements.',
    same_password: 'Choose a password different from your current password.',
    over_email_send_rate_limit: 'Too many emails requested. Please wait before trying again.',
    over_request_rate_limit: 'Too many requests. Please wait before trying again.',
    otp_expired: 'This link has expired or was already used. Request a new password reset email.',
  };
  return (code && messages[code]) || 'The request could not be completed. Check your connection and Supabase configuration, then try again.';
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { session, profile, loading, recovery } = useAuth();
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState(false);
  const inFlight = useRef(false);
  const register = mode === 'register';
  const hasPassword = mode !== 'forgot';
  const labels = { login: ['Welcome back.', 'Your farm, your herd, your next step.', 'Log in'], register: ['Start your journey.', 'Bring better care to your everyday farming.', 'Create account'], forgot: ['Forgot your password?', 'We’ll send you a link to reset it securely.', 'Send reset email'], update: ['Choose a new password.', 'Give your account a fresh, secure start.', 'Update password'] };

  if ((mode === 'login' || register) && !loading && session && profile) return <Navigate to={recovery ? '/update-password' : dashboardPath(profile.role)} replace/>;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current || loading || setupMessage || !supabase) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const name = String(data.get('name') ?? '').trim();
    const role = String(data.get('role') ?? '');
    const next: Record<string, string> = {};
    if (mode !== 'update' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) next.email = 'Enter a valid email address.';
    if (register && (name.length < 2 || name.length > 100)) next.name = 'Use between 2 and 100 characters for your full name.';
    if (hasPassword && (password.length < (mode === 'login' ? 1 : 8) || password.length > 128)) next.password = mode === 'login' ? 'Enter your password (up to 128 characters).' : 'Use between 8 and 128 characters.';
    if ((register || mode === 'update') && password !== data.get('confirm')) next.confirm = 'Passwords do not match.';
    if (register && !['FARMER', 'VETERINARIAN'].includes(role)) next.role = 'Choose Farmer or Veterinarian.';
    setErrors(next); setFailure(''); setMessage('');
    if (Object.keys(next).length) return;
    inFlight.current = true; setBusy(true);
    try {
      if (register) {
        const { data: result, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name, role }, emailRedirectTo: authRedirect('/auth/callback') } });
        if (error) throw error;
        // Confirmation-enabled projects can deliberately obscure duplicate accounts.
        setMessage(result.session ? 'Account created. Opening your workspace…' : 'If this address is eligible for registration, a confirmation email has been sent. Check your inbox, or log in if you already have an account.');
        form.reset();
      } else if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setMessage('Signed in. Loading your workspace…');
        form.reset();
      } else if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: authRedirect('/update-password') });
        if (error) throw error;
        setMessage('If an account exists for this email, a reset link has been sent. Check your inbox and spam folder.');
      } else {
        if (!session) { setFailure('Open a valid reset link from your email before updating your password.'); return; }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        form.reset(); setUpdated(true);
        const { error: logoutError } = await supabase.auth.signOut({ scope: 'local' });
        setMessage(logoutError ? 'Password updated. Your current session remains active; you can continue to your workspace.' : 'Password updated. Log in with your new password.');
      }
    } catch (error) { setFailure(errorMessage(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <AuthLayout><span className="eyebrow">SECURE ACCESS TO CALFFIRST</span><h2>{labels[mode][0]}</h2><p>{labels[mode][1]}</p>
    {setupMessage && <div className="preview-notice" role="status"><CircleHelp size={18}/>{setupMessage}</div>}
    {loading && <p role="status">Restoring your session…</p>}
    {mode === 'update' && !loading && !session && !updated && <div className="preview-notice">Open a valid password reset link from your email. <Link to="/forgot-password">Request a new link</Link></div>}
    {!updated && <form onSubmit={submit} noValidate><fieldset disabled={busy || (mode === 'update' && !session)}>
      {register && <Field name="name" label="Full name" error={errors.name} autoComplete="name" maxLength={100} placeholder="Your full name"/>}
      {mode !== 'update' && <Field name="email" label="Email address" error={errors.email} type="email" autoComplete="email" maxLength={254} placeholder="you@example.com"/>}
      {hasPassword && <div className="password-field"><Field name="password" label={mode === 'update' ? 'New password' : 'Password'} error={errors.password} type={show ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={128} placeholder={mode === 'login' ? 'Enter your password' : 'At least 8 characters'}/><button type="button" className="eye-button" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={() => setShow(!show)}>{show ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div>}
      {(register || mode === 'update') && <Field name="confirm" label="Confirm password" error={errors.confirm} type={show ? 'text' : 'password'} autoComplete="new-password" maxLength={128} placeholder="Re-enter your password"/>}
      {register && <label className="field" htmlFor="role">I am a<select id="role" name="role" defaultValue="FARMER" aria-invalid={!!errors.role}><option value="FARMER">Farmer</option><option value="VETERINARIAN">Veterinarian</option></select>{errors.role && <small className="error">{errors.role}</small>}</label>}
      <button type="submit" className="button submit" disabled={busy || loading || !!setupMessage || (mode === 'update' && !session)}>{busy ? 'Please wait…' : labels[mode][2]}<ArrowRight size={18}/></button>
    </fieldset></form>}
    <div aria-live="polite">{message && <p className="form-status" role="status">{message}</p>}{failure && <p className="error auth-error" role="alert">{failure}</p>}{Object.keys(errors).length > 0 && <p className="error">Please correct the highlighted fields.</p>}</div>
    {mode === 'login' && <><Link className="preview-link" to="/forgot-password">Forgot password?</Link><p className="auth-switch">New to CalfFirst? <Link to="/register">Create an account</Link></p></>}
    {mode !== 'login' && <p className="auth-switch"><Link to="/login">Back to login</Link></p>}
    {session && <Link className="preview-link" to="/account">Open your workspace</Link>}
    <Link className="preview-link" to="/dashboard">Explore the dashboard preview</Link>
  </AuthLayout>;
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <><button className="button secondary" disabled={busy} onClick={async () => {
    if (!supabase || busy) return;
    setBusy(true); setError('');
    try { const { error } = await supabase.auth.signOut({ scope: 'local' }); if (error) throw error; }
    catch { setError('Logout failed. Check your connection and retry.'); }
    finally { setBusy(false); }
  }}>{busy ? 'Logging out…' : 'Log out'}</button>{error && <p className="error" role="alert">{error}</p>}</>;
}

export function AccountGate({ children, role, anyRole = false }: { children?: ReactNode; role?: string; anyRole?: boolean }) {
  const { session, profile, loading, error, reload, recovery } = useAuth();
  if (setupMessage) return <AuthLayout><h2>Connect your workspace.</h2><p className="form-status">{setupMessage}</p><Link to="/dashboard" className="preview-link">Explore the public preview</Link></AuthLayout>;
  if (loading) return <AuthLayout><p role="status">Loading your account…</p></AuthLayout>;
  if (recovery) return <Navigate to="/update-password" replace/>;
  if (!session) return <Navigate to="/login" replace/>;
  if (error || !profile) return <AuthLayout><h2>Profile unavailable.</h2><p className="error auth-error" role="alert">{error || 'Your profile is missing. Please contact your project administrator.'}</p><button className="button" onClick={() => void reload()}>Retry</button><LogoutButton/></AuthLayout>;
  if (!anyRole && (!role || role.toUpperCase() !== profile.role)) return <Navigate to={dashboardPath(profile.role)} replace/>;
  return children;
}

export function AuthCallback() {
  const { session, loading, error } = useAuth();
  // SDK consumes the implicit callback and reports session/recovery via the provider.
  const callbackError = new URLSearchParams(window.location.hash.slice(1)).has('error') || new URLSearchParams(window.location.search).has('error');
  if (loading) return <AuthLayout><p role="status">Confirming your session…</p></AuthLayout>;
  if (session && !callbackError) return <Navigate to="/account" replace/>;
  return <AuthLayout><h2>Check your confirmation link.</h2><p className="error auth-error">{setupMessage || error || 'This confirmation link is invalid, expired, or already used. Try logging in, or register again to request confirmation.'}</p><Link className="preview-link" to="/login">Back to login</Link></AuthLayout>;
}
