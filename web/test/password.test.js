// Persistent password changes, session revocation, and auth race integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebServer } from '../server.js';
import { createPasswordStore } from '../auth.js';

const secret = () => randomBytes(32).toString('base64url');
const bootstrap = () => randomBytes(3).toString('base64url');

async function fixture(t, { password = bootstrap(), authStateFile } = {}) {
  const bridge = Object.assign(new EventEmitter(), { status: { connected: true }, requests: new Map() });
  const server = await createWebServer({ password, authStateFile, bridge });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { cookie, body, headers, signal } = {}) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal,
  });
  const login = async (candidate = password) => {
    const response = await request('/api/login', { body: { password: candidate } });
    await response.json();
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const change = (cookie, currentPassword, newPassword, confirmation = newPassword, headers) => request('/api/password', {
    cookie, headers, body: { currentPassword, newPassword, confirmation },
  });
  return { password, request, login, change, close };
}

async function privatePath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'remodex-auth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'private', 'auth.json');
}

test('a four-character private bootstrap can change to a long password, surviving restart independently of the environment', async t => {
  const authStateFile = await privatePath(t);
  const app = await fixture(t, { authStateFile });
  assert.equal(app.password.length, 4);
  const first = await app.login();
  assert.equal(first.status, 200);
  const newPassword = secret();
  const changed = await app.change(first.cookie, app.password, newPassword);
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { ok: true });
  const freshCookie = changed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(freshCookie, first.cookie);
  const current = await app.request('/api/status', { cookie: freshCookie });
  assert.equal(current.status, 200);
  await current.json();
  const raw = await readFile(authStateFile, 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.algorithm, 'scrypt');
  assert.notEqual(record.salt, record.hash);
  assert.equal(Object.hasOwn(record, 'password'), false);
  assert.ok(!Object.values(record).includes(app.password));
  assert.ok(!raw.includes(newPassword));
  assert.equal((await stat(authStateFile)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(authStateFile))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dirname(authStateFile)), ['auth.json']);
  await app.close();
  const restarted = await fixture(t, { password: app.password, authStateFile });
  assert.equal((await restarted.login(app.password)).status, 401);
  assert.equal((await restarted.login(newPassword)).status, 200);
});

test('password changes require login, same origin, the correct current password, confirmation, and bounded input', async t => {
  const app = await fixture(t);
  const newPassword = secret();
  const unauthenticated = await app.change(undefined, app.password, newPassword);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.json();
  const { cookie } = await app.login();
  const foreign = await app.change(cookie, app.password, newPassword, newPassword, { Origin: 'https://foreign.invalid' });
  assert.equal(foreign.status, 403);
  await foreign.json();
  for (const [current, replacement, confirmation, expected] of [
    [secret(), newPassword, newPassword, 403],
    [app.password, newPassword, secret(), 400],
    [app.password, bootstrap(), bootstrap(), 400],
    [app.password, secret().repeat(25), '', 400],
    [secret().repeat(25), newPassword, newPassword, 403],
  ]) {
    const denied = await app.change(cookie, current, replacement, confirmation);
    assert.equal(denied.status, expected);
    assert.equal(denied.headers.get('set-cookie'), null);
    await denied.json();
  }
  const stillAuthenticated = await app.request('/api/status', { cookie });
  assert.equal(stillAuthenticated.status, 200);
  await stillAuthenticated.json();
  assert.equal((await app.login()).status, 200);
});

test('successful changes revoke every old session and close every SSE stream while issuing a fresh caller session', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const first = await app.login();
  const second = await app.login();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await app.request('/api/events', { cookie: second.cookie, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();
  const changed = await app.change(first.cookie, app.password, secret());
  assert.equal(changed.status, 200);
  await changed.json();
  const freshCookie = changed.headers.get('set-cookie').split(';')[0];
  assert.equal((await reader.read()).done, true);
  for (const cookie of [first.cookie, second.cookie]) {
    const response = await app.request('/api/status', { cookie });
    assert.equal(response.status, 401);
    await response.json();
  }
  const refreshed = await app.request('/api/status', { cookie: freshCookie });
  assert.equal(refreshed.status, 200);
  await refreshed.json();
});

test('invalid JSON, unsupported scrypt parameters, and malformed stored hashes fail closed without rewriting the file', async t => {
  const authStateFile = await privatePath(t);
  await createPasswordStore({ password: bootstrap(), authStateFile });
  const original = JSON.parse(await readFile(authStateFile, 'utf8'));
  for (const value of [
    '{broken json',
    JSON.stringify({ ...original, parameters: { ...original.parameters, N: 2 ** 30 } }),
    JSON.stringify({ ...original, hash: secret() }),
    JSON.stringify({ ...original, algorithm: 'unsupported' }),
    JSON.stringify(null),
  ]) {
    await writeFile(authStateFile, value, { mode: 0o600 });
    await assert.rejects(createPasswordStore({ password: bootstrap(), authStateFile }), error => error.status === 503 && !error.message.includes(authStateFile));
    assert.equal(await readFile(authStateFile, 'utf8'), value);
  }
});

test('failed persistence preserves the previous password, sessions, and private file without leaking paths', async t => {
  const authStateFile = await privatePath(t);
  const app = await fixture(t, { authStateFile });
  const { cookie } = await app.login();
  const original = await readFile(authStateFile, 'utf8');
  const directory = dirname(authStateFile);
  const displaced = `${directory}-saved`;
  await rename(directory, displaced);
  await writeFile(directory, secret());
  const failed = await app.change(cookie, app.password, secret());
  assert.equal(failed.status, 503);
  const error = await failed.text();
  assert.ok(!error.includes(directory));
  assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal(await readFile(join(displaced, 'auth.json'), 'utf8'), original);
  const active = await app.request('/api/status', { cookie });
  assert.equal(active.status, 200);
  await active.json();
  assert.equal((await app.login()).status, 200);
});

test('login and current-password verification share the same brute-force limit', async t => {
  const app = await fixture(t);
  const { cookie } = await app.login();
  const newPassword = secret();
  for (let index = 0; index < 5; index++) assert.equal((await app.login(secret())).status, 401);
  for (let index = 0; index < 5; index++) {
    const response = await app.change(cookie, secret(), newPassword);
    assert.equal(response.status, 403);
    await response.json();
  }
  const limited = await app.change(cookie, app.password, newPassword);
  assert.equal(limited.status, 429);
  await limited.json();
  assert.equal((await app.login()).status, 429);
});

test('a successful password change resets previous failed current-password attempts', async t => {
  const app = await fixture(t);
  const { cookie } = await app.login();
  const newPassword = secret();
  for (let index = 0; index < 9; index++) {
    const response = await app.change(cookie, secret(), newPassword);
    assert.equal(response.status, 403);
    await response.json();
  }
  const changed = await app.change(cookie, app.password, newPassword);
  assert.equal(changed.status, 200);
  await changed.json();
  assert.equal((await app.login(app.password)).status, 401);
  assert.equal((await app.login(newPassword)).status, 200);
});

test('concurrent old-password logins and changes cannot leave an old session alive after revocation', async t => {
  const app = await fixture(t);
  const { cookie } = await app.login();
  const candidates = [secret(), secret()];
  const changes = candidates.map(candidate => app.change(cookie, app.password, candidate));
  const loginRequests = Array.from({ length: 4 }, () => app.login());
  const responses = await Promise.all(changes);
  const statuses = responses.map(response => response.status);
  assert.deepEqual(statuses.slice().sort(), [200, 401]);
  for (const response of responses) await response.json();
  const winner = statuses.indexOf(200);
  for (const oldLogin of await Promise.all(loginRequests)) {
    assert.ok([200, 401].includes(oldLogin.status));
    if (oldLogin.cookie) {
      const status = await app.request('/api/status', { cookie: oldLogin.cookie });
      assert.equal(status.status, 401);
      await status.json();
    }
  }
  assert.equal((await app.login()).status, 401);
  assert.equal((await app.login(candidates[winner])).status, 200);
});

test('password records and transaction serialization do not depend on plaintext bootstrap after initialization', async () => {
  const initial = bootstrap();
  const replacement = secret();
  const store = await createPasswordStore({ password: initial });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let verificationFinished = false;
  const change = store.transaction(async auth => { await gate; await auth.replace(replacement); });
  const verify = store.transaction(async auth => {
    assert.equal(await auth.verify(initial), false);
    assert.equal(await auth.verify(replacement), true);
    verificationFinished = true;
  });
  assert.equal(verificationFinished, false);
  release();
  await Promise.all([change, verify]);
  assert.equal(verificationFinished, true);
});
