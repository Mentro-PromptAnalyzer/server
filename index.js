require('dotenv').config();

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { createClient } = require('@supabase/supabase-js');
const { validateTokenRequest } = require('./validateTokenRequest');
const { getProviderConfig } = require('./providerRegistry');
const { countTokensGemini } = require('./adapters/geminiAdapter');
const { countTokensPerplexity } = require('./adapters/perplexityAdapter');
const { estimateTokensFromMessages } = require('./adapters/localEstimator');

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    '[supabase] SUPABASE_URL or SUPABASE_ANON_KEY not set — Supabase features disabled.'
  );
}

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Chromium path: CHROMIUM_PATH env var for local dev or custom installs,
// defaults to system Chromium installed in the Docker image
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

// ---------------------------------------------------------------------------
// Warm browser pool — launch Chromium once, reuse across requests
// ---------------------------------------------------------------------------
let _browser = null;

async function getWarmBrowser() {
  if (_browser && _browser.connected) return _browser;

  console.log('[browser] Launching warm Chromium instance...');
  _browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });

  _browser.on('disconnected', () => {
    console.log('[browser] Chromium disconnected, will relaunch on next request');
    _browser = null;
  });

  console.log('[browser] Chromium warm and ready');
  return _browser;
}

// Pre-launch browser on server start (non-blocking)
getWarmBrowser().catch((err) => {
  console.warn('[browser] Failed to pre-launch Chromium:', err.message);
});

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Inference provider config — four-tier chain:
//
//   Tier 1 (primary):  Cerebras free tier (gpt-oss-120b)
//                      ~30 req/min, 1M tokens/day — free, no credit card.
//                      ~3,000 tok/sec — fastest available inference.
//                      Requires CEREBRAS_API_KEY.
//
//   Tier 2 (fallback): Groq free tier (llama-3.1-8b-instant)
//                      30 req/min, 14,400 req/day — free.
//                      Requires GROQ_API_KEY.
//
//   Tier 3 (fallback): Together AI paid (Llama-3.3-70B-Instruct-Turbo)
//                      Dynamic limits, ~$0.10/1M tokens.
//                      Requires TOGETHER_API_KEY.
//
// Each tier activates automatically when the previous returns any non-400/401
// error. Auth failures (401) and bad requests (400) stop the chain immediately.
//
// Backward compat: if only GROQ_API_KEY is set, tier 1 = Groq, other tiers
// are skipped — existing deployments keep working unchanged.
// ---------------------------------------------------------------------------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'openai/gpt-oss-20b';

const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
const CEREBRAS_MODEL = 'gpt-oss-120b';
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const TOGETHER_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

// Build the provider chain — each entry is { base, key, model, name }.
// Only include a tier if its key is set. Falls back gracefully at runtime.
const INFERENCE_CHAIN = [];

if (process.env.CEREBRAS_API_KEY) {
  INFERENCE_CHAIN.push({
    name: 'Cerebras',
    base: CEREBRAS_BASE_URL,
    key: process.env.CEREBRAS_API_KEY,
    model: CEREBRAS_MODEL,
  });
}

if (GROQ_API_KEY) {
  INFERENCE_CHAIN.push({
    name: 'Groq',
    base: GROQ_BASE_URL,
    key: GROQ_API_KEY,
    model: GROQ_MODEL,
  });
}

if (process.env.TOGETHER_API_KEY) {
  INFERENCE_CHAIN.push({
    name: 'Together AI',
    base: TOGETHER_BASE_URL,
    key: process.env.TOGETHER_API_KEY,
    model: TOGETHER_MODEL,
  });
}

// If none of the above keys are set, log a warning at startup.
if (INFERENCE_CHAIN.length === 0) {
  console.warn('[chat/stream] No inference API keys configured — /api/chat/stream will return 503');
}

const MAX_MESSAGES = 50;
const MAX_CONTENT_LENGTH = 32000;
const MAX_TOTAL_CONTENT = 128000;

app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Auth middleware — verifies Supabase JWT via /auth/v1/user
// Attaches req.userId on success; returns 401 otherwise.
// ---------------------------------------------------------------------------
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  const token = match[1];
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[auth] SUPABASE_URL or SUPABASE_ANON_KEY not configured');
    return res.status(503).json({ error: 'Auth service not configured.' });
  }

  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    const user = await userRes.json();
    if (!user?.id) {
      return res.status(401).json({ error: 'Invalid token payload.' });
    }

    req.userId = user.id;
    next();
  } catch (err) {
    console.error('[auth] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Token verification failed.' });
  }
}

// ---------------------------------------------------------------------------
// Rate limiter — 20 requests per minute per userId (in-memory)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20;
const rateLimitStore = new Map(); // userId → { count, windowStart }

function rateLimit(req, res, next) {
  const userId = req.userId;
  const now = Date.now();
  const entry = rateLimitStore.get(userId);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(userId, { count: 1, windowStart: now });
    return next();
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per minute. Retry in ${retryAfter}s.`,
    });
  }

  entry.count += 1;
  next();
}

function sendSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function validateChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array.' };
  }

  if (messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messages cannot exceed ${MAX_MESSAGES} items.` };
  }

  let totalLength = 0;
  for (const item of messages) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'each message must be an object.' };
    }
    if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') {
      return { ok: false, error: 'message role must be "user", "assistant", or "system".' };
    }
    if (typeof item.content !== 'string' || !item.content.trim()) {
      return { ok: false, error: 'message content must be a non-empty string.' };
    }
    if (item.content.length > MAX_CONTENT_LENGTH) {
      return {
        ok: false,
        error: `message content exceeds ${MAX_CONTENT_LENGTH} characters.`,
      };
    }
    totalLength += item.content.length;
  }

  if (totalLength > MAX_TOTAL_CONTENT) {
    return { ok: false, error: `total message content exceeds ${MAX_TOTAL_CONTENT} characters.` };
  }

  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// Security: allowlist of permitted hostnames and path prefixes
// ---------------------------------------------------------------------------
const ALLOWED_HOSTNAMES = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'www.perplexity.ai',
  'perplexity.ai',
]);

const VALID_PATH_PREFIXES = ['/share/', '/chat/', '/app/', '/search/', '/i/grok/share/'];

function validateShareUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format.' };
  }
  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only HTTPS URLs are allowed.' };
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    return {
      valid: false,
      reason: `Unsupported platform. We support ChatGPT, Claude, Gemini, Grok, and Perplexity.`,
    };
  }
  const hasValidPath = VALID_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
  if (!hasValidPath) {
    return { valid: false, reason: "That doesn't look like a valid share link." };
  }
  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// CORS — allow any localhost port in dev, lock down in production
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
      // Allow Vercel preview and production deployments
      if (origin.endsWith('.vercel.app')) return callback(null, true);
      // Allow Chrome extensions (background service workers may send no origin,
      // but content scripts and popups send chrome-extension://<id>)
      if (origin.startsWith('chrome-extension://')) return callback(null, true);
      // Add your custom domain here if you have one:
      // if (origin === "https://yourdomain.com") return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
  })
);

// ---------------------------------------------------------------------------
// GET /api/fetch-share?url=<encodedUrl>
// Strategy 1: Fast HTTP fetch + HTML parsing (works for most platforms)
// Strategy 2: Puppeteer rendering (fallback for JS-heavy pages)
// ---------------------------------------------------------------------------

/**
 * Extract user messages from raw HTML using regex patterns.
 * Works for pages that embed conversation data in JSON or have readable text.
 */
function extractMessagesFromHtml(html) {
  const userMessages = [];

  // ── Strategy A: React Router streaming data (modern ChatGPT) ────────────
  // ChatGPT embeds conversation data in streamController.enqueue() calls.
  // The serialized format stores user messages as: ,"message text","user",
  // In the raw HTML this appears as: ,\"message text\",\"user\",
  // We scan for this pattern directly rather than trying to parse the full array.
  if (html.includes('streamController') && html.includes('\\"user\\"')) {
    const marker = '\\",\\"user\\"';
    let idx = 0;

    while ((idx = html.indexOf(marker, idx)) !== -1) {
      // Walk backwards to find the opening \" of the message string
      // The message starts after a ,\" or [\" sequence
      let start = idx - 1;
      let depth = 0;
      let found = false;

      while (start > 0 && idx - start < 100000) {
        if (
          html[start] === '"' &&
          start > 0 &&
          html[start - 1] === '\\' &&
          start >= 2 &&
          (html[start - 2] === ',' || html[start - 2] === '[')
        ) {
          start = start + 1; // start after the \"
          found = true;
          break;
        }
        start--;
      }

      if (found) {
        const rawText = html.substring(start, idx);
        const text = rawText
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\u003e/g, '>')
          .replace(/\\u003c/g, '<')
          .replace(/\\u0026/g, '&')
          .trim();

        if (
          text.length > 15 &&
          !text.startsWith('{') &&
          !text.startsWith('http') &&
          !text.includes('statsig') &&
          !text.includes('djb2') &&
          !userMessages.includes(text)
        ) {
          userMessages.push(text);
        }
      }

      idx += marker.length;
    }

    // Also catch messages that use the reference-based format (no adjacent "user" string)
    // These appear as long natural-language strings in the enqueue data
    if (userMessages.length === 0) {
      // Find all strings in the enqueue data that look like user messages
      const enqueueStart = html.indexOf('streamController.enqueue(');
      const enqueueEnd = html.lastIndexOf('streamController.close()');
      if (enqueueStart !== -1 && enqueueEnd !== -1) {
        const enqueueData = html.substring(enqueueStart, enqueueEnd);
        // Match escaped strings of 30+ chars that look like natural language
        const strPattern = /\\"((?:[^\\]|\\[^"]){30,})\\"/g;
        let m;
        while ((m = strPattern.exec(enqueueData)) !== null) {
          const text = m[1]
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .replace(/\\u003e/g, '>')
            .replace(/\\u003c/g, '<')
            .replace(/\\u0026/g, '&')
            .trim();

          // Filter: skip UUIDs, URLs, technical strings, assistant responses (too long)
          if (
            text.length < 5000 &&
            !text.match(/^[0-9a-f]{8}-[0-9a-f]{4}/) &&
            !text.startsWith('http') &&
            !text.startsWith('{') &&
            !text.startsWith('[') &&
            !text.includes('statsig') &&
            !text.includes('experiment') &&
            !text.match(/^routes\//) &&
            !text.match(/^\d/) &&
            !userMessages.includes(text)
          ) {
            userMessages.push(text);
          }
        }

        // If we got candidates, filter to likely user messages (shorter, question-like)
        // vs assistant responses (longer, markdown-heavy)
        if (userMessages.length > 0) {
          const filtered = userMessages.filter(
            (m) => m.length < 2000 && !m.includes('**') && !m.includes('##') && !m.includes('---')
          );
          if (filtered.length > 0) {
            userMessages.length = 0;
            filtered.forEach((m) => userMessages.push(m));
          }
        }
      }
    }

    if (userMessages.length > 0) {
      console.log(`[extract] React Router stream found ${userMessages.length} user messages`);
      return { messages: userMessages, strategy: 'react-router-stream' };
    }
  }

  // ── Strategy B: Parse __NEXT_DATA__ JSON (older ChatGPT) ────────────────
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach(walk);
          return;
        }
        const role = obj?.author?.role || obj?.role;
        if (role === 'user' || role === 'human') {
          let text = '';
          if (obj.content?.parts) {
            text = obj.content.parts
              .filter((p) => typeof p === 'string')
              .join('\n')
              .trim();
          } else if (typeof obj.content === 'string') {
            text = obj.content.trim();
          }
          if (text.length > 0 && !userMessages.includes(text)) userMessages.push(text);
        }
        Object.values(obj).forEach(walk);
      };
      walk(data);
      if (userMessages.length > 0) {
        console.log(`[extract] __NEXT_DATA__ found ${userMessages.length} user messages`);
        return { messages: userMessages, strategy: 'next-data-json' };
      }
    } catch (e) {
      console.log('[extract] __NEXT_DATA__ parse failed:', e.message);
    }
  }

  // ── Strategy C: Regex scan for role/content patterns in script tags ──────
  const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    const content = match[1];
    if (content.includes('"role"') && (content.includes('"user"') || content.includes('"human"'))) {
      const rc = /"role"\s*:\s*"(user|human)"[\s\S]{0,500}?"content"\s*:\s*"((?:[^"\\]|\\.)*)"/gi;
      let m;
      while ((m = rc.exec(content)) !== null) {
        const text = m[2]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .trim();
        if (text.length > 0) userMessages.push(text);
      }
      const cr = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]{0,500}?"role"\s*:\s*"(user|human)"/gi;
      while ((m = cr.exec(content)) !== null) {
        const text = m[1]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .trim();
        if (text.length > 0 && !userMessages.includes(text)) userMessages.push(text);
      }
    }
  }

  if (userMessages.length > 0) {
    return { messages: userMessages, strategy: 'regex-extraction' };
  }

  // ── Strategy D: Strip HTML and return readable text ─────────────────────
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  text = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

  if (text.length > 100) {
    return { messages: null, strategy: 'text-fallback', rawText: text };
  }

  return { messages: null, strategy: 'none' };
}

app.get('/api/fetch-share', async (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url query parameter.' });
  }

  const { valid, reason } = validateShareUrl(url);
  if (!valid) {
    return res.status(400).json({ error: reason });
  }

  // ── Strategy 1: Fast HTTP fetch ──────────────────────────────────────────
  try {
    console.log(`[fetch-share] Trying fast HTTP fetch for: ${url}`);
    const httpResponse = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    if (httpResponse.ok) {
      const html = await httpResponse.text();
      const result = extractMessagesFromHtml(html);

      if (result.messages && result.messages.length > 0) {
        console.log(
          `[fetch-share] Fast fetch success (${result.strategy}): ${result.messages.length} messages`
        );
        const transcript = result.messages.map((m) => `You: ${m}`).join('\n\n');
        return res.json({ html: transcript });
      }

      if (result.rawText) {
        // Only use raw text if it looks like an actual conversation
        // (contains patterns like "You:", "Human:", etc.)
        const conversationPattern = /^(you|user|human|me)\s*:/im;
        if (conversationPattern.test(result.rawText)) {
          console.log(
            `[fetch-share] Fast fetch got conversation text (${result.rawText.length} chars)`
          );
          return res.json({ html: result.rawText });
        }
        console.log(
          '[fetch-share] Fast fetch got raw text but it does not look like a conversation'
        );
      }

      console.log('[fetch-share] Fast fetch got HTML but no messages, trying Puppeteer...');
      console.log(
        `[fetch-share] HTML length: ${html.length}, has streamController: ${html.includes('streamController')}, has user marker: ${html.includes('\\"user\\"')}`
      );
    } else {
      console.log(`[fetch-share] Fast fetch failed with status ${httpResponse.status}`);
    }
  } catch (err) {
    console.log(`[fetch-share] Fast fetch error: ${err.message}`);
  }

  // ── Strategy 2: Puppeteer rendering (fallback) ──────────────────────────
  let page;
  try {
    console.log('[fetch-share] Falling back to Puppeteer...');
    const browser = await getWarmBrowser();
    page = await browser.newPage();
    console.log('[fetch-share] New page created from warm browser');

    // Block images, fonts, and media to speed up load
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Use domcontentloaded instead of networkidle2 for faster loading
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Detect platform from URL to choose wait strategy
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;

    // Platform-specific wait strategies
    if (hostname.includes('gemini.google.com')) {
      // Gemini renders conversation turns in message-content elements
      await page
        .waitForSelector(
          'message-content, .conversation-container, .model-response-text, [class*="query-text"], [class*="response-text"]',
          { timeout: 15000 }
        )
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else if (hostname.includes('perplexity.ai')) {
      // Wait for Cloudflare challenge to resolve, then for content
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await page
        .waitForSelector('[class*="query"], .whitespace-pre-line, [class*="Question"]', {
          timeout: 15000,
        })
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      // ChatGPT or unknown — wait for data attributes
      await page.waitForSelector('[data-message-author-role]', { timeout: 10000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Extract conversation messages directly from the rendered DOM
    const messages = await page.evaluate((host) => {
      const results = [];

      // Known UI boilerplate strings to filter out
      const BOILERPLATE = [
        'get responses tailored to you',
        'log in to get answers based on saved chats',
        'create images and upload files',
        'get smarter responses',
        'upload files and images',
        'chatgpt can make mistakes',
        'check important info',
        'terms of use',
        'privacy policy',
        'sign up',
        'log in',
        'try chatgpt',
        'report content',
        'new chat',
      ];

      function isBoilerplate(text) {
        const lower = text.toLowerCase().trim();
        if (lower.length < 5) return true;
        return BOILERPLATE.some((bp) => lower.includes(bp));
      }

      // ── ChatGPT ──────────────────────────────────────────────────────────
      if (host.includes('chatgpt.com') || host.includes('openai.com')) {
        const messageEls = document.querySelectorAll('[data-message-author-role]');
        if (messageEls.length > 0) {
          messageEls.forEach((el) => {
            const role = el.getAttribute('data-message-author-role');
            if (role === 'user') {
              const text = el.innerText.trim();
              if (text && !isBoilerplate(text)) results.push(text);
            }
          });
          if (results.length > 0) return { messages: results, strategy: 'chatgpt-data-attr' };
        }

        // Fallback: __NEXT_DATA__
        const nextDataEl = document.getElementById('__NEXT_DATA__');
        if (nextDataEl) {
          try {
            const data = JSON.parse(nextDataEl.textContent || '');
            const walk = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              if (obj.role === 'user' && obj.content) {
                const content =
                  typeof obj.content === 'string'
                    ? obj.content
                    : obj.content?.parts?.join(' ') || '';
                if (content.trim() && !isBoilerplate(content)) results.push(content.trim());
              }
              Object.values(obj).forEach(walk);
            };
            walk(data);
            if (results.length > 0) return { messages: results, strategy: 'chatgpt-next-data' };
          } catch {}
        }
      }

      // ── Gemini ───────────────────────────────────────────────────────────
      if (host.includes('gemini.google.com')) {
        // Gemini uses custom elements: user queries are in specific containers
        // Try multiple selectors for Gemini's evolving DOM
        const geminiSelectors = [
          'message-content[class*="user"] .message-text',
          'message-content[class*="user"]',
          '.query-text',
          '.user-query',
          '[class*="query-content"]',
          '[class*="user-message"]',
          'user-query',
          '.conversation-turn.user .text-content',
        ];

        for (const selector of geminiSelectors) {
          const els = document.querySelectorAll(selector);
          if (els.length > 0) {
            els.forEach((el) => {
              const text = el.innerText?.trim();
              if (text && text.length > 0) results.push(text);
            });
            if (results.length > 0) return { messages: results, strategy: `gemini:${selector}` };
          }
        }

        // Gemini fallback: look at all text nodes and find user turns
        // Gemini often alternates user/model in the DOM tree
        const allTurns = document.querySelectorAll('.conversation-turn, [class*="turn"]');
        if (allTurns.length > 0) {
          allTurns.forEach((turn, i) => {
            // Even turns are typically user, odd are model
            if (i % 2 === 0) {
              const text = turn.innerText?.trim();
              if (text && text.length > 0 && text.length < 5000) results.push(text);
            }
          });
          if (results.length > 0) return { messages: results, strategy: 'gemini-turns' };
        }
      }

      // ── Perplexity ───────────────────────────────────────────────────────
      if (host.includes('perplexity.ai')) {
        const perplexitySelectors = [
          '.whitespace-pre-line',
          '[class*="QueryText"]',
          '[class*="query-text"]',
          '[class*="Question"]',
        ];

        for (const selector of perplexitySelectors) {
          const els = document.querySelectorAll(selector);
          if (els.length > 0) {
            els.forEach((el) => {
              const text = el.innerText?.trim();
              if (text && text.length > 0 && text.length < 5000) results.push(text);
            });
            if (results.length > 0)
              return { messages: results, strategy: `perplexity:${selector}` };
          }
        }
      }

      // ── Generic fallback: look for role-based patterns ───────────────────
      const genericSelectors = [
        '[data-role="user"]',
        '[role="user"]',
        '[class*="user-message"]',
        '[class*="human"]',
      ];

      for (const selector of genericSelectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) {
          els.forEach((el) => {
            const text = el.innerText?.trim();
            if (text && text.length > 0 && text.length < 5000) results.push(text);
          });
          if (results.length > 0) return { messages: results, strategy: `generic:${selector}` };
        }
      }

      // ── Universal fallback: scan all elements for conversation patterns ──
      // Look for elements whose attributes contain "user", "human", "query"
      const allEls = document.querySelectorAll('*');
      const userEls = [];
      for (const el of allEls) {
        const attrs = Array.from(el.attributes || []);
        const attrStr = attrs
          .map((a) => `${a.name}=${a.value}`)
          .join(' ')
          .toLowerCase();
        const tag = el.tagName.toLowerCase();

        // Skip tiny or huge elements, scripts, styles
        if (['script', 'style', 'meta', 'link', 'head', 'noscript'].includes(tag)) continue;

        const isUserElement =
          attrStr.includes('user') ||
          attrStr.includes('human') ||
          attrStr.includes('query') ||
          attrStr.includes('question') ||
          attrStr.includes('prompt');

        // Exclude elements that are about "assistant" or "model" or "response"
        const isAssistantElement =
          attrStr.includes('assistant') ||
          attrStr.includes('model') ||
          attrStr.includes('response') ||
          attrStr.includes('answer') ||
          attrStr.includes('bot');

        if (isUserElement && !isAssistantElement) {
          const text = el.innerText?.trim();
          // Only include if it has meaningful text and isn't a container of other matched elements
          if (text && text.length > 1 && text.length < 5000) {
            // Check this isn't a parent of an already-found element
            const isDuplicate = userEls.some(
              (prev) => prev.el.contains(el) || el.contains(prev.el)
            );
            if (!isDuplicate) {
              userEls.push({ el, text, attrStr });
            }
          }
        }
      }

      // Deduplicate: prefer the most specific (deepest) elements
      const deduped = userEls.filter(
        ({ el }) => !userEls.some((other) => other.el !== el && other.el.contains(el))
      );

      if (deduped.length > 0) {
        deduped.forEach(({ text }) => results.push(text));
        return { messages: results, strategy: 'universal-attr-scan' };
      }

      return { messages: results, strategy: 'none' };
    }, hostname);

    console.log(
      `[fetch-share] Puppeteer strategy: ${messages.strategy}, found ${messages.messages?.length || 0} messages`
    );

    if (messages.messages && messages.messages.length > 0) {
      const transcript = messages.messages.map((m) => `You: ${m}`).join('\n\n');
      return res.json({ html: transcript });
    }

    // If no messages found, log what the page looks like for debugging
    const debugInfo = await page.evaluate(() => {
      const body = document.body;
      if (!body) return { text: '', elementCount: 0, sample: '' };
      const text = body.innerText || '';
      const allEls = document.querySelectorAll('*');
      // Collect unique class names that contain interesting keywords
      const interestingClasses = new Set();
      allEls.forEach((el) => {
        const cls = el.className;
        if (typeof cls === 'string' && cls.length > 0) {
          cls.split(/\s+/).forEach((c) => {
            const lower = c.toLowerCase();
            if (
              lower.includes('message') ||
              lower.includes('user') ||
              lower.includes('human') ||
              lower.includes('turn') ||
              lower.includes('query') ||
              lower.includes('chat') ||
              lower.includes('prompt') ||
              lower.includes('conversation')
            ) {
              interestingClasses.add(c);
            }
          });
        }
      });
      return {
        textLength: text.length,
        elementCount: allEls.length,
        textSample: text.substring(0, 500),
        interestingClasses: Array.from(interestingClasses).slice(0, 30),
      };
    });
    console.log('[fetch-share] Debug — page info:', JSON.stringify(debugInfo, null, 2));

    return res.status(502).json({
      error:
        'Could not extract conversation messages. The link may be private, expired, or the page did not load properly.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error.';
    console.error('[fetch-share] Puppeteer error:', message);
    return res.status(502).json({
      error: `Could not load the shared conversation: ${message}`,
    });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/stream
// Streams assistant response as SSE events.
// Tries providers in INFERENCE_CHAIN order: Cerebras → Groq → Together AI → OCI Generative AI.
// Each tier is attempted on 429 (rate limited) or 5xx (server error).
// Auth failures (401/403) surface immediately without retrying.
// ---------------------------------------------------------------------------

/**
 * Attempt a single streaming inference call. Returns the fetch Response on
 * success (2xx), or throws an Error with a `statusCode` property on failure.
 */
async function callInferenceStream(baseUrl, apiKey, model, messages, signal) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!response.ok) {
    let detail = `Inference request failed with status ${response.status}.`;
    try {
      const upstream = await response.json();
      // Log the full error body so we can diagnose key/quota issues
      console.warn(`[inference] ${response.status} error body:`, JSON.stringify(upstream));
      detail = upstream?.error?.message || upstream?.message || detail;
    } catch {}
    const err = new Error(detail);
    err.statusCode = response.status;
    throw err;
  }

  return response;
}

app.post('/api/chat/stream', requireAuth, rateLimit, async (req, res) => {
  console.log('[chat/stream] Received request with', req.body?.messages?.length, 'messages');
  const messages = req.body?.messages;
  const validation = validateChatMessages(messages);

  if (!validation.ok) {
    console.log('[chat/stream] Validation failed:', validation.error);
    return res.status(400).json({ error: validation.error });
  }

  if (INFERENCE_CHAIN.length === 0) {
    console.log('[chat/stream] No inference API key configured');
    return res.status(503).json({
      error: 'No inference API key is configured on the server.',
    });
  }

  console.log(
    `[chat/stream] Starting stream — chain: ${INFERENCE_CHAIN.map((p) => p.name).join(' → ')}`
  );

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  /**
   * Stream tokens from a fetch Response to the SSE client.
   * Returns the number of tokens sent.
   */
  async function streamResponse(inferenceResponse) {
    const reader = inferenceResponse.body?.getReader();
    if (!reader) {
      const err = new Error('No response stream from inference provider.');
      err.statusCode = 502;
      throw err;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let tokenCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';

      for (const eventBlock of events) {
        const lines = eventBlock.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            return tokenCount;
          }
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text.length > 0) {
              tokenCount++;
              sendSseEvent(res, 'token', { text });
            }
          } catch {
            // Ignore malformed chunks and continue streaming.
          }
        }
      }
    }

    return tokenCount;
  }

  try {
    let inferenceResponse;

    // Walk the provider chain until one succeeds or all are exhausted.
    let lastErr = null;
    for (const provider of INFERENCE_CHAIN) {
      try {
        console.log(`[chat/stream] Trying ${provider.name} (${provider.model})...`);
        inferenceResponse = await callInferenceStream(
          provider.base,
          provider.key,
          provider.model,
          messages,
          abortController.signal
        );
        lastErr = null;
        break; // success — stop trying
      } catch (err) {
        const status = err.statusCode;

        console.warn(`[chat/stream] ${provider.name} failed (${status}): ${err.message}`);

        // Only stop the chain for errors where retrying a different provider
        // definitely won't help: our own server's auth (401) and bad request
        // body (400). Everything else — provider auth failures, model not found,
        // rate limits, server errors, unknown codes — falls through to the next
        // provider, since a different provider may succeed where this one failed.
        const isHopeless = status === 400 || status === 401;

        if (isHopeless) {
          const code = status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST';
          sendSseEvent(res, 'error', { code, message: err.message });
          return res.end();
        }

        lastErr = err;
        // Continue to next provider in chain
      }
    }

    if (!inferenceResponse) {
      const message = lastErr?.message || 'All inference providers failed.';
      console.error('[chat/stream] All providers exhausted:', message);
      sendSseEvent(res, 'error', { code: 'UPSTREAM_ERROR', message });
      return res.end();
    }

    const tokenCount = await streamResponse(inferenceResponse);
    console.log('[chat/stream] Stream complete. Sent', tokenCount, 'tokens');
    sendSseEvent(res, 'end', { done: true });
    return res.end();
  } catch (err) {
    if (abortController.signal.aborted) {
      return res.end();
    }
    const message = err instanceof Error ? err.message : 'Unknown streaming error.';
    console.error('[chat/stream] Unexpected error:', message);
    sendSseEvent(res, 'error', { code: 'STREAM_FAILURE', message });
    return res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/count-tokens
// Multi-provider token counting endpoint
// ---------------------------------------------------------------------------
app.post('/api/count-tokens', async (req, res) => {
  const validation = validateTokenRequest(req.body);
  if (!validation.valid) {
    return res.status(validation.status).json({ error: validation.message });
  }

  const { provider, model, messages } = req.body;

  // OpenAI: use server-side js-tiktoken directly
  if (provider === 'openai') {
    const inputTokens = estimateTokensFromMessages(messages);
    return res.json({
      inputTokens,
      estimationType: 'local_estimate',
      provider,
      model,
    });
  }

  // Check API key availability
  const config = getProviderConfig(provider);
  if (config.apiKeyEnv && !process.env[config.apiKeyEnv]) {
    return res.status(503).json({
      error: `${config.apiKeyEnv} is not configured`,
    });
  }

  // Dispatch to provider adapter with fallback
  try {
    let inputTokens;

    if (provider === 'gemini') {
      inputTokens = await countTokensGemini(messages, model);
    } else if (provider === 'perplexity') {
      const result = await countTokensPerplexity(messages, model);
      inputTokens = result.inputTokens;
    }

    return res.json({
      inputTokens,
      estimationType: 'provider_count',
      provider,
      model,
    });
  } catch (err) {
    // Fallback to local estimation
    const inputTokens = estimateTokensFromMessages(messages);
    return res.json({
      inputTokens,
      estimationType: 'local_estimate',
      provider,
      model,
      warning: `${provider} API unavailable: ${err.message}. Fell back to local estimation.`,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/inference-test?provider=<name>
// Dev-only endpoint — calls a single provider from INFERENCE_CHAIN directly,
// bypassing the fallback logic. Returns provider name, model, response text,
// and latency in JSON. Not available in production.
// Gate: process.env.NODE_ENV !== 'production' OR process.env.ENABLE_TEST_ENDPOINTS === 'true'
// ---------------------------------------------------------------------------
const TEST_MESSAGE = [{ role: 'user', content: "Say 'ok' in one word" }];

app.get('/api/inference-test', async (req, res) => {
  const isEnabled =
    process.env.NODE_ENV !== 'production' || process.env.ENABLE_TEST_ENDPOINTS === 'true';

  if (!isEnabled) {
    return res.status(404).json({ error: 'Not found.' });
  }

  const providerName = (req.query.provider || '').trim().toLowerCase();
  if (!providerName) {
    return res.status(400).json({
      error: 'Missing required query param: provider',
      available: INFERENCE_CHAIN.map((p) => p.name.toLowerCase()),
    });
  }

  const provider = INFERENCE_CHAIN.find((p) => p.name.toLowerCase() === providerName);
  if (!provider) {
    return res.status(400).json({
      error: `Unknown provider: "${providerName}"`,
      available: INFERENCE_CHAIN.map((p) => p.name.toLowerCase()),
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const start = Date.now();

  try {
    console.log(`[inference-test] Testing ${provider.name} (${provider.model})...`);
    const inferenceResponse = await callInferenceStream(
      provider.base,
      provider.key,
      provider.model,
      TEST_MESSAGE,
      controller.signal
    );

    // Collect the full streamed response into a single string
    const reader = inferenceResponse.body?.getReader();
    if (!reader) {
      throw Object.assign(new Error('No response stream from provider.'), { statusCode: 502 });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let responseText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';

      for (const eventBlock of events) {
        for (const line of eventBlock.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.delta?.content;
            if (typeof text === 'string') responseText += text;
          } catch {
            // ignore malformed chunks
          }
        }
      }
    }

    const latencyMs = Date.now() - start;
    console.log(`[inference-test] ${provider.name} OK — ${latencyMs}ms — "${responseText.trim()}"`);

    return res.json({
      provider: provider.name,
      model: provider.model,
      response: responseText.trim(),
      latencyMs,
      ok: true,
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    console.warn(`[inference-test] ${provider.name} failed (${err.statusCode}): ${err.message}`);
    return res.status(200).json({
      provider: provider.name,
      model: provider.model,
      error: err.message,
      latencyMs,
      ok: false,
    });
  } finally {
    clearTimeout(timeout);
  }
});

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.send('Hello World from Mentro server 👋');
});

// ---------------------------------------------------------------------------
// Supabase connection check
// ---------------------------------------------------------------------------
app.get('/api/supabase-health', async (_req, res) => {
  if (!supabase) {
    return res.status(503).json({
      ok: false,
      error: 'Supabase client not initialised — check SUPABASE_URL and SUPABASE_ANON_KEY env vars.',
    });
  }

  try {
    const { error } = await supabase.rpc('version');
    if (error && error.code !== 'PGRST202') {
      const { error: err2 } = await supabase.from('nonexistent_table_ping').select('id').limit(1);
      if (
        err2 &&
        err2.code !== 'PGRST116' &&
        err2.code !== '42P01' &&
        !err2.message.includes('does not exist')
      ) {
        return res.status(502).json({ ok: false, error: err2.message });
      }
    }
    return res.json({
      ok: true,
      project: SUPABASE_URL,
      message: 'Connected to Supabase successfully.',
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, supabase: !!supabase });
});

app.listen(PORT, () => {
  console.log(`Mentro proxy server running on http://localhost:${PORT}`);
});
