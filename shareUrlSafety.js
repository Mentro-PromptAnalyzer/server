const { isIP } = require('node:net');

const ALLOWED_HOSTNAMES = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'www.perplexity.ai',
  'perplexity.ai',
]);
const VALID_PATH_PREFIXES = ['/share/', '/chat/', '/app/', '/search/', '/i/grok/share/'];

function parsePublicHttps(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      parsed.protocol !== 'https:' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !host ||
      isIP(host) ||
      host === 'localhost' ||
      ['.localhost', '.local', '.internal'].some((suffix) => host.endsWith(suffix))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validateShareUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096) {
    return { valid: false, reason: 'Invalid URL format.' };
  }
  const parsed = parsePublicHttps(rawUrl);
  if (!parsed) {
    return { valid: false, reason: 'Only public HTTPS share URLs are allowed.' };
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    return {
      valid: false,
      reason: 'Unsupported platform. We support ChatGPT, Claude, Gemini, Grok, and Perplexity.',
    };
  }
  if (!VALID_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))) {
    return { valid: false, reason: "That doesn't look like a valid share link." };
  }
  return { valid: true, reason: null };
}

function safeBrowserRequestUrl(rawUrl, isNavigation) {
  if (isNavigation) return validateShareUrl(rawUrl).valid;
  return Boolean(parsePublicHttps(rawUrl));
}

async function fetchShareWithSafeRedirects(url, options, fetchImpl = fetch, fixtureOrigin = null) {
  let currentUrl = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(currentUrl, { ...options, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) {
      return { response, blocked: false };
    }
    const location = response.headers.get('location');
    if (!location) return { response: null, blocked: true };
    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      return { response: null, blocked: true };
    }
    if (fixtureOrigin || !validateShareUrl(nextUrl).valid) {
      return { response: null, blocked: true };
    }
    currentUrl = nextUrl;
  }
  return { response: null, blocked: true };
}

module.exports = { validateShareUrl, safeBrowserRequestUrl, fetchShareWithSafeRedirects };
