'use strict';
/**
 * 搜索引擎适配器公共工具：token 区间查找 / 文本提取 / 跳转链接还原
 */
const { decodeEntities } = require('../html-to-md');
const { fetchPage } = require('../fetcher');

function collapse(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
function classList(attrs) {
  return String((attrs && attrs.class) || '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 在 token 流中找出满足 pred(tag, attrs) 的元素区间 [{start, end, attrs}]
 * start 为开始标签下标，end 为对应结束标签之后的位置（含），自动去重嵌套包含
 */
function findRanges(tokens, pred) {
  const out = [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.type === 'start') {
      if (tk.selfClose) continue;
      stack.push({ tag: tk.tag, hit: !!(pred && pred(tk.tag, tk.attrs || {})), start: i });
    } else if (tk.type === 'end') {
      let f = -1;
      for (let s = stack.length - 1; s >= 0; s--) { if (stack[s].tag === tk.tag) { f = s; break; } }
      if (f === -1) continue;
      const frame = stack[f];
      if (frame.hit) out.push({ start: frame.start, end: i + 1, attrs: tokens[frame.start].attrs || {} });
      stack.length = f;
    }
  }
  // 去重：被完全包含的嵌套命中丢弃（保留最外层）
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const dedup = [];
  for (const r of out) {
    if (dedup.length && r.start < dedup[dedup.length - 1].end) continue;
    dedup.push(r);
  }
  return dedup;
}

/** 提取 [start,end) 区间内全部文本（已解码） */
function textInRange(tokens, start, end) {
  let s = '';
  for (let i = start; i < end; i++) {
    if (tokens[i].type === 'text') s += tokens[i].data;
  }
  return decodeEntities(s);
}

/** 在 [start,end) 内找第一个满足 pred 的开始标签，返回 {index, attrs} 或 null */
function findStart(tokens, start, end, pred) {
  for (let i = start; i < end; i++) {
    const tk = tokens[i];
    if (tk.type === 'start' && pred(tk.tag, tk.attrs || {})) return { index: i, attrs: tk.attrs || {} };
  }
  return null;
}

/** 提取从 anchorStart 开始的 <a> 文本（直到配对的 </a>） */
function anchorText(tokens, anchorStart) {
  let depth = 1;
  let s = '';
  for (let i = anchorStart + 1; i < tokens.length && depth > 0; i++) {
    const tk = tokens[i];
    if (tk.type === 'start' && tk.tag === 'a') depth++;
    else if (tk.type === 'end' && tk.tag === 'a') depth--;
    else if (tk.type === 'text') s += tk.data;
  }
  return decodeEntities(s);
}

/** 解码必应点击跳转链接 bing.com/ck/...?u=a1<base64url> -> 真实 URL */
function decodeBingUrl(href) {
  const u = String(href || '');
  try {
    if (/bing\.com\/ck/i.test(u)) {
      const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(u);
      if (m) {
        let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
      return u; // 解不出真实地址时保留跳转链接（仍可访问）
    }
    return u;
  } catch (e) { return u; }
}

/** 解码 DuckDuckGo 跳转链接 //duckduckgo.com/l/?uddg=<encoded> -> 真实 URL */
function decodeDdgUrl(href) {
  const u = String(href || '');
  try {
    if (/duckduckgo\.com\/l\//i.test(u)) {
      const m = /[?&]uddg=([^&]+)/.exec(u);
      if (m) {
        const real = decodeURIComponent(m[1]);
        if (/^https?:\/\//i.test(real)) return real;
      }
      return u;
    }
    return u;
  } catch (e) { return u; }
}

/**
 * 还原百度跳转链接 www.baidu.com/link?url=... -> 真实 URL
 * 百度可能返回 302（fetcher 自动跟随）或 JS 跳转页（扫描 body），或反爬验证页
 */
async function resolveBaiduLink(href, timeout) {
  const u = String(href || '');
  if (!u || !/baidu\.com\/link\?/i.test(u)) return { url: u, resolved: true };
  try {
    const page = await fetchPage(u, { timeout: timeout || 8000, maxBytes: 512 * 1024 });
    if (page.status >= 400) return { url: u, resolved: false, note: 'HTTP ' + page.status };
    if (/百度安全验证|wappass\.baidu\.com/i.test(page.body + ' ' + page.finalUrl)) {
      return { url: u, resolved: false, note: '触发百度反爬验证' };
    }
    const js = /window\.location\.replace\("([^"]+)"\)/.exec(page.body)
      || /window\.location\.href\s*=\s*"([^"]+)"/.exec(page.body)
      || /URL='([^']+)'/.exec(page.body);
    if (js && /^https?:\/\//i.test(js[1])) return { url: js[1], resolved: true };
    if (page.finalUrl && !/baidu\.com\/link/i.test(page.finalUrl)) return { url: page.finalUrl, resolved: true };
    return { url: page.finalUrl || u, resolved: true };
  } catch (e) {
    return { url: u, resolved: false, note: e.message };
  }
}

module.exports = {
  collapse, clampInt, classList, findRanges, textInRange, findStart,
  anchorText, decodeBingUrl, decodeDdgUrl, resolveBaiduLink
};
