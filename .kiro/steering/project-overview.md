# Mentro Server — Project Overview

## What This Is

Backend proxy server for Mentro, a prompt analysis web app. Deployed to Fly.io at `mentro-lucid-dust-3580.fly.dev`. It acts as a trusted intermediary between the Mentro frontend/extension and third-party APIs, handling CORS bypass, auth, and rate limiting.

## Consumers

- **Mentro-PromptAnalyzer/WebApp** — React frontend (connects via `VITE_PROXY_URL` env var)
- **Mentro Chrome Extension** — also hits this server directly

## API Endpoints

| Method | Path                                  | Auth         | Description                                                                                                                               |
| ------ | ------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/fetch-share?url=<encoded>`      | None         | Fetches AI share links (ChatGPT, Gemini, Perplexity) and extracts user messages                                                           |
| `POST` | `/api/chat/stream`                    | Supabase JWT | Streams LLM replies as SSE via multi-tier inference chain                                                                                 |
| `POST` | `/api/chat/stream-full`               | Supabase JWT | Same inference chain, but streams the full provider chunk JSON per event and an aggregated final object (content + usage + finish_reason) |
| `POST` | `/api/count-tokens`                   | None         | Multi-provider token counting                                                                                                             |
| `GET`  | `/api/inference-test?provider=<name>` | None         | Dev-only: calls a single provider directly, returns response text and latency. Disabled in production unless `ENABLE_TEST_ENDPOINTS=true` |
| `GET`  | `/api/health`                         | None         | Basic health check (returns `{ ok: true, supabase: bool }`)                                                                               |
| `GET`  | `/api/supabase-health`                | None         | Supabase connectivity check                                                                                                               |
| `GET`  | `/`                                   | None         | Root ping — returns a plain text hello message                                                                                            |

## Key Behaviours

### `/api/fetch-share`

- Allowlisted hostnames: `chatgpt.com`, `chat.openai.com`, `gemini.google.com`, `perplexity.ai`, `www.perplexity.ai`
- Valid path prefixes: `/share/`, `/chat/`, `/app/`, `/search/`, `/i/grok/share/`
- Note: error messages reference Claude and Grok, but neither has an allowlisted hostname yet — only the `/i/grok/share/` path prefix is registered
- **Strategy 1**: Fast HTTP fetch + HTML parsing (React Router stream data, `__NEXT_DATA__` JSON, regex, text fallback)
- **Strategy 2**: Puppeteer + stealth plugin fallback for JS-heavy pages
- Uses a warm browser pool — Chromium is launched once at startup and reused across requests

### `/api/chat/stream`

- Multi-tier inference chain: Groq (`llama-3.3-70b-versatile`) → Cerebras (`gpt-oss-120b`) → Together AI (`meta-llama/Llama-3.3-70B-Instruct-Turbo`)
- Groq is the primary tier because it serves an instruct model that emits final-channel content and follows format/tool instructions. Cerebras runs a gpt-oss reasoning model (Cerebras's public endpoints only offer gpt-oss/Qwen reasoning models, no instruct model), so it can emit reasoning-only output on tool-using prompts and sits second as a fast fallback.
- Each tier activates automatically when the previous returns any non-400/401 error. 400 (bad request) and 401 (our own server auth failure) stop the chain immediately; all other errors (provider auth, rate limits, 5xx) fall through to the next tier.
- Backward compat: if only `GROQ_API_KEY` is set, the chain is just Groq (which is now the primary tier anyway).
- Chain is built dynamically at startup from whichever API keys are present — tiers with no key are skipped entirely.
- SSE events: `event: token`, `event: error`, `event: end`
- Limits: 50 messages max, 32k chars per message, 128k chars total
- Rate limit: 20 requests/min per `userId` (in-memory `Map`, resets per window)
- Auth: Supabase JWT verified via `GET /auth/v1/user`

### `/api/chat/stream-full`

- Same multi-tier inference chain, chain semantics, limits, rate limit, and auth as `/api/chat/stream`. Use this when the consumer needs the whole AI response JSON, not just the reply text.
- Unlike `/api/chat/stream` (which extracts only `choices[0].delta.content` and emits `event: token`), this endpoint forwards the **entire provider chunk object** verbatim on each `event: chunk`.
- SSE events: `event: chunk` (raw OpenAI-compatible chunk), `event: error` (`{ code, message }`), `event: end`.
- The `event: end` payload is an aggregated response object: `{ done, provider, model, role, content, reasoning, finishReason, usage, chunkCount }` — `content` is the fully assembled message text, `reasoning` is the accumulated analysis-channel text, `usage` is the provider's token usage (or `null`), `finishReason` is the stop reason (or `null`).
- Reasoning-model handling: reasoning models (e.g. the `gpt-oss-120b` Cerebras tier) may stream output in the analysis channel (`delta.reasoning`) instead of `delta.content`, especially for larger instruction-heavy prompts. The aggregation accumulates `reasoning` separately and always includes it on `end`. If `content` is empty but `reasoning` is non-empty, `content` falls back to the reasoning text, so clients reading `content` never get a blank reply.
- Requests usage stats by sending `stream_options: { include_usage: true }` to the provider (via the shared `callInferenceStream(..., includeUsage=true)`). Providers that don't support it simply return `usage: null`.

### `/api/count-tokens`

- Providers: `openai` (tiktoken local, cl100k_base, default model: `gpt-4o`), `gemini` (Gemini API, default model: `gemini-2.5-flash`), `perplexity` (Perplexity API, default model: `sonar-pro`, max_tokens: 1 trick)
- Provider config lives in `providerRegistry.js`; request validation in `validateTokenRequest.js`
- Optional providers (Gemini, Perplexity) return `503` if their API key env var is set but missing; if the API call fails at runtime, the endpoint falls back to local tiktoken estimation and returns a `warning` field in the response
- Response shape: `{ inputTokens, estimationType, provider, model, warning? }` — `estimationType` is `"local_estimate"` or `"provider_count"`. Perplexity responses may also include a `cost` field (`{ input_tokens_cost, output_tokens_cost, total_cost }`) when the API returns pricing data.

## Environment Variables

```
SUPABASE_URL=https://anmsstuexchqyghqoipt.supabase.co
SUPABASE_ANON_KEY=<anon key>
GROQ_API_KEY=<groq key>          # Tier 1 — primary inference (llama-3.3-70b-versatile, instruct)
CEREBRAS_API_KEY=<cerebras key>  # Tier 2 fallback (gpt-oss-120b reasoning model, fast)
TOGETHER_API_KEY=<together key>  # Tier 3 fallback (meta-llama/Llama-3.3-70B-Instruct-Turbo, paid)
PORT=3001
GEMINI_API_KEY=        # optional — enables Gemini token counting
PERPLEXITY_API_KEY=    # optional — enables Perplexity token counting
CHROMIUM_PATH=         # optional — defaults to /usr/bin/chromium (Docker)
ENABLE_TEST_ENDPOINTS= # optional — set to "true" to enable /api/inference-test in production
# OCI_GENAI_API_KEY — present in .env but not wired into the inference chain in index.js
```

## Tech Stack

- **Runtime**: Node.js 20, CommonJS (`"type": "commonjs"`)
- **Framework**: Express 5
- **Scraping**: `puppeteer-extra` + `puppeteer-extra-plugin-stealth` + `puppeteer-core`, system Chromium in Docker (`PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`)
- **LLM**: Multi-tier inference chain — Groq → Cerebras → Together AI (direct `fetch` to each provider's OpenAI-compatible endpoint — no SDKs)
- **Auth**: Supabase JS client (`@supabase/supabase-js`) + direct fetch to `/auth/v1/user`
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
- Uses `puppeteer-core` — `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` is set so no bundled Chromium is downloaded; system Chromium is used instead
