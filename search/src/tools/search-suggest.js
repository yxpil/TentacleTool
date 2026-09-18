'use strict';
/**
 * 工具：search_suggest —— 搜索词联想（必应 + 百度 suggest 合并）
 * 用于改写/扩展查询词，走两家的公开 suggest 接口，无需 API Key
 */
const { fetchPage } = require('../utils/fetcher');

/**
 * @param {object} params
 *  - query: 查询词（必填）
 *  - engines: 引擎列表，默认 ['bing','baidu']
 *  - limit: 每个引擎最多返回条数（默认 8）
 *  - timeout: 超时毫秒（默认 8000）
 */
async function run(params = {}) {
  const query = String(params.query || '').trim();
  if (!query) return { error: '缺少 query 参数' };

  let engines = params.engines;
  if (typeof engines === 'string') engines = engines.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(engines) || engines.length === 0) engines = ['bing', 'baidu'];
  engines = engines.map(e => String(e).toLowerCase()).filter(e => e === 'bing' || e === 'baidu');
  if (engines.length === 0) return { error: 'search_suggest 仅支持 bing / baidu' };

  const limit = Math.min(15, Math.max(1, parseInt(params.limit, 10) || 8));
  const timeout = Math.min(30000, Math.max(2000, parseInt(params.timeout, 10) || 8000));
  const enc = encodeURIComponent(query);

  const tasks = {};
  if (engines.includes('bing')) {
    tasks.bing = fetchPage('https://api.bing.com/osjson.aspx?query=' + enc, { timeout })
      .then(r => { const j = JSON.parse(r.body); return Array.isArray(j[1]) ? j[1].map(String) : []; });
  }
  if (engines.includes('baidu')) {
    tasks.baidu = fetchPage('https://www.baidu.com/sugrec?prod=pc&wd=' + enc, { timeout })
      .then(r => { const j = JSON.parse(r.body); return (j && Array.isArray(j.g)) ? j.g.map(x => String(x.q || x.k)).filter(Boolean) : []; });
  }

  const settled = await Promise.allSettled(Object.entries(tasks).map(async ([k, p]) => [k, await p]));
  const byEngine = {};
  const failures = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') byEngine[s.value[0]] = s.value[1].slice(0, limit);
    else failures.push(s.reason && s.reason.message || String(s.reason));
  }

  // 合并去重（保序：先按引擎轮询交错）
  const merged = [];
  const seen = new Set();
  const lists = engines.map(e => byEngine[e] || []).filter(a => a.length);
  let cursor = 0;
  while (merged.length < limit * 2) {
    let added = false;
    for (const l of lists) {
      while (cursor < l.length && seen.has(l[cursor])) cursor++;
      if (cursor < l.length) { seen.add(l[cursor]); merged.push(l[cursor]); added = true; }
      cursor = 0; // 下一轮重新从头找各引擎下一条
    }
    if (!added) break;
  }

  if (merged.length === 0 && failures.length) {
    return { error: '联想接口全部失败: ' + failures.join(' | ') };
  }

  return {
    query,
    suggestions: merged,
    byEngine,
    failures: failures.length ? failures : undefined
  };
}

module.exports = { run };
