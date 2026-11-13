#!/usr/bin/env node
'use strict';

/**
 * NetInspector — LAN request logger server.
 *   - ws://<mac>/log        : endpoint for iOS clients (push captured requests)
 *   - http://<mac>/         : Charles/Proxyman-style dashboard
 *   - /api/logs, /api/logs/:id, /api/status
 */

const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { LogStore, summarize } = require('./src/logStore');
const { localIPv4s } = require('./src/network');

const PORT = parseInt(process.env.PORT || '9090', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_LOGS = parseInt(process.env.MAX_LOGS || '500', 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(256 * 1024), 10);
// 单条消息传输上限自动跟随存储上限：二进制 body 以 base64 传输会膨胀 4/3，
// 再留 JSON 结构开销，取 2 倍 + 16 MiB 余量，避免传输层成为隐形暗坑。
const MAX_MESSAGE_BYTES = MAX_BODY_BYTES * 2 + 16 * 1024 * 1024;
// 可选访问令牌：设置后所有 HTTP/WS 访问都需携带（query 参数 token 或请求头
// x-ni-token）。局域网（尤其公司网）下强烈建议设置——抓包数据含有 App 的
// token/密码等敏感信息，同网段任何人默认可读。
const TOKEN = process.env.TOKEN || process.env.NI_TOKEN || '';

const store = new LogStore({ capacity: MAX_LOGS, maxBodyBytes: MAX_BODY_BYTES });

/* --------------------------- Security helpers --------------------------- */

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** 定长哈希 + timingSafeEqual，防时序侧信道 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function tokenFromRequest(req) {
  let token = req.headers['x-ni-token'];
  if (!token) {
    try { token = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch { /* ignore */ }
  }
  return typeof token === 'string' ? token : '';
}

function isAuthorized(req) {
  if (!TOKEN) return true;
  return safeEqual(tokenFromRequest(req), TOKEN);
}

/**
 * Host allowlist — mitigates DNS rebinding: an attacker page whose domain
 * resolves to 127.0.0.1 would send Host: evil.com; we reject non-local hosts.
 * Allowed: localhost, raw IPv4/IPv6 literals, *.local mDNS names, this Mac's
 * hostname. (Users reach the dashboard by IP or .local name.)
 */
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const hostname = String(hostHeader).replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.endsWith('.local')) return true;
  if (hostname === os.hostname().toLowerCase()) return true;
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(hostname)) return true;   // IPv4 literal
  if (/^[0-9a-f:]+$/i.test(hostname) && hostname.includes(':')) return true; // IPv6 literal
  return false;
}

/** WS 的 Origin 校验：浏览器页面必须与服务端同主机；非浏览器客户端不带 Origin。 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // iOS / node clients
  try {
    const originHost = new URL(origin).hostname.toLowerCase();
    const reqHost = String(req.headers.host || '').replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
    return originHost === reqHost;
  } catch {
    return false;
  }
}

/** 去除不可信字符串中的控制字符（防终端 ESC 注入） */
const stripCtrl = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, '');

/** 过滤 __proto__ / constructor / prototype，防原型污染 */
function safeAssign(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    target[key] = source[key];
  }
  return target;
}

/* ------------------------------ HTTP API ------------------------------ */

const app = express();
app.disable('x-powered-by');

// 安全响应头：CSP（防潜在 XSS）、禁止被 iframe 嵌入（防点击劫持）
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// 静态资源放在鉴权之前：Dashboard 的 HTML/CSS/JS 壳不含任何抓包数据，
// 且 <link>/<script> 请求不会携带 query 里的 token——若被 401 会整页裸奔。
// 敏感数据全部由下方鉴权保护的 /api/*、/log、WS 升级提供（app.js 会自动
// 把 token 附加到每个 API 请求上）。
// no-cache = 允许缓存但每次使用前必须重新校验（ETag 304），
// 保证服务端更新后浏览器不会继续跑旧版 JS。
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Host + Token 校验：保护所有数据通道（API / HTTP 回退 / ping）
app.use((req, res, next) => {
  if (!hostAllowed(req.headers.host)) {
    return res.status(403).type('text/plain').send('Forbidden: invalid Host header\n');
  }
  if (!isAuthorized(req)) {
    const hadToken = tokenFromRequest(req).length > 0;
    console.log(`[!] 401 ${stripCtrl(req.method)} ${stripCtrl(req.path)} ← ${req.ip} ` +
                `(token ${hadToken ? '不匹配' : '缺失'} — 请核对服务端 TOKEN 环境变量的值)`);
    return res.status(401).type('text/plain').send('Unauthorized: missing or invalid token\n');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Reachability probe: plain text, no assets involved.
app.get('/ping', (_req, res) => res.type('text/plain').send(`netinspector alive at ${new Date().toISOString()}\n`));

// Log API traffic with source IP — makes "is the phone actually reaching me?"
// instantly answerable from the server console.
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/ping') {
    console.log(`  http ${stripCtrl(req.method)} ${stripCtrl(req.originalUrl)} ← ${req.ip}`);
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
app.post('/log', express.json({ limit: MAX_MESSAGE_BYTES }), (req, res) => {
  const info = upsertHttpDevice(req.body);
  const reply = ingestMessage(req.body, info);
  res.json(reply || { ok: true });
});

/* ------------------------------ WebSocket ------------------------------ */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

const devices = new Map(); // ws -> device info
const httpDevices = new Map(); // clientId -> device info (HTTP fallback, TTL-based)
const viewers = new Set();
const HTTP_DEVICE_TTL_MS = 60_000;

// Manual upgrade routing: unknown paths get an explicit 404 instead of a
// silent upgrade, so misconfigured clients fail loudly.
server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* keep default */ }

  // Security gate: Host (DNS rebinding), Origin (cross-site WS), Token.
  if (!hostAllowed(req.headers.host) || !originAllowed(req) || !isAuthorized(req)) {
    const status = !isAuthorized(req) ? 401 : 403;
    console.log(`[!] rejected WebSocket upgrade (${status}) from ${req.socket.remoteAddress} ` +
                `host="${stripCtrl(req.headers.host || '')}" origin="${stripCtrl(req.headers.origin || '')}"`);
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  if (pathname === '/log' || pathname === '/device') {
    wss.handleUpgrade(req, socket, head, (ws) => attachDevice(ws, req));
  } else if (pathname === '/' || pathname === '/dashboard') {
    // Viewer 数量上限：防止资源耗尽
    if (viewers.size >= 32) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachViewer(ws));
  } else {
    console.log(`[!] rejected WebSocket upgrade to unknown path "${stripCtrl(pathname)}" ← ${req.socket.remoteAddress}`);
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

/** Shared message handling for both transports. Returns a reply message or null. */
function ingestMessage(msg, clientInfo) {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'hello' && msg.client && typeof msg.client === 'object') {
    safeAssign(clientInfo, msg.client); // __proto__ 等键已过滤
    if (!clientInfo.id) clientInfo.id = `dev-${Math.random().toString(36).slice(2, 10)}`;
    console.log(`   ↳ ${stripCtrl(clientInfo.name || clientInfo.model || 'device')} · ` +
                `${stripCtrl(clientInfo.app || 'no app')} · ${stripCtrl(clientInfo.system || '')}` +
                `${clientInfo.transport === 'http' ? ' · HTTP 回退' : ''}`);
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
      `  ${stripCtrl(stored.method).padEnd(7)} ${String(stored.statusCode == null ? '---' : stored.statusCode).padEnd(3)} ` +
      `${stripCtrl(stored.host)}${stripCtrl(stored.path)}  ${Math.round(stored.durationMs)}ms`
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
  const fmt = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MiB` : `${Math.round(n / 1024)} KiB`);
  const tokenQuery = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
  console.log('');
  console.log('  ⚡ NetInspector server is running');
  console.log('  ───────────────────────────────────────────────');
  console.log(`  Dashboard :  http://localhost:${PORT}/${tokenQuery}`);
  for (const ip of ips) {
    console.log(`               http://${ip}:${PORT}/${tokenQuery}`);
    console.log(`  iOS host  :  LNNetInspector.shared.host = @"${ip}"   port = ${PORT}` +
                (TOKEN ? '   token = @"<见 .authToken 配置>"' : ''));
  }
  if (!ips.length) console.log('  ⚠ no LAN IPv4 address found — is Wi-Fi / Ethernet connected?');
  console.log(`  Buffer    :  last ${MAX_LOGS} requests · body 存储上限 ${fmt(MAX_BODY_BYTES)} (env MAX_BODY_BYTES 可调大，同时建议调小 MAX_LOGS)`);
  if (TOKEN) {
    console.log('  Security  :  ✅ 已启用访问令牌（Dashboard 与设备均需 token）');
  } else {
    console.log('  Security  :  ⚠ 未设置访问令牌 —— 同网段任何人都能读取抓包数据（含 token/密码）！');
    console.log('               建议：TOKEN=your-secret npm start      （Dashboard 打开 http://ip:9090/?token=your-secret）');
  }
  console.log('  Tip       :  npm run demo  → replay fake traffic without an iOS device');
  console.log('');
});
