import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractProjectZip, extractProjectZips } from '../src/zipImport.js';
import { binaryAssetByteLength, isBinaryAsset, parseBinaryAsset } from '../src/projectFiles.js';
import { MAX_PROJECT_BYTES, MAX_PROJECT_FILE_COUNT } from '../src/limits.js';

function namedFile(name, text, size = new Date()) { return new File([text], name, { lastModified: size instanceof Date ? size.getTime() : size }); }

test('imports safe text files and strips a single GitHub archive wrapper', async () => {
  const archive = new JSZip();
  archive.file('demo-main/package.json', '{"scripts":{"build":"vite build"}}');
  archive.file('demo-main/src/main.js', 'console.log("hello")');
  archive.file('demo-main/README.md', '# demo');
  const blob = await archive.generateAsync({ type: 'nodebuffer' });
  const result = await extractProjectZip(namedFile('demo-main.zip', blob));
  assert.equal(result.count, 3);
  assert.equal(result.files['package.json'], '{"scripts":{"build":"vite build"}}');
  assert.equal(result.files['src/main.js'], 'console.log("hello")');
});

test('keeps safe binary assets and skips generated folders and secret environment files', async () => {
  const archive = new JSZip();
  archive.file('project/index.html', '<!doctype html>');
  archive.file('project/node_modules/pkg/index.js', 'ignored');
  archive.file('project/.env.local', 'SECRET=value');
  archive.file('project/image.png', new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]));
  archive.file('project/photo.heic', new Uint8Array([1, 2, 3, 4]));
  archive.file('project/clip.mov', new Uint8Array([5, 6, 7]));
  archive.file('project/brief.docx', new Uint8Array([8, 9, 10]));
  archive.file('project/tiny.webp', new TextEncoder().encode('valid-ascii-bytes'));
  const blob = await archive.generateAsync({ type: 'nodebuffer' });
  const result = await extractProjectZip(namedFile('project.zip', blob));
  assert.deepEqual(Object.keys(result.files).sort(), ['brief.docx', 'clip.mov', 'image.png', 'index.html', 'photo.heic', 'tiny.webp']);
  assert.equal(parseBinaryAsset(result.files['brief.docx']).mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(parseBinaryAsset(result.files['clip.mov']).mime, 'video/quicktime');
  assert.equal(parseBinaryAsset(result.files['photo.heic']).mime, 'image/heic');
  assert.ok(isBinaryAsset(result.files['image.png']));
  assert.equal(parseBinaryAsset(result.files['image.png']).mime, 'image/png');
  assert.equal(binaryAssetByteLength(result.files['image.png']), 8);
  assert.ok(isBinaryAsset(result.files['tiny.webp']));
  assert.equal(parseBinaryAsset(result.files['tiny.webp']).mime, 'image/webp');
  assert.ok(result.skipped >= 2);
});

test('rejects an OpenRouter-style live key in a source file', async () => {
  const archive = new JSZip();
  const liveKey = `sk-or-v1-${'A'.repeat(30)}`;
  archive.file('main.js', `const key = "${liveKey}";`);
  const blob = await archive.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => extractProjectZip(namedFile('project.zip', blob)), /possible live credential/i);
});

test('merges multiple ZIP archives within one bounded project import', async () => {
  const first = new JSZip();
  first.file('src/main.js', 'export const main = true;');
  first.file('README.md', '# Demo');
  const second = new JSZip();
  second.file('styles-export/src/styles.css', 'body { color: #333; }');
  const [firstBlob, secondBlob] = await Promise.all([
    first.generateAsync({ type: 'nodebuffer' }), second.generateAsync({ type: 'nodebuffer' }),
  ]);
  const result = await extractProjectZips([
    namedFile('source.zip', firstBlob), namedFile('styles.zip', secondBlob),
  ]);
  assert.equal(result.archiveCount, 2);
  assert.equal(result.count, 3);
  assert.equal(result.files['src/main.js'], 'export const main = true;');
  assert.equal(result.files['src/styles.css'], 'body { color: #333; }');
});

test('preserves individual source files larger than the previous 750 KB cap', async () => {
  const content = 'StackPilot-large-source-'.repeat(180_000);
  const archive = new JSZip();
  archive.file('project-main/src/large-source.txt', content);
  const blob = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  const result = await extractProjectZip(namedFile('large-source.zip', blob));
  assert.equal(result.files['src/large-source.txt'], content);
  assert.equal(result.totalBytes, Buffer.byteLength(content));
});

test('rejects an oversized supported file instead of silently dropping it', async () => {
  const archive = new JSZip();
  archive.file('src/oversized.txt', 'x'.repeat(8 * 1024 * 1024 + 1));
  const blob = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  await assert.rejects(() => extractProjectZip(namedFile('oversized.zip', blob)), /per-file limit.*Nothing.*silently dropped/i);
});

test('counts existing attachments toward ZIP limits and rejects duplicate paths across archives', async () => {
  const first = new JSZip();
  first.file('project-a/index.html', '<main>first</main>');
  const second = new JSZip();
  second.file('project-b/index.html', '<main>second</main>');
  const [firstBlob, secondBlob] = await Promise.all([
    first.generateAsync({ type: 'nodebuffer' }), second.generateAsync({ type: 'nodebuffer' }),
  ]);
  await assert.rejects(() => extractProjectZips([namedFile('one.zip', firstBlob)], { currentFiles: MAX_PROJECT_FILE_COUNT }), /supported-file limit/i);
  await assert.rejects(() => extractProjectZips([namedFile('one.zip', firstBlob)], { currentBytes: MAX_PROJECT_BYTES }), /Project contents exceed/i);
  await assert.rejects(() => extractProjectZips([
    namedFile('one.zip', firstBlob), namedFile('two.zip', secondBlob),
  ]), /duplicate path/i);
});

test('bounds multi-ZIP selection to 100 archives and 150 MB compressed', async () => {
  const emptyArchive = namedFile('empty.zip', new Uint8Array());
  await assert.rejects(() => extractProjectZips(Array.from({ length: 101 }, () => emptyArchive)), /no more than 100/i);
  await assert.rejects(() => extractProjectZips([
    { name: 'large-a.zip', size: 76 * 1024 * 1024 },
    { name: 'large-b.zip', size: 76 * 1024 * 1024 },
  ]), /150 MB combined/i);
  await assert.rejects(() => extractProjectZip({ name: 'too-large.zip', size: 101 * 1024 * 1024 }), /100 MB compressed/i);
});
