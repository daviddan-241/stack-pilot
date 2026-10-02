import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessageForModelStatus, isOpenRouterRetryableStatus, normalizeFreeModel, normalizeOpenRouterKeys, OPENROUTER_FREE_MODEL } from '../src/openrouter.js';

test('rotates over at most two distinct OpenRouter keys without persisting them', () => {
  assert.deepEqual(normalizeOpenRouterKeys([' key-one ', 'key-two', 'key-one', 'key-three']), ['key-one', 'key-two']);
  assert.deepEqual(normalizeOpenRouterKeys(['', null]), []);
});

test('accepts only the free router or a model explicitly marked free', () => {
  assert.equal(normalizeFreeModel(), OPENROUTER_FREE_MODEL);
  assert.equal(normalizeFreeModel('openrouter/free'), OPENROUTER_FREE_MODEL);
  assert.equal(normalizeFreeModel('qwen/qwen3-coder:free'), 'qwen/qwen3-coder:free');
  assert.equal(normalizeFreeModel('vendor/paid-model'), OPENROUTER_FREE_MODEL);
});

test('classifies retryable model limits and explains that no paid model is used', () => {
  assert.equal(isOpenRouterRetryableStatus(429), true);
  assert.equal(isOpenRouterRetryableStatus(503), true);
  assert.equal(isOpenRouterRetryableStatus(400), false);
  assert.match(errorMessageForModelStatus(402), /No paid model/);
});
