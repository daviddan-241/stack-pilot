export const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i,
  /\bsk-ant-api\d+-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\brnd_[A-Za-z0-9_-]{20,}\b/,
  /\brender_[A-Za-z0-9_-]{32,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

export function containsPossibleSecret(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(String(value || '')));
}

export function validateRelativePath(input) {
  if (typeof input !== 'string' || !input.trim()) return false;
  const value = input.trim().replaceAll('\\', '/');
  if (value.startsWith('/') || value.includes('\0') || /^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (parts.some((part) => part.toLowerCase() === '.git' || part.toLowerCase() === 'node_modules')) return false;
  const base = parts.at(-1).toLowerCase();
  if (base === '.env' || base.startsWith('.env.') && !base.endsWith('.example')) return false;
  if (['id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json'].includes(base)) return false;
  return true;
}
