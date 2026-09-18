'use strict';
/**
 * 工具：web_meta —— 抓取网页并提取元信息（title / og / SEO / 页面统计）
 */
const { fetchPage } = require('../utils/fetcher');
const { extractPageMeta } = require('../utils/page-parser');

/**
 * @param {object} params
 *  - url: 目标网页地址（必填）
 *  - timeout: 抓取超时毫秒（默认 20000）
 */
async function run(params = {}) {
  if (!params.url) return { error: '缺少 url 参数' };
  let url = String(params.url).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

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

  const meta = extractPageMeta(page.body, page.finalUrl);
  return {
    url: page.finalUrl,
    httpStatus: page.status,
    contentType: page.contentType,
    charset: page.charset,
    sizeBytes: page.sizeBytes,
    elapsedMs: page.elapsedMs,
    title: meta.title,
    lang: meta.lang,
    canonical: meta.canonical,
    description: meta.meta.description || null,
    keywords: meta.meta.keywords || null,
    openGraph: Object.fromEntries(Object.entries(meta.meta).filter(([k]) => k.startsWith('og:'))),
    twitter: Object.fromEntries(Object.entries(meta.meta).filter(([k]) => k.startsWith('twitter:'))),
    otherMeta: meta.meta,
    icons: meta.icons,
    stats: meta.stats
  };
}

module.exports = { run };
