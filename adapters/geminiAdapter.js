// server/adapters/geminiAdapter.js
const fetch = require('node-fetch');

async function countTokensGemini(messages, model) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.statusCode = 503;
    throw err;
  }

  const contents = messages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[gemini] countTokens failed: ${response.status} — ${errorBody}`);
      throw new Error(`Gemini API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    return data.totalTokens;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Gemini API request timed out after 10 seconds');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { countTokensGemini };
