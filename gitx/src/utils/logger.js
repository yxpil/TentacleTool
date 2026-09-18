'use strict';
/**
 * Gitx 简易文件日志
 * 日志写到 <项目根>/logs/gitx.log，每次追加，带时间戳
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'gitx.log');

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
}

function ts() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function write(level, msg) {
  try {
    ensureDir();
    const line = `[${ts()}] [${level}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    if (level === 'ERROR') console.error('[gitx]', line.trim());
    else console.log('[gitx]', line.trim());
  } catch (e) {
    try { console.error('[logger-fail]', e.message, msg); } catch (_) {}
  }
}

function log(msg) { write('INFO', msg); }
function warn(msg) { write('WARN', msg); }
function error(msg, err) {
  const detail = err
    ? ` | ${err.message}` + (err.stack ? ' | Stack=' + err.stack.split('\n').slice(0, 8).join(' || ') : '')
    : '';
  write('ERROR', msg + detail);
}
function request(req, extra) {
  try {
    const line = `${extra || ''} ${req.method} ${req.url} host=${req.headers.host || ''} session=${(req.headers['mcp-session-id'] || '').slice(0, 12)}`;
    write('REQ', line);
  } catch (e) {}
}

module.exports = { log, warn, error, request };
