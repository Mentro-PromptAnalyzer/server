# Mentro Server — Debugging & Ops

## Log Prefixes

Every `console.log/warn/error` call uses a `[module]` prefix. Use these to filter logs quickly.

| Prefix | Source | What it tells you |
|--------|--------|-------------------|
| `[browser]` | `index.js` — Puppeteer pool | Chromium launch, reuse, disconnect events |
| `[fetch-share]` | `/api/fetch-share` handler | Which strategy ran, message count, fallback reason |
| `[extract]` | `extractMessagesFromHtml()` | Which HTML parsing strategy succeeded |
| `[auth]` | `requireAuth` middleware | Token verification failures, missing config |
| `[supabase]` | Supabase client init | Missing env vars at startup |
| `[gemini]` | `adapters/geminiAdapter.js` | Gemini API errors, missing key |
| `[perplexity]` | `adapters/perplexityAdapter.js` | Perplexity API errors, missing key |
| `[local]` | `adapters/localEstimator.js` | tiktoken estimation issues |

## What Breaks Without Each Env Var

| Variable | Missing behaviour |
|----------|------------------|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | `/api/chat/stream` returns `503`. Supabase health check fails. Server still starts. |
| `GROQ_API_KEY` | `/api/chat/stream` returns `503` on first request (key is checked at request time, not startup). |
| `GEMINI_API_KEY` | `/api/count-tokens` with `provider: "gemini"` returns `503`. All other providers unaffected. |
| `PERPLEXITY_API_KEY` | `/api/count-tokens` with `provider: "perplexity"` returns `503`. All other providers unaffected. |
| `CHROMIUM_PATH` | Defaults to `/usr/bin/chromium`. If that path doesn't exist (local dev on macOS/Windows), Puppeteer fails and `/api/fetch-share` falls back — but Strategy 1 (HTTP fetch) still works without Chromium. |
| `PORT` | Defaults to `3001`. |

## Warm Browser Pool Behaviour

- Chromium is launched **once at server startup** (non-blocking — errors are warned, not fatal).
- Subsequent requests reuse `_browser` if `_browser.connected` is true.
- If Chromium crashes or disconnects, the `disconnected` event nulls out `_browser` and the next request relaunches it automatically.
- **Cold start on Fly.io**: the machine auto-stops when idle. On first request after a cold start, Chromium has to relaunch — expect the first `/api/fetch-share` Puppeteer fallback to be slow (~5–10s).
- Strategy 1 (HTTP fetch) does not use the browser and is unaffected by cold starts.

## Rate Limit Behaviour

- In-memory `Map` — **resets on every server restart or Fly.io machine cycle**.
- Window: 60 seconds, max 20 requests per `userId`.
- There is no persistence. If the machine restarts mid-window, counts reset.
- This is intentional for current scale. Don't add Redis without discussion.

## CORS Policy

Allowed origins (enforced in `index.js`):
- Any `http://localhost:<port>` — local dev
- Any `*.vercel.app` — Vercel preview and production deployments
- Any `chrome-extension://<id>` — Chrome extension (popup, content scripts)
- No-origin requests (e.g., server-to-server, curl) — allowed

Everything else gets a CORS error. If adding a custom domain for the frontend, add it to the `cors()` origin handler in `index.js` and document it here.

## Fetch-Share Debugging

When a share URL returns no messages:

1. Check logs for the strategy that ran: `react-router-stream`, `next-data-json`, `regex-extraction`, `text-fallback`, `none`.
2. If Strategy 1 logs `no messages, trying Puppeteer...`, Puppeteer ran — check `[fetch-share] Puppeteer strategy:` line.
3. If Puppeteer also returns 0 messages, the platform's DOM changed. The selectors in `page.evaluate()` need updating.
4. The `html.length` and `has streamController` debug log fires before Puppeteer — use it to confirm what the HTTP fetch actually returned.

Platforms and their primary parse strategies:
- **ChatGPT** — React Router stream data (Strategy A), then `__NEXT_DATA__` (Strategy B), then Puppeteer `[data-message-author-role]`
- **Gemini** — Puppeteer only (Strategy 1 HTML rarely has structured data)
- **Perplexity** — Puppeteer only, waits 5s for Cloudflare to clear

## Fly.io Operations

```bash
# Deploy
fly deploy

# View live logs
fly logs

# SSH into running machine
fly ssh console

# Check machine status
fly status

# Scale memory or CPU (requires fly.toml change + redeploy)
fly scale memory 512
```

App name: `mentro-lucid-dust-3580`, region: `iad`.

The machine auto-stops when idle and auto-starts on the next inbound request. The first request after idle will be slow due to cold start + Chromium relaunch. `min_machines_running = 1` in `fly.toml` keeps at least one machine warm — verify this is still set if cold starts become a problem.

## Local Dev Notes

- Puppeteer needs a local Chromium. Set `CHROMIUM_PATH` to your local install, e.g.:
  - macOS (Homebrew): `/usr/bin/chromium` or wherever `which chromium` points
  - Or just let Strategy 1 handle share URLs — it works without Chromium for most ChatGPT links
- `npm run dev` uses `--watch` (Node.js built-in), which restarts on file changes
- Supabase and Groq keys from `.env` are required for chat streaming to work locally
