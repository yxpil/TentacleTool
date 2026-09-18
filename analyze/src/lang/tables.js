'use strict';
/**
 * 语言基础表：扩展名映射、注释风格、是否花括号语言
 *
 * 单独一个文件是为了**打破循环依赖**：
 *   clean.js（净化）需要注释风格表
 *   index.js（注册表）需要 clean.js 的产出 + 各语言提取器
 *   各语言提取器又要 clean.js
 * 表格抽出来，依赖图就变成无环的：
 *   tables.js  ←  clean.js  ←  lang/*.js  ←  index.js
 */

/** 扩展名 → 语言名 */
const EXT_TO_LANG = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'java',      // Kotlin 语法接近，用 java 提取器兜底
  '.kts': 'java',
  '.scala': 'java',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.m': 'c',
  '.mm': 'cpp',
  '.rb': 'ruby',
  '.php': 'php'
};

/** 语言 → 注释符号 */
const COMMENT_STYLE = {
  javascript: { line: '//', block: ['/*', '*/'] },
  typescript: { line: '//', block: ['/*', '*/'] },
  python: { line: '#', block: null },
  go: { line: '//', block: ['/*', '*/'] },
  rust: { line: '//', block: ['/*', '*/'] },
  java: { line: '//', block: ['/*', '*/'] },
  csharp: { line: '//', block: ['/*', '*/'] },
  c: { line: '//', block: ['/*', '*/'] },
  cpp: { line: '//', block: ['/*', '*/'] },
  ruby: { line: '#', block: ['=begin', '=end'] },
  php: { line: '//', block: ['/*', '*/'] }
};

/** 该语言是否为"花括号语言"（影响作用域配对） */
const BRACE_LANGS = new Set([
  'javascript', 'typescript', 'go', 'rust', 'java', 'csharp', 'c', 'cpp', 'php'
]);

/** 语言 → 默认支持的符号类型（供文档/过滤用） */
const LANG_KINDS = {
  javascript: ['function', 'class', 'method', 'variable', 'property'],
  typescript: ['function', 'class', 'method', 'variable', 'property', 'interface', 'type', 'enum'],
  python: ['function', 'class', 'method', 'variable'],
  go: ['function', 'method', 'struct', 'interface', 'type', 'variable', 'const'],
  rust: ['function', 'method', 'struct', 'enum', 'trait', 'impl', 'type', 'variable', 'const', 'mod'],
  java: ['class', 'interface', 'enum', 'method', 'field', 'record'],
  csharp: ['class', 'interface', 'struct', 'enum', 'method', 'property', 'field', 'record', 'delegate'],
  c: ['function', 'struct', 'enum', 'union', 'typedef', 'variable', 'macro'],
  cpp: ['function', 'class', 'struct', 'enum', 'union', 'typedef', 'method', 'variable', 'macro', 'namespace'],
  ruby: ['class', 'module', 'method', 'constant'],
  php: ['function', 'class', 'interface', 'trait', 'method', 'property', 'const']
};

module.exports = { EXT_TO_LANG, COMMENT_STYLE, BRACE_LANGS, LANG_KINDS };
