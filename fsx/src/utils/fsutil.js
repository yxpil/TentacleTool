'use strict';
/**
 * fsx 共享文件系统工具函数（零依赖，node:fs / path / os）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** glob 模式 → 正则（针对 basename，大小写不敏感）。支持 * ? ** [...] */
function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/\\\\]*';
    } else if (c === '?') {
      re += '[^/\\\\]';
    } else if (c === '[') {
      let j = i + 1, cls = '', neg = false;
      if (pattern[j] === '!' || pattern[j] === '^') { neg = true; j++; }
      while (j < pattern.length && pattern[j] !== ']') { cls += pattern[j]; j++; }
      if (j < pattern.length) { re += '[' + (neg ? '^' : '') + cls + ']'; i = j; }
      else re += '\\[';
    } else {
      re += c.replace(/[.+^${}()|=]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

/** 前若干字节是否含 NUL（二进制判据） */
function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 猜测编码：BOM 优先，其次含 NUL 判二进制，再试 UTF-8，最后回退 Latin-1 */
function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return { encoding: 'utf8', bom: true, label: 'UTF-8 (BOM)' };
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
    return { encoding: 'utf16le', bom: true, label: 'UTF-16 LE (BOM)' };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
    return { encoding: 'utf16be', bom: true, label: 'UTF-16 BE (BOM)' };
  if (buf.includes(0)) return { encoding: 'binary', bom: false, label: '二进制（含 NUL）' };
  try {
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').equals(buf)) return { encoding: 'utf8', bom: false, label: 'UTF-8' };
  } catch (e) {}
  return { encoding: 'latin1', bom: false, label: 'ANSI/Latin-1' };
}

/** 统计字符串行数（不含末尾空行） */
function countLines(s) {
  if (!s || s.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return s.endsWith('\n') ? n : n + 1;
}

/** 把 mode 转成 rwx 字符串（best-effort，Windows 下仅反映 fs 模式位） */
function permString(mode) {
  const r = (mode & 0o400) ? 'r' : '-';
  const w = (mode & 0o200) ? 'w' : '-';
  const x = (mode & 0o100) ? 'x' : '-';
  return r + w + x;
}

/** 八进制权限（如 0o644） */
function permOctal(mode) {
  return '0o' + (mode & 0o777).toString(8).padStart(3, '0');
}

/** 安全 stat：不存在返回 null，不抛错 */
function safeStat(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

const PROTECTED_EXTRA = []; // 预留

/**
 * 受保护路径判定：盘符根、用户主目录、主目录父级、系统目录（含子目录）一律拒绝删除。
 * 入参先 path.resolve 规范化（吸收大小写变体、末尾斜杠、.. 穿越），再做大小写不敏感比较。
 * @returns {string|null} 返回拒绝原因字符串；null 表示允许
 */
function isProtected(target) {
  let resolved;
  try { resolved = path.resolve(target); } catch (e) { return '路径非法：' + e.message; }
  const t = resolved.toLowerCase();

  // 盘符根：path.parse(...).root === resolved
  const pr = path.parse(resolved);
  if (pr.root && pr.root === resolved) {
    return '盘符根目录（' + resolved + '）受保护，拒绝删除';
  }

  // 用户主目录本身
  const home = path.resolve(os.homedir());
  if (t === home.toLowerCase()) {
    return '用户主目录（' + home + '）受保护，拒绝删除';
  }
  // 主目录的父级（如 C:\Users）：删除它会抹掉所有用户数据
  const homeParent = path.dirname(home);
  if (homeParent && t === homeParent.toLowerCase()) {
    return '用户目录上层（' + homeParent + '）受保护，拒绝删除';
  }

  // 系统目录及其子目录
  const sysRoots = [];
  if (process.env.SystemRoot) sysRoots.push(path.resolve(process.env.SystemRoot));
  if (process.env.ProgramFiles) sysRoots.push(path.resolve(process.env.ProgramFiles));
  if (process.env['ProgramFiles(x86)']) sysRoots.push(path.resolve(process.env['ProgramFiles(x86)']));
  if (process.env.ProgramData) sysRoots.push(path.resolve(process.env.ProgramData));
  for (const r of sysRoots) {
    const rl = r.toLowerCase();
    if (t === rl || t.startsWith(rl + '\\') || t.startsWith(rl + '/') || t.startsWith(rl + path.sep)) {
      return '系统目录（' + r + '）或其子目录受保护，拒绝删除';
    }
  }
  return null;
}

/** 把 Date → 紧凑时间字符串 */
function fmtTime(d) {
  if (!d) return '—';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) +
    ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
}

module.exports = {
  globToRegex,
  isBinaryBuffer,
  detectEncoding,
  countLines,
  permString,
  permOctal,
  safeStat,
  isProtected,
  fmtTime
};
