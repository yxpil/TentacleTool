'use strict';
/**
 * 工具：web_search —— 多引擎聚合搜索（折叠摘要 + 翻页）
 *
 * 上下文经济设计：
 *  - 默认只返回 标题 + 链接 + 短摘要（snippetLen 可调，0 可关闭摘要）
 *  - 多引擎并行请求，结果轮询交错合并（每个引擎的第一条先出现，再轮第二条……），URL 去重
 *  - page/pageSize 翻页，每次调用只占一小段上下文
 */
const bing = require('../utils/engines/bing');
const baidu = require('../utils/engines/baidu');
const duckduckgo = require('../utils/engines/duckduckgo');

const ENGINE_IMPL = { bing, baidu, duckduckgo };
const ENGINE_NAMES = ['bing', 'baidu', 'duckduckgo'];

function normalizeUrl(u) {
  try {
    const url = new URL(String(u));
    url.hash = '';
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch (e) { return String(u); }
}

/**
 * @param {object} params
 *  - query: 搜索词（必填）
 *  - engines: 引擎列表，默认 ['bing','baidu']；可选 bing/baidu/duckduckgo，数组或逗号分隔字符串
 *  - page: 页码（默认 1）
 *  - pageSize: 每页条数（默认 10，上限 30）
 *  - snippetLen: 每条摘要字符数（默认 120，0 关闭摘要）
 *  - timeout: 单引擎超时毫秒（默认 15000）
 */
async function run(params = {}) {
  const query = String(params.query || '').trim();
  if (!query) return { error: '缺少 query 参数' };

  let engines = params.engines;
  if (typeof engines === 'string') engines = engines.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(engines) || engines.length === 0) engines = ['bing', 'baidu'];
  engines = [...new Set(engines.map(e => String(e).toLowerCase()))].filter(e => ENGINE_NAMES.includes(e));
  if (engines.length === 0) {
    return { error: 'engines 参数无效，支持的引擎: ' + ENGINE_NAMES.join(', ') };
  }

  const page = clamp(params.page, 1, 50, 1);
  const pageSize = clamp(params.pageSize, 1, 30, 10);
  const snippetLen = clamp(params.snippetLen === 0 ? 0 : params.snippetLen, 0, 300, 120);
  const timeout = clamp(params.timeout, 3000, 60000, 15000);

  // 并行请求各引擎（单引擎时直接 await 保留原始错误）
  let lists;
  if (engines.length === 1) {
    const engine = engines[0];
    try {
      lists = [{ engine, ok: true, results: await ENGINE_IMPL[engine].search(query, { page, pageSize, timeout }) }];
    } catch (e) {
      return { error: engine + ' 搜索失败: ' + e.message + '。可尝试 engines=' + (engine === 'bing' ? 'baidu' : 'bing') + ' 换引擎' };
    }
  } else {
    const settled = await Promise.allSettled(engines.map(e => ENGINE_IMPL[e].search(query, { page, pageSize, timeout })));
    lists = settled.map((s, i) => ({
      engine: engines[i],
      ok: s.status === 'fulfilled',
      results: s.status === 'fulfilled' ? s.value : null,
      error: s.status === 'rejected' ? (s.reason && s.reason.message || String(s.reason)) : null
    }));
  }

  // 轮询交错合并 + 去重
  const merged = [];
  const seen = new Set();
  const cursors = lists.map(() => 0);
  while (true) {
    let added = false;
    for (let i = 0; i < lists.length; i++) {
      const l = lists[i];
      if (!l.ok) continue;
      while (cursors[i] < l.results.length) {
        const item = l.results[cursors[i]++];
        const key = normalizeUrl(item.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  const pageItems = merged.slice(0, pageSize);

  // 渲染折叠结果
  const out = [];
  const engineTag = lists.map(l => l.engine + (l.ok ? '✓' : '✗')).join(' ');
  out.push('[搜索] ' + query + ' | 第 ' + page + ' 页 × ' + pageSize + ' 条 | 引擎: ' + engineTag + ' | 去重后 ' + merged.length + ' 条');
  out.push('');
  pageItems.forEach((item, i) => {
    out.push((i + 1) + '. [' + item.title.replace(/[\[\]]/g, '') + '](' + item.url + ') ·' + item.engine
      + (item.urlResolved === false ? ' ⚠链接未还原' : ''));
    if (snippetLen > 0 && item.snippet) {
      out.push('   ' + item.snippet.slice(0, snippetLen) + (item.snippet.length > snippetLen ? '…' : ''));
    }
  });
  out.push('');
  out.push('---');
  const failed = lists.filter(l => !l.ok);
  if (pageItems.length === 0) {
    out.push('本页无结果。建议：减少/更换关键词 | 翻页 page=2 | 换引擎 engines=' + (engines.includes('bing') ? 'baidu' : 'bing') + (failed.length ? ' | 失败引擎: ' + failed.map(f => f.engine + '(' + (f.error || '?') + ')').join(' ') : ''));
  } else {
    out.push('翻页: page=' + (page + 1) + ' | 展开全文: search_detail(url=上方结果URL) | 摘要长度: snippetLen=0~300');
    for (const f of failed) out.push('> 引擎 ' + f.engine + ' 失败: ' + (f.error || '未知错误'));
  }
  return out.join('\n');
}

function clamp(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

module.exports = { run };
