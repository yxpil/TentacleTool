'use strict';
/**
 * 语言提取器注册表
 *
 * 每个提取器把一份源码文本变成"符号定义 + 关系"：
 *   symbols: [{ name, kind, line, exported, container, params, doc }]
 *   imports: [{ name, from, line, kind }]    —— 导入的模块/文件
 *   calls:   [{ name, line, member }]        —— 调用到的名字（未解析）
 *   refs:    [{ name, line, kind }]          —— 其他引用（继承/类型注解/导入名）
 *
 * 设计取舍：**不追求完整语法树**，只做"够用的词法 + 锚点正则"。
 * 零依赖前提下，正则 + 轻量状态机（去注释/去字符串）能覆盖真实代码的绝大多数情形，
 * 比引入完整 parser 便宜得多，也不会因语言版本差异而炸。
 *
 * 依赖图（无环）：tables.js ← clean.js ← lang/*.js ← index.js
 */

const jsLike = require('./js');
const python = require('./python');
const go = require('./go');
const rust = require('./rust');
const javaLike = require('./javalike');
const cLike = require('./clike');
const ruby = require('./ruby');
const php = require('./php');
const { EXT_TO_LANG, COMMENT_STYLE, BRACE_LANGS, LANG_KINDS } = require('./tables');

const LANGUAGES = {
  javascript: jsLike.javascript,
  typescript: jsLike.typescript,
  python: python,
  go: go,
  rust: rust,
  java: javaLike.java,
  csharp: javaLike.csharp,
  c: cLike.c,
  cpp: cLike.cpp,
  ruby: ruby,
  php: php
};

function langOf(filePath) {
  const m = /(\.[A-Za-z0-9]+)$/.exec(String(filePath || ''));
  if (!m) return null;
  return EXT_TO_LANG[m[1].toLowerCase()] || null;
}

function extractorFor(lang) {
  return LANGUAGES[lang] || null;
}

/** 全部已知扩展名（供索引器判断"是否值得解析"） */
function knownExtensions() {
  return Object.keys(EXT_TO_LANG);
}

/** 语言 → 展示名 */
const LANG_LABEL = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python',
  go: 'Go', rust: 'Rust', java: 'Java', csharp: 'C#',
  c: 'C', cpp: 'C++', ruby: 'Ruby', php: 'PHP'
};

module.exports = {
  LANGUAGES,
  EXT_TO_LANG,
  COMMENT_STYLE,
  BRACE_LANGS,
  LANG_KINDS,
  LANG_LABEL,
  langOf,
  extractorFor,
  knownExtensions
};
