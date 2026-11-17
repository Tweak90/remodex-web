// Runtime privacy and complete lazy pagination tests for the Asgard Codex fork.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createCatalog, readRuntime } from '../catalog.js';
import { createWebServer } from '../server.js';

const secret = () => randomBytes(24).toString('base64url');
const query = values => new URLSearchParams(values);

function threadBridge(threads, nativeProjects = []) {
  return {
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'project/list') return { data: nativeProjects, nextCursor: null };
      assert.equal(method, 'thread/list');
      let filtered = threads;
      if (params.cwd) filtered = filtered.filter(thread => thread.cwd === params.cwd);
      if (Object.hasOwn(params, 'projectId')) filtered = filtered.filter(thread => (thread.projectId || null) === params.projectId);
      const offset = Number(params.cursor || 0);
      const data = filtered.slice(offset, offset + params.limit);
      return { data, nextCursor: offset + data.length < filtered.length ? String(offset + data.length) : null };
    },
  };
}

test('100 interleaved threads remain reachable: ten filtered chats first, then five without preload or skipped cursors', async () => {
  const threads = Array.from({ length: 100 }, (_, index) => ({
    id: `thread-${index}`, cwd: index % 5 === 0 ? '/unassigned' : '/known', projectId: null,
  }));
  const bridge = threadBridge(threads);
  const catalog = createCatalog({ bridge, projects: [{ name: 'Known', path: '/known' }] });
  await catalog.readProjects();
  assert.equal(bridge.calls.filter(call => call.method === 'thread/list').length, 0);

  const collected = [];
  let cursor;
  let pages = 0;
  do {
    const pageLimit = pages === 0 ? 10 : 5;
    const start = bridge.calls.length;
    const page = await catalog.listThreads(query({ scope: 'unassigned', limit: String(pageLimit), ...(cursor ? { cursor } : {}) }), 'browser-session');
    assert.equal(page.data.length, pages === 0 ? 10 : pages < 3 ? 5 : 0);
    let remaining = pageLimit;
    for (const { method, params } of bridge.calls.slice(start)) if (method === 'thread/list') {
      assert.ok(params.limit <= remaining);
      assert.equal(params.projectId, null);
      const offset = Number(params.cursor || 0);
      remaining -= threads.slice(offset, offset + params.limit).filter(thread => thread.cwd !== '/known').length;
    }
    collected.push(...page.data.map(thread => thread.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 4);
  assert.deepEqual(collected, threads.filter(thread => thread.cwd === '/unassigned').map(thread => thread.id));
  assert.equal(new Set(collected).size, 20);
  assert.ok(bridge.calls.filter(call => call.method === 'thread/list').every(call => call.params.limit <= 10));
});

test('sparse matches beyond one hundred records fill the first page rather than creating an unreachable empty page', async () => {
  const threads = Array.from({ length: 180 }, (_, index) => ({ id: String(index), cwd: index < 170 ? '/known' : '/loose' }));
  const bridge = threadBridge(threads);
  const catalog = createCatalog({ bridge, projects: [{ path: '/known' }] });
  const page = await catalog.listThreads(query({ scope: 'unassigned', limit: '10' }), 'session');
  assert.deepEqual(page.data.map(thread => thread.id), threads.slice(170).map(thread => thread.id));
  assert.equal(page.nextCursor, null);
});

test('project uses native cwd before pagination, other excludes that cwd, and cursors are bound to scope, project, and login', async () => {
  const threads = Array.from({ length: 50 }, (_, index) => ({ id: String(index), cwd: index % 2 ? '/second' : '/first' }));
  const bridge = threadBridge(threads);
  const catalog = createCatalog({ bridge, projects: [{ path: '/first' }, { path: '/second' }] });
  const first = await catalog.listThreads(query({ scope: 'project', project: '/first', limit: '10' }), 'session-one');
  assert.deepEqual(first.data.map(thread => thread.id), threads.filter(thread => thread.cwd === '/first').slice(0, 10).map(thread => thread.id));
  const native = bridge.calls.find(call => call.method === 'thread/list');
  assert.equal(native.params.cwd, '/first');
  assert.equal(native.params.limit, 10);
  const next = await catalog.listThreads(query({ scope: 'project', project: '/first', limit: '5', cursor: first.nextCursor }), 'session-one');
  assert.deepEqual(next.data.map(thread => thread.id), threads.filter(thread => thread.cwd === '/first').slice(10, 15).map(thread => thread.id));
  for (const [scope, project, session] of [
    ['other', '/first', 'session-one'], ['project', '/second', 'session-one'], ['project', '/first', 'session-two'],
  ]) {
    await assert.rejects(catalog.listThreads(query({ scope, project, cursor: first.nextCursor }), session), { status: 400 });
  }
  const other = await catalog.listThreads(query({ scope: 'other', project: '/first' }), 'session-one');
  assert.deepEqual(other.data.map(thread => thread.id), threads.filter(thread => thread.cwd === '/second').slice(0, 10).map(thread => thread.id));
  await assert.rejects(catalog.listThreads(query({ scope: 'project', project: '/first', cursor: `${first.nextCursor}tampered` }), 'session-one'), { status: 400 });
});

test('native projects include all legacy root chats, native assignment wins over cwd, and no chat is lost', async () => {
  const threads = [
    { id: 'native-member', projectId: 'native-id', cwd: '/different-working-tree' },
    { id: 'configured', projectId: null, cwd: '/configured' },
    { id: 'native-root-legacy', projectId: null, cwd: '/native-root' },
    { id: 'second-root-legacy', projectId: null, cwd: '/second-root' },
    { id: 'other-native-assignment', projectId: 'other-native-id', cwd: '/native-root' },
    { id: 'loose', projectId: null, cwd: '/elsewhere' },
    { id: 'empty-cwd', projectId: null },
  ];
  const bridge = threadBridge(threads, [
    { id: 'native-id', name: 'Native', roots: [{ path: '/native-root' }, { path: '/second-root' }] },
    { id: 'other-native-id', name: 'Other Native', roots: [{ path: '/other-native-root' }] },
  ]);
  const catalog = createCatalog({ bridge, projects: [{ name: 'Configured', path: '/configured' }] });
  assert.deepEqual((await catalog.readProjects()).map(project => project.path), ['/configured', '/native-root', '/second-root', '/other-native-root']);
  const native = await catalog.listThreads(query({ scope: 'project', project: '/native-root' }), 'session');
  assert.deepEqual(native.data.map(thread => thread.id), ['native-member', 'native-root-legacy', 'second-root-legacy']);
  const secondRoot = await catalog.listThreads(query({ scope: 'project', project: '/second-root' }), 'session');
  assert.deepEqual(secondRoot.data, native.data);
  const nativeCalls = bridge.calls.filter(call => call.method === 'thread/list');
  assert.ok(nativeCalls.every(call => !Object.hasOwn(call.params, 'projectId') && !Object.hasOwn(call.params, 'cwd')));
  const other = await catalog.listThreads(query({ scope: 'other', project: '/native-root' }), 'session');
  assert.deepEqual(other.data.map(thread => thread.id), threads.filter(thread => !native.data.some(member => member.id === thread.id)).map(thread => thread.id));
  const unassigned = await catalog.listThreads(query({ scope: 'unassigned' }), 'session');
  assert.deepEqual(unassigned.data.map(thread => thread.id), ['loose', 'empty-cwd']);
  const visible = new Set(unassigned.data.map(thread => thread.id));
  for (const project of await catalog.readProjects()) {
    const page = await catalog.listThreads(query({ scope: 'project', project: project.path }), 'session');
    for (const thread of page.data) visible.add(thread.id);
  }
  assert.deepEqual([...visible].sort(), threads.map(thread => thread.id).sort());
});

test('invalid sizes and scopes are rejected and repeated backend cursors terminate with a useful error', async () => {
  const bridge = threadBridge([]);
  const catalog = createCatalog({ bridge });
  for (const input of [{ scope: 'all' }, { scope: 'project' }, { scope: 'unassigned', limit: '100' }, { scope: 'unassigned', limit: '0' }])
    await assert.rejects(catalog.listThreads(query(input), 'session'), { status: 400 });
  assert.deepEqual(bridge.calls, []);
  bridge.call = async method => method === 'project/list' ? { data: [] } : { data: [], nextCursor: 'repeated-cursor' };
  await assert.rejects(catalog.listThreads(query({ scope: 'unassigned' }), 'session'), { status: 502 });
});

test('runtime returns live models, only three configuration defaults, and allowlisted quota fields', async () => {
  const privateValue = secret();
  const calls = [];
  const runtime = await readRuntime({ async call(method, params) {
    calls.push({ method, params });
    if (method === 'model/list') return { data: [{
      id: 'live-model', model: 'live-model', displayName: 'Live Model', hidden: false, isDefault: true,
      defaultReasoningEffort: 'high', defaultServiceTier: 'priority', accountId: privateValue, secret: privateValue,
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'More reasoning', secret: privateValue }],
      serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority service', accountId: privateValue }],
    }] };
    if (method === 'config/read') return { config: {
      model: 'live-model', model_reasoning_effort: 'high', service_tier: 'fast',
      developer_instructions: privateValue, mcp_servers: { token: privateValue },
    }, layers: [{ config: { token: privateValue } }], origins: { secret: privateValue } };
    return { accountId: privateValue, rateLimitUpsell: { tracking: privateValue }, ordinaryUsageAllowed: false,
      rateLimits: { primary: { usedPercent: 87, resetsAt: 1234, windowDurationMins: 300, accountId: privateValue }, token: privateValue },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 12 }, accountId: privateValue } } };
  } });
  assert.deepEqual(runtime.defaults, { model: 'live-model', effort: 'high', serviceTier: 'fast' });
  assert.equal(runtime.models[0].id, 'live-model');
  assert.deepEqual(runtime.models[0].supportedReasoningEfforts, [{ reasoningEffort: 'high', description: 'More reasoning' }]);
  assert.deepEqual(runtime.models[0].serviceTiers, [{ id: 'priority', name: 'Fast', description: 'Priority service' }]);
  assert.equal(runtime.models[0].defaultServiceTier, 'priority');
  assert.equal(runtime.usage.rateLimits.primary.usedPercent, 87);
  assert.equal(runtime.usage.rateLimitsByLimitId.codex.primary.usedPercent, 12);
  assert.equal(runtime.usage.ordinaryUsageAllowed, false);
  assert.ok(!JSON.stringify(runtime).includes(privateValue));
  assert.deepEqual(calls.map(call => call.method).sort(), ['account/rateLimits/read', 'config/read', 'model/list']);
  assert.deepEqual(calls.find(call => call.method === 'config/read').params, { includeLayers: false });
});

test('optional quota failure does not hide model controls or expose backend error messages', async () => {
  const privateValue = secret();
  const runtime = await readRuntime({ async call(method) {
    if (method === 'model/list') return { data: [{ id: 'available-model' }] };
    if (method === 'config/read') return { config: {} };
    throw new Error(privateValue);
  } });
  assert.equal(runtime.models[0].id, 'available-model');
  assert.equal(runtime.availability.usage, false);
  assert.equal(runtime.usage.ordinaryUsageAllowed, null);
  assert.ok(!JSON.stringify(runtime).includes(privateValue));
});

test('runtime and thread routes require login, raw config RPC stays blocked, and quota SSE strips account identity', { timeout: 5000 }, async t => {
  const privateValue = secret();
  const password = secret();
  const bridge = Object.assign(new EventEmitter(), {
    status: { connected: true }, requests: new Map(),
    async call(method) {
      if (method === 'model/list') return { data: [{ id: 'http-model' }] };
      if (method === 'config/read') return { config: { model: 'http-model', developer_instructions: privateValue } };
      if (method === 'account/rateLimits/read') return { accountId: privateValue, rateLimits: {} };
      return { data: [], nextCursor: null };
    },
  });
  const server = await createWebServer({ password, bridge });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/runtime', '/api/threads?scope=unassigned']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 401);
    await response.json();
  }
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  await login.json();
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const runtime = await fetch(`${base}/api/runtime`, { headers });
  assert.equal(runtime.status, 200);
  const body = await runtime.text();
  assert.equal(JSON.parse(body).models[0].id, 'http-model');
  assert.ok(!body.includes(privateValue));
  const blocked = await fetch(`${base}/api/rpc`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'config/read' }),
  });
  assert.equal(blocked.status, 403);
  await blocked.json();
  const threads = await fetch(`${base}/api/threads?scope=unassigned`, { headers });
  assert.equal(threads.status, 200);
  assert.deepEqual(await threads.json(), { data: [], nextCursor: null });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
  const reader = events.body.getReader();
  await reader.read();
  for (const method of ['account/rateLimits/updated', 'account/rate_limits/updated']) {
    bridge.emit('message', { method, params: { accountId: privateValue, rateLimits: { primary: { usedPercent: 20 } } } });
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.ok(!event.includes(privateValue));
    assert.match(event, /"usedPercent":20/);
  }
  controller.abort();
});
