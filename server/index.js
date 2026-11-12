#!/usr/bin/env node
'use strict';

/**
 * NetInspector — LAN request logger server.
 *   - ws://<mac>/log        : endpoint for iOS clients (push captured requests)
 *   - http://<mac>/         : Charles/Proxyman-style dashboard
 *   - /api/logs, /api/logs/:id, /api/status
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { LogStore, summarize } = require('./src/logStore');
const { localIPv4s } = require('./src/network');

const PORT = parseInt(process.env.PORT || '9090', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_LOGS = parseInt(process.env.MAX_LOGS || '500', 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(256 * 1024), 10);

const store = new LogStore({ capacity: MAX_LOGS, maxBodyBytes: MAX_BODY_BYTES });

/* ------------------------------ HTTP API ------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

// Reachability probe: plain text, no assets involved.
app.get('/ping', (_req, res) => res.type('text/plain').send(`netinspector alive at ${new Date().toISOString()}\n`));

// Log API traffic with source IP — makes "is the phone actually reaching me?"
// instantly answerable from the server console.
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/ping') {
    console.log(`  http ${req.method} ${req.originalUrl} ← ${req.ip}`);
  }
  next();
});

const clampInt = (v, min, max, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

app.get('/api/status', (_req, res) => res.json(store.status()));

app.get('/api/logs', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 5000, 1000);
  const offset = clampInt(req.query.offset, 0, 1e9, 0);
  res.json({
    logs: store.list(limit, offset).map(summarize),
    total: store.items.length,
    stats: store.status(),
  });
});

app.get('/api/logs/:id', (req, res) => {
  const e = store.get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  res.json(e);
});

app.delete('/api/logs', (_req, res) => {
  store.clear();
  broadcastToViewers({ type: 'cleared' });
  res.json({ ok: true });
});

/* HTTP fallback transport for devices whose network blocks WebSocket
 * upgrades (phone proxies, transparent middleboxes) but still forwards
 * plain HTTP POSTs. Same message format as the WebSocket channel. */
app.post('/log', express.json({ limit: '32mb' }), (req, res) => {
  const info = upsertHttpDevice(req.body);
  const reply = ingestMessage(req.body, info);
  res.json(reply || { ok: true });
});

/* ------------------------------ WebSocket ------------------------------ */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

const devices = new Map(); // ws -> device info
const httpDevices = new Map(); // clientId -> device info (HTTP fallback, TTL-based)
const viewers = new Set();
const HTTP_DEVICE_TTL_MS = 60_000;

// Manual upgrade routing: unknown paths get an explicit 404 instead of a
// silent upgrade, so misconfigured clients fail loudly.
server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* keep default */ }

  if (pathname === '/log' || pathname === '/device') {
    wss.handleUpgrade(req, socket, head, (ws) => attachDevice(ws, req));
  } else if (pathname === '/' || pathname === '/dashboard') {
    wss.handleUpgrade(req, socket, head, (ws) => attachViewer(ws));
  } else {
    console.log(`[!] rejected WebSocket upgrade to unknown path "${pathname}" ← ${req.socket.remoteAddress}`);
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

/** Shared message handling for both transports. Returns a reply message or null. */
function ingestMessage(msg, clientInfo) {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'hello' && msg.client && typeof msg.client === 'object') {
    Object.assign(clientInfo, msg.client);
    if (!clientInfo.id) clientInfo.id = `dev-${Math.random().toString(36).slice(2, 10)}`;
    console.log(`   ↳ ${clientInfo.name || clientInfo.model || 'device'} · ${clientInfo.app || 'no app'} · ` +
                `${clientInfo.system || ''}${clientInfo.transport === 'http' ? ' · HTTP 回退' : ''}`);
    broadcastClients();
    return { type: 'welcome', server: { version: 1, capacity: MAX_LOGS, transport: clientInfo.transport || 'ws' } };
  }

  if (msg.type === 'request' && msg.event) {
    let stored;
    try {
      stored = store.add(msg.event, clientInfo);
    } catch (err) {
      console.error('[!] failed to store event:', err.message);
      return null;
    }
    console.log(
      `  ${stored.method.padEnd(7)} ${String(stored.statusCode == null ? '---' : stored.statusCode).padEnd(3)} ` +
      `${stored.host}${stored.path}  ${Math.round(stored.durationMs)}ms`
    );
    broadcastToViewers({ type: 'event', event: summarize(stored) });
    return { type: 'ack', id: stored.id };
  }
  return null;
}

function attachDevice(ws, req) {
  const info = {
    id: `dev-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Unknown device',
    app: '',
    model: '',
    system: '',
    transport: 'ws',
    connectedAt: Date.now(),
  };
  devices.set(ws, info);
  console.log(`[+] device connected (${devices.size} total) from ${req.socket.remoteAddress}`);
  broadcastClients();

  ws.on('message', (raw, isBinary) => {
    // iOS NSURLSessionWebSocketTask sends JSON as BINARY frames (NSData),
    // node clients send text frames — accept both.
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    const reply = ingestMessage(msg, info);
    if (reply) safeSend(ws, reply);
  });

  ws.on('close', () => {
    devices.delete(ws);
    console.log(`[-] device disconnected (${devices.size} total)`);
    broadcastClients();
  });
  ws.on('error', () => { /* handled via close */ });
}

/** Track devices using the HTTP fallback so they show up on the dashboard. */
function upsertHttpDevice(body) {
  const client = (body && body.type === 'hello' && body.client) || null;
  const id = (client && client.id) || (body && body.event && body.event.clientId) || 'http-device';
  let info = httpDevices.get(id);
  if (!info) {
    info = {
      id,
      name: 'Unknown device',
      app: '',
      model: '',
      system: '',
      transport: 'http',
      connectedAt: Date.now(),
    };
    httpDevices.set(id, info);
  }
  info.lastSeen = Date.now();
  return info;
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, info] of httpDevices) {
    if (now - (info.lastSeen || 0) > HTTP_DEVICE_TTL_MS) {
      httpDevices.delete(id);
      changed = true;
    }
  }
  if (changed) broadcastClients();
}, 30_000).unref();

function attachViewer(ws) {
  viewers.add(ws);
  safeSend(ws, {
    type: 'hello',
    server: { version: 1, capacity: MAX_LOGS },
    clients: deviceList(),
    stats: store.status(),
  });
  ws.on('close', () => viewers.delete(ws));
  ws.on('error', () => { /* handled via close */ });
}

function deviceList() {
  const seen = new Set();
  const list = [];
  // WebSocket devices first (live connection), then HTTP-fallback devices.
  for (const d of devices.values()) {
    if (!seen.has(d.id)) { seen.add(d.id); list.push(publicInfo(d)); }
  }
  for (const d of httpDevices.values()) {
    if (!seen.has(d.id)) { seen.add(d.id); list.push(publicInfo(d)); }
  }
  return list;
}

function publicInfo(d) {
  return {
    id: d.id, name: d.name, app: d.app, model: d.model, system: d.system,
    transport: d.transport || 'ws', connectedAt: d.connectedAt,
  };
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function broadcastToViewers(obj) {
  const data = JSON.stringify(obj);
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

function broadcastClients() {
  broadcastToViewers({ type: 'clients', clients: deviceList() });
}

/* Heartbeat: drop dead sockets (iOS side also self-pings). */
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(hb));

/* ------------------------------ Startup ------------------------------ */

server.listen(PORT, HOST, () => {
  const ips = localIPv4s();
  console.log('');
  console.log('  ⚡ NetInspector server is running');
  console.log('  ───────────────────────────────────────────────');
  console.log(`  Dashboard :  http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`               http://${ip}:${PORT}`);
    console.log(`  iOS host  :  LNNetInspector.shared.host = @"${ip}"   port = ${PORT}`);
  }
  if (!ips.length) console.log('  ⚠ no LAN IPv4 address found — is Wi-Fi / Ethernet connected?');
  console.log(`  Buffer    :  last ${MAX_LOGS} requests · bodies capped at ${Math.round(MAX_BODY_BYTES / 1024)} KiB`);
  console.log('  Tip       :  npm run demo  → replay fake traffic without an iOS device');
  console.log('');
});
