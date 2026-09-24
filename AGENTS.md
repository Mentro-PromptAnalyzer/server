# Mentro server workflow

The repository root is the Node.js API. Use Node.js 24 and npm with the committed `package-lock.json`. `index.js` owns HTTP routes, Supabase JWT verification, inference streaming, share extraction, Chromium lifecycle, and health. `validateTokenRequest.js` owns token-request validation; `adapters/` owns provider-specific token calls. Keep backend authorization authoritative.

From the repository root, run `npm ci`, `npm run format:check`, `npm run lint`, `npm run check:syntax`, and `npm test`. The container contract also requires Docker with Linux containers: set `MENTRO_REVISION` to `git rev-parse HEAD`, run `docker compose up --build --detach --wait --wait-timeout 60`, then `npm run test:container`. See [the local container runbook](docs/local-container.md) for PowerShell and POSIX commands, fixture boundaries, health, recovery, and evidence deadlines. Do not treat a zero-test run as passing.

The local Compose stack uses controlled fixture auth, share pages, and inference. It must not contain production credentials or call live providers. Fixture substitution is rejected when `NODE_ENV=production`. The production image contains the API and Chromium, without test fixtures or development dependencies. The existing Fly configuration is separate; no cloud target, registry, proxy, or production deployment pipeline is configured by this pilot.

Commit coherent, validated changes on a task branch and open a PR. The user approves merges. Do not merge, enable auto-merge, push to main, or manually deploy production. Keep CI read-only for untrusted PRs and report any unavailable check or external-service evidence explicitly.
