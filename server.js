import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import AdmZip from 'adm-zip';
import webpush from 'web-push';
import { containsPossibleSecret, validateRelativePath } from './src/safety.js';
import { errorMessageForModelStatus, isOpenRouterRetryableStatus, normalizeFreeModel, normalizeOpenRouterKeys } from './src/openrouter.js';
import { isPrivateOrReservedAddress, normalizeMonitorUrl } from './src/monitor.js';
import { binaryAssetByteLength, encodeBinaryAsset, isBinaryAsset, parseBinaryAsset } from './src/projectFiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
let openRouterKeyCursor = 0;
const authFailures = new Map();
if (process.env.APP_PIN && !/^\d{4}$/.test(process.env.APP_PIN)) throw new Error('APP_PIN must be exactly four digits.');
const BODY_LIMIT = '12mb';
const GH_API = 'https://api.github.com';
const RENDER_API = 'https://api.render.com/v1';
const backgroundJobs = new Map();
const pushSubscriptions = new Map();
const notifiedExpiryDays = new Set();
const JOB_RETENTION_MS = 12 * 60 * 60 * 1000;
const MAX_JOB_LOGS = 300;
const BINARY_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' };
const vapidConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:stackpilot@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

app.disable('x-powered-by');
app.use(express.json({ limit: BODY_LIMIT }));

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function configuredAppSecret() { return process.env.APP_PIN || process.env.APP_PASSWORD || ''; }

const PROJECT_CREDENTIAL_ENV_FIELDS = {
  githubToken: 'GITHUB_TOKEN',
  renderToken: 'RENDER_API_TOKEN',
  openRouterKey1: 'OPENROUTER_API_KEY_1',
  openRouterKey2: 'OPENROUTER_API_KEY_2',
  renderOwnerId: 'RENDER_OWNER_ID',
};
function normalizeProjectId(value) {
  const projectId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) throw httpError('A valid project ID is required.');
  return projectId;
}
function projectCredentialEnvKey(projectId, field) {
  const suffix = PROJECT_CREDENTIAL_ENV_FIELDS[field];
  if (!suffix) throw httpError('Unsupported project credential field.');
  const idHash = createHash('sha256').update(normalizeProjectId(projectId)).digest('hex').slice(0, 20).toUpperCase();
  return `STACKPILOT_PROJECT_${idHash}_${suffix}`;
}
function readProjectCredentials(projectId) {
  const values = {};
  for (const field of Object.keys(PROJECT_CREDENTIAL_ENV_FIELDS)) values[field] = process.env[projectCredentialEnvKey(projectId, field)] || '';
  return values;
}
function projectCredentialStatus(projectId) {
  return Object.fromEntries(Object.keys(PROJECT_CREDENTIAL_ENV_FIELDS).map((field) => [field, Boolean(process.env[projectCredentialEnvKey(projectId, field)])]));
}

// Rate-limit failed PIN/password attempts in-process. Render restarts can clear
// this map; a short PIN is still weaker than a long passphrase.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || !configuredAppSecret()) return next();
  const client = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = authFailures.get(client);
  if (record?.blockedUntil > now) return res.status(429).json({ error: 'Too many incorrect workspace codes. Wait ten minutes and try again.' });
  const supplied = req.get('x-app-password') || '';
  if (!safeEqual(configuredAppSecret(), supplied)) {
    const current = record?.windowUntil > now ? record : { attempts: 0, windowUntil: now + 10 * 60 * 1000, blockedUntil: 0 };
    current.attempts += 1;
    if (current.attempts >= 8) current.blockedUntil = now + 10 * 60 * 1000;
    authFailures.set(client, current);
    return res.status(current.blockedUntil ? 429 : 401).json({ error: current.blockedUntil ? 'Too many incorrect workspace codes. Wait ten minutes and try again.' : 'Workspace locked. Enter the passcode on the lock screen.' });
  }
  authFailures.delete(client);
  next();
});

app.post('/api/auth/check', (_req, res) => res.json({ ok: true }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    authRequired: Boolean(configuredAppSecret()),
    appPinRequired: Boolean(process.env.APP_PIN),
    mode: process.env.NODE_ENV === 'production' ? 'cloud' : 'development',
    persistence: 'project-indexeddb-and-github-actions',
    envConfigured: {
      github: Boolean(process.env.GITHUB_TOKEN),
      render: Boolean(process.env.RENDER_API_TOKEN),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY_1 || process.env.OPENROUTER_API_KEY_2 || process.env.OPENROUTER_API_KEY),
    },
    renderOwnerId: process.env.RENDER_OWNER_ID || '',
    notificationsConfigured: vapidConfigured,
    githubTokenExpiresAt: process.env.GITHUB_TOKEN_EXPIRES_AT || '',
    serviceId: process.env.STACKPILOT_SERVICE_ID || process.env.RENDER_SERVICE_ID || '',
    uptimeUrl: '/api/health',
  });
});

app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.get('/uptime', (_req, res) => res.status(200).type('text/plain').send('ok'));

function normalizeFiles(input, { maxFiles = 300, maxTotal = 3_000_000 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError('Expected a map of relative file paths to file contents.');
  }
  const entries = Object.entries(input);
  if (!entries.length) throw httpError('The organizer returned no files. Add source code and try again.');
  if (entries.length > maxFiles) throw httpError(`Too many files. Limit is ${maxFiles}.`);
  const out = {};
  let total = 0;
  for (const [rawPath, rawContent] of entries) {
    const filePath = rawPath.trim().replaceAll('\\', '/');
    if (!validateRelativePath(filePath)) throw httpError(`Unsafe or unsupported file path: ${rawPath}`);
    if (typeof rawContent !== 'string') throw httpError(`File contents must be text or a validated binary asset: ${rawPath}`);
    let bytes;
    if (isBinaryAsset(rawContent)) {
      const parsed = parseBinaryAsset(rawContent);
      bytes = binaryAssetByteLength(rawContent);
      if (!parsed || bytes < 0) throw httpError(`Binary asset encoding is invalid: ${rawPath}`);
    } else bytes = Buffer.byteLength(rawContent, 'utf8');
    if (bytes > 750_000) throw httpError(`File is too large: ${rawPath}`);
    total += bytes;
    if (total > maxTotal) throw httpError('Project is too large to process in one pass (3 MB total raw file limit).');
    out[filePath] = rawContent;
  }
  return out;
}

async function callOpenRouter({ apiKeys, model, system, user, maxTokens = 7000 }) {
  const keys = normalizeOpenRouterKeys([
    ...(Array.isArray(apiKeys) ? apiKeys : []),
    process.env.OPENROUTER_API_KEY_1,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY,
  ]);
  if (!keys.length) throw httpError('Add one or two OpenRouter keys in Settings to use the $0 free-model router.');
  const selectedModel = normalizeFreeModel(model || process.env.OPENROUTER_MODEL);
  const startIndex = openRouterKeyCursor % keys.length;
  openRouterKeyCursor = (openRouterKeyCursor + 1) % keys.length;
  let lastStatus = 503;

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const key = keys[(startIndex + attempt) % keys.length];
    let response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'http-referer': process.env.OPENROUTER_SITE_URL || 'https://stack-pilot-builder.onrender.com',
          'x-title': 'StackPilot',
        },
        body: JSON.stringify({
          model: selectedModel,
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      lastStatus = 503;
      if (attempt + 1 < keys.length) continue;
      throw httpError('OpenRouter could not be reached. No paid model was selected; check connectivity and retry.', 503);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastStatus = response.status;
      if (!isOpenRouterRetryableStatus(response.status)) {
        const detail = String(data?.error?.message || '').slice(0, 240);
        throw httpError(`OpenRouter request failed${detail ? `: ${detail}` : ` (HTTP ${response.status})`}.`, response.status >= 500 ? 502 : 400);
      }
      if (response.status === 429 && attempt + 1 < keys.length) {
        const retryAfter = Math.min(1500, Math.max(0, Number(response.headers.get('retry-after') || 0) * 1000));
        if (retryAfter) await new Promise((resolve) => setTimeout(resolve, retryAfter));
      }
      continue;
    }
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text || '').join('\n') : '';
    if (text.trim()) return text;
    lastStatus = 502;
  }
  throw httpError(`${errorMessageForModelStatus(lastStatus)} Free models have shared, limited quotas; rotating two keys cannot guarantee extra quota.`, 503);
}

function parseJsonResponse(text) {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw httpError('OpenRouter did not return the expected project JSON. Try again with a shorter request.', 502);
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw httpError('OpenRouter returned malformed JSON for the file map. Try a smaller code dump or retry the free model.', 502);
  }
}

app.post('/api/organize', async (req, res, next) => {
  try {
    const { input, projectName, model } = req.body || {};
    const apiKeys = normalizeOpenRouterKeys(req.body?.apiKeys || [req.body?.apiKey1, req.body?.apiKey2]);
    const suppliedFiles = req.body?.files && Object.keys(req.body.files).length ? normalizeFiles(req.body.files) : {};
    const modelFiles = Object.fromEntries(Object.entries(suppliedFiles).filter(([, content]) => !isBinaryAsset(content)));
    if (typeof input !== 'string' || !input.trim()) throw httpError('Add a short project brief or code dump first.');
    if (input.length > 40_000) throw httpError('Keep the project prompt under 40,000 characters to preserve free-model context.');
    if (containsPossibleSecret(input) || Object.values(modelFiles).some(containsPossibleSecret)) throw httpError('A live credential was detected. Remove or rotate it before sending source to OpenRouter.');
    const sourceBytes = Object.values(modelFiles).reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
    if (sourceBytes > 60_000) throw httpError('This project is too large for the free-model organize step (60 KB source limit). Use the ZIP/repository import, edit the files, and run the GitHub checks directly.');
    const system = [
      'You are StackPilot, a concise senior software engineer. Convert the user brief and any supplied source files into a coherent, runnable project.',
      'Return strict JSON with this shape: {"files":{"relative/path":"full file contents"},"summary":"short description","stack":"detected stack","deployType":"web_service or static_site","runtime":"node, python, ruby, go, or elixir","buildCommand":"... or empty","startCommand":"... or empty","publishPath":"dist, public, or .","testCommand":"... or empty","notes":["..." ]}.',
      'If existing files are supplied, preserve them and return only files that need to be added or changed. If no files are supplied, return the full minimal project. Preserve the intended behavior and finish only obvious gaps; never invent unrequested business logic.',
      'Use environment-variable placeholders only. Never create real credentials, .env secrets, production data, dependency folders, or binary files. Keep relative paths safe and use forward slashes.',
      'Choose the runtime, build command, start command, and static/web-service type from the actual project. Prefer small dependency sets and standard scripts to conserve free model output.',
      'Be accurate about assumptions and leave a short TODO when a required decision cannot be inferred. Do not claim tests or deployments have run. Output valid JSON only.',
    ].join('\n');
    const fileContext = Object.keys(modelFiles).length ? `\n\nCurrent text source files (JSON; return only changed/new files):\n${JSON.stringify(modelFiles)}` : '';
    const user = `Project name: ${String(projectName || 'new-project').slice(0, 80)}\n\nTask / code dump:\n${input}${fileContext}`;
    const raw = await callOpenRouter({ apiKeys, model, system, user, maxTokens: Object.keys(modelFiles).length ? 5000 : 7000 });
    const parsed = parseJsonResponse(raw);
    const files = parsed.files && Object.keys(parsed.files).length ? normalizeFiles(parsed.files) : {};
    if (!Object.keys(files).length && !Object.keys(suppliedFiles).length) throw httpError('The free model returned no files. Retry once or use the ZIP import path.', 502);
    res.json({
      files,
      summary: String(parsed.summary || 'Project files reviewed by the free OpenRouter model.').slice(0, 1200),
      stack: String(parsed.stack || 'Detected from source').slice(0, 120),
      deployType: parsed.deployType === 'static_site' ? 'static_site' : 'web_service',
      runtime: ['node', 'python', 'ruby', 'go', 'elixir'].includes(parsed.runtime) ? parsed.runtime : 'node',
      buildCommand: String(parsed.buildCommand || '').slice(0, 300),
      startCommand: String(parsed.startCommand || '').slice(0, 300),
      publishPath: String(parsed.publishPath || (parsed.deployType === 'static_site' && !parsed.buildCommand ? '.' : 'dist')).slice(0, 200),
      testCommand: String(parsed.testCommand || '').slice(0, 300),
      notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 12).map((n) => String(n).slice(0, 400)) : [],
    });
  } catch (error) { next(error); }
});

app.post('/api/repair', async (req, res, next) => {
  try {
    const { files: originalFiles, errors, model } = req.body || {};
    const apiKeys = normalizeOpenRouterKeys(req.body?.apiKeys || [req.body?.apiKey1, req.body?.apiKey2]);
    const files = normalizeFiles(originalFiles);
    const textFiles = Object.fromEntries(Object.entries(files).filter(([, content]) => !isBinaryAsset(content)));
    if (Object.values(textFiles).some(containsPossibleSecret)) throw httpError('A project file appears to contain a live credential. Remove or rotate it before sending source to OpenRouter.');
    if (!Object.keys(files).length || Object.values(textFiles).reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0) > 60_000) throw httpError('Free-model repairs are limited to projects with at most 60 KB of text source.');
    if (typeof errors !== 'string' || !errors.trim()) throw httpError('No build or test error log was supplied.');
    if (errors.length > 20_000) throw httpError('Error log is too large; keep the last 20,000 characters to conserve free-model quota.');
    if (containsPossibleSecret(errors)) throw httpError('The error log appears to contain a live credential. Rotate it before sharing logs with OpenRouter.');
    const system = [
      'You are StackPilot, a focused build-failure repair engineer.',
      'Use the supplied files and real build/test logs. Make the smallest evidence-based fix; preserve intended behavior. Do not add secrets or unrelated features.',
      'Return strict JSON shaped as {"files":{"relative/path":"full updated file contents"},"summary":"what changed","notes":["remaining caveats"]}. Include changed/new files only.',
      'Use safe relative paths. Never create .env secrets, credentials, binary artifacts, or dependency folders. Do not claim the repair passed until the runner verifies it. Output valid JSON only.',
    ].join('\n');
    const user = `Build/test error log:\n${errors.slice(-20_000)}\n\nCurrent text source files (JSON; binary assets are preserved outside the model call):\n${JSON.stringify(textFiles)}`;
    const raw = await callOpenRouter({ apiKeys, model, system, user, maxTokens: 4500 });
    const parsed = parseJsonResponse(raw);
    const changed = parsed.files && Object.keys(parsed.files).length ? normalizeFiles(parsed.files) : {};
    if (!Object.keys(changed).length) throw httpError('The free model could not identify a concrete repair from these logs.', 422);
    res.json({ files: changed, summary: String(parsed.summary || 'Applied a targeted fix suggestion.').slice(0, 1200), notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 12) : [] });
  } catch (error) { next(error); }
});

function inspectProject(files) {
  const findings = [];
  let totalBytes = 0;
  for (const [filePath, content] of Object.entries(files)) {
    if (!validateRelativePath(filePath)) findings.push({ severity: 'error', message: `Unsafe path: ${filePath}` });
    totalBytes += isBinaryAsset(content) ? Math.max(0, binaryAssetByteLength(content)) : Buffer.byteLength(content, 'utf8');
    if (!isBinaryAsset(content) && containsPossibleSecret(content)) {
      findings.push({ severity: 'error', message: `Possible live secret detected in ${filePath}; remove it before sending or committing this file.` });
    }
  }
  if (Object.keys(files).length > 300) findings.push({ severity: 'error', message: 'Project has more than 300 files.' });
  if (totalBytes > 3_000_000) findings.push({ severity: 'error', message: 'Project exceeds the 3 MB total file limit.' });

  let pkg = null;
  if (files['package.json']) {
    try { pkg = JSON.parse(files['package.json']); }
    catch { findings.push({ severity: 'error', message: 'package.json is not valid JSON.' }); }
  }
  if (pkg && typeof pkg === 'object') {
    const scripts = pkg.scripts || {};
    if (!scripts.start && !scripts.preview && !files['index.html']) {
      findings.push({ severity: 'warning', message: 'No start script found. A Render web service needs a working start command.' });
    }
    if (!scripts.build && (pkg.dependencies?.vite || pkg.devDependencies?.vite || pkg.dependencies?.next || pkg.dependencies?.react)) {
      findings.push({ severity: 'warning', message: 'No build script found in package.json.' });
    }
  }

  const pathSet = new Set(Object.keys(files));
  const importPattern = /(?:from\s*|import\s*|require\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const [fromPath, content] of Object.entries(files)) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(fromPath)) continue;
    let match;
    while ((match = importPattern.exec(content))) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), match[1]));
      const candidates = [base, ...['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'].map((ext) => `${base}${ext}`), ...['index.js', 'index.jsx', 'index.ts', 'index.tsx'].map((name) => path.posix.join(base, name))];
      if (!candidates.some((candidate) => pathSet.has(candidate))) {
        findings.push({ severity: 'warning', message: `Relative import may be missing: ${fromPath} → ${match[1]}` });
      }
    }
  }

  if (!Object.keys(files).length) findings.push({ severity: 'error', message: 'No source files found.' });
  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    files: Object.keys(files).length,
    bytes: totalBytes,
    packageScripts: pkg?.scripts || {},
    findings,
    note: 'Preflight is static analysis only. The real build/test runs in a temporary GitHub Actions runner after the commit.',
  };
}

app.post('/api/validate', (req, res, next) => {
  try {
    const files = normalizeFiles(req.body?.files);
    res.json(inspectProject(files));
  } catch (error) { next(error); }
});

function stackPilotWorkflow() {
  return `name: StackPilot project checks
on:
  push:
  workflow_dispatch:
    inputs:
      mode:
        description: Verify the project or run a shell command
        required: true
        type: choice
        options:
          - verify
          - shell
        default: verify
      command:
        description: Command for the temporary runner (only used in shell mode)
        required: false
        type: string
        default: npm run build --if-present && npm test --if-present
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout source
        uses: actions/checkout@v5
        with:
          persist-credentials: false
      - name: Set up Node
        if: github.event_name == 'workflow_dispatch' || hashFiles('package.json') != ''
        uses: actions/setup-node@v7
        with:
          node-version: '22'
      - name: Set up Python
        if: github.event_name == 'push' && (hashFiles('requirements.txt') != '' || hashFiles('pyproject.toml') != '')
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Run requested shell command
        if: github.event_name == 'workflow_dispatch' && inputs.mode == 'shell'
        env:
          USER_COMMAND: \${{ inputs.command }}
        run: |
          if [ -z "$USER_COMMAND" ]; then echo "No command provided"; exit 1; fi
          echo "$ $USER_COMMAND"
          bash -lc "$USER_COMMAND"
      - name: Install, build and test Node project
        if: github.event_name == 'push' && hashFiles('package.json') != ''
        run: |
          npm install --no-audit --no-fund
          npm run build --if-present
          npm test --if-present
      - name: Install and check Python project
        if: github.event_name == 'push' && (hashFiles('requirements.txt') != '' || hashFiles('pyproject.toml') != '')
        run: |
          if [ -f requirements.txt ]; then python -m pip install -r requirements.txt; fi
          if [ -f pyproject.toml ]; then python -m pip install -e .; fi
          python -m compileall -q .
          if [ -d tests ]; then python -m pip install pytest && python -m pytest -q; fi
      - name: Set up Ruby
        if: github.event_name == 'push' && (hashFiles('Gemfile') != '' || hashFiles('**/*.rb') != '')
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.3'
      - name: Run Ruby checks
        if: github.event_name == 'push' && (hashFiles('Gemfile') != '' || hashFiles('**/*.rb') != '')
        run: |
          if [ -f Gemfile ]; then bundle install; fi
          find . -type f -name '*.rb' -not -path './vendor/*' -print0 | xargs -0 -r -n1 ruby -c
          if [ -f Rakefile ]; then gem install rake --no-document && rake; fi
      - name: Set up Elixir
        if: github.event_name == 'push' && hashFiles('mix.exs') != ''
        uses: erlef/setup-beam@v1
        with:
          elixir-version: '1.18'
          otp-version: '27'
      - name: Run Elixir checks
        if: github.event_name == 'push' && hashFiles('mix.exs') != ''
        run: mix local.hex --force && mix deps.get && mix test && mix compile --warnings-as-errors
      - name: Set up Rust
        if: github.event_name == 'push' && hashFiles('Cargo.toml') != ''
        uses: dtolnay/rust-toolchain@stable
      - name: Run Rust checks
        if: github.event_name == 'push' && hashFiles('Cargo.toml') != ''
        run: cargo test --workspace && cargo build --workspace
      - name: Report static project
        if: github.event_name == 'push' && hashFiles('package.json') == '' && hashFiles('requirements.txt') == '' && hashFiles('pyproject.toml') == '' && hashFiles('go.mod') == '' && hashFiles('Gemfile') == '' && hashFiles('**/*.rb') == '' && hashFiles('mix.exs') == '' && hashFiles('Cargo.toml') == ''
        run: |
          if [ -f index.html ] || find . -maxdepth 4 -type f -name '*.html' -print -quit | grep -q .; then
            echo "Static HTML project detected; ready for Static Site hosting."
          else
            echo "No supported project check runner matched these files. Add a supported build manifest or run a command from StackPilot's remote shell." >&2
            exit 1
          fi
`;
}

function parseGithubRepo(input) {
  const normalized = String(input || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length !== 2 || !/^[A-Za-z0-9_.-]{1,39}$/.test(parts[0]) || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1])) {
    throw httpError('Enter a GitHub repository as owner/repo (or paste its GitHub URL).');
  }
  return { owner: parts[0], repo: parts[1] };
}

async function mapLimit(items, limit, handler) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await handler(items[index], index);
    }
  }));
  return result;
}

async function githubRequest(token, endpoint, options = {}) {
  const response = await fetch(`${GH_API}${endpoint}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const contentType = response.headers.get('content-type') || '';
  let data;
  if (contentType.includes('json')) data = await response.json().catch(() => ({}));
  else if (response.status !== 204) data = await response.text().catch(() => '');
  if (!response.ok) {
    const message = data?.message || (typeof data === 'string' ? data.slice(0, 300) : '') || `GitHub returned HTTP ${response.status}.`;
    throw httpError(`GitHub ${response.status}: ${message}`, response.status === 401 ? 401 : response.status === 403 ? 403 : 502);
  }
  return { data, response };
}

app.post('/api/openrouter/test', async (req, res, next) => {
  try {
    const keys = normalizeOpenRouterKeys(req.body?.apiKeys || [req.body?.key1, req.body?.key2, process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2, process.env.OPENROUTER_API_KEY]);
    if (!keys.length) throw httpError('Enter at least one OpenRouter key first.');
    let lastStatus = 401;
    for (const key of keys) {
      const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        const info = body.data || body;
        return res.json({ ok: true, label: info.label || '', isFreeTier: Boolean(info.is_free_tier), remainingFreeRequests: info.free_model_daily_requests?.remaining ?? null, freeRequestLimit: info.free_model_daily_requests?.limit ?? null, message: 'OpenRouter key accepted. The free model router can still be rate-limited or temporarily unavailable.' });
      }
      lastStatus = response.status;
      if (response.status !== 401 && response.status !== 429) break;
    }
    throw httpError(lastStatus === 429 ? 'OpenRouter key check is rate-limited. Wait and retry.' : 'OpenRouter did not accept either key. Check the key values and account access.', lastStatus === 401 ? 401 : 502);
  } catch (error) { next(error); }
});

app.post('/api/github/me', async (req, res, next) => {
  try {
    const token = req.body?.token || process.env.GITHUB_TOKEN;
    if (!token) throw httpError('Add a GitHub token in Settings or configure GITHUB_TOKEN on the StackPilot server.');
    const { data } = await githubRequest(token, '/user');
    res.json({ login: data.login, avatarUrl: data.avatar_url, htmlUrl: data.html_url });
  } catch (error) { next(error); }
});

app.post('/api/github/import', async (req, res, next) => {
  try {
    const token = req.body?.token || process.env.GITHUB_TOKEN;
    if (!token) throw httpError('Add a GitHub token in Settings before importing a repository.');
    const { owner, repo } = parseGithubRepo(req.body?.repository);
    const { data: repoInfo } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    const branch = String(req.body?.branch || repoInfo.default_branch || 'main').trim();
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes('..')) throw httpError('Invalid branch name.');
    const refPath = branch.split('/').map(encodeURIComponent).join('/');
    const { data: ref } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${refPath}`);
    const { data: treeData } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref.object.sha)}?recursive=1`);
    if (treeData.truncated) throw httpError('This repository is too large to import in one pass. Use its ZIP download and keep source files under the project limit.', 413);
    const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', 'vendor', '__pycache__']);
    const blobs = (treeData.tree || []).filter((entry) => entry.type === 'blob' && entry.size <= 750_000 && validateRelativePath(entry.path) && !entry.path.split('/').some((part) => ignored.has(part.toLowerCase()))).slice(0, 301);
    if (blobs.length > 300) throw httpError('Repository has more than 300 importable source files. Reduce generated/dependency content and retry.', 413);
    const files = {};
    let totalBytes = 0;
    let skipped = (treeData.tree || []).length - blobs.length;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, blobs.length) }, async () => {
      while (cursor < blobs.length) {
        const index = cursor++;
        const entry = blobs[index];
        const { data: blob } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(entry.sha)}`);
        if (blob.encoding !== 'base64' || !blob.content) { skipped += 1; continue; }
        const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
        const extension = entry.path.split('.').at(-1)?.toLowerCase();
        const mime = BINARY_MIME[extension];
        if (mime) {
          if (bytes.length > 750_000) { skipped += 1; continue; }
          totalBytes += bytes.length;
          if (totalBytes > 3_000_000) throw httpError('Repository source exceeds the 3 MB total file limit. Use a smaller branch or remove generated files.', 413);
          files[entry.path] = encodeBinaryAsset(bytes, mime);
          continue;
        }
        if (bytes.includes(0)) { skipped += 1; continue; }
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { skipped += 1; continue; }
        if (containsPossibleSecret(text)) throw httpError(`A possible live credential is present in ${entry.path}. Remove or rotate it before importing.`, 422);
        totalBytes += bytes.length;
        if (totalBytes > 3_000_000) throw httpError('Repository source exceeds the 3 MB total file limit. Use a smaller branch or remove generated files.', 413);
        files[entry.path] = text;
      }
    });
    await Promise.all(workers);
    const normalized = normalizeFiles(files);
    res.json({ repository: `${owner}/${repo}`, branch, defaultBranch: repoInfo.default_branch || branch, files: normalized, count: Object.keys(normalized).length, skipped, url: repoInfo.html_url || `https://github.com/${owner}/${repo}` });
  } catch (error) { next(error); }
});

app.post('/api/github/push', async (req, res, next) => {
  try {
    const { repository, branch, files: rawFiles, createIfMissing = true, isPrivate = true } = req.body || {};
    const token = req.body?.token || process.env.GITHUB_TOKEN;
    if (!token) throw httpError('Add a GitHub token in Settings or configure GITHUB_TOKEN on the StackPilot server.');
    const { owner, repo } = parseGithubRepo(repository);
    const files = normalizeFiles(rawFiles);
    if (Object.values(files).some((content) => !isBinaryAsset(content) && containsPossibleSecret(content))) throw httpError('A project file appears to contain a live credential. Remove or rotate it before pushing to GitHub.');
    const workflowPath = '.github/workflows/stackpilot-ci.yml';
    const workflowContent = stackPilotWorkflow();
    files[workflowPath] = workflowContent;

    let repoData;
    try {
      ({ data: repoData } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`));
    } catch (error) {
      if (error.status !== 502 || !String(error.message).includes('404')) throw error;
      if (!createIfMissing) throw httpError(`Repository ${owner}/${repo} was not found. Enable create repository or create it first.`, 404);
      const { data: me } = await githubRequest(token, '/user');
      const createPath = me.login?.toLowerCase() === owner.toLowerCase()
        ? '/user/repos'
        : `/orgs/${encodeURIComponent(owner)}/repos`;
      try {
        ({ data: repoData } = await githubRequest(token, createPath, {
          method: 'POST',
          body: JSON.stringify({
            name: repo,
            description: 'Created and managed with StackPilot',
            private: Boolean(isPrivate),
            auto_init: true,
          }),
        }));
      } catch (createError) {
        throw httpError(`Could not create ${owner}/${repo}. Check the token's repository-creation permission, or create an empty repository first. ${createError.message}`, 403);
      }
    }

    let selectedBranch = String(branch || repoData.default_branch || 'main').trim();
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(selectedBranch) || selectedBranch.includes('..')) throw httpError('Invalid branch name.');
    const branchRefPath = (value) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${value.split('/').map(encodeURIComponent).join('/')}`;
    let refData = null;
    let branchExists = true;
    try {
      ({ data: refData } = await githubRequest(token, branchRefPath(selectedBranch)));
    } catch (error) {
      if (error.status !== 502 || !String(error.message).includes('404')) throw error;
      branchExists = false;
      const defaultBranch = repoData.default_branch || '';
      if (selectedBranch === 'main' && defaultBranch && defaultBranch !== 'main') {
        selectedBranch = defaultBranch;
        try { ({ data: refData } = await githubRequest(token, branchRefPath(selectedBranch))); branchExists = true; }
        catch (fallbackError) { if (fallbackError.status !== 502 || !String(fallbackError.message).includes('404')) throw fallbackError; }
      } else if (defaultBranch && selectedBranch !== defaultBranch) {
        try { ({ data: refData } = await githubRequest(token, branchRefPath(defaultBranch))); }
        catch (fallbackError) { if (fallbackError.status !== 502 || !String(fallbackError.message).includes('404')) throw fallbackError; }
      }
    }

    let baseTree;
    const parents = [];
    if (refData?.object?.sha) {
      const parentSha = refData.object.sha;
      const { data: parentCommit } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${parentSha}`);
      baseTree = parentCommit.tree.sha;
      parents.push(parentSha);
    }
    const tree = await mapLimit(Object.entries(files), 8, async ([filePath, content]) => {
      if (!isBinaryAsset(content)) return { path: filePath, mode: '100644', type: 'blob', content };
      const asset = parseBinaryAsset(content);
      const { data: blob } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: asset.base64, encoding: 'base64' }) });
      return { path: filePath, mode: '100644', type: 'blob', sha: blob.sha };
    });
    const treeBody = { tree };
    if (baseTree) treeBody.base_tree = baseTree;
    const { data: nextTree } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {
      method: 'POST', body: JSON.stringify(treeBody),
    });
    const { data: commit } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message: 'StackPilot: organize and verify project', tree: nextTree.sha, parents }),
    });
    if (branchExists) {
      await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${selectedBranch.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }),
      });
    } else {
      await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
        method: 'POST', body: JSON.stringify({ ref: `refs/heads/${selectedBranch}`, sha: commit.sha }),
      });
    }

    res.json({
      owner, repo, branch: selectedBranch,
      url: repoData.html_url || `https://github.com/${owner}/${repo}`,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
      commitSha: commit.sha,
      fileCount: Object.keys(files).length,
      automationFilePath: workflowPath,
      automationFileContent: workflowContent,
    });
  } catch (error) { next(error); }
});

app.post('/api/github/dispatch', async (req, res, next) => {
  try {
    const { repository, branch, command } = req.body || {};
    const projectToken = req.body?.projectId ? readProjectCredentials(req.body.projectId).githubToken : '';
    const token = req.body?.token || projectToken || process.env.GITHUB_TOKEN;
    if (!token) throw httpError('Add a GitHub token in Settings or configure GITHUB_TOKEN on the StackPilot server.');
    const { owner, repo } = parseGithubRepo(repository);
    const shellCommand = String(command || '').trim();
    if (!shellCommand) throw httpError('Enter a command to run.');
    if (shellCommand.length > 700) throw httpError('Keep shell commands under 700 characters.');
    const workflow = '/actions/workflows/stackpilot-ci.yml/dispatches';
    await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${workflow}`, {
      method: 'POST', body: JSON.stringify({ ref: branch || 'main', inputs: { mode: 'shell', command: shellCommand } }),
    });
    res.status(202).json({ accepted: true, message: 'Command sent to a temporary GitHub Actions runner.' });
  } catch (error) { next(error); }
});

async function readGithubRunLogs(token, owner, repo, runId) {
  const response = await fetch(`${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/logs`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 20_000_000) return '[GitHub log archive exceeded the 20 MB display limit.]';
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory && /\.txt$/i.test(entry.entryName));
    const text = entries.map((entry) => `--- ${entry.entryName} ---\n${entry.getData().toString('utf8')}`).join('\n');
    return text.slice(-45_000);
  } catch {
    return '';
  }
}

app.post('/api/github/runs', async (req, res, next) => {
  try {
    const { repository, branch, since } = req.body || {};
    const projectToken = req.body?.projectId ? readProjectCredentials(req.body.projectId).githubToken : '';
    const token = req.body?.token || projectToken || process.env.GITHUB_TOKEN;
    if (!token) throw httpError('Add a GitHub token in Settings or configure GITHUB_TOKEN on the StackPilot server.');
    const { owner, repo } = parseGithubRepo(repository);
    const params = new URLSearchParams({ per_page: '15' });
    if (branch) params.set('branch', branch);
    const { data } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${params}`);
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const cutoff = since ? Date.parse(since) - 15_000 : 0;
    const run = runs.find((item) => Date.parse(item.created_at || '') >= cutoff) || (cutoff ? null : runs[0]);
    if (!run) return res.json({ found: false, status: 'waiting', message: 'Waiting for GitHub Actions to start. Check that Actions are enabled for this repository.' });
    const { data: jobsData } = await githubRequest(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run.id}/jobs?per_page=100`);
    const jobs = (jobsData.jobs || []).map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at }));
    const logs = run.status === 'completed' ? await readGithubRunLogs(token, owner, repo, run.id) : '';
    res.json({
      found: true, runId: run.id, name: run.name, event: run.event,
      status: run.status, conclusion: run.conclusion, createdAt: run.created_at,
      url: run.html_url, branch: run.head_branch, jobs, logs,
    });
  } catch (error) { next(error); }
});

function normalizeRenderEnvVars(envVars, { protectOwnService = false } = {}) {
  if (!Array.isArray(envVars) || envVars.length > 30) throw httpError('Supply up to 30 environment variables.');
  const reserved = new Set(['PORT', 'GITHUB_TOKEN', 'RENDER_API_TOKEN', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_1', 'OPENROUTER_API_KEY_2', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'STACKPILOT_SERVICE_ID']);
  if (protectOwnService) ['APP_PASSWORD', 'APP_PIN', 'GITHUB_TOKEN_EXPIRES_AT', 'OPENROUTER_MODEL'].forEach((key) => reserved.add(key));
  const output = envVars.map((item) => ({ key: String(item?.key || '').trim(), value: String(item?.value ?? '') })).filter((item) => item.key);
  for (const item of output) {
    if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(item.key)) throw httpError(`Invalid environment variable name: ${item.key}`);
    if (item.key === 'PORT') throw httpError('PORT is reserved by Render.');
    if (reserved.has(item.key) || item.key.startsWith('STACKPILOT_PROJECT_')) throw httpError(`${item.key} is reserved for StackPilot's server-side platform keys. Use the project platform-key card instead.`);
    if (item.value.length > 2000) throw httpError(`${item.key} exceeds the 2,000 character limit.`);
  }
  return output;
}

async function renderRequest(token, endpoint, options = {}) {
  const response = await fetch(`${RENDER_API}${endpoint}`, {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || data?.error || `Render returned HTTP ${response.status}.`;
    throw httpError(`Render ${response.status}: ${message}`, response.status === 401 ? 401 : response.status === 403 ? 403 : 502);
  }
  return data;
}

app.post('/api/render/test', async (req, res, next) => {
  try {
    const token = req.body?.token || process.env.RENDER_API_TOKEN;
    if (!token) throw httpError('Add a Render API key in Settings or configure RENDER_API_TOKEN on the StackPilot server.');
    const data = await renderRequest(token, '/services?limit=1');
    res.json({ ok: true, message: 'Render API key accepted.', visibleServices: Array.isArray(data) ? data.length : 0 });
  } catch (error) { next(error); }
});

app.post('/api/render/disable-autodeploy', async (req, res, next) => {
  try {
    const token = req.body?.token || process.env.RENDER_API_TOKEN;
    const serviceId = String(req.body?.serviceId || '').trim();
    if (!token) throw httpError('Add a Render API key before using an existing service with GitHub checks.');
    if (!serviceId || serviceId.length > 120) throw httpError('Enter a valid existing Render service ID.');
    const data = await renderRequest(token, `/services/${encodeURIComponent(serviceId)}`, { method: 'PATCH', body: JSON.stringify({ autoDeployTrigger: 'off' }) });
    res.json({ ok: true, autoDeployTrigger: data.autoDeployTrigger || 'off' });
  } catch (error) { next(error); }
});

app.post('/api/render/create', async (req, res, next) => {
  try {
    const {
      repository, branch, name, serviceType = 'web_service', runtime = 'node', region = 'frankfurt',
      buildCommand, startCommand, publishPath = 'dist', rootDir = '', envVars = [],
    } = req.body || {};
    const ownerId = req.body?.ownerId || process.env.RENDER_OWNER_ID;
    const token = req.body?.token || process.env.RENDER_API_TOKEN;
    if (!token) throw httpError('Add a Render API key in Settings or configure RENDER_API_TOKEN on the StackPilot server.');
    if (!ownerId) throw httpError('Enter the Render workspace/owner ID in Settings.');
    const { owner, repo } = parseGithubRepo(repository);
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const serviceName = String(name || repo).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 55) || 'stackpilot-app';
    const isStatic = serviceType === 'static_site';
    const safeEnv = normalizeRenderEnvVars(envVars);
    const payload = {
      type: isStatic ? 'static_site' : 'web_service',
      name: serviceName,
      ownerId,
      repo: repoUrl,
      branch: branch || 'main',
      rootDir: rootDir || undefined,
      autoDeployTrigger: 'off',
      envVars: safeEnv,
      serviceDetails: isStatic
        ? { buildCommand: String(buildCommand || 'npm install && npm run build').slice(0, 500), publishPath: String(publishPath || 'dist').slice(0, 200) }
        : {
            runtime: ['node', 'python', 'ruby', 'go', 'elixir'].includes(runtime) ? runtime : 'node',
            plan: 'free',
            region: ['frankfurt', 'singapore', 'oregon', 'ohio', 'virginia'].includes(region) ? region : 'frankfurt',
            numInstances: 1,
            envSpecificDetails: {
              buildCommand: String(buildCommand || 'npm install').slice(0, 500),
              startCommand: String(startCommand || 'npm start').slice(0, 500),
            },
          },
    };
    if (!rootDir) delete payload.rootDir;
    const data = await renderRequest(token, '/services', { method: 'POST', body: JSON.stringify(payload) });
    const service = data.service || data;
    const url = service.serviceDetails?.url || service.url || (service.slug ? `https://${service.slug}.onrender.com` : '');
    res.json({
      serviceId: service.id,
      name: service.name || serviceName,
      url,
      dashboardUrl: service.dashboardUrl || '',
      deployId: data.deployId || '',
      branch: service.branch || branch || 'main',
      serviceType,
      message: 'Render service created. Its first build has been queued.',
    });
  } catch (error) { next(error); }
});

app.post('/api/render/deploy', async (req, res, next) => {
  try {
    const { serviceId, commitId, clearCache = false } = req.body || {};
    const token = req.body?.token || process.env.RENDER_API_TOKEN;
    if (!token || !serviceId) throw httpError('A Render token and service ID are required.');
    const body = { clearCache: clearCache ? 'clear' : 'do_not_clear' };
    if (commitId) body.commitId = commitId;
    const deploy = await renderRequest(token, `/services/${encodeURIComponent(serviceId)}/deploys`, { method: 'POST', body: JSON.stringify(body) });
    res.json({ deployId: deploy.id, status: deploy.status || 'created', createdAt: deploy.createdAt || new Date().toISOString() });
  } catch (error) { next(error); }
});

app.post('/api/render/status', async (req, res, next) => {
  try {
    const { serviceId, deployId } = req.body || {};
    const token = req.body?.token || process.env.RENDER_API_TOKEN;
    if (!token || !serviceId) throw httpError('A Render token and service ID are required.');
    let deploy;
    if (deployId) {
      deploy = await renderRequest(token, `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`);
    } else {
      const rows = await renderRequest(token, `/services/${encodeURIComponent(serviceId)}/deploys?limit=10`);
      const list = Array.isArray(rows) ? rows : rows.items || [];
      deploy = list[0]?.deploy || list[0] || null;
    }
    const serviceResponse = await renderRequest(token, `/services/${encodeURIComponent(serviceId)}`).catch(() => ({}));
    const service = serviceResponse.service || serviceResponse;
    res.json({
      serviceId,
      deployId: deploy?.id || deployId || '',
      status: deploy?.status || 'unknown',
      createdAt: deploy?.createdAt || '',
      finishedAt: deploy?.finishedAt || '',
      url: service?.serviceDetails?.url || service?.url || '',
      dashboardUrl: service?.dashboardUrl || '',
      commit: deploy?.commit?.id || '',
    });
  } catch (error) { next(error); }
});

app.post('/api/render/logs', async (req, res, next) => {
  try {
    const { serviceId, since } = req.body || {};
    const ownerId = req.body?.ownerId || process.env.RENDER_OWNER_ID;
    const token = req.body?.token || process.env.RENDER_API_TOKEN;
    if (!token || !ownerId || !serviceId) throw httpError('Render token, workspace ID, and service ID are required to load logs.');
    const start = since ? Date.parse(since) : Date.now() - 45 * 60 * 1000;
    const startTime = new Date(Number.isFinite(start) ? start : Date.now() - 45 * 60 * 1000).toISOString();
    const params = new URLSearchParams({ ownerId, startTime, direction: 'forward', limit: '100' });
    params.append('resource', serviceId);
    params.append('type', 'build');
    params.append('type', 'app');
    const data = await renderRequest(token, `/logs?${params}`);
    const rows = Array.isArray(data) ? data : data.logs || data.items || [];
    const logs = rows.map((row) => ({
      time: row.timestamp || row.createdAt || row.time || '',
      level: row.level || 'info',
      type: row.type || 'app',
      message: String(row.message || row.text || row.raw || row.log || JSON.stringify(row)).slice(0, 3000),
    }));
    res.json({ logs, hasMore: Boolean(data.hasMore) });
  } catch (error) { next(error); }
});

async function validatePublicMonitorUrl(value) {
  let url;
  try { url = new URL(normalizeMonitorUrl(value)); }
  catch (error) { throw httpError(error.message || 'Enter a public HTTP(S) URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateOrReservedAddress(host)) throw httpError('Monitoring private or local network addresses is blocked.');
    return url;
  }
  let addresses;
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch { throw httpError('The monitor hostname did not resolve to a public address.'); }
  if (!addresses.length || addresses.some((row) => isPrivateOrReservedAddress(row.address))) throw httpError('The monitor hostname resolves to a private or reserved network address.');
  return url;
}

app.post('/api/monitor/ping', async (req, res, next) => {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  try {
    let current = await validatePublicMonitorUrl(req.body?.url);
    for (let hop = 0; hop <= 3; hop += 1) {
      current = await validatePublicMonitorUrl(current.toString());
      let response;
      try {
        response = await fetch(current, {
          method: 'GET', redirect: 'manual', headers: { 'user-agent': 'StackPilot-Uptime-Monitor/1.0', accept: '*/*' },
          signal: AbortSignal.timeout(8000),
        });
      } catch (error) {
        return res.json({ ok: false, statusCode: 0, durationMs: Math.round(performance.now() - started), checkedAt, error: error.name === 'TimeoutError' ? 'Timed out after 8 seconds.' : 'The URL could not be reached.' });
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        await response.body?.cancel().catch(() => {});
        if (hop === 3) return res.json({ ok: false, statusCode: response.status, durationMs: Math.round(performance.now() - started), checkedAt, error: 'The URL redirected too many times.' });
        current = new URL(response.headers.get('location'), current);
        continue;
      }
      const statusCode = response.status;
      await response.body?.cancel().catch(() => {});
      return res.json({ ok: statusCode >= 200 && statusCode < 400, statusCode, durationMs: Math.round(performance.now() - started), checkedAt, error: statusCode >= 400 ? `HTTP ${statusCode}` : '' });
    }
    return res.json({ ok: false, statusCode: 0, durationMs: Math.round(performance.now() - started), checkedAt, error: 'Redirect check failed.' });
  } catch (error) { next(error); }
});

function appendJobLog(job, text, level = 'info', source = 'StackPilot') {
  job.sequence += 1;
  job.logs.push({ id: job.sequence, time: new Date().toISOString(), level, source, text: String(text).slice(0, 3000) });
  if (job.logs.length > MAX_JOB_LOGS) job.logs.splice(0, job.logs.length - MAX_JOB_LOGS);
  job.updatedAt = new Date().toISOString();
}

function patchJob(job, patch) {
  job.patch = { ...(job.patch || {}), ...patch };
  job.patchVersion += 1;
  job.updatedAt = new Date().toISOString();
}

function jobProgress(job) {
  if (job.status === 'live' || job.status === 'verified') return 100;
  const weights = { organize: 16, preflight: 14, github: 22, runner: 25, render: 23 };
  let value = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const state = job.steps?.[key];
    if (state === 'done') value += weight;
    else if (state === 'running') value += weight * 0.35;
    else if (state === 'error') return Math.max(5, Math.min(96, value + weight * 0.2));
  }
  return Math.round(Math.min(job.status === 'live' || job.status === 'verified' ? 100 : 96, value));
}

function publicJob(job, after = 0, sinceVersion = 0) {
  return {
    id: job.id,
    projectId: job.projectId,
    name: job.name,
    status: job.status,
    progress: jobProgress(job),
    activeAgent: job.activeAgent,
    steps: job.steps,
    logs: job.logs.filter((entry) => entry.id > after),
    sequence: job.sequence,
    patch: sinceVersion < job.patchVersion ? job.patch : null,
    patchVersion: job.patchVersion,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || '',
    error: job.error || '',
    workflowUrl: job.workflowUrl || '',
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function internalPost(endpoint, payload) {
  const headers = { 'content-type': 'application/json' };
  if (configuredAppSecret()) headers['x-app-password'] = configuredAppSecret();
  const response = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${endpoint} returned HTTP ${response.status}.`);
  return data;
}

function jobStep(job, id, status, source, message) {
  job.steps[id] = status;
  job.activeAgent = source || 'StackPilot';
  if (message) appendJobLog(job, message, status === 'error' ? 'error' : 'info', source || 'StackPilot');
  job.updatedAt = new Date().toISOString();
}

async function notifySubscriptions(projectId, notification) {
  if (!vapidConfigured || !pushSubscriptions.size) return;
  const payload = JSON.stringify({ ...notification, url: notification.url || '/' });
  await Promise.all([...pushSubscriptions.entries()].map(async ([endpoint, entry]) => {
    if (projectId && entry.projectId && entry.projectId !== projectId) return;
    try { await webpush.sendNotification(entry.subscription, payload, { TTL: 3600 }); }
    catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) pushSubscriptions.delete(endpoint);
      else console.warn('[push] delivery failed', error.statusCode || 'unknown');
    }
  }));
}

app.get('/api/push/public-key', (_req, res) => {
  res.json({ enabled: vapidConfigured, publicKey: vapidConfigured ? process.env.VAPID_PUBLIC_KEY : '' });
});

app.post('/api/push/subscribe', (req, res, next) => {
  try {
    if (!vapidConfigured) throw httpError('Web Push is not configured on this server yet.', 503);
    const { subscription, projectId = '' } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) throw httpError('A valid browser push subscription is required.');
    if (pushSubscriptions.size >= 50 && !pushSubscriptions.has(subscription.endpoint)) throw httpError('This single-operator workspace has reached its 50-device notification limit.', 429);
    pushSubscriptions.set(subscription.endpoint, { subscription, projectId: String(projectId).slice(0, 100) });
    res.status(201).json({ ok: true, enabled: true });
  } catch (error) { next(error); }
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  if (endpoint) pushSubscriptions.delete(endpoint);
  res.json({ ok: true });
});

app.post('/api/render/env-vars', async (req, res, next) => {
  try {
    const { serviceId, envVars = [] } = req.body || {};
    const token = req.body?.token || process.env.RENDER_API_TOKEN;
    if (!token || !serviceId) throw httpError('A Render API key and service ID are required.');
    const ownServiceId = process.env.STACKPILOT_SERVICE_ID || process.env.RENDER_SERVICE_ID || '';
    const allowed = normalizeRenderEnvVars(envVars, { protectOwnService: Boolean(ownServiceId && serviceId === ownServiceId) });
    const results = await Promise.all(allowed.map(({ key, value }) => renderRequest(token, `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) })));
    res.json({ ok: true, updated: results.length, message: 'Render environment variables saved. A deploy is required before the running service sees the new values.' });
  } catch (error) { next(error); }
});

app.post('/api/settings/github-token', async (req, res, next) => {
  try {
    const githubToken = String(req.body?.githubToken || '').trim();
    const renderToken = req.body?.renderToken || process.env.RENDER_API_TOKEN;
    const serviceId = process.env.STACKPILOT_SERVICE_ID || process.env.RENDER_SERVICE_ID || req.body?.serviceId;
    const expiresAt = String(req.body?.expiresAt || '').trim();
    if (!githubToken) throw httpError('Enter the new GitHub token.');
    if (!renderToken) throw httpError('Add a Render API key in Settings to save a token to the server environment.');
    if (!serviceId) throw httpError('The StackPilot Render service ID is not configured.');
    if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) throw httpError('Token expiry must use the YYYY-MM-DD date format.');
    const { data: user } = await githubRequest(githubToken, '/user');
    await Promise.all([
      renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/env-vars/GITHUB_TOKEN`, { method: 'PUT', body: JSON.stringify({ value: githubToken }) }),
      renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/env-vars/GITHUB_TOKEN_EXPIRES_AT`, { method: 'PUT', body: JSON.stringify({ value: expiresAt }) }),
    ]);
    const deploy = await renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/deploys`, { method: 'POST', body: JSON.stringify({ clearCache: 'do_not_clear' }) });
    res.json({ ok: true, login: user.login, expiresAt, deployId: deploy.id || '', message: 'GitHub token and reminder date saved as Render secrets. StackPilot will restart on the queued deploy.' });
  } catch (error) { next(error); }
});

app.post('/api/settings/openrouter-keys', async (req, res, next) => {
  try {
    const key1 = String(req.body?.key1 || '').trim();
    const key2 = String(req.body?.key2 || '').trim();
    const renderToken = req.body?.renderToken || process.env.RENDER_API_TOKEN;
    const serviceId = process.env.STACKPILOT_SERVICE_ID || process.env.RENDER_SERVICE_ID || '';
    if (!renderToken || !serviceId) throw httpError('A fresh Render API key and StackPilot service ID are required to save model keys to Render.');
    if (!key1 || key1.length < 20 || (key2 && key2.length < 20)) throw httpError('Enter one or two valid-looking OpenRouter keys.');
    const values = [['OPENROUTER_API_KEY_1', key1], ['OPENROUTER_API_KEY_2', key2], ['OPENROUTER_MODEL', 'openrouter/free']];
    await Promise.all(values.map(([key, value]) => renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) })));
    const deploy = await renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/deploys`, { method: 'POST', body: JSON.stringify({ clearCache: 'do_not_clear' }) });
    res.json({ ok: true, deployId: deploy.id || '', message: 'OpenRouter keys were saved as Render environment secrets. Free model routing will activate after the queued deploy.' });
  } catch (error) { next(error); }
});

app.post('/api/settings/app-pin', async (req, res, next) => {
  try {
    const pin = String(req.body?.pin || '').trim();
    const renderToken = req.body?.renderToken || process.env.RENDER_API_TOKEN;
    const serviceId = process.env.STACKPILOT_SERVICE_ID || process.env.RENDER_SERVICE_ID || '';
    if (!/^\d{4}$/.test(pin)) throw httpError('The App PIN must be exactly four digits.');
    if (!renderToken || !serviceId) throw httpError('A fresh Render API key and StackPilot service ID are required to update the Render environment.');
    await renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/env-vars/APP_PIN`, { method: 'PUT', body: JSON.stringify({ value: pin }) });
    const deploy = await renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/deploys`, { method: 'POST', body: JSON.stringify({ clearCache: 'do_not_clear' }) });
    res.json({ ok: true, deployId: deploy.id || '', message: 'The four-digit PIN is in Render environment. It becomes active when the queued deploy starts.' });
  } catch (error) { next(error); }
});

app.get('/api/projects/:projectId/credentials', (req, res, next) => {
  try {
    const projectId = normalizeProjectId(req.params.projectId);
    res.json({ configured: projectCredentialStatus(projectId) });
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/credentials', async (req, res, next) => {
  try {
    const projectId = normalizeProjectId(req.params.projectId);
    const supplied = req.body?.credentials && typeof req.body.credentials === 'object' && !Array.isArray(req.body.credentials) ? req.body.credentials : {};
    const current = readProjectCredentials(projectId);
    const clear = req.body?.clear === true;
    const updates = clear
      ? Object.keys(PROJECT_CREDENTIAL_ENV_FIELDS).map((field) => [field, ''])
      : Object.entries(supplied).filter(([field]) => Object.hasOwn(PROJECT_CREDENTIAL_ENV_FIELDS, field)).map(([field, value]) => [field, String(value ?? '').trim()]).filter(([, value]) => value.length > 0);
    if (!updates.length) throw httpError('Enter at least one project-specific key before saving.');
    for (const [field, value] of updates) {
      if (value.length > 2000) throw httpError(`${field} exceeds the 2,000 character limit.`);
    }

    const renderToken = String(req.body?.adminRenderToken || supplied.renderToken || process.env.RENDER_API_TOKEN || current.renderToken || '').trim();
    const serviceId = process.env.STACKPILOT_SERVICE_ID || process.env.RENDER_SERVICE_ID || '';
    if (!renderToken || !serviceId) throw httpError('Saving per-project platform keys needs a Render API key with access to the StackPilot service and its service ID.');

    const updateMap = new Map(updates);
    if (updateMap.get('githubToken')) await githubRequest(updateMap.get('githubToken'), '/user');
    const openRouterKeys = ['openRouterKey1', 'openRouterKey2'].map((field) => updateMap.get(field)).filter(Boolean);
    if (openRouterKeys.length) await internalPost('/api/openrouter/test', { apiKeys: openRouterKeys });
    if (updateMap.get('renderToken')) await renderRequest(updateMap.get('renderToken'), '/services?limit=1');

    await Promise.all(updates.map(([field, value]) => {
      const envKey = projectCredentialEnvKey(projectId, field);
      return renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(envKey)}`, { method: 'PUT', body: JSON.stringify({ value }) });
    }));
    for (const [field, value] of updates) process.env[projectCredentialEnvKey(projectId, field)] = value;
    const deploy = await renderRequest(renderToken, `/services/${encodeURIComponent(serviceId)}/deploys`, { method: 'POST', body: JSON.stringify({ clearCache: 'do_not_clear' }) });
    res.json({ ok: true, configured: projectCredentialStatus(projectId), deployId: deploy.id || '', message: clear ? 'Project-specific keys were cleared from Render.' : 'Project-specific keys were saved as StackPilot Render environment secrets.' });
  } catch (error) { next(error); }
});

app.post('/api/jobs', async (req, res, next) => {
  try {
    const input = req.body || {};
    const project = input.project || {};
    const projectId = String(project.id || '').slice(0, 100);
    const name = String(project.name || 'New project').slice(0, 100);
    if (!projectId) throw httpError('A project ID is required to start a background run.');
    if ([...backgroundJobs.values()].some((job) => ['queued', 'running'].includes(job.status))) throw httpError('Another StackPilot background run is already active. Wait for it to finish first.', 409);
    if (!String(project.repo || '').trim()) throw httpError('Enter the GitHub repository (owner/repo) first.');
    const projectCredentials = readProjectCredentials(projectId);
    const credentials = {
      openRouterKeys: normalizeOpenRouterKeys([
        input.credentials?.openRouterKey1, input.credentials?.openRouterKey2,
        projectCredentials.openRouterKey1, projectCredentials.openRouterKey2,
        process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2, process.env.OPENROUTER_API_KEY,
      ]),
      githubToken: String(input.credentials?.githubToken || projectCredentials.githubToken || process.env.GITHUB_TOKEN || ''),
      renderToken: String(input.credentials?.renderToken || projectCredentials.renderToken || process.env.RENDER_API_TOKEN || ''),
    };
    if (!credentials.githubToken) throw httpError('Add a GitHub token override in this project’s Deploy & Render tab or configure GITHUB_TOKEN on the StackPilot server.');
    const rawInput = typeof project.rawInput === 'string' ? project.rawInput : '';
    const sourceFiles = project.files && typeof project.files === 'object' ? project.files : {};
    if (!rawInput.trim() && !Object.keys(sourceFiles).length) throw httpError('Paste a code dump, import a ZIP, or add project files before starting.');
    if (rawInput.trim() && !credentials.openRouterKeys.length) throw httpError('Add an OpenRouter key override in this project’s Deploy & Render tab or configure a workspace key in Settings.');
    if (rawInput.length > 40_000) throw httpError('Keep the brief or code dump under 40,000 characters for the free-model context budget.');
    const jobId = randomUUID();
    const job = {
      id: jobId, projectId, name, status: 'queued', activeAgent: 'StackPilot orchestrator',
      steps: { organize: 'idle', preflight: 'idle', github: 'idle', runner: 'idle', render: 'idle' },
      logs: [], sequence: 0, patch: {}, patchVersion: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      workflowUrl: '', error: '',
    };
    backgroundJobs.set(jobId, job);
    appendJobLog(job, 'Run accepted. StackPilot will keep working on the server if you leave this page.', 'info', 'Orchestrator');
    const context = {
      credentials,
      project: {
        id: projectId, name, slug: String(project.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 60),
        rawInput, files: sourceFiles, repo: String(project.repo || '').trim(), branch: String(project.branch || 'main').trim(),
        renderServiceId: String(project.renderServiceId || ''), renderUrl: String(project.renderUrl || ''),
        serviceType: project.serviceType === 'static_site' ? 'static_site' : 'web_service',
        runtime: ['node', 'python', 'ruby', 'go', 'elixir'].includes(project.runtime) ? project.runtime : 'node',
        region: String(project.region || 'frankfurt'), buildCommand: String(project.buildCommand || ''),
        startCommand: String(project.startCommand || ''), publishPath: String(project.publishPath || 'dist'), rootDir: String(project.rootDir || ''),
        summary: String(project.summary || ''), stack: String(project.stack || ''), autoDeploy: Boolean(project.autoDeploy),
        envVars: Array.isArray(input.envVars) ? input.envVars : [],
      },
      ownerId: String(input.credentials?.renderOwnerId || projectCredentials.renderOwnerId || input.renderOwnerId || process.env.RENDER_OWNER_ID || ''), model: normalizeFreeModel(input.model || process.env.OPENROUTER_MODEL),
    };
    runBackgroundJob(job, context).catch((error) => console.error('[job] unhandled failure', error.message));
    res.status(202).json({ jobId, status: job.status, projectId, message: 'Background run started.' });
  } catch (error) { next(error); }
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = backgroundJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Background run not found. It may have expired or the server restarted.' });
  const after = Math.max(0, Number(req.query.after) || 0);
  const sinceVersion = Math.max(0, Number(req.query.sinceVersion) || 0);
  res.json(publicJob(job, after, sinceVersion));
});

async function runBackgroundJob(job, ctx) {
  const p = ctx.project;
  const creds = ctx.credentials;
  let files = { ...(p.files || {}) };
  let repairs = 0;
  try {
    job.status = 'running';
    jobStep(job, 'organize', p.rawInput.trim() ? 'running' : 'done', 'Project architect', p.rawInput.trim() ? 'Reading the dump and assembling a runnable project structure.' : 'Starting from the saved project files.');
    if (p.rawInput.trim()) {
      const organized = await internalPost('/api/organize', { input: p.rawInput, files, projectName: p.name, apiKeys: creds.openRouterKeys, model: ctx.model });
      files = { ...files, ...(organized.files || {}) };
      Object.assign(p, organized, { files });
      appendJobLog(job, `Free-model architect reviewed the project · ${organized.stack || 'stack identified'}.`, 'success', 'OpenRouter architect');
      (organized.notes || []).forEach((note) => appendJobLog(job, note, 'warning', 'Project architect'));
      patchJob(job, { files, activeFile: Object.keys(files).sort()[0] || '', summary: organized.summary || '', stack: organized.stack || '', serviceType: organized.deployType || p.serviceType, runtime: organized.runtime || p.runtime, buildCommand: organized.buildCommand || p.buildCommand, startCommand: organized.startCommand || p.startCommand, publishPath: organized.publishPath || p.publishPath, rawInput: p.rawInput });
    } else appendJobLog(job, 'Using the current project file tree.', 'info', 'Project architect');
    job.steps.organize = 'done';

    while (true) {
      jobStep(job, 'preflight', 'running', 'Safety & build guard', 'Checking file paths, likely secrets, imports, and project setup.');
      const preflight = await internalPost('/api/validate', { files });
      appendJobLog(job, `Preflight inspected ${preflight.files} files · ${preflight.findings.length} finding(s).`, preflight.ok ? 'success' : 'warning', 'Safety & build guard');
      preflight.findings.forEach((finding) => appendJobLog(job, finding.message, finding.severity === 'error' ? 'error' : 'warning', 'Preflight'));
      if (preflight.ok) { job.steps.preflight = 'done'; break; }
      if (!creds.openRouterKeys.length || repairs >= 2) throw new Error('Preflight found blocking issues. Add an OpenRouter key in project settings or fix the files before retrying.');
      const repair = await internalPost('/api/repair', { files, errors: preflight.findings.map((finding) => finding.message).join('\n'), apiKeys: creds.openRouterKeys, model: ctx.model });
      files = { ...files, ...(repair.files || {}) };
      repairs += 1;
      appendJobLog(job, `${repair.summary || 'Applied a targeted preflight repair.'} (repair ${repairs}/2).`, 'warning', 'Repair agent');
      patchJob(job, { files, activeFile: Object.keys(repair.files || {})[0] || Object.keys(files)[0] || '' });
    }

    if (p.renderServiceId) {
      if (!creds.renderToken) throw new Error('An existing Render service may auto-deploy directly from a GitHub push. Add a Render API key so StackPilot can disable that trigger before pushing, or remove the existing service ID.');
      await internalPost('/api/render/disable-autodeploy', { token: creds.renderToken, serviceId: p.renderServiceId });
      appendJobLog(job, 'Disabled the existing Render service auto-deploy trigger. StackPilot will only queue a deploy after GitHub checks pass.', 'success', 'Render release gate');
    }

    while (true) {
      jobStep(job, 'github', 'running', 'GitHub release agent', `Pushing ${Object.keys(files).length} checked files to ${p.repo}…`);
      const captureAt = Date.now();
      const pushed = await internalPost('/api/github/push', { token: creds.githubToken, repository: p.repo, branch: p.branch, files, createIfMissing: true, isPrivate: true });
      p.repo = `${pushed.owner}/${pushed.repo}`;
      p.branch = pushed.branch;
      p.lastCommit = pushed.commitSha;
      p.lastCommitUrl = pushed.commitUrl;
      files = { ...files, [pushed.automationFilePath]: pushed.automationFileContent };
      job.steps.github = 'done';
      patchJob(job, { repo: p.repo, branch: p.branch, files, lastCommit: p.lastCommit, lastCommitUrl: p.lastCommitUrl, status: 'pushed' });
      appendJobLog(job, `Committed ${pushed.fileCount} files (${pushed.commitSha.slice(0, 7)}). Waiting for real GitHub Actions checks.`, 'success', 'GitHub release agent');
      jobStep(job, 'runner', 'running', 'Build & test agent', 'GitHub Actions is installing dependencies, running tests, and building the project.');
      let runInfo = null;
      for (let attempt = 0; attempt < 84; attempt += 1) {
        runInfo = await internalPost('/api/github/runs', { token: creds.githubToken, repository: p.repo, branch: p.branch, since: new Date(captureAt).toISOString() });
        if (runInfo.found) {
          job.workflowUrl = runInfo.url || '';
          if (runInfo.status !== job._lastRunStatus || runInfo.conclusion !== job._lastRunConclusion) {
            job._lastRunStatus = runInfo.status;
            job._lastRunConclusion = runInfo.conclusion;
            appendJobLog(job, `GitHub Actions: ${runInfo.status}${runInfo.conclusion ? ` · ${runInfo.conclusion}` : ''}.`, runInfo.conclusion === 'failure' ? 'error' : 'info', 'Build & test agent');
          }
          if (runInfo.status === 'completed') break;
        } else if (attempt >= 9) {
          throw new Error('No GitHub Actions run appeared. Make sure Actions are enabled and this token can read workflow runs.');
        } else if (attempt === 0) appendJobLog(job, 'Waiting for the GitHub-hosted runner to start…', 'info', 'Build & test agent');
        await sleep(5000);
      }
      if (!runInfo?.found || runInfo.status !== 'completed') throw new Error('GitHub Actions is taking longer than seven minutes. Open the workflow link and retry after it finishes.');
      if (runInfo.conclusion === 'success') {
        job.steps.runner = 'done';
        appendJobLog(job, 'Remote build and test workflow passed. Render will not be touched until this point.', 'success', 'Build & test agent');
        break;
      }
      job.steps.runner = 'error';
      if (!creds.openRouterKeys.length || !runInfo.logs || repairs >= 2) throw new Error(runInfo.logs ? 'Remote build failed after the allowed repair attempts.' : 'Remote build failed; verify GitHub Actions log access before asking the free model to repair it.');
      repairs += 1;
      appendJobLog(job, `The build failed. OpenRouter repair is reviewing its real runner logs (${repairs}/2)…`, 'warning', 'Repair agent');
      const repair = await internalPost('/api/repair', { files, errors: runInfo.logs, apiKeys: creds.openRouterKeys, model: ctx.model });
      files = { ...files, ...(repair.files || {}) };
      appendJobLog(job, repair.summary || 'Applied a build-log-guided repair.', 'warning', 'Repair agent');
      patchJob(job, { files, activeFile: Object.keys(repair.files || {})[0] || Object.keys(files)[0] || '' });
    }

    if (!p.autoDeploy) {
      job.status = 'verified';
      job.activeAgent = 'Release gate';
      patchJob(job, { status: 'verified', files, repo: p.repo, branch: p.branch, lastCommit: p.lastCommit, lastCommitUrl: p.lastCommitUrl });
      appendJobLog(job, 'Automatic Render step is off. Everything is pushed and tested; use Deploy when you are ready.', 'success', 'Release gate');
      return;
    }
    if (!creds.renderToken || (!p.renderServiceId && !ctx.ownerId)) {
      job.status = 'verified';
      patchJob(job, { status: 'verified', files, repo: p.repo, branch: p.branch, lastCommit: p.lastCommit, lastCommitUrl: p.lastCommitUrl });
      appendJobLog(job, 'GitHub checks passed. Add a Render API key and workspace ID to start the deployment.', 'warning', 'Render operator');
      return;
    }

    let serviceId = p.renderServiceId;
    let deployId = '';
    let renderSince = new Date().toISOString();
    jobStep(job, 'render', 'running', 'Render operator', 'Starting Render only after all GitHub checks have passed.');
    const envVars = Array.isArray(p.envVars) ? p.envVars : [];
    if (!serviceId) {
      const created = await internalPost('/api/render/create', {
        token: creds.renderToken, ownerId: ctx.ownerId, repository: p.repo, branch: p.branch, name: p.slug,
        serviceType: p.serviceType, runtime: p.runtime, region: p.region, buildCommand: p.buildCommand,
        startCommand: p.startCommand, publishPath: p.publishPath, rootDir: p.rootDir, envVars,
      });
      serviceId = created.serviceId;
      deployId = created.deployId;
      p.renderUrl = created.url || '';
      appendJobLog(job, `Render service created: ${serviceId}. Watching the live build now.`, 'success', 'Render operator');
      patchJob(job, { renderServiceId: serviceId, renderUrl: p.renderUrl, renderDashboardUrl: created.dashboardUrl || '', renderDeployId: deployId, status: 'deploying' });
    } else {
      if (envVars.length) {
        await internalPost('/api/render/env-vars', { token: creds.renderToken, serviceId, envVars });
        appendJobLog(job, `Saved ${envVars.length} project environment variable(s) to Render.`, 'success', 'Render operator');
      }
      const queued = await internalPost('/api/render/deploy', { token: creds.renderToken, serviceId, commitId: p.lastCommit });
      deployId = queued.deployId;
      appendJobLog(job, `Render deploy queued for verified commit ${String(p.lastCommit || '').slice(0, 7)}.`, 'info', 'Render operator');
      patchJob(job, { renderDeployId: deployId, status: 'deploying' });
    }
    renderSince = new Date().toISOString();
    let renderOutcome = { ok: false };
    for (let attempt = 0; attempt < 86; attempt += 1) {
      const status = await internalPost('/api/render/status', { token: creds.renderToken, serviceId, deployId });
      p.renderUrl = status.url || p.renderUrl;
      if (status.status !== job._lastRenderStatus) {
        job._lastRenderStatus = status.status;
        appendJobLog(job, `Render deployment: ${String(status.status || 'unknown').replaceAll('_', ' ')}.`, ['build_failed', 'update_failed', 'pre_deploy_failed'].includes(status.status) ? 'error' : 'info', 'Render operator');
      }
      if (status.url) patchJob(job, { renderUrl: status.url, renderDashboardUrl: status.dashboardUrl || '', renderDeployId: status.deployId || deployId });
      const logResponse = await internalPost('/api/render/logs', { token: creds.renderToken, ownerId: ctx.ownerId, serviceId, since: renderSince });
      for (const line of (logResponse.logs || []).slice(-25)) {
        const fingerprint = `${line.time}|${line.type}|${line.message}`;
        if (job._renderLogFingerprints?.has(fingerprint)) continue;
        job._renderLogFingerprints ||= new Set();
        job._renderLogFingerprints.add(fingerprint);
        appendJobLog(job, line.message, /error|fatal/i.test(`${line.level} ${line.message}`) ? 'error' : 'info', `Render ${line.type || 'log'}`);
      }
      if (status.status === 'live') { renderOutcome = { ok: true, info: status }; break; }
      if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(status.status)) { renderOutcome = { ok: false, logs: job.logs.slice(-120).map((line) => line.text).join('\n') }; break; }
      await sleep(7000);
    }
    while (!renderOutcome.ok && repairs < 2 && creds.openRouterKeys.length && renderOutcome.logs) {
      repairs += 1;
      appendJobLog(job, `Render failed. OpenRouter repair is reviewing the deployment log (${repairs}/2)…`, 'warning', 'Repair agent');
      const repair = await internalPost('/api/repair', { files, errors: renderOutcome.logs.slice(-20_000), apiKeys: creds.openRouterKeys, model: ctx.model });
      files = { ...files, ...(repair.files || {}) };
      patchJob(job, { files, activeFile: Object.keys(repair.files || {})[0] || Object.keys(files)[0] || '' });
      appendJobLog(job, repair.summary || 'Applied a Render-log-guided repair.', 'warning', 'Repair agent');
      const captureAt = Date.now();
      const pushed = await internalPost('/api/github/push', { token: creds.githubToken, repository: p.repo, branch: p.branch, files, createIfMissing: false, isPrivate: true });
      p.lastCommit = pushed.commitSha;
      p.lastCommitUrl = pushed.commitUrl;
      p.branch = pushed.branch;
      files = { ...files, [pushed.automationFilePath]: pushed.automationFileContent };
      patchJob(job, { files, lastCommit: p.lastCommit, lastCommitUrl: p.lastCommitUrl, branch: p.branch });
      appendJobLog(job, `Pushed repair ${repairs}/2. Waiting for GitHub checks again before another Render deploy.`, 'success', 'GitHub release agent');
      const runInfo = await waitForJobGithub(job, p, creds.githubToken, captureAt);
      if (runInfo.conclusion !== 'success') { renderOutcome = { ok: false, logs: runInfo.logs || 'GitHub checks did not pass after the repair.' }; break; }
      await internalPost('/api/render/env-vars', { token: creds.renderToken, serviceId, envVars });
      const queued = await internalPost('/api/render/deploy', { token: creds.renderToken, serviceId, commitId: p.lastCommit });
      deployId = queued.deployId;
      renderSince = new Date().toISOString();
      appendJobLog(job, `Retry deployment ${repairs}/2 queued after successful GitHub checks.`, 'info', 'Render operator');
      renderOutcome = await waitForJobRender(job, { ...ctx, project: p }, creds.renderToken, serviceId, deployId, renderSince);
    }
    if (!renderOutcome.ok) throw new Error('GitHub checks passed, but Render did not reach Live. Review the live logs and retry.');
    job.steps.render = 'done';
    job.status = 'live';
    job.activeAgent = 'Render operator';
    patchJob(job, { files, repo: p.repo, branch: p.branch, lastCommit: p.lastCommit, lastCommitUrl: p.lastCommitUrl, renderServiceId: serviceId, renderUrl: renderOutcome.info.url || p.renderUrl, renderDashboardUrl: renderOutcome.info.dashboardUrl || '', renderDeployId: renderOutcome.info.deployId || deployId, status: 'live' });
    appendJobLog(job, `Live on Render: ${renderOutcome.info.url || p.renderUrl || 'deployment completed'}.`, 'success', 'Render operator');
    await notifySubscriptions(job.projectId, { title: 'StackPilot build is live', body: `${job.name} passed checks and is now deployed.`, url: renderOutcome.info.url || p.renderUrl || '/' });
  } catch (error) {
    job.status = 'failed';
    job.error = error.message || 'Background run failed.';
    job.activeAgent = 'Needs attention';
    for (const key of Object.keys(job.steps)) if (job.steps[key] === 'running') job.steps[key] = 'error';
    appendJobLog(job, job.error, 'error', 'StackPilot');
    patchJob(job, { status: 'needs_attention', files, error: job.error });
    await notifySubscriptions(job.projectId, { title: 'StackPilot needs your attention', body: `${job.name}: ${job.error}`, url: '/' });
  } finally {
    job.completedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    ctx.credentials.openRouterKeys = [];
    ctx.credentials.githubToken = '';
    ctx.credentials.renderToken = '';
    ctx.project.rawInput = '';
    ctx.project.files = {};
    ctx.project.envVars = [];
    if (job.status === 'running') job.status = 'failed';
    setTimeout(() => backgroundJobs.delete(job.id), JOB_RETENTION_MS).unref?.();
  }
}

async function waitForJobGithub(job, project, token, captureAt) {
  for (let attempt = 0; attempt < 84; attempt += 1) {
    const info = await internalPost('/api/github/runs', { token, repository: project.repo, branch: project.branch || 'main', since: new Date(captureAt).toISOString() });
    if (info.found) {
      job.workflowUrl = info.url || '';
      if (info.status === 'completed') {
        if (info.conclusion === 'success') job.steps.runner = 'done';
        return info;
      }
      if (attempt % 6 === 0) appendJobLog(job, `GitHub repair check is ${info.status}.`, 'info', 'Build & test agent');
    } else if (attempt >= 9) throw new Error('No GitHub Actions run appeared for the repair commit.');
    await sleep(5000);
  }
  throw new Error('GitHub Actions is taking longer than seven minutes after the repair.');
}

async function waitForJobRender(job, ctx, token, serviceId, deployId, since) {
  const unique = job._renderLogFingerprints || new Set();
  for (let attempt = 0; attempt < 86; attempt += 1) {
    const status = await internalPost('/api/render/status', { token, serviceId, deployId });
    if (status.status !== job._lastRenderStatus) {
      job._lastRenderStatus = status.status;
      appendJobLog(job, `Render deployment: ${String(status.status || 'unknown').replaceAll('_', ' ')}.`, ['build_failed', 'update_failed', 'pre_deploy_failed'].includes(status.status) ? 'error' : 'info', 'Render operator');
    }
    const logs = await internalPost('/api/render/logs', { token, ownerId: ctx.ownerId, serviceId, since });
    for (const line of (logs.logs || []).slice(-25)) {
      const fingerprint = `${line.time}|${line.type}|${line.message}`;
      if (unique.has(fingerprint)) continue;
      unique.add(fingerprint);
      appendJobLog(job, line.message, /error|fatal/i.test(`${line.level} ${line.message}`) ? 'error' : 'info', `Render ${line.type || 'log'}`);
    }
    if (status.url) patchJob(job, { renderUrl: status.url, renderDashboardUrl: status.dashboardUrl || '', renderDeployId: status.deployId || deployId });
    if (status.status === 'live') return { ok: true, info: status };
    if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(status.status)) return { ok: false, logs: job.logs.slice(-120).map((line) => line.text).join('\n') };
    await sleep(7000);
  }
  return { ok: false, logs: job.logs.slice(-120).map((line) => line.text).join('\n') };
}

if (process.env.GITHUB_TOKEN_EXPIRES_AT) {
  const expiryTimer = setInterval(async () => {
    const date = new Date(`${process.env.GITHUB_TOKEN_EXPIRES_AT}T23:59:59Z`);
    if (Number.isNaN(date.getTime())) return;
    const daysLeft = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
    if (![7, 3, 1, 0].includes(daysLeft) || notifiedExpiryDays.has(daysLeft)) return;
    notifiedExpiryDays.add(daysLeft);
    await notifySubscriptions('', { title: daysLeft === 0 ? 'GitHub token expires today' : `GitHub token expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, body: 'Open StackPilot Settings to rotate the token before your next push.', url: '/' });
  }, 60 * 60 * 1000);
  expiryTimer.unref?.();
}

app.use('/api', (error, _req, res, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('[api]', error.message);
  res.status(status).json({ error: error.message || 'Unexpected server error.' });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, 'dist');
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    configFile: path.join(__dirname, 'vite.config.js'),
    server: { middlewareMode: true, host: '0.0.0.0', allowedHosts: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StackPilot ready on http://0.0.0.0:${PORT}`);
});
