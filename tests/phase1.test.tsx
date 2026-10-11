// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
vi.mock('../src/auth/AuthProvider', () => ({ useAuth: () => ({ profile: null, session: null, loading: false, error: '', recovery: false }), dashboardPath: (role: string) => `/dashboard/${role.toLowerCase()}` }));
afterEach(cleanup);
beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
it('preserves the original landing headline and section navigation', () => {
  render(<MemoryRouter><App/></MemoryRouter>);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Good dairy begins');
  for (const id of ['platform','welfare','traceability']) expect(document.getElementById(id)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
  expect(screen.getByRole('button', { name: 'Toggle navigation' }).getAttribute('aria-expanded')).toBe('true');
});
it('keeps the public demo separate from real farmer records and preserves its search', () => {
  render(<MemoryRouter initialEntries={['/dashboard']}><App/></MemoryRouter>);
  expect(screen.getByText('DEMO PREVIEW')).toBeTruthy(); expect(screen.getByText(/statistics and records are sample data/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search animals'), { target: { value: 'Clover' } });
  expect(screen.getByText('Clover')).toBeTruthy(); expect(screen.queryByText('Daisy')).toBeNull();
});
