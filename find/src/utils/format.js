'use strict';
/**
 * 格式化辅助：路径拆分、扩展名、大小/时间的紧凑展示
 * 输出面向 Agent 阅读，一切以省 token 为先。
 */

/** 取路径最后一段（兼容 \ 和 /） */
function basename(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 取小写扩展名（不含点；点文件如 .gitignore 返回空串） */
function extOf(p) {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 字节数 → 人类可读（1.2 KB / 3.4 MB） */
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[u];
}

/** mtime 毫秒 → "2026-09-18 13:40"（本地时区） */
function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** mtime 毫秒 → 相对时间（"3 分钟前"） */
function relTime(ms) {
  if (!ms) return '-';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  if (d < 30) return d + ' 天前';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + ' 个月前';
  return Math.floor(mo / 12) + ' 年前';
}

/** "30m"/"2h"/"7d"/"4w" 或纯数字（按小时） → 毫秒；非法返回 null */
function parseWithin(v) {
  if (v == null || v === '') return 24 * 3600 * 1000;
  if (typeof v === 'number' && isFinite(v) && v > 0) return v * 3600 * 1000;
  const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d|w|hours?|minutes?|days?|weeks?)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] || 'h';
  const mult = unit.startsWith('m') ? 60 * 1000
    : unit.startsWith('h') ? 3600 * 1000
    : unit.startsWith('d') ? 24 * 3600 * 1000
    : unit.startsWith('w') ? 7 * 24 * 3600 * 1000
    : 3600 * 1000;
  return n * mult;
}

module.exports = { basename, extOf, fmtSize, fmtTime, relTime, parseWithin };
