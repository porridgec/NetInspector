#!/usr/bin/env node
'use strict';

/**
 * Demo device client — replays realistic fake traffic so you can develop
 * against the dashboard without an iOS device.
 *
 *   npm run demo        (server must be running)
 *   PORT=9090 node demo-client.js
 */

const os = require('os');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '9090', 10);
const INTERVAL = parseInt(process.env.INTERVAL || '700', 10);

const TINY_GIF_BASE64 =
  'R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6mu7fiyZeKqNKToQGDsM8hBADgUXoGAiqhSvp5QAnQKGIgUhwFUYLCVDFCrKUE1lBavAViFIDlTImbKC5Gm2hB0SlBCBMkiB0UjIQA7';

// A real, browser-decodable 96x64 gradient JPEG (so the multipart image preview works).
const REAL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAYKADAAQAAAABAAAAQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAQABgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICBAICBAYEBAQGCAYGBgYICggICAgICgwKCgoKCgoMDAwMDAwMDA4ODg4ODhAQEBAQEhISEhISEhISEv/bAEMBAwMDBQQFCAQECBMNCw0TExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE//dAAQABv/aAAwDAQACEQMRAD8A/C630npxW7b6T7V2VvpPtW7b6T7VwrFHLgM121ONt9J6cVvW+k+1djbaT7VvW+k9OKpYo+2wGbbanG22k+1btvpPTiuyt9J9q3bbSfaqWKPtsBmu2px1vpPtW7b6T7V2NvpPtW9b6T04qlij7XAZrtqcbb6T7VvW2k+1djb6T7VvW+k+1V9aPtsvzXbU4230n2rdt9J6cV2VvpPTit220n2qlij7bAZrtqf/0PzMt9I9q3bfSD6V2lvpPtW7b6T7V8asUflWAzbbU4y30g8cVu22j+1dnbaT7Vu2+k9OKpYo+1wGbbanGW2j+1b1vo/Tiuzt9J6cVu2+k+1V9aPtsBm22pxlvo/tW9b6QfSuyt9J9q3rfSfaqWKPtsBm22pxlvpB9K3bbR/auzt9J6cVvW+k+1UsUfa5fm22pxdvpB9K3rfR+nFdnb6T7Vu22k+1UsUfbYDNttT/0fmu30n2ret9J6cV2dvpA9K3bfR/avylYo/l7AZttqcZb6T04rdttJ9q7O20gelb1vo444qvrR9tgM221OLttJ9q3rfSenFdnb6QOOK3rfSB6VSxR9rl+bbanF2+k+1b1vpPtXZ2+kD0rdt9I9qpYo+2wGbbanGW+k9OK3bbSfauzt9Iz2ret9HHHFV9aPtsvzbbU4u30n2ret9J6cV2dvpA44rettIH92qWKPtsBm22p//SuW+k+1btvpPTiuzt9IPHFbtvpH+zX4KsUfwlgM221ONt9J6cVu2+k+1dlbaR/s1u2+ke1V9aPtsBmu2pxttpPtW9b6T7V2VvpB/u1u2+k/7NUsUfbYDNdtTjbfSenFb1vpPtXY2+kHjit620g+lUsUfa4DNdtTjbfSfat220n2rsrbSPat230jp8tUsUfbYDNdtTjbfSfat630npxXZW+kHrtrdttJ/2apYo+2wGbban/9k=';

const ws = new WebSocket(`ws://localhost:${PORT}/log`);

const paths = ['/v1/users', '/v1/users/42', '/v1/orders', '/v1/search?q=swift', '/v1/feed?page=3',
  '/api/login', '/api/upload', '/api/config', '/health', '/v1/missing-page'];
const uas = ['MyApp/1.2.3 (iPhone15,3; iOS 17.2)', 'MyApp/1.2.3 (iPhone14,2; iOS 16.6)'];

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function rand(min, max) { return Math.round(min + Math.random() * (max - min)); }

function jsonUsers() {
  const users = [];
  for (let i = 0; i < 6; i++) {
    users.push({
      id: 1000 + i, name: `user_${i}`, email: `user${i}@example.com`,
      active: Math.random() > 0.3,
      score: rand(0, 5000),
      tags: ['beta', null],
      profile: { city: pick(['Beijing', 'Shanghai', 'Shenzhen']), logins: rand(1, 999), vip: Math.random() > 0.5 },
    });
  }
  return { code: 0, message: 'ok', data: { list: users, total: 128, page: 1, hasMore: true } };
}

function multipartUpload() {
  const boundary = `----NetInspectorDemo${Math.random().toString(36).slice(2, 10)}`;
  const textPart = (name, value) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  // Real decodable JPEG — the dashboard image preview must actually render.
  const jpeg = Buffer.from(REAL_JPEG_BASE64, 'base64');
  const body = Buffer.concat([
    textPart('title', 'Monthly report'),
    textPart('tags', JSON.stringify(['q3', 'finance', '内部审批'])),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="chart.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

function eventTemplate() {
  const kind = Math.random();
  const path = pick(paths);
  const url = `https://api.example.com${path}${path.includes('?') ? '&' : '?'}sign=abc123`;
  const now = Date.now();

  // common shape
  const ev = {
    id: `demo-${now}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: 0,
    completedAt: 0,
    durationMs: 0,
    url,
    method: 'GET',
    requestHeaders: {
      'Accept': 'application/json',
      'User-Agent': pick(uas),
      'X-App-Version': '1.2.3',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo.signature',
    },
    requestContentType: '',
    requestBody: '', requestBodyEncoding: 'none', requestBodySize: 0, requestBodyTruncated: false,
    statusCode: 200,
    responseHeaders: {
      'Content-Type': 'application/json',
      'Server': 'nginx/1.24.0',
      'X-Request-Id': `req-${Math.random().toString(36).slice(2, 12)}`,
    },
    responseContentType: 'application/json',
    responseMimeType: 'application/json',
    responseBody: '', responseBodyEncoding: 'none', responseBodySize: 0, responseBodyTruncated: false,
    error: null,
  };

  if (kind < 0.14) {
    // POST multipart/form-data (text fields + binary file part)
    ev.method = 'POST';
    ev.url = 'https://api.example.com/v1/uploads';
    const mp = multipartUpload();
    ev.requestContentType = mp.contentType;
    ev.requestBody = mp.body.toString('base64');
    ev.requestBodyEncoding = 'base64';
    ev.requestBodySize = mp.body.length;
    ev.requestHeaders['Content-Type'] = mp.contentType;
    ev.responseBody = '{"ok":true,"fileId":"f_' + Math.random().toString(36).slice(2, 8) + '"}';
    ev.responseBodyEncoding = 'text';
    ev.responseBodySize = ev.responseBody.length;
    ev.durationMs = rand(400, 1800);
  } else if (kind < 0.38) {
    // GET list, 200 JSON
    ev.method = 'GET';
    const body = JSON.stringify(jsonUsers());
    ev.responseBody = body; ev.responseBodyEncoding = 'text'; ev.responseBodySize = body.length;
    ev.durationMs = rand(35, 400);
  } else if (kind < 0.45) {
    // POST JSON
    ev.method = 'POST';
    const reqBody = JSON.stringify({ username: 'hahn', password: 's3cret!', remember: true, extra: { from: 'app', lat: 31.2304, lng: 121.4737 } });
    ev.requestContentType = 'application/json';
    ev.requestBody = reqBody; ev.requestBodyEncoding = 'text'; ev.requestBodySize = reqBody.length;
    const resBody = JSON.stringify({ code: 0, data: { token: 'tok_' + Math.random().toString(36).slice(2), expires: 7200 } });
    ev.responseBody = resBody; ev.responseBodyEncoding = 'text'; ev.responseBodySize = resBody.length;
    ev.durationMs = rand(120, 800);
  } else if (kind < 0.55) {
    // urlencoded form
    ev.method = 'POST';
    ev.url = 'https://api.example.com/v1/feedback';
    ev.requestContentType = 'application/x-www-form-urlencoded';
    const form = 'title=Hello%20World&content=%E8%BF%99%E6%98%AF%E4%B8%80%E6%9D%A1%E5%8F%8D%E9%A6%88&rate=5';
    ev.requestBody = form; ev.requestBodyEncoding = 'text'; ev.requestBodySize = form.length;
    ev.responseBody = '{"ok":true}'; ev.responseBodyEncoding = 'text'; ev.responseBodySize = 9;
    ev.durationMs = rand(80, 300);
  } else if (kind < 0.65) {
    // 404 / 500
    ev.method = 'GET';
    ev.statusCode = Math.random() > 0.5 ? 404 : 500;
    const body = JSON.stringify({ code: ev.statusCode, message: ev.statusCode === 404 ? 'resource not found' : 'internal server error' });
    ev.responseBody = body; ev.responseBodyEncoding = 'text'; ev.responseBodySize = body.length;
    ev.durationMs = rand(20, 150);
  } else if (kind < 0.72) {
    // binary image response
    ev.method = 'GET';
    ev.url = `https://cdn.example.com/avatar/${rand(1, 99)}.gif`;
    ev.responseHeaders['Content-Type'] = 'image/gif';
    ev.responseContentType = 'image/gif'; ev.responseMimeType = 'image/gif';
    ev.responseBody = TINY_GIF_BASE64; ev.responseBodyEncoding = 'base64'; ev.responseBodySize = 320;
    ev.durationMs = rand(50, 200);
  } else if (kind < 0.80) {
    // slow request
    ev.method = 'GET';
    ev.url = 'https://api.example.com/v1/report/aggregate';
    ev.durationMs = rand(1500, 4200);
    const body = JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: i, v: rand(0, 9999) })) });
    ev.responseBody = body; ev.responseBodyEncoding = 'text'; ev.responseBodySize = body.length;
  } else if (kind < 0.88) {
    // connection error
    ev.method = 'GET';
    ev.url = 'https://unreachable.example.com/v1/ping';
    ev.statusCode = 0;
    ev.responseHeaders = {};
    ev.error = 'Could not connect to the server.';
    ev.durationMs = rand(4000, 9000);
  } else {
    // redirect
    ev.method = 'GET';
    ev.statusCode = 301;
    ev.responseHeaders['Location'] = 'https://api.example.com/v1/users';
    ev.durationMs = rand(10, 60);
  }

  ev.durationMs = Math.round(ev.durationMs);
  ev.timestamp = now - ev.durationMs;
  ev.completedAt = now;
  return ev;
}

ws.on('open', () => {
  console.log(`demo client → ws://localhost:${PORT}/log  (one event every ${INTERVAL} ms, Ctrl-C to stop)`);
  ws.send(JSON.stringify({
    type: 'hello',
    client: {
      id: 'demo-client',
      name: `${os.hostname()} (demo)`,
      model: 'MacBook Pro',
      system: `macOS demo · node ${process.version}`,
      app: 'SampleApp 1.2.3 (45)',
    },
  }));
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'request', event: eventTemplate() }));
    }
  }, INTERVAL);
});

ws.on('close', () => {
  console.error('connection closed — is the server running? (npm start)');
  process.exit(1);
});
ws.on('error', (err) => {
  console.error('connection error:', err.message);
});
