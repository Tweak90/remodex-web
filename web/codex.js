// Browser adapter added by the remodex-web fork; Apache-2.0.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

export class CodexConnection extends EventEmitter {
  constructor({ url, token }) {
    super();
    const endpoint = new URL(url);
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search)
      throw new Error('CODEX_WS_URL must be a WebSocket URL without credentials or query parameters');
    this.url = endpoint;
    this.token = token;
    this.pending = new Map();
    this.requests = new Map();
    this.subscriptions = new Set();
    this.prefix = randomBytes(8).toString('hex');
    this.sequence = 0;
    this.generation = 0;
    this.status = { connected: false, error: null };
  }

  publishStatus(change) {
    Object.assign(this.status, change);
    this.emit('message', { method: 'web/status', params: this.status });
  }

  connect() {
    if (this.stopped) return Promise.reject(new Error('Verbindung beendet'));
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    const generation = ++this.generation;
    let failed = false;
    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeout: 10000,
      maxPayload: 32 * 1024 * 1024,
    });
    this.socket = ws;
    const disconnect = () => {
      if (failed || generation !== this.generation) return;
      failed = true;
      clearInterval(this.heartbeat);
      this.publishStatus({ connected: false, error: 'Codex-Verbindung unterbrochen. Wiederverbindung läuft.' });
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Codex-Verbindung unterbrochen'));
      }
      this.pending.clear();
      this.requests.clear();
      if (!this.stopped) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), 3000);
        this.reconnectTimer.unref();
      }
    };
    ws.on('error', disconnect);
    ws.on('close', disconnect);
    ws.on('message', (data) => {
      if (failed || generation !== this.generation) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) this.requests.set(String(message.id), message);
        if (message.method === 'serverRequest/resolved') this.requests.delete(String(message.params?.requestId));
        if (message.method === 'turn/completed') {
          for (const [id, request] of this.requests) {
            if (request.params?.threadId === message.params?.threadId && request.params?.turnId === message.params?.turn?.id)
              this.requests.delete(id);
          }
        }
        this.emit('message', message);
      } else if (message.id !== undefined) {
        const entry = this.pending.get(String(message.id));
        if (!entry) return;
        this.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else entry.resolve(message.result);
      }
    });
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', () => reject(new Error('Gateway nicht erreichbar')));
      });
      await this.raw('initialize', {
        clientInfo: { name: 'remodex_web', title: 'remodex-web', version: '0.2.1' },
        capabilities: { experimentalApi: true },
      }, 15000);
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
      for (const threadId of this.subscriptions) {
        try { await this.raw('thread/resume', { threadId, excludeTurns: true }); } catch { /* Removed threads may disappear. */ }
        if (failed) break;
      }
      if (failed || generation !== this.generation || ws.readyState !== WebSocket.OPEN)
        throw new Error('Connection lost during initialization');
      let alive = true;
      ws.on('pong', () => { alive = true; });
      this.heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return disconnect();
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, 20000);
      this.heartbeat.unref();
      if (!failed) this.publishStatus({ connected: true, error: null });
    } catch {
      disconnect();
      ws.terminate();
      throw new Error('Verbindung zum vorhandenen Codex-Gateway fehlgeschlagen');
    }
  }

  raw(method, params = {}, timeout = 60000) {
    const id = `${this.prefix}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Zeitlimit für ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async call(method, params = {}) {
    if (!this.status.connected) throw new Error('Codex ist noch nicht verbunden');
    const result = await this.raw(method, params);
    if (['thread/start', 'thread/resume'].includes(method) && result.thread?.id)
      this.subscriptions.add(result.thread.id);
    return result;
  }

  answer(id, result) {
    const request = this.requests.get(String(id));
    if (!request) throw new Error('Diese Anfrage ist nicht mehr offen');
    this.socket.send(JSON.stringify({ id: request.id, result }));
    this.requests.delete(String(id));
    this.emit('message', { method: 'serverRequest/resolved', params: { requestId: request.id } });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Beendet'));
    }
    this.pending.clear();
    this.socket?.terminate();
  }
}
