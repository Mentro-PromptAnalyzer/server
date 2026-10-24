# Inference models

The authenticated chat routes enable providers with configured API keys in this
order: Groq, Cerebras, Together AI. Provider URLs remain fixed. Models may be
overridden in the protected host environment file; blank overrides use defaults.

| Provider    | Model environment variable | Default                        |
| ----------- | -------------------------- | ------------------------------ |
| Groq        | `GROQ_MODEL`               | `openai/gpt-oss-120b`          |
| Cerebras    | `CEREBRAS_MODEL`           | `gpt-oss-120b`                 |
| Together AI | `TOGETHER_MODEL`           | `meta-models/Muse-Glimmer-30B` |

On October 24, 2026, Roadtrips' authenticated gateway request failed because
Together no longer serves `meta-llama/Llama-3.3-70B-Instruct-Turbo` on serverless.
Its [deprecation notice](https://docs.together.ai/docs/deprecations) gives
October 22 as the removal date and Muse Glimmer 30B as the replacement. The
[serverless catalog](https://docs.together.ai/docs/serverless/models) lists
streaming chat, function calling and structured outputs for that replacement.
Groq's [deprecation notice](https://console.groq.com/docs/deprecations) also
retires the previous `llama-3.3-70b-versatile` default and recommends GPT-OSS 120B.
These defaults use existing per-token endpoints; no dedicated endpoint is provisioned.

The observed Together failure identifies an unavailable model, not proof of an
expired API key. Preserve existing credentials unless an authenticated live check
reports a credential failure. Model changes can alter generated ratings and should
be recorded in downstream experiment provenance and cache versions.

Local unit and container checks use isolated inference fixtures. They verify model
selection, fallback routing, SSE chunks, tool calls, usage, cancellation and errors;
they cannot establish live model quality, account quota or key validity. After the
owner merges and checked-main deployment succeeds, verify both a simple authenticated
stream and representative Roadtrips rating JSON through the production gateway before
starting a study. Record the returned provider/model and assess an end-to-end trip.
If any check fails, leave the study stopped and retain the failure evidence.

Keep credentials out of commits and logs. Model overrides take effect on the next
approved container recreation. Follow the existing PR and checked-main deployment
workflow; do not manually replace production with an unmerged image.
