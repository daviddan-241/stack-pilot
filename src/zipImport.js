import { containsPossibleSecret, validateRelativePath } from './safety.js';
import { encodeBinaryAsset } from './projectFiles.js';

const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;
const MAX_FILE_COUNT = 300;
const MAX_TOTAL_PROJECT_BYTES = 3_000_000;
const SKIP_PARTS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', 'vendor', '__pycache__']);
const ASSET_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' };
function assetMime(path) { return ASSET_MIME[path.split('.').at(-1)?.toLowerCase()] || ''; }

function isSkippablePath(path) {
  return path.split('/').some((part) => SKIP_PARTS.has(part.toLowerCase())) || path.startsWith('__MACOSX/');
}

export async function extractProjectZip(file) {
  if (!file || !Number.isFinite(file.size)) throw new Error('Choose a ZIP archive first.');
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP archives must be 15 MB or smaller.');
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(file, { createFolders: false });
  let entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > 2000) throw new Error('This ZIP contains too many archive entries. Keep it under 2,000 items.');

  // GitHub source archives commonly add one wrapper directory such as repo-main/.
  const firstParts = entries.map((entry) => entry.name.split('/').filter(Boolean)[0]).filter(Boolean);
  const uniqueRoots = new Set(firstParts);
  const hasRootFiles = entries.some((entry) => entry.name.split('/').filter(Boolean).length === 1);
  const wrapper = !hasRootFiles && uniqueRoots.size === 1 ? `${firstParts[0]}/` : '';
  const files = {};
  let totalBytes = 0;
  let skipped = 0;

  for (const entry of entries) {
    let filePath = entry.name.replaceAll('\\', '/');
    if (wrapper && filePath.startsWith(wrapper)) filePath = filePath.slice(wrapper.length);
    filePath = filePath.replace(/\/$/, '');
    if (!filePath || isSkippablePath(filePath) || !validateRelativePath(filePath)) { skipped += 1; continue; }
    if (Object.keys(files).length >= MAX_FILE_COUNT) throw new Error(`ZIP contains more than ${MAX_FILE_COUNT} supported files.`);
    if (entry._data?.uncompressedSize > 750_000) { skipped += 1; continue; }

    const bytes = await entry.async('uint8array');
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > 750_000) { skipped += 1; continue; }
    if (totalBytes > MAX_TOTAL_PROJECT_BYTES) throw new Error('The ZIP has more than 3 MB of extracted project files. Remove generated files and try again.');
    const mime = assetMime(filePath);
    if (mime) {
      files[filePath] = encodeBinaryAsset(bytes, mime);
      continue;
    }
    let text = '';
    let isText = true;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { isText = false; }
    if (!isText || text.includes('\0')) {
      skipped += 1;
      continue;
    }
    if (containsPossibleSecret(text)) throw new Error(`A possible live credential was found in ${filePath}. Remove or rotate it before importing this ZIP.`);
    files[filePath] = text;
  }
  if (!Object.keys(files).length) throw new Error('No safe text source files were found in that ZIP. Binary files and generated folders are skipped.');
  return { files, skipped, count: Object.keys(files).length, totalBytes };
}
