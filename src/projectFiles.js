export const BINARY_ASSET_PREFIX = '\u0000STACKPILOT_BINARY_V1:';

export function isBinaryAsset(value) {
  return typeof value === 'string' && value.startsWith(BINARY_ASSET_PREFIX);
}

export function parseBinaryAsset(value) {
  if (!isBinaryAsset(value)) return null;
  const payload = value.slice(BINARY_ASSET_PREFIX.length);
  const splitAt = payload.indexOf(':');
  if (splitAt < 1) return null;
  const mime = payload.slice(0, splitAt);
  const base64 = payload.slice(splitAt + 1);
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) || !base64 || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return null;
  return { mime, base64 };
}

export function encodeBinaryAsset(bytes, mime = 'application/octet-stream') {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < array.length; offset += chunkSize) {
    binary += String.fromCharCode(...array.subarray(offset, offset + chunkSize));
  }
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(array).toString('base64');
  return `${BINARY_ASSET_PREFIX}${mime}:${base64}`;
}

export function binaryAssetByteLength(value) {
  const asset = parseBinaryAsset(value);
  if (!asset) return -1;
  return Math.floor(asset.base64.length * 3 / 4) - (asset.base64.endsWith('==') ? 2 : asset.base64.endsWith('=') ? 1 : 0);
}

export function binaryAssetDataUri(value) {
  const asset = parseBinaryAsset(value);
  return asset ? `data:${asset.mime};base64,${asset.base64}` : '';
}
