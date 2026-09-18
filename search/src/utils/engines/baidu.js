'use strict';
/**
 * 百度搜索引擎适配器
 * 解析 www.baidu.com/s 的 HTML 结果页（div.result / div.c-container 区块）
 * 结果链接是 baidu.com/link?url=... 跳转，并发还原为真实地址（含 JS 跳转页与反爬检测）
 */
const { fetchPage } = require('../fetcher');
const { tokenize, decodeEntities } = require('../html-to-md');
const {
  collapse, clampInt, findRanges, findStart, anchorText,
  textInRange, resolveBaiduLink
} = require('./common');

/**
 * @param {string} query 搜索词
 * @param {object} opts - { page: 1起, pageSize: 1-20, timeout }
 * @returns {Promise<Array<{title, url, snippet, engine, urlResolved}>>}
 */
async function search(query, opts = {}) {
  const page = clampInt(opts.page, 1, 50);
  const pageSize = clampInt(opts.pageSize, 1, 20); // baidu rn 上限 20
  const pn = (page - 1) * pageSize;
  const url = 'https://www.baidu.com/s?ie=utf-8&wd=' + encodeURIComponent(query)
    + '&pn=' + pn + '&rn=' + pageSize;

  const data = await fetchPage(url, {
    timeout: opts.timeout || 15000,
    headers: { 'Referer': 'https://www.baidu.com/' }
  });
  if (data.status >= 400) throw new Error('HTTP ' + data.status);
  if (/百度安全验证/.test(data.body)) {
    throw new Error('百度触发反爬验证，暂时不可用（可稍后重试或换引擎）');
  }

  const tokens = tokenize(data.body);
  const ranges = findRanges(tokens, (tag, attrs) => {
    if (tag !== 'div') return false;
    const cls = String((attrs && attrs.class) || '');
    return /(^|\s)(result|c-container|result-op)(\s|$)/.test(cls);
  });

  const raw = [];
  for (const r of ranges) {
    // 标题：容器内第一个 <h3> 中的第一个链接
    const h3 = findStart(tokens, r.start, r.end, (tag) => tag === 'h3');
    if (!h3) continue;
    const anchor = findStart(tokens, h3.index, r.end, (tag, attrs) =>
      tag === 'a' && attrs.href && /^https?:\/\//i.test(attrs.href));
    if (!anchor) continue;
    const title = collapse(anchorText(tokens, anchor.index));
    if (!title) continue;

    // 摘要：优先 c-abstract 类元素，否则取容器全文去掉标题
    let snippet = '';
    const abs = findStart(tokens, anchor.index, r.end, (tag, attrs) => {
      if (!attrs || !attrs.class) return false;
      return /c-abstract|c-span-last|content-right|c-color-text|c-gap-inner/.test(String(attrs.class));
    });
    if (abs) {
      let depth = 1;
      let s = '';
      for (let i = abs.index + 1; i < r.end && depth > 0; i++) {
        const tk = tokens[i];
        if (tk.type === 'start' && !tk.selfClose) depth++;
        else if (tk.type === 'end' && tk.tag === tokens[abs.index].tag) depth--;
        else if (tk.type === 'text') s += tk.data;
      }
      snippet = collapse(decodeEntities(s));
    }
    if (!snippet) {
      const all = textInRange(tokens, r.start, r.end);
      const idx = all.indexOf(title);
      snippet = collapse(idx >= 0 ? all.slice(idx + title.length) : all);
    }

    raw.push({
      title,
      url: anchor.attrs.href,
      snippet: snippet.replace(/[\uE000-\uF8FF\uFEFF]/g, '').replace(/^[-·\s]+/, '').slice(0, 300),
      engine: 'baidu'
    });
  }

  // 过滤广告结果（baidu.php 商业跳转链 / 摘要带"广告"标记）
  const organic = raw.filter(item =>
    !/baidu\.php|\/adrcm|cpro\.baidu/i.test(item.url)
    && !/(^|\s)广告(\s|$|\d{4}-)/.test(item.snippet));

  // 并发还原百度跳转链接（限流：每批 5 个）
  const resolved = [];
  for (let i = 0; i < organic.length; i += 5) {
    const batch = organic.slice(i, i + 5);
    const done = await Promise.all(batch.map(async (item) => {
      const r = await resolveBaiduLink(item.url, Math.min(opts.timeout || 15000, 8000));
      return Object.assign({}, item, { url: r.url, urlResolved: r.resolved, urlNote: r.note || null });
    }));
    resolved.push(...done);
  }

  return resolved.filter(item => item.url && item.url.length > 0).slice(0, pageSize);
}

module.exports = { search };
