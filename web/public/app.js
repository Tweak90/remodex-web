/* remodex-web: independent browser client for an existing Codex environment. */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  thread: null, project: '', projects: [], connected: false,
  panes: {
    project: { items: [], cursor: null, loading: false, version: 0, initialized: false },
    unassigned: { items: [], cursor: null, loading: false, version: 0, initialized: false },
  },
  runtime: { models: [], defaults: {}, usage: null },
  settings: { model: '', effort: '', serviceTier: 'default' }, settingsReady: false,
  running: false, turnId: null, items: new Map(), source: null,
  opening: false, sending: false, loadVersion: 0, requests: new Map(),
  completedTurns: new Set(), completionVersions: new Map(),
};

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (response.status === 401) {
    showLogin();
    throw new Error('Bitte melde dich an.');
  }
  if (!response.ok || result.error) {
    throw new Error(result.error?.message || result.error || `Anfrage fehlgeschlagen (${response.status}).`);
  }
  return result;
}

async function rpc(method, params = {}) {
  const result = await api('/api/rpc', { method, params });
  return result.jsonrpc ? result.result : result;
}

function notice(error) {
  $('notice-text').textContent = typeof error === 'string' ? error : error.message;
  $('notice').hidden = false;
}

function showLogin() {
  state.source?.close();
  state.source = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

function setConnection(connected, label) {
  const reconnected = Boolean(connected) && !state.connected;
  state.connected = Boolean(connected);
  $('connection').className = `connection ${connected ? 'connected' : 'disconnected'}`;
  $('connection-text').textContent = label || (connected ? 'Umgebung verbunden' : 'Verbindung unterbrochen');
  updateComposer();
  if (reconnected && !$('app').hidden) {
    void reconcileThread();
    void refreshThreads();
    void loadRequests();
    void loadRuntime();
  }
}

async function loadStatus() {
  const status = await api('/api/status');
  setConnection(status.connected);
  $('host-label').textContent = status.hostLabel || 'Bestehende Umgebung';
  return status;
}

async function init() {
  try {
    const status = await loadStatus();
    $('login').hidden = true;
    $('app').hidden = false;
    connectEvents();
    await Promise.all([loadProjects(), loadRuntime()]);
    await Promise.all([loadPane('project', 'reset'), loadPane('unassigned', 'reset')]);
    await loadRequests();
    const selected = new URL(location.href).searchParams.get('thread');
    if (selected && !state.thread) await openThread(selected);
    if (!status.connected) notice('Codex ist momentan nicht erreichbar. Die Verbindung wird automatisch erneut geprüft.');
  } catch (error) {
    if (!$('app').hidden) notice(error);
  }
}

async function loadProjects() {
  try {
    const result = await api('/api/projects');
    const previous = $('project').value || state.project;
    state.projects = result.projects || [];
    $('project').replaceChildren(new Option('Projekt wählen …', ''));
    for (const project of state.projects) {
      $('project').add(new Option(project.name || baseName(project.path), project.path));
    }
    if (previous && ![...$('project').options].some((option) => option.value === previous)) {
      $('project').add(new Option(baseName(previous), previous));
    }
    $('project').value = previous;
    state.project = previous;
    updateComposer();
  } catch (error) { notice(error); }
}

function baseName(path) { return String(path || '').replace(/\/$/, '').split('/').pop() || path; }
function threadName(thread) { return thread.name || thread.preview || 'Neues Gespräch'; }
function isRunning(status) {
  const value = typeof status === 'object' ? status?.type || status?.status : status;
  return ['inProgress', 'running', 'active', 'busy'].includes(value);
}

function allThreads() { return [...state.panes.project.items, ...state.panes.unassigned.items]; }

async function fetchThreadPage(scope, project, limit, cursor) {
  const query = new URLSearchParams({ scope, limit: String(limit) });
  if (project) query.set('project', project);
  if (cursor) query.set('cursor', cursor);
  return api(`/api/threads?${query}`);
}

async function loadPane(scope, mode = 'refresh') {
  const pane = state.panes[scope];
  const nav = $(`${scope}-threads`);
  if (mode === 'more' && (pane.loading || !pane.cursor)) return;
  if (mode === 'refresh' && pane.loading) return;
  const version = ++pane.version;
  const project = scope === 'project' ? state.project : '';
  const oldScroll = mode === 'reset' ? 0 : nav.scrollTop;
  const targetCount = mode === 'reset' ? 10 : Math.max(10, pane.items.length);
  if (mode === 'reset') { pane.items = []; pane.cursor = null; pane.initialized = false; }
  if (scope === 'project' && !project) {
    pane.loading = false;
    pane.initialized = true;
    renderPane(scope);
    return;
  }
  pane.loading = true;
  renderPaneStatus(scope);
  try {
    let result;
    let items;
    if (mode === 'more') {
      result = await fetchThreadPage(scope, project, 5, pane.cursor);
      items = [...pane.items];
      for (const thread of result.data || []) if (!items.some((item) => item.id === thread.id)) items.push(thread);
    } else {
      result = await fetchThreadPage(scope, project, 10);
      items = [...(result.data || [])];
      // Refresh only the pages the user already opened; this never grows the visible window.
      while (items.length < targetCount && result.nextCursor) {
        if (version !== pane.version || project !== (scope === 'project' ? state.project : '')) return;
        result = await fetchThreadPage(scope, project, 5, result.nextCursor);
        items.push(...(result.data || []));
      }
    }
    if (version !== pane.version || project !== (scope === 'project' ? state.project : '')) return;
    pane.items = items;
    pane.cursor = result.nextCursor || null;
    pane.initialized = true;
    renderPane(scope);
    nav.scrollTop = oldScroll;
  } catch (error) {
    if (version === pane.version) notice(error);
  } finally {
    if (version === pane.version) { pane.loading = false; renderPaneStatus(scope); }
  }
}

function refreshThreads() { return Promise.all([loadPane('project'), loadPane('unassigned')]); }

function renderPaneStatus(scope) {
  const pane = state.panes[scope];
  $(`refresh-${scope}`).disabled = pane.loading;
  $(`${scope}-threads-status`).textContent = pane.loading ? 'Wird geladen …' : pane.cursor ? 'Für weitere Gespräche nach unten scrollen' : '';
}

function renderPane(scope) {
  const pane = state.panes[scope];
  const nav = $(`${scope}-threads`);
  const previousScroll = nav.scrollTop;
  pane.scrollIntent = 0;
  nav.replaceChildren();
  if (!pane.items.length) {
    const empty = document.createElement('p');
    empty.className = 'thread-empty';
    empty.textContent = scope === 'project' && !state.project
      ? 'Wähle ein Projekt, um seine Gespräche zu sehen.'
      : pane.initialized ? scope === 'project' ? 'In diesem Projekt gibt es noch keine Gespräche.' : 'Keine Gespräche ohne Projekt.' : 'Gespräche werden geladen …';
    nav.append(empty);
  }
  for (const thread of pane.items) {
    const button = document.createElement('button');
    button.className = `thread${state.thread?.id === thread.id ? ' active' : ''}`;
    button.title = threadName(thread);
    button.setAttribute('aria-current', state.thread?.id === thread.id ? 'page' : 'false');
    const name = document.createElement('span');
    name.className = 'thread-name';
    name.textContent = threadName(thread);
    const meta = document.createElement('span');
    meta.className = 'thread-meta';
    const date = thread.updatedAt ? new Date(thread.updatedAt * (thread.updatedAt > 1e12 ? 1 : 1000)) : null;
    meta.textContent = [baseName(thread.cwd), date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) : null].filter(Boolean).join(' · ');
    button.append(name, meta);
    button.addEventListener('click', () => openThread(thread.id));
    nav.append(button);
  }
  nav.scrollTop = previousScroll;
  renderPaneStatus(scope);
}

function renderThreads() { renderPane('project'); renderPane('unassigned'); }

function projectForThread(thread) {
  if (thread.projectId) return state.projects.find((project) => project.id === thread.projectId);
  return state.projects.find((project) => thread.cwd === project.path);
}

function setProject(project) {
  if (state.project === project) return;
  state.project = project;
  $('project').value = project;
  void loadPane('project', 'reset');
  updateComposer();
}

const effortLabels = { none: 'Ohne', minimal: 'Minimal', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', xhigh: 'Sehr hoch', max: 'Maximum', ultra: 'Ultra' };

function selectedModel() {
  return state.runtime.models.find((model) => model.model === state.settings.model || model.id === state.settings.model);
}

function resetRuntimeSettings() {
  const defaults = state.runtime.defaults || {};
  const model = state.runtime.models.find((item) => item.model === defaults.model || item.id === defaults.model)
    || state.runtime.models.find((item) => item.isDefault) || state.runtime.models[0];
  state.settings = {
    model: defaults.model || model?.model || model?.id || '',
    effort: defaults.effort || defaults.reasoningEffort || model?.defaultReasoningEffort || '',
    serviceTier: defaults.serviceTier || 'default',
  };
  renderRuntimeControls();
  renderUsage();
}

function applyThreadSettings(response) {
  const thread = response.thread || response;
  const defaults = state.runtime.defaults || {};
  state.settings.model = response.model || thread.model || defaults.model || state.settings.model;
  const model = selectedModel();
  state.settings.effort = response.reasoningEffort || response.effort || thread.reasoningEffort
    || defaults.effort || defaults.reasoningEffort || model?.defaultReasoningEffort || '';
  state.settings.serviceTier = response.serviceTier || thread.serviceTier || 'default';
  renderRuntimeControls();
  renderUsage();
}

async function loadRuntime() {
  try {
    const result = await api('/api/runtime');
    state.runtime.models = Array.isArray(result.models) ? result.models : result.models?.data || [];
    state.runtime.defaults = result.defaults || {};
    state.runtime.usage = result.usage || null;
    state.runtime.updatedAt = Date.now();
    if (!state.settingsReady) {
      resetRuntimeSettings();
      state.settingsReady = true;
    } else {
      renderRuntimeControls();
      renderUsage();
    }
    updateComposer();
  } catch (error) {
    if (!state.runtime.usage) {
      $('usage-content').replaceChildren();
      const text = document.createElement('p');
      text.textContent = 'Kontingentdaten sind momentan nicht verfügbar.';
      $('usage-content').append(text);
    }
    if (!state.settingsReady) {
      $('model').replaceChildren(new Option('Modell nicht verfügbar', ''));
      $('effort').replaceChildren(new Option('Denkgrad nicht verfügbar', ''));
    }
  }
}

function renderRuntimeControls() {
  const modelSelect = $('model');
  const models = state.runtime.models.filter((model) => !model.hidden || model.model === state.settings.model || model.id === state.settings.model);
  modelSelect.replaceChildren();
  for (const model of models) modelSelect.add(new Option(model.displayName || model.model || model.id, model.model || model.id));
  if (state.settings.model && ![...modelSelect.options].some((option) => option.value === state.settings.model))
    modelSelect.add(new Option(state.settings.model, state.settings.model));
  if (!modelSelect.options.length) modelSelect.add(new Option('Umgebungsstandard', ''));
  modelSelect.value = state.settings.model;
  const model = selectedModel();
  const effortSelect = $('effort');
  const supported = model?.supportedReasoningEfforts || [];
  effortSelect.replaceChildren();
  for (const item of supported) {
    const option = new Option(effortLabels[item.reasoningEffort] || item.reasoningEffort, item.reasoningEffort);
    option.title = item.description || '';
    effortSelect.add(option);
  }
  if (state.settings.effort && ![...effortSelect.options].some((option) => option.value === state.settings.effort))
    effortSelect.add(new Option(effortLabels[state.settings.effort] || state.settings.effort, state.settings.effort));
  if (!effortSelect.options.length) effortSelect.add(new Option('Umgebungsstandard', ''));
  effortSelect.value = state.settings.effort;
  const tierSelect = $('service-tier');
  tierSelect.replaceChildren(new Option('Standard', 'default'));
  for (const tier of model?.serviceTiers || []) {
    if (tier.id === 'default') continue;
    const option = new Option(tier.id === 'priority' ? 'Fast' : tier.name || tier.id, tier.id);
    option.title = tier.description || '';
    tierSelect.add(option);
  }
  if (state.settings.serviceTier !== 'default' && ![...tierSelect.options].some((option) => option.value === state.settings.serviceTier))
    tierSelect.add(new Option(state.settings.serviceTier === 'priority' ? 'Fast' : state.settings.serviceTier, state.settings.serviceTier));
  tierSelect.value = state.settings.serviceTier;
  $('service-tier-label').hidden = tierSelect.options.length < 2;
  updateComposer();
}

function quotaWindowLabel(window) {
  const minutes = Number(window.windowDurationMins);
  if (!minutes) return 'Nutzungsfenster';
  if (minutes === 10080) return 'Woche';
  if (minutes % 1440 === 0) return `${minutes / 1440} Tage`;
  if (minutes % 60 === 0) return `${minutes / 60} Stunden`;
  return `${minutes} Minuten`;
}

function usageSnapshots() {
  const usage = state.runtime.usage;
  if (!usage) return [];
  const candidates = [usage.rateLimits, ...Object.values(usage.rateLimitsByLimitId || {})].filter(Boolean);
  const snapshots = [];
  const seen = new Set();
  for (const snapshot of candidates) {
    const key = snapshot.limitId || JSON.stringify([snapshot.limitName, snapshot.primary, snapshot.secondary]);
    if (!seen.has(key)) { snapshots.push(snapshot); seen.add(key); }
  }
  return snapshots;
}

function updateUsage(params) {
  const usage = state.runtime.usage || {};
  if (params.rateLimits) {
    const limit = params.rateLimits;
    usage.rateLimits = limit;
    if (limit.limitId) usage.rateLimitsByLimitId = { ...usage.rateLimitsByLimitId, [limit.limitId]: limit };
  }
  if (typeof params.ordinaryUsageAllowed === 'boolean') usage.ordinaryUsageAllowed = params.ordinaryUsageAllowed;
  if (params.rateLimitsByLimitId) usage.rateLimitsByLimitId = { ...usage.rateLimitsByLimitId, ...params.rateLimitsByLimitId };
  state.runtime.usage = usage;
  state.runtime.updatedAt = Date.now();
  renderUsage();
}

function renderUsage() {
  const content = $('usage-content');
  content.replaceChildren();
  const snapshots = usageSnapshots();
  let windowCount = 0;
  const primarySnapshot = snapshots.find((snapshot) => snapshot.normalModelSlug === state.settings.model)
    || snapshots.find((snapshot) => snapshot.primary || snapshot.secondary);
  const summaryWindow = primarySnapshot?.primary || primarySnapshot?.secondary;
  $('usage-summary').textContent = summaryWindow && Number.isFinite(summaryWindow.usedPercent)
    ? `${Math.max(0, Math.min(100, 100 - summaryWindow.usedPercent))} % frei` : 'Kontingent';
  for (const snapshot of snapshots) {
    const windows = [snapshot.primary, snapshot.secondary].filter((window) => window && Number.isFinite(window.usedPercent));
    if (!windows.length) continue;
    const group = document.createElement('section');
    group.className = 'quota-group';
    if (snapshots.length > 1 || snapshot.limitName) {
      const heading = document.createElement('h3');
      heading.textContent = snapshot.limitName || snapshot.normalModelSlug || 'Codex';
      group.append(heading);
    }
    for (const window of windows) {
      windowCount++;
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
      const row = document.createElement('div');
      row.className = 'quota-window';
      const label = document.createElement('span');
      label.textContent = quotaWindowLabel(window);
      const percent = document.createElement('strong');
      percent.textContent = `${remaining} % verbleibend`;
      const meter = document.createElement('meter');
      meter.min = 0; meter.max = 100; meter.value = remaining;
      meter.setAttribute('aria-label', `${quotaWindowLabel(window)}: ${remaining} Prozent verbleibend`);
      const reset = document.createElement('small');
      if (Number.isFinite(window.resetsAt)) {
        const date = new Date(window.resetsAt * (window.resetsAt > 1e12 ? 1 : 1000));
        reset.textContent = `Erneuert am ${date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
      } else reset.textContent = 'Zeitpunkt der Erneuerung nicht verfügbar';
      row.append(label, percent, meter, reset);
      group.append(row);
    }
    content.append(group);
  }
  if (!windowCount) {
    const unavailable = document.createElement('p');
    unavailable.textContent = 'Die Codex-Umgebung liefert momentan keine Kontingentdaten.';
    content.append(unavailable);
  }
  if (state.runtime.usage?.ordinaryUsageAllowed === false) {
    const limited = document.createElement('p');
    limited.className = 'quota-warning';
    limited.textContent = 'Die reguläre Nutzung ist laut Codex derzeit eingeschränkt.';
    content.append(limited);
  }
  $('usage-updated').textContent = state.runtime.updatedAt
    ? `Stand ${new Date(state.runtime.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · Angaben aus deiner Codex-Umgebung` : '';
}

function updateComposer() {
  $('send').disabled = state.sending || state.opening || state.running || !state.connected;
  $('send').hidden = state.running;
  $('stop').hidden = !state.running;
  $('run-state').hidden = !state.running;
  $('composer-context').textContent = state.thread?.cwd || state.project || 'Wähle links ein Projekt für ein neues Gespräch.';
  for (const id of ['model', 'effort', 'service-tier']) $(id).disabled = state.sending || state.opening || !state.settingsReady;
  $('prompt').placeholder = state.running ? 'Codex arbeitet. Du kannst schon deine nächste Nachricht vorbereiten.' : 'Was möchtest du mit Codex angehen?';
}

function setRunning(running, turnId = null) {
  state.running = running;
  state.turnId = running ? turnId || state.turnId : null;
  updateComposer();
}

function clearMessages() {
  state.items.clear();
  for (const element of [...$('messages').children]) if (element.id !== 'welcome') element.remove();
}

function syncThread(thread) {
  state.thread = thread;
  const project = projectForThread(thread);
  if (project && project.path !== state.project) setProject(project.path);
  $('thread-title').textContent = threadName(thread);
  const turns = thread.turns || [];
  const running = [...turns].reverse().find((turn) => isRunning(turn.status));
  setRunning(Boolean(running) || isRunning(thread.status), running?.id);
  clearMessages();
  $('welcome').hidden = turns.some((turn) => turn.items?.length);
  for (const turn of turns) for (const item of turn.items || []) renderItem(item, turn.id);
  renderThreads();
  scrollBottom(true);
}

async function openThread(id) {
  const version = ++state.loadVersion;
  state.opening = true;
  updateComposer();
  closeSidebar();
  try {
    const resumed = await rpc('thread/resume', { threadId: id });
    if (version !== state.loadVersion) return;
    const read = await rpc('thread/read', { threadId: id, includeTurns: true });
    if (version !== state.loadVersion) return;
    syncThread(read.thread || resumed.thread);
    applyThreadSettings(resumed);
    const url = new URL(location.href);
    url.searchParams.set('thread', id);
    history.replaceState({}, '', url);
  } catch (error) { if (version === state.loadVersion) notice(error); }
  finally {
    if (version === state.loadVersion) {
      state.opening = false;
      updateComposer();
    }
  }
}

function itemText(item) {
  if (item.type === 'userMessage') return (item.content || []).map((part) => part.text || (part.type === 'image' ? '[Bild]' : '')).join('\n');
  if (item.type === 'agentMessage') return item.text || '';
  if (item.type === 'reasoning') return (item.summary || item.content || []).map((part) => typeof part === 'string' ? part : part.text || '').join('\n');
  return item.text || item.message || '';
}

function nearBottom() { return $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 130; }
function scrollBottom(force = false) { if (force || nearBottom()) $('messages').scrollTop = $('messages').scrollHeight; }

function renderItem(item, turnId = '') {
  if (!item || !item.type) return;
  const supported = ['userMessage', 'agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'reasoning'];
  if (!supported.includes(item.type)) return;
  const id = item.id || `${turnId}:${item.type}:${state.items.size}`;
  let entry = state.items.get(id);
  const wasNear = nearBottom();
  $('welcome').hidden = true;
  if (!entry) {
    const tool = !['userMessage', 'agentMessage'].includes(item.type);
    const element = document.createElement(tool ? 'details' : 'article');
    element.className = `message ${item.type === 'userMessage' ? 'user' : tool ? 'tool' : 'assistant'}`;
    if (tool) {
      const title = document.createElement('summary');
      const body = document.createElement('pre');
      element.append(title, body);
      entry = { element, title, body, item: {} };
    } else {
      const header = document.createElement('div');
      header.className = 'message-header';
      const icon = document.createElement('span');
      icon.className = 'message-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.type === 'userMessage' ? 'S' : '✳';
      header.append(icon, document.createTextNode(item.type === 'userMessage' ? 'DU' : 'CODEX'));
      const body = document.createElement('div');
      body.className = 'message-body';
      element.append(header, body);
      entry = { element, body, item: {} };
    }
    state.items.set(id, entry);
    $('messages').append(element);
  }
  entry.item = { ...entry.item, ...item, id };
  const current = entry.item;
  if (entry.title) {
    const labels = { commandExecution: 'Terminal', fileChange: 'Dateiänderungen', mcpToolCall: 'Tool', webSearch: 'Websuche', reasoning: 'Überlegungen' };
    entry.title.textContent = `${labels[current.type]}${current.command ? ` · ${current.command}` : current.tool ? ` · ${current.tool}` : current.query ? ` · ${current.query}` : ''}`;
    entry.body.textContent = current.aggregatedOutput || current.output || (current.changes ? current.changes.map((change) => `${change.kind?.type || change.kind || ''} ${change.path || ''}`).join('\n') : itemText(current)) || current.status || '';
  } else entry.body.textContent = itemText(current);
  if (wasNear) scrollBottom(true);
}

async function sendMessage(event) {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (!text || state.sending || state.running || state.opening || !state.connected) return;
  state.sending = true;
  let optimisticId = null;
  let needsReconcile = false;
  const sendVersion = state.loadVersion;
  updateComposer();
  try {
    if (!state.thread) {
      if (!state.project) throw new Error('Wähle zuerst links ein Projekt aus.');
      const created = await rpc('thread/start', {
        cwd: state.project,
        ...(state.settings.model ? { model: state.settings.model } : {}),
        ...(state.settings.effort ? { config: { model_reasoning_effort: state.settings.effort } } : {}),
        serviceTier: state.settings.serviceTier,
      });
      if (sendVersion !== state.loadVersion) return;
      state.thread = created.thread;
      if (!state.thread?.id) throw new Error('Codex hat kein Gespräch zurückgegeben.');
      $('thread-title').textContent = threadName(state.thread);
      const url = new URL(location.href);
      url.searchParams.set('thread', state.thread.id);
      history.replaceState({}, '', url);
      void loadPane('project');
    }
    optimisticId = `optimistic:${Date.now()}`;
    renderItem({ id: optimisticId, type: 'userMessage', content: [{ type: 'text', text }], _optimistic: true });
    const threadId = state.thread.id;
    const completionVersion = state.completionVersions.get(threadId) || 0;
    const result = await rpc('turn/start', {
      threadId, input: [{ type: 'text', text }],
      ...(state.settings.model ? { model: state.settings.model } : {}),
      ...(state.settings.effort ? { effort: state.settings.effort } : {}),
      serviceTier: state.settings.serviceTier,
    });
    if (sendVersion !== state.loadVersion || state.thread?.id !== threadId) return;
    $('prompt').value = '';
    $('prompt').style.height = '';
    const turnId = result.turn?.id || result.turnId;
    const completed = state.completedTurns.has(`${threadId}:${turnId}`)
      || (state.completionVersions.get(threadId) || 0) > completionVersion
      || (result.turn?.status && !isRunning(result.turn.status));
    setRunning(!completed, turnId);
    needsReconcile = completed;
    if (result.turn?.items?.length) {
      if (result.turn.items.some((item) => item.type === 'userMessage')) {
        state.items.get(optimisticId)?.element.remove();
        state.items.delete(optimisticId);
      }
      for (const item of result.turn.items) renderItem(item, result.turn.id);
    }
    scrollBottom(true);
  } catch (error) {
    if (optimisticId) { state.items.get(optimisticId)?.element.remove(); state.items.delete(optimisticId); }
    notice(error);
  }
  finally {
    state.sending = false;
    updateComposer();
    if (needsReconcile) void reconcileThread();
  }
}

async function stopTurn() {
  if (!state.thread || !state.running) return;
  $('stop').disabled = true;
  try {
    if (!state.turnId) {
      const result = await rpc('thread/read', { threadId: state.thread.id, includeTurns: true });
      state.turnId = [...(result.thread?.turns || [])].reverse().find((turn) => isRunning(turn.status))?.id;
    }
    if (!state.turnId) throw new Error('Der laufende Schritt konnte noch nicht ermittelt werden. Bitte gleich erneut versuchen.');
    await rpc('turn/interrupt', { threadId: state.thread.id, turnId: state.turnId });
  } catch (error) { notice(error); }
  finally { $('stop').disabled = false; }
}

function newChat() {
  state.loadVersion++;
  state.opening = false;
  state.thread = null;
  resetRuntimeSettings();
  setRunning(false);
  clearMessages();
  $('welcome').hidden = false;
  $('thread-title').textContent = 'Neues Gespräch';
  const url = new URL(location.href);
  url.searchParams.delete('thread');
  history.replaceState({}, '', url);
  renderThreads();
  closeSidebar();
  $('prompt').focus();
}

function connectEvents() {
  state.source?.close();
  const source = new EventSource('/api/events');
  state.source = source;
  source.onopen = async () => {
    try {
      await loadStatus();
      await loadRequests();
      if (state.thread && !state.sending) {
        const result = await rpc('thread/read', { threadId: state.thread.id, includeTurns: true });
        if (result.thread?.id === state.thread?.id) syncThread(result.thread);
      }
    } catch (error) { notice(error); }
  };
  source.onerror = () => setConnection(false, 'Verbindung wird erneuert …');
  source.onmessage = (event) => {
    try { handleEvent(JSON.parse(event.data)); } catch (error) { console.warn('Ereignis konnte nicht verarbeitet werden.', error.message); }
  };
}

function handleEvent(event) {
  const params = event.params || {};
  const method = event.method || event.type;
  if (event.id !== undefined && event.method) {
    renderRequest(event);
    return;
  }
  if (['serverRequest/resolved', 'request/resolved'].includes(method)) {
    const resolvedId = String(params.requestId ?? params.id);
    state.requests.get(resolvedId)?.remove();
    state.requests.delete(resolvedId);
    return;
  }
  if (['connection', 'status', 'bridge/status', 'web/status'].includes(method)) {
    const connected = params.connected ?? event.connected;
    if (connected !== undefined) setConnection(connected);
    return;
  }
  if (method === 'thread/name/updated') {
    const thread = allThreads().find((candidate) => candidate.id === params.threadId);
    if (thread) thread.name = params.threadName || params.name;
    if (state.thread?.id === params.threadId) {
      state.thread.name = params.threadName || params.name;
      $('thread-title').textContent = threadName(state.thread);
    }
    renderThreads();
  }
  if (['account/rateLimits/updated', 'account/rate_limits/updated'].includes(method)) {
    updateUsage(params);
    return;
  }
  if (method === 'turn/completed' && params.threadId) {
    void loadRuntime();
    state.completionVersions.set(params.threadId, (state.completionVersions.get(params.threadId) || 0) + 1);
    if (state.completionVersions.size > 200) state.completionVersions.delete(state.completionVersions.keys().next().value);
    const completedId = params.turn?.id || params.turnId;
    if (completedId) {
      state.completedTurns.add(`${params.threadId}:${completedId}`);
      if (state.completedTurns.size > 200) state.completedTurns.delete(state.completedTurns.values().next().value);
    }
  }
  if (!state.thread || params.threadId !== state.thread.id) return;
  if (method === 'turn/started') {
    const turnId = params.turn?.id || params.turnId;
    if (!state.completedTurns.has(`${params.threadId}:${turnId}`)) setRunning(true, turnId);
  }
  if (method === 'turn/completed') {
    setRunning(false);
    if (params.turn?.error) notice(params.turn.error.message || params.turn.error);
    void reconcileThread();
    void refreshThreads();
  }
  if (method === 'thread/status/changed' && params.status) setRunning(isRunning(params.status));
  if (method === 'item/started' || method === 'item/completed') {
    if (params.item?.type === 'userMessage') {
      for (const [id, entry] of state.items) if (entry.item._optimistic) { entry.element.remove(); state.items.delete(id); }
    }
    renderItem(params.item, params.turnId);
  }
  if (method === 'item/agentMessage/delta') {
    const current = state.items.get(params.itemId)?.item;
    if (!state.running && !current) return;
    renderItem({ ...current, id: params.itemId, type: 'agentMessage', text: (current?.text || '') + (params.delta || '') }, params.turnId);
  }
  if (method === 'item/commandExecution/outputDelta') {
    const current = state.items.get(params.itemId)?.item;
    if (current) renderItem({ ...current, aggregatedOutput: (current.aggregatedOutput || '') + (params.delta || '') }, params.turnId);
  }
  if (method === 'error' && params.error) notice(params.error.message || params.error);
}

async function reconcileThread() {
  const id = state.thread?.id;
  const version = state.loadVersion;
  if (!id) return;
  try {
    const result = await rpc('thread/read', { threadId: id, includeTurns: true });
    if (state.thread?.id === id && version === state.loadVersion && !state.sending) syncThread(result.thread);
  } catch (error) { notice(error); }
}

async function loadRequests() {
  try {
    const result = await api('/api/requests');
    const ids = new Set((result.requests || []).map((request) => String(request.id)));
    for (const [id, entry] of state.requests) if (!ids.has(id)) { entry.remove(); state.requests.delete(id); }
    for (const request of result.requests || []) renderRequest(request);
  } catch (error) { notice(error); }
}

function renderRequest(request) {
  const id = String(request.id);
  if (state.requests.has(id)) return;
  const params = request.params || {};
  const card = document.createElement('section');
  card.className = 'request-card';
  const title = document.createElement('h3');
  title.textContent = request.method.includes('requestUserInput') ? 'Codex hat eine Rückfrage' : 'Codex benötigt eine Freigabe';
  const context = document.createElement('p');
  context.textContent = params.command || params.reason || request.method;
  card.append(title, context);
  const fields = [];
  if (request.method.includes('requestUserInput')) {
    for (const question of params.questions || []) {
      const label = document.createElement('label');
      label.textContent = question.question || question.header || 'Deine Antwort';
      const choices = document.createElement('select');
      if (question.options?.length) {
        choices.add(new Option('Antwort auswählen …', ''));
        for (const option of question.options) choices.add(new Option(option.label, option.label));
        choices.add(new Option('Eigene Antwort …', '__custom__'));
      }
      const input = document.createElement('input');
      input.type = question.isSecret ? 'password' : 'text';
      input.placeholder = 'Deine Antwort';
      label.append(input);
      if (question.options?.length) {
        label.insertBefore(choices, input);
        input.hidden = true;
        choices.addEventListener('change', () => { input.hidden = choices.value !== '__custom__'; });
      }
      fields.push({ id: question.id, input, choices, hasOptions: Boolean(question.options?.length) });
      card.append(label);
    }
    addRequestButton(card, 'Antwort senden', async () => {
      const answers = {};
      for (const field of fields) {
        const answer = field.hasOptions && field.choices.value !== '__custom__' ? field.choices.value : field.input.value.trim();
        if (!answer) throw new Error('Bitte beantworte alle Fragen.');
        answers[field.id] = { answers: [answer] };
      }
      await respond(request.id, { answers }, card);
    });
  } else if (request.method.includes('requestApproval')) {
    addRequestButton(card, 'Einmal erlauben', () => respond(request.id, { decision: 'accept' }, card));
    addRequestButton(card, 'Ablehnen', () => respond(request.id, { decision: 'decline' }, card), true);
  } else {
    const hint = document.createElement('p');
    hint.textContent = 'Diese Anfrage bitte in der Codex-Anwendung beantworten.';
    card.append(hint);
  }
  if (params.threadId && params.threadId !== state.thread?.id) {
    const link = document.createElement('button');
    link.textContent = 'Zugehöriges Gespräch öffnen';
    link.className = 'request-secondary';
    link.addEventListener('click', () => openThread(params.threadId));
    card.append(link);
  }
  state.requests.set(id, card);
  $('composer').before(card);
}

function addRequestButton(card, text, action, secondary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = secondary ? 'request-secondary' : 'request-primary';
  button.textContent = text;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); } catch (error) { notice(error); } finally { button.disabled = false; }
  });
  card.append(button);
}

async function respond(id, result, card) {
  await api('/api/respond', { id, result });
  card.remove();
  state.requests.delete(String(id));
}

function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-shade').hidden = true; }
$('open-sidebar').addEventListener('click', () => { $('sidebar').classList.add('open'); $('sidebar-shade').hidden = false; });
$('close-sidebar').addEventListener('click', closeSidebar);
$('sidebar-shade').addEventListener('click', closeSidebar);
$('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
$('new-chat').addEventListener('click', newChat);
for (const scope of ['project', 'unassigned']) {
  const nav = $(`${scope}-threads`);
  const pane = state.panes[scope];
  const moreOnUserScroll = () => {
    if (!pane.scrollIntent || Date.now() - pane.scrollIntent > 1200) return;
    if (nav.scrollTop > 0 && nav.scrollHeight - nav.clientHeight - nav.scrollTop < 35) {
      pane.scrollIntent = 0;
      void loadPane(scope, 'more');
    }
  };
  $(`refresh-${scope}`).addEventListener('click', () => loadPane(scope));
  nav.addEventListener('scroll', moreOnUserScroll, { passive: true });
  nav.addEventListener('wheel', (event) => {
    if (event.deltaY > 0) { pane.scrollIntent = Date.now(); requestAnimationFrame(moreOnUserScroll); }
  }, { passive: true });
  nav.addEventListener('touchmove', () => { pane.scrollIntent = Date.now(); }, { passive: true });
  nav.addEventListener('pointerdown', (event) => { if (event.target === nav) pane.scrollIntent = Date.now(); });
  nav.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) { pane.scrollIntent = Date.now(); requestAnimationFrame(moreOnUserScroll); }
  });
}
$('project').addEventListener('change', () => {
  const project = $('project').value;
  if (state.thread) newChat();
  setProject(project);
  updateComposer();
});
$('model').addEventListener('change', () => {
  state.settings.model = $('model').value;
  const model = selectedModel();
  const efforts = (model?.supportedReasoningEfforts || []).map((item) => item.reasoningEffort);
  if (!efforts.includes(state.settings.effort)) {
    const configured = state.runtime.defaults.effort || state.runtime.defaults.reasoningEffort;
    state.settings.effort = efforts.includes(configured) ? configured : model?.defaultReasoningEffort || efforts[0] || '';
  }
  const tiers = ['default', ...(model?.serviceTiers || []).map((tier) => tier.id)];
  if (!tiers.includes(state.settings.serviceTier)) state.settings.serviceTier = model?.defaultServiceTier || 'default';
  renderRuntimeControls();
  renderUsage();
});
$('effort').addEventListener('change', () => { state.settings.effort = $('effort').value; });
$('service-tier').addEventListener('change', () => { state.settings.serviceTier = $('service-tier').value; });
$('usage-toggle').addEventListener('click', () => {
  $('usage-panel').hidden = !$('usage-panel').hidden;
  $('usage-toggle').setAttribute('aria-expanded', String(!$('usage-panel').hidden));
});
$('usage-close').addEventListener('click', () => { $('usage-panel').hidden = true; $('usage-toggle').setAttribute('aria-expanded', 'false'); });
$('composer').addEventListener('submit', sendMessage);
$('stop').addEventListener('click', stopTurn);
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.running) $('composer').requestSubmit(); }
});
$('prompt').addEventListener('input', () => { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 180)}px`; });
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('login-form').querySelector('button');
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/api/login', { password: $('password').value });
    $('password').value = '';
    await init();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', {});
    state.thread = null;
    for (const pane of Object.values(state.panes)) { pane.version++; pane.items = []; pane.cursor = null; pane.initialized = false; }
    state.settingsReady = false;
    clearMessages();
    for (const card of state.requests.values()) card.remove();
    state.requests.clear();
    showLogin();
  } catch (error) { notice(error); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('app').hidden) { void loadStatus().catch(notice); void reconcileThread(); void loadRequests(); void loadRuntime(); }
});
setInterval(() => {
  if (!$('app').hidden && !document.hidden) {
    void loadStatus().catch(notice);
    if (state.requests.size) void loadRequests();
  }
}, 15000);
setInterval(() => { if (!$('app').hidden && !document.hidden) void loadRuntime(); }, 60000);
void init();
