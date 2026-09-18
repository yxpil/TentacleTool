'use strict';
/**
 * 工具：search_detail —— 展开单个搜索结果的全文（Markdown）
 * 与 web_search 的折叠摘要配合使用：先看摘要，哪条有价值再展开哪条
 * 默认截断 8000 字符保护上下文，可通过增大 maxLength 续读
 */
const { fetchPage } = require('../utils/fetcher');
const { htmlToMarkdown } = require('../utils/html-to-md');

/**
 * @param {object} params
 *  - url: 结果链接（必填）
 *  - maxLength: 返回 Markdown 最大字符数（默认 8000，上限 50000）
 *  - mode: content=正文模式(默认) | full=完整模式
 *  - includeImages: 是否保留图片（默认 false，节省上下文）
 *  - includeLinks: 是否保留链接（默认 true）
 *  - timeout: 抓取超时毫秒（默认 20000）
 */
async function run(params = {}) {
  let url = String(params.url || '').trim();
  if (!url) return { error: '缺少 url 参数（可从 web_search 的折叠结果中复制）' };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const maxLength = clamp(params.maxLength, 500, 50000, 8000);
  const mode = params.mode === 'full' ? 'full' : 'content';
  const includeImages = params.includeImages === true;
  const includeLinks = params.includeLinks !== false;
  const timeout = clamp(params.timeout, 3000, 120000, 20000);

  let page;
  try {
    page = await fetchPage(url, { timeout });
  } catch (e) {
    return { error: '抓取失败: ' + e.message, url };
  }
  if (page.status >= 400) {
    return { error: '抓取失败: HTTP ' + page.status, url: page.finalUrl };
  }

  const ct = (page.contentType || '').toLowerCase();
  if (ct && !ct.includes('html') && !ct.includes('xml') && !ct.includes('text/plain')) {
    return { error: '不支持的内容类型: ' + (page.contentType || '未知') + '（仅 HTML/文本页面）', url: page.finalUrl };
  }

  const conv = htmlToMarkdown(page.body, { mode, includeImages, includeLinks, baseUrl: page.finalUrl });
  let md = conv.markdown;
  if (!md.trim()) {
    return { error: '未提取到有效内容（可能是 JS 渲染页面或反爬拦截）', url: page.finalUrl, hint: '可试 mode=full' };
  }

  const total = md.length;
  if (total > maxLength) {
    const nextMax = Math.min(total, maxLength * 3);
    md = md.slice(0, maxLength)
      + '\n\n---\n[已截断] 显示 ' + maxLength + ' / ' + total + ' 字符。续读: search_detail(url, maxLength=' + nextMax + ')';
  }

  return '[来源] ' + page.finalUrl + ' | ' + (mode === 'content' ? '正文模式' : '完整模式') + ' | 共 ' + total + ' 字符\n\n' + md;
}

function clamp(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

module.exports = { run };
