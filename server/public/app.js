/* NetInspector dashboard app — vanilla JS, no build step */
(() => {
  'use strict';

  /* ------------------------------ helpers ------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v; // 文本一律走 textContent（XSS 安全）
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  /* ------------------------------ auth ------------------------------ */

  // 鉴权完全由服务端驱动：/api/auth 返回 {tokenRequired, authorized}，
  // cookie 由服务端在校验通过时下发（HttpOnly），客户端不自行管理令牌。
  let tokenRequired = false;
  let authorized = false;

  async function checkAuth() {
    const r = await fetch('/api/auth', { cache: 'no-store' });
    if (!r.ok) throw new Error('auth check failed');
    const state = await r.json();
    tokenRequired = !!state.tokenRequired;
    authorized = !!state.authorized;
    return state;
  }

  /** 校验用户输入的令牌；成功时服务端下发 cookie。返回是否授权通过。 */
  async function submitToken(value) {
    const r = await fetch('/api/auth?token=' + encodeURIComponent(value), { cache: 'no-store' });
    if (!r.ok) return false;
    const state = await r.json();
    authorized = !!state.authorized;
    return authorized;
  }

  function showAuthError() {
    const node = $('#authError');
    if (!node) return;
    node.hidden = false;
    setTimeout(() => $('#authInput')?.focus(), 50);
  }

  function hideAuthError() {
    const node = $('#authError');
    if (node) node.hidden = true;
  }

  // 授权卡片：粘贴令牌 → 服务端校验（同时下发 cookie）→ 拉取历史 → 连接 WS
  function bindAuthInput() {
    const input = $('#authInput');
    const button = $('#authBtn');
    const hint = $('#authHint');
    if (!input || !button) return;
    const submit = async () => {
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      button.disabled = true;
      button.textContent = '校验中…';
      let ok = false;
      let networkError = false;
      try {
        ok = await submitToken(value);
      } catch { networkError = true; }
      button.disabled = false;
      button.textContent = '连接';
      if (ok) {
        hint.textContent = '';
        hint.style.color = '';
        hideAuthError();
        authorized = true;
        await loadHistory();
        connect();
        append('✓ 令牌验证通过，已连接');
        return;
      }
      hint.style.color = 'var(--red)';
      hint.textContent = networkError
        ? '❌ 网络错误，请稍后重试'
        : '❌ 令牌不匹配 —— 请核对服务端 TOKEN 环境变量的值后重试';
      input.focus();
    };
    button.addEventListener('click', submit);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
  }

  const fmtBytes = (n) => {
    n = +n || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
  };

  const fmtDur = (ms) => {
    ms = +ms || 0;
    if (ms <= 0) return '0 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  };
  const fmtTime = (ts) => new Date(+ts || 0).toLocaleTimeString([], { hour12: false });
  const fmtFullTime = (ts) => new Date(+ts || 0).toLocaleString([], { hour12: false });

  const METHOD_CLASS = { GET: 'm-get', POST: 'm-post', PUT: 'm-put', PATCH: 'm-patch', DELETE: 'm-delete', HEAD: 'm-head', OPTIONS: 'm-options' };
  const methodChip = (m) => el('span', { class: `chip ${METHOD_CLASS[m] || 'm-head'}`, text: m });

  function classOf(e) {
    if (e.error) return 'error';
    if (e.statusCode == null || !e.statusCode) return 'pending';
    const s = Math.floor(e.statusCode / 100);
    return s === 2 ? 'ok' : s === 3 ? 'redirect' : s === 4 ? 'client' : 'server';
  }

  function statusChip(e) {
    if (e.error) return el('span', { class: 'st-err', text: 'ERR' });
    if (!e.statusCode) return el('span', { class: 'st st-0', text: '···' });
    return el('span', { class: `st st-${Math.floor(e.statusCode / 100)}`, text: String(e.statusCode) });
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    t.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => { t.hidden = true; }, 400); }, 1400);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied ✓'); }
    catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied ✓'); } catch { toast('Copy failed'); }
      ta.remove();
    }
  }

  /* ------------------------------ state ------------------------------ */

  const state = {
    events: [],            // newest last (append order)
    byId: new Map(),
    detailCache: new Map(),
    selectedId: null,
    paused: false,
    pending: [],           // events buffered while paused
    follow: true,
    predicates: [],
    clients: [],
    multiClient: false,
    tab: 'overview',
    current: null,         // full event shown in detail pane
  };

  /* ------------------------------ list rendering ------------------------------ */

  const tbody = $('#listBody');
  const scroller = $('#listScroller');

  function rowFor(e) {
    const tr = el('tr', { 'data-id': e.id, class: 'new' });
    tr.append(el('td', { class: 'c-method' }, methodChip(e.method)));

    const pathTd = el('td', { class: 'c-path' });
    if (e.host) pathTd.append(el('span', { class: 'host', text: e.host }));
    pathTd.append(document.createTextNode(e.path || '/'));
    if (e.query) {
      const short = e.query.length > 30 ? `${e.query.slice(0, 30)}…` : e.query;
      pathTd.append(el('span', { class: 'q', text: `?${short}` }));
    }
    tr.append(pathTd);

    tr.append(el('td', { class: 'c-status' }, statusChip(e)));

    const d = +e.durationMs || 0;
    const durTd = el('td', { class: `c-dur${d > 3000 ? ' dur-slow' : d > 800 ? ' dur-mid' : ''}`, text: fmtDur(d) });
    tr.append(durTd);

    tr.append(el('td', { class: 'c-size', text: fmtBytes(e.responseBodySize || 0) }));
    tr.append(el('td', { class: 'c-time', text: fmtTime(e.timestamp) }));
    if (state.multiClient) tr.append(el('td', { class: 'c-dev', text: e.clientName || '' }));

    tr.addEventListener('animationend', () => tr.classList.remove('new'), { once: true });
    return tr;
  }

  function matches(e) {
    for (const p of state.predicates) if (!p(e)) return false;
    return true;
  }

  function appendRow(e) {
    if (!matches(e)) return;
    tbody.append(rowFor(e));
    // keep DOM bounded
    while (tbody.rows.length > 1200) tbody.deleteRow(0);
    $('#emptyList').style.display = 'none';
    if (state.follow) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  function refilter() {
    tbody.textContent = '';
    let shown = 0;
    for (const e of state.events) {
      if (matches(e)) {
        const row = rowFor(e).cloneNode(true);
        row.classList.remove('new'); // no flash animation on rebuilds
        tbody.append(row);
        shown++;
      }
    }
    $('#emptyList').style.display = shown ? 'none' : 'flex';
    updateStats();
    updateSelectionHighlight();
    if (state.follow) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  function updateStats() {
    const shown = [...state.events].filter(matches).length;
    $('#stats').textContent = `${shown} / ${state.events.length}`;
  }

  function updateSelectionHighlight() {
    const prev = tbody.querySelector('tr.selected');
    if (prev) prev.classList.remove('selected');
    if (!state.selectedId) return;
    const row = tbody.querySelector(`tr[data-id="${CSS.escape(state.selectedId)}"]`);
    if (row) row.classList.add('selected');
  }

  function ingest(e, { silent = false } = {}) {
    if (!e || !e.id) return;
    const known = state.byId.get(e.id);
    state.byId.set(e.id, e);
    if (known) {
      const i = state.events.indexOf(known);
      if (i >= 0) state.events[i] = e;
    } else {
      state.events.push(e);
      if (state.events.length > 3000) {
        const dropped = state.events.shift();
        if (dropped) { state.byId.delete(dropped.id); state.detailCache.delete(dropped.id); }
      }
    }
    if (state.paused && !silent) {
      state.pending.push(e);
      updateStats();
      $('#pauseBtn').textContent = `▶ Resume (${state.pending.length})`;
      $('#followBtn').hidden = false;
      return;
    }
    if (silent) return;
    appendRow(e);
    updateStats();
  }

  /* ------------------------------ filters ------------------------------ */

  function buildPredicates() {
    const preds = [];
    const meth = $('#methodFilter').value;
    const st = $('#statusFilter').value;
    if (meth) preds.push((e) => e.method === meth);
    if (st) preds.push((e) => classOf(e) === st);

    const q = $('#search').value.trim().toLowerCase();
    for (const t of q.split(/\s+/).filter(Boolean)) {
      let m;
      if ((m = t.match(/^method:(\w+)$/))) { const v = m[1].toUpperCase(); preds.push((e) => e.method === v); }
      else if ((m = t.match(/^status:(\d)xx$/))) { const v = +m[1]; preds.push((e) => e.statusCode != null && Math.floor(e.statusCode / 100) === v); }
      else if ((m = t.match(/^status:([<>]=?)(\d+)$/))) { const op = m[1]; const v = +m[2]; preds.push((e) => e.statusCode != null && (op === '>' ? e.statusCode > v : op === '>=' ? e.statusCode >= v : op === '<' ? e.statusCode < v : e.statusCode <= v)); }
      else if ((m = t.match(/^status:(\d+)$/))) { const v = +m[1]; preds.push((e) => e.statusCode === v); }
      else if ((m = t.match(/^host:(\S+)$/))) { const v = m[1]; preds.push((e) => (e.host || '').toLowerCase().includes(v)); }
      else preds.push((e) => `${e.url || ''} ${e.error || ''}`.toLowerCase().includes(t));
    }
    state.predicates = preds;
    refilter();
  }

  /* ------------------------------ detail pane ------------------------------ */

  async function select(id) {
    state.selectedId = id;
    updateSelectionHighlight();
    const row = tbody.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });

    let full = state.detailCache.get(id);
    const summary = state.byId.get(id);
    if (!full) {
      try {
        const r = await fetch(`/api/logs/${encodeURIComponent(id)}`);
        if (r.ok) { full = await r.json(); state.detailCache.set(id, full); }
      } catch { /* offline */ }
    }
    renderDetail(full || summary);
  }

  function renderDetail(e) {
    if (!e) { $('#detail').hidden = true; $('#detailEmpty').style.display = 'flex'; return; }
    state.current = e;
    $('#detailEmpty').style.display = 'none';
    $('#detail').hidden = false;

    const dm = $('#dMethod'); dm.textContent = ''; dm.append(methodChip(e.method));
    const ds = $('#dStatus'); ds.textContent = ''; ds.append(statusChip(e));
    if (e.error) ds.append(el('span', { class: 'meta', text: e.error.slice(0, 80) }));
    else if (e.statusCode >= 300 && e.statusCode < 400) {
      const loc = e.responseHeaders['Location'] || e.responseHeaders['location'];
      if (loc) ds.append(el('span', { class: 'meta', text: `→ ${loc}`, title: loc }));
    }
    $('#dDur').textContent = '';
    $('#dDur').append(el('b', { text: fmtDur(e.durationMs) }));
    $('#dSize').textContent = '';
    $('#dSize').append(el('b', { text: fmtBytes(e.responseBodySize || 0) }));
    const url = $('#dUrl'); url.textContent = e.url || ''; url.title = e.url || '';
    renderTab();
  }

  function sectionCard(title, ...children) {
    const card = el('div', { class: 'sectionCard' });
    card.append(el('h3', {}, title));
    for (const c of children) if (c) card.append(c);
    return card;
  }

  function renderTab() {
    const e = state.current;
    const root = $('#tabContent');
    root.textContent = '';
    if (!e) return;

    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));

    if (state.tab === 'overview') root.append(renderOverview(e));
    else if (state.tab === 'request') root.append(renderRequest(e));
    else root.append(renderResponse(e));
  }

  function infoGrid(pairs) {
    const grid = el('div', { class: 'infoGrid' });
    for (const [k, v] of pairs) {
      grid.append(el('dt', { text: k }));
      grid.append(el('dd', {}, v));
    }
    return grid;
  }

  function renderOverview(e) {
    const frag = document.createDocumentFragment();

    if (e.error) frag.append(el('div', { class: 'errorBox', text: `⚠ ${e.error}` }));
    if (e.requestBodyTruncated || e.responseBodyTruncated) {
      frag.append(el('div', { class: 'banner', text: 'Body truncated — captured bytes are limited by maxBodyCaptureBytes on the client / MAX_BODY_BYTES on the server.' }));
    }

    const pairs = [
      ['URL', e.url || ''],
      ['Method', e.method],
      ['Status', e.error ? `Error — ${e.error}` : `${e.statusCode}${e.statusCode >= 300 && e.statusCode < 400 ? ' (redirect)' : ''}`],
      ['Content-Type', e.responseContentType || e.responseMimeType || '—'],
      ['Started', fmtFullTime(e.timestamp)],
      ['Completed', fmtFullTime(e.completedAt)],
      ['Duration', fmtDur(e.durationMs)],
      ['Request body', `${fmtBytes(e.requestBodySize || 0)}${e.requestBodyEncoding === 'base64' ? ' · binary' : ''}${e.requestBodyTruncated ? ' · truncated' : ''}`],
      ['Response body', `${fmtBytes(e.responseBodySize || 0)}${e.responseBodyEncoding === 'base64' ? ' · binary' : ''}${e.responseBodyTruncated ? ' · truncated' : ''}`],
      ['Host', e.host || '—'],
      ['Scheme', e.scheme || '—'],
      ['Device', e.clientName || '—'],
    ];
    frag.append(sectionCard('General', infoGrid(pairs)));

    if (e.query) {
      const tbl = paramsTable(parseQuery(e.query));
      frag.append(sectionCard('Query Parameters', tbl));
    }
    return frag;
  }

  function parseQuery(q) {
    const out = [];
    for (const [k, v] of new URLSearchParams(q)) out.push([k, v]);
    return out;
  }

  function paramsTable(pairs) {
    const tbl = el('table', { class: 'kv' });
    for (const [k, v] of pairs) tbl.append(el('tr', {}, el('td', { class: 'k', text: k, title: k }), el('td', { class: 'v', text: v })));
    return tbl.rows.length ? tbl : el('div', { class: 'binaryDesc', text: '(empty)' });
  }

  function headersTable(headers) {
    const tbl = el('table', { class: 'kv' });
    const entries = Object.entries(headers || {});
    for (const [k, v] of entries) tbl.append(el('tr', {}, el('td', { class: 'k', text: k, title: k }), el('td', { class: 'v', text: String(v) })));
    return entries.length ? tbl : el('div', { class: 'binaryDesc', text: '(no headers)' });
  }

  function renderRequest(e) {
    const frag = document.createDocumentFragment();
    if (e.query) frag.append(sectionCard('Query Parameters', paramsTable(parseQuery(e.query))));
    frag.append(sectionCard('Request Headers', headersTable(e.requestHeaders)));
    frag.append(sectionCard('Request Body', bodyPanel(e, 'request')));
    return frag;
  }

  function renderResponse(e) {
    const frag = document.createDocumentFragment();
    frag.append(sectionCard('Response Headers', headersTable(e.responseHeaders)));
    frag.append(sectionCard('Response Body', bodyPanel(e, 'response')));
    return frag;
  }

  /* ------------------------------ body viewer ------------------------------ */

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function u8ToBase64(u8) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function downloadBytes(u8, name, mime) {
    const blob = new Blob([u8], { type: mime || 'application/octet-stream' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name || 'file.bin' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ------------------------------ multipart parts ------------------------------ */

  function partImagePreview(p, partType) {
    return imagePreviewEl(p.data, partType, p.disposition.filename, p.truncated);
  }

  /** 图片 mime 白名单：仅栅格格式允许进 data: URL（拒绝 svg 等可执行内容） */
  const SAFE_IMAGE_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif|ico|heic|heif|tiff?)$/i;
  const isSafeImageMime = (mime) => SAFE_IMAGE_RE.test(String(mime || '').split(';')[0].trim());

  /** Image preview with graceful degradation (truncated / undecodable data). */
  function imagePreviewEl(bytes, mime, name, truncated) {
    if (truncated) {
      return el('div', { class: 'imgNote', text: '⚠ image truncated at capture limit — cannot preview, download the raw body instead' });
    }
    const img = el('img', { class: 'imgPreview', alt: name || 'preview' });
    img.src = `data:${mime};base64,${u8ToBase64(bytes)}`;
    img.addEventListener('error', () => {
      img.replaceWith(el('div', { class: 'imgNote', text: '⚠ image data incomplete or undecodable — see hex preview below' }));
    });
    return img;
  }

  function renderMultipartParts(parsed) {
    return parsed.parts.map((p, i) => {
      const card = el('div', { class: 'partCard' });

      const decoded = MultipartParser.tryUTF8(p.data);
      const isText = decoded !== null && MultipartParser.isPlainText(decoded);
      const partType = p.headers['content-type'] || (isText ? 'text/plain' : 'application/octet-stream');
      const isFile = !!p.disposition.filename;

      // ---- labeled meta: #index · disposition type + name/filename/content-type/size ----
      const meta = el('div', { class: 'partMeta' });
      meta.append(el('span', { class: 'partIdx', text: `#${i + 1}` }));
      meta.append(el('span', { class: 'partKind', text: p.disposition.type || 'part' }));

      const fields = el('div', { class: 'partFields' });
      const addField = (key, value, cls) => {
        fields.append(el('div', { class: 'pf' },
          el('span', { class: 'pfk', text: key }),
          el('span', { class: `pfv${cls ? ' ' + cls : ''}`, text: value })));
      };
      addField('name', p.disposition.name || '(unnamed)', p.disposition.name ? 'partName' : 'dim');
      if (p.disposition.filename) addField('filename', p.disposition.filename, 'partFile');
      addField('content-type', partType);
      addField('size', fmtBytes(p.size));
      meta.append(fields);

      if (p.truncated) meta.append(el('span', { class: 'badge-trunc', text: 'truncated' }));
      card.append(meta);

      // ---- value area ----
      if (isFile && !isText) {
        // binary file part: tools + (optional) preview + hexdump
        const tools = el('div', { class: 'partTools' },
          el('button', {
            class: 'btn mini',
            text: 'Download',
            onclick: () => downloadBytes(p.data, p.disposition.filename || `part-${i + 1}.bin`, partType),
          }));
        card.append(tools);
        if (isSafeImageMime(partType) && p.size < 8 * 1024 * 1024) {
          card.append(partImagePreview(p, partType));
        }
        card.append(el('pre', { class: 'hex', text: hexdump(p.data, 160) }));
      } else {
        // text form field (or text file): show the value
        card.append(el('pre', { class: 'raw', text: decoded ?? '(binary)' }));
      }
      return card;
    });
  }

  function hexdump(u8, max = 224) {
    const lines = [];
    const n = Math.min(u8.length, max);
    for (let i = 0; i < n; i += 16) {
      const slice = u8.subarray(i, Math.min(i + 16, n));
      const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
      const ascii = [...slice].map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '·').join('');
      lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
    }
    if (u8.length > n) lines.push(`… ${u8.length - n} more bytes`);
    return lines.join('\n');
  }

  function downloadBody(e, side) {
    const b64 = e[`${side}Body`];
    if (!b64) return;
    const mime = (side === 'request' ? e.requestContentType : e.responseMimeType || e.responseContentType) || 'application/octet-stream';
    let bytes;
    try { bytes = e[`${side}BodyEncoding`] === 'base64' ? b64ToU8(b64) : new TextEncoder().encode(b64); }
    catch { return; }
    const blob = new Blob([bytes], { type: mime });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${side}-${e.id}.bin` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function bodyPanel(e, side) {
    const body = e[`${side}Body`] || '';
    const enc = e[`${side}BodyEncoding`] || 'none';
    const size = e[`${side}BodySize`] || 0;
    const truncated = !!e[`${side}BodyTruncated`];
    const mime = (side === 'request' ? e.requestContentType : (e.responseMimeType || e.responseContentType)) || '';

    if (enc === 'none' || (!body && !size)) {
      return el('div', { class: 'binaryDesc', text: '(no body)' });
    }

    const wrap = el('div', {});
    const metaBits = [fmtBytes(size), enc === 'base64' ? 'binary' : 'text', mime].filter(Boolean);
    const actions = el('span', { class: 'right' });

    if (truncated) {
      const by = e[`${side}BodyTruncatedBy`];
      const who = by === 'server'
        ? '服务端存储上限 MAX_BODY_BYTES（重启服务端时调大，如 MAX_BODY_BYTES=$((128*1024*1024)) npm start）'
        : '客户端捕获上限 maxBodyCaptureBytes（iOS 端 -start 前调大）';
      wrap.append(el('div', {
        class: 'banner',
        text: `⚠ Body 已截断（${who}）— 显示前 ${fmtBytes(body.length)} / 原始 ${fmtBytes(size)}`,
      }));
    }

    // ---- multipart/form-data (request or response, text or base64) ----
    if (/^multipart\//i.test(mime)) {
      let bytes = null;
      try { bytes = enc === 'base64' ? b64ToU8(body) : new TextEncoder().encode(body); } catch { bytes = null; }
      const parsed = bytes ? MultipartParser.parseMultipart(bytes, mime) : null;

      if (parsed) {
        actions.append(
          el('button', { class: 'btn mini', text: 'Copy', onclick: () => copyText(body) }),
          el('button', { class: 'btn mini', text: 'Download', onclick: () => downloadBody(e, side) }),
        );
        wrap.append(sectionCard(`Body · ${metaBits.join(' · ')}`, actions));

        const partsBtn = el('button', { class: 'btn mini active', text: `Parts (${parsed.parts.length})` });
        const rawBtn = el('button', { class: 'btn mini', text: 'Raw' });
        const container = el('div', {});
        container.append(sectionCard(`Multipart · boundary=${parsed.boundary}`, el('span', { class: 'right' }, partsBtn, rawBtn)));

        const partsView = el('div', { class: 'parts' }, ...renderMultipartParts(parsed));
        const rawView = el('pre', {
          class: 'raw',
          text: enc === 'base64' ? hexdump(bytes) : body,
        });
        const setMode = (m) => {
          partsBtn.classList.toggle('active', m === 'parts');
          rawBtn.classList.toggle('active', m === 'raw');
          partsView.style.display = m === 'parts' ? '' : 'none';
          rawView.style.display = m === 'raw' ? '' : 'none';
        };
        partsBtn.addEventListener('click', () => setMode('parts'));
        rawBtn.addEventListener('click', () => setMode('raw'));
        rawView.style.display = 'none';
        container.append(partsView, rawView);
        wrap.append(container);
        return wrap;
      }
      // unparsable (e.g. boundary missing from a truncated capture) → raw/hex below
    }

    if (enc === 'base64') {
      actions.append(
        el('button', { class: 'btn mini', text: 'Download', onclick: () => downloadBody(e, side) }),
        el('button', { class: 'btn mini', text: 'Copy (base64)', onclick: () => copyText(body) }),
      );
      wrap.append(sectionCard(`Body · ${metaBits.join(' · ')}`, actions));
      const box = el('div', { class: 'binaryBox' });
      let u8 = null;
      try { u8 = b64ToU8(body); } catch { /* invalid base64 */ }
      if (u8) {
        if (isSafeImageMime(mime) && u8.length < 8 * 1024 * 1024) {
          box.append(imagePreviewEl(u8, mime, 'preview', truncated));
        }
        box.append(el('pre', { class: 'hex', text: hexdump(u8) }));
      }
      wrap.append(box);
      return wrap;
    }

    // ---- text body ----
    actions.append(
      el('button', { class: 'btn mini', text: 'Copy', onclick: () => copyText(body) }),
      el('button', { class: 'btn mini', text: 'Download', onclick: () => downloadBody(e, side) }),
    );
    wrap.append(sectionCard(`Body · ${metaBits.join(' · ')}`, actions));

    let parsed = null;
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(body); } catch { parsed = null; }
    }

    const isUrlencoded = /application\/x-www-form-urlencoded/i.test(mime);

    if (parsed !== null && typeof parsed === 'object') {
      let mode = 'pretty';
      const container = el('div', {});
      const prettyBtn = el('button', { class: 'btn mini active', text: 'Pretty', onclick: () => setMode('pretty') });
      const rawBtn = el('button', { class: 'btn mini', text: 'Raw', onclick: () => setMode('raw') });
      const copyBtn = el('button', { class: 'btn mini', text: 'Copy formatted', onclick: () => copyText(JSON.stringify(parsed, null, 2)) });
      container.append(sectionCard('JSON', el('span', { class: 'right' }, prettyBtn, rawBtn, copyBtn)));

      const prettyView = el('div', {}, jsonTree(parsed));
      const rawView = el('pre', { class: 'raw', text: body });
      const setMode = (m) => {
        mode = m;
        prettyBtn.classList.toggle('active', m === 'pretty');
        rawBtn.classList.toggle('active', m === 'raw');
        prettyView.style.display = m === 'pretty' ? '' : 'none';
        rawView.style.display = m === 'raw' ? '' : 'none';
      };
      rawView.style.display = 'none';
      container.append(prettyView, rawView);
      wrap.append(container);
      return wrap;
    }

    if (isUrlencoded && side === 'request') {
      try {
        const pairs = parseQuery(body);
        if (pairs.length) wrap.append(sectionCard('Form Fields', paramsTable(pairs)));
      } catch { /* fall through to raw */ }
    }

    wrap.append(el('pre', { class: 'raw', text: body }));
    return wrap;
  }

  /* ------------------------------ JSON tree ------------------------------ */

  function jsonTree(value) {
    return el('div', { class: 'jtree' }, jsonNode(value, '', 0, true));
  }

  function jsonNode(value, key, depth, isRoot) {
    if (value === null || typeof value !== 'object') {
      const line = el('div', { class: 'jline' });
      if (key) line.append(el('span', { class: 'jkey', text: `"${key}": ` }));
      if (value === null) line.append(el('span', { class: 'jnull', text: 'null' }));
      else if (typeof value === 'number') line.append(el('span', { class: 'jnum', text: String(value) }));
      else if (typeof value === 'boolean') line.append(el('span', { class: 'jbool', text: String(value) }));
      else line.append(longStringSpan(String(value)));
      return line;
    }

    const isArr = Array.isArray(value);
    const entries = isArr ? value.map((v, i) => [String(i), v]) : Object.entries(value);

    const head = el('div', { class: 'jline jhead' });
    const caret = el('span', { class: 'jcaret', text: '▾' });
    if (key) head.append(el('span', { class: 'jkey', text: `"${key}": ` }));
    head.append(el('span', { class: 'jbrk', text: `${isArr ? '[' : '{'} ${entries.length} ${isArr ? 'items' : 'keys'} ${isArr ? ']' : '}'}` }));

    const kids = el('div', { class: 'jkids' });
    const LIMIT = 200;
    for (let i = 0; i < Math.min(entries.length, LIMIT); i++) {
      const [k, v] = entries[i];
      kids.append(jsonNode(v, k, depth + 1, false));
    }
    if (entries.length > LIMIT) {
      kids.append(el('div', { class: 'jmore', text: `… ${entries.length - LIMIT} more items` }));
    }

    const collapsed = !isRoot && (depth >= 3 || (depth >= 1 && entries.length > 8));
    const node = el('div', { class: `jnode${collapsed ? ' closed' : ''}` }, head, kids);
    if (collapsed) caret.textContent = '▸';
    const toggle = () => {
      node.classList.toggle('closed');
      caret.textContent = node.classList.contains('closed') ? '▸' : '▾';
    };
    head.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(); });
    return node;
  }

  function longStringSpan(s) {
    const LIMIT = 1000;
    if (s.length <= LIMIT) return el('span', { class: 'jstr', text: `"${s}"`, title: s });
    const short = s.slice(0, LIMIT);
    const span = el('span', { class: 'jstr expandable', text: `"${short}… (${s.length} chars)"`, title: 'click to expand' });
    let expanded = false;
    span.addEventListener('click', (ev) => {
      ev.stopPropagation();
      expanded = !expanded;
      span.textContent = expanded ? `"${s}"` : `"${short}… (${s.length} chars)"`;
    });
    return span;
  }

  /* ------------------------------ cURL ------------------------------ */

  function toCurl(e) {
    const q = (s) => String(s).replaceAll("'", "'\\''");
    const parts = [`curl -X ${e.method} '${q(e.url)}'`];
    for (const [k, v] of Object.entries(e.requestHeaders || {})) {
      const name = k.toLowerCase();
      if (name === 'content-length' || name === 'host') continue;
      parts.push(`  -H '${q(k)}: ${q(v)}'`);
    }
    if (e.requestBodyEncoding === 'text' && e.requestBody) {
      parts.push(`  --data-binary '${q(e.requestBody)}'`);
    } else if (e.requestBodyEncoding === 'base64' && e.requestBodySize) {
      parts.push(`  # binary body (${fmtBytes(e.requestBodySize)}) omitted`);
    }
    return parts.join(' \\\n');
  }

  /* ------------------------------ WebSocket ------------------------------ */

  let ws;
  let retries = 0;

  function setConn(cls, text) {
    const c = $('#conn');
    c.className = `conn ${cls}`;
    $('#connText').textContent = text;
  }

  function connect() {
    setConn('connecting', 'connecting…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/dashboard`);

    ws.onopen = () => { retries = 0; setConn('online', 'live'); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'event' && m.event) ingest(m.event);
      else if (m.type === 'cleared') clearAll();
      else if (m.type === 'clients') setClients(m.clients || []);
      else if (m.type === 'hello') setClients(m.clients || []);
    };
    ws.onclose = (ev) => {
      setConn('offline', 'offline');
      // 授权遮罩由 checkAuth() 的结果驱动，这里只做自动重连
      const delay = Math.min(15000, 500 * 2 ** retries++);
      setTimeout(connect, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  function setClients(list) {
    state.clients = list;
    const multi = list.length > 1;
    if (multi !== state.multiClient) {
      state.multiClient = multi;
      document.querySelector('#list .c-dev').hidden = !multi;
      refilter();
    }
    const c = $('#clients');
    if (!list.length) { c.textContent = ''; return; }
    const names = list.map((d) => `${d.name || d.model || d.id}${d.app ? ` — ${d.app}` : ''}`).join('\n');
    c.textContent = `📱 ${list.length} device${list.length > 1 ? 's' : ''}${list.length === 1 ? ` · ${list[0].name || list[0].model || ''}` : ''}`;
    c.title = names;
  }

  function clearAll() {
    state.events = [];
    state.byId.clear();
    state.detailCache.clear();
    state.pending = [];
    state.selectedId = null;
    state.current = null;
    tbody.textContent = '';
    $('#emptyList').style.display = 'flex';
    $('#detail').hidden = true;
    $('#detailEmpty').style.display = 'flex';
    $('#pauseBtn').textContent = '⏸ Pause';
    updateStats();
  }

  /* ------------------------------ UI wiring ------------------------------ */

  function bindUI() {
    tbody.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-id]');
      if (tr) select(tr.dataset.id);
    });

    let searchTimer;
    $('#search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(buildPredicates, 120);
    });
    $('#methodFilter').addEventListener('change', buildPredicates);
    $('#statusFilter').addEventListener('change', buildPredicates);

    $('#pauseBtn').addEventListener('click', togglePause);
    function togglePause() {
      state.paused = !state.paused;
      $('#pauseBtn').classList.toggle('active', state.paused);
      if (!state.paused) {
        const pending = state.pending;
        state.pending = [];
        $('#pauseBtn').textContent = '⏸ Pause';
        $('#followBtn').hidden = true;
        for (const e of pending) appendRow(e);
        updateStats();
      } else {
        $('#pauseBtn').textContent = '▶ Resume';
      }
    }

    $('#clearBtn').addEventListener('click', async () => {
      try { await fetch('/api/logs', { method: 'DELETE' }); } catch { /* ignore */ }
      clearAll(); // optimistic; server broadcast is idempotent
    });

    $('#followBtn').addEventListener('click', () => {
      state.follow = true;
      $('#followBtn').hidden = true;
      scroller.scrollTop = scroller.scrollHeight;
    });

    scroller.addEventListener('scroll', () => {
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 28;
      state.follow = atBottom;
      if (atBottom) $('#followBtn').hidden = true;
    });

    document.querySelectorAll('#tabs .tab').forEach((btn) => {
      btn.addEventListener('click', () => { state.tab = btn.dataset.tab; renderTab(); });
    });

    $('#copyUrlBtn').addEventListener('click', () => { if (state.current) copyText(state.current.url || ''); });
    $('#copyCurlBtn').addEventListener('click', () => { if (state.current) copyText(toCurl(state.current)); });

    document.addEventListener('keydown', (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
        if (ev.key === 'Escape') t.blur();
        return;
      }
      if (ev.code === 'Space') { ev.preventDefault(); togglePause(); return; }
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      const rows = [...tbody.querySelectorAll('tr[data-id]')];
      if (!rows.length) return;
      const currentIdx = rows.findIndex((r) => r.dataset.id === state.selectedId);
      let nextIdx = currentIdx < 0 ? 0 : currentIdx + (ev.key === 'ArrowDown' ? 1 : -1);
      nextIdx = Math.max(0, Math.min(rows.length - 1, nextIdx));
      select(rows[nextIdx].dataset.id);
    });
  }

  /* ------------------------------ splitter ------------------------------ */

  function initSplitter() {
    const splitter = $('#splitter');
    const main = $('#main');
    const listPane = $('#listPane');
    let dragging = false;

    const apply = (px) => {
      const min = 280;
      const max = main.clientWidth - 360;
      const w = Math.max(min, Math.min(max, px));
      listPane.style.setProperty('width', `${w}px`);
      listPane.style.setProperty('flex', 'none');
    };

    const saved = localStorage.getItem('ni.listW');
    if (saved) apply(+saved);

    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      splitter.classList.add('drag');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = main.getBoundingClientRect();
      apply(e.clientX - rect.left);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('drag');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('ni.listW', listPane.getBoundingClientRect().width.toFixed(0));
    });
    splitter.addEventListener('dblclick', () => {
      localStorage.removeItem('ni.listW');
      listPane.style.removeProperty('width');
      listPane.style.removeProperty('flex');
    });
  }

  /* ------------------------------ init ------------------------------ */

  async function loadHistory() {
    try {
      const r = await fetch('/api/logs?limit=1000');
      const j = await r.json();
      for (const ev of (j.logs || []).reverse()) {
        state.events.push(ev);
        state.byId.set(ev.id, ev);
      }
      refilter();
    } catch { /* server restarted; ws will bring new events */ }
  }

  (async function init() {
    bindUI();
    bindAuthInput();
    initSplitter();
    try {
      const state = await checkAuth();
      if (!state.authorized) {
        showAuthError(); // 服务端要求令牌且当前未授权 → 显示授权卡片
        return;          // 不连接 WS、不拉历史；用户在卡片里提交后再继续
      }
    } catch {
      setConn('offline', 'offline'); // 网络错误：稍后由用户刷新重试
      return;
    }
    await loadHistory();
    connect();
  })();
})();
