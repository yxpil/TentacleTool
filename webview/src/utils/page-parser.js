'use strict';
/**
 * 页面解析工具：元信息提取 / 链接清单提取 / 页面统计
 * 基于 html-to-md 的分词器（token 流），零依赖
 */
const { tokenize, decodeEntities, tokensPlainText } = require('./html-to-md');

function collapseWs(s) { return String(s).replace(/\s+/g, ' ').trim(); }

/** 相对链接 -> 绝对链接 */
function resolveUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); } catch (e) { return href; }
}

/**
 * 提取页面元信息
 * @returns {{ title, lang, meta: object, canonical, icons: string[], stats: object }}
 */
function extractPageMeta(html, baseUrl) {
  const tokens = tokenize(String(html || ''));
  const meta = {};
  let title = '';
  let lang = '';
  let canonical = '';
  const icons = [];
  const counts = { h1: 0, h2: 0, h3: 0, headings: 0, paragraphs: 0, links: 0, images: 0, tables: 0, codeBlocks: 0, textChars: 0 };

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.type !== 'start') {
      if (tk.type === 'text') counts.textChars += tk.data.trim().length;
      continue;
    }
    const attrs = tk.attrs || {};
    if (tk.tag === 'html' && attrs.lang) lang = attrs.lang;
    else if (tk.tag === 'title' && !title) {
      let s = '';
      for (let u = i + 1; u < tokens.length; u++) {
        if (tokens[u].type === 'end' && tokens[u].tag === 'title') break;
        if (tokens[u].type === 'text') s += tokens[u].data;
      }
      title = collapseWs(decodeEntities(s));
    } else if (tk.tag === 'meta') {
      const name = (attrs.name || attrs.property || '').toLowerCase();
      const content = attrs.content || '';
      if (name && content && !(name in meta)) meta[name] = decodeEntities(content);
    } else if (tk.tag === 'link') {
      const rel = (attrs.rel || '').toLowerCase();
      if (rel === 'canonical' && attrs.href) canonical = resolveUrl(attrs.href, baseUrl);
      if ((rel.includes('icon') || rel === 'apple-touch-icon' || rel === 'shortcut icon') && attrs.href) {
        icons.push(resolveUrl(attrs.href, baseUrl));
      }
    } else if (tk.selfClose || false) { /* void 元素无统计 */ }

    // 页面统计（按开始标签计数）
    if (tk.tag === 'h1') counts.h1++;
    if (tk.tag === 'h2') counts.h2++;
    if (tk.tag === 'h3') counts.h3++;
    if (/^h[1-6]$/.test(tk.tag)) counts.headings++;
    if (tk.tag === 'p') counts.paragraphs++;
    if (tk.tag === 'a' && attrs.href) counts.links++;
    if (tk.tag === 'img' && (attrs.src || attrs['data-src'])) counts.images++;
    if (tk.tag === 'table') counts.tables++;
    if (tk.tag === 'pre') counts.codeBlocks++;
  }

  const text = tokensPlainText(tokens, 0, tokens.length);
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const enWords = text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .split(/\s+/).filter(w => /[\w]/.test(w)).length;
  const wordCount = enWords + cjkChars;
  const readingTimeMin = Math.max(1, Math.ceil(wordCount / 400));

  return {
    title,
    lang: lang || null,
    canonical: canonical || null,
    meta,
    icons: [...new Set(icons)].slice(0, 5),
    stats: Object.assign(counts, {
      wordCount,
      readingTimeMin,
      textChars: counts.textChars
    })
  };
}

/**
 * 提取页面全部链接
 * @returns {{ total, links: [{text, href, domain, type}], domains: [{domain, count}] }}
 */
function extractLinks(html, baseUrl, opts = {}) {
  const tokens = tokenize(String(html || ''));
  const sameOriginOnly = !!opts.sameOriginOnly;
  const limit = Math.max(1, Math.min(2000, parseInt(opts.limit, 10) || 200));
  const seen = new Set();
  const links = [];
  const domainCount = new Map();

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.type !== 'start' || tk.tag !== 'a') continue;
    const href = (tk.attrs && tk.attrs.href || '').trim();
    if (!href || /^javascript:/i.test(href)) continue;
    const abs = resolveUrl(href, baseUrl);
    let u;
    try { u = new URL(abs); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (sameOriginOnly) {
      try { if (new URL(baseUrl).origin !== u.origin) continue; } catch (e) { continue; }
    }
    const key = u.origin + u.pathname + u.search;
    if (seen.has(key)) continue;
    seen.add(key);

    // 提取链接文本（直到 </a>）
    let text = '';
    let depth = 1;
    for (let j2 = i + 1; j2 < tokens.length && depth > 0; j2++) {
      const t2 = tokens[j2];
      if (t2.type === 'start' && t2.tag === 'a') depth++;
      else if (t2.type === 'end' && t2.tag === 'a') depth--;
      else if (t2.type === 'text' && depth > 0) text += t2.data;
    }
    text = collapseWs(decodeEntities(text)).slice(0, 120);
    const type = u.protocol === 'mailto:' ? 'mailto' : (u.pathname.match(/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|exe|dmg|apk|mp3|mp4|csv)$/i) ? 'file' : (u.pathname === '/' || u.pathname === '' ? 'page' : 'page'));
    links.push({ text: text || u.pathname, href: abs, domain: u.hostname, type });
    domainCount.set(u.hostname, (domainCount.get(u.hostname) || 0) + 1);
    if (links.length >= limit) break;
  }

  const domains = [...domainCount.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);

  return { total: links.length, links, domains: domains.slice(0, 20) };
}

module.exports = { extractPageMeta, extractLinks, resolveUrl };
