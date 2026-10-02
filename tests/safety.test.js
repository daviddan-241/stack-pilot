import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPossibleSecret, validateRelativePath } from '../src/safety.js';

test('allows ordinary nested source files and safe examples', () => {
  assert.equal(validateRelativePath('src/components/Button.jsx'), true);
  assert.equal(validateRelativePath('README.md'), true);
  assert.equal(validateRelativePath('.env.example'), true);
});

test('rejects traversal, absolute paths, secrets, and dependency folders', () => {
  for (const value of ['../outside.js', '/etc/passwd', 'C:\\temp\\x.js', '.env', '.env.production', '.git/config', 'node_modules/pkg/index.js', 'secrets.json']) {
    assert.equal(validateRelativePath(value), false, `${value} should be rejected`);
  }
});

test('detects GitHub credentials and private keys', () => {
  assert.equal(containsPossibleSecret('const token = "ghp_' + 'A'.repeat(40) + '";'), true);
  const privateKeyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  assert.equal(containsPossibleSecret(privateKeyMarker), true);
});
