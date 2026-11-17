// HTTP security and session integration tests added by the remodex-web fork.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createWebServer } from '../server.js';

const secret = () => randomBytes(32).toString('base64url');

async function fixture(t, options = {}) {
  const password = secret();
  const bridge = Object.assign(new EventEmitter(), {
    token: secret(),
    url: new URL('ws://gateway.invalid/codex'),
    status: { connected: true, error: null },
    requests: new Map(),
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      return { data: [] };
    },
    answer() { throw new Error('No pending request in this fixture'); },
  });
  const server = await createWebServer({ password, bridge, hostLabel: 'test-host', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, json, headers, ...init } = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', json: { password } });
    assert.equal(response.status, 200);
    await response.json();
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { bridge, password, request, login, base };
}

test('API reads, event streams, and mutations require a valid browser login', async t => {
  const { request, bridge } = await fixture(t);
  for (const path of ['/api/status', '/api/events', '/api/requests', '/api/projects']) {
    const response = await request(path);
    assert.equal(response.status, 401, path);
    await response.json();
  }
  const response = await request('/api/rpc', {
    method: 'POST', json: { method: 'thread/list' },
  });
  assert.equal(response.status, 401);
  await response.json();
  const forged = await request('/api/status', { cookie: `remodex_web_session=${secret()}` });
  assert.equal(forged.status, 401);
  await forged.json();
  assert.deepEqual(bridge.calls, []);
});

test('failed login creates no session; successful login issues a protected working cookie', async t => {
  const { password, request } = await fixture(t, { secureCookie: true });
  const denied = await request('/api/login', { method: 'POST', json: { password: secret() } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('set-cookie'), null);
  await denied.json();

  const accepted = await request('/api/login', { method: 'POST', json: { password } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true });
  const header = accepted.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Secure']) assert.ok(header.includes(flag));
  assert.ok(!header.includes(password));
  const status = await request('/api/status', { cookie: header.split(';')[0] });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).authenticated, true);
});

test('foreign origins and cross-site requests cannot log in or invoke authenticated RPC', async t => {
  const { password, request, login, bridge, base } = await fixture(t);
  const cookie = await login();
  for (const headers of [
    { Origin: 'https://foreign.invalid' },
    { Origin: 'not-an-origin' },
    { Origin: base, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    for (const [path, json] of [
      ['/api/login', { password }],
      ['/api/rpc', { method: 'thread/list' }],
    ]) {
      const response = await request(path, { method: 'POST', cookie, headers, json });
      assert.equal(response.status, 403);
      await response.json();
    }
  }
  const allowed = await request('/api/rpc', {
    method: 'POST', cookie, headers: { Origin: base }, json: { method: 'thread/list', params: { limit: 5 } },
  });
  assert.equal(allowed.status, 200);
  await allowed.json();
  assert.deepEqual(bridge.calls, [{ method: 'thread/list', params: { limit: 5 } }]);
});

test('RPC allowlist blocks arbitrary gateway commands and rejects malformed parameters', async t => {
  const { request, login, bridge } = await fixture(t);
  const cookie = await login();
  for (const method of ['command/exec', 'fs/readFile', 'account/login/start', 'initialize', '__proto__']) {
    const response = await request('/api/rpc', { method: 'POST', cookie, json: { method, params: {} } });
    assert.equal(response.status, 403, method);
    await response.json();
  }
  for (const params of [null, [], 'invalid']) {
    const response = await request('/api/rpc', {
      method: 'POST', cookie, json: { method: 'thread/list', params },
    });
    assert.equal(response.status, 400);
    await response.json();
  }
  assert.deepEqual(bridge.calls, []);
});

test('authenticated SSE delivers live events and logout closes the stream and revokes its cookie', { timeout: 5000 }, async t => {
  const { request, login, bridge } = await fixture(t);
  const cookie = await login();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await request('/api/events', { cookie, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), ': connected\n\n');
  const event = { method: 'turn/completed', params: { threadId: randomBytes(8).toString('hex') } };
  bridge.emit('message', event);
  const update = await reader.read();
  assert.equal(new TextDecoder().decode(update.value), `data: ${JSON.stringify(event)}\n\n`);

  const logout = await request('/api/logout', { method: 'POST', cookie, json: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  await logout.json();
  assert.equal((await reader.read()).done, true);
  bridge.emit('message', event);
  for (const path of ['/api/status', '/api/events']) {
    const revoked = await request(path, { cookie });
    assert.equal(revoked.status, 401);
    await revoked.json();
  }
});

test('public health is minimal and authenticated status omits gateway credentials and location', async t => {
  const { request, login, bridge, password } = await fixture(t);
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const status = await request('/api/status', { cookie: await login() });
  assert.equal(status.status, 200);
  const body = await status.text();
  assert.deepEqual(JSON.parse(body), {
    connected: true, error: null, authenticated: true, hostLabel: 'test-host',
  });
  for (const value of [bridge.token, password, bridge.url.href, bridge.url.hostname]) assert.ok(!body.includes(value));
});

test('only the explicit static asset paths are served; source and traversal paths remain inaccessible', async t => {
  const { request, login } = await fixture(t);
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    await response.text();
  }
  const cookie = await login();
  for (const path of ['/server.js', '/codex.js', '/package.json', '/.env', '/public/index.html', '/%2e%2e%2fserver.js']) {
    const response = await request(path, { cookie });
    assert.equal(response.status, 404, path);
    await response.json();
  }
});
