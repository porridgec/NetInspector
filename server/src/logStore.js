'use strict';

/**
 * Fixed-capacity ring buffer of captured request events.
 * Bodies are hard-capped (maxBodyBytes) to keep memory bounded.
 */

function flattenHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
  for (const [k, v] of Object.entries(h)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
  }
  return out;
}

class LogStore {
  constructor({ capacity = 500, maxBodyBytes = 256 * 1024 } = {}) {
    this.capacity = Math.max(1, capacity | 0);
    this.maxBodyBytes = maxBodyBytes | 0;
    this.items = [];            // oldest -> newest
    this.byId = new Map();
    this.seq = 0;
    this.totalReceived = 0;
    this.startedAt = Date.now();
    this.serverTruncationWarnings = 0;
  }

  /** Normalize a raw event coming from a device, then store it. */
  add(rawEvent, client) {
    const event = this._normalize(rawEvent, client);
    this.totalReceived += 1;
    this.items.push(event);
    this.byId.set(event.id, event);
    while (this.items.length > this.capacity) {
      const dropped = this.items.shift();
      this.byId.delete(dropped.id);
    }
    return event;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** Newest-first listing. */
  list(limit = 1000, offset = 0) {
    const out = [];
    for (let i = this.items.length - 1 - offset; i >= 0 && out.length < limit; i--) {
      out.push(this.items[i]);
    }
    return out;
  }

  clear() {
    this.items = [];
    this.byId.clear();
  }

  status() {
    return {
      capacity: this.capacity,
      count: this.items.length,
      totalReceived: this.totalReceived,
      maxBodyBytes: this.maxBodyBytes,
      startedAt: this.startedAt,
    };
  }

  /** 首几次服务端截断时在控制台醒目提示（避免刷屏） */
  warnServerTruncation() {
    if (this.serverTruncationWarnings >= 3) return;
    this.serverTruncationWarnings += 1;
    const kb = Math.round(this.maxBodyBytes / 1024);
    console.warn(`[!] ⚠ body 在服务端存储上限处被截断（${kb} KiB）。需要完整 body 请调大后重启：`);
    console.warn(`    MAX_BODY_BYTES=$((128*1024*1024)) npm start   # 128 MiB 示例`);
    console.warn(`    同时建议调小 MAX_LOGS（如 100），防止内存占用过大`);
  }

  _normalize(raw, client) {
    const e = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : {};

    e.id = (typeof e.id === 'string' && e.id) ? e.id : `ev-${++this.seq}-${Date.now()}`;
    e.seq = ++this.seq;

    e.method = String(e.method || 'GET').toUpperCase();
    e.url = String(e.url || '');

    let parsed = null;
    try { parsed = new URL(e.url); } catch { /* not a valid absolute URL */ }
    e.scheme = e.scheme || (parsed ? parsed.protocol.replace(':', '') : '');
    e.host = e.host || (parsed ? parsed.host : '');
    e.path = e.path || (parsed ? parsed.pathname : '');
    e.query = e.query || (parsed ? parsed.search.replace(/^\?/, '') : '');

    const num = (v, d) => {
      if (typeof v === 'number' && isFinite(v)) return v;
      if (v != null && isFinite(+v)) return +v;
      return d;
    };
    e.statusCode = e.statusCode == null ? null : num(e.statusCode, null);
    e.timestamp = num(e.timestamp, Date.now());
    e.completedAt = num(e.completedAt, e.timestamp);
    e.durationMs = num(e.durationMs, Math.max(0, e.completedAt - e.timestamp));
    e.error = (typeof e.error === 'string' && e.error) ? e.error : null;

    for (const side of ['request', 'response']) {
      const b = `${side}Body`;
      const encKey = `${side}BodyEncoding`;
      const sizeKey = `${side}BodySize`;
      const truncKey = `${side}BodyTruncated`;
      const truncByKey = `${side}BodyTruncatedBy`;

      if (typeof e[b] === 'string' && e[b].length) {
        if (e[encKey] !== 'base64') e[encKey] = 'text';
        e[sizeKey] = num(e[sizeKey], e[b].length);
        if (this.maxBodyBytes > 0 && e[b].length > this.maxBodyBytes) {
          e[b] = e[b].slice(0, this.maxBodyBytes);
          e[truncKey] = true;
          e[truncByKey] = 'server';
          this.warnServerTruncation();
        }
      } else {
        e[b] = '';
        e[encKey] = 'none';
        e[sizeKey] = num(e[sizeKey], 0);
      }
      e[truncKey] = !!e[truncKey];
      // 标记截断来源：server（存储上限）还是 client（捕获上限）
      if (e[truncKey] && !e[truncByKey]) e[truncByKey] = 'client';
    }

    e.requestHeaders = flattenHeaders(e.requestHeaders);
    e.responseHeaders = flattenHeaders(e.responseHeaders);
    e.requestContentType = String(e.requestContentType || '');
    e.responseContentType = String(e.responseContentType || '');
    e.responseMimeType = String(e.responseMimeType || '');

    e.clientId = e.clientId || (client && client.id) || 'unknown';
    e.clientName = e.clientName
      || (client && (client.app || client.name))
      || 'Unknown client';

    return e;
  }
}

/** Strip heavy body payloads for list/broadcast payloads (detail fetched on demand). */
function summarize(e) {
  const { requestBody, responseBody, ...rest } = e;
  return rest;
}

module.exports = { LogStore, summarize };
