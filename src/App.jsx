import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, ArrowUpRight, Bell, BookOpen,
  Braces, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp,
  Clipboard, Cloud, Code2, Copy, ExternalLink, Eye, File, FileCode2, Folder,
  Github, Globe, HardDrive, KeyRound, Loader2, LockKeyhole, Menu, Monitor,
  Plus, Radio, Rocket, Save, Search, Settings2, ShieldCheck, Smartphone, Sparkles,
  Terminal, Trash2, Download, FileArchive, GitBranch, Timer, Wifi, X, Zap,
  ArrowUp, History, Image as ImageIcon, MessageSquareText, Paperclip,
} from 'lucide-react';
import { createProjectId, getProjects, removeProject, saveProject } from './storage.js';
import { STEPS, calculateProgress, detectEnvKeys } from './workflow.js';
import { prepareAttachments } from './attachmentImport.js';
import { normalizeMonitorUrl } from './monitor.js';
import { binaryAssetByteLength, binaryAssetDataUri, isBinaryAsset, parseBinaryAsset } from './projectFiles.js';
import { MAX_PROJECT_BYTES, MAX_PROJECT_FILE_BYTES, MAX_PROJECT_FILE_COUNT, MAX_RAW_INPUT_CHARS } from './limits.js';

const SECRET_KEYS = { githubTokenExpiresAt: 'stackpilot.github.expires' };
const LEGACY_SESSION_SECRET_KEYS = [
  'stackpilot.openrouter.1.session', 'stackpilot.openrouter.2.session', 'stackpilot.github.session',
  'stackpilot.render.session', 'stackpilot.password.session', 'stackpilot.render.owner',
];

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
function clearLegacySessionSecrets() {
  try {
    LEGACY_SESSION_SECRET_KEYS.forEach((key) => sessionStorage.removeItem(key));
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index) || '';
      if (key.startsWith('stackpilot.project.vault.') || key.startsWith('stackpilot.project.env.')) sessionStorage.removeItem(key);
    }
  } catch { /* storage may be disabled */ }
}
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
  return ({ js: 'JavaScript', jsx: 'React JSX', ts: 'TypeScript', tsx: 'React TSX', html: 'HTML', css: 'CSS', json: 'JSON', md: 'Markdown', py: 'Python', yml: 'YAML', yaml: 'YAML', go: 'Go', sh: 'Shell', env: 'Environment', png: 'Binary image', jpg: 'Binary image', jpeg: 'Binary image', gif: 'Binary image', webp: 'Binary image', avif: 'Binary image', ico: 'Binary image', woff: 'Binary font', woff2: 'Binary font', ttf: 'Binary font', otf: 'Binary font', pdf: 'PDF asset', mp3: 'Audio asset', wav: 'Audio asset', mp4: 'Video asset', webm: 'Video asset' })[ext] || 'Text';
}
function fileIconFor(path) {
  if (path.endsWith('.json')) return Braces;
  if (/\.(jsx?|tsx?)$/.test(path)) return FileCode2;
  if (path.endsWith('.md')) return BookOpen;
  return File;
}
function projectFileByteLength(content) {
  return isBinaryAsset(content) ? binaryAssetByteLength(content) : new TextEncoder().encode(String(content || '')).byteLength;
}
function readMonitors() {
  try {
    const saved = JSON.parse(localStorage.getItem('stackpilot.uptime.monitors') || 'null');
    if (Array.isArray(saved)) return saved.slice(0, 30);
  } catch { /* local storage may be disabled */ }
  return [{ id: 'stackpilot-main', name: 'StackPilot', url: `${typeof window !== 'undefined' ? window.location.origin : 'https://stack-pilot-builder.onrender.com'}/health`, intervalSec: 60, checks: [], addedAt: new Date().toISOString(), status: 'unknown' }];
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
  const [connectors, setConnectors] = useState({ openRouterKey1: '', openRouterKey2: '', githubToken: '', renderToken: '', appPassword: '', renderOwnerId: '' });
  const [projectVaults, setProjectVaults] = useState({});
  const [projectEnvRows, setProjectEnvRows] = useState({});
  const [projectCredentialStatus, setProjectCredentialStatus] = useState({});
  const [health, setHealth] = useState({ authRequired: false, appPinRequired: false, envConfigured: {} });
  const [accessGranted, setAccessGranted] = useState(false);
  const [unlockInput, setUnlockInput] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [page, setPage] = useState('start');
  const [workspaceTab, setWorkspaceTab] = useState('build');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastList, setToastList] = useState([]);
  const [checkingGithub, setCheckingGithub] = useState(false);
  const [checkingRender, setCheckingRender] = useState(false);
  const [checkingOpenRouter, setCheckingOpenRouter] = useState(false);
  const [savingOpenRouter, setSavingOpenRouter] = useState(false);
  const [savingAppPin, setSavingAppPin] = useState(false);
  const [shellCommand, setShellCommand] = useState('npm run build');
  const [shellBusy, setShellBusy] = useState(false);
  const [githubIdentity, setGithubIdentity] = useState('');
  const [startSourceMode, setStartSourceMode] = useState('code');
  const [startInput, setStartInput] = useState('');
  const [startFiles, setStartFiles] = useState({});
  const [zipFilename, setZipFilename] = useState('');
  const [zipBusy, setZipBusy] = useState(false);
  const [startRepo, setStartRepo] = useState('');
  const [startBranch, setStartBranch] = useState('');
  const [startName, setStartName] = useState('');
  const [startAutoDeploy, setStartAutoDeploy] = useState(true);
  const [importingGithub, setImportingGithub] = useState(false);
  const [monitors, setMonitors] = useState(() => readMonitors());
  const monitorsRef = useRef(monitors);
  const checkingMonitors = useRef(new Set());
  const [editorDraft, setEditorDraft] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [search, setSearch] = useState('');
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
  const activeVault = useMemo(() => activeId ? (projectVaults[activeId] || {}) : {}, [activeId, projectVaults]);
  const detectedEnv = useMemo(() => active ? detectEnvKeys(active.files || {}) : [], [active?.files]);
  const projectEnv = useMemo(() => {
    if (!activeId) return [];
    const saved = projectEnvRows[activeId] || [];
    const values = new Map(saved.map((item) => [item.key, item]));
    detectedEnv.forEach((item) => { if (!values.has(item.key)) values.set(item.key, item); });
    return [...values.values()].slice(0, 30);
  }, [activeId, projectEnvRows, detectedEnv]);
  const activeJobs = useMemo(() => projects.filter((project) => project.jobId && ['queued', 'running', 'deploying'].includes(project.status)), [projects]);
  const activeJobSignature = activeJobs.map((project) => `${project.id}:${project.jobId}`).join('|');
  const appBusy = activeJobs.length > 0;
  const connectorCount = [connectors.openRouterKey1 || connectors.openRouterKey2 || health.envConfigured?.openrouter, connectors.githubToken || health.envConfigured?.github, connectors.renderToken || health.envConfigured?.render].filter(Boolean).length;

  const api = useCallback(async (url, payload, method = 'POST') => {
    const headers = { 'content-type': 'application/json' };
    if (connectors.appPassword) headers['x-app-password'] = connectors.appPassword;
    const response = await fetch(url, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(payload || {}) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && health.authRequired) {
        setAccessGranted(false);
        setConnectors((current) => ({ ...current, appPassword: '' }));
        setUnlockInput('');
        setUnlockError('Your app passcode needs to be entered again.');
        throw new Error('The workspace passcode was rejected. Return to the lock screen and try again.');
      }
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  }, [connectors.appPassword, health.authRequired]);

  const showToast = useCallback((message, tone = 'info') => {
    const id = `${Date.now()}_${Math.random()}`;
    setToastList((items) => [...items, { id, message, tone }]);
    window.setTimeout(() => setToastList((items) => items.filter((item) => item.id !== id)), 4500);
  }, []);

  const submitUnlock = async (event, submittedValue) => {
    event?.preventDefault?.();
    const code = String(submittedValue ?? unlockInput).trim();
    if (!code) { setUnlockError('Enter your app passcode to continue.'); return; }
    if (health.appPinRequired && !/^\d{4}$/.test(code)) { setUnlockError('Enter the four-digit app PIN.'); return; }
    setUnlockBusy(true);
    setUnlockError('');
    try {
      const response = await fetch('/api/auth/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-password': code } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || (response.status === 429 ? 'Too many attempts. Wait ten minutes and try again.' : 'That passcode did not match. Try again.'));
      setConnectors((current) => ({ ...current, appPassword: code }));
      setAccessGranted(true);
      setUnlockError('');
    } catch (error) {
      setUnlockError(error.message || 'Could not unlock the workspace.');
      if (health.appPinRequired) setUnlockInput('');
    } finally { setUnlockBusy(false); }
  };

  const logoutFromGate = () => {
    try { sessionStorage.removeItem('stackpilot.password.session'); } catch { /* storage may be disabled */ }
    setConnectors((current) => ({ ...current, appPassword: '' }));
    setUnlockInput('');
    setUnlockError('');
    setAccessGranted(false);
  };

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
    const detected = detectEnvKeys(files);
    setProjectEnvRows((current) => {
      const envMap = new Map((current[id] || []).map((row) => [row.key, row]));
      detected.forEach((row) => { if (!envMap.has(row.key)) envMap.set(row.key, row); });
      return { ...current, [id]: [...envMap.values()].slice(0, 30) };
    });
  }, []);

  const pingMonitor = useCallback(async (id) => {
    const monitor = monitorsRef.current.find((item) => item.id === id);
    if (!monitor || checkingMonitors.current.has(id)) return;
    checkingMonitors.current.add(id);
    setMonitors((rows) => rows.map((item) => item.id === id ? { ...item, checking: true } : item));
    try {
      const result = await api('/api/monitor/ping', { url: monitor.url });
      const check = { ok: Boolean(result.ok), statusCode: Number(result.statusCode) || 0, durationMs: Number(result.durationMs) || 0, checkedAt: result.checkedAt || new Date().toISOString(), error: String(result.error || '') };
      const wasUp = monitor.status === 'up';
      setMonitors((rows) => rows.map((item) => item.id === id ? { ...item, checking: false, status: check.ok ? 'up' : 'down', lastCheckedAt: check.checkedAt, responseMs: check.durationMs, checks: [...(item.checks || []), check].slice(-240) } : item));
      if (!check.ok && wasUp) {
        showToast(`${monitor.name} is down (${check.error || `HTTP ${check.statusCode}`}).`, 'error');
        if ('Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then((registration) => registration.showNotification(`${monitor.name} is down`, { body: check.error || `HTTP ${check.statusCode}`, icon: '/stackpilot-icon.png' })).catch(() => {});
      }
      return check;
    } catch (error) {
      const check = { ok: false, statusCode: 0, durationMs: 0, checkedAt: new Date().toISOString(), error: error.message || 'Monitor check failed.' };
      setMonitors((rows) => rows.map((item) => item.id === id ? { ...item, checking: false, status: 'down', lastCheckedAt: check.checkedAt, responseMs: 0, checks: [...(item.checks || []), check].slice(-240) } : item));
      return check;
    } finally { checkingMonitors.current.delete(id); }
  }, [api, showToast]);

  const addMonitor = (value, name = '', projectId = '') => {
    let url;
    try { url = normalizeMonitorUrl(value); }
    catch (error) { showToast(error.message || 'Enter a public HTTP(S) URL.', 'error'); return; }
    let duplicate = monitorsRef.current.find((item) => item.url === url && (projectId ? item.projectId === projectId || item.id === `project_${projectId}` : !item.projectId));
    if (!duplicate && projectId) duplicate = monitorsRef.current.find((item) => item.url === url && !item.projectId);
    if (duplicate) {
      if (projectId && duplicate.projectId !== projectId) setMonitors((rows) => rows.map((item) => item.id === duplicate.id ? { ...item, projectId, name: name.trim() || item.name } : item));
      showToast(projectId ? 'This URL is already monitored for this project.' : 'That URL is already being monitored.');
      return;
    }
    if (monitorsRef.current.length >= 30) { showToast('Keep at most 30 monitor URLs on this device.', 'error'); return; }
    const monitor = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, projectId: projectId || '', name: name.trim() || new URL(url).hostname, url, intervalSec: 60, checks: [], addedAt: new Date().toISOString(), status: 'unknown' };
    setMonitors((rows) => [monitor, ...rows]);
    window.setTimeout(() => pingMonitor(monitor.id), 50);
    showToast('Monitor added. Checks run while this app is open and visible.', 'success');
  };

  const removeMonitor = (id) => setMonitors((rows) => rows.filter((item) => item.id !== id));
  const updateMonitorInterval = (id, intervalSec) => setMonitors((rows) => rows.map((item) => item.id === id ? { ...item, intervalSec: Number(intervalSec) } : item));

  useEffect(() => { monitorsRef.current = monitors; try { localStorage.setItem('stackpilot.uptime.monitors', JSON.stringify(monitors)); } catch { /* local storage may be disabled */ } }, [monitors]);

  useEffect(() => {
    if (health.authRequired && !connectors.appPassword) return undefined;
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      monitorsRef.current.forEach((item) => {
        if (checkingMonitors.current.has(item.id)) return;
        const last = Date.parse(item.lastCheckedAt || item.checks?.at(-1)?.checkedAt || '');
        const interval = Math.max(60, Math.min(3600, Number(item.intervalSec) || 60)) * 1000;
        if (!Number.isFinite(last) || now - last >= interval) pingMonitor(item.id);
      });
    };
    poll();
    const timer = window.setInterval(poll, 15_000);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [pingMonitor, connectors.appPassword, health.authRequired]);

  useEffect(() => {
    const discovered = projects.filter((project) => project.renderUrl).map((project) => {
      try { return { project, url: normalizeMonitorUrl(project.renderUrl) }; } catch { return null; }
    }).filter(Boolean);
    if (!discovered.length) return;
    setMonitors((rows) => {
      const next = [...rows];
      let changed = false;
      for (const { project, url } of discovered) {
        const projectIndex = next.findIndex((item) => item.projectId === project.id || item.id === `project_${project.id}`);
        if (projectIndex >= 0) {
          const prior = next[projectIndex];
          if (prior.url !== url || prior.name !== project.name || prior.projectId !== project.id) {
            next[projectIndex] = { ...prior, projectId: project.id, name: project.name, url, status: prior.url === url ? prior.status : 'unknown', checks: prior.url === url ? prior.checks : [], lastCheckedAt: prior.url === url ? prior.lastCheckedAt : '' };
            changed = true;
          }
          continue;
        }
        const urlIndex = next.findIndex((item) => item.url === url && !item.projectId);
        if (urlIndex >= 0) {
          next[urlIndex] = { ...next[urlIndex], projectId: project.id, name: project.name };
          changed = true;
          continue;
        }
        if (next.length < 30) {
          next.unshift({ id: `project_${project.id}`, projectId: project.id, name: project.name, url, intervalSec: 60, checks: [], addedAt: new Date().toISOString(), status: 'unknown' });
          changed = true;
        }
      }
      return changed ? next : rows;
    });
  }, [projects]);

  useEffect(() => {
    clearLegacySessionSecrets();
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
      } finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (loading) return undefined;
    if (!health.authRequired) { setAccessGranted(true); return undefined; }
    setAccessGranted(false);
    const savedCode = connectors.appPassword;
    if (!savedCode) return undefined;
    let cancelled = false;
    fetch('/api/auth/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-password': savedCode } })
      .then((response) => {
        if (cancelled) return;
        if (response.ok) setAccessGranted(true);
        else {
          setConnectors((current) => ({ ...current, appPassword: '' }));
          setUnlockInput('');
        }
      })
      .catch(() => { if (!cancelled) setAccessGranted(false); });
    return () => { cancelled = true; };
  }, [loading, health.authRequired]);

  useEffect(() => {
    if (!active?.activeFile) { setEditorDraft(''); setEditorDirty(false); return; }
    const content = active.files?.[active.activeFile] || '';
    setEditorDraft(isBinaryAsset(content) ? '' : content);
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
    setProjectVaults((current) => ({ ...current, [projectId]: { ...(current[projectId] || {}), [field]: value } }));
  };
  const setEnvironmentRows = (projectId, rows) => {
    if (!projectId) return;
    setProjectEnvRows((current) => ({ ...current, [projectId]: rows.slice(0, 30) }));
  };
  const effectiveCredentials = (projectId) => {
    const vault = projectId ? projectVaults[projectId] || {} : {};
    return {
      openRouterKey1: vault.openRouterKey1 || connectors.openRouterKey1 || '',
      openRouterKey2: vault.openRouterKey2 || connectors.openRouterKey2 || '',
      githubToken: vault.githubToken || connectors.githubToken || '',
      renderToken: vault.renderToken || connectors.renderToken || '',
      renderOwnerId: vault.renderOwnerId || connectors.renderOwnerId || '',
    };
  };
  const loadProjectCredentialStatus = async (projectId) => {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/credentials`, undefined, 'GET');
    setProjectCredentialStatus((current) => ({ ...current, [projectId]: result.configured || {} }));
    return result.configured || {};
  };
  const saveProjectCredentials = async (projectId, credentials) => {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/credentials`, { credentials, adminRenderToken: connectors.renderToken || '' });
    setProjectCredentialStatus((current) => ({ ...current, [projectId]: result.configured || {} }));
    showToast('Project keys were saved as secrets on StackPilot Render. A restart has been queued.', 'success');
    return result;
  };
  const clearProjectCredentials = async (projectId) => {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/credentials`, { clear: true, adminRenderToken: connectors.renderToken || '' });
    setProjectCredentialStatus((current) => ({ ...current, [projectId]: result.configured || {} }));
    setProjectVaults((current) => { const next = { ...current }; delete next[projectId]; return next; });
    showToast('Saved project platform keys were cleared from StackPilot Render.', 'success');
    return result;
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
  const testOpenRouter = async () => {
    setCheckingOpenRouter(true);
    try {
      const data = await api('/api/openrouter/test', { key1: connectors.openRouterKey1 || '', key2: connectors.openRouterKey2 || '' });
      showToast(data.remainingFreeRequests === null ? 'OpenRouter key is valid; free-model availability may vary.' : `OpenRouter key is valid · ${data.remainingFreeRequests} free requests remain today.`, 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { setCheckingOpenRouter(false); }
  };
  const testRender = async () => {
    setCheckingRender(true);
    try {
      await api('/api/render/test', { token: connectors.renderToken || '' });
      showToast('Render API connection is healthy.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    finally { setCheckingRender(false); }
  };

  const saveRenderTokenToServer = async (token, ownerId) => {
    const value = String(token || '').trim();
    if (!value) throw new Error('Enter a Render API key first.');
    const result = await api('/api/settings/render-token', { renderToken: value, ownerId: String(ownerId || '').trim() });
    setHealth((current) => ({ ...current, envConfigured: { ...(current.envConfigured || {}), render: true }, renderOwnerId: String(ownerId || current.renderOwnerId || '') }));
    setConnectors((current) => ({ ...current, renderToken: '', renderOwnerId: String(ownerId || current.renderOwnerId || '') }));
    showToast('Render API key saved as a StackPilot Render secret. A service restart has been queued.', 'success');
    return result;
  };

  const saveOpenRouterKeysToServer = async (key1, key2) => {
    const first = String(key1 || '').trim();
    const second = String(key2 || '').trim();
    if (!first || first.length < 20 || (second && second.length < 20)) throw new Error('Enter one or two OpenRouter keys before saving.');
    const result = await api('/api/settings/openrouter-keys', { key1: first, key2: second, renderToken: connectors.renderToken || '' });
    setHealth((current) => ({ ...current, envConfigured: { ...(current.envConfigured || {}), openrouter: true } }));
    showToast('OpenRouter keys are saved in Render. Free routing activates after the queued deploy.', 'success');
    return result;
  };

  const saveAppPinToServer = async (pin) => {
    const value = String(pin || '').trim();
    if (!/^\d{4}$/.test(value)) throw new Error('Choose exactly four digits for the App PIN.');
    const result = await api('/api/settings/app-pin', { pin: value, renderToken: connectors.renderToken || '' });
    showToast('App PIN saved in Render. It becomes active when the queued deploy starts.', 'success');
    return result;
  };

  const saveGithubTokenToServer = async (githubToken, expiry) => {
    const value = String(githubToken || '').trim();
    if (!value) throw new Error('Enter a fresh GitHub token first.');
    const result = await api('/api/settings/github-token', { githubToken: value, expiresAt: expiry || '', renderToken: connectors.renderToken || '' });
    setGithubIdentity(result.login || 'Connected');
    setTokenExpiry(expiry || '');
    try { localStorage.setItem(SECRET_KEYS.githubTokenExpiresAt, expiry || ''); } catch { /* storage disabled */ }
    setHealth((current) => ({ ...current, envConfigured: { ...(current.envConfigured || {}), github: true }, githubTokenExpiresAt: expiry || '', serviceId: current.serviceId || '' }));
    setConnectors((current) => ({ ...current, githubToken: '' }));
    showToast('Fresh GitHub token saved as a Render secret. The browser field was cleared; StackPilot is restarting to activate it.', 'success');
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
    if (!startInput.trim() && !Object.keys(startFiles).length) { showToast('Paste a brief or code dump, or upload a ZIP archive first.', 'error'); return; }
    const name = startName.trim() || (startRepo.split('/').filter(Boolean).at(-1) || 'New project').replace(/[-_]/g, ' ');
    const project = newProject(name);
    project.rawInput = startInput;
    project.files = { ...startFiles };
    project.activeFile = Object.keys(project.files).sort()[0] || '';
    project.repo = startRepo.trim();
    project.branch = startBranch.trim() || 'main';
    project.autoDeploy = startAutoDeploy;
    project.status = Object.keys(project.files).length ? 'ready' : 'draft';
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
    setWorkspaceTab('build');
    setPage('workspace');
    if (Object.keys(project.files).length) updateProjectFiles(project.id, project.files);
    saveProject(project).then(() => savedVersions.current.set(project.id, project.updatedAt)).catch(() => {});
    showToast(project.repo ? 'Project workspace created. Starting the verified release path…' : 'Project workspace created. Add a GitHub repository when you are ready to build.');
    if (project.repo) window.setTimeout(() => runFullPipeline(project), 50);
  };

  const importAttachedFiles = async (fileList) => {
    const selected = Array.from(fileList || []);
    if (!selected.length || zipBusy) return;
    setZipBusy(true);
    try {
      const result = await prepareAttachments(selected, startFiles);
      if (!result.count) { showToast('No supported files were found in that selection.', 'error'); return; }
      setStartFiles((current) => ({ ...current, ...result.files }));
      setZipFilename(`${result.totalFiles} files attached`);
      showToast(`Added ${result.count} file${result.count === 1 ? '' : 's'}${result.mediaCount ? ` · ${result.mediaCount} image/media asset${result.mediaCount === 1 ? '' : 's'} preserved` : ''}${result.renamedCount ? ` · renamed ${result.renamedCount} duplicate name${result.renamedCount === 1 ? '' : 's'} so both copies stay` : ''}${result.skipped ? ` · skipped ${result.skipped.toLocaleString()} generated/unsafe/unsupported ZIP entries` : ''}.`, 'success');
    } catch (error) { showToast(error.message || 'Could not add those files.', 'error'); }
    finally { setZipBusy(false); }
  };

  const removeStartAttachment = (path) => {
    const next = { ...startFiles };
    delete next[path];
    setStartFiles(next);
    setZipFilename(Object.keys(next).length ? `${Object.keys(next).length} files attached` : '');
  };

  const clearStartAttachments = () => {
    setStartFiles({});
    setZipFilename('');
  };

  const importGithubRepo = async () => {
    const repository = startRepo.trim();
    if (!repository) { showToast('Enter owner/repo or a GitHub URL first.', 'error'); return; }
    const token = connectors.githubToken || '';
    if (!token && !health.envConfigured?.github) { setSettingsOpen(true); showToast('Connect GitHub in Settings to import a repository.', 'error'); return; }
    setImportingGithub(true);
    try {
      const result = await api('/api/github/import', { token, repository, branch: startBranch || '' });
      const name = startName.trim() || repository.split('/').at(-1)?.replace(/[-_]/g, ' ') || 'Imported project';
      const project = newProject(name);
      project.repo = result.repository;
      project.branch = result.branch;
      project.files = result.files || {};
      project.activeFile = Object.keys(project.files).sort()[0] || '';
      project.rawInput = startInput;
      project.status = 'ready';
      project.summary = `Imported ${result.count.toLocaleString()} safe files/assets from ${result.repository} (${result.branch}).`;
      project.autoDeploy = startAutoDeploy;
      setProjects((current) => [project, ...current]);
      setActiveId(project.id); setWorkspaceTab('build'); setPage('workspace');
      updateProjectFiles(project.id, project.files);
      saveProject(project).then(() => savedVersions.current.set(project.id, project.updatedAt)).catch(() => {});
      showToast(`Imported ${result.count.toLocaleString()} files${result.skipped ? ` · skipped ${result.skipped.toLocaleString()} generated/unsafe/unsupported entries` : ''}. Choose GitHub-only checks or auto-deploy after they pass.`, 'success');
    } catch (error) { showToast(error.message || 'Could not import the repository.', 'error'); }
    finally { setImportingGithub(false); }
  };

  const createNewProject = () => {
    setStartInput(''); setStartFiles({}); setZipFilename(''); setStartSourceMode('code');
    setStartRepo(''); setStartBranch(''); setStartName(''); setStartAutoDeploy(true);
    setActiveId(''); setPage('start');
  };

  const openProject = (id) => { setActiveId(id); setPage('workspace'); setWorkspaceTab('build'); loadProjectCredentialStatus(id).catch(() => {}); };

  const deleteProject = async (id) => {
    const project = projects.find((row) => row.id === id);
    if (!project) return;
    if (!window.confirm(`Remove “${project.name}” from this device? Its GitHub repository and Render service will not be deleted.`)) return;
    const timer = saveTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    saveTimers.current.delete(id);
    await removeProject(id).catch(() => {});
    setProjectVaults((current) => { const next = { ...current }; delete next[id]; return next; });
    setProjectEnvRows((current) => { const next = { ...current }; delete next[id]; return next; });
    setProjectCredentialStatus((current) => { const next = { ...current }; delete next[id]; return next; });
    const next = projects.filter((row) => row.id !== id);
    setProjects(next);
    setMonitors((rows) => rows.filter((item) => item.projectId !== id && item.id !== `project_${id}`));
    if (activeId === id) { setActiveId(''); setPage('start'); }
    showToast('Project removed from this browser. GitHub and Render were not changed.');
  };

  const runFullPipeline = async (projectOverride = null) => {
    const project = projectOverride || active;
    if (!project || appBusy) return;
    const credentials = effectiveCredentials(project.id);
    const runProject = { ...project };
    if (project.status === 'verified' && Object.keys(project.files || {}).length) runProject.rawInput = '';
    const envVars = (project.id === activeId ? projectEnv : projectEnvRows[project.id] || []).filter((row) => row.key && row.value !== undefined).map(({ key, value }) => ({ key, value: String(value) }));
    updateProject(project.id, { status: 'running', progress: 0, activeAgent: 'StackPilot orchestrator', jobId: '', steps: Object.fromEntries(STEPS.map((step) => [step.id, 'idle'])) });
    appendLog(project.id, 'Background run requested. StackPilot keeps working server-side if you leave the page.', 'info', 'Orchestrator');
    try {
      const started = await api('/api/jobs', {
        project: runProject,
        credentials,
        renderOwnerId: connectors.renderOwnerId,
        envVars,
        model: 'openrouter/free',
      });
      updateProject(project.id, { jobId: started.jobId, status: 'running', progress: 0, activeAgent: 'StackPilot orchestrator' });
      pollCursor.current.set(started.jobId, { after: 0, version: 0 });
      showToast('StackPilot agents are working in the background.', 'success');
    } catch (error) {
      updateProject(project.id, { status: 'needs_attention', progress: 0, jobId: '' });
      appendLog(project.id, error.message || 'Could not start the background run.', 'error', 'StackPilot');
      if (/key override|key in project settings/i.test(error.message || '')) { setActiveId(project.id); setPage('workspace'); setWorkspaceTab('deploy'); }
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
    if (!shellCommand.trim()) { showToast('Enter a command for the temporary runner.', 'error'); return; }
    setShellBusy(true);
    const captureAt = Date.now();
    appendLog(active.id, `Queueing temporary GitHub runner command: ${shellCommand}`, 'info', 'Remote shell');
    try {
      await api('/api/github/dispatch', { token: credentials.githubToken, projectId: active.id, repository: active.repo, branch: active.branch || 'main', command: shellCommand });
      appendLog(active.id, 'Command accepted by a temporary GitHub Actions runner. The command continues if you close this page.', 'info', 'Remote shell');
      let waited = 0; let last = '';
      while (waited < 7 * 60_000) {
        const info = await api('/api/github/runs', { token: credentials.githubToken, projectId: active.id, repository: active.repo, branch: active.branch || 'main', since: new Date(captureAt).toISOString() });
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
    if (!active?.activeFile || isBinaryAsset(active.files?.[active.activeFile])) return;
    const bytes = new TextEncoder().encode(editorDraft).byteLength;
    if (bytes > MAX_PROJECT_FILE_BYTES) { showToast(`A project file can be up to ${Math.floor(MAX_PROJECT_FILE_BYTES / (1024 * 1024))} MB. Nothing was changed.`, 'error'); return; }
    const files = { ...active.files, [active.activeFile]: editorDraft };
    if (Object.keys(files).length > MAX_PROJECT_FILE_COUNT) { showToast(`A project can have up to ${MAX_PROJECT_FILE_COUNT.toLocaleString()} files.`, 'error'); return; }
    const totalBytes = Object.values(files).reduce((sum, content) => sum + projectFileByteLength(content), 0);
    if (totalBytes > MAX_PROJECT_BYTES) { showToast(`Project files are limited to ${Math.floor(MAX_PROJECT_BYTES / (1024 * 1024))} MB total. Nothing was changed.`, 'error'); return; }
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
    if (Object.keys(active.files || {}).length >= MAX_PROJECT_FILE_COUNT) { showToast(`A project can have up to ${MAX_PROJECT_FILE_COUNT.toLocaleString()} files.`, 'error'); return; }
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
  const currentProjectCredentialStatus = activeId ? projectCredentialStatus[activeId] || {} : {};
  const activeEnvConfigured = {
    ...(health.envConfigured || {}),
    github: Boolean(health.envConfigured?.github || currentProjectCredentialStatus.githubToken),
    render: Boolean(health.envConfigured?.render || currentProjectCredentialStatus.renderToken),
    openrouter: Boolean(health.envConfigured?.openrouter || currentProjectCredentialStatus.openRouterKey1 || currentProjectCredentialStatus.openRouterKey2),
  };

  if (loading) return <div className="app-loading"><img src="/stackpilot-icon.png" alt="" /><span>Preparing your workspace…</span></div>;
  if (health.authRequired && !accessGranted) return <AccessGate
    appPinRequired={health.appPinRequired} value={unlockInput} onChange={(value) => { setUnlockInput(value); setUnlockError(''); }}
    busy={unlockBusy} error={unlockError} onSubmit={submitUnlock} onLogout={logoutFromGate}
  />;

  return (
    <div className="site-shell">
      {page === 'start' && <StartPage
        input={startInput} setInput={setStartInput} filesCount={Object.keys(startFiles).length} zipFilename={zipFilename} zipBusy={zipBusy} onAddFiles={importAttachedFiles} attachedFiles={startFiles} onRemoveAttachment={removeStartAttachment} onClearAttachments={clearStartAttachments}
        sourceMode={startSourceMode} setSourceMode={setStartSourceMode} importingGithub={importingGithub} onImportGithub={importGithubRepo}
        repo={startRepo} setRepo={setStartRepo} branch={startBranch} setBranch={setStartBranch} name={startName} setName={setStartName}
        autoDeploy={startAutoDeploy} setAutoDeploy={setStartAutoDeploy} onStart={newProjectFromHome} onOpenMonitors={() => setPage('monitor')}
        projects={filteredProjects} monitors={monitors} onOpen={openProject} onNew={createNewProject} onDelete={deleteProject}
        search={search} setSearch={setSearch} onSettings={() => setSettingsOpen(true)} onAbout={() => setPage('about')}
        health={health} connectorCount={connectorCount} notificationsReady={notificationReady} onEnableNotifications={enableNotifications} onShowToast={showToast}
        onSample={() => { setStartInput(SAMPLE_DUMP); if (!startName) setStartName('Northstar landing page'); }}
        onInstallHelp={() => setInstallHelpOpen(true)} onCopyMonitor={() => navigator.clipboard?.writeText(`${window.location.origin}/health`).then(() => showToast('UptimeRobot URL copied.', 'success')).catch(() => showToast('Clipboard is unavailable in this browser.', 'error'))}
      />}
      {page === 'workspace' && active && <ProjectWorkspace
        project={active} credentials={effectiveCredentials(active.id)} envConfigured={activeEnvConfigured}
        projectVault={activeVault} projectCredentialStatus={currentProjectCredentialStatus}
        onVaultChange={(key, value) => setVaultField(active.id, key, value)} onLoadProjectCredentialStatus={() => loadProjectCredentialStatus(active.id)}
        onSaveProjectCredentials={(values) => saveProjectCredentials(active.id, values)} onClearProjectCredentials={() => clearProjectCredentials(active.id)}
        envRows={projectEnv} onEnvChange={updateEnvironment} onAddEnv={addEnvironment} onRemoveEnv={removeEnvironment}
        tab={workspaceTab} setTab={setWorkspaceTab} onHome={() => setPage('start')} allProjects={projects} onOpenProject={openProject}
        monitors={monitors} onAddMonitor={addMonitor} onPingMonitor={pingMonitor} onRemoveMonitor={removeMonitor} onMonitorInterval={updateMonitorInterval} onSettings={() => setSettingsOpen(true)}
        onNameChange={updateProjectName} onRepoChange={updateRepo} onProjectChange={(patch) => updateProject(active.id, patch)} onRun={runOrDeploy} onToggleAutoDeploy={toggleAutoDeploy}
        busy={appBusy} onDelete={() => deleteProject(active.id)} onEditorChange={(value) => { setEditorDraft(value); setEditorDirty(true); }}
        editorDraft={editorDraft} editorDirty={editorDirty} onSaveEditor={saveEditor} onSelectFile={selectFile} onAddFile={addFile}
        onAbout={() => setPage('about')} onOpenMonitors={() => setPage('monitor')} onShowToast={showToast} onRefreshEnv={() => updateProjectFiles(active.id, active.files || {})}
        shellCommand={shellCommand} setShellCommand={setShellCommand} shellBusy={shellBusy} onRunShell={runShellCommand}
      />}
      {page === 'about' && <AboutPage projects={projects} onBack={() => setPage(activeId ? 'workspace' : 'start')} expiry={tokenExpiry} daysLeft={tokenDaysLeft} health={health} onSettings={() => setSettingsOpen(true)} onOpenMonitors={() => setPage('monitor')} onOpen={openProject} />}
      {page === 'deployments' && <DeploymentsPage projects={projects} onBack={() => setPage('start')} onOpen={openProject} />}
      {page === 'monitor' && <MonitorPage monitors={monitors} onBack={() => setPage(activeId ? 'workspace' : 'start')} onAdd={addMonitor} onPing={pingMonitor} onRemove={removeMonitor} onInterval={(id, intervalSec) => setMonitors((rows) => rows.map((item) => item.id === id ? { ...item, intervalSec: Number(intervalSec) } : item))} />}

      {settingsOpen && <SettingsModal
        connectors={connectors} setConnectors={setConnectors} health={health} tokenExpiry={tokenExpiry} setTokenExpiry={setTokenExpiry}
        githubIdentity={githubIdentity} checkingGithub={checkingGithub} checkingRender={checkingRender} checkingOpenRouter={checkingOpenRouter}
        onGithubTest={testGithub} onRenderTest={testRender} onOpenRouterTest={testOpenRouter} onSaveGithubToServer={saveGithubTokenToServer}
        onSaveRenderToken={saveRenderTokenToServer} onSaveOpenRouterKeys={saveOpenRouterKeysToServer} onSaveAppPin={saveAppPinToServer}
        onClearSecrets={() => { setConnectors({ openRouterKey1: '', openRouterKey2: '', githubToken: '', renderToken: '', appPassword: '', renderOwnerId: '' }); setProjectVaults({}); setProjectEnvRows({}); setUnlockInput(''); setUnlockError(''); setAccessGranted(!health.authRequired); }}
        onSave={() => { setSettingsOpen(false); showToast('Unsaved fields are kept only in this tab. Keys saved to Render remain server-side.', 'success'); }}
        onEnableNotifications={enableNotifications} onDisableNotifications={disableNotifications} notificationReady={notificationReady} onClose={() => setSettingsOpen(false)}
      />}
      {installHelpOpen && <InstallHelp onClose={() => setInstallHelpOpen(false)} />}
      <div className="toast-stack" aria-live="polite">{toastList.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}><span className="toast-icon">{toast.tone === 'error' ? <AlertTriangle size={17} /> : toast.tone === 'success' ? <CheckCircle2 size={17} /> : <Activity size={17} />}</span><span>{toast.message}</span><button onClick={() => setToastList((list) => list.filter((item) => item.id !== toast.id))} aria-label="Dismiss"><X size={14} /></button></div>)}</div>
    </div>
  );
}

function AccessGate({ appPinRequired, value, onChange, busy, error, onSubmit, onLogout }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashLeaving, setSplashLeaving] = useState(false);
  const submitTimer = useRef(null);

  useEffect(() => {
    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const fadeTimer = window.setTimeout(() => setSplashLeaving(true), reducedMotion ? 0 : 850);
    const hideTimer = window.setTimeout(() => setSplashVisible(false), reducedMotion ? 180 : 1320);
    return () => { window.clearTimeout(fadeTimer); window.clearTimeout(hideTimer); };
  }, []);

  useEffect(() => () => window.clearTimeout(submitTimer.current), []);

  const handleDigit = (digit) => {
    if (busy || !appPinRequired || value.length >= 4) return;
    const next = `${value}${digit}`.slice(0, 4);
    onChange(next);
    if (next.length === 4) {
      window.clearTimeout(submitTimer.current);
      submitTimer.current = window.setTimeout(() => onSubmit(null, next), 170);
    }
  };

  const handleBackspace = () => {
    if (busy) return;
    window.clearTimeout(submitTimer.current);
    onChange(value.slice(0, -1));
  };

  useEffect(() => {
    if (!appPinRequired || splashVisible) return undefined;
    const handleKeyDown = (event) => {
      if (busy || event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^\d$/.test(event.key)) { event.preventDefault(); handleDigit(event.key); }
      else if (event.key === 'Backspace') { event.preventDefault(); handleBackspace(); }
      else if (event.key === 'Escape') { window.clearTimeout(submitTimer.current); setHelpOpen(false); onChange(''); }
      else if (event.key === 'Enter' && value.length === 4) { event.preventDefault(); window.clearTimeout(submitTimer.current); onSubmit(event, value); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [appPinRequired, splashVisible, busy, value, onChange, onSubmit]);

  const handleLogout = () => {
    window.clearTimeout(submitTimer.current);
    setHelpOpen(false);
    onLogout?.();
  };

  if (splashVisible) return <div className={`pin-splash${splashLeaving ? ' is-exiting' : ''}`} role="status" aria-label="Opening StackPilot">
    <div className="pin-splash-lockup">
      <img src="/stackpilot-icon-192.png" alt="" />
      <span>stackpilot</span>
    </div>
  </div>;

  return <main className={`access-gate-page pin-gate-page${error ? ' has-error' : ''}`}>
    <header className="pin-gate-header">
      <button className="pin-gate-action" type="button" onClick={handleLogout} disabled={busy}>Log out</button>
      <button className="pin-gate-action pin-gate-help-action" type="button" onClick={() => setHelpOpen((open) => !open)} aria-expanded={helpOpen}>
        <CircleHelp size={19} strokeWidth={1.8} /> Help
      </button>
    </header>

    {appPinRequired ? <section className="pin-gate-main" aria-labelledby="pin-gate-title">
      <img className="pin-gate-app-icon" src="/stackpilot-icon-192.png" alt="StackPilot app icon" />
      <h1 id="pin-gate-title">Welcome back</h1>
      <p className="pin-gate-subtitle">Enter your login PIN to continue</p>
      <div className={`pin-gate-indicators${error ? ' is-error' : ''}`} role="img" aria-label={`${value.length} of 4 PIN digits entered`}>
        {Array.from({ length: 4 }, (_, index) => <span key={index} className={index < value.length ? 'is-filled' : ''} />)}
      </div>
      <div className="pin-gate-error-slot" role="alert" aria-live="assertive">{error || ''}</div>
      <div className="pin-gate-keypad" role="group" aria-label="PIN keypad">
        {'123456789'.split('').map((digit) => <button className="pin-gate-key" key={digit} type="button" onClick={() => handleDigit(digit)} disabled={busy} aria-label={`Digit ${digit}`}>{digit}</button>)}
        <span className="pin-gate-key-spacer" aria-hidden="true" />
        <button className="pin-gate-key" type="button" onClick={() => handleDigit('0')} disabled={busy} aria-label="Digit zero">0</button>
        <button className="pin-gate-key pin-gate-delete" type="button" onClick={handleBackspace} disabled={busy || !value.length} aria-label="Delete last digit">
          <svg viewBox="0 0 32 24" aria-hidden="true"><path d="M11 3.5h17v17H11L3 12l8-8.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="m17 8 7 8m0-8-7 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </div>
      <button className="pin-gate-forgot" type="button" onClick={() => setHelpOpen((open) => !open)} aria-expanded={helpOpen}>Forgot PIN?</button>
      {helpOpen && <div className="pin-gate-help-note" role="status">For a secure reset, contact the StackPilot workspace owner. PIN checks stay on the server.</div>}
    </section> : <section className="access-gate-card pin-gate-legacy" aria-labelledby="access-gate-title">
      <img className="pin-gate-app-icon" src="/stackpilot-icon-192.png" alt="StackPilot app icon" />
      <h1 id="access-gate-title">Welcome back</h1>
      <p>Enter your workspace passcode to continue.</p>
      <form onSubmit={onSubmit}>
        <label className="access-code-label" htmlFor="access-code">WORKSPACE PASSCODE</label>
        <input id="access-code" className="access-code-input" type="password" autoComplete="current-password" autoCapitalize="off" autoCorrect="off" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Enter your passcode" aria-label="Workspace passcode" aria-invalid={Boolean(error)} />
        {error && <div className="access-gate-error" role="alert"><AlertTriangle size={15} />{error}</div>}
        <button className="access-unlock-button" type="submit" disabled={busy}>{busy ? <><Loader2 size={17} className="spin" /> Checking passcode…</> : <>Open my workspace <ArrowRight size={17} /></>}</button>
      </form>
      <button className="pin-gate-forgot" type="button" onClick={() => setHelpOpen((open) => !open)} aria-expanded={helpOpen}>Need help?</button>
      {helpOpen && <div className="pin-gate-help-note" role="status">Contact the StackPilot workspace owner to reset access.</div>}
    </section>}
  </main>;
}

function StartPage({ input, setInput, filesCount, zipFilename, zipBusy, onAddFiles, attachedFiles = {}, onRemoveAttachment, onClearAttachments, sourceMode, setSourceMode, importingGithub, onImportGithub, repo, setRepo, branch, setBranch, name, setName, autoDeploy, setAutoDeploy, onStart, projects, monitors = [], onOpen, onNew, onDelete, search, setSearch, onSettings, onAbout, onOpenMonitors, health, connectorCount, notificationsReady, onEnableNotifications, onShowToast, onSample, onInstallHelp, onCopyMonitor }) {
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const promptRef = useRef(null);
  const attachedEntries = Object.entries(attachedFiles || {});
  const running = projects.filter((project) => ['queued', 'running', 'deploying'].includes(project.status));
  const handleFileChange = (event) => {
    onAddFiles(event.target.files);
    event.target.value = '';
    setAttachmentMenuOpen(false);
  };
  const addPrompt = (text) => {
    setInput(text);
    setSourceMode('code');
    window.setTimeout(() => promptRef.current?.focus(), 20);
  };
  const submit = (event) => {
    event.preventDefault();
    if (sourceMode === 'github') onImportGithub();
    else onStart();
  };

  return <div className="start-page ios-chat-home">
    <header className="chat-topbar">
      <button className="chat-brand-lockup" onClick={onNew} aria-label="StackPilot home"><img src="/stackpilot-icon.png" alt="" /><span>StackPilot<small>BUILD STUDIO</small></span></button>
      <div className="chat-top-actions">
        <span className={`chat-service-status ${health.ok ? 'is-online' : ''}`}><i />{health.ok ? 'Online' : 'Connecting'}</span>
        <button className="chat-icon-button" onClick={onAbout} aria-label="Project history" title="Project history"><History size={18} /></button>
        <button className="chat-icon-button" onClick={onOpenMonitors} aria-label="Monitors" title="Monitors"><Wifi size={18} /></button>
        <button className="chat-icon-button chat-settings-button" onClick={onSettings} aria-label={`Settings · ${connectorCount} connections`} title="Settings"><Settings2 size={18} /><span>{connectorCount}</span></button>
      </div>
    </header>

    <main className="chat-thread">
      <section className="chat-welcome-row">
        <div className="chat-assistant-avatar"><Sparkles size={20} /></div>
        <div className="chat-welcome-content">
          <div className="chat-assistant-label">STACKPILOT <span>BUILD ASSISTANT</span></div>
          <h1>What are we building today?</h1>
          <p>Share an idea, code, or a project. I’ll prepare the workspace and run real checks before anything is released.</p>
          <div className="chat-suggestion-row">
            <button className="chat-suggestion-chip" onClick={() => addPrompt('Build a polished, mobile-first landing page for my product. Include a clear value proposition, a primary call to action, and an accessible features section.')}><Sparkles size={13} /> Start from an idea</button>
            <button className="chat-suggestion-chip" onClick={() => { setSourceMode('github'); setAttachmentMenuOpen(false); }}><GitBranch size={13} /> Import a repository</button>
            <button className="chat-suggestion-chip" onClick={onSample}><FileCode2 size={13} /> Use sample code</button>
          </div>
        </div>
      </section>

      {running.length > 0 && <button className="chat-running-card" onClick={() => onOpen(running[0].id)}><span className="chat-running-icon"><Loader2 size={17} className="spin" /></span><span><strong>{running.length} build{running.length === 1 ? '' : 's'} in progress</strong><small>{running[0].name} · updates continue in the background</small></span><ArrowRight size={16} /></button>}

      <section className="chat-recent-section">
        <div className="chat-section-heading"><div><span className="chat-section-eyebrow">YOUR WORKSPACES</span><h2>Recent builds</h2></div><button className="chat-view-all" onClick={onAbout}>View all <ArrowRight size={14} /></button></div>
        {projects.length > 2 && <label className="chat-project-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" aria-label="Search projects" /></label>}
        {projects.length ? <div className="chat-project-list">{projects.slice(0, 6).map((project) => {
          const latest = project.logs?.at(-1)?.text || project.summary || `${Object.keys(project.files || {}).length} project files`;
          const monitor = monitors.find((item) => item.projectId === project.id);
          return <article className="chat-project-card" key={project.id}>
            <button className="chat-project-open" onClick={() => onOpen(project.id)}>
              <span className={`chat-project-icon ${project.status === 'live' ? 'is-live' : ''}`}>{project.status === 'live' ? <Rocket size={17} /> : <HardDrive size={17} />}</span>
              <span className="chat-project-copy"><strong>{project.name}</strong><small>{project.repo || latest}</small></span>
              <span className={`chat-project-status status-${project.status}`}>{statusLabel(project.status)}</span>
              <span className="chat-project-time">{timeAgo(project.updatedAt)}</span>
            </button>
            <div className="chat-project-details"><span className="chat-project-summary">{latest}</span>{monitor && <span className={`chat-monitor-indicator ${monitor.lastStatus === 'up' ? 'is-up' : ''}`}><i />{monitor.lastStatus === 'up' ? 'Monitor up' : 'Monitor'}</span>}<button className="chat-project-delete" onClick={() => onDelete(project.id)} aria-label={`Delete ${project.name}`} title="Delete project"><Trash2 size={14} /></button></div>
            {['queued', 'running', 'deploying'].includes(project.status) && <div className="chat-project-progress"><span style={{ width: `${Math.max(4, project.progress || 0)}%` }} /></div>}
          </article>;
        })}</div> : <div className="chat-empty-history"><span><MessageSquareText size={19} /></span><strong>Your build history will show up here</strong><small>Start with a prompt, attach source files, or import a GitHub repository.</small></div>}
      </section>
      <div className="chat-run-assurance"><ShieldCheck size={14} /><span>GitHub checks gate deployment</span><span className="chat-assurance-divider" /><Cloud size={14} /><span>Render Free</span><span className="chat-assurance-divider" /><span>{monitors.length} monitor{monitors.length === 1 ? '' : 's'}</span></div>
    </main>

    <form className="chat-composer-dock" onSubmit={submit}>
      {attachmentMenuOpen && <div className="chat-attachment-menu" role="menu" aria-label="Add to project">
        <label className="chat-attachment-option" role="menuitem"><span className="chat-menu-option-icon image-option"><ImageIcon size={17} /></span><span><strong>Add images or media</strong><small>Photos, video, audio and PDFs</small></span><input className="ios-hidden-file-input" type="file" accept="image/*,video/*,audio/*,.pdf,.heic,.heif,.mov,.m4a" multiple onChange={handleFileChange} /></label>
        <label className="chat-attachment-option" role="menuitem"><span className="chat-menu-option-icon file-option"><FileArchive size={17} /></span><span><strong>Add files or ZIP</strong><small>Project source, documents, or archives</small></span><input className="ios-hidden-file-input" type="file" accept=".zip,.js,.jsx,.ts,.tsx,.html,.css,.json,.md,.txt,.py,.yml,.yaml,.toml,.xml,.svg,.pdf,.png,.jpg,.jpeg,.gif,.webp,.avif,.heic,.heif,.mov,.mp4,.m4a,.mp3,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,application/zip,text/*,image/*,audio/*,video/*,application/pdf" multiple onChange={handleFileChange} /></label>
        <button type="button" className="chat-attachment-option" onClick={() => { setSourceMode('github'); setAttachmentMenuOpen(false); }}><span className="chat-menu-option-icon github-option"><Github size={17} /></span><span><strong>Import GitHub repository</strong><small>Bring in an existing branch</small></span></button>
        <button type="button" className="chat-attachment-option" onClick={() => { setSourceMode('code'); setDestinationOpen((value) => !value); setAttachmentMenuOpen(false); }}><span className="chat-menu-option-icon github-option"><GitBranch size={17} /></span><span><strong>{repo ? 'Edit GitHub destination' : 'Set GitHub destination'}</strong><small>Push a new build to a repository</small></span></button>
        <button type="button" className="chat-attachment-option" onClick={() => { setNameOpen((value) => !value); setAttachmentMenuOpen(false); }}><span className="chat-menu-option-icon file-option"><Folder size={17} /></span><span><strong>Name this project</strong><small>Optional workspace title</small></span></button>
        <div className="chat-menu-footer"><button type="button" onClick={() => { setAttachmentMenuOpen(false); onInstallHelp(); }}><Smartphone size={14} /> iPhone install help</button><button type="button" onClick={() => { setAttachmentMenuOpen(false); onCopyMonitor(); }}><Wifi size={14} /> Copy monitor URL</button><button type="button" onClick={() => { setAttachmentMenuOpen(false); onEnableNotifications(); }}><Bell size={14} /> {notificationsReady ? 'Notifications on' : 'Notifications'}</button></div>
      </div>}

      {(sourceMode === 'github' || destinationOpen || nameOpen) && <div className="chat-project-options">
        {sourceMode === 'github' && <div className="chat-source-panel"><div className="chat-source-heading"><Github size={16} /><strong>Import an existing repository</strong><button type="button" onClick={() => setSourceMode('code')} aria-label="Close GitHub import"><X size={15} /></button></div><label><span>Repository</span><input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/repo or GitHub URL" autoCapitalize="none" autoCorrect="off" spellCheck="false" /></label><label><span>Branch <small>optional</small></span><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Default branch" autoCapitalize="none" autoCorrect="off" /></label><p>Source files are imported for review. GitHub checks must pass before any optional Render deployment.</p></div>}
        {sourceMode !== 'github' && destinationOpen && <div className="chat-source-panel"><div className="chat-source-heading"><GitBranch size={16} /><strong>GitHub destination</strong><button type="button" onClick={() => setDestinationOpen(false)} aria-label="Close GitHub destination"><X size={15} /></button></div><label><span>Repository</span><input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/repo or new repo name" autoCapitalize="none" autoCorrect="off" spellCheck="false" /></label><small className="chat-inline-help">Leave empty to create a local project workspace first.</small></div>}
        {nameOpen && <div className="chat-source-panel chat-name-panel"><div className="chat-source-heading"><Folder size={16} /><strong>Project name</strong><button type="button" onClick={() => setNameOpen(false)} aria-label="Close project name"><X size={15} /></button></div><label><span>Workspace title</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional project name" autoComplete="off" /></label></div>}
      </div>}

      {attachedEntries.length > 0 && <div className="chat-attachment-tray"><div className="chat-attachment-tray-heading"><span>{zipBusy ? <Loader2 size={13} className="spin" /> : <Paperclip size={13} />}{zipBusy ? 'Adding files…' : `${attachedEntries.length} attached`}</span><button type="button" onClick={onClearAttachments}>Clear all</button></div><div className="chat-attachment-chips">{attachedEntries.slice(0, 8).map(([path, content]) => {
        const asset = parseBinaryAsset(content);
        const isImage = asset?.mime.startsWith('image/') && !['image/heic', 'image/heif'].includes(asset.mime);
        return <div className="chat-attachment-chip" key={path} title={path}>{isImage ? <img src={binaryAssetDataUri(content)} alt="" /> : <span className="chat-attachment-file-icon">{asset?.mime.startsWith('video/') ? <Monitor size={15} /> : asset?.mime.startsWith('audio/') ? <Radio size={15} /> : asset?.mime.startsWith('image/') ? <ImageIcon size={15} /> : <File size={15} />}</span>}<span>{path.split('/').at(-1)}</span><button type="button" onClick={() => onRemoveAttachment?.(path)} aria-label={`Remove ${path}`}><X size={12} /></button></div>;
      })}{attachedEntries.length > 8 && <span className="chat-attachment-more">+{attachedEntries.length - 8} more</span>}</div></div>}

      <div className="chat-composer-card">
        <label className="chat-composer-label" htmlFor="stackpilot-prompt">{sourceMode === 'github' ? 'Optional build instructions' : 'Message StackPilot'}</label>
        <textarea id="stackpilot-prompt" ref={promptRef} value={input} onChange={(event) => { const value = event.target.value; if (value.length > MAX_RAW_INPUT_CHARS) { onShowToast(`Paste limit is ${MAX_RAW_INPUT_CHARS.toLocaleString()} characters. The previous text was kept unchanged; attach a ZIP or GitHub repository for larger source.`, 'error'); return; } setInput(value); }} placeholder={sourceMode === 'github' ? 'Add a note for this repository, if you like…' : 'Describe your idea, paste code, or add a brief…'} rows={2} />
        <div className="chat-composer-toolbar"><div className="chat-composer-left-tools"><button type="button" className={`chat-attach-button ${attachmentMenuOpen ? 'is-active' : ''}`} onClick={() => setAttachmentMenuOpen((open) => !open)} aria-label="Add images, files, or a repository" aria-expanded={attachmentMenuOpen}><Paperclip size={18} /></button><button type="button" className="chat-add-label" onClick={() => setAttachmentMenuOpen((open) => !open)}>{zipBusy ? 'Adding…' : 'Add files'}</button>{filesCount > 0 && <span className="chat-attachment-count">{filesCount} files</span>}</div><div className="chat-composer-right-tools"><label className="chat-auto-deploy" title="Deploy only after GitHub checks pass"><input type="checkbox" checked={autoDeploy} onChange={(event) => setAutoDeploy(event.target.checked)} /><span className="chat-auto-switch" /><span>Checks → deploy</span></label><button type="submit" className="chat-send-button" disabled={zipBusy || (sourceMode === 'github' ? (!repo.trim() || importingGithub) : (!input.trim() && !filesCount))} aria-label={sourceMode === 'github' ? 'Import GitHub repository' : 'Create project workspace'}>{importingGithub ? <Loader2 size={18} className="spin" /> : sourceMode === 'github' ? <GitBranch size={18} /> : <ArrowUp size={20} />}</button></div></div>
      </div>
      <div className="chat-composer-footnote"><LockKeyhole size={12} /><span>Credentials stay separate from source files.</span><span className="chat-footnote-divider" /><span>{zipFilename || 'Images are stored with the project; free-model organization reads text, not image pixels.'}</span></div>
    </form>
  </div>;
}

function ProjectCard({ project, monitor, onOpen, onDelete }) {
  const uptimeLabel = monitor?.status === 'up' ? 'Up' : monitor?.status === 'down' ? 'Down' : monitor ? 'Waiting' : project.renderUrl ? 'Not checked' : 'No URL';
  const renderLabel = project.renderUrl ? `Render · ${project.status === 'live' ? 'Live' : statusLabel(project.status)}` : project.renderServiceId ? 'Render service linked' : 'Render not connected';
  return <article className="recent-card">
    <button className="recent-card-open" onClick={onOpen}>
      <div className="recent-card-top"><span className="recent-card-icon"><Code2 size={20} /></span><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span></div>
      <strong>{project.name}</strong><span className="recent-card-repo">{project.repo || project.stack || 'Workspace draft'}</span>
      {['running', 'queued', 'deploying'].includes(project.status) && <div className="mini-progress"><span style={{ width: `${calculateProgress(project.steps, project.status, project.progress)}%` }} /></div>}
      <div className="project-card-health"><span className={`project-health-chip ${monitor?.status || 'unknown'}`}><Wifi size={14} />{uptimeLabel}{monitor?.checks?.at(-1)?.durationMs ? ` · ${monitor.checks.at(-1).durationMs} ms` : ''}</span><span className={`project-render-chip ${project.renderUrl ? 'connected' : ''}`}><Cloud size={14} />{renderLabel}</span></div>
      <div className="recent-card-bottom"><span><Activity size={14} /> Updated {timeAgo(project.updatedAt)}</span><ArrowUpRight size={16} /></div>
    </button>
    <button className="recent-card-delete" onClick={onDelete} aria-label={`Remove ${project.name}`} title="Remove from this device"><Trash2 size={15} /></button>
  </article>;
}

function ProjectWorkspace({ project, credentials, envConfigured, projectVault, projectCredentialStatus, onVaultChange, onLoadProjectCredentialStatus, onSaveProjectCredentials, onClearProjectCredentials, envRows, onEnvChange, onAddEnv, onRemoveEnv, tab, setTab, onHome, allProjects = [], onOpenProject, monitors = [], onAddMonitor, onPingMonitor, onRemoveMonitor, onMonitorInterval, onSettings, onNameChange, onRepoChange, onProjectChange, onRun, onToggleAutoDeploy, busy, onDelete, onEditorChange, editorDraft, editorDirty, onSaveEditor, onSelectFile, onAddFile, onAbout, onOpenMonitors, onShowToast, onRefreshEnv, shellCommand, setShellCommand, shellBusy, onRunShell }) {
  const progress = calculateProgress(project.steps, project.status, project.progress);
  const isWorking = ['queued', 'running', 'deploying'].includes(project.status);
  const canDeploy = Boolean(project.renderUrl || project.renderServiceId || credentials.renderToken || envConfigured.render);
  const projectMonitors = monitors.filter((item) => item.projectId === project.id || item.id === `project_${project.id}`);
  const primaryMonitor = projectMonitors[0] || null;
  const sideProjects = allProjects.filter((item) => item.id !== project.id).slice(0, 5);
  const tabs = [{ id: 'build', label: 'Build', icon: Sparkles }, { id: 'files', label: 'Files', icon: Folder }, { id: 'deploy', label: 'Deploy & Render', icon: Cloud }, { id: 'uptime', label: 'Uptime', icon: Wifi }];
  const deployButtonText = isWorking ? 'Working…' : project.status === 'verified' && !project.autoDeploy ? 'Deploy verified build' : project.status === 'live' ? 'Build & deploy again' : 'Run tests & release';
  const runClick = () => onRun(project.status === 'verified' && !project.autoDeploy);

  return <div className="workspace-page">
    <header className="workspace-header">
      <button className="workspace-brand" onClick={onHome}><img src="/stackpilot-icon.png" alt="" /><span>stackpilot</span></button>
      <div className="workspace-breadcrumb"><button onClick={onHome}>Projects</button><ChevronRight size={13} /><span>{project.name}</span></div>
      <div className="workspace-header-actions"><button className="header-link" onClick={onOpenMonitors}><Wifi size={15} /><span>Monitors</span></button><button className="header-link" onClick={onAbout}><Activity size={15} /><span>My work</span></button><button className="header-settings" onClick={onSettings} aria-label="Settings"><Settings2 size={17} /></button></div>
    </header>

    <main className="workspace-main">
      <section className="project-heading">
        <div className="project-heading-copy"><div className="project-heading-kicker"><span className="online-ring" /> PROJECT WORKSPACE <span className="heading-slash">/</span> {project.slug}</div><div className="project-title-line"><input aria-label="Project name" value={project.name} onChange={(event) => onNameChange(event.target.value)} /><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span></div><p>{project.summary || 'The project architect, safety guard, build runner, and Render operator are ready when you are.'}</p></div>
        <div className="project-heading-actions"><button className="soft-button" onClick={onHome}><ArrowLeft size={15} /><span>All projects</span></button><button className="icon-only workspace-delete" onClick={onDelete} aria-label="Delete project" title="Delete this project"><Trash2 size={15} /></button><button className="primary-button" onClick={runClick} disabled={busy || (!project.files || !Object.keys(project.files).length) && !project.rawInput?.trim()}>{busy ? <Loader2 size={16} className="spin" /> : <Rocket size={16} />}<span>{deployButtonText}</span></button></div>
      </section>

      <div className="workspace-shell">
        <nav className="workspace-tabs" aria-label="Project workspace tabs">
          <div className="workspace-tabs-heading"><span>PROJECT MENU</span><button onClick={onHome}><ArrowLeft size={14} /> All projects <em>{allProjects.length}</em></button></div>
          <div className="workspace-tab-links">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'selected' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={18} /><span>{label}</span>{id === 'files' && <em>{Object.keys(project.files || {}).length}</em>}{id === 'uptime' && <i className={`sidebar-tab-indicator ${primaryMonitor?.status || 'unknown'}`} />}</button>)}</div>
          <div className="workspace-sidebar-health"><span className="sidebar-section-label">PROJECT STATUS</span><div className="sidebar-health-row"><span className={`monitor-status-light ${project.renderUrl && project.status === 'live' ? 'up' : project.status === 'failed' ? 'down' : 'unknown'}`} /><span><small>RENDER</small><strong>{project.renderUrl ? statusLabel(project.status) : project.renderServiceId ? 'Service linked' : 'Not connected'}</strong></span></div><div className="sidebar-health-row"><span className={`monitor-status-light ${primaryMonitor?.status || 'unknown'}`} /><span><small>UPTIME</small><strong>{primaryMonitor ? primaryMonitor.status === 'up' ? 'Responding' : primaryMonitor.status === 'down' ? 'Needs attention' : 'Waiting for check' : 'No URL monitored'}</strong></span></div><button className="sidebar-monitor-link" onClick={onOpenMonitors}><Activity size={14} /> All monitors <ArrowUpRight size={13} /></button></div>
          {sideProjects.length > 0 && <div className="workspace-sidebar-projects"><span className="sidebar-section-label">RECENT PROJECTS</span>{sideProjects.map((item) => <button key={item.id} onClick={() => onOpenProject?.(item.id)}><span className={`project-dot project-${item.status}`} /><span>{item.name}</span></button>)}<button className="sidebar-all-projects" onClick={onHome}>Browse all projects <ArrowRight size={13} /></button></div>}
          <button className="tab-settings" onClick={onSettings}><Settings2 size={17} /><span>Connections & settings</span></button>
        </nav>
        <div className="workspace-tab-content">
          {isWorking && <ProgressPanel project={project} progress={progress} />}

      {tab === 'build' && <div className="build-layout">
        <section className="build-primary-column">
          <div className="workspace-card code-input-card">
            <div className="card-header"><div className="card-title-icon violet"><Sparkles size={16} /></div><div><strong>Code & direction</strong><span>Paste, revise, or add a specific request for the agents.</span></div><span className="character-count">{(project.rawInput || '').length.toLocaleString()} / {MAX_RAW_INPUT_CHARS.toLocaleString()} chars</span></div>
            <textarea className="workspace-dump" value={project.rawInput || ''} onChange={(event) => { const value = event.target.value; if (value.length > MAX_RAW_INPUT_CHARS) { onShowToast(`Paste limit is ${MAX_RAW_INPUT_CHARS.toLocaleString()} characters. Existing project text was kept unchanged; split larger input into files.`, 'error'); return; } onProjectChange({ rawInput: value }); }} placeholder="Paste your code dump or describe the project…" aria-label="Project code and instructions" />
            <div className="dump-footer"><span><LockKeyhole size={12} /> Credentials are never added to the commit</span><button className="small-action" onClick={() => onShowToast('Paste updates from your starter brief; the file editor stays in the Files tab.', 'info')}>How it works <CircleHelp size={13} /></button></div>
          </div>

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
        <section className="workspace-card editor-card"><div className="editor-card-header"><div className="file-name-label"><FileCode2 size={15} /><span>{project.activeFile || 'Choose a file'}</span><em>{project.activeFile ? fileLanguage(project.activeFile) : '—'}</em></div><div className="editor-card-actions">{editorDirty && <span className="unsaved-chip">Unsaved</span>}<button className="small-action" disabled={!editorDraft} onClick={() => navigator.clipboard?.writeText(editorDraft).then(() => onShowToast('File copied.')).catch(() => onShowToast('Copy is unavailable in this browser.', 'error'))}><Copy size={13} /> Copy</button><button className="save-editor-button" disabled={!editorDirty} onClick={onSaveEditor}><Save size={13} /> Save</button></div></div>{project.activeFile ? isBinaryAsset(project.files?.[project.activeFile]) ? <BinaryAssetPreview path={project.activeFile} content={project.files[project.activeFile]} /> : <div className="code-editor-wrap"><div className="line-gutter">{Array.from({ length: Math.max(1, editorDraft.split('\n').length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea spellCheck="false" className="code-editor" value={editorDraft} onChange={(event) => onEditorChange(event.target.value)} aria-label={`Edit ${project.activeFile}`} /></div> : <div className="editor-empty"><div><Code2 size={24} /></div><strong>Select a file</strong><span>Your editor is ready for quick changes on desktop or iPhone.</span></div>}<div className="editor-bottom"><span>UTF-8 <i /> {project.activeFile ? isBinaryAsset(project.files?.[project.activeFile]) ? `${binaryAssetByteLength(project.files[project.activeFile]).toLocaleString()} bytes` : `${editorDraft.split('\n').length} lines` : 'No file selected'}</span><span>Mobile-friendly editor · binary assets preserved</span></div></section>
      </div>}

      {tab === 'deploy' && <div className="preview-layout">
        <section className="workspace-card live-preview-card"><div className="card-header"><div className="card-title-icon green"><Eye size={16} /></div><div><strong>Live browser preview</strong><span>{project.renderUrl ? 'The deployed Render site, embedded here.' : 'A real preview appears as soon as Render finishes a successful deploy.'}</span></div>{project.renderUrl && <a className="small-action" href={project.renderUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open tab</a>}</div>{project.renderUrl ? <div className="embedded-browser"><div className="browser-chrome"><span /><span /><span /><div className="browser-address"><LockKeyhole size={10} />{project.renderUrl.replace(/^https?:\/\//, '')}</div><button onClick={() => window.open(project.renderUrl, '_blank', 'noopener,noreferrer')} aria-label="Open preview in a new tab"><ArrowUpRight size={13} /></button></div><iframe title={`Live preview of ${project.name}`} src={project.renderUrl} loading="lazy" referrerPolicy="no-referrer" /></div> : <div className="preview-empty"><div className="preview-orb"><Globe size={22} /></div><strong>{project.status === 'verified' ? 'Checks passed. Ready for Render.' : 'Your live preview will appear here.'}</strong><span>{project.status === 'verified' ? 'Turn on auto-deploy or use “Deploy verified build”.' : 'The Render operator only starts after GitHub tests and build succeed.'}</span>{project.status === 'verified' && <button className="primary-button" onClick={runClick} disabled={busy}><Rocket size={15} /> Deploy verified build</button>}</div>}</section>
        <ProjectCredentialsCard projectId={project.id} vault={projectVault} status={projectCredentialStatus || {}} onChange={onVaultChange} onLoadStatus={onLoadProjectCredentialStatus} onSave={onSaveProjectCredentials} onClear={onClearProjectCredentials} onSettings={onSettings} />
        <EnvironmentCard rows={envRows} onChange={onEnvChange} onAdd={onAddEnv} onRemove={onRemoveEnv} onRefresh={onRefreshEnv} serviceId={project.renderServiceId} envConfigured={envConfigured} credentials={credentials} />
        <div className="preview-bottom-grid"><ReleaseSettings project={project} onRepoChange={onRepoChange} onToggleAutoDeploy={onToggleAutoDeploy} onProjectChange={onProjectChange} onSettings={onSettings} /><RenderStatusCard project={project} onSettings={onSettings} /></div>
      </div>}

      {tab === 'uptime' && <ProjectUptimeTab project={project} monitors={projectMonitors} onAdd={onAddMonitor} onPing={onPingMonitor} onRemove={onRemoveMonitor} onInterval={onMonitorInterval} onOpenDeploy={() => setTab('deploy')} onOpenMonitors={onOpenMonitors} />}
        </div>
      </div>
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
  return <section className="activity-card"><div className="activity-header"><div><div className="activity-live-dot" /><strong>Live activity</strong><span>{['queued', 'running', 'deploying'].includes(project.status) ? 'STREAMING' : 'RUN HISTORY'}</span></div><div className="activity-actions"><button className="small-action" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Collapse' : 'Expand'}</button><button className="icon-only" onClick={onClear} title="Clear local activity"><Trash2 size={14} /></button></div></div>{expanded && <div className="activity-log">{logs.length ? logs.map((line, index) => <div className={`activity-line level-${line.level || 'info'}`} key={`${line.jobLogId || line.time}_${index}`}><span className="activity-time">{timeLabel(line.time)}</span><span className="activity-source">{line.source || 'StackPilot'}</span><span className="activity-text">{line.text}</span></div>) : <div className="activity-placeholder"><span>$</span>Activity from OpenRouter, GitHub Actions, and Render will show up here.</div>}</div>}{expanded && <div className="activity-footer"><span><Radio size={12} /> Server-side run tracking</span><span>Refreshes every 2.2 seconds while open</span></div>}</section>;
}

function ReleaseSummary({ project, canDeploy, autoDeploy, onToggleAutoDeploy, onRun, busy, onSettings }) {
  const finished = ['live', 'verified'].includes(project.status);
  return <section className="release-summary workspace-card"><div className="release-summary-head"><div className="card-title-icon green"><Rocket size={15} /></div><div><strong>Release gate</strong><span>Render waits for GitHub success</span></div><span className="free-chip"><i /> FREE</span></div><div className="release-repo-line"><Github size={14} /><span>{project.repo || 'Add owner/repo in release settings'}</span></div><label className="release-auto-toggle"><input type="checkbox" checked={autoDeploy} onChange={(event) => onToggleAutoDeploy(event.target.checked)} /><span className="toggle-ui small-toggle" /><span><strong>Auto-deploy</strong><small>{autoDeploy ? 'Publish after checks pass' : 'Review, then deploy manually'}</small></span></label>{project.status === 'verified' && !autoDeploy && <button className="primary-button side-deploy-button" onClick={onRun} disabled={busy}><Rocket size={14} /> Deploy verified build</button>}{project.renderUrl && <a className="release-live-link" href={project.renderUrl} target="_blank" rel="noreferrer"><Globe size={14} /><span>{project.renderUrl.replace(/^https?:\/\//, '')}</span><ArrowUpRight size={13} /></a>}{!canDeploy && <div className="release-needs-key"><KeyRound size={13} /> Add a Render key for this project or set the workspace fallback in Settings.</div>}<button className="release-settings-link" onClick={onSettings}><Settings2 size={13} /> Configure Render & connections</button>{finished && project.lastCommitUrl && <a className="commit-link" href={project.lastCommitUrl} target="_blank" rel="noreferrer"><CheckCircle2 size={13} /> View verified GitHub commit <ExternalLink size={12} /></a>}</section>;
}

function ReleaseSettings({ project, onRepoChange, onToggleAutoDeploy, onProjectChange, onSettings }) {
  return <section className="workspace-card release-settings-card"><div className="card-header"><div className="card-title-icon violet"><Settings2 size={16} /></div><div><strong>Release settings</strong><span>Choose where the verified source goes.</span></div><span className="free-chip"><i /> RENDER FREE</span></div>
    <label className="settings-field-inline"><span>GitHub repository</span><div className="start-repo-input"><Github size={15} /><input value={project.repo || ''} onChange={(event) => onRepoChange(event.target.value)} placeholder="owner/repo" autoCapitalize="none" autoCorrect="off" /></div></label>
    <label className="settings-field-inline"><span>Existing Render service ID <small>optional · leave blank to create one</small></span><input value={project.renderServiceId || ''} onChange={(event) => onProjectChange({ renderServiceId: event.target.value.trim() })} placeholder="srv-…" /></label>
    {project.renderServiceId && <div className="existing-service-gate-note"><ShieldCheck size={13} /> Before pushing, StackPilot turns off this service's direct GitHub auto-deploy. It will only queue a Render deploy after checks pass and Auto-deploy is enabled.</div>}
    <div className="settings-two-column"><label className="settings-field-inline"><span>Branch</span><input value={project.branch || 'main'} onChange={(event) => onProjectChange({ branch: event.target.value })} /></label><label className="settings-field-inline"><span>Service type</span><select value={project.serviceType || 'web_service'} onChange={(event) => onProjectChange({ serviceType: event.target.value })}><option value="web_service">Web service</option><option value="static_site">Static site</option></select></label></div>
    <div className="settings-two-column"><label className="settings-field-inline"><span>Runtime</span><select value={project.runtime || 'node'} onChange={(event) => onProjectChange({ runtime: event.target.value })}><option value="node">Node.js</option><option value="python">Python</option><option value="ruby">Ruby</option><option value="go">Go</option><option value="elixir">Elixir</option></select></label><label className="settings-field-inline"><span>Region</span><select value={project.region || 'frankfurt'} onChange={(event) => onProjectChange({ region: event.target.value })}><option value="frankfurt">Frankfurt</option><option value="singapore">Singapore</option><option value="oregon">Oregon</option><option value="ohio">Ohio</option><option value="virginia">Virginia</option></select></label></div>
    <label className="settings-field-inline"><span>Build command</span><input value={project.buildCommand || ''} onChange={(event) => onProjectChange({ buildCommand: event.target.value })} placeholder="npm install && npm run build" /></label>
    {project.serviceType !== 'static_site' ? <div className="settings-two-column"><label className="settings-field-inline"><span>Start command</span><input value={project.startCommand || ''} onChange={(event) => onProjectChange({ startCommand: event.target.value })} placeholder="npm start" /></label><label className="settings-field-inline"><span>Root directory</span><input value={project.rootDir || ''} onChange={(event) => onProjectChange({ rootDir: event.target.value })} placeholder="(repository root)" /></label></div> : <label className="settings-field-inline"><span>Publish directory</span><input value={project.publishPath || 'dist'} onChange={(event) => onProjectChange({ publishPath: event.target.value })} placeholder="dist" /></label>}
    <div className="release-settings-footer"><label className="release-auto-toggle"><input type="checkbox" checked={project.autoDeploy !== false} onChange={(event) => onToggleAutoDeploy(event.target.checked)} /><span className="toggle-ui small-toggle" /><span><strong>Deploy automatically after GitHub checks</strong><small>Render is never triggered before the current commit passes.</small></span></label><button className="small-action" onClick={onSettings}><KeyRound size={13} /> Keys</button></div>
  </section>;
}

function ProjectCredentialsCard({ projectId, vault, status, onChange, onLoadStatus, onSave, onClear, onSettings }) {
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setLoadingStatus(true);
    Promise.resolve(onLoadStatus?.()).catch((loadError) => {
      if (!cancelled) setError(loadError.message || 'Could not load saved key status.');
    }).finally(() => { if (!cancelled) setLoadingStatus(false); });
    return () => { cancelled = true; };
  }, [projectId]);
  const fields = [
    ['githubToken', 'GitHub token override', 'Use workspace default'],
    ['renderToken', 'Render API key override', 'Use workspace default'],
    ['openRouterKey1', 'OpenRouter key 1', 'Use workspace default'],
    ['openRouterKey2', 'OpenRouter key 2', 'Optional fallback key'],
  ];
  const savedCount = Object.values(status || {}).filter(Boolean).length;
  const save = async () => {
    const values = Object.fromEntries(fields.map(([key]) => [key, String(vault?.[key] || '').trim()]).filter(([, value]) => value));
    if (!Object.keys(values).length && !String(vault?.renderOwnerId || '').trim()) { setError('Enter at least one project key or owner ID first.'); return; }
    if (String(vault?.renderOwnerId || '').trim()) values.renderOwnerId = String(vault.renderOwnerId).trim();
    setSaving(true); setError(''); setMessage('');
    try {
      await onSave(values);
      Object.keys(values).forEach((key) => onChange(key, ''));
      setMessage('Saved on the StackPilot Render service.');
    } catch (saveError) { setError(saveError.message || 'Could not save project keys.'); }
    finally { setSaving(false); }
  };
  const clear = async () => {
    if (!savedCount || !window.confirm(`Clear all ${savedCount} saved platform key${savedCount === 1 ? '' : 's'} for this project from StackPilot Render?`)) return;
    setClearing(true); setError(''); setMessage('');
    try { await onClear(); setMessage('Saved project keys cleared.'); }
    catch (clearError) { setError(clearError.message || 'Could not clear saved project keys.'); }
    finally { setClearing(false); }
  };
  return <section className="workspace-card project-credentials-card">
    <div className="card-header"><div className="card-title-icon blue"><KeyRound size={16} /></div><div><strong>Project platform keys</strong><span>Overrides for this project only. Save them server-side or use workspace defaults.</span></div><span className={`settings-state ${savedCount ? 'ready' : ''}`}>{loadingStatus ? 'CHECKING' : `${savedCount} SAVED`}</span></div>
    <div className="project-credential-grid">{fields.map(([key, label, emptyHint]) => <label className="settings-field-inline" key={key}><span>{label}{status?.[key] && <small className="credential-saved-label"> · SAVED</small>}</span><input type="password" autoComplete="new-password" value={vault?.[key] || ''} onChange={(event) => onChange(key, event.target.value)} placeholder={status?.[key] ? 'Saved on StackPilot Render' : emptyHint} /></label>)}<label className="settings-field-inline"><span>Render owner / workspace ID{status?.renderOwnerId && <small className="credential-saved-label"> · SAVED</small>}</span><input autoCapitalize="none" autoCorrect="off" value={vault?.renderOwnerId || ''} onChange={(event) => onChange('renderOwnerId', event.target.value)} placeholder={status?.renderOwnerId ? 'Saved on StackPilot Render' : 'Use workspace default'} /></label></div>
    {(error || message) && <div className={`project-credentials-message ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || message}</div>}
    <div className="project-credentials-actions"><button className="primary-button" onClick={save} disabled={saving || clearing || loadingStatus}>{saving ? <Loader2 size={14} className="spin" /> : <LockKeyhole size={14} />} Save filled keys to Render</button>{savedCount > 0 && <button className="soft-button" onClick={clear} disabled={saving || clearing}>{clearing ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} Clear saved keys</button>}<button className="small-action" onClick={onSettings}>Workspace keys <Settings2 size={13} /></button></div>
    <div className="env-note"><ShieldCheck size={13} /> Saved keys live in the StackPilot service’s Render environment—not the deployed project—and Render stores them as secrets. Saving queues a service restart. Unsaved values exist in page memory only and clear on refresh.</div>
  </section>;
}

function EnvironmentCard({ rows, onChange, onAdd, onRemove, onRefresh, serviceId, envConfigured, credentials }) {
  const [visible, setVisible] = useState(false);
  const populated = rows.filter((row) => row.key && row.value).length;
  return <section className="workspace-card env-card"><div className="card-header"><div className="card-title-icon amber"><KeyRound size={16} /></div><div><strong>Project environment</strong><span>Detected from source. Values stay in memory until sent to this project’s Render service.</span></div><button className="small-action" onClick={() => setVisible((value) => !value)}>{visible ? 'Hide values' : 'Show values'}</button></div>
    {!rows.length ? <div className="env-empty"><span><Sparkles size={15} /></span><div><strong>No environment keys detected</strong><small>Add keys your deployed app needs. They are never committed to GitHub.</small></div></div> : <div className="env-table">{rows.map((row, index) => <div className="env-row" key={`${row.key}_${index}`}><input className="env-key-input" value={row.key} onChange={(event) => onChange(index, 'key', event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} placeholder="API_KEY" aria-label="Environment variable name" /><input className="env-value-input" type={visible ? 'text' : 'password'} value={row.value || ''} onChange={(event) => onChange(index, 'value', event.target.value)} placeholder="Add secret value" aria-label={`Value for ${row.key || 'environment variable'}`} /><button className="icon-only danger-icon" onClick={() => onRemove(index)} aria-label={`Remove ${row.key || 'environment variable'}`}><X size={14} /></button></div>)}</div>}
    <div className="env-footer"><button className="small-action" onClick={onAdd}><Plus size={13} /> Add variable</button><span>{serviceId ? `Render service linked · ${populated} value${populated === 1 ? '' : 's'} ready` : 'Values are sent only when the Render service is created.'}</span><button className="small-action" onClick={onRefresh}><RefreshIcon /> Scan source</button></div>
    <div className="env-note"><ShieldCheck size={13} /> Platform keys: GitHub {envConfigured.github ? 'from server environment' : credentials.githubToken ? 'connected for this session' : 'not connected'} · Render {envConfigured.render ? 'from server environment' : credentials.renderToken ? 'connected for this session' : 'not connected'}</div>
  </section>;
}

function RefreshIcon() { return <Activity size={13} />; }

function BinaryAssetPreview({ path, content }) {
  const asset = parseBinaryAsset(content);
  if (!asset) return <div className="binary-asset-preview"><AlertTriangle size={18} /><span>Binary asset encoding could not be read.</span></div>;
  const data = binaryAssetDataUri(content);
  const size = binaryAssetByteLength(content);
  const needsImageFallback = ['image/heic', 'image/heif'].includes(asset.mime);
  return <div className="binary-asset-preview">{asset.mime.startsWith('image/') && !needsImageFallback ? <img src={data} alt={path} /> : asset.mime.startsWith('audio/') ? <audio controls src={data} /> : asset.mime.startsWith('video/') ? <video controls src={data} /> : <div className="binary-asset-placeholder">{asset.mime.startsWith('image/') ? <ImageIcon size={24} /> : <FileArchive size={24} />}<strong>{asset.mime}</strong><span>{needsImageFallback ? 'This HEIC/HEIF photo is preserved; this browser may not support an inline preview.' : 'Binary source asset preserved for GitHub and deployment.'}</span></div>}<div className="binary-asset-meta"><span>{size.toLocaleString()} bytes · included in release</span><a href={data} download={path.split('/').at(-1)} className="small-action"><Download size={13} /> Download copy</a></div></div>;
}

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
  return <section className="workspace-card render-status-card"><div className="card-header"><div className="card-title-icon green"><Cloud size={16} /></div><div><strong>Render status</strong><span>Configured from your release settings.</span></div></div><div className="render-status-line"><span className={`status-light ${project.status === 'live' ? 'light-green' : project.status === 'deploying' ? 'light-violet' : ''}`} /><strong>{project.status === 'live' ? 'Live' : project.status === 'deploying' ? 'Building' : project.status === 'verified' ? 'Waiting for deploy' : 'Not deployed yet'}</strong></div>{project.renderServiceId && <div className="service-id-line">Service <code>{project.renderServiceId}</code></div>}{project.renderDashboardUrl && <a className="small-action" href={project.renderDashboardUrl} target="_blank" rel="noreferrer"><Cloud size={13} /> Open Render dashboard <ExternalLink size={12} /></a>}<button className="small-action" onClick={onSettings}><KeyRound size={13} /> Workspace Render key</button></section>;
}

function AboutPage({ projects, onBack, expiry, daysLeft, health, onSettings, onOpenMonitors, onOpen }) {
  const [projectFilter, setProjectFilter] = useState('all');
  const live = projects.filter((project) => project.status === 'live').length;
  const working = projects.filter((project) => ['queued', 'running', 'deploying'].includes(project.status)).length;
  const commits = projects.filter((project) => project.lastCommit).length;
  const liveProjects = projects.filter((project) => project.status === 'live' || project.renderUrl);
  const draftProjects = projects.filter((project) => ['draft', 'ready'].includes(project.status));
  const filters = [
    { id: 'all', label: 'All projects', count: projects.length },
    { id: 'recent', label: 'Recent', count: Math.min(projects.length, 6) },
    { id: 'live', label: 'Live', count: liveProjects.length },
    { id: 'drafts', label: 'Drafts', count: draftProjects.length },
  ];
  const visibleProjects = projectFilter === 'recent' ? projects.slice(0, 6) : projectFilter === 'live' ? liveProjects : projectFilter === 'drafts' ? draftProjects : projects;
  const exactExpiry = expiry ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${expiry}T12:00:00Z`)) : '';
  const expiryText = expiry ? `${exactExpiry} · ${daysLeft < 0 ? `expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago` : daysLeft === 0 ? 'expires today' : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}` : 'Add a reminder date in Settings';
  return <div className="about-page">
    <header className="workspace-header"><button className="workspace-brand" onClick={onBack}><img src="/stackpilot-icon.png" alt="" /><span>stackpilot</span></button><div className="workspace-breadcrumb"><button onClick={onBack}>Workspace</button><ChevronRight size={13} /><span>My work</span></div><div className="workspace-header-actions"><button className="header-link" onClick={onOpenMonitors}><Wifi size={15} /><span>Monitors</span></button><button className="header-settings" onClick={onSettings}><Settings2 size={17} /></button></div></header>
    <main className="about-main">
      <button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back</button>
      <div className="about-heading"><span className="section-eyebrow">ABOUT YOUR WORKSPACE</span><h1>Built to make progress visible.</h1><p>StackPilot turns a code dump into a reviewed GitHub commit, a real hosted build, and a live Render link.</p></div>
      <div className="about-stat-grid"><div><strong>{projects.length}</strong><span>projects saved</span></div><div><strong>{live}</strong><span>live on Render</span></div><div><strong>{commits}</strong><span>GitHub commits</span></div><div><strong>{working}</strong><span>runs in progress</span></div></div>
      <div className="about-detail-grid">
        <section className="workspace-card about-card"><div className="card-title-icon violet"><Github size={16} /></div><div><strong>GitHub token reminder</strong><span>GitHub does not reveal a PAT&apos;s expiry date through this integration. Add the date you chose when creating it; StackPilot will remind you at 7, 3, 1, and 0 days when notifications are enabled.</span></div><div className={`expiry-status ${daysLeft !== null && daysLeft <= 7 ? 'expiry-warning' : ''}`}><CalendarDays size={15} />{expiryText}</div><button className="soft-button" onClick={onSettings}>Manage token & reminder <ArrowRight size={14} /></button></section>
        <section className="workspace-card about-card"><div className="card-title-icon green"><Radio size={16} /></div><div><strong>Health endpoint</strong><span>Use this public URL for an external HTTP(S) monitor. No UptimeRobot account is connected here.</span></div><div className="monitor-url"><code>{typeof window !== 'undefined' ? `${window.location.origin}/health` : '/health'}</code><button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/health`)} aria-label="Copy health endpoint"><Copy size={13} /></button></div><div className="health-fact">{health?.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{health?.ok ? 'StackPilot health is reachable. Monitor /health in an external service.' : 'The health endpoint could not be reached just now.'}</div></section>
      </div>
      <section className="about-projects">
        <div className="recent-heading"><div><span className="section-eyebrow">PROJECT HISTORY</span><h2>Your work</h2></div><button className="soft-button" onClick={onSettings}>Settings <Settings2 size={14} /></button></div>
        <div className="history-filter-tabs" role="tablist" aria-label="Filter project history">{filters.map((filter) => <button key={filter.id} type="button" role="tab" aria-selected={projectFilter === filter.id} className={projectFilter === filter.id ? 'selected' : ''} onClick={() => setProjectFilter(filter.id)}>{filter.label}<span>{filter.count}</span></button>)}</div>
        {projects.length ? visibleProjects.length ? <div className="recent-grid">{visibleProjects.map((project) => <button className="about-project-row" key={project.id} onClick={() => onOpen(project.id)}><span className={`project-dot project-${project.status}`} /><span><strong>{project.name}</strong><small>{project.repo || 'Draft on this device'} · {timeAgo(project.updatedAt)}</small></span><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span><ArrowRight size={14} /></button>)}</div> : <div className="recent-empty"><strong>No projects in this view</strong><span>Choose another history filter.</span></div> : <div className="recent-empty"><strong>No projects yet</strong><span>Your first build will appear here.</span></div>}
      </section>
      <p className="about-caveat">Drafts are stored on this device. Unsaved platform keys exist only in page memory; saved platform keys and runtime secrets live in Render environment variables. GitHub is the durable source copy. Keep a separate backup of production credentials.</p>
    </main>
  </div>;
}

function durationText(start) {
  if (!start) return '—';
  const ms = Math.max(0, Date.now() - new Date(start).getTime());
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function monitorStateDuration(monitor) {
  const checks = monitor.checks || [];
  if (!checks.length) return 'Waiting for first check';
  const current = checks.at(-1).ok;
  let index = checks.length - 1;
  while (index >= 0 && checks[index].ok === current) index -= 1;
  const since = checks[index + 1]?.checkedAt || monitor.addedAt;
  return `${current ? 'Up for ' : 'Down for '}${durationText(since)}`;
}

function ProjectUptimeTab({ project, monitors, onAdd, onPing, onRemove, onInterval, onOpenDeploy, onOpenMonitors }) {
  const [url, setUrl] = useState(project.renderUrl || '');
  const [name, setName] = useState(project.name || '');
  useEffect(() => { setUrl(project.renderUrl || ''); setName(project.name || ''); }, [project.id, project.renderUrl, project.name]);
  const add = (event) => { event.preventDefault(); if (!url.trim()) return; onAdd(url, name, project.id); setUrl(project.renderUrl || ''); };
  const latest = monitors.map((monitor) => monitor.checks?.at(-1)).filter(Boolean).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
  const responding = monitors.filter((monitor) => monitor.status === 'up').length;
  return <div className="project-uptime-layout">
    <section className="project-uptime-heading"><div><span className="section-eyebrow">PROJECT HEALTH</span><h2>Uptime & Render</h2><p>Checks, response history, and deployment status for <strong>{project.name}</strong> stay grouped with this project.</p></div><button className="soft-button" onClick={onOpenMonitors}><Activity size={15} /> All monitors</button></section>
    <section className="workspace-card project-service-overview"><div className="project-service-main"><span className="card-title-icon green"><Cloud size={18} /></span><div><small>RENDER SERVICE</small><strong>{project.renderUrl ? statusLabel(project.status) : project.renderServiceId ? 'Service linked' : 'Not connected yet'}</strong><span>{project.renderUrl || (project.renderServiceId ? `Service ID ${project.renderServiceId}` : 'Connect a Render service in Deploy & Render after GitHub checks pass.')}</span></div></div><div className="project-service-metrics"><div><span>URL CHECKS</span><strong>{monitors.length}</strong></div><div><span>RESPONDING</span><strong>{responding}</strong></div><div><span>LAST PING</span><strong>{latest ? timeAgo(latest.checkedAt) : 'Not checked'}</strong></div></div><div className="project-service-actions">{project.renderUrl && <a className="soft-button" href={project.renderUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open live site</a>}<button className="primary-button" onClick={onOpenDeploy}><Settings2 size={15} /> Deploy & Render settings</button></div></section>
    <form className="monitor-add-card project-monitor-add" onSubmit={add}><div className="monitor-add-title"><span className="card-title-icon blue"><Wifi size={17} /></span><div><strong>Monitor a URL for this project</strong><small>Use the Render URL above or add another public endpoint.</small></div></div><div className="monitor-add-fields"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-project.onrender.com/health" aria-label={`Public URL for ${project.name}`} type="url" required /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project or endpoint name" aria-label="Monitor label" /><button className="primary-button" type="submit"><Plus size={16} /> Add URL</button></div><p><ShieldCheck size={13} /> Checks run at your selected interval while StackPilot is open and visible. Private addresses are blocked; use an external monitor for continuous checks.</p></form>
    <div className="project-monitor-list-heading"><div><span className="section-eyebrow">THIS PROJECT</span><h3>Ping history</h3></div><span>{monitors.length} endpoint{monitors.length === 1 ? '' : 's'}</span></div>
    <div className="monitor-list">{monitors.map((monitor) => <MonitorCard key={monitor.id} monitor={monitor} onPing={onPing} onRemove={onRemove} onInterval={onInterval} />)}{!monitors.length && <div className="recent-empty"><div className="empty-mark"><Wifi size={19} /></div><div><strong>No uptime check yet</strong><span>Add this project's public URL above. A deployed Render URL is attached automatically.</span></div></div>}</div>
  </div>;
}

function MonitorCard({ monitor, onPing, onRemove, onInterval }) {
  const checks = monitor.checks || [];
  const recent = checks.slice(-100);
  const uptime = recent.length ? Math.round(recent.filter((check) => check.ok).length / recent.length * 100) : null;
  const last = checks.at(-1);
  return <section className="workspace-card monitor-card" key={monitor.id}><div className="monitor-card-head"><span className={`monitor-status-light ${monitor.status}`} /><div className="monitor-card-title"><strong>{monitor.name}</strong><a href={monitor.url} target="_blank" rel="noreferrer">{monitor.url}<ExternalLink size={14} /></a></div><span className={`monitor-status-chip ${monitor.status}`}>{monitor.checking ? 'CHECKING' : monitor.status === 'up' ? 'UP' : monitor.status === 'down' ? 'DOWN' : 'WAITING'}</span><button className="icon-only danger-icon" onClick={() => onRemove(monitor.id)} aria-label={`Remove ${monitor.name}`} title="Remove monitor"><X size={15} /></button></div><div className="monitor-metrics"><div><span>RESPONSE</span><strong>{last ? `${last.durationMs} ms` : '—'}</strong></div><div><span>HTTP</span><strong>{last?.statusCode || '—'}</strong></div><div><span>UPTIME</span><strong>{uptime === null ? '—' : `${uptime}%`}</strong></div><div><span>STATE DURATION</span><strong>{monitorStateDuration(monitor)}</strong></div></div><div className="monitor-card-actions"><label>Check interval<select value={monitor.intervalSec || 60} onChange={(event) => onInterval(monitor.id, event.target.value)}><option value="60">1 minute</option><option value="300">5 minutes</option><option value="900">15 minutes</option></select></label><span>{last ? `Last ping ${timeAgo(last.checkedAt)}${last.error ? ` · ${last.error}` : ''}` : 'No checks yet'}</span><button className="soft-button" onClick={() => onPing(monitor.id)} disabled={monitor.checking}><Radio size={15} /> Ping now</button></div><details className="monitor-log-details"><summary><Activity size={15} /> Recent ping log <span>{checks.length}</span><ChevronDown size={14} /></summary><div className="monitor-log-list">{checks.slice(-20).reverse().map((check, index) => <div className="monitor-log-row" key={`${check.checkedAt}_${index}`}><i className={check.ok ? 'ok' : 'bad'} /><time>{timeLabel(check.checkedAt)}</time><span>{check.ok ? 'Responded' : check.error || 'No response'}</span><strong>{check.statusCode || '—'} · {check.durationMs} ms</strong></div>)}</div></details></section>;
}

function MonitorPage({ monitors, onBack, onAdd, onPing, onRemove, onInterval }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const add = (event) => { event.preventDefault(); if (!url.trim()) return; onAdd(url, name); setUrl(''); setName(''); };
  const totals = monitors.reduce((result, monitor) => { result[monitor.status] = (result[monitor.status] || 0) + 1; return result; }, {});
  return <div className="about-page monitor-page"><header className="workspace-header"><button className="workspace-brand" onClick={onBack}><img src="/stackpilot-icon.png" alt="" /><span>stackpilot</span></button><div className="workspace-breadcrumb"><button onClick={onBack}>Workspace</button><ChevronRight size={13} /><span>Uptime monitors</span></div><button className="header-link" onClick={onBack}>Back to projects <ArrowLeft size={14} /></button></header><main className="about-main"><button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back</button><div className="about-heading"><span className="section-eyebrow">LIVE URL CHECKS</span><h1>Know when a site responds.</h1><p>Add any public Render or web URL. StackPilot records status, response time, and recent ping history on this device.</p></div>
    <div className="monitor-stats"><div><strong>{monitors.length}</strong><span>URLs monitored</span></div><div><strong>{totals.up || 0}</strong><span>responding</span></div><div><strong>{totals.down || 0}</strong><span>failing</span></div><div><strong>60s+</strong><span>minimum interval</span></div></div>
    <form className="monitor-add-card" onSubmit={add}><div className="monitor-add-title"><span className="card-title-icon green"><Wifi size={16} /></span><div><strong>Add a public URL</strong><small>Checks do not send cookies or authentication headers.</small></div></div><div className="monitor-add-fields"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-app.onrender.com/health" aria-label="Public URL to monitor" type="url" required /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Label (optional)" aria-label="Monitor label" /><button className="primary-button" type="submit"><Plus size={15} /> Add monitor</button></div><p><ShieldCheck size={12} /> Local/private network addresses are blocked. Checks run while this app is open and visible; use an external uptime service if you need monitoring with the browser closed.</p></form>
    <div className="monitor-list">{monitors.map((monitor) => <MonitorCard key={monitor.id} monitor={monitor} onPing={onPing} onRemove={onRemove} onInterval={onInterval} />)}{!monitors.length && <div className="recent-empty"><strong>No URLs monitored yet</strong><span>Add your deployed URL to start collecting checks while StackPilot is open.</span></div>}</div>
    <div className="monitor-external-note"><strong>Need checks while StackPilot is closed?</strong><span>Use an external uptime service with this public health endpoint for StackPilot itself: <code>{typeof window !== 'undefined' ? `${window.location.origin}/api/health` : '/api/health'}</code>. No UptimeRobot account is connected here.</span></div>
  </main></div>;
}

function DeploymentsPage({ projects, onBack, onOpen }) {
  const deployed = projects.filter((project) => project.renderUrl || project.renderServiceId || ['deploying', 'live'].includes(project.status));
  return <div className="about-page"><header className="workspace-header"><button className="workspace-brand" onClick={onBack}><img src="/stackpilot-icon.png" alt="" /><span>stackpilot</span></button><div className="workspace-breadcrumb"><button onClick={onBack}>Projects</button><ChevronRight size={13} /><span>Deployments</span></div></header><main className="about-main"><button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back</button><div className="about-heading"><span className="section-eyebrow">RELEASE HISTORY</span><h1>Every deploy, in one place.</h1><p>Render only receives a project after its current GitHub build and tests pass.</p></div>{deployed.length ? <div className="deployment-list">{deployed.map((project) => <button key={project.id} onClick={() => onOpen(project.id)}><span className={`project-dot project-${project.status}`} /><span><strong>{project.name}</strong><small>{project.repo || 'No repository linked'}</small></span><span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span><span className="deployment-url">{project.renderUrl || 'Waiting for first Render deployment'}</span><ArrowUpRight size={15} /></button>)}</div> : <div className="recent-empty"><strong>No releases yet.</strong><span>Start a project and enable Auto-deploy to publish after successful checks.</span></div>}</main></div>;
}

function SettingsModal({ connectors, setConnectors, health, tokenExpiry, setTokenExpiry, githubIdentity, checkingGithub, checkingRender, checkingOpenRouter, onGithubTest, onRenderTest, onOpenRouterTest, onSaveGithubToServer, onSaveRenderToken, onSaveOpenRouterKeys, onSaveAppPin, onClearSecrets, onSave, onEnableNotifications, onDisableNotifications, notificationReady, onClose }) {
  const [serverExpiry, setServerExpiry] = useState(tokenExpiry || '');
  const [savingServerToken, setSavingServerToken] = useState(false);
  const [savingServerRenderToken, setSavingServerRenderToken] = useState(false);
  const [savingServerOpenRouter, setSavingServerOpenRouter] = useState(false);
  const [savingServerPin, setSavingServerPin] = useState(false);
  const [newAppPin, setNewAppPin] = useState('');
  const [confirmAppPin, setConfirmAppPin] = useState('');
  const update = (key, value) => setConnectors((current) => ({ ...current, [key]: value }));
  const saveServerToken = async () => {
    const token = String(connectors.githubToken || '').trim();
    if (!token) { window.alert('Paste a newly rotated GitHub token in the GitHub field first.'); return; }
    setSavingServerToken(true);
    try { await onSaveGithubToServer(token, serverExpiry); setTokenExpiry(serverExpiry); }
    catch (error) { window.alert(error.message || 'Could not save token.'); }
    finally { setSavingServerToken(false); }
  };
  const saveRenderToken = async () => {
    const token = String(connectors.renderToken || '').trim();
    if (!token) { window.alert('Paste a Render API key in the workspace fallback field first.'); return; }
    setSavingServerRenderToken(true);
    try { await onSaveRenderToken(token, connectors.renderOwnerId); update('renderToken', ''); }
    catch (error) { window.alert(error.message || 'Could not save the Render API key.'); }
    finally { setSavingServerRenderToken(false); }
  };
  const saveOpenRouterKeys = async () => {
    setSavingServerOpenRouter(true);
    try {
      await onSaveOpenRouterKeys(connectors.openRouterKey1, connectors.openRouterKey2);
      update('openRouterKey1', ''); update('openRouterKey2', '');
    } catch (error) { window.alert(error.message || 'Could not save OpenRouter keys.'); }
    finally { setSavingServerOpenRouter(false); }
  };
  const saveAppPin = async () => {
    if (newAppPin !== confirmAppPin) { window.alert('The two App PIN fields do not match.'); return; }
    setSavingServerPin(true);
    try { await onSaveAppPin(newAppPin); setNewAppPin(''); setConfirmAppPin(''); }
    catch (error) { window.alert(error.message || 'Could not save the App PIN.'); }
    finally { setSavingServerPin(false); }
  };
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
    <div className="modal-header"><div className="modal-icon"><Settings2 size={18} /></div><div><h2 id="settings-heading">Settings & connections</h2><p>Use fresh credentials. Secrets never enter project files or the GitHub commit.</p></div><button className="icon-only modal-close" onClick={onClose} aria-label="Close settings"><X size={18} /></button></div>
    <div className="modal-body">
      <div className="settings-card openrouter-settings-card"><div className="settings-section-heading"><span className="card-title-icon violet"><Sparkles size={15} /></span><div><strong>OpenRouter · free models only</strong><small>Workspace fallback; per-project overrides are available in each project’s Deploy & Render tab.</small></div><span className={`settings-state ${connectors.openRouterKey1 || connectors.openRouterKey2 || health.envConfigured?.openrouter ? 'ready' : ''}`}>{connectors.openRouterKey1 || connectors.openRouterKey2 || health.envConfigured?.openrouter ? 'READY' : 'ADD KEY'}</span></div><label className="settings-field-inline"><span>OpenRouter key 1</span><input type="password" autoComplete="new-password" value={connectors.openRouterKey1} onChange={(event) => update('openRouterKey1', event.target.value)} placeholder="sk-or-v1-…" /></label><label className="settings-field-inline"><span>OpenRouter key 2 <small>optional fallback</small></span><input type="password" autoComplete="new-password" value={connectors.openRouterKey2} onChange={(event) => update('openRouterKey2', event.target.value)} placeholder="Second key for rotation" /></label><small className="field-help">Requests are restricted to OpenRouter’s free router; two keys rotate on requests/errors but do not guarantee more quota or uptime. Free models can still return 429s or be unavailable.</small><div className="settings-inline-actions"><button className="soft-button" onClick={onOpenRouterTest} disabled={checkingOpenRouter}>{checkingOpenRouter ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Test OpenRouter keys</button><span>Quota check uses the key endpoint, not a model inference.</span></div><div className="server-secret-details server-secret-visible"><p>Save these keys in the StackPilot service’s Render environment. This uses the Render key in the workspace section below or one already saved server-side; saving queues a restart.</p><button className="primary-button save-server-token" onClick={saveOpenRouterKeys} disabled={savingServerOpenRouter || !connectors.openRouterKey1 || (!connectors.renderToken && !health.envConfigured?.render)}>{savingServerOpenRouter ? <Loader2 size={14} className="spin" /> : <LockKeyhole size={14} />} Save OpenRouter keys to Render</button></div></div>
      <div className="settings-card app-pin-settings-card"><div className="settings-section-heading"><span className="card-title-icon amber"><LockKeyhole size={15} /></span><div><strong>Set a four-digit App PIN</strong><small>Writes APP_PIN to Render. The lock screen opens before the workspace.</small></div><span className={`settings-state ${health.appPinRequired ? 'ready' : ''}`}>{health.appPinRequired ? 'PIN ON' : 'PASSWORD'}</span></div><div className="pin-field-row"><label className="settings-field-inline"><span>New PIN</span><input type="password" inputMode="numeric" autoComplete="new-password" maxLength="4" value={newAppPin} onChange={(event) => setNewAppPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4 digits" /></label><label className="settings-field-inline"><span>Confirm PIN</span><input type="password" inputMode="numeric" autoComplete="new-password" maxLength="4" value={confirmAppPin} onChange={(event) => setConfirmAppPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Repeat PIN" /></label></div><small className="field-help">A four-digit PIN is weaker than a passphrase. StackPilot blocks local API brute-force attempts, but Render Free restarts can reset its in-memory limit. A Render API key is required.</small><button className="primary-button save-server-token" onClick={saveAppPin} disabled={savingServerPin || newAppPin.length !== 4 || confirmAppPin.length !== 4 || (!connectors.renderToken && !health.envConfigured?.render)}>{savingServerPin ? <Loader2 size={14} className="spin" /> : <LockKeyhole size={14} />} Save PIN in Render</button></div>
      <div className="settings-card"><div className="settings-section-heading"><span className="card-title-icon blue"><Github size={15} /></span><div><strong>GitHub</strong><small>Push code and start the real Actions build runner.</small></div><span className={`settings-state ${connectors.githubToken || health.envConfigured?.github ? 'ready' : ''}`}>{githubIdentity || (health.envConfigured?.github ? 'SERVER KEY' : connectors.githubToken ? 'SESSION KEY' : 'ADD KEY')}</span></div><label className="settings-field-inline"><span>GitHub token <small>used for testing or server save</small></span><input type="password" autoComplete="new-password" value={connectors.githubToken} onChange={(event) => update('githubToken', event.target.value)} placeholder="github_pat_…" /></label><div className="settings-inline-actions"><button className="soft-button" onClick={onGithubTest} disabled={checkingGithub}>{checkingGithub ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Test GitHub</button><span>Fine-grained token: Contents read/write, Actions read/write, Metadata read.</span></div>
        <div className="server-secret-details server-secret-visible"><p>Save a newly rotated token as the private GITHUB_TOKEN Render secret. The service restarts after saving. Never use an exposed or revoked token.</p><label className="settings-field-inline"><span>Token expiry date <small>manual reminder</small></span><input type="date" value={serverExpiry} onChange={(event) => setServerExpiry(event.target.value)} /></label><button className="primary-button save-server-token" onClick={saveServerToken} disabled={savingServerToken || !connectors.githubToken || (!connectors.renderToken && !health.envConfigured?.render)}>{savingServerToken ? <Loader2 size={14} className="spin" /> : <LockKeyhole size={14} />} Save token securely to Render</button></div>
      </div>
      <div className="settings-card"><div className="settings-section-heading"><span className="card-title-icon green"><Cloud size={15} /></span><div><strong>Render workspace fallback</strong><small>Save this workspace key on StackPilot Render to reuse it after you leave; project-level keys take priority.</small></div><span className={`settings-state ${connectors.renderToken || health.envConfigured?.render ? 'ready' : ''}`}>{health.envConfigured?.render ? 'SERVER KEY' : connectors.renderToken ? 'SESSION KEY' : 'ADD KEY'}</span></div><label className="settings-field-inline"><span>Workspace fallback API key</span><input type="password" autoComplete="new-password" value={connectors.renderToken} onChange={(event) => update('renderToken', event.target.value)} placeholder="rnd_…" /></label><label className="settings-field-inline"><span>Render workspace / owner ID</span><input value={connectors.renderOwnerId} onChange={(event) => update('renderOwnerId', event.target.value)} placeholder="tea-…" /></label><div className="settings-inline-actions"><button className="soft-button" onClick={onRenderTest} disabled={checkingRender}>{checkingRender ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Test Render</button><span>Service region defaults to Frankfurt; choose per project.</span></div><div className="server-secret-details server-secret-visible"><p>Unsaved values exist only in this tab. Save writes RENDER_API_TOKEN as a StackPilot Render secret, optionally saves the owner ID, and queues a service restart.</p><button className="primary-button save-server-token" onClick={saveRenderToken} disabled={savingServerRenderToken || !connectors.renderToken}>{savingServerRenderToken ? <Loader2 size={14} className="spin" /> : <LockKeyhole size={14} />} Save Render key to server</button></div></div>
      <div className="settings-card notification-settings"><div className="settings-section-heading"><span className="card-title-icon amber"><Bell size={15} /></span><div><strong>Real notifications</strong><small>{health.notificationsConfigured ? 'Web Push is configured on the server.' : 'Notifications need browser permission and server VAPID keys.'}</small></div><span className={`settings-state ${notificationReady ? 'ready' : ''}`}>{notificationReady ? 'ON' : 'DEVICE'}</span></div><button className="soft-button" onClick={notificationReady ? onDisableNotifications : onEnableNotifications}><Bell size={14} />{notificationReady ? 'Disable notifications' : 'Enable notifications'}</button><p className="field-help">On iPhone, add StackPilot to Home Screen first, then allow notifications. Web Push is supported by iOS 16.4+ home-screen web apps.</p></div>
      <div className="privacy-note"><ShieldCheck size={15} /><span>Unsaved credentials stay in page memory only and clear on refresh; they are not encrypted in the browser and could be inspected from an unlocked tab. Render stores saved environment secrets server-side. Project runtime values are sent to that project’s Render service only when you save them.</span></div>
    </div>
    <div className="modal-footer"><button className="quiet-button danger-text" onClick={onClearSecrets}>Clear in-memory keys</button><div><button className="soft-button" onClick={onClose}>Close</button><button className="primary-button" onClick={onSave}><Check size={15} /> Done</button></div></div>
  </section></div>;
}

function InstallHelp({ onClose }) {
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-modal install-modal"><div className="modal-header"><div className="modal-icon"><Smartphone size={18} /></div><div><h2>Add StackPilot to iPhone</h2><p>Use a home-screen app to get the best mobile and notification experience.</p></div><button className="icon-only modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button></div><div className="modal-body"><ol className="install-steps"><li><span>1</span><div><strong>Open in Safari</strong><small>Web Push on iOS requires Safari and iOS 16.4 or newer.</small></div></li><li><span>2</span><div><strong>Tap Share, then Add to Home Screen</strong><small>The StackPilot icon is configured for your home screen.</small></div></li><li><span>3</span><div><strong>Open the new StackPilot icon</strong><small>Tap Notifications and allow permission from inside the installed app.</small></div></li></ol><div className="privacy-note"><Bell size={15} /><span>Background runs continue on the StackPilot server. Push delivery and Render Free availability can still be affected by host restarts and usage limits.</span></div></div><div className="modal-footer"><span /><button className="primary-button" onClick={onClose}>Got it</button></div></section></div>;
}

export default App;
