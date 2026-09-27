// server/validateTokenRequest.js
const { VALID_PROVIDERS, getProviderConfig } = require('./providerRegistry');

function validateTokenRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, status: 400, message: 'request body must be an object' };
  }
  if (!body.provider) {
    return { valid: false, status: 400, message: 'provider field is required' };
  }
  if (!VALID_PROVIDERS.includes(body.provider)) {
    return { valid: false, status: 400, message: 'unsupported provider' };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, status: 400, message: 'messages must be a non-empty array' };
  }
  if (body.messages.length > 50) {
    return { valid: false, status: 400, message: 'messages cannot exceed 50 items' };
  }
  let totalLength = 0;
  for (const msg of body.messages) {
    if (
      !msg ||
      !['user', 'assistant', 'system'].includes(msg.role) ||
      typeof msg.content !== 'string' ||
      !msg.content.trim() ||
      msg.content.length > 32000
    ) {
      return {
        valid: false,
        status: 400,
        message:
          'each message must have a supported role and non-empty content under 32000 characters',
      };
    }
    totalLength += msg.content.length;
  }
  if (totalLength > 128000) {
    return {
      valid: false,
      status: 400,
      message: 'total message content exceeds 128000 characters',
    };
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
    return { valid: false, status: 400, message: 'model must be a non-empty string' };
  }
  // Default model from provider registry when not provided
  if (!body.model) {
    const config = getProviderConfig(body.provider);
    body.model = config.model;
  }
  return { valid: true };
}

module.exports = { validateTokenRequest };
