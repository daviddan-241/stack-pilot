import { extractProjectZips } from './zipImport.js';
import { binaryAssetByteLength, encodeBinaryAsset, isBinaryAsset } from './projectFiles.js';
import { containsPossibleSecret, validateRelativePath } from './safety.js';
import { MAX_PROJECT_BYTES, MAX_PROJECT_FILE_BYTES, MAX_PROJECT_FILE_COUNT } from './limits.js';

const DIRECT_ASSET_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
};
const DIRECT_TEXT_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'html', 'htm', 'css', 'scss', 'json', 'md', 'txt', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'php', 'sh', 'yml', 'yaml', 'toml', 'xml', 'svg', 'csv', 'sql', 'graphql', 'prisma', 'env']);
const encoder = new TextEncoder();

function contentBytes(content) {
  return isBinaryAsset(content) ? Math.max(0, binaryAssetByteLength(content)) : encoder.encode(String(content || '')).byteLength;
}

function uniquePath(path, occupied) {
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash + 1) : '';
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  let index = 2;
  let candidate = `${directory}${stem} (${index})${extension}`;
  while (occupied.has(candidate)) { index += 1; candidate = `${directory}${stem} (${index})${extension}`; }
  return candidate;
}

function assetMime(file) {
  const extension = String(file?.name || '').split('.').at(-1)?.toLowerCase();
  return DIRECT_ASSET_MIME[extension] || (file?.type?.startsWith('image/') && file.type !== 'image/svg+xml' ? file.type : '');
}

/** Safely prepare newly selected ZIPs, text files, and media assets for merging into a project. */
export async function prepareAttachments(fileList, existingFiles = {}) {
  const selected = Array.from(fileList || []);
  if (!selected.length) return { files: {}, count: 0, totalFiles: Object.keys(existingFiles || {}).length, skipped: 0, mediaCount: 0, renamedCount: 0 };

  const existing = existingFiles || {};
  const existingPaths = Object.keys(existing);
  const currentFileCount = existingPaths.length;
  const currentBytes = Object.values(existing).reduce((total, content) => total + contentBytes(content), 0);
  const archives = selected.filter((file) => String(file?.name || '').toLowerCase().endsWith('.zip'));
  const ordinaryFiles = selected.filter((file) => !String(file?.name || '').toLowerCase().endsWith('.zip'));
  const incoming = {};
  let skipped = 0;

  if (archives.length) {
    const result = await extractProjectZips(archives, { currentBytes, currentFiles: currentFileCount });
    Object.assign(incoming, result.files);
    skipped += result.skipped;
  }
  const archiveCollisions = Object.keys(incoming).filter((path) => Object.prototype.hasOwnProperty.call(existing, path));
  if (archiveCollisions.length) throw new Error(`${archiveCollisions.length} ZIP path${archiveCollisions.length === 1 ? '' : 's'} already attached (for example “${archiveCollisions[0]}”). Remove the existing file before adding a replacement.`);

  const occupied = new Set([...existingPaths, ...Object.keys(incoming)]);
  let byteCount = currentBytes + Object.values(incoming).reduce((total, content) => total + contentBytes(content), 0);
  let renamedCount = 0;
  const checkCapacity = (path, size) => {
    if (size > MAX_PROJECT_FILE_BYTES) throw new Error(`${path} is over the ${Math.round(MAX_PROJECT_FILE_BYTES / 1024 / 1024)} MB per-file limit.`);
    if (currentFileCount + Object.keys(incoming).length >= MAX_PROJECT_FILE_COUNT) throw new Error(`This project reached the ${MAX_PROJECT_FILE_COUNT.toLocaleString()}-file limit.`);
    if (byteCount + size > MAX_PROJECT_BYTES) throw new Error(`These attachments would exceed the ${Math.round(MAX_PROJECT_BYTES / 1024 / 1024)} MB project limit.`);
  };

  for (const file of ordinaryFiles) {
    const originalPath = String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
    if (!validateRelativePath(originalPath)) throw new Error(`${file.name || 'A selected file'} is not a safe project path.`);
    const path = occupied.has(originalPath) ? uniquePath(originalPath, occupied) : originalPath;
    if (path !== originalPath) renamedCount += 1;
    if (!validateRelativePath(path)) throw new Error(`${file.name} is not a safe project path.`);
    if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error(`${file.name} is over the ${Math.round(MAX_PROJECT_FILE_BYTES / 1024 / 1024)} MB per-file limit.`);

    const extension = String(file.name || '').split('.').at(-1)?.toLowerCase() || '';
    const mime = assetMime(file);
    let content;
    if (mime) {
      checkCapacity(path, file.size);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== file.size) checkCapacity(path, bytes.byteLength);
      content = encodeBinaryAsset(bytes, mime);
    } else {
      const supportedText = DIRECT_TEXT_EXTENSIONS.has(extension) || String(file.name || '').toLowerCase().endsWith('.env.example') || file.type?.startsWith('text/');
      if (!supportedText) throw new Error(`${file.name} is not a supported direct attachment. Add a common image/media/PDF or text/source file, or use a ZIP for a full project.`);
      checkCapacity(path, file.size);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`${file.name} is not valid UTF-8 text. Add it inside a ZIP archive if it is a binary project asset.`); }
      if (containsPossibleSecret(content)) throw new Error(`${file.name} appears to contain a credential. Remove secrets before attaching project files.`);
      const decodedBytes = encoder.encode(content).byteLength;
      if (decodedBytes !== file.size) checkCapacity(path, decodedBytes);
    }

    incoming[path] = content;
    occupied.add(path);
    byteCount += contentBytes(content);
  }

  const count = Object.keys(incoming).length;
  return {
    files: incoming,
    count,
    totalFiles: currentFileCount + count,
    skipped,
    mediaCount: Object.values(incoming).filter(isBinaryAsset).length,
    renamedCount,
  };
}
