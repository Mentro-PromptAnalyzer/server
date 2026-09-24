# Mentro server local container pilot

This runbook exercises the actual Node.js API and system Chromium image against disposable, deterministic upstreams. It does not validate live inference providers, real Supabase authentication, or a production reverse proxy. The existing `fly.toml` is not used by this Compose stack.

## Preflight and deadlines

Work from the repository root with Node.js 24, npm, Docker Desktop in Linux-container mode, and Docker Compose. The pilot was planned for a Docker allocation of 16 CPUs and 7.68 GiB. The following acceptance deadlines were chosen before the container run: healthy within 60 seconds of start, graceful stop within 15 seconds, HTTP requests within 60 seconds, and service recovery within 60 seconds. Production inference calls have a 30-second timeout. The local fixture stack shortens that timeout to two seconds so failure tests are deterministic. Share extraction may spend up to 15 seconds on fast fetch and 30 seconds on browser navigation; the fixture timeout test checks the combined path against the 60-second request deadline.

The initial server limit is 1 CPU and 1 GiB RAM, matching the scale of the existing 1 GB/one shared CPU Fly configuration. The fixture has 0.25 CPU and 128 MiB. The API has 256 MiB of writable `/tmp` and a 256 MiB shared-memory mount for Chromium; its root filesystem is read-only. Chromium uses `/tmp` for its home and XDG configuration/cache. The server runs as uid 1000, drops Linux capabilities, enables `no-new-privileges`, and uses an init process to reap children. Docker rotates API logs at 10 MiB × 3 files and fixture logs at 5 MiB × 2 files. No application volume is needed: Stoplight sessions are in memory and disappear on recreation; the optional real Supabase service remains external.

## Commands

PowerShell, from this repository root:

```powershell
$env:MENTRO_REVISION = git rev-parse HEAD
npm ci
npm run format:check
npm run lint
npm run check:syntax
npm test
docker compose up --build --detach --wait --wait-timeout 60
npm run test:container
docker compose ps
docker compose logs --tail=100 mentro-server
docker compose stop mentro-server
docker compose start --wait --wait-timeout 60 mentro-server
```

POSIX shell, from this repository root:

```sh
export MENTRO_REVISION="$(git rev-parse HEAD)"
npm ci
npm run format:check
npm run lint
npm run check:syntax
npm test
docker compose up --build --detach --wait --wait-timeout 60
npm run test:container
docker compose ps
docker compose logs --tail=100 mentro-server
docker compose stop mentro-server
docker compose start --wait --wait-timeout 60 mentro-server
```

The preview is `http://127.0.0.1:3001`; set `MENTRO_PORT` before `docker compose up` to change its loopback host port. Check `GET /api/health` for `{ "ok": true, "browser": true }`. This readiness check launches or verifies Chromium; `supabaseConfigured` reports only whether auth settings exist, not live Supabase connectivity. `GET /api/supabase-health` is a separate external dependency check and is not part of the local fixture gate. Use `docker compose down` to stop the pilot without deleting unrelated resources. Do not add `-v` to routine stop or restart commands.

## Isolated serving contract

The Compose project is `mentro-server-local`. Its API service has DNS name `mentro-server` on `mentro-server-local_pilot` and listens internally on port 3001. The fixture service is `fixture:3004` on that internal network and has no host port. The API also joins `mentro-server-local_preview` so `127.0.0.1:3001` can reach it; the host binding does not expose it to the LAN. Another isolated Compose project can explicitly join the `mentro-server-local_pilot` network to test a real container-to-container call. Do not use this fixture network or token in production.

The local auth fixture accepts `Authorization: Bearer local-fixture-token` along with the API's dummy anon key and returns `{ "id": "fixture-user-1" }` from `/auth/v1/user`. The server's real `requireAuth` middleware still performs that HTTP verification. Invalid and absent tokens return 401. Local token counting returns known values for `hello world`: OpenAI local estimate 2, Gemini fixture 17, and Perplexity fixture 23. The share fixtures use otherwise valid provider URLs: `https://chatgpt.com/share/fast` returns `You: Explain the fixture route`; `https://chatgpt.com/share/browser` uses Chromium and returns `You: Summarize this controlled browser page`; `https://gemini.google.com/share/browser` exercises the Gemini DOM parser. The request URL is validated before test-only mapping to the fixture. Production startup rejects `MENTRO_FIXTURE_ORIGIN`.

POST `{ "messages": [{ "role": "user", "content": "[fixture:tool]" }] }` to `/api/chat/stream-full` with the local bearer token for raw SSE `chunk` events and an `end` event containing `Hello world`, usage, finish reason, and an assembled `search` tool call. `/api/chat/stream` emits token and optional tool-call events plus `end`. The marker `[fixture:text-tool]` streams a fenced `validate_location` tool request split across chunks for a client that parses text tools. `[fixture:fallback]` makes the first inference tier fail so the second succeeds. `[fixture:bad-request]`, `[fixture:exhaust]`, `[fixture:incomplete]`, `[fixture:timeout]`, and `[fixture:disconnect]` exercise bounded failures and cancellation. These marker responses exist only in the internal fixture service.

The API's production defaults still target the existing provider URLs and Supabase settings. The Compose file supplies only dummy keys and a validated fixture origin, with no production secrets. The browser fixture aborts requests outside the fixture origin and the fast-fetch fixture path rejects redirects. The local stack tests provider behavior through controlled HTTP endpoints; it does not prove live-provider availability or production proxy behavior.

## CI and release boundary

`.github/workflows/validate.yml` runs the same format, lint, syntax, unit, image, and container checks on PRs and main. Its job name is `quality-and-container`; the workflow grants `contents: read`, persists no checkout credential, and passes no production secrets to PR code. The existing Supabase keepalive workflow is separate from this pilot. Remote required-check enforcement and production deployment are not established by this YAML alone.

For a future production release, select a host, registry, proxy owner, credentials, health/recovery procedure, and immutable image digest. Verify the actual merged main commit and required checks before publishing or deploying it. Serialize deployment and prevent an older release from replacing a newer one. This pilot does not publish images, deploy to Fly or a new host, change DNS, or migrate data.
