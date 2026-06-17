// server/validateTokenRequest.js
const { VALID_PROVIDERS, getProviderConfig } = require('./providerRegistry');

function validateTokenRequest(body) {
  if (!body.provider) {
    return { valid: false, status: 400, message: 'provider field is required' };
  }
  if (!VALID_PROVIDERS.includes(body.provider)) {
    return { valid: false, status: 400, message: 'unsupported provider' };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, status: 400, message: 'messages must be a non-empty array' };
  }
  for (const msg of body.messages) {
    if (!msg || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
      return { valid: false, status: 400, message: 'each message must have role and content strings' };
    }
  }
  // Default model from provider registry when not provided
  if (!body.model) {
    const config = getProviderConfig(body.provider);
    body.model = config.model;
  }
  return { valid: true };
}

module.exports = { validateTokenRequest };
