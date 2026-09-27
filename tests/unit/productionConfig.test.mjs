import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertProductionConfig } = require('../../productionConfig.js');

const valid = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'sample-public-key',
  GROQ_API_KEY: 'sample-provider-key',
};

it('rejects incomplete production configuration without exposing values', () => {
  expect(() => assertProductionConfig({ NODE_ENV: 'production' })).toThrow(
    'SUPABASE_URL, SUPABASE_ANON_KEY, GROQ_API_KEY/CEREBRAS_API_KEY/TOGETHER_API_KEY'
  );
  expect(() =>
    assertProductionConfig({ ...valid, SUPABASE_URL: 'http://example.supabase.co' })
  ).toThrow('SUPABASE_URL must be an HTTPS URL');
  expect(() => assertProductionConfig({ ...valid, ENABLE_TEST_ENDPOINTS: 'true' })).toThrow(
    'ENABLE_TEST_ENDPOINTS is forbidden'
  );
});

it('accepts a complete production configuration and leaves local mode alone', () => {
  expect(() => assertProductionConfig(valid)).not.toThrow();
  expect(() =>
    assertProductionConfig({ ...valid, GROQ_API_KEY: '', TOGETHER_API_KEY: 'sample' })
  ).not.toThrow();
  expect(() => assertProductionConfig({ NODE_ENV: 'test' })).not.toThrow();
});
