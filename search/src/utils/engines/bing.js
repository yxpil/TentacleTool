'use strict';
/**
 * 必应搜索引擎适配器
 * 解析 www.bing.com/search 的 HTML 结果页（li.b_algo 区块）
 * 结果链接通常包着 bing.com/ck 跳转，自动解码还原真实地址
 */
const { fetchPage } = require('../fetcher');
const { tokenize, decodeEntities } = require('../html-to-md');
const {
  collapse, clampInt, classList, findRanges, findStart,
  anchorText, decodeBingUrl
} = require('./common');

/**
 * @param {string} query 搜索词
 * @param {object} opts - { page: 1起, pageSize: 1-30, timeout, lang: 'zh-CN'|'en' }
 * @returns {Promise<Array<{title, url, snippet, engine}>>}
 */
async function search(query, opts = {}) {
  const page = clampInt(opts.page, 1, 50);
  const pageSize = clampInt(opts.pageSize, 1, 30);
  const first = (page - 1) * pageSize + 1;
  const lang = opts.lang === 'en' ? 'en' : 'zh-CN';
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query)
    + '&first=' + first + '&count=' + pageSize
    + '&setlang=' + lang + '&mkt=' + (lang === 'en' ? 'en-US' : 'zh-CN');

  const data = await fetchPage(url, { timeout: opts.timeout || 15000 });
  if (data.status >= 400) throw new Error('HTTP ' + data.status);
  if (/请输入验证码|CAPTCHA/i.test(data.body) && !/b_algo/.test(data.body)) {
    throw new Error('必应触发验证码，暂时不可用');
  }

  const tokens = tokenize(data.body);
  const ranges = findRanges(tokens, (tag, attrs) =>
    tag === 'li' && classList(attrs).includes('b_algo'));

  const results = [];
  for (const r of ranges) {
    // 标题锚点：优先 <h2> 内的链接（新版必应在 h2 之前有"来源栏"锚点，其文本是 域名+路径 不是标题）
    let anchor = null;
    const h2 = findStart(tokens, r.start, r.end, (tag) => tag === 'h2');
    if (h2) {
      anchor = findStart(tokens, h2.index, r.end, (tag, attrs) =>
        tag === 'a' && attrs.href && /^https?:\/\//i.test(attrs.href));
    }
    if (!anchor) {
      anchor = findStart(tokens, r.start, r.end, (tag, attrs) =>
        tag === 'a' && attrs.href && /^https?:\/\//i.test(attrs.href));
    }
    if (!anchor) continue;

    const title = collapse(anchorText(tokens, anchor.index));
    const realUrl = decodeBingUrl(anchor.attrs.href);
    if (!title && !realUrl) continue;

    // 摘要：优先 .b_caption p，其次任意 <p>
    let snippet = '';
    const pCap = findStart(tokens, anchor.index, r.end, (tag, attrs) =>
      tag === 'p' && classList(attrs).some(c => c.includes('b_caption')));
    const pAny = pCap || findStart(tokens, anchor.index, r.end, (tag, attrs) => tag === 'p');
    if (pAny) {
      // 找到配对 </p>
      let depth = 1;
      let s = '';
      for (let i = pAny.index + 1; i < r.end && depth > 0; i++) {
        const tk = tokens[i];
        if (tk.type === 'start' && tk.tag === 'p') depth++;
        else if (tk.type === 'end' && tk.tag === 'p') depth--;
        else if (tk.type === 'text') s += tk.data;
      }
      snippet = collapse(decodeEntities(s));
    }

    results.push({
      title: title || realUrl,
      url: realUrl,
      snippet: snippet.slice(0, 300),
      engine: 'bing'
    });
  }
  return results.slice(0, pageSize);
}

module.exports = { search };
