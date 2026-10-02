import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, BadgeCheck, BookOpen,
  Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleHelp, Clipboard,
  Cloud, Code2, Command, ExternalLink, File, FileCode2, Folder, Github, Globe,
  KeyRound, Layers3, Loader2, LockKeyhole, Menu, MoreHorizontal, Plus, Rocket,
  Save, Search, Send, Settings2, ShieldCheck, Sparkles, Terminal, Trash2, X,
  Zap, RefreshCw, AlertTriangle, CircleDashed, CircleX, Braces, UploadCloud,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { createProjectId, getProjects, removeProject, saveProject } from './storage.js';

const SECRET_KEYS = {
  anthropicKey: 'stackpilot.anthropic.session',
  githubToken: 'stackpilot.github.session',
  renderToken: 'stackpilot.render.session',
  appPassword: 'stackpilot.password.session',
  renderOwnerId: 'stackpilot.render.owner',
};

const STEPS = [
  { id: 'organize', label: 'Organize with Claude', detail: 'Turn the dump into a clean file tree', icon: Sparkles },
  { id: 'preflight', label: 'Preflight checks', detail: 'Catch unsafe paths and missing files', icon: ShieldCheck },
  { id: 'github', label: 'Push to GitHub', detail: 'Create a commit and add a CI workflow', icon: Github },
  { id: 'runner', label: 'Build in a runner', detail: 'Run tests and build on GitHub Actions', icon: Terminal },
  { id: 'render', label: 'Deploy on Render', detail: 'Build, watch logs, and return the URL', icon: Rocket },
];

const SAMPLE_FILES = {
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f8f7f4" />
    <title>Northstar — Make room for good work</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="page-shell">
      <nav class="nav"><a class="brand" href="#"><span class="brand-mark">N</span> northstar</a><a class="nav-link" href="#features">Why Northstar</a><a class="nav-link" href="#get-started">Get started <span>↗</span></a></nav>
      <section class="hero">
        <div class="eyebrow"><span class="sparkle">✦</span> A calmer way to plan</div>
        <h1>Make room<br />for <em>good work.</em></h1>
        <p class="intro">A little less busywork. A lot more of what matters. Bring your projects, people, and plans into one clear space.</p>
        <div class="hero-actions"><a class="button-primary" href="#get-started">Find your focus <span>→</span></a><a class="quiet-link" href="#features">See how it works</a></div>
        <div class="hero-note"><span class="avatars">A · J · M</span><span>Thoughtful work starts here</span></div>
      </section>
      <section class="feature" id="features"><div><span class="eyebrow">LESS NOISE. MORE MOMENTUM.</span><h2>Your next good idea<br />deserves a clear path.</h2></div><p>Keep the moving pieces together, make progress visible, and leave more energy for the part only you can do.</p></section>
      <section class="cta" id="get-started"><span class="eyebrow">START WITH ONE THING</span><h2>Make a little space.</h2><a class="button-primary" href="mailto:hello@example.com">Say hello <span>→</span></a></section>
      <footer>© Northstar Studio · Built for better days</footer>
    </main>
  </body>
</html>`,
  'styles.css': `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap');
:root{font-family:'DM Sans',sans-serif;color:#25251f;background:#f8f7f4;font-synthesis:none}*{box-sizing:border-box}body{margin:0}.page-shell{max-width:1100px;margin:0 auto;padding:0 56px}.nav{height:86px;display:flex;align-items:center;gap:38px;border-bottom:1px solid #e7e5df}.brand{display:flex;align-items:center;gap:11px;margin-right:auto;color:#24241f;text-decoration:none;font-weight:700;letter-spacing:-.03em}.brand-mark{display:grid;place-items:center;width:30px;height:30px;background:#30322a;color:white;border-radius:9px;font-family:Georgia,serif;font-size:17px}.nav-link,.quiet-link{color:#65655f;text-decoration:none;font-size:13px}.nav-link span{margin-left:5px}.hero{max-width:700px;padding:112px 0 120px}.eyebrow{font-size:10px;letter-spacing:.14em;font-weight:700;color:#868678}.sparkle{color:#ba8c53;margin-right:8px}.hero h1{font-family:'Playfair Display',Georgia,serif;font-size:clamp(54px,7vw,86px);line-height:.99;letter-spacing:-.055em;margin:25px 0 22px;font-weight:600}.hero h1 em{font-weight:600;color:#a88662}.intro{font-size:16px;line-height:1.8;color:#77776f;max-width:470px;margin:0}.hero-actions{display:flex;align-items:center;gap:27px;margin-top:31px}.button-primary{display:inline-flex;align-items:center;gap:28px;border-radius:7px;background:#30322a;color:white;padding:14px 18px;text-decoration:none;font-size:12px;font-weight:600}.button-primary span{font-size:17px;line-height:10px}.hero-note{display:flex;align-items:center;gap:11px;margin-top:42px;font-size:11px;color:#8a8980}.avatars{letter-spacing:3px;color:#a88662;font-weight:700}.feature{display:grid;grid-template-columns:1fr 1fr;gap:80px;padding:46px 0 78px;border-top:1px solid #e7e5df}.feature h2,.cta h2{font-family:'Playfair Display',Georgia,serif;font-size:37px;line-height:1.18;letter-spacing:-.04em;font-weight:600}.feature p{align-self:end;color:#7a7a72;line-height:1.8;font-size:14px;margin:0 0 8px}.cta{padding:52px 0 68px;text-align:center;background:#efeee8;border-radius:14px;margin-bottom:55px}.cta h2{margin:13px 0 21px}.cta .button-primary{margin:auto}footer{border-top:1px solid #e7e5df;padding:25px 0;color:#94938a;font-size:11px}@media(max-width:640px){.page-shell{padding:0 22px}.nav{height:70px;gap:16px}.nav-link{display:none}.hero{padding:83px 0 88px}.hero h1{font-size:59px}.intro{font-size:14px}.feature{grid-template-columns:1fr;gap:14px;padding:35px 0 54px}.feature h2,.cta h2{font-size:30px}.cta{padding:40px 22px 48px}}`,
  'README.md': `# Northstar landing page\n\nA small responsive landing-page starter. This is a StackPilot sample project; no GitHub push, shell command, or Render deploy has been run.\n\n## Files\n- index.html — semantic page structure\n- styles.css — responsive styling\n\nOpen index.html directly to preview. Replace the example email address before publishing.`,
};

const SAMPLE_DUMP = `Please arrange this small landing page into proper files and finish the mobile styles. Keep the quiet editorial look.\n\nindex.html:\n<!doctype html><n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Northstar</title><link rel="stylesheet" href="styles.css"></head><body><main><nav>Northstar</nav><h1>Make room for good work.</h1><p>A calmer way to plan.</p><a href="#features">Find your focus</a></main></body></html>\n\nstyles.css:\nbody { margin: 0; background: #f8f7f4; color: #25251f; font-family: sans-serif; }\nmain { max-width: 900px; margin: auto; padding: 48px; }\nh1 { font-family: Georgia, serif; font-size: 5rem; }\n/* TODO: add a small responsive navigation and a proper mobile layout */`;

function createBlankProject(name = 'untitled-project') {
  const slug = slugify(name) || 'untitled-project';
  return {
    id: createProjectId(),
    name: name || 'Untitled project',
    slug,
    rawInput: '',
    files: {},
    activeFile: '',
    repo: '',
    branch: 'main',
    renderServiceId: '',
    renderUrl: '',
    renderDashboardUrl: '',
    renderDeployId: '',
    serviceType: 'web_service',
    runtime: 'node',
    region: 'frankfurt',
    buildCommand: 'npm install && npm run build',
    startCommand: 'npm start',
    publishPath: 'dist',
    rootDir: '',
    summary: '',
    stack: '',
    status: 'draft',
    isDemo: false,
    steps: Object.fromEntries(STEPS.map((step) => [step.id, 'idle'])),
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createDemoProject() {
  return {
    ...createBlankProject('Northstar landing page'),
    slug: 'northstar-landing',
    files: SAMPLE_FILES,
    activeFile: 'index.html',
    rawInput: '',
    summary: 'A responsive editorial landing page. This sample is stored on this device and has not been deployed.',
    stack: 'Static HTML + CSS',
    status: 'demo',
    isDemo: true,
    serviceType: 'static_site',
    buildCommand: 'echo "Static HTML ready"',
    publishPath: '.',
    steps: { organize: 'demo', preflight: 'demo', github: 'idle', runner: 'idle', render: 'idle' },
    logs: [
      { time: new Date().toISOString(), level: 'info', source: 'StackPilot', text: 'Welcome — this is a local sample project. Nothing has been pushed or deployed.' },
      { time: new Date().toISOString(), level: 'info', source: 'Workspace', text: 'Paste a code dump above, connect your keys, and run the real pipeline when you are ready.' },
    ],
  };
}

function slugify(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55);
}

function readSession(key) {
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}

function initialConnectors() {
  let renderOwnerId = '';
  try { renderOwnerId = localStorage.getItem(SECRET_KEYS.renderOwnerId) || ''; } catch { /* private mode */ }
  return {
    anthropicKey: readSession(SECRET_KEYS.anthropicKey),
    githubToken: readSession(SECRET_KEYS.githubToken),
    renderToken: readSession(SECRET_KEYS.renderToken),
    appPassword: readSession(SECRET_KEYS.appPassword),
    renderOwnerId,
  };
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shortTime(value) {
  try { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
  catch { return '--:--:--'; }
}

function fileLanguage(filePath = '') {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ({ js: 'JavaScript', jsx: 'React JSX', ts: 'TypeScript', tsx: 'React TSX', html: 'HTML', css: 'CSS', json: 'JSON', md: 'Markdown', py: 'Python', yml: 'YAML', yaml: 'YAML', go: 'Go', sh: 'Shell' })[ext] || 'Text';
}

function getFileIcon(path) {
  if (path.endsWith('.json')) return Braces;
  if (/\.(jsx?|tsx?)$/.test(path)) return FileCode2;
  if (path.endsWith('.md')) return BookOpen;
  if (path.includes('.github/')) return Activity;
  return File;
}

function App() {
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [loading, setLoading] = useState(true);
  const [connectors, setConnectors] = useState(initialConnectors);
  const [health, setHealth] = useState({ authRequired: false });
  const [page, setPage] = useState('builder');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toastList, setToastList] = useState([]);
  const [busyProjectId, setBusyProjectId] = useState('');
  const [checkingGithub, setCheckingGithub] = useState(false);
  const [checkingRender, setCheckingRender] = useState(false);
  const [githubIdentity, setGithubIdentity] = useState('');
  const [editorDraft, setEditorDraft] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [shellCommand, setShellCommand] = useState('npm run build');
  const [projectSearch, setProjectSearch] = useState('');
  const logEndRef = useRef(null);
  const seenRenderLogs = useRef(new Set());
  const pendingSavesRef = useRef(new Map());
  const savedVersionsRef = useRef(new Map());
  const active = projects.find((project) => project.id === activeId) || null;
  const isBusy = Boolean(busyProjectId);
  const connectorCount = [connectors.anthropicKey, connectors.githubToken, connectors.renderToken].filter(Boolean).length;

  const api = useCallback(async (url, payload, method = 'POST') => {
    const headers = { 'content-type': 'application/json' };
    if (connectors.appPassword) headers['x-app-password'] = connectors.appPassword;
    const response = await fetch(url, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload || {}) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && health.authRequired) throw new Error('Workspace password is missing or incorrect. Open Connectors to unlock it.');
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  }, [connectors.appPassword, health.authRequired]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [stored, serverHealth] = await Promise.all([
          getProjects().catch(() => []),
          fetch('/api/health').then((res) => res.json()).catch(() => ({ ok: false })),
        ]);
        if (!mounted) return;
        setHealth(serverHealth || { authRequired: false });
        let rows = (stored || []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        if (!rows.length) {
          const demo = createDemoProject();
          rows = [demo];
          await saveProject(demo).catch(() => {});
        }
        rows.forEach((project) => savedVersionsRef.current.set(project.id, project.updatedAt));
        setProjects(rows);
        setActiveId(rows[0]?.id || '');
        if (serverHealth?.authRequired && !readSession(SECRET_KEYS.appPassword)) setSettingsOpen(true);
      } catch {
        if (mounted) {
          const demo = createDemoProject();
          setProjects([demo]);
          setActiveId(demo.id);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (active && active.activeFile) {
      setEditorDraft(active.files?.[active.activeFile] || '');
      setEditorDirty(false);
    } else {
      setEditorDraft('');
      setEditorDirty(false);
    }
  }, [active?.id, active?.activeFile, active?.files]);

  useEffect(() => {
    if (loading) return;
    projects.forEach((project) => {
      if (savedVersionsRef.current.get(project.id) === project.updatedAt) return;
      const pending = pendingSavesRef.current.get(project.id);
      if (pending?.updatedAt === project.updatedAt) return;
      if (pending) window.clearTimeout(pending.timer);
      const snapshot = project;
      const timer = window.setTimeout(() => {
        saveProject(snapshot)
          .then(() => savedVersionsRef.current.set(snapshot.id, snapshot.updatedAt))
          .catch((error) => console.warn('Project save failed', error))
          .finally(() => {
            if (pendingSavesRef.current.get(snapshot.id)?.timer === timer) pendingSavesRef.current.delete(snapshot.id);
          });
      }, 300);
      pendingSavesRef.current.set(project.id, { timer, updatedAt: project.updatedAt });
    });
  }, [projects, loading]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [active?.logs?.length]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SECRET_KEYS.anthropicKey, connectors.anthropicKey || '');
      sessionStorage.setItem(SECRET_KEYS.githubToken, connectors.githubToken || '');
      sessionStorage.setItem(SECRET_KEYS.renderToken, connectors.renderToken || '');
      sessionStorage.setItem(SECRET_KEYS.appPassword, connectors.appPassword || '');
      localStorage.setItem(SECRET_KEYS.renderOwnerId, connectors.renderOwnerId || '');
    } catch { /* browser privacy settings may disable local persistence */ }
  }, [connectors]);

  const showToast = useCallback((message, tone = 'info') => {
    const id = `${Date.now()}_${Math.random()}`;
    setToastList((items) => [...items, { id, message, tone }]);
    window.setTimeout(() => setToastList((items) => items.filter((item) => item.id !== id)), 4200);
  }, []);

  const updateProject = useCallback((id, patch) => {
    setProjects((current) => {
      const next = current.map((project) => {
        if (project.id !== id) return project;
        const changed = typeof patch === 'function' ? patch(project) : { ...project, ...patch };
        return { ...changed, updatedAt: new Date().toISOString() };
      });
      return next.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    });
  }, []);

  const appendLog = useCallback((id, text, level = 'info', source = 'StackPilot') => {
    updateProject(id, (project) => ({
      ...project,
      logs: [...(project.logs || []), { time: new Date().toISOString(), level, source, text: String(text) }].slice(-180),
    }));
  }, [updateProject]);

  const setStep = useCallback((id, stepId, status) => {
    updateProject(id, (project) => ({ ...project, steps: { ...(project.steps || {}), [stepId]: status } }));
  }, [updateProject]);

  const createNewProject = () => {
    const project = createBlankProject();
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
    setPage('builder');
    setMobileNavOpen(false);
    saveProject(project).then(() => savedVersionsRef.current.set(project.id, project.updatedAt)).catch(() => {});
    showToast('New project ready. Paste your code to get started.');
  };

  const deleteActiveProject = async () => {
    if (!active) return;
    if (!window.confirm(`Delete “${active.name}” from this browser? Its GitHub repository will not be deleted.`)) return;
    const id = active.id;
    const pendingSave = pendingSavesRef.current.get(id);
    if (pendingSave) window.clearTimeout(pendingSave.timer);
    pendingSavesRef.current.delete(id);
    savedVersionsRef.current.delete(id);
    await removeProject(id).catch(() => {});
    const remaining = projects.filter((item) => item.id !== id);
    if (!remaining.length) {
      const demo = createDemoProject();
      await saveProject(demo).then(() => savedVersionsRef.current.set(demo.id, demo.updatedAt)).catch(() => {});
      setProjects([demo]);
      setActiveId(demo.id);
    } else {
      setProjects(remaining);
      setActiveId(remaining[0].id);
    }
    showToast('Project removed from this device.');
  };

  const saveCurrentEditor = () => {
    if (!active?.activeFile) return;
    updateProject(active.id, (project) => ({ ...project, files: { ...project.files, [project.activeFile]: editorDraft }, isDemo: false }));
    setEditorDirty(false);
    showToast('File saved in this browser.');
  };

  const addSampleInput = () => {
    if (!active) return;
    updateProject(active.id, { rawInput: SAMPLE_DUMP, name: active.isDemo ? active.name : active.name, isDemo: false });
    showToast('Sample code added to the input box.');
  };

  const saveConnectorSettings = () => {
    setSettingsOpen(false);
    showToast('Connectors saved for this browser session.', 'success');
  };

  const handleGithubTest = async () => {
    if (!connectors.githubToken) return showToast('Paste a GitHub token first.', 'error');
    setCheckingGithub(true);
    try {
      const data = await api('/api/github/me', { token: connectors.githubToken });
      setGithubIdentity(data.login || 'Connected');
      showToast(`GitHub connected as ${data.login}.`, 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { setCheckingGithub(false); }
  };

  const handleRenderTest = async () => {
    if (!connectors.renderToken) return showToast('Paste a Render API key first.', 'error');
    setCheckingRender(true);
    try {
      await api('/api/render/test', { token: connectors.renderToken });
      showToast('Render API key accepted.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { setCheckingRender(false); }
  };

  const parseDump = async (projectId, currentProject) => {
    if (!currentProject.rawInput?.trim()) {
      if (Object.keys(currentProject.files || {}).length) return currentProject.files;
      throw new Error('Paste your code or a project brief before organizing.');
    }
    if (!connectors.anthropicKey) {
      setSettingsOpen(true);
      throw new Error('Add your Anthropic key in Connectors to organize real code.');
    }
    appendLog(projectId, 'Sending the code dump to Claude for file planning…', 'info', 'Claude');
    setStep(projectId, 'organize', 'running');
    const result = await api('/api/organize', {
      input: currentProject.rawInput,
      projectName: currentProject.name,
      apiKey: connectors.anthropicKey,
      model: 'claude-sonnet-5-5',
    });
    const files = result.files || {};
    const firstFile = Object.keys(files).sort()[0] || '';
    updateProject(projectId, (project) => ({
      ...project,
      files,
      activeFile: firstFile,
      summary: result.summary || '',
      stack: result.stack || '',
      serviceType: result.deployType === 'static_site' ? 'static_site' : 'web_service',
      runtime: result.runtime || project.runtime || 'node',
      buildCommand: result.buildCommand || (result.deployType === 'static_site' ? '' : project.buildCommand || 'npm install'),
      startCommand: result.startCommand || project.startCommand,
      publishPath: result.publishPath || (result.deployType === 'static_site' ? '.' : project.publishPath),
      isDemo: false,
      status: 'ready',
    }));
    setStep(projectId, 'organize', 'done');
    appendLog(projectId, `Claude organized ${Object.keys(files).length} files · ${result.stack || 'stack detected'}.`, 'success', 'Claude');
    if (result.notes?.length) result.notes.forEach((note) => appendLog(projectId, `Note: ${note}`, 'warning', 'Claude'));
    return files;
  };

  const runOrganizeOnly = async () => {
    if (!active || isBusy) return;
    const id = active.id;
    setBusyProjectId(id);
    appendLog(id, 'Starting AI file organization…');
    try {
      const fresh = projects.find((project) => project.id === id) || active;
      const files = await parseDump(id, fresh);
      const report = await api('/api/validate', { files });
      setStep(id, 'preflight', report.ok ? 'done' : 'error');
      appendLog(id, `Preflight checked ${report.files} files · ${report.findings.length} finding(s).`, report.ok ? 'success' : 'warning', 'Checks');
      report.findings.forEach((finding) => appendLog(id, finding.message, finding.severity === 'error' ? 'error' : 'warning', 'Checks'));
      if (!report.ok) updateProject(id, { status: 'needs_attention' });
      else updateProject(id, { status: 'ready' });
      showToast(report.ok ? 'Files organized and preflight passed.' : 'Files organized; review the preflight warnings.', report.ok ? 'success' : 'info');
    } catch (error) {
      setStep(id, 'organize', 'error');
      appendLog(id, error.message, 'error');
      showToast(error.message, 'error');
    } finally { setBusyProjectId(''); }
  };

  const mergeRepair = (projectId, files, repairResult) => {
    const merged = { ...files, ...(repairResult.files || {}) };
    updateProject(projectId, { files: merged, activeFile: Object.keys(repairResult.files || {})[0] || Object.keys(merged)[0] || '', summary: repairResult.summary || 'Applied a build repair.', isDemo: false });
    appendLog(projectId, `Claude repair: ${repairResult.summary || 'updated project files'}`, 'warning', 'Auto-fix');
    (repairResult.notes || []).forEach((note) => appendLog(projectId, note, 'warning', 'Auto-fix'));
    return merged;
  };

  const pushProject = async (project, files, captureTime) => {
    const repository = project.repo?.trim();
    if (!repository) throw new Error('Enter a GitHub owner/repository in the Release panel.');
    const result = await api('/api/github/push', {
      token: connectors.githubToken,
      repository,
      branch: project.branch || 'main',
      files,
      createIfMissing: true,
      isPrivate: true,
    });
    const allFiles = { ...files, [result.automationFilePath]: result.automationFileContent };
    updateProject(project.id, {
      repo: `${result.owner}/${result.repo}`,
      branch: result.branch,
      files: allFiles,
      activeFile: project.activeFile || Object.keys(files)[0] || '',
      status: 'pushed',
      lastCommit: result.commitSha,
      lastCommitUrl: result.commitUrl,
      isDemo: false,
    });
    appendLog(project.id, `Committed ${result.fileCount} files to ${result.owner}/${result.repo} (${result.commitSha.slice(0, 7)}).`, 'success', 'GitHub');
    return { ...result, capturedAt: captureTime };
  };

  const waitForGithub = async (project, captureAt, { announce = true } = {}) => {
    const start = Date.now();
    let last = '';
    let waited = 0;
    while (Date.now() - start < 7 * 60_000) {
      const info = await api('/api/github/runs', {
        token: connectors.githubToken,
        repository: project.repo,
        branch: project.branch || 'main',
        since: new Date(captureAt).toISOString(),
      });
      if (info.found) {
        const label = `${info.status}${info.conclusion ? ` · ${info.conclusion}` : ''}`;
        if (label !== last) {
          appendLog(project.id, `GitHub Actions ${label}${info.url ? ` · ${info.url}` : ''}`, info.conclusion === 'failure' ? 'error' : 'info', 'GitHub runner');
          last = label;
        }
        if (info.status === 'completed') {
          if (announce) appendLog(project.id, info.conclusion === 'success' ? 'Build and test workflow passed.' : `Workflow ${info.conclusion || 'failed'}.`, info.conclusion === 'success' ? 'success' : 'error', 'GitHub runner');
          return info;
        }
      } else if (waited >= 45_000) {
        throw new Error('No GitHub Actions run appeared. Check that Actions are enabled and the token can read workflow runs.');
      } else if (last !== 'waiting') {
        appendLog(project.id, 'Waiting for the GitHub-hosted runner to start…', 'info', 'GitHub runner');
        last = 'waiting';
      }
      await wait(5000);
      waited += 5000;
    }
    throw new Error('GitHub Actions is taking longer than 7 minutes. Open the workflow link and check its status.');
  };

  const loadRenderLogs = async (project, since) => {
    try {
      const result = await api('/api/render/logs', {
        token: connectors.renderToken,
        ownerId: connectors.renderOwnerId,
        serviceId: project.renderServiceId,
        since,
      });
      (result.logs || []).slice(-80).forEach((line) => {
        const key = `${project.id}:${line.time}:${line.type}:${line.message}`;
        if (seenRenderLogs.current.has(key)) return;
        seenRenderLogs.current.add(key);
        if (seenRenderLogs.current.size > 1000) seenRenderLogs.current.clear();
        appendLog(project.id, line.message, /error|fatal/i.test(`${line.level} ${line.message}`) ? 'error' : 'info', `Render ${line.type || 'log'}`);
      });
      return (result.logs || []).map((line) => line.message).join('\n');
    } catch (error) {
      appendLog(project.id, `Could not load Render logs: ${error.message}`, 'warning', 'Render');
      return '';
    }
  };

  const waitForRender = async (project, deployId, since) => {
    const start = Date.now();
    let lastStatus = '';
    while (Date.now() - start < 10 * 60_000) {
      const latestProject = { ...(projects.find((item) => item.id === project.id) || {}), ...project };
      const info = await api('/api/render/status', {
        token: connectors.renderToken,
        serviceId: latestProject.renderServiceId,
        deployId,
      });
      const status = info.status || 'unknown';
      if (status !== lastStatus) {
        appendLog(project.id, `Render deployment: ${status.replaceAll('_', ' ')}.`, ['build_failed', 'update_failed', 'pre_deploy_failed'].includes(status) ? 'error' : 'info', 'Render');
        lastStatus = status;
      }
      if (info.url) updateProject(project.id, { renderUrl: info.url, renderDashboardUrl: info.dashboardUrl || latestProject.renderDashboardUrl || '' });
      if (status === 'live') {
        await loadRenderLogs({ ...latestProject, ...info }, since);
        return { ok: true, info };
      }
      if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(status)) {
        const logs = await loadRenderLogs(latestProject, since);
        return { ok: false, info, logs };
      }
      await loadRenderLogs(latestProject, since);
      await wait(7000);
    }
    return { ok: false, timeout: true, logs: await loadRenderLogs(projects.find((item) => item.id === project.id) || project, since) };
  };

  const runFullPipeline = async () => {
    if (!active || isBusy) return;
    if (!connectors.githubToken) { setSettingsOpen(true); showToast('Add a GitHub token before running the full pipeline.', 'error'); return; }
    if (!connectors.anthropicKey && !active.files?.['index.html'] && !Object.keys(active.files || {}).length) { setSettingsOpen(true); showToast('Add your Claude key to organize the pasted code.', 'error'); return; }
    const projectId = active.id;
    setBusyProjectId(projectId);
    updateProject(projectId, { status: 'running', steps: Object.fromEntries(STEPS.map((step) => [step.id, 'idle'])) });
    appendLog(projectId, 'Full automation started. Secrets stay in this browser session; project files stay in this browser and GitHub.');
    let current = projects.find((project) => project.id === projectId) || active;
    let files = {};
    let repairCount = 0;
    let pushed = null;
    const canOrganize = Boolean(current.rawInput?.trim());
    try {
      if (canOrganize) {
        files = await parseDump(projectId, current);
        current = { ...current, files };
      } else if (Object.keys(current.files || {}).length) {
        files = current.files;
        setStep(projectId, 'organize', 'done');
        appendLog(projectId, 'Using the saved file tree; no new code dump to organize.', 'info', 'Claude');
      } else {
        throw new Error('Paste a code dump first, or add files to this project.');
      }

      while (true) {
        setStep(projectId, 'preflight', 'running');
        const preflight = await api('/api/validate', { files });
        appendLog(projectId, `Preflight: ${preflight.files} files · ${preflight.findings.length} finding(s).`, preflight.ok ? 'success' : 'warning', 'Checks');
        preflight.findings.forEach((finding) => appendLog(projectId, finding.message, finding.severity === 'error' ? 'error' : 'warning', 'Checks'));
        if (preflight.findings.some((finding) => finding.severity === 'error')) {
          if (!connectors.anthropicKey || repairCount >= 2) throw new Error('Preflight found blocking issues. Review the log or add Claude to repair them.');
          const repair = await api('/api/repair', { files, errors: preflight.findings.map((finding) => finding.message).join('\n'), apiKey: connectors.anthropicKey, model: 'claude-sonnet-5-5' });
          files = mergeRepair(projectId, files, repair);
          repairCount += 1;
          continue;
        }
        setStep(projectId, 'preflight', 'done');
        break;
      }

      while (true) {
        setStep(projectId, 'github', 'running');
        appendLog(projectId, `Pushing ${Object.keys(files).length} project files to GitHub…`, 'info', 'GitHub');
        const captureAt = Date.now();
        pushed = await pushProject({ ...current, ...(projects.find((item) => item.id === projectId) || {}), repo: current.repo, branch: current.branch }, files, captureAt);
        current = { ...current, repo: `${pushed.owner}/${pushed.repo}`, branch: pushed.branch, files: { ...files, [pushed.automationFilePath]: pushed.automationFileContent }, lastCommit: pushed.commitSha };
        files = current.files;
        setStep(projectId, 'github', 'done');
        setStep(projectId, 'runner', 'running');
        const run = await waitForGithub(current, captureAt);
        if (run.conclusion === 'success') {
          setStep(projectId, 'runner', 'done');
          break;
        }
        if (repairCount >= 2 || !connectors.anthropicKey || !run.logs) {
          setStep(projectId, 'runner', 'error');
          updateProject(projectId, { status: 'needs_attention' });
          throw new Error(run.logs ? 'Remote build failed after the allowed repair attempts.' : 'Remote build failed. Add Claude and check the GitHub Actions log archive to enable auto-repair.');
        }
        repairCount += 1;
        appendLog(projectId, `Build failed. Claude is reviewing the GitHub log (repair ${repairCount}/2)…`, 'warning', 'Auto-fix');
        const repaired = await api('/api/repair', { files, errors: run.logs, apiKey: connectors.anthropicKey, model: 'claude-sonnet-5-5' });
        files = mergeRepair(projectId, files, repaired);
        current = { ...current, files };
      }

      const currentAfterCheck = projects.find((item) => item.id === projectId) || current;
      const renderToken = connectors.renderToken;
      if (!renderToken || !connectors.renderOwnerId) {
        setStep(projectId, 'render', 'idle');
        updateProject(projectId, { status: 'verified' });
        appendLog(projectId, 'Checks passed. Add a Render API key and workspace ID in Connectors to deploy.', 'success', 'StackPilot');
        showToast('GitHub build checks passed. Connect Render to publish the project.', 'success');
        return;
      }

      let serviceId = currentAfterCheck.renderServiceId || current.renderServiceId || '';
      let deployId = '';
      let renderSince = new Date().toISOString();
      setStep(projectId, 'render', 'running');
      if (!serviceId) {
        appendLog(projectId, 'Creating a Render service on the Free plan…', 'info', 'Render');
        renderSince = new Date().toISOString();
        const created = await api('/api/render/create', {
          token: renderToken,
          ownerId: connectors.renderOwnerId,
          repository: current.repo,
          branch: current.branch,
          name: current.slug,
          serviceType: current.serviceType,
          runtime: current.runtime,
          region: current.region || 'frankfurt',
          buildCommand: current.buildCommand,
          startCommand: current.startCommand,
          publishPath: current.publishPath,
          rootDir: current.rootDir,
        });
        serviceId = created.serviceId;
        deployId = created.deployId;
        updateProject(projectId, { renderServiceId: serviceId, renderUrl: created.url || '', renderDashboardUrl: created.dashboardUrl || '', renderDeployId: deployId, status: 'deploying' });
        appendLog(projectId, `Render service created: ${serviceId}. ${created.dashboardUrl || ''}`, 'success', 'Render');
      } else {
        appendLog(projectId, 'Starting a Render deploy for the verified commit…', 'info', 'Render');
        renderSince = new Date().toISOString();
        const queued = await api('/api/render/deploy', { token: renderToken, serviceId, commitId: pushed?.commitSha });
        deployId = queued.deployId;
        updateProject(projectId, { renderDeployId: deployId, status: 'deploying' });
      }
      let outcome = await waitForRender({ ...currentAfterCheck, renderServiceId: serviceId }, deployId, renderSince);
      while (!outcome.ok && repairCount < 2 && connectors.anthropicKey && outcome.logs) {
        repairCount += 1;
        appendLog(projectId, `Render build failed. Claude is applying repair ${repairCount}/2…`, 'warning', 'Auto-fix');
        const repaired = await api('/api/repair', { files, errors: outcome.logs, apiKey: connectors.anthropicKey, model: 'claude-sonnet-5-5' });
        files = mergeRepair(projectId, files, repaired);
        current = { ...current, files, renderServiceId: serviceId };
        const captureAt = Date.now();
        pushed = await pushProject(current, files, captureAt);
        current = { ...current, repo: `${pushed.owner}/${pushed.repo}`, branch: pushed.branch, lastCommit: pushed.commitSha, files: { ...files, [pushed.automationFilePath]: pushed.automationFileContent } };
        files = current.files;
        const check = await waitForGithub(current, captureAt);
        if (check.conclusion !== 'success') {
          outcome = { ok: false, logs: check.logs || 'GitHub Actions did not pass after Render repair.' };
          break;
        }
        const nextDeploy = await api('/api/render/deploy', { token: renderToken, serviceId, commitId: pushed.commitSha });
        deployId = nextDeploy.deployId;
        renderSince = new Date().toISOString();
        outcome = await waitForRender(current, deployId, renderSince);
      }
      if (!outcome.ok) {
        setStep(projectId, 'render', 'error');
        updateProject(projectId, { status: 'needs_attention' });
        throw new Error(outcome.timeout ? 'Render is still building after 10 minutes. Check the Render dashboard and logs.' : 'Render deployment failed. Review the logs before trying another repair.');
      }
      setStep(projectId, 'render', 'done');
      updateProject(projectId, { status: 'live', renderUrl: outcome.info.url || (projects.find((item) => item.id === projectId)?.renderUrl || ''), renderDeployId: outcome.info.deployId || deployId, isDemo: false });
      appendLog(projectId, `Live on Render${outcome.info.url ? `: ${outcome.info.url}` : '.'}`, 'success', 'Render');
      showToast('Build passed and Render deployment is live.', 'success');
    } catch (error) {
      const message = error.message || 'Pipeline stopped unexpectedly.';
      appendLog(projectId, message, 'error');
      updateProject(projectId, { status: 'needs_attention' });
      showToast(message, 'error');
    } finally { setBusyProjectId(''); }
  };

  const runShellCommand = async () => {
    if (!active || isBusy) return;
    if (!connectors.githubToken) { setSettingsOpen(true); showToast('Connect GitHub to use the remote shell.', 'error'); return; }
    if (!active.repo) return showToast('Push this project to GitHub first.', 'error');
    if (!shellCommand.trim()) return showToast('Enter a command to run.', 'error');
    const project = active;
    setBusyProjectId(project.id);
    try {
      const captureAt = Date.now();
      appendLog(project.id, `Queueing temporary runner command: ${shellCommand}`, 'info', 'Terminal');
      await api('/api/github/dispatch', {
        token: connectors.githubToken,
        repository: project.repo,
        branch: project.branch || 'main',
        command: shellCommand,
      });
      appendLog(project.id, 'Command accepted by GitHub Actions. Runner status refreshes every 5 seconds; full logs arrive when the job finishes.', 'info', 'Terminal');
      const result = await waitForGithub(project, captureAt, { announce: false });
      if (result.logs) {
        result.logs.split('\n').slice(-90).forEach((line) => appendLog(project.id, line, /error|failed|fatal/i.test(line) ? 'error' : 'info', 'Terminal'));
      }
      if (result.conclusion === 'success') showToast('Remote command completed successfully.', 'success');
      else {
        showToast(`Remote command ${result.conclusion || 'did not pass'}.`, 'error');
        if (result.logs && connectors.anthropicKey) {
          appendLog(project.id, 'Use “Repair failed build” from the next prompt to ask Claude to diagnose these logs.', 'warning', 'StackPilot');
        }
      }
    } catch (error) {
      appendLog(project.id, error.message, 'error', 'Terminal');
      showToast(error.message, 'error');
    } finally { setBusyProjectId(''); }
  };

  const runDemo = async () => {
    if (!active || isBusy) return;
    const projectId = active.id;
    setBusyProjectId(projectId);
    const demoLines = [
      ['organize', 'Demo only — no Claude API request was made.'],
      ['preflight', 'Sample files checked locally; no shell command executed.'],
      ['github', 'Demo only — no repository was created or changed.'],
      ['runner', 'Demo only — no GitHub Actions job was started.'],
      ['render', 'Demo only — no Render service was created.'],
    ];
    updateProject(projectId, { status: 'demo', steps: Object.fromEntries(STEPS.map((step) => [step.id, 'idle'])) });
    for (const [step, message] of demoLines) {
      setStep(projectId, step, 'running');
      appendLog(projectId, message, 'info', 'Demo');
      await wait(450);
      setStep(projectId, step, 'demo');
    }
    appendLog(projectId, 'Sample flow complete. Connect your API keys to run the real pipeline.', 'success', 'Demo');
    updateProject(projectId, { status: 'demo' });
    setBusyProjectId('');
    showToast('Demo finished. No external services were called.');
  };

  const updateProjectName = (value) => {
    if (!active) return;
    updateProject(active.id, { name: value, slug: slugify(value) || active.slug });
  };

  const setSelectedFile = (filePath) => {
    if (!active) return;
    if (editorDirty && !window.confirm('Discard unsaved file edits?')) return;
    updateProject(active.id, { activeFile: filePath });
  };

  const filteredProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    return projects.filter((project) => !query || project.name.toLowerCase().includes(query) || project.slug.toLowerCase().includes(query));
  }, [projects, projectSearch]);

  if (loading) return <div className="app-loading"><div className="brand-symbol">S</div><span>Loading workspace…</span></div>;

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
      <Sidebar
        projects={filteredProjects}
        activeId={activeId}
        page={page}
        search={projectSearch}
        onSearch={setProjectSearch}
        onSelectProject={(id) => { setActiveId(id); setPage('builder'); setMobileNavOpen(false); }}
        onNew={createNewProject}
        onNavigate={(target) => { setPage(target); setMobileNavOpen(false); }}
        onSettings={() => { setSettingsOpen(true); setMobileNavOpen(false); }}
        connectorCount={connectorCount}
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed((value) => !value)}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu-button" onClick={() => setMobileNavOpen(true)} aria-label="Open menu"><Menu size={19} /></button>
            <button className="icon-button collapse-button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label="Toggle sidebar">{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
            <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{page === 'builder' ? active?.name || 'Projects' : page === 'deployments' ? 'Deployments' : 'Projects'}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className={`mode-tag ${health.mode === 'cloud' ? 'mode-cloud' : ''}`}><span />{health.mode === 'cloud' ? 'Cloud workspace' : 'Development preview'}</span>
            <button className="connect-button" onClick={() => setSettingsOpen(true)}><KeyRound size={15} /><span>Connectors</span><span className="connector-count">{connectorCount}/3</span></button>
            <button className="avatar-button" onClick={() => setSettingsOpen(true)} aria-label="Workspace settings">S</button>
          </div>
        </header>

        {page === 'builder' && active ? (
          <main className="content-area">
            <section className="page-heading">
              <div>
                <div className="section-kicker"><span className="kicker-line" /> CODE WORKSPACE</div>
                <div className="title-row"><input className="project-title-input" value={active.name} onChange={(event) => updateProjectName(event.target.value)} aria-label="Project name" /><span className={`status-pill status-${active.status}`}>{statusLabel(active.status)}</span></div>
                <p className="page-subtitle">One paste. A proper project structure, tested build, and a link you can share.</p>
              </div>
              <div className="heading-actions">
                <button className="button-secondary" onClick={createNewProject}><Plus size={16} /> New project</button>
                <button className="button-quiet" onClick={deleteActiveProject} title="Remove from this device"><Trash2 size={16} /></button>
              </div>
            </section>

            <section className="composer-card">
              <div className="composer-topline">
                <div className="composer-label"><span className="step-number">01</span><div><strong>Drop in the code dump</strong><small>Paste everything you have — file names, code blocks, and instructions.</small></div></div>
                <button className="text-action" onClick={addSampleInput}><Sparkles size={14} /> Use sample</button>
              </div>
              <textarea
                className="code-dump-input"
                value={active.rawInput || ''}
                onChange={(event) => updateProject(active.id, { rawInput: event.target.value, isDemo: false })}
                placeholder={'Paste the whole response here — even if it is one long code block.\n\nStackPilot will ask Claude to split it into files, add missing setup, and keep a clear file tree.'}
                aria-label="Paste the whole code dump"
              />
              <div className="composer-footer">
                <div className="input-meta"><span className="claude-mark">✳</span><span>Claude Sonnet</span><span className="meta-separator">·</span><span>{(active.rawInput || '').length.toLocaleString()} characters</span>{active.files && Object.keys(active.files).length > 0 && <><span className="meta-separator">·</span><span>{Object.keys(active.files).length} saved files</span></>}</div>
                <div className="composer-actions">
                  <button className="button-secondary button-small" onClick={runOrganizeOnly} disabled={isBusy}><Sparkles size={15} /> Organize files</button>
                  <button className="button-primary button-small" onClick={runFullPipeline} disabled={isBusy}><Rocket size={15} /> {isBusy && busyProjectId === active.id ? <><Loader2 className="spin" size={15} /> Working…</> : <>Run full pipeline <ArrowRight size={15} /></>}</button>
                </div>
              </div>
              <div className="trust-note"><LockKeyhole size={13} /><span>Keys stay in this browser session. Source is saved on this device, then in GitHub after you push.</span></div>
            </section>

            <div className="workspace-grid">
              <section className="panel files-panel">
                <div className="panel-header"><div className="panel-title"><Folder size={16} /><strong>Project files</strong><span className="count-badge">{Object.keys(active.files || {}).length}</span></div><button className="icon-button small-icon" title="Refresh files"><RefreshCw size={14} /></button></div>
                <div className="project-root"><ChevronDown size={13} /><Folder size={14} className="root-folder-icon" /><span>{active.slug || 'untitled-project'}</span></div>
                <FileTree files={active.files || {}} current={active.activeFile} onSelect={setSelectedFile} />
                {Object.keys(active.files || {}).length === 0 && <div className="empty-files"><div className="empty-files-icon"><FileCode2 size={19} /></div><strong>Your file tree will appear here</strong><span>Paste code above and choose <b>Organize files</b>.</span><button className="text-action" onClick={addSampleInput}>Try a sample dump <ArrowRight size={13} /></button></div>}
                <div className="files-panel-footer"><span><span className="tiny-dot" /> Saved locally</span><span>{formatBytes(totalFileBytes(active.files || {}))}</span></div>
              </section>

              <section className="panel editor-panel">
                <div className="panel-header editor-header"><div className="file-breadcrumb"><FileCode2 size={15} /><span>{active.activeFile || 'No file selected'}</span><span className="language-badge">{active.activeFile ? fileLanguage(active.activeFile) : '—'}</span></div><div className="editor-actions">{editorDirty && <span className="unsaved-label">Unsaved</span>}<button className="icon-button small-icon" onClick={() => { navigator.clipboard?.writeText(editorDraft).then(() => showToast('File copied.')).catch(() => showToast('Copy is unavailable in this browser.', 'error')); }} disabled={!editorDraft} title="Copy file"><Clipboard size={14} /></button><button className="save-file-button" onClick={saveCurrentEditor} disabled={!editorDirty}><Save size={13} /> Save</button></div></div>
                {active.activeFile ? <div className="editor-wrap"><div className="editor-gutter">{Array.from({ length: Math.max(1, editorDraft.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea className="code-editor" spellCheck="false" value={editorDraft} onChange={(event) => { setEditorDraft(event.target.value); setEditorDirty(true); }} aria-label={`Edit ${active.activeFile}`} /></div> : <div className="editor-empty"><div className="editor-empty-icon"><Code2 size={24} /></div><strong>Editor is ready</strong><span>Select a file from the tree, or paste your code above to get started.</span></div>}
                <div className="editor-footer"><span>UTF-8 <span>·</span> {active.activeFile ? `${editorDraft.split('\n').length} lines` : 'No file'}</span><span>{active.activeFile ? fileLanguage(active.activeFile) : 'StackPilot editor'}</span></div>
              </section>

              <section className="panel release-panel">
                <div className="panel-header"><div className="panel-title"><Rocket size={16} /><strong>Release</strong></div><button className="icon-button small-icon" onClick={() => setPage('deployments')} title="Deployment history"><MoreHorizontal size={16} /></button></div>
                <div className="release-panel-body">
                  <div className="release-block">
                    <label className="field-label" htmlFor="github-repo">GitHub repository</label>
                    <div className="input-with-icon"><Github size={15} /><input id="github-repo" value={active.repo || ''} onChange={(event) => updateProject(active.id, { repo: event.target.value })} placeholder="your-name/project-name" /></div>
                    <div className="field-footnote">Create a private repo automatically, or paste one you already own.</div>
                    <div className="input-row-label branch-field"><label className="field-label" htmlFor="github-branch">Branch</label><input className="compact-field" id="github-branch" value={active.branch || ''} onChange={(event) => updateProject(active.id, { branch: event.target.value })} placeholder="main" /></div>
                  </div>
                  <div className="release-divider" />
                  <div className="release-block">
                    <div className="release-heading-row"><label className="field-label" htmlFor="service-type">Render service</label><span className="free-plan-tag"><span /> FREE PLAN</span></div>
                    <div className="select-wrap"><select id="service-type" value={active.serviceType || 'web_service'} onChange={(event) => updateProject(active.id, { serviceType: event.target.value })}><option value="web_service">Web service</option><option value="static_site">Static site</option></select><ChevronDown size={14} /></div>
                    {active.serviceType === 'static_site' ? <>
                      <div className="input-row-label"><label className="field-label" htmlFor="build-command">Build command</label><input className="compact-field" id="build-command" value={active.buildCommand || ''} onChange={(event) => updateProject(active.id, { buildCommand: event.target.value })} placeholder="npm install && npm run build" /></div>
                      <div className="input-row-label"><label className="field-label" htmlFor="publish-path">Publish directory</label><input className="compact-field" id="publish-path" value={active.publishPath || ''} onChange={(event) => updateProject(active.id, { publishPath: event.target.value })} placeholder="dist" /></div>
                    </> : <>
                      <div className="input-row-label"><label className="field-label" htmlFor="build-command">Build command</label><input className="compact-field" id="build-command" value={active.buildCommand || ''} onChange={(event) => updateProject(active.id, { buildCommand: event.target.value })} placeholder="npm install && npm run build" /></div>
                      <div className="input-row-label"><label className="field-label" htmlFor="start-command">Start command</label><input className="compact-field" id="start-command" value={active.startCommand || ''} onChange={(event) => updateProject(active.id, { startCommand: event.target.value })} placeholder="npm start" /></div>
                      <div className="input-row-label"><label className="field-label" htmlFor="runtime-select">Runtime</label><div className="select-wrap"><select id="runtime-select" value={active.runtime || 'node'} onChange={(event) => updateProject(active.id, { runtime: event.target.value })}><option value="node">Node.js</option><option value="python">Python</option><option value="ruby">Ruby</option><option value="go">Go</option><option value="elixir">Elixir</option></select><ChevronDown size={14} /></div></div>
                      <div className="input-row-label"><label className="field-label" htmlFor="render-region">Region</label><div className="select-wrap"><select id="render-region" value={active.region || 'frankfurt'} onChange={(event) => updateProject(active.id, { region: event.target.value })}><option value="frankfurt">Frankfurt</option><option value="singapore">Singapore</option><option value="oregon">Oregon</option><option value="ohio">Ohio</option><option value="virginia">Virginia</option></select><ChevronDown size={14} /></div></div>
                    </>}
                  </div>
                  <div className="release-divider" />
                  <ol className="pipeline-list">
                    {STEPS.map((step, index) => <PipelineStep key={step.id} step={step} index={index} status={active.steps?.[step.id] || 'idle'} />)}
                  </ol>
                  {active.renderUrl && <a className="live-url-card" href={active.renderUrl} target="_blank" rel="noreferrer"><span className="live-url-icon"><Globe size={15} /></span><span><small>LIVE ON RENDER</small><strong>{active.renderUrl.replace(/^https?:\/\//, '')}</strong></span><ArrowUpRight size={15} /></a>}
                  <button className="button-primary release-run-button" onClick={runFullPipeline} disabled={isBusy || Object.keys(active.files || {}).length === 0 && !active.rawInput?.trim()}><Rocket size={15} /> {isBusy && busyProjectId === active.id ? 'Automation running…' : 'Run full automation'}</button>
                  {active.isDemo && <button className="button-demo" onClick={runDemo} disabled={isBusy}><Zap size={14} /> Preview demo flow</button>}
                  <p className="release-hint"><CircleHelp size={13} /> Free Render services may sleep when idle. Your project source is kept in GitHub, not on Render's temporary disk.</p>
                </div>
              </section>
            </div>

            <section className="terminal-panel">
              <div className="terminal-header">
                <div className="terminal-title"><Terminal size={16} /><strong>Activity & logs</strong><span className={`live-dot ${isBusy ? 'live-dot-active' : ''}`} />{isBusy ? <span className="terminal-live-label">LIVE</span> : <span className="terminal-session-label">SESSION LOG</span>}</div>
                <div className="terminal-tools"><span className="terminal-agent"><span className="terminal-agent-dot" /> automation</span><button className="icon-button terminal-clear" onClick={() => updateProject(active.id, { logs: [] })} title="Clear activity"><Trash2 size={14} /></button><button className="icon-button terminal-expand" title="Terminal"><MoreHorizontal size={16} /></button></div>
              </div>
              <div className="terminal-body">
                {active.logs?.length ? active.logs.slice(-70).map((entry, index) => <div className={`log-line log-${entry.level || 'info'}`} key={`${entry.time}_${index}`}><span className="log-time">{shortTime(entry.time)}</span><span className="log-source">{entry.source || 'StackPilot'}</span><span className="log-message">{entry.text}</span></div>) : <div className="terminal-placeholder"><span className="terminal-prompt">$</span><span>Logs from organization, checks, GitHub, and Render will appear here.</span></div>}
                <div ref={logEndRef} />
              </div>
              <div className="shell-bar"><span className="shell-prompt"><Terminal size={14} /><span>RUN</span></span><input value={shellCommand} onChange={(event) => setShellCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') runShellCommand(); }} placeholder="npm run build" aria-label="Remote shell command" /><span className="shell-runtime-label">GitHub Actions runner</span><button className="shell-run-button" onClick={runShellCommand} disabled={isBusy || !active.repo}><Send size={14} /> Run command</button></div>
              <div className="shell-disclaimer"><ShieldCheck size={13} /><span>Commands run on a temporary GitHub-hosted runner with the repository and network access, but no StackPilot keys. Run trusted source only; logs arrive when the job finishes.</span><button onClick={() => setSettingsOpen(true)}>Runner details</button></div>
            </section>

            <footer className="workspace-footer"><span>StackPilot <span className="footer-dot">·</span> Private drafts stay on this device</span><span>Render deployment is initiated only after checks pass</span></footer>
          </main>
        ) : page === 'projects' ? (
          <ProjectsPage projects={filteredProjects} onOpen={(id) => { setActiveId(id); setPage('builder'); }} onNew={createNewProject} search={projectSearch} onSearch={setProjectSearch} />
        ) : (
          <DeploymentsPage projects={projects} onOpen={(id) => { setActiveId(id); setPage('builder'); }} />
        )}
      </div>

      {settingsOpen && <SettingsModal
        connectors={connectors}
        setConnectors={setConnectors}
        health={health}
        githubIdentity={githubIdentity}
        checkingGithub={checkingGithub}
        checkingRender={checkingRender}
        onGithubTest={handleGithubTest}
        onRenderTest={handleRenderTest}
        onSave={saveConnectorSettings}
        onClose={() => setSettingsOpen(false)}
      />}
      <div className="toast-stack" aria-live="polite">{toastList.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}><span className="toast-icon">{toast.tone === 'error' ? <CircleX size={17} /> : toast.tone === 'success' ? <CheckCircle2 size={17} /> : <Activity size={17} />}</span><span>{toast.message}</span><button onClick={() => setToastList((list) => list.filter((item) => item.id !== toast.id))}><X size={14} /></button></div>)}</div>
    </div>
  );
}

function Sidebar({ projects, activeId, page, search, onSearch, onSelectProject, onNew, onNavigate, onSettings, connectorCount, collapsed, onCollapse, onCloseMobile }) {
  return (
    <>
      <div className="sidebar-scrim" onClick={onCloseMobile} />
      <aside className="sidebar">
        <div className="sidebar-brand-row"><button className="brand-lockup" onClick={() => onNavigate('builder')}><span className="brand-symbol">S</span><span className="brand-name">stackpilot<span>AI BUILD WORKSPACE</span></span></button><button className="icon-button sidebar-close" onClick={onCloseMobile} aria-label="Close menu"><X size={18} /></button><button className="icon-button sidebar-collapse" onClick={onCollapse} aria-label="Collapse sidebar"><PanelLeftClose size={17} /></button></div>
        <div className="sidebar-workspace"><div className="workspace-avatar">Y</div><div className="workspace-name"><strong>Your workspace</strong><span>Personal</span></div><ChevronDown size={14} className="workspace-chevron" /></div>
        <div className="sidebar-nav-label">WORKSPACE</div>
        <nav className="primary-nav">
          <button className={`nav-item ${page === 'builder' ? 'active' : ''}`} onClick={() => onNavigate('builder')}><Layers3 size={17} /><span>Build workspace</span><span className="nav-shortcut">⌘ 1</span></button>
          <button className={`nav-item ${page === 'projects' ? 'active' : ''}`} onClick={() => onNavigate('projects')}><Folder size={17} /><span>All projects</span><span className="nav-count">{projects.length}</span></button>
          <button className={`nav-item ${page === 'deployments' ? 'active' : ''}`} onClick={() => onNavigate('deployments')}><Activity size={17} /><span>Deployments</span></button>
        </nav>
        <div className="sidebar-project-section"><div className="sidebar-section-heading"><span>YOUR PROJECTS</span><button className="sidebar-add" onClick={onNew} aria-label="New project"><Plus size={15} /></button></div><div className="sidebar-search"><Search size={14} /><input placeholder="Find a project" value={search} onChange={(event) => onSearch(event.target.value)} /></div><div className="sidebar-project-list">
          {projects.length ? projects.slice(0, 8).map((project) => <button key={project.id} className={`project-nav-item ${activeId === project.id ? 'selected' : ''}`} onClick={() => onSelectProject(project.id)}><span className={`project-color-dot project-${project.status}`} /><span className="project-nav-name">{project.name}</span>{project.status === 'live' && <span className="project-live-indicator" title="Live" />}</button>) : <div className="sidebar-empty-projects">No matching projects.</div>}
        </div></div>
        <div className="sidebar-spacer" />
        <div className="sidebar-connect-card"><div className="connect-card-icon"><KeyRound size={16} /></div><div className="connect-card-copy"><strong>Connect your tools</strong><span>{connectorCount}/3 services ready</span></div><button onClick={onSettings} aria-label="Configure connectors"><ArrowRight size={15} /></button><div className="connector-meter"><span style={{ width: `${(connectorCount / 3) * 100}%` }} /></div></div>
        <button className="sidebar-settings" onClick={onSettings}><Settings2 size={17} /><span>Connectors & settings</span><span className="settings-dot" /></button>
        <div className="sidebar-user"><div className="user-avatar">SP</div><div className="user-info"><strong>StackPilot</strong><span>Single-user workspace</span></div><button className="icon-button small-icon" onClick={onSettings} title="Workspace settings"><MoreHorizontal size={16} /></button></div>
      </aside>
    </>
  );
}

function FileTree({ files, current, onSelect }) {
  const [closed, setClosed] = useState({});
  const tree = useMemo(() => {
    const root = { folders: {}, files: [] };
    Object.keys(files).forEach((filePath) => {
      const parts = filePath.split('/');
      let branch = root;
      for (const part of parts.slice(0, -1)) {
        branch.folders[part] ||= { folders: {}, files: [] };
        branch = branch.folders[part];
      }
      branch.files.push({ name: parts.at(-1), path: filePath });
    });
    return root;
  }, [files]);

  const renderBranch = (branch, depth = 0, parentPath = '') => <>
    {Object.keys(branch.folders).sort((a, b) => a.localeCompare(b)).map((name) => {
      const folderPath = parentPath ? `${parentPath}/${name}` : name;
      const isClosed = Boolean(closed[folderPath]);
      return <div key={`folder:${folderPath}`}>
        <button className="tree-folder-row" style={{ '--depth': depth }} onClick={() => setClosed((currentState) => ({ ...currentState, [folderPath]: !currentState[folderPath] }))} title={folderPath}>
          {isClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<Folder size={14} /><span>{name}</span><span className="folder-file-count">{countTreeFiles(branch.folders[name])}</span>
        </button>
        {!isClosed && renderBranch(branch.folders[name], depth + 1, folderPath)}
      </div>;
    })}
    {branch.files.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, path }) => {
      const Icon = getFileIcon(path);
      return <button className={`tree-file ${current === path ? 'tree-file-active' : ''}`} style={{ '--depth': depth }} key={`file:${path}`} onClick={() => onSelect(path)} title={path}>
        <Icon size={14} /><span>{name}</span>{path.includes('.github/') && <span className="tree-status-dot" />}
      </button>;
    })}
  </>;
  return <div className="file-tree">{renderBranch(tree)}</div>;
}

function countTreeFiles(branch) {
  return branch.files.length + Object.values(branch.folders).reduce((sum, folder) => sum + countTreeFiles(folder), 0);
}

function PipelineStep({ step, index, status }) {
  const Icon = step.icon;
  const complete = status === 'done' || status === 'demo';
  const error = status === 'error';
  const running = status === 'running';
  return <li className={`pipeline-step pipeline-${status}`}>
    <div className="pipeline-step-rail"><span className="pipeline-icon">{complete ? <Check size={14} /> : error ? <CircleX size={14} /> : running ? <Loader2 size={14} className="spin" /> : <Icon size={14} />}</span>{index < STEPS.length - 1 && <span className="pipeline-connector" />}</div>
    <div className="pipeline-copy"><div><strong>{step.label}</strong>{status === 'demo' && <span className="mini-demo-label">DEMO</span>}</div><span>{status === 'running' ? 'In progress…' : status === 'done' ? 'Complete' : status === 'error' ? 'Needs attention' : status === 'demo' ? 'Previewed only' : step.detail}</span></div>
    {complete && status === 'done' && <CheckCircle2 size={15} className="pipeline-done-mark" />}
  </li>;
}

function SettingsModal({ connectors, setConnectors, health, githubIdentity, checkingGithub, checkingRender, onGithubTest, onRenderTest, onSave, onClose }) {
  const update = (key, value) => setConnectors((current) => ({ ...current, [key]: value }));
  const clearSecrets = () => {
    setConnectors((current) => ({ ...current, anthropicKey: '', githubToken: '', renderToken: '', appPassword: '' }));
  };
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal-header"><div className="modal-title-icon"><KeyRound size={19} /></div><div><h2 id="settings-title">Connect your tools</h2><p>Keys are sent only when you run an action and kept in this browser session.</p></div><button className="icon-button modal-close" onClick={onClose} aria-label="Close settings"><X size={18} /></button></div>
      <div className="modal-scroll">
        {health.authRequired && <div className="workspace-password-card"><div className="password-card-icon"><LockKeyhole size={17} /></div><div className="password-card-copy"><strong>Unlock this workspace</strong><span>This app is protected by the APP_PASSWORD set in Render.</span></div><label className="settings-field password-field"><span>App password</span><input type="password" autoComplete="current-password" value={connectors.appPassword} onChange={(event) => update('appPassword', event.target.value)} placeholder="Enter the workspace password" /><small>Saved only for this browser tab session.</small></label></div>}
        <div className="connector-form-card"><div className="connector-card-heading"><div className="connector-brand claude-brand">✳</div><div><strong>Claude / Anthropic</strong><span>Organize code and repair build failures</span></div><span className={`connection-state ${connectors.anthropicKey ? 'connected' : ''}`}><span />{connectors.anthropicKey ? 'KEY ADDED' : 'NOT CONNECTED'}</span></div><label className="settings-field"><span>Anthropic API key</span><input type="password" autoComplete="new-password" value={connectors.anthropicKey} onChange={(event) => update('anthropicKey', event.target.value)} placeholder="sk-ant-api…" /><small>Used for code organization and up to two evidence-based repair attempts.</small></label><div className="provider-note"><ShieldCheck size={13} /> Never committed to a project or stored on the server.</div></div>
        <div className="connector-form-card"><div className="connector-card-heading"><div className="connector-brand github-brand"><Github size={17} /></div><div><strong>GitHub</strong><span>Commit files and run the temporary shell</span></div><span className={`connection-state ${connectors.githubToken ? 'connected' : ''}`}><span />{githubIdentity || (connectors.githubToken ? 'KEY ADDED' : 'NOT CONNECTED')}</span></div><label className="settings-field"><span>Personal access token</span><input type="password" autoComplete="new-password" value={connectors.githubToken} onChange={(event) => update('githubToken', event.target.value)} placeholder="github_pat_…" /><small>Fine-grained token: Contents read/write, Actions read/write, Metadata read. Add repository creation permission if you want StackPilot to create repos.</small></label><div className="connector-card-footer"><span>Private repos recommended</span><button className="button-secondary button-small" onClick={onGithubTest} disabled={checkingGithub || !connectors.githubToken}>{checkingGithub ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />} Test GitHub</button></div></div>
        <div className="connector-form-card"><div className="connector-card-heading"><div className="connector-brand render-brand"><Cloud size={17} /></div><div><strong>Render</strong><span>Create a service and monitor its deploy</span></div><span className={`connection-state ${connectors.renderToken ? 'connected' : ''}`}><span />{connectors.renderToken ? 'KEY ADDED' : 'NOT CONNECTED'}</span></div><label className="settings-field"><span>Render API key</span><input type="password" autoComplete="new-password" value={connectors.renderToken} onChange={(event) => update('renderToken', event.target.value)} placeholder="rnd_…" /><small>Create the API key in Render account settings. StackPilot requests a Free web service after checks pass.</small></label><label className="settings-field owner-field"><span>Render workspace / owner ID</span><input value={connectors.renderOwnerId} onChange={(event) => update('renderOwnerId', event.target.value)} placeholder="tea-…" /><small>Find the owner ID in your Render workspace settings. Render must already be connected to the GitHub repo.</small></label><div className="connector-card-footer"><span>Free services can sleep when idle</span><button className="button-secondary button-small" onClick={onRenderTest} disabled={checkingRender || !connectors.renderToken}>{checkingRender ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />} Test Render</button></div></div>
        <div className="privacy-callout"><ShieldCheck size={16} /><div><strong>Designed for a single operator</strong><span>Source drafts live in this browser's IndexedDB; pushed source lives in GitHub. This app does not save API keys or write project files to Render's ephemeral disk.</span></div></div>
      </div>
      <div className="modal-footer"><button className="button-quiet danger-quiet" onClick={clearSecrets}>Clear session keys</button><div><button className="button-secondary" onClick={onClose}>Close</button><button className="button-primary" onClick={onSave}><Check size={15} /> Save connectors</button></div></div>
    </section>
  </div>;
}

function ProjectsPage({ projects, onOpen, onNew, search, onSearch }) {
  return <main className="content-area secondary-page"><section className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> LIBRARY</div><h1 className="secondary-title">Your projects</h1><p className="page-subtitle">Drafts are saved in this browser. Push to GitHub to keep a durable copy.</p></div><button className="button-primary" onClick={onNew}><Plus size={16} /> New project</button></section><div className="library-toolbar"><div className="search-large"><Search size={17} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search projects" /></div><span>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span></div><div className="project-card-grid">{projects.map((project) => <button className="project-library-card" key={project.id} onClick={() => onOpen(project.id)}><div className="library-card-top"><div className="library-project-icon"><Code2 size={19} /></div><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span></div><strong>{project.name}</strong><span className="library-project-subtitle">{project.stack || 'Draft workspace'} <span>·</span> {Object.keys(project.files || {}).length} files</span><div className="library-card-bottom"><span><Clock3Icon /> Updated {timeAgo(project.updatedAt)}</span><ArrowUpRight size={15} /></div>{project.renderUrl && <span className="library-live-url"><Globe size={12} /> {project.renderUrl.replace(/^https?:\/\//, '')}</span>}</button>)}<button className="add-project-card" onClick={onNew}><span><Plus size={20} /></span><strong>Create a project</strong><small>Start with a code dump or a blank workspace.</small></button></div></main>;
}

function DeploymentsPage({ projects, onOpen }) {
  const deployed = projects.filter((project) => project.renderUrl || project.renderServiceId || project.status === 'deploying' || project.status === 'live');
  return <main className="content-area secondary-page"><section className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> RELEASES</div><h1 className="secondary-title">Deployments</h1><p className="page-subtitle">Render service links and recent release state across your projects.</p></div><div className="render-connected-badge"><Cloud size={15} /> Render integration</div></section>{deployed.length ? <div className="deployments-table"><div className="deploy-table-head"><span>PROJECT</span><span>STATUS</span><span>RENDER URL</span><span>LAST COMMIT</span><span /></div>{deployed.map((project) => <button className="deploy-table-row" key={project.id} onClick={() => onOpen(project.id)}><span className="deploy-project-name"><span className={`project-color-dot project-${project.status}`} /><strong>{project.name}</strong><small>{project.repo || 'No repository linked'}</small></span><span><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span></span><span className="deploy-url-cell">{project.renderUrl ? <>{project.renderUrl.replace(/^https?:\/\//, '')}<ExternalLink size={13} /></> : <span className="muted-cell">Awaiting first deploy</span>}</span><span className="commit-cell">{project.lastCommit ? project.lastCommit.slice(0, 7) : '—'}</span><ArrowRight size={16} /></button>)}</div> : <div className="empty-deployments"><div className="empty-deploy-icon"><Rocket size={21} /></div><h2>No deployments yet</h2><p>Once a project passes GitHub checks and connects to Render, its build progress and live link will appear here.</p><button className="button-primary" onClick={() => projects[0] && onOpen(projects[0].id)}><Code2 size={15} /> Open build workspace</button></div>}<div className="deployment-footnote"><CircleHelp size={14} /><span>Render Free web services can spin down after idle time and use an ephemeral file system. Keep durable project source in GitHub.</span></div></main>;
}

function Clock3Icon() {
  return <Activity size={12} />;
}

function statusLabel(status) {
  return ({ draft: 'Draft', demo: 'Sample', ready: 'Ready to push', running: 'Running', pushed: 'Pushed', verified: 'Checks passed', deploying: 'Deploying', live: 'Live', needs_attention: 'Needs attention' })[status] || 'Draft';
}

function totalFileBytes(files) {
  return Object.values(files || {}).reduce((sum, content) => sum + new Blob([content]).size, 0);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(value) {
  if (!value) return 'just now';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default App;
