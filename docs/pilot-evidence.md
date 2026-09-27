# Local Mentro server pilot evidence

This record covers the isolated Compose stack at the pre-PR working tree based on `3040d7bfa49715a3b0162218215db9d91384ece7` on 2026-09-24. Rebuild and retest the committed SHA before treating its image label as final. The image was built only for local testing; its Docker image ID is not a published registry digest.

## Baseline and acceptance limits

Before changes, `npm ci`, `npm run format:check`, and `node --check index.js` passed. The prior `npm test` passed while discovering **zero** tests because its script included `--passWithNoTests`; no lint command was configured. The clean install reported 13 dependency advisories (2 low, 3 moderate, 8 high). Those advisories were not addressed by this scoped migration.

Docker Desktop reported a Linux daemon with 16 CPUs and 8,247,738,368 bytes of memory. Before acceptance testing, the pilot limits were set to healthy within 60 seconds, graceful stop within 15 seconds, HTTP request within 60 seconds, and recovery within 60 seconds. The API limit is 1 CPU/1 GiB; the fixture limit is 0.25 CPU/128 MiB. The local inference timeout is two seconds, while the default runtime timeout is 30 seconds.

## Observed local checks

From a clean `npm ci`, `npm run format:check`, `npm run lint`, `npm run check:syntax`, and `npm test` passed; the unit runner executed three tests. With `MENTRO_REVISION` set to the Git SHA, `docker compose up --build --detach --wait --wait-timeout 60` started both containers healthy. `npm run test:container` passed 12 tests against the **actual API image**, including Chromium share extraction, auth through the fixture HTTP endpoint, token count schemas, two SSE endpoints, tool data and split text-tool content, fallback, upstream errors, incomplete streams, timeouts, client cancellation, and internal DNS. The 45-second hanging-share case completed within the 60-second HTTP deadline. A test-mode startup without the isolated auth/share/inference fixture failed explicitly; production mode rejected the fixture override. No test contacted a live provider or live Supabase.

Measured API stop was 1.829 seconds, start-to-healthy 6.333 seconds, and force recreation-to-healthy 6.789 seconds. After the suite, one `docker stats --no-stream` sample showed the API at 298.7 MiB / 1 GiB and 0.12% CPU with 133 processes, and the fixture at 16.3 MiB / 128 MiB and 11.23% CPU with 8 processes. These are point samples, not a sustained-load or capacity result. The local API image was 366,674,583 bytes (Docker image ID `sha256:bd890e131ce074449e5fa794fc62dd602921ed22536fcb1a85341b8754accd09`). Inspection confirmed uid 1000, read-only root, capabilities dropped, `no-new-privileges`, loopback-only published API port, writable `/tmp`, and no fixture source or test dependencies in the final API image.

The separate Roadtrips integration probe used its actual runtime image on `mentro-server-local_pilot`. It received and parsed the fenced `validate_location` tool call for Denver from the actual Mentro container in 0.19 seconds. During a deliberate Mentro stop it returned a bounded provider error in 0.037 seconds; after Mentro restarted it succeeded in 0.239 seconds and recovered within the 60-second deadline. This verifies a controlled cross-container contract, not live inference or Roadtrips' database journey.

## Gate boundary

The local container portions of S1-S4, S6, S8 and M1-M3 pass under controlled fixtures. M6's internal call and loopback/CORS path pass locally; the eventual production proxy remains untested. S5's full browser journey and the combined rehearsal belong to the coordinated application run. S7 requires the PR workflow to finish for the final commit. Live share providers, provider token APIs, real Supabase authentication, and live inference have **not** been validated; they remain separate external-service blockers. The draft PR is intentionally retained until the applicable external and coordinated gates are resolved.
