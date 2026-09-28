import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  validateShareUrl,
  safeBrowserRequestUrl,
  fetchShareWithSafeRedirects,
} = require('../../shareUrlSafety');

describe('public share request destinations', () => {
  it('accepts supported HTTPS share pages and ordinary public assets', () => {
    expect(validateShareUrl('https://chatgpt.com/share/abc').valid).toBe(true);
    expect(safeBrowserRequestUrl('https://gemini.google.com/share/abc', true)).toBe(true);
    expect(safeBrowserRequestUrl('https://cdn.example.com/app.js', false)).toBe(true);
  });

  it.each([
    'http://chatgpt.com/share/abc',
    'https://127.0.0.1/share/abc',
    'https://[::1]/share/abc',
    'https://metadata.google.internal/share/abc',
    'https://chatgpt.com:8443/share/abc',
    'https://user:pass@chatgpt.com/share/abc',
    'https://unapproved.example/share/abc',
    'https://chatgpt.com/admin',
  ])('rejects an unsafe top-level destination: %s', (url) => {
    expect(validateShareUrl(url).valid).toBe(false);
    expect(safeBrowserRequestUrl(url, true)).toBe(false);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/admin',
    'https://localhost/admin',
    'https://service.internal/admin',
    'file:///etc/passwd',
  ])('blocks private browser subrequests: %s', (url) => {
    expect(safeBrowserRequestUrl(url, false)).toBe(false);
  });

  it('follows only supported share redirects with manual fetches', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { get: () => 'https://chatgpt.com/share/canonical' },
      })
      .mockResolvedValueOnce({ status: 200 });
    const result = await fetchShareWithSafeRedirects(
      'https://chat.openai.com/share/old',
      {},
      fetchImpl
    );
    expect(result).toMatchObject({ blocked: false, response: { status: 200 } });
    expect(fetchImpl.mock.calls.map(([url, options]) => [url, options.redirect])).toEqual([
      ['https://chat.openai.com/share/old', 'manual'],
      ['https://chatgpt.com/share/canonical', 'manual'],
    ]);
  });

  it('does not request a redirected private or unapproved URL', async () => {
    for (const destination of [
      'http://169.254.169.254/latest/meta-data/',
      'https://unapproved.example/share/abc',
      'https://chatgpt.com:8443/share/abc',
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue({
        status: 302,
        headers: { get: () => destination },
      });
      const result = await fetchShareWithSafeRedirects(
        'https://chatgpt.com/share/original',
        {},
        fetchImpl
      );
      expect(result.blocked).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
