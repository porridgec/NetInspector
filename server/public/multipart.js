/* NetInspector — multipart/form-data parser (browser + Node testable) */
(function (root) {
  'use strict';

  const ENC = new TextEncoder();

  function indexOfBytes(hay, needle, from) {
    if (!hay || !needle || !needle.length) return -1;
    const first = needle[0];
    outer: for (let i = from | 0; i <= hay.length - needle.length; i++) {
      if (hay[i] !== first) continue;
      for (let j = 1; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /** Strict UTF-8 decode — null when the bytes are not valid UTF-8. */
  function tryUTF8(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return null; }
  }

  /** No unprintable control chars (allow \t \n \r) — mirrors the iOS heuristic. */
  function isPlainText(s) {
    if (s === null) return false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) return false;
    }
    return true;
  }

  /** `multipart/form-data; boundary="abc"` → "abc" (quoted or bare). */
  function extractBoundary(contentType) {
    if (!contentType) return null;
    const m = String(contentType).match(/boundary=(?:"([^"]+)"|([^";\s]+))/i);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  }

  function parseHeaderBlock(block) {
    const headers = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return headers;
  }

  /** `form-data; name="a"; filename="b.png"` → {type, name, filename} */
  function dispositionParams(disposition) {
    const out = { type: '', name: '', filename: '' };
    if (!disposition) return out;
    out.type = disposition.split(';')[0].trim().toLowerCase();
    const rx = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g;
    let m;
    while ((m = rx.exec(disposition))) {
      out[m[1].toLowerCase()] = (m[2] !== undefined) ? m[2].replace(/\\(.)/g, '$1') : m[3];
    }
    return out;
  }

  /**
   * Byte-level multipart parser — works for text-encoded and base64-decoded
   * bodies alike. Returns { boundary, parts, truncated } or null.
   * Each part: { headers, disposition, data(Uint8Array), size, truncated }.
   */
  function parseMultipart(bytes, contentType) {
    const boundary = extractBoundary(contentType);
    if (!boundary || !bytes || !bytes.length) return null;

    const dash = ENC.encode('--' + boundary);
    const crlfDash = ENC.encode('\r\n--' + boundary);
    const lfDash = ENC.encode('\n--' + boundary);      // lenient: LF-only bodies
    const headSep = ENC.encode('\r\n\r\n');
    const headSepLf = ENC.encode('\n\n');

    let pos = indexOfBytes(bytes, dash, 0);
    if (pos < 0) return null;
    pos += dash.length;

    const parts = [];
    const MAX_PARTS = 200;
    let truncated = false;

    while (pos < bytes.length && parts.length < MAX_PARTS) {
      // After a boundary comes: '--' (closing), CRLF, padding, or (lenient) LF.
      if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) break;              // --
      if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;           // CRLF
      else if (bytes[pos] === 0x0a) pos += 1;                                  // LF
      else if (bytes[pos] === 0x20 || bytes[pos] === 0x09) { pos += 1; continue; } // padding
      else break;

      let headerBlock = '';
      let dataStart = pos;
      let headEnd = indexOfBytes(bytes, headSep, pos);
      if (headEnd >= 0) {
        headerBlock = tryUTF8(bytes.subarray(pos, headEnd)) || '';
        dataStart = headEnd + headSep.length;
      } else {
        const headEndLf = indexOfBytes(bytes, headSepLf, pos);
        if (headEndLf >= 0) {
          headerBlock = tryUTF8(bytes.subarray(pos, headEndLf)) || '';
          dataStart = headEndLf + headSepLf.length;
        } else {
          truncated = true; // capture limit hit inside the header block
        }
      }

      let next = indexOfBytes(bytes, crlfDash, dataStart);
      let delimLen = 2 + dash.length;
      if (next < 0) {
        const lfNext = indexOfBytes(bytes, lfDash, dataStart);
        if (lfNext >= 0) {
          next = lfNext;
          delimLen = 1 + dash.length;
        }
      }
      const dataEnd = next >= 0 ? next : bytes.length;
      const data = bytes.subarray(dataStart, dataEnd);

      const headers = parseHeaderBlock(headerBlock);
      parts.push({
        headers,
        disposition: dispositionParams(headers['content-disposition']),
        data,
        size: data.length,
        truncated: next < 0,
      });
      if (next < 0) truncated = true;
      if (next < 0) break;

      pos = next + delimLen; // skip line ending + boundary
    }

    return parts.length ? { boundary, parts, truncated } : null;
  }

  const api = { parseMultipart, extractBoundary, tryUTF8, isPlainText, dispositionParams, indexOfBytes };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MultipartParser = api;
})(typeof self !== 'undefined' ? self : this);
