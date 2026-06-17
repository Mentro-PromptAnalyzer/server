# Mentro Server — Coding Conventions

## Module System

- **CommonJS only** — `require()`/`module.exports` everywhere. No `import`/`export`.
- `"type": "commonjs"` is set in `package.json`. Do not change this.
- Each file exports its public API at the bottom: `module.exports = { fn1, fn2 };`

## File Structure

```
index.js                  # Main Express app — routes, middleware, startup
providerRegistry.js       # Static provider config (models, endpoints, env key names)
validateTokenRequest.js   # Input validation for /api/count-tokens
adapters/
  geminiAdapter.js        # Gemini token counting (uses node-fetch)
  perplexityAdapter.js    # Perplexity token counting (uses node-fetch)
  localEstimator.js       # tiktoken local estimation (js-tiktoken)
```

New adapters go in `adapters/`. New routes go in `index.js`. Extract validation logic to separate files when it grows beyond a few checks.

## Error Handling

- Adapters throw `Error` with a `statusCode` property when the error maps to an HTTP status (e.g., `err.statusCode = 503` for missing API key).
- Route handlers catch adapter errors and return the appropriate status:
  ```js
  try {
    const result = await countTokensGemini(messages, model);
    return res.json({ tokenCount: result });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message });
  }
  ```
- Always log errors with a `[module-name]` prefix: `console.error('[gemini] ...')`, `console.log('[fetch-share] ...')`.
- Never swallow errors silently. If a catch block can't handle an error, re-throw or log it.

## Async / Timeouts

- All external HTTP calls must have a timeout using `AbortController`:
  ```js
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    ...
  } finally {
    clearTimeout(timeout);
  }
  ```
- Use `AbortSignal.timeout(ms)` for one-shot fetches where you don't need the controller reference (e.g., in `requireAuth`).
- Puppeteer pages should always be closed in a `finally` block to prevent browser resource leaks.

## HTTP / Express Patterns

- Use `return res.status(N).json(...)` — always `return` to prevent double-response errors (Express 5 throws on this).
- Validation failures → `400`. Auth failures → `401`. Rate limit → `429` with `Retry-After` header. Missing config → `503`. Unexpected errors → `500`.
- Middleware order in `index.js`: CORS → `express.json()` → auth middleware → rate limiter → route handler.
- Input size limits: `express.json({ limit: '256kb' })`. Don't increase this without reason.
- CORS allows: any `http://localhost:<port>`, any `*.vercel.app`, and any `chrome-extension://<id>` origin. Add new allowed origins explicitly — never use a wildcard.

## Auth Middleware

- `requireAuth` attaches `req.userId` (Supabase user UUID) on success.
- Routes that need auth use: `router.post('/path', requireAuth, rateLimit, handler)`.
- Do not pass raw JWT tokens or secrets into logs.

## Rate Limiting

- The in-memory `rateLimitStore` (`Map<userId, {count, windowStart}>`) is intentionally simple — single instance, no Redis. Acceptable for current scale.
- If adding a new rate-limited endpoint, reuse the existing `rateLimit` middleware.

## SSE Streaming

- Use `sendSseEvent(res, eventName, payload)` helper for all SSE writes.
- Event names in use: `token`, `error`, `end`.
- Always send `event: end` before closing the response, even on error paths (so the client knows the stream is done).
- Set headers before any writes: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.

## Provider Registry Pattern

When adding a new token-counting provider:
1. Add an entry to `PROVIDERS` in `providerRegistry.js` with `provider`, `model`, `apiKeyEnv`, `endpoint`.
2. Create `adapters/<name>Adapter.js` — export a single async function `countTokens<Name>(messages, model)`.
3. Import and wire it in the `POST /api/count-tokens` handler in `index.js`.
4. Update `validateTokenRequest.js` if validation logic needs to change.

## Share URL Validation

- The `ALLOWED_HOSTNAMES` set and `VALID_PATH_PREFIXES` array in `index.js` are the security boundary for `/api/fetch-share`.
- Always add new platforms to both lists. Never bypass with a wildcard.
- Only `https:` protocol is allowed.

## Puppeteer / Browser Pool

- The warm browser (`_browser`) is a module-level singleton. Access it only via `getWarmBrowser()`.
- Always check `_browser.connected` before reuse — the `disconnected` handler nulls it out automatically.
- Block `image`, `font`, `media`, `stylesheet` resources on all Puppeteer pages to reduce load time.
- Platform-specific wait strategies live inside the route handler, not in a shared utility, because they evolve independently.

## Testing

- Test runner: **Vitest** (`npm run test` → `vitest --run --passWithNoTests`)
- Property-based testing: **fast-check** is installed — use it for input validation and parsing logic.
- Test files: co-locate as `*.test.js` or put in a `tests/` directory.
- Run tests with `npm run test` (single pass, no watch mode).

## Formatting

- **Prettier** — run `npm run format` before committing. Config in `.prettierrc`.
- No ESLint currently. Don't add it without discussion.
- Single quotes, no semicolons (check `.prettierrc` for exact config before assuming).

## Logging Conventions

```js
console.log('[module] brief description of what happened');
console.warn('[module] non-fatal issue');
console.error('[module] error with context:', err.message);
```

Include relevant context (URL, strategy name, count, status code) but never log secrets, tokens, or full user message content.

## Dependencies

- Prefer existing dependencies over adding new ones.
- `node-fetch` v2 is used in adapters (CommonJS compatible). Use it for adapter HTTP calls.
- Native `fetch` is used in `index.js` for auth verification and Groq streaming (Node 18+ built-in). Keep this split consistent.
- `puppeteer-core` is used (not full `puppeteer`) — it does not bundle Chromium. System Chromium is always required.
- Pin new dependencies to exact versions in `package.json`.
