import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, ArrowUpRight, Bell, BookOpen,
  Braces, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp,
  Clipboard, Cloud, Code2, Copy, ExternalLink, Eye, File, FileCode2, Folder,
  Github, Globe, HardDrive, KeyRound, Loader2, LockKeyhole, Menu, Monitor,
  Plus, Radio, Rocket, Save, Search, Settings2, ShieldCheck, Smartphone, Sparkles,
  Terminal, Trash2, X, Zap,
} from 'lucide-react';
import { createProjectId, getProjects, removeProject, saveProject } from './storage.js';
import { STEPS, calculateProgress, detectEnvKeys } from './workflow.js';

const SECRET_KEYS = {
  anthropicKey: 'stackpilot.anthropic.session',
  githubToken: 'stackpilot.github.session',
  renderToken: 'stackpilot.render.session',
  appPassword: 'stackpilot.password.session',
  renderOwnerId: 'stackpilot.render.owner',
  githubTokenExpiresAt: 'stackpilot.github.expires',
};
const PROJECT_VAULT_PREFIX = 'stackpilot.project.vault.';
const PROJECT_ENV_PREFIX = 'stackpilot.project.env.';

const SAMPLE_DUMP = `Please build a clean one-page product site for Northstar. Use mobile-first HTML, CSS, and JavaScript. Include a responsive hero, one call to action, and a short features section. Keep the visual style calm, premium, and accessible.\n\nindex.html:\n<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Northstar</title><link rel="stylesheet" href="styles.css"></head><body><main><nav>Northstar</nav><h1>Make room for good work.</h1><p>A calmer way to plan.</p><a href="#features">Find your focus</a></main></body></html>\n\nstyles.css:\nbody { margin: 0; background: #f8f7f4; color: #25251f; font-family: sans-serif; }\nmain { max-width: 900px; margin: auto; padding: 48px; }\nh1 { font-family: Georgia, serif; font-size: 5rem; }\n/* TODO: add accessible mobile styles and the features section */`;

function slugify(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55);
}
function newProject(name = 'Untitled project') {
  const slug = slugify(name) || 'untitled-project';
  return {
    id: createProjectId(), name, slug, rawInput: '', files: {}, activeFile: '',
    repo: '', branch: 'main', renderServiceId: '', renderUrl: '', renderDashboardUrl: '', renderDeployId: '',
    serviceType: 'web_service', runtime: 'node', region: 'frankfurt', buildCommand: 'npm install && npm run build',
    startCommand: 'npm start', publishPath: 'dist', rootDir: '', summary: '', stack: '', status: 'draft',
    steps: Object.fromEntries(STEPS.map((step) => [step.id, 'idle'])), logs: [], createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), autoDeploy: true, jobId: '', progress: 0, activeAgent: '',
  };
}
function readSession(key) { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } }
function writeSession(key, value) { try { sessionStorage.setItem(key, value || ''); } catch { /* private mode */ } }
function readJsonSession(key, fallback) { try { return JSON.parse(sessionStorage.getItem(key) || '') || fallback; } catch { return fallback; } }
function timeLabel(value) {
  try { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
  catch { return '--:--:--'; }
}
function timeAgo(value) {
  if (!value) return 'just now';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
function delay(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
function statusLabel(status) {
  return ({ draft: 'Draft', ready: 'Ready', queued: 'Queued', running: 'Working', pushed: 'Pushed', verified: 'Checks passed', deploying: 'Deploying', live: 'Live', needs_attention: 'Needs attention', failed: 'Needs attention' })[status] || 'Draft';
}
function fileLanguage(filePath = '') {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ({ js: 'JavaScript', jsx: 'React JSX', ts: 'TypeScript', tsx: 'React TSX', html: 'HTML', css: 'CSS', json: 'JSON', md: 'Markdown', py: 'Python', yml: 'YAML', yaml: 'YAML', go: 'Go', sh: 'Shell', env: 'Environment' })[ext] || 'Text';
}
function fileIconFor(path) {
  if (path.endsWith('.json')) return Braces;
  if (/\.(jsx?|tsx?)$/.test(path)) return FileCode2;
  if (path.endsWith('.md')) return BookOpen;
  return File;
}
function parseVault(projectId) { return readJsonSession(`${PROJECT_VAULT_PREFIX}${projectId}`, {}); }
function parseProjectEnv(projectId) { return readJsonSession(`${PROJECT_ENV_PREFIX}${projectId}`, []); }
function saveProjectEnvSession(projectId, rows) {
  try { sessionStorage.setItem(`${PROJECT_ENV_PREFIX}${projectId}`, JSON.stringify(rows)); } catch { /* session-only by design */ }
}
function base64UrlToBytes(value) {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`;
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

function App() {
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [loading, setLoading] = useState(true);
  const [connectors, setConnectors] = useState(() => ({
    anthropicKey: readSession(SECRET_KEYS.anthropicKey), githubToken: readSession(SECRET_KEYS.githubToken),
    renderToken: readSession(SECRET_KEYS.renderToken), appPassword: readSession(SECRET_KEYS.appPassword),
    renderOwnerId: readSession(SECRET_KEYS.renderOwnerId),
  }));
  const [health, setHealth] = useState({ authRequired: false, envConfigured: {} });
  const [page, setPage] = useState('start');
  const [workspaceTab, setWorkspaceTab] = useState('build');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastList, setToastList] = useState([]);
  const [checkingGithub, setCheckingGithub] = useState(false);
  const [checkingRender, setCheckingRender] = useState(false);
  const [shellCommand, setShellCommand] = useState('npm run build');
  const [shellBusy, setShellBusy] = useState(false);
  const [githubIdentity, setGithubIdentity] = useState('');
  const [startInput, setStartInput] = useState('');
  const [startRepo, setStartRepo] = useState('');
  const [startName, setStartName] = useState('');
  const [startAutoDeploy, setStartAutoDeploy] = useState(true);
  const [editorDraft, setEditorDraft] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [vaultVersion, setVaultVersion] = useState(0);
  const [envVersion, setEnvVersion] = useState(0);
  const [tokenExpiry, setTokenExpiry] = useState(() => {
    try { return localStorage.getItem(SECRET_KEYS.githubTokenExpiresAt) || ''; } catch { return ''; }
  });
  const [notificationReady, setNotificationReady] = useState(false);
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const logEndRef = useRef(null);
  const saveTimers = useRef(new Map());
  const pollCursor = useRef(new Map());
  const activePolls = useRef(new Set());
  const savedVersions = useRef(new Map());
  const active = projects.find((project) => project.id === activeId) || null;
  const activeVault = useMemo(() => activeId ? parseVault(activeId) : {}, [activeId, vaultVersion]);
  const detectedEnv = useMemo(() => active ? detectEnvKeys(active.files || {}) : [], [active?.files]);
  const projectEnv = useMemo(() => {
    if (!activeId) return [];
    const saved = parseProjectEnv(activeId);
    const values = new Map(saved.map((item) => [item.key, item]));
    detectedEnv.forEach((item) => { if (!values.has(item.key)) values.set(item.key, item); });
    return [...values.values()].slice(0, 30);
  }, [activeId, envVersion, detectedEnv]);
  const activeJobs = useMemo(() => projects.filter((project) => project.jobId && ['queued', 'running', 'deploying'].includes(project.status)), [projects]);
  const activeJobSignature = activeJobs.map((project) => `${project.id}:${project.jobId}`).join('|');
  const appBusy = activeJobs.length > 0;
  const connectorCount = [connectors.anthropicKey || health.envConfigured?.anthropic, connectors.githubToken || health.envConfigured?.github, connectors.renderToken || health.envConfigured?.render].filter(Boolean).length;

  const api = useCallback(async (url, payload, method = 'POST') => {
    const headers = { 'content-type': 'application/json' };
    if (connectors.appPassword) headers['x-app-password'] = connectors.appPassword;
    const response = await fetch(url, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(payload || {}) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && health.authRequired) throw new Error('Workspace password is missing or incorrect. Open Settings to unlock it.');
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  }, [connectors.appPassword, health.authRequired]);

  const showToast = useCallback((message, tone = 'info') => {
    const id = `${Date.now()}_${Math.random()}`;
    setToastList((items) => [...items, { id, message, tone }]);
    window.setTimeout(() => setToastList((items) => items.filter((item) => item.id !== id)), 4500);
  }, []);

  const updateProject = useCallback((id, patch) => {
    setProjects((current) => current.map((project) => {
      if (project.id !== id) return project;
      const changed = typeof patch === 'function' ? patch(project) : { ...project, ...patch };
      return { ...changed, updatedAt: new Date().toISOString() };
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }, []);

  const appendLog = useCallback((id, text, level = 'info', source = 'StackPilot') => {
    updateProject(id, (project) => ({ ...project, logs: [...(project.logs || []), { time: new Date().toISOString(), level, source, text: String(text) }].slice(-180) }));
  }, [updateProject]);

  const updateProjectFiles = useCallback((id, files) => {
    const existing = parseProjectEnv(id);
    const envMap = new Map(existing.map((row) => [row.key, row]));
    detectEnvKeys(files).forEach((row) => { if (!envMap.has(row.key)) envMap.set(row.key, row); });
    saveProjectEnvSession(id, [...envMap.values()].slice(0, 30));
    setEnvVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [stored, serverHealth] = await Promise.all([
          getProjects().catch(() => []),
          fetch('/api/health').then((response) => response.json()).catch(() => ({ ok: false, envConfigured: {} })),
        ]);
        if (!mounted) return;
        const rows = (stored || []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        setProjects(rows);
        setHealth(serverHealth || { authRequired: false, envConfigured: {} });
        if (serverHealth?.renderOwnerId) setConnectors((current) => ({ ...current, renderOwnerId: current.renderOwnerId || serverHealth.renderOwnerId }));
        setTokenExpiry(serverHealth?.githubTokenExpiresAt || tokenExpiry);
        if (serverHealth?.githubTokenExpiresAt) {
          try { localStorage.setItem(SECRET_KEYS.githubTokenExpiresAt, serverHealth.githubTokenExpiresAt); } catch { /* storage disabled */ }
        }
        rows.forEach((project) => savedVersions.current.set(project.id, project.updatedAt));
        if (serverHealth?.authRequired && !readSession(SECRET_KEYS.appPassword)) setSettingsOpen(true);
      } finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!active?.activeFile) { setEditorDraft(''); setEditorDirty(false); return; }
    setEditorDraft(active.files?.[active.activeFile] || '');
    setEditorDirty(false);
  }, [active?.id, active?.activeFile, active?.files]);

  useEffect(() => {
    if (loading) return;
    projects.forEach((project) => {
      if (savedVersions.current.get(project.id) === project.updatedAt) return;
      const oldTimer = saveTimers.current.get(project.id);
      if (oldTimer) window.clearTimeout(oldTimer);
      const snapshot = project;
      const timer = window.setTimeout(() => {
        saveProject(snapshot).then(() => savedVersions.current.set(snapshot.id, snapshot.updatedAt)).catch((error) => console.warn('Project save failed', error));
        saveTimers.current.delete(snapshot.id);
      }, 250);
      saveTimers.current.set(project.id, timer);
    });
  }, [projects, loading]);

  useEffect(() => {
    try {
      writeSession(SECRET_KEYS.anthropicKey, connectors.anthropicKey);
      writeSession(SECRET_KEYS.githubToken, connectors.githubToken);
      writeSession(SECRET_KEYS.renderToken, connectors.renderToken);
      writeSession(SECRET_KEYS.appPassword, connectors.appPassword);
      writeSession(SECRET_KEYS.renderOwnerId, connectors.renderOwnerId);
    } catch { /* private mode */ }
  }, [connectors]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [active?.logs?.length]);

  useEffect(() => {
    if (!activeJobSignature) return undefined;
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (busy || stopped) return;
      busy = true;
      for (const project of activeJobs) {
        if (stopped || activePolls.current.has(project.jobId)) continue;
        activePolls.current.add(project.jobId);
        const cursor = pollCursor.current.get(project.jobId) || { after: 0, version: 0 };
        try {
          const data = await api(`/api/jobs/${encodeURIComponent(project.jobId)}?after=${cursor.after}&sinceVersion=${cursor.version}`, undefined, 'GET');
          pollCursor.current.set(project.jobId, { after: data.sequence || cursor.after, version: data.patchVersion || cursor.version });
          const patch = data.patch || {};
          if (Object.keys(patch).length && patch.files) updateProjectFiles(project.id, patch.files);
          if ((data.logs || []).length || Object.keys(patch).length || project.progress !== data.progress || project.activeAgent !== data.activeAgent || project.status !== data.status) {
            updateProject(project.id, (current) => {
              const mappedStatus = data.status === 'failed' ? 'needs_attention' : data.status;
              const status = patch.status || mappedStatus;
              const newLogs = (data.logs || []).map((entry) => ({ time: entry.time, level: entry.level, source: entry.source, text: entry.text, jobLogId: entry.id }));
              const oldIds = new Set((current.logs || []).map((entry) => entry.jobLogId).filter(Boolean));
              const freshLogs = newLogs.filter((entry) => !oldIds.has(entry.jobLogId));
              return {
                ...current, ...patch, status, steps: data.steps || current.steps, progress: data.progress,
                activeAgent: data.activeAgent || '', workflowUrl: data.workflowUrl || current.workflowUrl || '',
                logs: [...(current.logs || []), ...freshLogs].slice(-180), jobId: ['queued', 'running'].includes(data.status) ? data.id : current.jobId,
              };
            });
            if (['live', 'verified', 'failed'].includes(data.status) && !project._noticedJobCompletion) {
              updateProject(project.id, { _noticedJobCompletion: data.id });
              if (!health.notificationsConfigured && 'Notification' in window && Notification.permission === 'granted') {
                const title = data.status === 'live' ? 'StackPilot is live' : data.status === 'verified' ? 'GitHub checks passed' : 'StackPilot needs attention';
                new Notification(title, { body: project.name, icon: '/stackpilot-icon.png' });
              }
              if (data.status === 'live') showToast(`${project.name} is live on Render.`, 'success');
              else if (data.status === 'verified') showToast(`${project.name} passed GitHub checks.`, 'success');
              else showToast(`${project.name} needs attention. Open the live log for details.`, 'error');
            }
          }
        } catch (error) {
          if (error.message?.includes('not found') || error.message?.includes('404')) {
            updateProject(project.id, { status: 'needs_attention', jobId: '', activeAgent: '', progress: 0 });
            appendLog(project.id, 'The server no longer has this background job in memory. The GitHub commit and runner logs remain available; start again to resume.', 'warning', 'Background runner');
          }
        } finally { activePolls.current.delete(project.jobId); }
      }
      busy = false;
    };
    poll();
    const timer = window.setInterval(poll, 2200);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeJobSignature, api, updateProject, updateProjectFiles, appendLog, showToast, health.notificationsConfigured]);

  useEffect(() => {
    if (!tokenExpiry) return;
    const expiry = new Date(`${tokenExpiry}T23:59:59Z`);
    if (Number.isNaN(expiry.getTime())) return;
    const days = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
    if (days < 0 || days > 7) return;
    const stamp = `stackpilot.expiry.warned.${tokenExpiry}.${days}`;
    try { if (localStorage.getItem(stamp)) return; localStorage.setItem(stamp, '1'); } catch { /* session can still show warning */ }
    const message = days === 0 ? 'Your GitHub token expires today. Rotate it in Settings.' : `Your GitHub token expires in ${days} day${days === 1 ? '' : 's'}. Rotate it in Settings.`;
    showToast(message, 'warning');
    if (!health.notificationsConfigured && 'Notification' in window && Notification.permission === 'granted') new Notification('GitHub token reminder', { body: message, icon: '/stackpilot-icon.png' });
  }, [tokenExpiry, showToast, health.notificationsConfigured]);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !connectors.appPassword) return;
    let canceled = false;
    navigator.serviceWorker.register('/service-worker.js').then((registration) => registration.pushManager?.getSubscription()).then(async (subscription) => {
      if (!subscription || canceled) return;
      await api('/api/push/subscribe', { subscription: subscription.toJSON(), projectId: activeId || '' }).catch(() => {});
      if (!canceled) setNotificationReady(true);
    }).catch(() => {});
    return () => { canceled = true; };
  }, [api, connectors.appPassword, activeId]);

  const setVaultField = (projectId, field, value) => {
    if (!projectId) return;
    const next = { ...parseVault(projectId), [field]: value };
    try { sessionStorage.setItem(`${PROJECT_VAULT_PREFIX}${projectId}`, JSON.stringify(next)); } catch { /* session-only by design */ }
    setVaultVersion((current) => current + 1);
  };
  const setEnvironmentRows = (projectId, rows) => {
    if (!projectId) return;
    saveProjectEnvSession(projectId, rows.slice(0, 30));
    setEnvVersion((current) => current + 1);
  };
  const effectiveCredentials = (projectId) => {
    const vault = projectId ? parseVault(projectId) : {};
    return {
      anthropicKey: vault.anthropicKey || connectors.anthropicKey || '',
      githubToken: vault.githubToken || connectors.githubToken || '',
      renderToken: vault.renderToken || connectors.renderToken || '',
    };
  };

  const testGithub = async () => {
    setCheckingGithub(true);
    try {
      const token = connectors.githubToken || '';
      const data = await api('/api/github/me', { token });
      setGithubIdentity(data.login || 'Connected');
      showToast(`GitHub connected as ${data.login}.`, 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { setCheckingGithub(false); }
  };
  const testRender = async () => {
    setCheckingRender(true);
    try {
      await api('/api/render/test', { token: connectors.renderToken || '' });
      showToast('Render API connection is healthy.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { setCheckingRender(false); }
  };

  const saveGithubTokenToServer = async (githubToken, expiry) => {
    const value = String(githubToken || '').trim();
    if (!value) throw new Error('Enter a fresh GitHub token first.');
    const result = await api('/api/settings/github-token', { githubToken: value, expiresAt: expiry || '', renderToken: connectors.renderToken || '' });
    setGithubIdentity(result.login || 'Connected');
    setTokenExpiry(expiry || '');
    try { localStorage.setItem(SECRET_KEYS.githubTokenExpiresAt, expiry || ''); } catch { /* storage disabled */ }
    setHealth((current) => ({ ...current, envConfigured: { ...(current.envConfigured || {}), github: true }, githubTokenExpiresAt: expiry || '', serviceId: current.serviceId || '' }));
    showToast('Fresh GitHub token saved as a Render secret. StackPilot is restarting to activate it.', 'success');
    return result;
  };

  const disableNotifications = async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration('/');
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        await api('/api/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
        await subscription.unsubscribe().catch(() => {});
      }
      setNotificationReady(false);
      showToast('Notifications are disabled for this device.');
    } catch (error) { showToast(error.message || 'Could not disable notifications.', 'error'); }
  };

  const enableNotifications = async () => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      showToast('This browser does not support web notifications. Use a supported iOS version and add StackPilot to Home Screen.', 'error');
      return;
    }
    try {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') throw new Error('Notification permission is off. Allow it in your browser settings and try again.');
      const registration = await navigator.serviceWorker.register('/service-worker.js');
      const config = await api('/api/push/public-key', {}, 'GET');
      if (!config.enabled || !config.publicKey) {
        setNotificationReady(true);
        showToast('On-device notifications are enabled while StackPilot is open. Server push still needs VAPID keys.', 'warning');
        return;
      }
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(config.publicKey) });
      await api('/api/push/subscribe', { subscription: subscription.toJSON(), projectId: activeId || '' });
      setNotificationReady(true);
      showToast('Push notifications enabled for this device.', 'success');
      registration.showNotification('StackPilot notifications are on', { body: 'You will be notified when a background run finishes.', icon: '/stackpilot-icon.png' });
    } catch (error) { showToast(error.message || 'Could not enable notifications.', 'error'); }
  };

  const newProjectFromHome = () => {
    if (!startInput.trim()) { showToast('Paste your code or project instructions first.', 'error'); return; }
    const name = startName.trim() || (startRepo.split('/').filter(Boolean).at(-1) || 'New project').replace(/[-_]/g, ' ');
    const project = newProject(name);
    project.rawInput = startInput;
    project.repo = startRepo.trim();
    project.autoDeploy = startAutoDeploy;
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
    setWorkspaceTab('build');
    setPage('workspace');
    saveProject(project).then(() => savedVersions.current.set(project.id, project.updatedAt)).catch(() => {});
    showToast('Project workspace created. Starting the real pipeline…', 'success');
    if (project.repo) window.setTimeout(() => runFullPipeline(project), 50);
  };

  const createNewProject = () => {
    setStartInput(''); setStartRepo(''); setStartName(''); setStartAutoDeploy(true);
    setActiveId(''); setPage('start');
  };

  const openProject = (id) => { setActiveId(id); setPage('workspace'); setWorkspaceTab('build'); };

  const deleteProject = async (id) => {
    const project = projects.find((row) => row.id === id);
    if (!project) return;
    if (!window.confirm(`Remove “${project.name}” from this device? Its GitHub repository and Render service will not be deleted.`)) return;
    const timer = saveTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    saveTimers.current.delete(id);
    await removeProject(id).catch(() => {});
    try { sessionStorage.removeItem(`${PROJECT_VAULT_PREFIX}${id}`); sessionStorage.removeItem(`${PROJECT_ENV_PREFIX}${id}`); } catch { /* ignore */ }
    const next = projects.filter((row) => row.id !== id);
    setProjects(next);
    if (activeId === id) { setActiveId(''); setPage('start'); }
    showToast('Project removed from this browser. GitHub and Render were not changed.');
  };

  const runFullPipeline = async (projectOverride = null) => {
    const project = projectOverride || active;
    if (!project || appBusy) return;
    const credentials = effectiveCredentials(project.id);
    if (!credentials.githubToken && !health.envConfigured?.github) { setSettingsOpen(true); showToast('Add a GitHub token in Settings or save one in the server environment.', 'error'); return; }
    const needsClaude = Boolean(project.rawInput?.trim());
    if (needsClaude && !credentials.anthropicKey && !health.envConfigured?.anthropic) { setSettingsOpen(true); showToast('Add an Anthropic key to organize a new code dump.', 'error'); return; }
    const runProject = { ...project };
    if (project.status === 'verified' && Object.keys(project.files || {}).length) runProject.rawInput = '';
    const envVars = (project.id === activeId ? projectEnv : parseProjectEnv(project.id)).filter((row) => row.key && row.value !== undefined).map(({ key, value }) => ({ key, value: String(value) }));
    updateProject(project.id, { status: 'running', progress: 1, activeAgent: 'StackPilot orchestrator', jobId: '', steps: Object.fromEntries(STEPS.map((step) => [step.id, 'idle'])) });
    appendLog(project.id, 'Background run requested. StackPilot keeps working server-side if you leave the page.', 'info', 'Orchestrator');
    try {
      const started = await api('/api/jobs', {
        project: runProject,
        credentials,
        renderOwnerId: connectors.renderOwnerId,
        envVars,
        model: 'claude-sonnet-5-5',
      });
      updateProject(project.id, { jobId: started.jobId, status: 'running', progress: 1, activeAgent: 'StackPilot orchestrator' });
      pollCursor.current.set(started.jobId, { after: 0, version: 0 });
      showToast('StackPilot agents are working in the background.', 'success');
    } catch (error) {
      updateProject(project.id, { status: 'needs_attention', progress: 0, jobId: '' });
      appendLog(project.id, error.message || 'Could not start the background run.', 'error', 'StackPilot');
      showToast(error.message || 'Could not start the background run.', 'error');
    }
  };

  const runOrDeploy = (forceDeploy = false) => {
    if (!active) return;
    const project = { ...active, autoDeploy: forceDeploy || active.autoDeploy !== false };
    if (project.status === 'verified' && Object.keys(project.files || {}).length) project.rawInput = '';
    runFullPipeline(project);
  };

  const toggleAutoDeploy = (enabled) => {
    if (!active) return;
    updateProject(active.id, { autoDeploy: Boolean(enabled) });
    showToast(enabled ? 'Render will start automatically after GitHub checks pass.' : 'Auto-deploy is off. You can still deploy after verification.');
  };

  const runShellCommand = async () => {
    if (!active || appBusy || shellBusy) return;
    if (!active.repo) { showToast('Add the repository in Release settings first.', 'error'); return; }
    const credentials = effectiveCredentials(active.id);
    if (!credentials.githubToken && !health.envConfigured?.github) { setSettingsOpen(true); showToast('Connect GitHub before running a temporary command.', 'error'); return; }
    if (!shellCommand.trim()) { showToast('Enter a command for the temporary runner.', 'error'); return; }
    setShellBusy(true);
    const captureAt = Date.now();
    appendLog(active.id, `Queueing temporary GitHub runner command: ${shellCommand}`, 'info', 'Remote shell');
    try {
      await api('/api/github/dispatch', { token: credentials.githubToken, repository: active.repo, branch: active.branch || 'main', command: shellCommand });
      appendLog(active.id, 'Command accepted by a temporary GitHub Actions runner. The command continues if you close this page.', 'info', 'Remote shell');
      let waited = 0; let last = '';
      while (waited < 7 * 60_000) {
        const info = await api('/api/github/runs', { token: credentials.githubToken, repository: active.repo, branch: active.branch || 'main', since: new Date(captureAt).toISOString() });
        if (info.found) {
          const label = `${info.status}${info.conclusion ? ` · ${info.conclusion}` : ''}`;
          if (label !== last) { appendLog(active.id, `Temporary runner ${label}${info.url ? ` · ${info.url}` : ''}`, info.conclusion === 'failure' ? 'error' : 'info', 'Remote shell'); last = label; }
          if (info.status === 'completed') {
            (info.logs || '').split('\n').slice(-55).forEach((line) => { if (line.trim()) appendLog(active.id, line, /error|failed|fatal/i.test(line) ? 'error' : 'info', 'Runner log'); });
            if (info.conclusion === 'success') showToast('Temporary shell command finished successfully.', 'success');
            else showToast(`Temporary runner finished: ${info.conclusion || 'check logs'}.`, 'error');
            return;
          }
        } else if (waited >= 45_000) throw new Error('No GitHub Actions run appeared. Check that Actions are enabled and this token can read runs.');
        await delay(5000); waited += 5000;
      }
      showToast('The runner is still working. Open GitHub Actions to see the continuing job.', 'warning');
    } catch (error) { appendLog(active.id, error.message || 'Remote command failed.', 'error', 'Remote shell'); showToast(error.message || 'Remote command failed.', 'error'); }
    finally { setShellBusy(false); }
  };

  const saveEditor = () => {
    if (!active?.activeFile) return;
    const files = { ...active.files, [active.activeFile]: editorDraft };
    updateProject(active.id, { files, isDemo: false });
    updateProjectFiles(active.id, files);
    setEditorDirty(false);
    showToast('File saved in this project.');
  };
  const selectFile = (filePath) => {
    if (editorDirty && !window.confirm('Discard unsaved edits to the current file?')) return;
    updateProject(active.id, { activeFile: filePath });
  };
  const addFile = () => {
    if (!active) return;
    const path = window.prompt('New file path (example: src/app.js)');
    if (!path) return;
    const cleaned = path.trim().replaceAll('\\', '/');
    if (!cleaned || cleaned.startsWith('/') || cleaned.split('/').some((part) => part === '..')) { showToast('Use a safe relative file path.', 'error'); return; }
    const files = { ...active.files, [cleaned]: '' };
    updateProject(active.id, { files, activeFile: cleaned });
    setEditorDraft(''); setEditorDirty(false);
  };

  const updateRepo = (repo) => active && updateProject(active.id, { repo });
  const updateProjectName = (name) => active && updateProject(active.id, { name, slug: slugify(name) || active.slug });
  const updateEnvironment = (index, field, value) => {
    const rows = [...projectEnv];
    rows[index] = { ...rows[index], [field]: value };
    setEnvironmentRows(active.id, rows);
  };
  const addEnvironment = () => setEnvironmentRows(active.id, [...projectEnv, { key: '', value: '' }]);
  const removeEnvironment = (index) => setEnvironmentRows(active.id, projectEnv.filter((_, row) => row !== index));

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    return projects.filter((project) => !query || project.name.toLowerCase().includes(query) || project.slug.toLowerCase().includes(query) || (project.repo || '').toLowerCase().includes(query));
  }, [projects, search]);
  const liveCount = projects.filter((project) => project.status === 'live').length;
  const tokenDaysLeft = tokenExpiry ? Math.ceil((new Date(`${tokenExpiry}T23:59:59Z`).getTime() - Date.now()) / 86_400_000) : null;

  if (loading) return <div className="app-loading"><img src="/stackpilot-icon.png" alt="" /><span>Preparing your workspace…</span></div>;

  return (
    <div className="site-shell">
      {page === 'start' && <StartPage
        input={startInput} setInput={setStartInput} repo={startRepo} setRepo={setStartRepo} name={startName} setName={setStartName}
        autoDeploy={startAutoDeploy} setAutoDeploy={setStartAutoDeploy} onStart={newProjectFromHome}
        projects={filteredProjects} onOpen={openProject} onNew={createNewProject} onDelete={deleteProject}
        search={search} setSearch={setSearch} onSettings={() => setSettingsOpen(true)} onAbout={() => setPage('about')}
        health={health} connectorCount={connectorCount} notificationsReady={notificationReady} onEnableNotifications={enableNotifications}
        onSample={() => { setStartInput(SAMPLE_DUMP); if (!startName) setStartName('Northstar landing page'); }}
        onInstallHelp={() => setInstallHelpOpen(true)} onCopyMonitor={() => navigator.clipboard?.writeText(`${window.location.origin}/health`).then(() => showToast('UptimeRobot URL copied.', 'success')).catch(() => showToast('Clipboard is unavailable in this browser.', 'error'))}
      />}
      {page === 'workspace' && active && <ProjectWorkspace
        project={active} credentials={effectiveCredentials(active.id)} envConfigured={health.envConfigured || {}}
        projectVault={activeVault} onVaultChange={(key, value) => setVaultField(active.id, key, value)}
        envRows={projectEnv} onEnvChange={updateEnvironment} onAddEnv={addEnvironment} onRemoveEnv={removeEnvironment}
        tab={workspaceTab} setTab={setWorkspaceTab} onHome={() => setPage('start')} onSettings={() => setSettingsOpen(true)}
        onNameChange={updateProjectName} onRepoChange={updateRepo} onProjectChange={(patch) => updateProject(active.id, patch)} onRun={runOrDeploy} onToggleAutoDeploy={toggleAutoDeploy}
        busy={appBusy} onDelete={() => deleteProject(active.id)} onEditorChange={(value) => { setEditorDraft(value); setEditorDirty(true); }}
        editorDraft={editorDraft} editorDirty={editorDirty} onSaveEditor={saveEditor} onSelectFile={selectFile} onAddFile={addFile}
        onAbout={() => setPage('about')} onShowToast={showToast} onRefreshEnv={() => updateProjectFiles(active.id, active.files || {})}
        shellCommand={shellCommand} setShellCommand={setShellCommand} shellBusy={shellBusy} onRunShell={runShellCommand}
      />}
      {page === 'about' && <AboutPage projects={projects} onBack={() => setPage(activeId ? 'workspace' : 'start')} expiry={tokenExpiry} daysLeft={tokenDaysLeft} health={health} onSettings={() => setSettingsOpen(true)} onOpen={openProject} />}
      {page === 'deployments' && <DeploymentsPage projects={projects} onBack={() => setPage('start')} onOpen={openProject} />}

      {settingsOpen && <SettingsModal
        connectors={connectors} setConnectors={setConnectors} health={health} tokenExpiry={tokenExpiry} setTokenExpiry={setTokenExpiry}
        githubIdentity={githubIdentity} checkingGithub={checkingGithub} checkingRender={checkingRender}
        onGithubTest={testGithub} onRenderTest={testRender} onSaveGithubToServer={saveGithubTokenToServer}
        onSave={() => { setSettingsOpen(false); showToast('Settings saved for this browser session.', 'success'); }}
        onEnableNotifications={enableNotifications} onDisableNotifications={disableNotifications} notificationReady={notificationReady} onClose={() => setSettingsOpen(false)}
      />}
      {installHelpOpen && <InstallHelp onClose={() => setInstallHelpOpen(false)} />}
      <div className="toast-stack" aria-live="polite">{toastList.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}><span className="toast-icon">{toast.tone === 'error' ? <AlertTriangle size={17} /> : toast.tone === 'success' ? <CheckCircle2 size={17} /> : <Activity size={17} />}</span><span>{toast.message}</span><button onClick={() => setToastList((list) => list.filter((item) => item.id !== toast.id))} aria-label="Dismiss"><X size={14} /></button></div>)}</div>
    </div>
  );
}

function StartPage({ input, setInput, repo, setRepo, name, setName, autoDeploy, setAutoDeploy, onStart, projects, onOpen, onNew, onDelete, search, setSearch, onSettings, onAbout, health, connectorCount, notificationsReady, onEnableNotifications, onSample, onInstallHelp, onCopyMonitor }) {
  const running = projects.filter((project) => ['queued', 'running', 'deploying'].includes(project.status));
  return <div className="start-page">
    <header className="start-header">
      <button className="brand-lockup" onClick={onNew}><img className="brand-app-icon" src="/stackpilot-icon.png" alt="" /><span><strong>stackpilot</strong><small>AI BUILD STUDIO</small></span></button>
      <div className="start-header-actions">
        <span className={`server-pill ${health.ok ? 'server-online' : ''}`}><i />{health.ok ? 'Monitor endpoint ready' : 'Checking workspace'}</span>
        <button className="header-link" onClick={onEnableNotifications}><Bell size={15} /><span>{notificationsReady ? 'Notifications on' : 'Notifications'}</span></button>
        <button className="header-link" onClick={onAbout}><Activity size={15} /><span>My work</span></button>
        <button className="header-settings" onClick={onSettings} aria-label="Settings"><Settings2 size={17} /><span>{connectorCount}/3</span></button>
      </div>
    </header>

    <main className="start-main">
      <section className="start-hero">
        <div className="hero-copy">
          <div className="hero-kicker"><span className="kicker-sparkle">✦</span> A calm place to ship</div>
          <h1>From one big paste<br />to <em>something live.</em></h1>
          <p>Give StackPilot your code or idea. Five specialist steps organize it, check it, test it, and—only when checks pass—send it to Render.</p>
          <div className="hero-trust-row"><span><ShieldCheck size={14} /> Tests before deploy</span><span><Radio size={14} /> Live activity</span><span><Smartphone size={14} /> Built for iPhone</span></div>
        </div>
        <div className="hero-art" aria-hidden="true"><div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><div className="hero-glow" /><img src="/stackpilot-icon.png" alt="" /><span className="hero-art-chip chip-left"><Check size={12} /> tests first</span><span className="hero-art-chip chip-right"><Rocket size={12} /> ready to ship</span></div>
      </section>

      <section className="launch-card" aria-labelledby="launch-title">
        <div className="launch-header"><div className="launch-number">01</div><div><h2 id="launch-title">Start with your code</h2><p>Paste a dump, a brief, or files plus instructions. You can edit everything after.</p></div><button className="sample-link" onClick={onSample}><Sparkles size={14} /> Try sample</button></div>
        <label className="start-field"><span>Project name <small>Optional</small></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="A name for this build" /></label>
        <label className="start-field start-dump-field"><span>Code or instructions</span><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={'Paste the whole code response here — even if it is one long block.\n\nStackPilot will organize it into files, complete obvious gaps, and build a live project workspace.'} /></label>
        <label className="start-field"><span>GitHub repository <small>owner/repo</small></span><div className="start-repo-input"><Github size={16} /><input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="your-name/project-name" autoCapitalize="none" autoCorrect="off" spellCheck="false" /></div></label>
        <div className="launch-options"><label className="auto-deploy-toggle"><input type="checkbox" checked={autoDeploy} onChange={(event) => setAutoDeploy(event.target.checked)} /><span className="toggle-ui" /><span><strong>Auto-deploy after checks pass</strong><small>Turn off to review the tested GitHub build before publishing.</small></span></label><span className="plan-chip"><Cloud size={13} /> Render Free</span></div>
        <div className="launch-actions"><button className="launch-button" onClick={onStart} disabled={!input.trim()}><Sparkles size={17} /> Create project workspace <ArrowRight size={16} /></button><span className="secure-note"><LockKeyhole size={12} /> Keys stay out of your source files</span></div>
        <div className="launch-connection-note"><span className={`connection-dot ${health.envConfigured?.github || connectorCount ? 'is-ready' : ''}`} />{health.envConfigured?.github || connectorCount ? 'Connections are ready. Review project-specific keys inside the workspace.' : 'Connect GitHub, Anthropic, and Render in Settings to run a real build.'}<button onClick={onSettings}>Settings <ArrowUpRight size={12} /></button></div>
      </section>

      {running.length > 0 && <section className="running-strip"><div className="running-strip-icon"><Loader2 size={16} className="spin" /></div><div><strong>{running.length} project{running.length === 1 ? '' : 's'} still working</strong><span>Runs continue on StackPilot while this page is closed.</span></div><button onClick={() => onOpen(running[0].id)}>View live progress <ArrowRight size={14} /></button></section>}

      <section className="recent-section">
        <div className="recent-heading"><div><span className="section-eyebrow">YOUR WORK</span><h2>Recent projects</h2></div><div className="recent-controls"><label className="recent-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a project" /></label><button className="new-project-button" onClick={onNew}><Plus size={15} /> New</button></div></div>
        {projects.length ? <div className="recent-grid">{projects.slice(0, 6).map((project) => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project.id)} onDelete={() => onDelete(project.id)} />)}</div> : <div className="recent-empty"><div className="empty-mark"><Folder size={19} /></div><div><strong>Your project shelf is ready.</strong><span>Build your first project above. Drafts are saved on this device; GitHub is the durable source.</span></div></div>}
      </section>

      <footer className="start-footer"><span><img src="/stackpilot-icon.png" alt="" /> StackPilot <i /> Five visible steps. One clear live result.</span><div><a href="/health" target="_blank" rel="noreferrer"><Radio size={12} /> uptime check</a><button onClick={onInstallHelp}><Smartphone size={12} /> add to iPhone</button><button onClick={onCopyMonitor}>copy monitor URL</button></div></footer>
    </main>
  </div>;
}

function ProjectCard({ project, onOpen, onDelete }) {
  return <article className="recent-card">
    <button className="recent-card-open" onClick={onOpen}>
      <div className="recent-card-top"><span className="recent-card-icon"><Code2 size={17} /></span><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span></div>
      <strong>{project.name}</strong><span className="recent-card-repo">{project.repo || project.stack || 'Workspace draft'}</span>
      {['running', 'queued', 'deploying'].includes(project.status) && <div className="mini-progress"><span style={{ width: `${calculateProgress(project.steps, project.status, project.progress)}%` }} /></div>}
      <div className="recent-card-bottom"><span><Activity size={12} /> Updated {timeAgo(project.updatedAt)}</span><ArrowUpRight size={14} /></div>
    </button>
    <button className="recent-card-delete" onClick={onDelete} aria-label={`Remove ${project.name}`} title="Remove from this device"><Trash2 size={13} /></button>
  </article>;
}

function ProjectWorkspace({ project, credentials, envConfigured, projectVault, onVaultChange, envRows, onEnvChange, onAddEnv, onRemoveEnv, tab, setTab, onHome, onSettings, onNameChange, onRepoChange, onProjectChange, onRun, onToggleAutoDeploy, busy, onDelete, onEditorChange, editorDraft, editorDirty, onSaveEditor, onSelectFile, onAddFile, onAbout, onShowToast, onRefreshEnv, shellCommand, setShellCommand, shellBusy, onRunShell }) {
  const progress = calculateProgress(project.steps, project.status, project.progress);
  const isWorking = ['queued', 'running', 'deploying'].includes(project.status);
  const canDeploy = Boolean(project.renderUrl || project.renderServiceId || credentials.renderToken || envConfigured.render);
  const activeSteps = Object.values(project.steps || {}).filter((step) => step === 'done').length;
  const latest = project.logs?.at(-1);
  const [configOpen, setConfigOpen] = useState(false);
  const [showEnvValues, setShowEnvValues] = useState(false);
  const tabs = [{ id: 'build', label: 'Build', icon: Sparkles }, { id: 'files', label: 'Files', icon: Folder }, { id: 'preview', label: 'Live & keys', icon: Eye }];
  const deployButtonText = isWorking ? 'Working…' : project.status === 'verified' && !project.autoDeploy ? 'Deploy verified build' : project.status === 'live' ? 'Build & deploy again' : 'Run tests & release';
  const runClick = () => onRun(project.status === 'verified' && !project.autoDeploy);

  return <div className="workspace-page">
    <header className="workspace-header">
      <button className="workspace-brand" onClick={onHome}><img src="/stackpilot-icon.png" alt="" /><span>stackpilot</span></button>
      <div className="workspace-breadcrumb"><button onClick={onHome}>Projects</button><ChevronRight size={13} /><span>{project.name}</span></div>
      <div className="workspace-header-actions"><button className="header-link" onClick={onAbout}><Activity size={15} /><span>My work</span></button><button className="header-settings" onClick={onSettings} aria-label="Settings"><Settings2 size={17} /></button></div>
    </header>

    <main className="workspace-main">
      <section className="project-heading">
        <div className="project-heading-copy"><div className="project-heading-kicker"><span className="online-ring" /> PROJECT WORKSPACE <span className="heading-slash">/</span> {project.slug}</div><div className="project-title-line"><input aria-label="Project name" value={project.name} onChange={(event) => onNameChange(event.target.value)} /><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span></div><p>{project.summary || 'The project architect, safety guard, build runner, and Render operator are ready when you are.'}</p></div>
        <div className="project-heading-actions"><button className="soft-button" onClick={onHome}><ArrowLeft size={15} /><span>All projects</span></button><button className="icon-only workspace-delete" onClick={onDelete} aria-label="Delete project" title="Delete this project"><Trash2 size={15} /></button><button className="primary-button" onClick={runClick} disabled={busy || (!project.files || !Object.keys(project.files).length) && !project.rawInput?.trim()}>{busy ? <Loader2 size={16} className="spin" /> : <Rocket size={16} />}<span>{deployButtonText}</span></button></div>
      </section>

      <nav className="workspace-tabs" aria-label="Project workspace tabs">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={15} /><span>{label}</span>{id === 'files' && <em>{Object.keys(project.files || {}).length}</em>}{id === 'preview' && project.renderUrl && <i />}</button>)}<div className="workspace-tabs-spacer" /><button className="tab-settings" onClick={() => setConfigOpen((value) => !value)}><Settings2 size={15} /><span>Release settings</span></button></nav>

      {isWorking && <ProgressPanel project={project} progress={progress} />}

      {tab === 'build' && <div className="build-layout">
        <section className="build-primary-column">
          <div className="workspace-card code-input-card">
            <div className="card-header"><div className="card-title-icon violet"><Sparkles size={16} /></div><div><strong>Code & direction</strong><span>Paste, revise, or add a specific request for the agents.</span></div><span className="character-count">{(project.rawInput || '').length.toLocaleString()} chars</span></div>
            <textarea className="workspace-dump" value={project.rawInput || ''} onChange={(event) => onProjectChange({ rawInput: event.target.value })} placeholder="Paste your code dump or describe the project…" aria-label="Project code and instructions" />
            <div className="dump-footer"><span><LockKeyhole size={12} /> Credentials are never added to the commit</span><button className="small-action" onClick={() => onShowToast('Paste updates from your starter brief; the file editor stays in the Files tab.', 'info')}>How it works <CircleHelp size={13} /></button></div>
          </div>

          {configOpen && <ReleaseSettings project={project} onRepoChange={onRepoChange} onToggleAutoDeploy={onToggleAutoDeploy} onProjectChange={onProjectChange} onSettings={onSettings} />}

          {!isWorking && <ProgressPanel project={project} progress={progress} compact />}

          <ActivityPanel project={project} logEndRef={null} onClear={() => onProjectChange({ logs: [] })} />
          <ShellRunner command={shellCommand} setCommand={setShellCommand} onRun={onRunShell} busy={shellBusy || busy} repo={project.repo} />
        </section>
        <aside className="build-side-column">
          <ReleaseSummary project={project} canDeploy={canDeploy} autoDeploy={project.autoDeploy !== false} onToggleAutoDeploy={onToggleAutoDeploy} onRun={runClick} busy={busy} onSettings={onSettings} />
          <AgentRoster project={project} />
          {project.renderUrl && <a className="deployed-link-card" href={project.renderUrl} target="_blank" rel="noreferrer"><span className="deployed-link-icon"><Globe size={15} /></span><span><small>LIVE URL</small><strong>{project.renderUrl.replace(/^https?:\/\//, '')}</strong></span><ArrowUpRight size={15} /></a>}
        </aside>
      </div>}

      {tab === 'files' && <div className="files-layout">
        <section className="workspace-card files-card"><div className="card-header"><div className="card-title-icon blue"><Folder size={16} /></div><div><strong>Project files</strong><span>Tap a file to edit it. Changes stay in this project until the next run.</span></div><button className="small-action add-file-action" onClick={onAddFile}><Plus size={14} /> New file</button></div><div className="file-explorer-root"><ChevronDown size={13} /><Folder size={14} />{project.slug || 'project'}</div><FileTree files={project.files || {}} current={project.activeFile} onSelect={onSelectFile} />{!Object.keys(project.files || {}).length && <div className="empty-files"><FileCode2 size={22} /><strong>Your organized files will appear here</strong><span>Paste a dump and run the Project Architect.</span></div>}</section>
        <section className="workspace-card editor-card"><div className="editor-card-header"><div className="file-name-label"><FileCode2 size={15} /><span>{project.activeFile || 'Choose a file'}</span><em>{project.activeFile ? fileLanguage(project.activeFile) : '—'}</em></div><div className="editor-card-actions">{editorDirty && <span className="unsaved-chip">Unsaved</span>}<button className="small-action" disabled={!editorDraft} onClick={() => navigator.clipboard?.writeText(editorDraft).then(() => onShowToast('File copied.')).catch(() => onShowToast('Copy is unavailable in this browser.', 'error'))}><Copy size={13} /> Copy</button><button className="save-editor-button" disabled={!editorDirty} onClick={onSaveEditor}><Save size={13} /> Save</button></div></div>{project.activeFile ? <div className="code-editor-wrap"><div className="line-gutter">{Array.from({ length: Math.max(1, editorDraft.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea spellCheck="false" className="code-editor" value={editorDraft} onChange={(event) => onEditorChange(event.target.value)} aria-label={`Edit ${project.activeFile}`} /></div> : <div className="editor-empty"><div><Code2 size={24} /></div><strong>Select a file</strong><span>Your editor is ready for quick changes on desktop or iPhone.</span></div>}<div className="editor-bottom"><span>UTF-8 <i /> {project.activeFile ? `${editorDraft.split('\n').length} lines` : 'No file selected'}</span><span>Mobile-friendly plain editor</span></div></section>
      </div>}

      {tab === 'preview' && <div className="preview-layout">
        <section className="workspace-card live-preview-card"><div className="card-header"><div className="card-title-icon green"><Eye size={16} /></div><div><strong>Live browser preview</strong><span>{project.renderUrl ? 'The deployed Render site, embedded here.' : 'A real preview appears as soon as Render finishes a successful deploy.'}</span></div>{project.renderUrl && <a className="small-action" href={project.renderUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open tab</a>}</div>{project.renderUrl ? <div className="embedded-browser"><div className="browser-chrome"><span /><span /><span /><div className="browser-address"><LockKeyhole size={10} />{project.renderUrl.replace(/^https?:\/\//, '')}</div><button onClick={() => window.open(project.renderUrl, '_blank', 'noopener,noreferrer')} aria-label="Open preview in a new tab"><ArrowUpRight size={13} /></button></div><iframe title={`Live preview of ${project.name}`} src={project.renderUrl} loading="lazy" referrerPolicy="no-referrer" /></div> : <div className="preview-empty"><div className="preview-orb"><Globe size={22} /></div><strong>{project.status === 'verified' ? 'Checks passed. Ready for Render.' : 'Your live preview will appear here.'}</strong><span>{project.status === 'verified' ? 'Turn on auto-deploy or use “Deploy verified build”.' : 'The Render operator only starts after GitHub tests and build succeed.'}</span>{project.status === 'verified' && <button className="primary-button" onClick={runClick} disabled={busy}><Rocket size={15} /> Deploy verified build</button>}</div>}</section>
        <ProjectCredentialsCard vault={projectVault} onChange={onVaultChange} />
        <EnvironmentCard rows={envRows} onChange={onEnvChange} onAdd={onAddEnv} onRemove={onRemoveEnv} onRefresh={onRefreshEnv} serviceId={project.renderServiceId} envConfigured={envConfigured} credentials={credentials} />
        <div className="preview-bottom-grid"><ReleaseSettings project={project} onRepoChange={onRepoChange} onToggleAutoDeploy={onToggleAutoDeploy} onProjectChange={onProjectChange} onSettings={onSettings} /><RenderStatusCard project={project} onSettings={onSettings} /></div>
      </div>}
    </main>
  </div>;
}

function ProgressPanel({ project, progress, compact = false }) {
  const steps = project.steps || {};
  const runningIndex = STEPS.findIndex((step) => steps[step.id] === 'running');
  const current = STEPS[Math.max(0, runningIndex)];
  const finished = ['live', 'verified'].includes(project.status);
  const hasStarted = project.status !== 'draft' && project.status !== 'ready';
  return <section className={`progress-card ${compact ? 'progress-compact' : ''} ${hasStarted ? 'progress-active' : ''}`} aria-live="polite">
    <div className="progress-top"><div className="progress-heading"><div className={`progress-emblem ${hasStarted && !finished ? 'emblem-working' : ''}`}><Sparkles size={17} /></div><div><div className="progress-eyebrow">{finished ? 'RUN COMPLETE' : hasStarted ? 'SPECIALISTS AT WORK' : 'READY WHEN YOU ARE'}</div><strong>{finished ? (project.status === 'live' ? 'Your project is live.' : 'GitHub checks passed.') : hasStarted ? (project.activeAgent || current.role) : 'Five clear steps. No black box.'}</strong><span>{finished ? 'Source is in GitHub, with a result you can revisit anytime.' : hasStarted ? 'This run continues on the server if you leave the page.' : 'Each agent owns one visible part of the build.'}</span></div></div><div className="progress-value"><strong>{hasStarted ? progress : 0}<small>%</small></strong><span>{finished ? 'complete' : 'progress'}</span></div></div>
    <div className="progress-track" role="progressbar" aria-valuenow={hasStarted ? progress : 0} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${hasStarted ? progress : 0}%` }} /><i /></div>
    <div className="agent-track">{STEPS.map((step, index) => {
      const state = steps[step.id] || 'idle';
      const Icon = [Sparkles, ShieldCheck, Github, Terminal, Rocket][index];
      return <div className={`agent-track-item agent-${state}`} key={step.id}><div className="agent-track-icon">{state === 'running' ? <Loader2 size={14} className="spin" /> : state === 'done' ? <Check size={14} /> : state === 'error' ? <AlertTriangle size={14} /> : <Icon size={14} />}</div><div><small>AGENT {String(index + 1).padStart(2, '0')}</small><strong>{step.label}</strong><span>{step.role}</span></div></div>;
    })}</div>
    <div className="progress-foot"><span className="progress-live-indicator"><i />{hasStarted && !finished ? 'LIVE UPDATE' : finished ? 'CHECKPOINT SAVED' : 'GITHUB → TESTS → RENDER'}</span><span className="progress-latest">{project.logs?.length ? `${project.logs.at(-1).source || 'StackPilot'} · ${project.logs.at(-1).text}` : 'Render will wait for a passing GitHub build.'}</span></div>
  </section>;
}

function AgentRoster({ project }) {
  return <section className="agent-roster"><div className="roster-header"><span className="section-eyebrow">THE BUILD CREW</span><span>{Object.values(project.steps || {}).filter((state) => state === 'done').length}/{STEPS.length} done</span></div>{STEPS.map((step, index) => {
    const Icon = [Sparkles, ShieldCheck, Github, Terminal, Rocket][index];
    const state = project.steps?.[step.id] || 'idle';
    return <div className={`roster-agent roster-${state}`} key={step.id}><span className="roster-icon">{state === 'running' ? <Loader2 size={14} className="spin" /> : state === 'done' ? <Check size={14} /> : <Icon size={14} />}</span><span><strong>{step.role}</strong><small>{step.detail}</small></span><i>{state === 'done' ? 'DONE' : state === 'running' ? 'ACTIVE' : state === 'error' ? 'FIX' : 'READY'}</i></div>;
  })}</section>;
}

function ShellRunner({ command, setCommand, onRun, busy, repo }) {
  const [open, setOpen] = useState(false);
  return <details className="shell-runner-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className="shell-runner-icon"><Terminal size={15} /></span><span><strong>Temporary shell runner</strong><small>Run a trusted command on a GitHub-hosted VM, not on Render.</small></span><ChevronDown size={14} /></summary>{open && <div className="shell-runner-body"><div className="shell-command-row"><span>$</span><input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onRun(); }} placeholder="npm run build" aria-label="Temporary runner command" /><button className="primary-button" onClick={onRun} disabled={busy || !repo}>{busy ? <Loader2 size={14} className="spin" /> : <Rocket size={14} />} Run</button></div><p><ShieldCheck size={12} /> The runner checks out this repo and can access the network. It does not receive StackPilot API keys. Never paste production tokens into commands.</p></div>}</details>;
}

function ActivityPanel({ project, onClear }) {
  const [expanded, setExpanded] = useState(true);
  const logs = (project.logs || []).slice(-100);
  return <section className="activity-card"><div className="activity-header"><div><div className="activity-live-dot" /><strong>Live activity</strong><span>{['queued', 'running', 'deploying'].includes(project.status) ? 'STREAMING' : 'RUN HISTORY'}</span></div><div className="activity-actions"><button className="small-action" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Collapse' : 'Expand'}</button><button className="icon-only" onClick={onClear} title="Clear local activity"><Trash2 size={14} /></button></div></div>{expanded && <div className="activity-log">{logs.length ? logs.map((line, index) => <div className={`activity-line level-${line.level || 'info'}`} key={`${line.jobLogId || line.time}_${index}`}><span className="activity-time">{timeLabel(line.time)}</span><span className="activity-source">{line.source || 'StackPilot'}</span><span className="activity-text">{line.text}</span></div>) : <div className="activity-placeholder"><span>$</span>Activity from Claude, GitHub Actions, and Render will show up here.</div>}</div>}{expanded && <div className="activity-footer"><span><Radio size={12} /> Server-side run tracking</span><span>Refreshes every 2.2 seconds while open</span></div>}</section>;
}

function ReleaseSummary({ project, canDeploy, autoDeploy, onToggleAutoDeploy, onRun, busy, onSettings }) {
  const finished = ['live', 'verified'].includes(project.status);
  return <section className="release-summary workspace-card"><div className="release-summary-head"><div className="card-title-icon green"><Rocket size={15} /></div><div><strong>Release gate</strong><span>Render waits for GitHub success</span></div><span className="free-chip"><i /> FREE</span></div><div className="release-repo-line"><Github size={14} /><span>{project.repo || 'Add owner/repo in release settings'}</span></div><label className="release-auto-toggle"><input type="checkbox" checked={autoDeploy} onChange={(event) => onToggleAutoDeploy(event.target.checked)} /><span className="toggle-ui small-toggle" /><span><strong>Auto-deploy</strong><small>{autoDeploy ? 'Publish after checks pass' : 'Review, then deploy manually'}</small></span></label>{project.status === 'verified' && !autoDeploy && <button className="primary-button side-deploy-button" onClick={onRun} disabled={busy}><Rocket size={14} /> Deploy verified build</button>}{project.renderUrl && <a className="release-live-link" href={project.renderUrl} target="_blank" rel="noreferrer"><Globe size={14} /><span>{project.renderUrl.replace(/^https?:\/\//, '')}</span><ArrowUpRight size={13} /></a>}{!canDeploy && <div className="release-needs-key"><KeyRound size={13} /> Add a Render key in Settings to publish.</div>}<button className="release-settings-link" onClick={onSettings}><Settings2 size={13} /> Configure Render & connections</button>{finished && project.lastCommitUrl && <a className="commit-link" href={project.lastCommitUrl} target="_blank" rel="noreferrer"><CheckCircle2 size={13} /> View verified GitHub commit <ExternalLink size={12} /></a>}</section>;
}

function ReleaseSettings({ project, onRepoChange, onToggleAutoDeploy, onProjectChange, onSettings }) {
  return <section className="workspace-card release-settings-card"><div className="card-header"><div className="card-title-icon violet"><Settings2 size={16} /></div><div><strong>Release settings</strong><span>Choose where the verified source goes.</span></div><span className="free-chip"><i /> RENDER FREE</span></div>
    <label className="settings-field-inline"><span>GitHub repository</span><div className="start-repo-input"><Github size={15} /><input value={project.repo || ''} onChange={(event) => onRepoChange(event.target.value)} placeholder="owner/repo" autoCapitalize="none" autoCorrect="off" /></div></label>
    <div className="settings-two-column"><label className="settings-field-inline"><span>Branch</span><input value={project.branch || 'main'} onChange={(event) => onProjectChange({ branch: event.target.value })} /></label><label className="settings-field-inline"><span>Service type</span><select value={project.serviceType || 'web_service'} onChange={(event) => onProjectChange({ serviceType: event.target.value })}><option value="web_service">Web service</option><option value="static_site">Static site</option></select></label></div>
    <div className="settings-two-column"><label className="settings-field-inline"><span>Runtime</span><select value={project.runtime || 'node'} onChange={(event) => onProjectChange({ runtime: event.target.value })}><option value="node">Node.js</option><option value="python">Python</option><option value="ruby">Ruby</option><option value="go">Go</option><option value="elixir">Elixir</option></select></label><label className="settings-field-inline"><span>Region</span><select value={project.region || 'frankfurt'} onChange={(event) => onProjectChange({ region: event.target.value })}><option value="frankfurt">Frankfurt</option><option value="singapore">Singapore</option><option value="oregon">Oregon</option><option value="ohio">Ohio</option><option value="virginia">Virginia</option></select></label></div>
    <label className="settings-field-inline"><span>Build command</span><input value={project.buildCommand || ''} onChange={(event) => onProjectChange({ buildCommand: event.target.value })} placeholder="npm install && npm run build" /></label>
    {project.serviceType !== 'static_site' ? <div className="settings-two-column"><label className="settings-field-inline"><span>Start command</span><input value={project.startCommand || ''} onChange={(event) => onProjectChange({ startCommand: event.target.value })} placeholder="npm start" /></label><label className="settings-field-inline"><span>Root directory</span><input value={project.rootDir || ''} onChange={(event) => onProjectChange({ rootDir: event.target.value })} placeholder="(repository root)" /></label></div> : <label className="settings-field-inline"><span>Publish directory</span><input value={project.publishPath || 'dist'} onChange={(event) => onProjectChange({ publishPath: event.target.value })} placeholder="dist" /></label>}
    <div className="release-settings-footer"><label className="release-auto-toggle"><input type="checkbox" checked={project.autoDeploy !== false} onChange={(event) => onToggleAutoDeploy(event.target.checked)} /><span className="toggle-ui small-toggle" /><span><strong>Deploy automatically after GitHub checks</strong><small>Render is never triggered before the current commit passes.</small></span></label><button className="small-action" onClick={onSettings}><KeyRound size={13} /> Keys</button></div>
  </section>;
}

function ProjectCredentialsCard({ vault, onChange }) {
  return <section className="workspace-card project-credentials-card"><div className="card-header"><div className="card-title-icon blue"><KeyRound size={16} /></div><div><strong>Project-specific platform keys</strong><span>Optional overrides for this project only. These values stay in this browser session.</span></div></div><div className="project-credential-grid"><label className="settings-field-inline"><span>GitHub token override</span><input type="password" autoComplete="new-password" value={vault.githubToken || ''} onChange={(event) => onChange('githubToken', event.target.value)} placeholder="Use workspace default" /></label><label className="settings-field-inline"><span>Render API key override</span><input type="password" autoComplete="new-password" value={vault.renderToken || ''} onChange={(event) => onChange('renderToken', event.target.value)} placeholder="Use workspace default" /></label><label className="settings-field-inline"><span>Anthropic key override</span><input type="password" autoComplete="new-password" value={vault.anthropicKey || ''} onChange={(event) => onChange('anthropicKey', event.target.value)} placeholder="Use workspace default" /></label></div><div className="env-note"><ShieldCheck size={13} /> Overrides are not saved with the project files and are never pushed to GitHub.</div></section>;
}

function EnvironmentCard({ rows, onChange, onAdd, onRemove, onRefresh, serviceId, envConfigured, credentials }) {
  const [visible, setVisible] = useState(false);
  const populated = rows.filter((row) => row.key && row.value).length;
  return <section className="workspace-card env-card"><div className="card-header"><div className="card-title-icon amber"><KeyRound size={16} /></div><div><strong>Project environment</strong><span>Detected from .env.example and source usage; values stay in this browser until sent to Render.</span></div><button className="small-action" onClick={() => setVisible((value) => !value)}>{visible ? 'Hide values' : 'Show values'}</button></div>
    {!rows.length ? <div className="env-empty"><span><Sparkles size={15} /></span><div><strong>No environment keys detected</strong><small>Add keys your deployed app needs. They are never committed to GitHub.</small></div></div> : <div className="env-table">{rows.map((row, index) => <div className="env-row" key={`${row.key}_${index}`}><input className="env-key-input" value={row.key} onChange={(event) => onChange(index, 'key', event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} placeholder="API_KEY" aria-label="Environment variable name" /><input className="env-value-input" type={visible ? 'text' : 'password'} value={row.value || ''} onChange={(event) => onChange(index, 'value', event.target.value)} placeholder="Add secret value" aria-label={`Value for ${row.key || 'environment variable'}`} /><button className="icon-only danger-icon" onClick={() => onRemove(index)} aria-label={`Remove ${row.key || 'environment variable'}`}><X size={14} /></button></div>)}</div>}
    <div className="env-footer"><button className="small-action" onClick={onAdd}><Plus size={13} /> Add variable</button><span>{serviceId ? `Render service linked · ${populated} value${populated === 1 ? '' : 's'} ready` : 'Values are sent only when the Render service is created.'}</span><button className="small-action" onClick={onRefresh}><RefreshIcon /> Scan source</button></div>
    <div className="env-note"><ShieldCheck size={13} /> Platform keys: GitHub {envConfigured.github ? 'from server environment' : credentials.githubToken ? 'connected for this session' : 'not connected'} · Render {envConfigured.render ? 'from server environment' : credentials.renderToken ? 'connected for this session' : 'not connected'}</div>
  </section>;
}

function RefreshIcon() { return <Activity size={13} />; }

function FileTree({ files, current, onSelect }) {
  const [closed, setClosed] = useState({});
  const tree = useMemo(() => {
    const root = { folders: {}, files: [] };
    Object.keys(files || {}).sort().forEach((filePath) => {
      const parts = filePath.split('/'); let branch = root;
      for (const part of parts.slice(0, -1)) { branch.folders[part] ||= { folders: {}, files: [] }; branch = branch.folders[part]; }
      branch.files.push({ name: parts.at(-1), path: filePath });
    });
    return root;
  }, [files]);
  const renderBranch = (branch, depth = 0, parent = '') => <>
    {Object.keys(branch.folders).sort().map((name) => {
      const path = parent ? `${parent}/${name}` : name; const isClosed = Boolean(closed[path]);
      return <div key={`folder-${path}`}><button className="file-tree-folder" style={{ '--depth': depth }} onClick={() => setClosed((state) => ({ ...state, [path]: !state[path] }))}>{isClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<Folder size={14} /><span>{name}</span></button>{!isClosed && renderBranch(branch.folders[name], depth + 1, path)}</div>;
    })}
    {branch.files.map(({ name, path }) => { const Icon = fileIconFor(path); return <button key={path} className={`file-tree-row ${path === current ? 'selected' : ''}`} style={{ '--depth': depth }} onClick={() => onSelect(path)}><Icon size={14} /><span>{name}</span><small>{fileLanguage(path)}</small></button>; })}
  </>;
  return <div className="file-tree-list">{renderBranch(tree)}</div>;
}

function RenderStatusCard({ project, onSettings }) {
  return <section className="workspace-card render-status-card"><div className="card-header"><div className="card-title-icon green"><Cloud size={16} /></div><div><strong>Render status</strong><span>Configured from your release settings.</span></div></div><div className="render-status-line"><span className={`status-light ${project.status === 'live' ? 'light-green' : project.status === 'deploying' ? 'light-violet' : ''}`} /><strong>{project.status === 'live' ? 'Live' : project.status === 'deploying' ? 'Building' : project.status === 'verified' ? 'Waiting for deploy' : 'Not deployed yet'}</strong></div>{project.renderServiceId && <div className="service-id-line">Service <code>{project.renderServiceId}</code></div>}{project.renderDashboardUrl && <a className="small-action" href={project.renderDashboardUrl} target="_blank" rel="noreferrer"><Cloud size={13} /> Open Render dashboard <ExternalLink size={12} /></a>}<button className="small-action" onClick={onSettings}><KeyRound size={13} /> Edit Render key</button></section>;
}

function AboutPage({ projects, onBack, expiry, daysLeft, health, onSettings, onOpen }) {
  const live = projects.filter((project) => project.status === 'live').length;
  const working = projects.filter((project) => ['queued', 'running', 'deploying'].includes(project.status)).length;
  const commits = projects.filter((project) => project.lastCommit).length;
  const exactExpiry = expiry ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${expiry}T12:00:00Z`)) : '';
  const expiryText = expiry ? `${exactExpiry} · ${daysLeft < 0 ? `expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago` : daysLeft === 0 ? 'expires today' : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}` : 'Add a reminder date in Settings';
  return <div className="about-page"><header className="workspace-header"><button className="workspace-brand" onClick={onBack}><img src="/stackpilot-icon.png" alt="" /><span>stackpilot</span></button><div className="workspace-breadcrumb"><button onClick={onBack}>Workspace</button><ChevronRight size={13} /><span>My work</span></div><button className="header-settings" onClick={onSettings}><Settings2 size={17} /></button></header><main className="about-main"><button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back</button><div className="about-heading"><span className="section-eyebrow">ABOUT YOUR WORKSPACE</span><h1>Built to make progress visible.</h1><p>StackPilot turns a code dump into a reviewed GitHub commit, a real hosted build, and a live Render link.</p></div><div className="about-stat-grid"><div><strong>{projects.length}</strong><span>projects saved</span></div><div><strong>{live}</strong><span>live on Render</span></div><div><strong>{commits}</strong><span>GitHub commits</span></div><div><strong>{working}</strong><span>runs in progress</span></div></div><div className="about-detail-grid"><section className="workspace-card about-card"><div className="card-title-icon violet"><Github size={16} /></div><div><strong>GitHub token reminder</strong><span>GitHub does not reveal a PAT's expiry date through this integration. Add the date you chose when creating it; StackPilot will remind you at 7, 3, 1, and 0 days when notifications are enabled.</span></div><div className={`expiry-status ${daysLeft !== null && daysLeft <= 7 ? 'expiry-warning' : ''}`}><CalendarDays size={15} />{expiryText}</div><button className="soft-button" onClick={onSettings}>Manage token & reminder <ArrowRight size={14} /></button></section><section className="workspace-card about-card"><div className="card-title-icon green"><Radio size={16} /></div><div><strong>UptimeRobot endpoint</strong><span>Use this public URL for a simple HTTP(S) monitor. It stays outside the workspace password.</span></div><div className="monitor-url"><code>{typeof window !== 'undefined' ? `${window.location.origin}/health` : '/health'}</code><button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/health`)}><Copy size={13} /></button></div><div className="health-fact">{health?.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{health?.ok ? "StackPilot health is reachable. Monitor /health in UptimeRobot." : "The health endpoint could not be reached just now."}</div></section></div><section className="about-projects"><div className="recent-heading"><div><span className="section-eyebrow">PROJECT HISTORY</span><h2>Your work</h2></div><button className="soft-button" onClick={onSettings}>Settings <Settings2 size={14} /></button></div>{projects.length ? <div className="recent-grid">{projects.slice(0, 8).map((project) => <button className="about-project-row" key={project.id} onClick={() => onOpen(project.id)}><span className={`project-dot project-${project.status}`} /><span><strong>{project.name}</strong><small>{project.repo || 'Draft on this device'} · {timeAgo(project.updatedAt)}</small></span><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span><ArrowRight size={14} /></button>)}</div> : <div className="recent-empty"><strong>No projects yet</strong><span>Your first build will appear here.</span></div>}</section><p className="about-caveat">Drafts and project-specific environment values are stored in this browser session/device. GitHub is the durable source copy. Keep a separate backup of production credentials.</p></main></div>;
}

function DeploymentsPage({ projects, onBack, onOpen }) {
  const deployed = projects.filter((project) => project.renderUrl || project.renderServiceId || ['deploying', 'live'].includes(project.status));
  return <div className="about-page"><header className="workspace-header"><button className="workspace-brand" onClick={onBack}><img src="/stackpilot-icon.png" alt="" /><span>stackpilot</span></button><div className="workspace-breadcrumb"><button onClick={onBack}>Projects</button><ChevronRight size={13} /><span>Deployments</span></div></header><main className="about-main"><button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back</button><div className="about-heading"><span className="section-eyebrow">RELEASE HISTORY</span><h1>Every deploy, in one place.</h1><p>Render only receives a project after its current GitHub build and tests pass.</p></div>{deployed.length ? <div className="deployment-list">{deployed.map((project) => <button key={project.id} onClick={() => onOpen(project.id)}><span className={`project-dot project-${project.status}`} /><span><strong>{project.name}</strong><small>{project.repo || 'No repository linked'}</small></span><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span><span className="deployment-url">{project.renderUrl || 'Waiting for first Render deployment'}</span><ArrowUpRight size={15} /></button>)}</div> : <div className="recent-empty"><strong>No releases yet.</strong><span>Start a project and enable Auto-deploy to publish after successful checks.</span></div>}</main></div>;
}

function SettingsModal({ connectors, setConnectors, health, tokenExpiry, setTokenExpiry, githubIdentity, checkingGithub, checkingRender, onGithubTest, onRenderTest, onSaveGithubToServer, onSave, onEnableNotifications, onDisableNotifications, notificationReady, onClose }) {
  const [serverToken, setServerToken] = useState('');
  const [serverExpiry, setServerExpiry] = useState(tokenExpiry || '');
  const [savingServerToken, setSavingServerToken] = useState(false);
  const update = (key, value) => setConnectors((current) => ({ ...current, [key]: value }));
  const saveServerToken = async () => {
    setSavingServerToken(true);
    try { await onSaveGithubToServer(serverToken, serverExpiry); setTokenExpiry(serverExpiry); setServerToken(''); }
    catch (error) { window.alert(error.message || 'Could not save token.'); }
    finally { setSavingServerToken(false); }
  };
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
    <div className="modal-header"><div className="modal-icon"><Settings2 size={18} /></div><div><h2 id="settings-heading">Settings & connections</h2><p>Use fresh credentials. Secrets never enter project files or the GitHub commit.</p></div><button className="icon-only modal-close" onClick={onClose} aria-label="Close settings"><X size={18} /></button></div>
    <div className="modal-body">
      {health.authRequired && <div className="settings-card unlock-card"><div className="settings-section-heading"><span className="card-title-icon amber"><LockKeyhole size={15} /></span><div><strong>Workspace password</strong><small>Unlocks protected StackPilot APIs.</small></div></div><label className="settings-field-inline"><span>APP_PASSWORD</span><input type="password" autoComplete="current-password" value={connectors.appPassword} onChange={(event) => update('appPassword', event.target.value)} placeholder="Enter the workspace password" /></label></div>}
      <div className="settings-card"><div className="settings-section-heading"><span className="card-title-icon violet"><Sparkles size={15} /></span><div><strong>Anthropic / Claude</strong><small>Organizes code and diagnoses real build logs.</small></div><span className={`settings-state ${connectors.anthropicKey || health.envConfigured?.anthropic ? 'ready' : ''}`}>{connectors.anthropicKey || health.envConfigured?.anthropic ? 'READY' : 'ADD KEY'}</span></div><label className="settings-field-inline"><span>Anthropic API key</span><input type="password" autoComplete="new-password" value={connectors.anthropicKey} onChange={(event) => update('anthropicKey', event.target.value)} placeholder="sk-ant-…" /></label><small className="field-help">Can also be set privately as ANTHROPIC_API_KEY in Render environment.</small></div>
      <div className="settings-card"><div className="settings-section-heading"><span className="card-title-icon blue"><Github size={15} /></span><div><strong>GitHub</strong><small>Push code and start the real Actions build runner.</small></div><span className={`settings-state ${connectors.githubToken || health.envConfigured?.github ? 'ready' : ''}`}>{githubIdentity || (health.envConfigured?.github ? 'SERVER KEY' : connectors.githubToken ? 'SESSION KEY' : 'ADD KEY')}</span></div><label className="settings-field-inline"><span>Session token <small>optional if server token is saved</small></span><input type="password" autoComplete="new-password" value={connectors.githubToken} onChange={(event) => update('githubToken', event.target.value)} placeholder="github_pat_…" /></label><div className="settings-inline-actions"><button className="soft-button" onClick={onGithubTest} disabled={checkingGithub}>{checkingGithub ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Test GitHub</button><span>Fine-grained token: Contents read/write, Actions read/write, Metadata read.</span></div>
        <details className="server-secret-details"><summary>Save a fresh token in Render environment</summary><p>Stores the token as the private GITHUB_TOKEN environment variable on this StackPilot service. The app restarts after saving. Never use an exposed or revoked token here.</p><label className="settings-field-inline"><span>New GitHub token</span><input type="password" autoComplete="new-password" value={serverToken} onChange={(event) => setServerToken(event.target.value)} placeholder="Paste a newly rotated token" /></label><label className="settings-field-inline"><span>Token expiry date <small>manual reminder</small></span><input type="date" value={serverExpiry} onChange={(event) => setServerExpiry(event.target.value)} /></label><button className="primary-button save-server-token" onClick={saveServerToken} disabled={savingServerToken || !serverToken}>{savingServerToken ? <Loader2 size={14} className="spin" /> : <LockKeyhole size={14} />} Save token securely to Render</button></details>
      </div>
      <div className="settings-card"><div className="settings-section-heading"><span className="card-title-icon green"><Cloud size={15} /></span><div><strong>Render</strong><small>Create services after checks, then watch live build logs.</small></div><span className={`settings-state ${connectors.renderToken || health.envConfigured?.render ? 'ready' : ''}`}>{health.envConfigured?.render ? 'SERVER KEY' : connectors.renderToken ? 'SESSION KEY' : 'ADD KEY'}</span></div><label className="settings-field-inline"><span>Render API key</span><input type="password" autoComplete="new-password" value={connectors.renderToken} onChange={(event) => update('renderToken', event.target.value)} placeholder="rnd_…" /></label><label className="settings-field-inline"><span>Render workspace / owner ID</span><input value={connectors.renderOwnerId} onChange={(event) => update('renderOwnerId', event.target.value)} placeholder="tea-…" /></label><div className="settings-inline-actions"><button className="soft-button" onClick={onRenderTest} disabled={checkingRender}>{checkingRender ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Test Render</button><span>Service region defaults to Frankfurt; choose per project.</span></div></div>
      <div className="settings-card notification-settings"><div className="settings-section-heading"><span className="card-title-icon amber"><Bell size={15} /></span><div><strong>Real notifications</strong><small>{health.notificationsConfigured ? 'Web Push is configured on the server.' : 'Notifications need browser permission and server VAPID keys.'}</small></div><span className={`settings-state ${notificationReady ? 'ready' : ''}`}>{notificationReady ? 'ON' : 'DEVICE'}</span></div><button className="soft-button" onClick={notificationReady ? onDisableNotifications : onEnableNotifications}><Bell size={14} />{notificationReady ? 'Disable notifications' : 'Enable notifications'}</button><p className="field-help">On iPhone, add StackPilot to Home Screen first, then allow notifications. Web Push is supported by iOS 16.4+ home-screen web apps.</p></div>
      <div className="privacy-note"><ShieldCheck size={15} /><span>Session keys are kept in this browser tab. Server environment keys are stored by Render. Project environment values are session-only until sent to Render.</span></div>
    </div>
    <div className="modal-footer"><button className="quiet-button danger-text" onClick={() => { setConnectors((current) => ({ ...current, githubToken: '', renderToken: '', anthropicKey: '' })); }}>Clear session keys</button><div><button className="soft-button" onClick={onClose}>Close</button><button className="primary-button" onClick={onSave}><Check size={15} /> Save session settings</button></div></div>
  </section></div>;
}

function InstallHelp({ onClose }) {
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal install-modal"><div className="modal-header"><div className="modal-icon"><Smartphone size={18} /></div><div><h2>Add StackPilot to iPhone</h2><p>Use a home-screen app to get the best mobile and notification experience.</p></div><button className="icon-only modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button></div><div className="modal-body"><ol className="install-steps"><li><span>1</span><div><strong>Open in Safari</strong><small>Web Push on iOS requires Safari and iOS 16.4 or newer.</small></div></li><li><span>2</span><div><strong>Tap Share, then Add to Home Screen</strong><small>The StackPilot icon is configured for your home screen.</small></div></li><li><span>3</span><div><strong>Open the new StackPilot icon</strong><small>Tap Notifications and allow permission from inside the installed app.</small></div></li></ol><div className="privacy-note"><Bell size={15} /><span>Background runs continue on the StackPilot server. Push delivery and Render Free availability can still be affected by host restarts and usage limits.</span></div></div><div className="modal-footer"><span /><button className="primary-button" onClick={onClose}>Got it</button></div></section></div>;
}

export default App;
