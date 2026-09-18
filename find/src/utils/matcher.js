'use strict';
/**
 * 文件名匹配器：sub / fuzzy / glob / regex 四种模式 + 评分排序
 *
 * 评分（越高越靠前，同分按修改时间新→旧）：
 *   100  文件名与查询完全相等
 *    90  glob / regex 命中文件名
 *    80  文件名以查询开头
 *    60  文件名包含查询
 *    40  glob / regex 命中完整路径
 *    30  完整路径包含查询
 *   20+  模糊命中（查询字符按序出现在文件名中，连续/词首加分）
 *
 * 全部大小写不敏感（Windows 习惯），路径查询中 / 自动当作 \ 处理。
 */
const { basename, extOf } = require('./format');

/** glob → RegExp：** 跨目录，* 单段内，? 单字符；大小写不敏感 */
function toGlobRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^\\\\/]*';
    } else if (c === '?') {
      re += '[^\\\\/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re, 'i');
}

/** 模糊匹配：query 的字符按序出现在 name 中即命中，返回 20+ 分，未命中 -1（name/query 均已小写） */
function fuzzyScore(name, query) {
  let ni = 0, streak = 0, bonus = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    if (ch === ' ' || ch === '\\' || ch === '/') continue;
    const idx = name.indexOf(ch, ni);
    if (idx < 0) return -1;
    if (idx === ni) streak++; else streak = 1;
    bonus += Math.min(streak, 5);
    if (idx === 0 || name[idx - 1] === '-' || name[idx - 1] === '_' || name[idx - 1] === '.' || name[idx - 1] === ' ') bonus += 2;
    ni = idx + 1;
  }
  return 20 + bonus * 0.5;
}

/** 对单条路径打分，未命中返回 -1 */
function matchScore(entryPath, query, mode) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return -1;
  const name = basename(entryPath).toLowerCase();
  const p = entryPath.toLowerCase();
  const pq = q.replace(/\//g, '\\');

  switch (mode) {
    case 'glob': {
      let re;
      try { re = toGlobRegex(q); } catch (e) { return -1; }
      if (re.test(name)) return 90;
      if (re.test(p)) return 40;
      return -1;
    }
    case 'regex': {
      let re;
      try { re = new RegExp(query, 'i'); } catch (e) { return -1; }
      if (re.test(name)) return 90;
      if (re.test(p)) return 40;
      return -1;
    }
    case 'fuzzy': {
      return fuzzyScore(name, q);
    }
    case 'sub':
    default: {
      if (name === q) return 100;
      if (name.startsWith(q)) return 80;
      if (name.includes(q)) return 60;
      if (p.includes(pq)) return 30;
      return -1;
    }
  }
}

/**
 * 在索引条目上执行过滤 + 打分 + 排序
 * opts: query, mode(sub/fuzzy/glob/regex), root(限制子树), ext([小写扩展名]), type('file'|'dir')
 * 返回 { total, matches: [{e, score}] }（已排序，由调用方分页）
 */
function searchEntries(entries, opts) {
  const q = String(opts.query || '').trim();
  if (!q) return { total: 0, matches: [] };
  const mode = opts.mode || 'sub';
  const root = opts.root ? String(opts.root).trim() : null;
  const rootLc = root ? root.replace(/[/\\]+$/, '').toLowerCase() : null;
  const type = opts.type || null;
  const exts = Array.isArray(opts.ext) && opts.ext.length ? opts.ext : null;
  const matches = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (type === 'file' && e.d) continue;
    if (type === 'dir' && !e.d) continue;
    if (exts && !exts.includes(extOf(e.p))) continue;
    if (rootLc) {
      const lp = e.p.toLowerCase();
      if (lp !== rootLc && !lp.startsWith(rootLc + '\\')) continue;
    }
    const score = matchScore(e.p, q, mode);
    if (score >= 0) matches.push({ e, score });
  }
  matches.sort((a, b) => (b.score - a.score) || (b.e.m - a.e.m));
  return { total: matches.length, matches };
}

module.exports = { matchScore, searchEntries, toGlobRegex, fuzzyScore };
