import js from '@eslint/js';
import globals from 'globals';

const nodeGlobals = { ...globals.node, fetch: 'readonly', AbortSignal: 'readonly' };

export default [
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: nodeGlobals },
    rules: js.configs.recommended.rules,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: nodeGlobals },
    rules: js.configs.recommended.rules,
  },
  {
    files: ['index.js'],
    // page.evaluate callbacks run inside Chromium, where document exists.
    languageOptions: { globals: { document: 'readonly' } },
  },
];
