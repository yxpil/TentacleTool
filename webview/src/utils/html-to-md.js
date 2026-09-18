'use strict';
/**
 * 零依赖 HTML -> Markdown 转换器
 *
 * 自带 HTML 分词器（token 流：text / start / end），栈式状态机渲染：
 * - 标题 h1-h6、段落、换行、水平线
 * - 无序/有序列表（支持嵌套）、引用块（支持嵌套）
 * - GFM 表格、围栏代码块（自动识别 language-xxx）
 * - 行内样式：粗体/斜体/删除线/行内代码/链接/图片
 * - content 模式：正文降噪（去 nav/aside/footer/广告等）+ 主内容块智能选取
 *
 * 全部基于 Node 原生能力，无任何 npm 依赖。
 */

/* ============================ 实体解码 ============================ */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '«', raquo: '»', times: '×', divide: '÷', deg: '°', middot: '·', bull: '•',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', plusmn: '±',
  sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', micro: 'µ',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔'
};

function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g) => {
    if (g[0] === '#') {
      const code = (g[1] === 'x' || g[1] === 'X')
        ? parseInt(g.slice(2), 16)
        : parseInt(g.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    const mapped = NAMED_ENTITIES[g] !== undefined ? NAMED_ENTITIES[g] : NAMED_ENTITIES[g.toLowerCase()];
    return mapped !== undefined ? mapped : m;
  });
}

/* ============================ 分词器 ============================ */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'image'
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'textarea']);

/** HTML 字符串 -> token 流 [{type:'text'|'start'|'end', ...}] */
function tokenize(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;
  let rawTag = null;

  while (i < n) {
    // 处于 raw text 元素（script/style 等）内部：直取文本直到闭合标签
    if (rawTag) {
      const lower = html.toLowerCase();
      const close = lower.indexOf('</' + rawTag, i);
      if (close === -1) {
        tokens.push({ type: 'text', data: html.slice(i) });
        i = n;
      } else {
        if (close > i) tokens.push({ type: 'text', data: html.slice(i, close) });
        const gt = html.indexOf('>', close);
        i = gt === -1 ? n : gt + 1;
        tokens.push({ type: 'end', tag: rawTag });
        rawTag = null;
      }
      continue;
    }

    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (i < n) tokens.push({ type: 'text', data: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', data: html.slice(i, lt) });

    // 注释
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // DOCTYPE / 处理指令
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const gt = html.indexOf('>', lt);
      i = gt === -1 ? n : gt + 1;
      continue;
    }

    const m = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 60));
    if (!m) { tokens.push({ type: 'text', data: '<' }); i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    const isEnd = html[lt + 1] === '/';

    // 找标签结束 '>'（尊重属性内的引号）
    let j = lt + (isEnd ? 2 : 1);
    let q = null;
    let selfClose = false;
    while (j < n) {
      const ch = html[j];
      if (q) { if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') break;
      else if (ch === '/' && html[j + 1] === '>') { selfClose = true; break; }
      j++;
    }
    const tagBody = html.slice(lt + (isEnd ? 2 : 1), j);
    i = html[j] === '>' ? j + 1 : Math.min(n, j + 2);

    if (isEnd) { tokens.push({ type: 'end', tag }); continue; }
    const attrs = parseAttrs(tagBody);
    const voided = selfClose || VOID_TAGS.has(tag);
    tokens.push({ type: 'start', tag, attrs, selfClose: voided });
    if (!voided && RAW_TEXT_TAGS.has(tag)) rawTag = tag;
  }
  return tokens;
}

/** 解析属性串 a="1" b='2' c=3 d -> {a:'1',...} */
function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const name = (m[1] || m[5] || '').toLowerCase();
    if (!name || name in attrs) continue;
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/* ============================ 转换器 ============================ */

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object',
  'embed', 'canvas', 'audio', 'video', 'source', 'track', 'map', 'form',
  'input', 'select', 'option', 'optgroup', 'button', 'textarea', 'label',
  'fieldset', 'datalist', 'dialog', 'head', 'title', 'meta', 'link', 'base'
]);
const CONTENT_SKIP_TAGS = new Set(['nav', 'aside', 'footer']);
const NOISE_ROLE = new Set(['navigation', 'banner', 'complementary', 'contentinfo', 'search', 'dialog']);
const NOISE_CLASS_RE = /(^|[\s_-])(sidebar|widget|menu|breadcrumb|pagination|page-nav|comment|comments|disqus|advert|ads|adsense|banner|promo|promotion|sponsor|social|share|sharing|related|recommend|newsletter|subscribe|footer|nav|navbar|topbar|masthead|search|login|signup|register|cookie|gdpr|consent|modal|popup|tooltip|dropdown|skip-link|screen-reader|sr-only|visually-hidden)/;
const MAIN_CAND_RE = /(^|[\s_-])(content|article|post|entry|main|story|body|text|markdown)/;
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup',
  'hr', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'address', 'details',
  'summary', 'center', 'hgroup', 'form'
]);

function collapseWs(s) { return String(s).replace(/\s+/g, ' '); }
/** 相对 URL -> 绝对 URL（无 baseUrl 或解析失败时原样返回） */
function resolveOpt(url, base) {
  const u = String(url || '').trim();
  if (!u || !base || /^(data|javascript|mailto|tel):/i.test(u) || /^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  try { return new URL(u, base).toString(); } catch (e) { return u; }
}
function extractLang(cls) {
  const m = /(?:language|lang)-([\w+#.-]+)/.exec(cls || '');
  return m ? m[1] : '';
}
function escapeMdUrl(u) {
  return String(u || '').trim()
    .replace(/\s+/g, '%20')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/</g, '%3C').replace(/>/g, '%3E');
}
function escapeCell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

/** content 模式：选出正文主块在 token 流中的区间 [start, end) */
function selectMainContent(tokens) {
  const stack = [];
  let best = null;
  let total = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.type === 'start') {
      if (tk.selfClose || VOID_TAGS.has(tk.tag)) continue;
      const idc = ((tk.attrs.id || '') + ' ' + (tk.attrs.class || '')).toLowerCase();
      const isCand = (tk.tag === 'article' || tk.tag === 'main' || MAIN_CAND_RE.test(idc)) && !NOISE_CLASS_RE.test(idc);
      stack.push({ tag: tk.tag, cand: isCand, len: 0, start: i });
    } else if (tk.type === 'end') {
      let f = -1;
      for (let s = stack.length - 1; s >= 0; s--) { if (stack[s].tag === tk.tag) { f = s; break; } }
      if (f === -1) continue;
      const frame = stack[f];
      if (frame.cand && (!best || frame.len > best.len)) best = { start: frame.start, end: i + 1, len: frame.len };
      stack.length = f;
    } else if (tk.type === 'text') {
      total += tk.data.length;
      for (const fr of stack) fr.len += tk.data.length;
    }
  }
  if (best && best.len >= 300 && best.len <= total * 0.98) return [best.start, best.end];
  return null;
}

class Converter {
  constructor(opts) {
    this.opts = opts;
    this.out = [];
    this.inline = [];
    this.captures = [];   // 行内捕获栈（表格单元格 / 标题 / summary）
    this.listStack = [];  // 嵌套列表
    this.linkStack = [];  // <a> 嵌套
    this.quoteMarks = []; // blockquote 起始行号
    this.quoteDepth = 0;
    this.preBuf = null;   // <pre> 内原文
    this.preLang = '';
    this.skipTag = null;
    this.skipDepth = 0;
    this.tableCtx = null;
    this.curRow = null;
    this.contLine = false; // 上一行是 li 标记行，inline 续写
  }

  get sink() { return this.captures.length ? this.captures[this.captures.length - 1] : this.inline; }
  pushInline(s) { if (s) this.sink.push(s); }
  get capturing() { return this.captures.length > 0; }

  pushBlock(line) {
    if (this.out.length && this.out[this.out.length - 1] !== '') this.out.push('');
    this.out.push(line);
  }

  flushInline() {
    const raw = this.inline.join('');
    this.inline = [];
    const text = raw.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/`{2,}/g, '`').replace(/\*{4,}/g, '').trim();
    if (!text) return;
    if (this.capturing) {
      const sink = this.captures[this.captures.length - 1];
      sink.push(sink.length ? ' ' : '', text);
      return;
    }
    if (this.contLine && this.out.length) {
      const last = this.out[this.out.length - 1];
      this.out[this.out.length - 1] = (last && last !== '') ? last + ' ' + text.replace(/\n/g, ' ') : text;
      return;
    }
    this.pushBlock(text);
  }

  shouldSkip(tag, tk) {
    if (SKIP_TAGS.has(tag)) return true;
    if (this.opts.mode !== 'content') return false;
    if (CONTENT_SKIP_TAGS.has(tag)) return true;
    if (tk.attrs && NOISE_ROLE.has((tk.attrs.role || '').toLowerCase())) return true;
    const idc = ((tk.attrs && tk.attrs.id) || '') + ' ' + ((tk.attrs && tk.attrs.class) || '');
    if (idc.trim() && NOISE_CLASS_RE.test(idc.toLowerCase()) && BLOCK_TAGS.has(tag)) return true;
    return false;
  }

  onStart(tk) {
    const tag = tk.tag;
    const attrs = tk.attrs || {};

    // 跳过区
    if (this.skipDepth > 0) {
      if (!tk.selfClose && tag === this.skipTag) this.skipDepth++;
      return;
    }

    // <pre> 内部：不做任何跳过（代码高亮常包 button/span/em 等，文本必须原样保留）
    if (this.preBuf !== null) {
      if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
        if (!this.preLang) this.preLang = extractLang(attrs.class);
        return;
      }
      if (tag === 'br') { this.preBuf.push('\n'); return; }
      return;
    }

    if (this.shouldSkip(tag, tk)) {
      if (tk.selfClose || VOID_TAGS.has(tag)) return; // void 元素无需等待闭合
      this.skipTag = tag;
      this.skipDepth = 1;
      return;
    }

    // 表格单元格内：所有内容行内化
    // 注意：td/th/caption 是「开局元」而非行内内容——它们要开启新的捕获缓冲，
    // 必须在下面 switch 里处理。若在这里就被 BLOCK_TAGS 拦下改成空格，
    // 捕获缓冲永不开启 → renderCapture() 返回空 → 整行 cells 为空 → emitTable 直接丢弃表格。
    if (this.curRow !== null) {
      if (tag === 'table') return; // 忽略嵌套表格
      if (tag !== 'td' && tag !== 'th' && tag !== 'caption' &&
          (tag === 'br' || BLOCK_TAGS.has(tag))) { this.pushInline(' '); return; }
    }

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        this.flushInline();
        this.captures.push([]);
        this._heading = parseInt(tag[1], 10);
        return;
      }
      case 'summary': {
        this.flushInline();
        this.captures.push([]);
        return;
      }
      case 'hr':
        this.flushInline();
        this.pushBlock('---');
        return;
      case 'br':
        this.pushInline('\n');
        return;
      case 'ul': case 'ol':
        this.flushInline();
        this.contLine = false;
        this.listStack.push({ type: tag === 'ul' ? 'ul' : 'ol', count: 0 });
        return;
      case 'li': {
        this.flushInline();
        if (this.listStack.length === 0) this.listStack.push({ type: 'ul', count: 0 });
        const ls = this.listStack[this.listStack.length - 1];
        ls.count++;
        const marker = ls.type === 'ol' ? (ls.count + '. ') : '- ';
        this.out.push('  '.repeat(this.listStack.length - 1) + marker);
        this.contLine = true;
        return;
      }
      case 'blockquote':
        this.flushInline();
        this.contLine = false;
        this.quoteMarks.push(this.out.length);
        this.quoteDepth++;
        return;
      case 'pre':
        this.flushInline();
        this.contLine = false;
        this.preBuf = [];
        this.preLang = extractLang(attrs.class);
        return;
      case 'table':
        this.flushInline();
        this.contLine = false;
        this.tableCtx = { rows: [], caption: '' };
        return;
      case 'tr':
        if (this.tableCtx) { this.curRow = []; }
        return;
      case 'td': case 'th':
        if (this.curRow !== null) { this.flushInline(); this.captures.push([]); }
        return;
      case 'caption':
        if (this.tableCtx) { this.flushInline(); this.captures.push([]); }
        return;
      case 'a': {
        const href = resolveOpt((attrs.href || '').trim(), this.opts.baseUrl);
        if (this.opts.includeLinks && href && !/^javascript:/i.test(href)) {
          this.linkStack.push({ href, at: this.sink.length });
          this.pushInline('[');
        } else {
          this.linkStack.push({ href: null, at: this.sink.length });
        }
        return;
      }
      case 'img': {
        const src = resolveOpt((attrs.src || attrs['data-src'] || '').trim(), this.opts.baseUrl);
        if (this.opts.includeImages && src && !/^data:/i.test(src)) {
          const alt = (attrs.alt || '').replace(/[\[\]]/g, '').trim();
          this.pushInline(`![${alt}](${escapeMdUrl(src)})`);
        }
        return;
      }
      case 'strong': case 'b': this.pushInline('**'); return;
      case 'em': case 'i': this.pushInline('*'); return;
      case 'del': case 's': case 'strike': this.pushInline('~~'); return;
      case 'code': case 'kbd': case 'samp': case 'tt': this.pushInline('`'); return;
      default:
        if (BLOCK_TAGS.has(tag)) this.flushInline();
        return;
    }
  }

  onEnd(tag) {
    // 跳过区
    if (this.skipDepth > 0) {
      if (tag === this.skipTag) { this.skipDepth--; if (this.skipDepth === 0) this.skipTag = null; }
      return;
    }
    // <pre> 结束
    if (this.preBuf !== null) {
      if (tag === 'pre') {
        const code = this.preBuf.join('').replace(/\n+$/, '');
        this.preBuf = null;
        if (code.trim()) {
          this.pushBlock('```' + (this.preLang || ''));
          for (const line of code.split('\n')) this.out.push(line);
          this.out.push('```');
        }
      }
      return; // pre 内的 </code> 等直接忽略
    }
    // 表格内部结束
    if (this.tableCtx) {
      if (tag === 'td' || tag === 'th') {
        if (this.captures.length) {
          const cell = this.renderCapture();
          this.curRow.push(escapeCell(cell) || ' ');
        }
        return;
      }
      if (tag === 'tr') {
        if (this.curRow) {
          if (this.curRow.length) this.tableCtx.rows.push(this.curRow);
          this.curRow = null;
        }
        return;
      }
      if (tag === 'caption') {
        if (this.tableCtx) this.tableCtx.caption = this.renderCapture();
        return;
      }
      if (tag === 'table') { this.emitTable(); return; }
      // tbody/thead 等直接落过
      if (!BLOCK_TAGS.has(tag)) return;
      return;
    }

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        if (this._heading) {
          const text = this.renderCapture();
          this.pushBlock('#'.repeat(this._heading) + ' ' + text);
          this._heading = 0;
        }
        return;
      }
      case 'summary': {
        const text = this.renderCapture();
        if (text) this.pushBlock('**' + text + '**');
        return;
      }
      case 'li': {
        this.flushInline();
        this.contLine = false;
        return;
      }
      case 'ul': case 'ol': {
        this.flushInline();
        this.listStack.pop();
        if (this.listStack.length > 0) this.contLine = true; // 回到父级 li 续写
        return;
      }
      case 'blockquote': {
        this.flushInline();
        const mark = this.quoteMarks.pop();
        this.quoteDepth--;
        if (mark !== undefined) {
          const lines = this.out.splice(mark);
          const prefix = '> ';
          const quoted = lines.map(l => l ? prefix + l : '>');
          if (this.out.length && this.out[this.out.length - 1] !== '') this.out.push('');
          for (const l of quoted) this.out.push(l);
        }
        return;
      }
      case 'p': case 'div': case 'section': case 'article': case 'main':
      case 'header': case 'figure': case 'figcaption': case 'dl': case 'dd':
      case 'dt': case 'address': case 'center': case 'details': case 'body':
      case 'html': case 'hgroup':
        this.flushInline();
        return;
      case 'a': {
        const st = this.linkStack.pop();
        if (!st) return;
        // st.at 处存的是 '[' 标记本身，文本从 at+1 开始
        const text = this.sink.slice(st.at + 1).join('');
        if (st.href) {
          if (text.trim() === '') { // 空文本链接 -> 自动链接
            this.sink.length = st.at;
            this.pushInline('<' + escapeMdUrl(st.href) + '>');
          } else {
            this.pushInline('](' + escapeMdUrl(st.href) + ')');
          }
        }
        return;
      }
      case 'strong': case 'b': this.pushInline('**'); return;
      case 'em': case 'i': this.pushInline('*'); return;
      case 'del': case 's': case 'strike': this.pushInline('~~'); return;
      case 'code': case 'kbd': case 'samp': case 'tt': this.pushInline('`'); return;
      default: return;
    }
  }

  renderCapture() {
    if (!this.captures.length) return '';
    const buf = this.captures.pop();
    return buf.join('').replace(/[ \t]+/g, ' ').trim();
  }

  emitTable() {
    const rows = this.tableCtx.rows;
    const caption = this.tableCtx.caption;
    this.tableCtx = null;
    this.curRow = null;
    if (caption) this.pushBlock(caption);
    if (!rows.length) return;
    const width = Math.max(...rows.map(r => r.length));
    for (const r of rows) { while (r.length < width) r.push(' '); }
    const header = rows[0];
    const sep = Array(width).fill('---');
    this.pushBlock('| ' + header.join(' | ') + ' |');
    this.out.push('| ' + sep.join(' | ') + ' |');
    for (let r = 1; r < rows.length; r++) this.out.push('| ' + rows[r].join(' | ') + ' |');
  }
}

/** 行内缓冲 -> 纯文本（用于分词层统计） */
function tokensPlainText(tokens, start, end) {
  let s = '';
  for (let i = start; i < end; i++) if (tokens[i].type === 'text') s += tokens[i].data;
  return s;
}

/* ============================ 主入口 ============================ */

/**
 * HTML -> Markdown
 * @param {string} html
 * @param {object} options - { mode:'content'|'full', includeImages, includeLinks, includeTitle }
 * @returns {{ title, markdown }}
 */
function htmlToMarkdown(html, options = {}) {
  const opts = {
    mode: options.mode === 'full' ? 'full' : 'content',
    includeImages: options.includeImages !== false,
    includeLinks: options.includeLinks !== false,
    includeTitle: options.includeTitle !== false,
    baseUrl: options.baseUrl || ''
  };
  const tokens = tokenize(String(html || ''));

  // 文档标题
  let docTitle = '';
  for (let t = 0; t < tokens.length; t++) {
    const tk = tokens[t];
    if (tk.type === 'start' && tk.tag === 'title') {
      let s = '';
      for (let u = t + 1; u < tokens.length; u++) {
        if (tokens[u].type === 'end' && tokens[u].tag === 'title') break;
        if (tokens[u].type === 'text') s += tokens[u].data;
      }
      docTitle = collapseWs(decodeEntities(s)).trim();
      break;
    }
    if (tk.type === 'end' && tk.tag === 'head') break;
  }

  // 主内容区间（content 模式）
  let start = 0;
  let end = tokens.length;
  if (opts.mode === 'content') {
    const range = selectMainContent(tokens);
    if (range) { start = range[0]; end = range[1]; }
  }

  const c = new Converter(opts);
  for (let i = start; i < end; i++) {
    const tk = tokens[i];
    if (tk.type === 'text') {
      if (c.skipDepth > 0) continue;
      if (c.preBuf !== null) { c.preBuf.push(decodeEntities(tk.data)); continue; }
      if (c.curRow !== null && c.captures.length === 0) continue; // tr 直接文本（无单元格包裹）
      c.pushInline(collapseWs(decodeEntities(tk.data)));
    } else if (tk.type === 'start') {
      c.onStart(tk);
    } else if (tk.type === 'end') {
      c.onEnd(tk.tag);
    }
  }
  c.flushInline();

  let md = c.out.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+$/, '')
    .replace(/^\n+/, '')
    .trim();

  if (opts.includeTitle && docTitle) {
    const h1 = /^# (.+)$/m.exec(md);
    if (!h1 || h1[1].trim() !== docTitle) md = '# ' + docTitle + '\n\n' + md;
  }

  return { title: docTitle, markdown: md };
}

module.exports = { htmlToMarkdown, tokenize, decodeEntities, parseAttrs, tokensPlainText };
