import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Pagination, StatusBadge, Empty, ErrorBox } from '../components/ui';
import { pct, num, interval, humanize, duration } from '../lib/format';
import { api, ApiError } from '../lib/api';

describe('format helpers', () => {
  it('formats numbers, percentages and intervals', () => {
    expect(num(null)).toBe('—');
    expect(pct(0.877, 1)).toMatch(/87\.7/);
    expect(interval({ low: 0.7, high: 0.9 })).toMatch(/70/);
    expect(humanize('LOCKED_TEST')).toMatch(/locked test/i);
    expect(duration(1500)).toBeTruthy();
  });
});

describe('ui components', () => {
  it('paginates without fake pages', () => {
    const onChange = vi.fn();
    render(<Pagination total={120} limit={50} offset={0} onChange={onChange} />);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onChange).toHaveBeenCalledWith(50);
  });
  it('shows only a total when one page is enough', () => {
    render(<Pagination total={10} limit={50} offset={0} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });
  it('renders monochrome status and empty states', () => {
    render(<><StatusBadge status="SIGNED_OFF" /><Empty title="Nothing here">Add a source.</Empty></>);
    expect(screen.getByText(/signed off/i)).toBeInTheDocument();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });
  it('renders API error messages', () => {
    render(<ErrorBox error={new ApiError(400, { code: 'GATE', message: 'Gate is blocked' })} />);
    expect(screen.getByText('Gate is blocked')).toBeInTheDocument();
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends the CSRF token on mutations and parses errors', async () => {
    document.cookie = 'aq_csrf=token-123';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'No' } }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.post('/sources', { name: 'x' })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/sources');
    expect((init as RequestInit).headers).toMatchObject({ 'x-csrf-token': 'token-123', 'content-type': 'application/json' });
    expect((init as RequestInit).credentials).toBe('same-origin');
  });
  it('does not send a CSRF header on GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.get('/sources');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('x-csrf-token');
  });
});
