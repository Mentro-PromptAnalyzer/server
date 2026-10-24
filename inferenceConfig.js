// Keep provider destinations fixed; runtime configuration selects models, not URLs.
function inferenceChain(env, fixtureOrigin = null) {
  return [
    ['GROQ', 'Groq', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b'],
    ['CEREBRAS', 'Cerebras', 'https://api.cerebras.ai/v1', 'gpt-oss-120b'],
    ['TOGETHER', 'Together AI', 'https://api.together.xyz/v1', 'meta-models/Muse-Glimmer-30B'],
  ]
    .filter(([prefix]) => env[`${prefix}_API_KEY`]?.trim())
    .map(([prefix, name, base, defaultModel]) => ({
      name,
      base: fixtureOrigin || base,
      key: env[`${prefix}_API_KEY`],
      model: env[`${prefix}_MODEL`]?.trim() || defaultModel,
    }));
}

module.exports = { inferenceChain };
