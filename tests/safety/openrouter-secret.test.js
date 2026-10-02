import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPossibleSecret } from '../../src/safety.js';

test('detects OpenRouter v1 keys using the required token pattern', () => {
  const key = `sk-or-v1-${'A'.repeat(30)}`;
  assert.equal(containsPossibleSecret(`const apiKey = "${key}";`), true);
  assert.equal(containsPossibleSecret(`OPENROUTER_API_KEY_1=replace-me`), false);
  assert.equal(containsPossibleSecret(`sk-or-v1-${'A'.repeat(29)}`), false);
});
