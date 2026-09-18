'use strict';
/**
 * 工具：html_to_md —— 将 HTML 源码直接转换为 Markdown（不抓取网络）
 */
const { htmlToMarkdown } = require('../utils/html-to-md');

/**
 * @param {object} params
 *  - html: HTML 源码字符串（必填）
 *  - mode: content=正文模式(默认) | full=完整模式
 *  - includeImages / includeLinks / includeTitle: 同 web_to_md
 */
async function run(params = {}) {
  const html = params.html;
  if (!html || typeof html !== 'string' || !html.trim()) {
    return { error: '缺少 html 参数（HTML 源码字符串）' };
  }
  if (html.length > 5 * 1024 * 1024) {
    return { error: 'HTML 过大（>' + Math.round(5 * 1024 * 1024 / 1024 / 1024 * 100) / 100 + 'MB），请截断后重试' };
  }
  const mode = params.mode === 'full' ? 'full' : 'content';
  const result = htmlToMarkdown(html, {
    mode,
    includeImages: params.includeImages !== false,
    includeLinks: params.includeLinks !== false,
    includeTitle: params.includeTitle !== false,
    baseUrl: (params.baseUrl || '').trim()
  });
  if (!result.markdown.trim()) return { error: '转换结果为空：输入可能不含可见文本内容' };
  return result.markdown;
}

module.exports = { run };
