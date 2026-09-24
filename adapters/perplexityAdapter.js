// server/adapters/perplexityAdapter.js
const fetch = require('node-fetch');

async function countTokensPerplexity(messages, model) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    const err = new Error('PERPLEXITY_API_KEY is not configured');
    err.statusCode = 503;
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const url = process.env.MENTRO_FIXTURE_ORIGIN
      ? `${process.env.MENTRO_FIXTURE_ORIGIN}/perplexity-count-tokens`
      : 'https://api.perplexity.ai/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, max_tokens: 1 }),
      signal: controller.signal,
      redirect: process.env.MENTRO_FIXTURE_ORIGIN ? 'error' : 'follow',
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Perplexity API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    if (!Number.isInteger(data?.usage?.prompt_tokens) || data.usage.prompt_tokens < 0) {
      throw new Error('Perplexity API returned an invalid token count');
    }
    const result = { inputTokens: data.usage.prompt_tokens };

    if (data.usage?.cost) {
      result.cost = {
        input_tokens_cost: data.usage.cost.input_tokens_cost,
        output_tokens_cost: data.usage.cost.output_tokens_cost,
        total_cost: data.usage.cost.total_cost,
      };
    }

    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Perplexity API request timed out after 15 seconds', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { countTokensPerplexity };
