import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inferenceChain } = require('../../inferenceConfig.js');

it('enables only credentialed providers with supported defaults in fallback order', () => {
  expect(inferenceChain({})).toEqual([]);
  const chain = inferenceChain({
    GROQ_API_KEY: 'fixture-groq',
    CEREBRAS_API_KEY: 'fixture-cerebras',
    TOGETHER_API_KEY: 'fixture-together',
  });
  expect(chain.map(({ name, model }) => [name, model])).toEqual([
    ['Groq', 'openai/gpt-oss-120b'],
    ['Cerebras', 'gpt-oss-120b'],
    ['Together AI', 'meta-models/Muse-Glimmer-30B'],
  ]);
});

it('honors model overrides without enabling an uncredentialed provider or changing its origin', () => {
  expect(
    inferenceChain({
      GROQ_MODEL: 'unused',
      TOGETHER_API_KEY: 'fixture',
      TOGETHER_MODEL: ' selected/model ',
    })
  ).toEqual([
    {
      name: 'Together AI',
      base: 'https://api.together.xyz/v1',
      key: 'fixture',
      model: 'selected/model',
    },
  ]);
  const [entry] = inferenceChain(
    { CEREBRAS_API_KEY: 'fixture', CEREBRAS_MODEL: ' ' },
    'http://fixture:3004'
  );
  expect(entry.base).toBe('http://fixture:3004');
  expect(entry.model).toBe('gpt-oss-120b');
});
