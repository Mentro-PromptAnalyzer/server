# Mentro API production readiness

`compose.prod.yaml` is a deployment template, separate from the fixture-only
`compose.yaml`. It publishes the API on host loopback for a future HTTPS proxy,
keeps the Chromium runtime nonroot with a read-only filesystem and bounded
resources, and rotates container logs. Build from a checked, merged `main` SHA;
do not use the fixture image or `NODE_ENV=test` in production. The image embeds
only its commit label, not runtime credentials.

The draft binding is `127.0.0.1:3001` on the host, routed in the future by
`api.mentro.elischiffler.dev`. Use `docker compose -f compose.prod.yaml` so the
local fixture file is never merged into a production command. The host operator
owns the Caddy route, TLS, firewall, and image release. This file does not
deploy or configure them.

Place `.env.production` on the host with restrictive permissions. It is
gitignored and must contain `SUPABASE_URL` and `SUPABASE_ANON_KEY` for the
approved Mentro Auth project and at least one approved inference key among
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, and `TOGETHER_API_KEY`. Optional token
counting providers use `GEMINI_API_KEY` and `PERPLEXITY_API_KEY`.
`CORS_ORIGINS` may add exact preview origins; the custom production origin is
always allowed. Do not set `MENTRO_FIXTURE_ORIGIN` or `ENABLE_TEST_ENDPOINTS`.
Check provider quotas and egress policy before sending live requests.

The production environment name inventory is:

| Name                                                   | Purpose                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`                    | Required Auth client connection; neither proves that the history table or RLS is ready. |
| `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `TOGETHER_API_KEY` | Inference providers; configure at least one approved provider.                          |
| `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`                 | Optional provider token counting.                                                       |
| `CORS_ORIGINS`                                         | Optional additional exact browser origins; avoid wildcard origins.                      |
| `MENTRO_REVISION`                                      | Full, checked merged-main commit SHA for image tag and OCI revision label.              |
| `MENTRO_API_PORT`                                      | Optional host loopback port; default `3001`.                                            |

`NODE_ENV=production` and `PORT=3001` are fixed in the production Compose file.
`CHROMIUM_PATH=/usr/bin/chromium` is fixed in the image. The server supports
`MENTRO_INFERENCE_TIMEOUT_MS`, but its default is 30 seconds; change it only as
an explicit operational decision. Keep all runtime credentials
in the protected host environment file, outside the repository and image. Test
Compose interpolation with dummy values only. A successful `docker compose config`
does not validate those credentials or any upstream.

`/api/health` checks Chromium and reports whether Supabase settings exist; it
does not prove Auth, RLS, history, or inference. Verify a CORS preflight from
`https://mentro.elischiffler.dev`, a real approved Auth flow, a streamed chat,
and the exact provider/model response through the HTTPS API route before
switching `VITE_PROXY_URL` in Vercel. The existing isolated fixture suite is
not evidence of these external integrations. The browser extension and
Roadtrips gateway need their API targets reviewed before retiring Fly.

The API stores no application database volume; Supabase owns Auth and history
persistence. Before cutover, identify the actual project, schema, RLS policies,
two test users, provider recovery behavior, and backup/restore procedure. No
production schema or Auth data should be inferred from the fixture. Keep the
previous image digest and proxy route for rollback; database changes require
their own recovery plan. The Supabase project owner must document and verify
its managed backup and restore process before cutover. Recreating the API
container cannot restore Supabase data, and rolling back an image cannot undo
an incompatible database migration. In-memory Stoplight sessions reset when
the container is recreated.

Each HTTP response also emits one JSON line to stdout with `kind=ops`, the
fixed service/event/message values, ISO 8601 `timestamp`, `info|warn|error`
`level`, allowlisted method, numeric status, and bounded duration. It omits
paths, query strings, headers, bodies, tokens, customer IDs, and provider
errors. The host operator owns any collection into
`/var/lib/hosting-ops/logs/mentro-api.jsonl`, file rotation and its read-only
mount. A dashboard feed must accept only the fixed `kind=ops` schema after
validation. Existing raw diagnostic lines may contain user or provider data;
never publish general Docker logs or mount the Docker socket into the dashboard.
No host log feed is active yet.
