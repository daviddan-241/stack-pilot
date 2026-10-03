import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewSegments, splitTextIntoChunks } from '../src/sourceChunking.js';

test('source chunks preserve all characters and never exceed their per-request size', () => {
  const source = `${'first line with details\n'.repeat(11)}${'x'.repeat(29)} ${'last piece '.repeat(13)} 🧭`;
  const chunks = splitTextIntoChunks(source, 47);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 47));
  assert.equal(chunks.join(''), source);
  for (const chunk of chunks) {
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(last >= 0xD800 && last <= 0xDBFF), 'a chunk must not end with a dangling high surrogate');
  }
});

test('review segments cover the full request and each text file in stable path order', () => {
  const request = 'Paste this complete request.\n'.repeat(9);
  const files = { 'z-last.js': 'z'.repeat(18), 'a-first.js': 'first\n'.repeat(14) };
  const segments = buildReviewSegments(request, files, 31);
  assert.ok(segments.length > 3);
  assert.equal(segments.filter((segment) => segment.type === 'request').map((segment) => segment.content).join(''), request);
  assert.equal(segments.filter((segment) => segment.path === 'a-first.js').map((segment) => segment.content).join(''), files['a-first.js']);
  assert.equal(segments.filter((segment) => segment.path === 'z-last.js').map((segment) => segment.content).join(''), files['z-last.js']);
  assert.deepEqual([...new Set(segments.filter((segment) => segment.type === 'file').map((segment) => segment.path))], ['a-first.js', 'z-last.js']);
});

test('empty input produces no review segments; no arbitrary total-input cap is applied', () => {
  assert.deepEqual(buildReviewSegments(''), []);
  const source = 'not truncated '.repeat(250_000);
  const chunks = splitTextIntoChunks(source, 20_000);
  assert.ok(chunks.length > 100);
  assert.equal(chunks.join(''), source);
});
