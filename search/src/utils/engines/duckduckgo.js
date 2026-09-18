'use strict';
/**
 * DuckDuckGo 搜索引擎适配器（HTML 版本端点，无需 API Key）
 * 解析 html.duckduckgo.com/html/?q= 的结果页（div.result / div.web-result）
 * 跳转链接 //duckduckgo.com/l/?uddg=<encoded> 自动解码还原
 * 注意：该域名在部分网络环境不可达，失败时上层会优雅降级
 */
const { fetchPage } = require('../fetcher');
const { tokenize, decodeEntities } = require('../html-to-md');
const {
  collapse, clampInt, classList, findRanges, findStart,
  anchorText, decodeDdgUrl
} = require('./common');

/**
 * @param {string} query 搜索词
 * @param {object} opts - { page: 1起, pageSize: 1-30, timeout }
 * @returns {Promise<Array<{title, url, snippet, engine}>>}
 */
async function search(query, opts = {}) {
  const page = clampInt(opts.page, 1, 50);
  const pageSize = clampInt(opts.pageSize, 1, 30);
  const s = (page - 1) * pageSize; // ddg 的 s 为已跳过的结果数
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&s=' + s;

  const data = await fetchPage(url, { timeout: opts.timeout || 15000 });
  if (data.status >= 400) throw new Error('HTTP ' + data.status);
  if (/anomaly|captcha|challenge/i.test(data.body.slice(0, 4000)) && !/result__a/.test(data.body)) {
    throw new Error('DuckDuckGo 触发人机验证，暂时不可用');
  }

  const tokens = tokenize(data.body);
  const ranges = findRanges(tokens, (tag, attrs) => {
    if (tag !== 'div') return false;
    const cls = classList(attrs);
    return cls.includes('result') || cls.includes('web-result');
  });

  const results = [];
  for (const r of ranges) {
    const anchor = findStart(tokens, r.start, r.end, (tag, attrs) =>
      tag === 'a' && classList(attrs).includes('result__a'));
    if (!anchor) continue;

    const title = collapse(anchorText(tokens, anchor.index));
    const realUrl = decodeDdgUrl(anchor.attrs.href);
    if (!title || !realUrl) continue;

    // 摘要：result__snippet
    let snippet = '';
    const snip = findStart(tokens, anchor.index, r.end, (tag, attrs) =>
      classList(attrs).includes('result__snippet'));
    if (snip) {
      let depth = 1;
      let sTxt = '';
      for (let i = snip.index + 1; i < r.end && depth > 0; i++) {
        const tk = tokens[i];
        if (tk.type === 'start' && !tk.selfClose) depth++;
        else if (tk.type === 'end' && tk.tag === tokens[snip.index].tag) depth--;
        else if (tk.type === 'text') sTxt += tk.data;
      }
      snippet = collapse(decodeEntities(sTxt));
    }

    results.push({
      title,
      url: realUrl,
      snippet: snippet.slice(0, 300),
      engine: 'duckduckgo'
    });
  }
  return results.slice(0, pageSize);
}

module.exports = { search };
