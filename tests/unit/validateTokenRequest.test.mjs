import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validateTokenRequest } = require('../../validateTokenRequest');

describe('validateTokenRequest', () => {
  it('rejects missing and malformed bodies before provider dispatch', () => {
    for (const body of [undefined, null, [], {}, { provider: 'unknown', messages: [] }]) {
      const result = validateTokenRequest(body);
      expect(result.valid).toBe(false);
      expect(result.status).toBe(400);
    }
  });

  it('rejects invalid messages and model fields', () => {
    const base = { provider: 'openai', messages: [{ role: 'user', content: 'hello' }] };
    for (const body of [
      { ...base, messages: [{ role: 'tool', content: 'hello' }] },
      { ...base, messages: [{ role: 'user', content: ' ' }] },
      { ...base, messages: [{ role: 'user', content: 'x'.repeat(32001) }] },
      { ...base, messages: Array.from({ length: 51 }, () => ({ role: 'user', content: 'x' })) },
      { ...base, model: 42 },
    ]) {
      expect(validateTokenRequest(body).valid).toBe(false);
    }
  });

  it('sets the registry model for a valid request', () => {
    const body = { provider: 'openai', messages: [{ role: 'user', content: 'hello world' }] };
    expect(validateTokenRequest(body)).toEqual({ valid: true });
    expect(body.model).toBe('gpt-4o');
  });
});
