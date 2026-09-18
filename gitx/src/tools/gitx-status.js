'use strict';
/**
 * gitx_status —— 工作区状态
 *
 * 返回当前分支、暂存/未暂存/未跟踪变更、领先/落后、最近提交摘要。
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, hasCommits, baseProps } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {})
};

/** 取最近一次提交；无提交则返回 null */
function lastCommit(args, rp) {
  if (!hasCommits(args, rp)) return null;
  const r = runGit(args, rp, ['log', '-1', '--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s', '--date=short'], { allowFail: true });
  if (!r.ok || !r.stdout.trim()) return null;
  const p = r.stdout.trim().split('\x1f');
  return {
    hash: p[0],
    shortHash: p[0].slice(0, 7),
    author: p[1],
    email: p[2],
    date: p[3],
    subject: p[4]
  };
}

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);

  const st = runGit(args, rp, ['status', '--porcelain=v1', '-b'], { allowFail: true });
  const lines = st.stdout.split('\n').filter(l => l.length);

  let branch = '(unknown)', upstream = null, ahead = 0, behind = 0;
  const staged = [], unstaged = [], untracked = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const info = line.slice(3).replace(/\s+$/, '');
      const noCommits = info.match(/^No commits yet on (.+)$/);
      if (noCommits) {
        branch = noCommits[1];
      } else {
        const br = info.match(/^([^\s.]+)/);
        branch = br ? br[1] : info;
      }
      const up = info.match(/\.\.\.(\S+)/);
      if (up) upstream = up[1];
      const a = info.match(/ahead (\d+)/);
      const b = info.match(/behind (\d+)/);
      ahead = a ? parseInt(a[1], 10) : 0;
      behind = b ? parseInt(b[1], 10) : 0;
      continue;
    }
    const code = line.slice(0, 2);
    const p = line.slice(3);
    if (code === '??') { untracked.push(p); continue; }
    const c0 = code[0], c1 = code[1];
    if (c0 !== ' ' && c0 !== '?') staged.push({ status: c0, path: p });
    if (c1 !== ' ' && c1 !== '?') unstaged.push({ status: c1, path: p });
  }

  const lc = lastCommit(args, rp);
  const clean = staged.length + unstaged.length + untracked.length === 0;

  const L = [];
  L.push('▸ 仓库: ' + rp);
  let head = '  分支: ' + branch;
  if (upstream) head += '  (跟踪 ' + upstream + ')';
  if (ahead || behind) head += '   领先 ' + ahead + ' / 落后 ' + behind;
  L.push(head);
  L.push('  状态: ' + (clean ? '干净（无未提交改动）' : '有改动'));

  if (staged.length) {
    L.push('');
    L.push('■ 暂存 (staged): ' + staged.length);
    for (const s of staged) L.push('  ' + s.status + '  ' + s.path);
  }
  if (unstaged.length) {
    L.push('');
    L.push('■ 未暂存 (unstaged): ' + unstaged.length);
    for (const s of unstaged) L.push('  ' + s.status + '  ' + s.path);
  }
  if (untracked.length) {
    L.push('');
    L.push('■ 未跟踪 (untracked): ' + untracked.length);
    for (const s of untracked) L.push('  ?? ' + s.path);
  }
  L.push('');
  L.push('■ 最近提交');
  if (lc) {
    L.push('  ' + lc.shortHash + '  ' + lc.author + '  ' + lc.date + '  ' + lc.subject);
  } else {
    L.push('  （尚无任何提交；用 gitx_commit 创建首个提交）');
  }

  return {
    _text: L.join('\n'),
    repo: rp,
    branch,
    upstream,
    ahead,
    behind,
    clean,
    staged,
    unstaged,
    untracked,
    lastCommit: lc
  };
}

module.exports = {
  name: 'gitx_status',
  title: '工作区状态（分支/变更/领先落后/最近提交）',
  description:
    '查看 Git 仓库当前状态：当前分支（及其跟踪的上游分支）、领先/落后提交数、' +
    '分 staged / unstaged / untracked 三类列出的变更文件、以及最近一次提交摘要。' +
    'repoPath 默认当前目录；非 git 仓库会给出明确错误而非崩溃。',
  inputSchema,
  run
};
