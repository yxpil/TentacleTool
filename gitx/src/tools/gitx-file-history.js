'use strict';
/**
 * gitx_file_history —— 单文件提交历史（含重命名跟踪）
 *
 * 一律用 `git -C <repoPath>`；默认 --follow 跟踪重命名。
 */
const { isGitRepo, runGit, hasCommits, baseProps, truncate } = require('../utils/gitutil');
const { parseLog } = require('./gitx-log');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    path: { type: 'string', description: '文件路径（相对于仓库，必填）' },
    limit: { type: 'number', description: '返回提交数上限（默认 50，上限 200）' },
    follow: { type: 'boolean', description: '是否跟踪重命名 --follow（默认 true）' }
  })
};

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const p = String(args.path || '').trim();
  if (!p) throw new Error('需要提供 path（要查历史的文件路径）');
  if (!hasCommits(args, rp)) {
    return { _text: '▸ 仓库: ' + rp + '\n  尚无任何提交。', repo: rp, path: p, commits: [] };
  }
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200);
  const follow = args.follow === false ? false : true;

  const gitArgs = ['log', '--numstat', '--date=short',
    '--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e', '-n', String(limit)];
  if (follow) gitArgs.push('--follow');
  gitArgs.push('--', p);

  const r = runGit(args, rp, gitArgs, { allowFail: true });
  const commits = parseLog(r.stdout);

  const L = [];
  L.push('▸ 文件历史: ' + p + (follow ? '  (跟踪重命名)' : '') + '  共 ' + commits.length + ' 条');
  L.push('');
  for (const c of commits) {
    L.push('  ' + c.shortHash + '  ' + c.author + '  ' + c.date + '  +' + c.added + '/-' + c.deleted + '  ' + c.subject);
  }
  if (!commits.length) L.push('  （该路径无提交记录）');
  const capped = truncate(L.join('\n'), 6000);

  return {
    _text: capped.text,
    truncated: capped.truncated,
    repo: rp,
    path: p,
    follow,
    count: commits.length,
    commits: commits.map(c => ({
      hash: c.hash, shortHash: c.shortHash, author: c.author, email: c.email,
      date: c.date, subject: c.subject, added: c.added, deleted: c.deleted, files: c.files
    }))
  };
}

module.exports = {
  name: 'gitx_file_history',
  title: '单文件提交历史（跟踪重命名）',
  description:
    '查看单个文件的提交历史（默认 --follow 跟踪重命名）。limit 控制条数（默认 50）。' +
    '返回每笔触及该文件的提交及其增删统计。',
  inputSchema,
  run
};
