'use strict';
/**
 * 工具：web_links —— 抓取网页并提取全部链接（Markdown 清单 + 域名分布）
 */
const { fetchPage } = require('../utils/fetcher');
const { extractLinks } = require('../utils/page-parser');

/**
 * @param {object} params
 *  - url: 目标网页地址（必填）
 *  - sameOriginOnly: 是否只保留同源链接（默认 false）
 *  - limit: 最多返回链接数（默认 200，上限 2000）
 *  - timeout: 抓取超时毫秒（默认 20000）
 */
async function run(params = {}) {
  if (!params.url) return { error: '缺少 url 参数' };
  let url = String(params.url).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const sameOriginOnly = !!params.sameOriginOnly;
  const limit = Math.min(2000, Math.max(1, parseInt(params.limit, 10) || 200));
  const timeout = Math.min(120000, Math.max(2000, parseInt(params.timeout, 10) || 20000));

  let page;
  try {
    page = await fetchPage(url, { timeout });
  } catch (e) {
    return { error: '抓取失败: ' + e.message, url };
  }
  if (page.status >= 400) {
    return { error: '抓取失败: HTTP ' + page.status, url: page.finalUrl };
  }

  const result = extractLinks(page.body, page.finalUrl, { sameOriginOnly, limit });

  const lines = [];
  lines.push('# 链接清单: ' + page.finalUrl);
  lines.push('');
  lines.push('共 ' + result.total + ' 个链接' + (sameOriginOnly ? '（仅同源）' : '') + '：');
  lines.push('');
  for (const l of result.links) {
    lines.push('- [' + l.text.replace(/\[|\]/g, '') + '](' + l.href + ')' + (l.type === 'file' ? ' [文件]' : ''));
  }
  if (result.domains.length) {
    lines.push('');
    lines.push('## 域名分布');
    lines.push('');
    for (const d of result.domains) lines.push('- ' + d.domain + ' × ' + d.count);
  }

  return {
    url: page.finalUrl,
    total: result.total,
    domains: result.domains,
    markdown: lines.join('\n')
  };
}

module.exports = { run };
