export function normalizeMonitorUrl(value) {
  if (String(value || '').length > 2048) throw new Error('Monitor URL must be 2,048 characters or shorter.');
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('Enter a complete public HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Monitor URLs must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('URLs with embedded usernames or passwords are not accepted.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIpLiteral && isPrivateOrReservedAddress(host))) {
    throw new Error('Use a public website hostname, not localhost or an internal address.');
  }
  url.hash = '';
  return url.toString();
}

export function isPrivateOrReservedAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (value.includes('.')) {
    const octets = value.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || (a === 255 && b === 255);
  }
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || /^fec[0-f]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedAddress(mapped[1]);
  const mappedHex = value.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const upper = Number.parseInt(mappedHex[1], 16);
    const lower = Number.parseInt(mappedHex[2], 16);
    return isPrivateOrReservedAddress(`${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`);
  }
  return false;
}
