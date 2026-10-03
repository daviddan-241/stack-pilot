import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { prepareAttachments } from '../src/attachmentImport.js';
import { encodeBinaryAsset, isBinaryAsset, parseBinaryAsset } from '../src/projectFiles.js';

function file(name, bytes, type = '') { return new File([bytes], name, { type }); }

async function zipFile(name, entries) {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(entries)) zip.file(path, contents);
  return file(name, await zip.generateAsync({ type: 'nodebuffer' }), 'application/zip');
}

test('attaches iPhone HEIC photos and QuickTime videos as preserved binary assets', async () => {
  const photo = file('IMG_8438.HEIC', new Uint8Array([1, 2, 3, 4]), 'image/heic');
  const video = file('clip.MOV', new Uint8Array([5, 6, 7]), 'video/quicktime');
  const result = await prepareAttachments([photo, video]);
  assert.equal(result.count, 2);
  assert.equal(result.mediaCount, 2);
  assert.ok(isBinaryAsset(result.files['IMG_8438.HEIC']));
  assert.equal(parseBinaryAsset(result.files['IMG_8438.HEIC']).mime, 'image/heic');
  assert.equal(parseBinaryAsset(result.files['clip.MOV']).mime, 'video/quicktime');
});

test('preserves common office documents as downloadable binary project assets', async () => {
  const document = file('product-brief.docx', new Uint8Array([9, 8, 7]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const result = await prepareAttachments([document]);
  assert.equal(result.count, 1);
  assert.ok(isBinaryAsset(result.files['product-brief.docx']));
  assert.equal(parseBinaryAsset(result.files['product-brief.docx']).mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('adds direct files without replacing existing content and renames duplicate media', async () => {
  const original = encodeBinaryAsset(new Uint8Array([0, 1]), 'image/png');
  const existing = { 'photo.png': original, 'README.md': '# Original' };
  const result = await prepareAttachments([
    file('photo.png', new Uint8Array([2, 3]), 'image/png'),
    file('notes.txt', 'Keep both attachments', 'text/plain'),
  ], existing);
  const merged = { ...existing, ...result.files };
  assert.equal(result.renamedCount, 1);
  assert.equal(result.totalFiles, 4);
  assert.equal(merged['photo.png'], original);
  assert.equal(parseBinaryAsset(merged['photo (2).png']).mime, 'image/png');
  assert.equal(merged['notes.txt'], 'Keep both attachments');
});

test('merges a ZIP into an existing file set and rejects same-path ZIP replacement', async () => {
  const archive = await zipFile('source.zip', { 'project-main/src/main.js': 'export const ready = true;', 'project-main/package.json': '{"name":"demo"}' });
  const existing = { 'README.md': '# Existing draft' };
  const result = await prepareAttachments([archive], existing);
  assert.equal(result.files['src/main.js'], 'export const ready = true;');
  assert.equal(existing['README.md'], '# Existing draft');
  assert.equal(result.totalFiles, 3);

  const collision = await zipFile('replacement.zip', { 'project-main/README.md': '# Replacement' });
  await assert.rejects(() => prepareAttachments([collision], existing), /already attached.*Remove the existing file/i);
});

test('rejects unsafe paths and likely credentials in directly attached text', async () => {
  await assert.rejects(() => prepareAttachments([file('../escape.js', 'export const x = 1;', 'text/javascript')]), /not a safe project path/i);
  const token = `ghp_${'A'.repeat(36)}`;
  await assert.rejects(() => prepareAttachments([file('config.js', `const token = '${token}';`, 'text/javascript')]), /appears to contain a credential/i);
});
