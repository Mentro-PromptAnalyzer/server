import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatHttpEvent } = require('../../opsEvents.js');

it('emits only bounded operational HTTP fields', () => {
  const event = JSON.parse(formatHttpEvent('GET', 200, 12.6));
  expect(event).toEqual({
    kind: 'ops',
    service: 'mentro-api',
    event: 'http.response',
    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    level: 'info',
    message: 'HTTP response',
    method: 'GET',
    status: 200,
    duration_ms: 13,
  });
  expect(formatHttpEvent('Bearer secret', 999, -10)).toMatch(/"method":"OTHER"/);
  expect(formatHttpEvent('Bearer secret', 999, -10)).not.toContain('secret');
  expect(JSON.parse(formatHttpEvent('POST', 503, Number.POSITIVE_INFINITY))).toMatchObject({
    level: 'error',
    status: 503,
    duration_ms: 0,
  });
  expect(JSON.parse(formatHttpEvent('GET', 401, 5_000_000))).toMatchObject({
    level: 'warn',
    duration_ms: 3_600_000,
  });
});
