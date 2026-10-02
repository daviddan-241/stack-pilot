import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateOrReservedAddress, normalizeMonitorUrl } from '../src/monitor.js';

test('normalizes public HTTP(S) monitor URLs and strips fragments', () => {
  assert.equal(normalizeMonitorUrl('https://example.com/status#check'), 'https://example.com/status');
  assert.equal(normalizeMonitorUrl('http://render.example.com'), 'http://render.example.com/');
});

test('rejects local, credential-bearing, and non-web URLs', () => {
  for (const value of ['http://localhost:3000', 'http://192.168.1.1', 'http://user:pass@example.com', 'file:///etc/passwd', 'not a URL']) {
    assert.throws(() => normalizeMonitorUrl(value));
  }
});

test('identifies private and reserved IP ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.2', '169.254.2.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(isPrivateOrReservedAddress(address), true, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateOrReservedAddress(address), false, address);
});
