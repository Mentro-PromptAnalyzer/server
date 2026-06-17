// server/adapters/localEstimator.js
const { Tiktoken } = require('js-tiktoken/lite');
const cl100k_base = require('js-tiktoken/ranks/cl100k_base');

let encoder = null;
let initFailed = false;

try {
  encoder = new Tiktoken(cl100k_base);
} catch {
  initFailed = true;
}

function estimateTokensLocal(text) {
  if (initFailed || !encoder) {
    return 0;
  }
  if (!text || text.length === 0) {
    return 0;
  }
  try {
    return encoder.encode(text).length;
  } catch {
    return 0;
  }
}

function estimateTokensFromMessages(messages) {
  const concatenated = messages.map((m) => m.content).join('\n');
  return estimateTokensLocal(concatenated);
}

module.exports = { estimateTokensLocal, estimateTokensFromMessages };
