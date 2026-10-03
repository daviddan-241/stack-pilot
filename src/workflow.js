import { isBinaryAsset } from './projectFiles.js';

export const STEPS = [
  { id: 'organize', label: 'Architect', role: 'OpenRouter Free Architect', detail: 'Reads the complete text intake in bounded segments when model organization is needed.' },
  { id: 'preflight', label: 'Safety', role: 'Safety & Build Guard', detail: 'Checks paths, secrets, imports, and setup.' },
  { id: 'github', label: 'Release', role: 'GitHub Release Agent', detail: 'Commits the verified project and workflow.' },
  { id: 'runner', label: 'Build', role: 'Build & Test Agent', detail: 'Runs real tests and production build in GitHub Actions.' },
  { id: 'render', label: 'Deploy', role: 'Render Operator', detail: 'Starts only after GitHub checks pass.' },
];

const WEIGHTS = { organize: 16, preflight: 14, github: 22, runner: 25, render: 23 };
export function calculateProgress(steps = {}, status = '', reported = null) {
  if (status === 'live') return 100;
  if (Number.isFinite(Number(reported)) && Number(reported) > 0) return Math.max(1, Math.min(96, Math.round(Number(reported))));
  // Credit only a phase confirmed complete by its actual result; running and skipped phases add nothing.
  return Math.round(Object.entries(WEIGHTS).reduce((value, [step, weight]) => (
    steps[step] === 'done' ? value + weight : value
  ), 0));
}

export function detectEnvKeys(files = {}) {
  const found = new Set();
  const envExample = /(?:^|\/)(?:\.env(?:\.(?:example|sample|template|development|production))?|env\.example)$/i;
  const openRouterEnvPattern = /\b(OPENROUTER_API_KEY(?:_[12])?|OPENROUTER_MODEL|OPENROUTER_SITE_URL)\b/g;
  const keyPatterns = [
    /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm,
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bos\.getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    /\bENV\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  ];
  for (const [path, content] of Object.entries(files)) {
    if (isBinaryAsset(content)) continue;
    for (const match of String(content).matchAll(openRouterEnvPattern)) found.add(match[1]);
    if (envExample.test(path)) {
      for (const match of String(content).matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)) found.add(match[1]);
    }
    for (const pattern of keyPatterns.slice(1)) {
      for (const match of String(content).matchAll(pattern)) found.add(match[1]);
    }
  }
  return [...found].filter((key) => !['NODE_ENV', 'PORT'].includes(key)).sort().slice(0, 30).map((key) => ({ key, value: '' }));
}
