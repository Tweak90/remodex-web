// Browser server added by the remodex-web fork; Apache-2.0.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CodexConnection } from './codex.js';

const allowedMethods = new Set([
  'thread/list', 'thread/read', 'thread/start', 'thread/resume',
  'turn/start', 'turn/interrupt', 'model/list',
]);
const hash = (value) => createHash('sha256').update(value).digest();
const problem = (status, message) => Object.assign(new Error(message), { status });
const sessionDuration = 24 * 60 * 60 * 1000;

export async function createWebServer({ password, bridge, hostLabel = 'Codex', projects = [], secureCookie = false } = {}) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('CODEX_WEB_PASSWORD must contain at least 12 characters');
  const expectedPassword = hash(password);
  const sessions = new Map();
  const attempts = new Map();
  const events = new Map();
  const assets = new Map();
  for (const [url, name, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ]) {
    assets.set(url, { body: await readFile(new URL(`./public/${name}`, import.meta.url)), type });
  }
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const getSession = (req) => {
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('remodex_web_session='))?.slice(20);
    if (!token) return null;
    const key = hash(token).toString('hex');
    const session = sessions.get(key);
    return session?.expires > Date.now() ? { ...session, key } : null;
  };
  const cookie = (value, maxAge) => `remodex_web_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const verifyOrigin = (req) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw problem(403, 'Fremder Ursprung nicht erlaubt');
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw problem(403, 'Ungültiger Ursprung'); }
      if (origin.host !== req.headers.host) throw problem(403, 'Fremder Ursprung nicht erlaubt');
    }
  };
  const readJSON = async (req) => {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw problem(415, 'JSON erforderlich');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw problem(413, 'Nachricht zu groß');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw problem(400, 'Ungültiges JSON'); }
  };
  const broadcast = (message) => {
    const chunk = `data: ${JSON.stringify(message)}\n\n`;
    for (const [res, { key, expires }] of events) {
      if (!sessions.has(key) || expires < Date.now()) { res.end(); events.delete(res); }
      else if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); events.delete(res); }
      else res.write(chunk);
    }
  };
  bridge.on('message', broadcast);
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expires < now) sessions.delete(key);
    for (const [ip, attempt] of attempts) if (attempt.until < now) attempts.delete(ip);
    for (const [res, { key, expires }] of events) {
      if (!sessions.has(key) || expires < now) { res.end(); events.delete(res); }
      else res.write(': heartbeat\n\n');
    }
  }, 15000);
  maintenance.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': asset.type });
        return res.end(asset.body);
      }
      verifyOrigin(req);
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        const attempt = attempts.get(ip) || { count: 0, until: now + 60000 };
        if (attempt.until > now && attempt.count >= 10) throw problem(429, 'Zu viele Versuche. Bitte eine Minute warten.');
        if (attempt.until < now) { attempt.count = 0; attempt.until = now + 60000; }
        const body = await readJSON(req);
        if (typeof body.password !== 'string' || !timingSafeEqual(hash(body.password), expectedPassword)) {
          attempt.count++;
          attempts.set(ip, attempt);
          throw problem(401, 'Das Passwort ist nicht korrekt.');
        }
        attempts.delete(ip);
        const token = randomBytes(32).toString('base64url');
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        sessions.set(hash(token).toString('hex'), { expires: now + sessionDuration });
        res.setHeader('Set-Cookie', cookie(token, sessionDuration / 1000));
        return send(res, 200, { ok: true });
      }
      const session = getSession(req);
      if (!session) throw problem(401, 'Bitte anmelden.');
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await readJSON(req);
        sessions.delete(session.key);
        for (const [stream, record] of events) if (record.key === session.key) { stream.end(); events.delete(stream); }
        res.setHeader('Set-Cookie', cookie('', 0));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/status')
        return send(res, 200, { ...bridge.status, authenticated: true, hostLabel });
      if (req.method === 'GET' && url.pathname === '/api/requests')
        return send(res, 200, { requests: [...bridge.requests.values()] });
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const known = new Map(projects.map(p => [p.path, p]));
        const result = await bridge.call('thread/list', { limit: 100 });
        for (const thread of result.data || []) if (thread.cwd && !known.has(thread.cwd))
          known.set(thread.cwd, { name: thread.cwd.split('/').filter(Boolean).at(-1), path: thread.cwd });
        return send(res, 200, { projects: [...known.values()] });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (events.size >= 50) throw problem(429, 'Zu viele offene Verbindungen');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        events.set(res, session);
        req.on('close', () => events.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/rpc') {
        const { method, params = {} } = await readJSON(req);
        if (!allowedMethods.has(method)) throw problem(403, 'Methode nicht freigegeben');
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw problem(400, 'Ungültige Parameter');
        return send(res, 200, await bridge.call(method, params));
      }
      if (req.method === 'POST' && url.pathname === '/api/respond') {
        const { id, result } = await readJSON(req);
        bridge.answer(id, result);
        return send(res, 200, { ok: true });
      }
      throw problem(404, 'Nicht gefunden');
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 502, { error: { message: error.message, code: error.code || undefined } });
      else res.end();
    }
  });
  server.on('close', () => {
    clearInterval(maintenance);
    bridge.off('message', broadcast);
    for (const res of events.keys()) res.end();
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.CODEX_API_TOKEN) throw new Error('CODEX_API_TOKEN is required');
    const bridge = new CodexConnection({ url: process.env.CODEX_WS_URL, token: process.env.CODEX_API_TOKEN });
    const server = await createWebServer({
      password: process.env.CODEX_WEB_PASSWORD,
      bridge,
      hostLabel: process.env.HOST_LABEL || 'Codex',
      projects: JSON.parse(process.env.CODEX_PROJECTS || '[]'),
      secureCookie: process.env.COOKIE_SECURE === 'true',
    });
    bridge.connect().catch(() => {});
    server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('remodex-web listening'));
    const stop = () => {
      bridge.close();
      server.close();
      server.closeAllConnections();
      setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch {
    console.error('Startup failed. Verify required gateway and password environment variables.');
    process.exitCode = 1;
  }
}
