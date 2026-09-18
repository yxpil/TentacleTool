'use strict';
/**
 * 工具：web_to_md —— 抓取网页并转换为 Markdown
 */
const { fetchPage } = require('../utils/fetcher');
const { htmlToMarkdown } = require('../utils/html-to-md');

/**
 * @param {object} params
 *  - url: 目标网页地址（必填）
 *  - mode: content=正文模式(默认,去导航/广告等噪声) | full=完整模式
 *  - includeImages: 是否保留图片（默认 true）
 *  - includeLinks: 是否保留链接（默认 true）
 *  - includeTitle: 是否在文首插入 # 文档标题（默认 true）
 *  - maxLength: 返回 Markdown 最大字符数（默认 60000，超出截断）
 *  - timeout: 抓取超时毫秒（默认 20000）
 */
async function run(params = {}) {
  if (!params.url) return { error: '缺少 url 参数' };
  let url = String(params.url).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const mode = params.mode === 'full' ? 'full' : 'content';
  const includeImages = params.includeImages !== false;
  const includeLinks = params.includeLinks !== false;
  const includeTitle = params.includeTitle !== false;
  const maxLength = Math.max(500, parseInt(params.maxLength, 10) || 60000);
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

  const ct = (page.contentType || '').toLowerCase();
  if (ct && !ct.includes('html') && !ct.includes('xml') && !ct.includes('text/plain')) {
    return {
      error: '不支持的内容类型: ' + (page.contentType || '未知') + '（仅支持 HTML/XHTML/纯文本页面）',
      url: page.finalUrl
    };
  }

  const result = htmlToMarkdown(page.body, { mode, includeImages, includeLinks, includeTitle, baseUrl: page.finalUrl });
  let md = result.markdown;
  let truncated = false;
  if (md.length > maxLength) {
    md = md.slice(0, maxLength) + '\n\n> [!NOTE] 内容过长，已在 ' + maxLength + ' 字符处截断（可用 maxLength 参数调大）';
    truncated = true;
  }
  if (!md.trim()) {
    return {
      error: '页面未提取到有效内容（可能是 JS 渲染页面或反爬拦截）',
      url: page.finalUrl,
      httpStatus: page.status,
      hint: '可尝试 mode=full 或换用页面提供的 API/RSS'
    };
  }

  return md;
}

module.exports = { run };
