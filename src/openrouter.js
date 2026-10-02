export const OPENROUTER_FREE_MODEL = 'openrouter/free';

export function normalizeOpenRouterKeys(values = []) {
  const items = Array.isArray(values) ? values : [values];
  return [...new Set(items.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 2);
}

export function normalizeFreeModel(value = '') {
  const model = String(value || '').trim();
  if (model === OPENROUTER_FREE_MODEL || /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(model)) return model;
  return OPENROUTER_FREE_MODEL;
}

export function isOpenRouterRetryableStatus(status) {
  return [401, 402, 408, 409, 429, 500, 502, 503, 504].includes(Number(status));
}

export function errorMessageForModelStatus(status) {
  if (status === 401) return 'OpenRouter rejected this key. Check it in Settings.';
  if (status === 402) return 'OpenRouter returned a billing or free-quota limit. No paid model was selected; try again after the free quota resets.';
  if (status === 429) return 'OpenRouter free-model rate limit reached. The second key was tried if supplied; wait a little and retry.';
  return 'OpenRouter free routing is temporarily unavailable. No paid model was selected; retry later.';
}
