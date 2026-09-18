'use strict';
/**
 * Git 操作共享工具：git 可执行文件解析、仓库校验、命令执行、CJK 宽字符排版、截断
 *
 * 设计要点：
 *  - 一律用 `git -C <repoPath>` 形式，repoPath 默认当前目录
 *  - git 二进制可经 args.gitBinary / 环境变量 GIT_BINARY 覆盖（本机 git 不在 PATH）
 *  - 非 git 仓库时抛中文错误而非崩溃
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* ======================== git 二进制与仓库 ======================== */

function gitBinary(args) {
  if (args && typeof args.gitBinary === 'string' && args.gitBinary.trim()) return args.gitBinary.trim();
  if (process.env.GIT_BINARY && process.env.GIT_BINARY.trim()) return process.env.GIT_BINARY.trim();
  return 'git';
}

function resolveRepo(repoPath) {
  const rp = (repoPath && String(repoPath).trim()) ? String(repoPath) : '.';
  return path.resolve(rp);
}

/** 校验是否为 git 仓库；返回规范化后的绝对路径，否则抛中文错误 */
function isGitRepo(args, repoPath) {
  const rp = resolveRepo(repoPath);
  if (!fs.existsSync(rp)) {
    throw new Error('路径不存在：' + rp);
  }
  const gitDir = path.join(rp, '.git');
  if (fs.existsSync(gitDir)) {
    // .git 是目录或文件（submodule 的 gitdir 指针）都算仓库根
    return rp;
  }
  const r = spawnSync(gitBinary(args), ['-C', rp, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (r.status === 0 && (r.stdout || '').trim() === 'true') return rp;
  throw new Error('不是 Git 仓库：' + rp + '（未找到 .git，或不在工作树内）');
}

/** 执行 git 命令；返回 { ok, status, stdout, stderr }（stdout/stderr 已统一换行符） */
function runGit(args, repoPath, gitArgs, opts) {
  opts = opts || {};
  let r;
  try {
    r = spawnSync(gitBinary(args), ['-C', resolveRepo(repoPath)].concat(gitArgs), {
      encoding: 'utf8',
      maxBuffer: 60 * 1024 * 1024
    });
  } catch (e) {
    throw new Error('git 执行异常：' + e.message);
  }
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      throw new Error(
        '无法执行 git（' + gitBinary(args) + '）。请确认 git 已安装，' +
        '或通过 gitBinary 参数 / GIT_BINARY 环境变量指定可执行文件路径。'
      );
    }
    throw new Error('git 执行出错：' + r.error.message);
  }
  const out = (r.stdout || '').replace(/\r\n/g, '\n');
  const err = (r.stderr || '').replace(/\r\n/g, '\n');
  if (!opts.allowFail && r.status !== 0) {
    // 把 git 的错误信息转成中文可读提示（git 本身已是中文 locale 时会很友好）
    const msg = (err || out || '').trim();
    throw new Error('git ' + gitArgs.join(' ') + ' 失败：' + (msg || '未知错误'));
  }
  return { ok: r.status === 0, status: r.status, stdout: out, stderr: err };
}

/** 是否需要初始提交（仓库存在但还没有任何 commit）—— git log 会失败 */
function hasCommits(args, repoPath) {
  const r = spawnSync(gitBinary(args), ['-C', resolveRepo(repoPath), 'rev-list', '-n', '1', '--all'], { encoding: 'utf8' });
  return r.status === 0 && !!(r.stdout || '').trim();
}

/* ======================== CJK 宽字符排版 ======================== */

// CJK（含全角标点、假名、汉字）按显示宽度计 2 列，与 fsx/stamp 约定一致
const CJK_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(s) {
  let w = 0;
  const str = String(s);
  for (const ch of str) w += CJK_RE.test(ch) ? 2 : 1;
  return w;
}

function padEnd(s, n) {
  s = String(s);
  const d = n - displayWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

function padStart(s, n) {
  s = String(s);
  const d = n - displayWidth(s);
  return d > 0 ? ' '.repeat(d) + s : s;
}

/** 生成对齐表格；列宽按显示宽度算，CJK 计 2 列；null/undefined 显示为 — */
function table(headers, rows) {
  const cols = headers.length;
  const widths = headers.map((h, i) => {
    let w = displayWidth(h);
    for (const r of rows) {
      const v = r[i] == null ? '—' : r[i];
      if (w < displayWidth(v)) w = displayWidth(v);
    }
    return w;
  });
  const fmt = (cells) => '  ' + cells.map((c, i) => padEnd(c == null ? '—' : c, widths[i])).join('  ');
  const lines = [fmt(headers)];
  lines.push('  ' + widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmt(r));
  return lines.join('\n');
}

/** 截断文本；超出 max 则在末尾追加续读提示并标记 truncated */
function truncate(text, max, hint) {
  if (text == null) text = '';
  text = String(text);
  if (text.length <= max) return { text, truncated: false };
  const tail = hint || '… 输出已截断，使用 limit / 行范围 / 更多参数查看完整内容';
  return { text: text.slice(0, max) + '\n' + tail, truncated: true };
}

/** 把字符串渲染为安全表格单元（null/undefined → —） */
function cell(v) {
  return v == null ? '—' : String(v);
}

/** 所有工具共有的两个参数：repoPath / gitBinary */
function baseProps() {
  return {
    repoPath: { type: 'string', description: 'Git 仓库路径（默认当前工作目录）' },
    gitBinary: { type: 'string', description: 'git 可执行文件路径，覆盖默认值与环境变量 GIT_BINARY（本机 git 不在 PATH 时尤其有用）' }
  };
}

module.exports = {
  gitBinary, resolveRepo, isGitRepo, runGit, hasCommits,
  displayWidth, padEnd, padStart, table, truncate, cell, baseProps
};
