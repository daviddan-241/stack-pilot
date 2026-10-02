export const STEPS = [
  { id: 'organize', label: 'Architect', role: 'Project Architect', detail: 'Maps the dump into a clean, runnable project.' },
  { id: 'preflight', label: 'Safety', role: 'Safety & Build Guard', detail: 'Checks paths, secrets, imports, and setup.' },
  { id: 'github', label: 'Release', role: 'GitHub Release Agent', detail: 'Commits the verified project and workflow.' },
  { id: 'runner', label: 'Build', role: 'Build & Test Agent', detail: 'Runs real tests and production build in GitHub Actions.' },
  { id: 'render', label: 'Deploy', role: 'Render Operator', detail: 'Starts only after GitHub checks pass.' },
];

const WEIGHTS = { organize: 16, preflight: 14, github: 22, runner: 25, render: 23 };
export function calculateProgress(steps = {}, status = '', reported = null) {
  if (['live', 'verified'].includes(status)) return 100;
  if (Number.isFinite(Number(reported)) && Number(reported) > 0) return Math.max(1, Math.min(96, Math.round(Number(reported))));
  return Math.round(Object.entries(WEIGHTS).reduce((value, [step, weight]) => {
    if (steps[step] === 'done') return value + weight;
    if (steps[step] === 'running') return value + weight * 0.35;
    return value;
  }, 0));
}

export function detectEnvKeys(files = {}) {
  const found = new Set();
  const envExample = /(?:^|\/)(?:\.env(?:\.(?:example|sample|template|development|production))?|env\.example)$/i;
  const keyPatterns = [
    /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm,
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bos\.getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    /\bENV\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  ];
  for (const [path, content] of Object.entries(files)) {
    if (envExample.test(path)) {
      for (const match of String(content).matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)) found.add(match[1]);
    }
    for (const pattern of keyPatterns.slice(1)) {
      for (const match of String(content).matchAll(pattern)) found.add(match[1]);
    }
  }
  return [...found].filter((key) => !['NODE_ENV', 'PORT'].includes(key)).sort().slice(0, 30).map((key) => ({ key, value: '' }));
}
