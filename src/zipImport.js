import { containsPossibleSecret, validateRelativePath } from './safety.js';
import { encodeBinaryAsset } from './projectFiles.js';
import {
  MAX_PROJECT_BYTES,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILE_COUNT,
  MAX_ZIP_ARCHIVE_BYTES,
  MAX_ZIP_ARCHIVES,
  MAX_ZIP_ENTRY_COUNT,
  MAX_ZIP_TOTAL_ARCHIVE_BYTES,
} from './limits.js';

const MIB = 1024 * 1024;
const SKIP_PARTS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', 'vendor', '__pycache__']);
const ASSET_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', };
function assetMime(path) { return ASSET_MIME[path.split('.').at(-1)?.toLowerCase()] || ''; }
function mib(bytes) { return Math.floor(bytes / MIB); }

function isSkippablePath(path) {
  return path.split('/').some((part) => SKIP_PARTS.has(part.toLowerCase())) || path.startsWith('__MACOSX/');
}

export async function extractProjectZip(file, { currentBytes = 0, currentFiles = 0 } = {}) {
  if (!file || !Number.isFinite(file.size)) throw new Error('Choose a ZIP archive first.');
  if (file.size > MAX_ZIP_ARCHIVE_BYTES) throw new Error(`A ZIP archive can be up to ${mib(MAX_ZIP_ARCHIVE_BYTES)} MB compressed.`);
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(file, { createFolders: false });
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ZIP_ENTRY_COUNT) throw new Error(`This ZIP has more than ${MAX_ZIP_ENTRY_COUNT.toLocaleString()} archive entries. Remove generated folders and retry.`);

  // GitHub source archives commonly add one wrapper directory such as repo-main/.
  const firstParts = entries.map((entry) => entry.name.split('/').filter(Boolean)[0]).filter(Boolean);
  const uniqueRoots = new Set(firstParts);
  const hasRootFiles = entries.some((entry) => entry.name.split('/').filter(Boolean).length === 1);
  const wrapper = !hasRootFiles && uniqueRoots.size === 1 ? `${firstParts[0]}/` : '';
  const files = {};
  let totalBytes = currentBytes;
  let skipped = 0;

  for (const entry of entries) {
    let filePath = entry.name.replaceAll('\\', '/');
    if (wrapper && filePath.startsWith(wrapper)) filePath = filePath.slice(wrapper.length);
    filePath = filePath.replace(/\/$/, '');
    if (!filePath || isSkippablePath(filePath) || !validateRelativePath(filePath)) { skipped += 1; continue; }

    const declaredBytes = Number(entry._data?.uncompressedSize);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PROJECT_FILE_BYTES) {
      throw new Error(`${filePath} is larger than the ${mib(MAX_PROJECT_FILE_BYTES)} MB per-file limit. Nothing from this ZIP was silently dropped.`);
    }
    if (Number.isFinite(declaredBytes) && totalBytes + declaredBytes > MAX_PROJECT_BYTES) {
      throw new Error(`Project contents exceed ${mib(MAX_PROJECT_BYTES)} MB extracted. Nothing from this ZIP was silently dropped.`);
    }
    if (currentFiles + Object.keys(files).length >= MAX_PROJECT_FILE_COUNT) {
      throw new Error(`Project exceeds the ${MAX_PROJECT_FILE_COUNT.toLocaleString()} supported-file limit. Nothing from this ZIP was silently dropped.`);
    }

    const bytes = await entry.async('uint8array');
    if (bytes.byteLength > MAX_PROJECT_FILE_BYTES) {
      throw new Error(`${filePath} is larger than the ${mib(MAX_PROJECT_FILE_BYTES)} MB per-file limit. Nothing from this ZIP was silently dropped.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROJECT_BYTES) {
      throw new Error(`Project contents exceed ${mib(MAX_PROJECT_BYTES)} MB extracted. Nothing from this ZIP was silently dropped.`);
    }

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
  if (!Object.keys(files).length) throw new Error('No safe text source files were found in that ZIP. Unsupported binary files and generated folders are skipped.');
  return { files, skipped, count: Object.keys(files).length, totalBytes: totalBytes - currentBytes };
}

export async function extractProjectZips(fileList, { currentBytes = 0, currentFiles = 0 } = {}) {
  const archives = Array.from(fileList || []);
  if (!archives.length) throw new Error('Choose at least one ZIP archive.');
  if (archives.length > MAX_ZIP_ARCHIVES) throw new Error(`Choose no more than ${MAX_ZIP_ARCHIVES} ZIP archives at a time.`);
  const compressedBytes = archives.reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
  if (compressedBytes > MAX_ZIP_TOTAL_ARCHIVE_BYTES) {
    throw new Error(`The selected ZIP archives exceed the ${mib(MAX_ZIP_TOTAL_ARCHIVE_BYTES)} MB combined compressed limit.`);
  }

  const files = {};
  let skipped = 0;
  let extractedBytes = 0;
  for (const archive of archives) {
    const result = await extractProjectZip(archive, { currentBytes: currentBytes + extractedBytes, currentFiles: currentFiles + Object.keys(files).length });
    extractedBytes += result.totalBytes;
    skipped += result.skipped;
    const duplicatePaths = Object.keys(result.files).filter((path) => Object.prototype.hasOwnProperty.call(files, path));
    if (duplicatePaths.length) throw new Error(`Multiple ZIP archives contain ${duplicatePaths.length} duplicate path${duplicatePaths.length === 1 ? '' : 's'} (for example “${duplicatePaths[0]}”). Import separately or rename the duplicate files to avoid losing source.`);
    Object.assign(files, result.files);
    if (currentFiles + Object.keys(files).length > MAX_PROJECT_FILE_COUNT) {
      throw new Error(`Combined ZIP archives exceed the ${MAX_PROJECT_FILE_COUNT.toLocaleString()} supported-file limit.`);
    }
  }
  if (!Object.keys(files).length) throw new Error('No safe project files were found in those ZIP archives.');
  return { files, skipped, count: Object.keys(files).length, totalBytes: extractedBytes, archiveCount: archives.length };
}
