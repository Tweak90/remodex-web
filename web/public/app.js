/* remodex-web: independent browser client for an existing Codex environment. */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  threads: [], cursor: null, thread: null, project: '', connected: false,
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
    void loadThreads();
    void loadRequests();
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
    await Promise.all([loadProjects(), loadThreads()]);
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
    $('project').replaceChildren(new Option('Projekt wählen …', ''));
    for (const project of result.projects || []) {
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

async function loadThreads(append = false) {
  $('refresh').disabled = true;
  try {
    const result = await rpc('thread/list', {
      limit: 50, sortKey: 'updated_at', ...(append && state.cursor ? { cursor: state.cursor } : {}),
    });
    const threads = result.data || result.threads || [];
    state.threads = append ? [...state.threads, ...threads.filter((t) => !state.threads.some((old) => old.id === t.id))] : threads;
    state.cursor = result.nextCursor || null;
    renderThreads();
  } catch (error) { notice(error); }
  finally { $('refresh').disabled = false; }
}

function renderThreads() {
  $('threads').replaceChildren();
  if (!state.threads.length) {
    const empty = document.createElement('p');
    empty.className = 'thread-empty';
    empty.textContent = 'Hier erscheinen deine Gespräche aus der bestehenden Codex-Umgebung.';
    $('threads').append(empty);
  }
  for (const thread of state.threads) {
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
    $('threads').append(button);
  }
  $('load-more').hidden = !state.cursor;
}

function updateComposer() {
  $('send').disabled = state.sending || state.opening || state.running || !state.connected;
  $('send').hidden = state.running;
  $('stop').hidden = !state.running;
  $('run-state').hidden = !state.running;
  $('composer-context').textContent = state.thread?.cwd || state.project || 'Wähle links ein Projekt für ein neues Gespräch.';
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
  state.project = thread.cwd || state.project;
  if (thread.cwd && ![...$('project').options].some((option) => option.value === thread.cwd)) {
    $('project').add(new Option(baseName(thread.cwd), thread.cwd));
  }
  $('project').value = state.project;
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
      const created = await rpc('thread/start', { cwd: state.project });
      if (sendVersion !== state.loadVersion) return;
      state.thread = created.thread;
      if (!state.thread?.id) throw new Error('Codex hat kein Gespräch zurückgegeben.');
      $('thread-title').textContent = threadName(state.thread);
      const url = new URL(location.href);
      url.searchParams.set('thread', state.thread.id);
      history.replaceState({}, '', url);
      state.threads.unshift(state.thread);
      renderThreads();
    }
    optimisticId = `optimistic:${Date.now()}`;
    renderItem({ id: optimisticId, type: 'userMessage', content: [{ type: 'text', text }], _optimistic: true });
    const threadId = state.thread.id;
    const completionVersion = state.completionVersions.get(threadId) || 0;
    const result = await rpc('turn/start', { threadId, input: [{ type: 'text', text }] });
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
    const thread = state.threads.find((candidate) => candidate.id === params.threadId);
    if (thread) thread.name = params.threadName || params.name;
    if (state.thread?.id === params.threadId) {
      state.thread.name = params.threadName || params.name;
      $('thread-title').textContent = threadName(state.thread);
    }
    renderThreads();
  }
  if (method === 'turn/completed' && params.threadId) {
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
    void loadThreads();
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
$('refresh').addEventListener('click', () => loadThreads());
$('load-more').addEventListener('click', () => loadThreads(true));
$('project').addEventListener('change', () => { state.project = $('project').value; if (state.thread) newChat(); updateComposer(); });
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
    state.threads = [];
    clearMessages();
    for (const card of state.requests.values()) card.remove();
    state.requests.clear();
    showLogin();
  } catch (error) { notice(error); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('app').hidden) { void loadStatus().catch(notice); void reconcileThread(); void loadRequests(); }
});
setInterval(() => {
  if (!$('app').hidden && !document.hidden) {
    void loadStatus().catch(notice);
    if (state.requests.size) void loadRequests();
  }
}, 15000);
void init();
