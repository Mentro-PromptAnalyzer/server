// server/providerRegistry.js
const PROVIDERS = {
  openai: {
    provider: 'openai',
    model: 'gpt-4o',
    apiKeyEnv: '',
    endpoint: 'local',
  },
  gemini: {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    endpoint: ':countTokens',
  },
  perplexity: {
    provider: 'perplexity',
    model: 'sonar-pro',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    endpoint: '/chat/completions',
  },
};

const VALID_PROVIDERS = Object.keys(PROVIDERS);

function getProviderConfig(providerName) {
  return PROVIDERS[providerName] || null;
}

module.exports = { PROVIDERS, VALID_PROVIDERS, getProviderConfig };
