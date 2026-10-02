import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProgress, detectEnvKeys } from '../src/workflow.js';

test('progress follows completed specialist stages and finishes for a verified build', () => {
  assert.equal(calculateProgress({ organize: 'done', preflight: 'running' }, 'running'), 21);
  assert.equal(calculateProgress({}, 'verified', 77), 100);
  assert.equal(calculateProgress({}, 'running', 140), 96);
});

test('environment scanner detects .env.example and source references without runtime defaults', () => {
  const rows = detectEnvKeys({
    '.env.example': 'API_URL=https://example.invalid\nAUTH_SECRET=replace-me\nPORT=3000\n',
    'src/server.js': "const key = process.env.ANTHROPIC_API_KEY;\nconst region = process.env['AWS_REGION'];",
    'src/client.js': 'const endpoint = import.meta.env.VITE_PUBLIC_API;\n',
  });
  assert.deepEqual(rows.map((row) => row.key), ['ANTHROPIC_API_KEY', 'API_URL', 'AUTH_SECRET', 'AWS_REGION', 'VITE_PUBLIC_API']);
  assert.ok(rows.every((row) => row.value === ''));
});
