'use strict';

const os = require('os');

/** All LAN-facing IPv4 addresses of this machine (no loopback). */
function localIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

module.exports = { localIPv4s };
