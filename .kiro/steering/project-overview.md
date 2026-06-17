# Mentro Server — Project Overview

## What This Is

Backend proxy server for Mentro, a prompt analysis web app. Deployed to Fly.io at `mentro-lucid-dust-3580.fly.dev`. It acts as a trusted intermediary between the Mentro frontend/extension and third-party APIs, handling CORS bypass, auth, and rate limiting.

## Consumers

- **Mentro-PromptAnalyzer/WebApp** — React frontend (connects via `VITE_PROXY_URL` env var)
- **Mentro Chrome Extension** — also hits this server directly

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/fetch-share?url=<encoded>` | None | Fetches AI share links (ChatGPT, Gemini, Perplexity) and extracts user messages |
| `POST` | `/api/chat/stream` | Supabase JWT | Streams Groq LLM replies as SSE |
| `POST` | `/api/count-tokens` | None | Multi-provider token counting |
| `GET` | `/api/health` | None | Basic health check |
| `GET` | `/api/supabase-health` | None | Supabase connectivity check |

## Key Behaviours

### `/api/fetch-share`
- Allowlisted hostnames: `chatgpt.com`, `chat.openai.com`, `gemini.google.com`, `perplexity.ai`, `www.perplexity.ai`
- Valid path prefixes: `/share/`, `/chat/`, `/app/`, `/search/`, `/i/grok/share/`
- **Strategy 1**: Fast HTTP fetch + HTML parsing (React Router stream data, `__NEXT_DATA__` JSON, regex, text fallback)
- **Strategy 2**: Puppeteer + stealth plugin fallback for JS-heavy pages
- Uses a warm browser pool — Chromium is launched once at startup and reused across requests

### `/api/chat/stream`
- Model: `llama-3.1-8b-instant` via Groq API
- SSE events: `event: token`, `event: error`, `event: end`
- Limits: 50 messages max, 32k chars per message, 128k chars total
- Rate limit: 20 requests/min per `userId` (in-memory `Map`, resets per window)
- Auth: Supabase JWT verified via `GET /auth/v1/user`

### `/api/count-tokens`
- Providers: `openai` (tiktoken local, cl100k_base), `gemini` (Gemini API), `perplexity` (Perplexity API, max_tokens: 1 trick)
- Provider config lives in `providerRegistry.js`; request validation in `validateTokenRequest.js`
- Optional providers (Gemini, Perplexity) return `503` if their API key is missing

## Environment Variables

```
SUPABASE_URL=https://anmsstuexchqyghqoipt.supabase.co
SUPABASE_ANON_KEY=<anon key>
GROQ_API_KEY=<groq key>
PORT=3001
GEMINI_API_KEY=        # optional — enables Gemini token counting
PERPLEXITY_API_KEY=    # optional — enables Perplexity token counting
CHROMIUM_PATH=         # optional — defaults to /usr/bin/chromium (Docker)
```

## Tech Stack

- **Runtime**: Node.js 20, CommonJS (`"type": "commonjs"`)
- **Framework**: Express 5
- **Scraping**: `puppeteer-extra` + `puppeteer-extra-plugin-stealth`, system Chromium in Docker
- **LLM**: Groq API (`groq-sdk` or direct fetch)
- **Auth**: Supabase JS client + direct fetch to `/auth/v1/user`
- **Token counting**: `js-tiktoken` (local), Gemini API, Perplexity API
- **Deploy**: Fly.io (`fly.toml`), Docker (`node:20-slim` + system Chromium)
- **Tests**: Vitest + `fast-check` for property-based testing
- **Formatting**: Prettier

## Common Commands

```bash
npm install       # install deps
npm start         # production
npm run dev       # dev with --watch
npm run test      # vitest --run --passWithNoTests
npm run format    # prettier
```

## Infrastructure

- **Fly.io app**: `mentro-lucid-dust-3580`, region `iad`
- **VM**: 1 shared CPU, 1 GB memory
- **Auto-stop**: machines stop when idle, auto-start on request
- **Min machines**: 1 always running
- **Docker base**: `node:20-slim` with system Chromium installed via apt
- `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` — uses system Chromium, not bundled
