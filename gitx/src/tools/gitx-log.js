'use strict';
/**
 * gitx_log —— 提交历史
 *
 * 支持 limit、作者过滤、日期范围、路径过滤、oneline/详细模式，并附每提交的文件统计。
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, hasCommits, baseProps, truncate } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    limit: { type: 'number', description: '返回提交数上限（默认 20，上限 200）' },
    author: { type: 'string', description: '按作者过滤（匹配 author 名称/邮箱，支持 git 的 --author 语义）' },
    since: { type: 'string', description: '起始日期过滤，如 "2026-01-01" 或 "2 weeks ago"（对应 --since）' },
    until: { type: 'string', description: '结束日期过滤（对应 --until）' },
    path: { type: 'string', description: '只显示触及该路径（文件或目录）的提交；可传多个用逗号分隔或数组' },
    oneline: { type: 'boolean', description: 'oneline=true（默认）文本每提交一行；false 则显示每提交的文件统计' }
  })
};

function parsePaths(pathArg) {
  if (!pathArg) return [];
  if (Array.isArray(pathArg)) return pathArg.map(String);
  return String(pathArg).split(',').map(s => s.trim()).filter(Boolean);
}

/** 解析 git log --numstat --pretty=format:... 输出 */
function parseLog(text) {
  const commits = [];
  let cur = null;
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    // 提交头：以 \x1e 结尾（出现新头时先收尾上一个提交）
    const body = line.replace(/\x1e$/, '');
    const parts = body.split('\x1f');
    if (parts.length >= 5 && /^[0-9a-f]{7,40}$/.test(parts[0])) {
      if (cur) commits.push(cur);
      cur = {
        hash: parts[0],
        shortHash: parts[0].slice(0, 7),
        author: parts[1],
        email: parts[2],
        date: parts[3],
        subject: parts.slice(4).join('\x1f'),
        files: [],
        added: 0,
        deleted: 0
      };
      continue;
    }
    // numstat 行：<added>\t<deleted>\t<path>（二进制为 - -）。注意 header 与 numstat 之间
    // git 可能输出空行，因此不在空行 flush，只在新 header 或结尾收尾，保证 numstat 归属正确。
    if (cur && /^[-0-9]+\t[-0-9]+\t/.test(line)) {
      const m = line.match(/^([-0-9]+)\t([-0-9]+)\t(.*)$/);
      if (m) {
        const added = m[1] === '-' ? null : parseInt(m[1], 10);
        const deleted = m[2] === '-' ? null : parseInt(m[2], 10);
        cur.files.push({ path: m[3], added, deleted });
        if (added != null) cur.added += added;
        if (deleted != null) cur.deleted += deleted;
      }
    }
    // 其它行（空行、commit 间的分隔）忽略
  }
  if (cur) commits.push(cur);
  return commits;
}

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  if (!hasCommits(args, rp)) {
    return { _text: '▸ 仓库: ' + rp + '\n  尚无任何提交。', repo: rp, commits: [] };
  }

  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 200);
  const oneline = args.oneline === false ? false : true;

  const gitArgs = ['log', '--numstat', '--date=short',
    '--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e', '-n', String(limit)];
  if (args.author) gitArgs.push('--author=' + String(args.author));
  if (args.since) gitArgs.push('--since=' + String(args.since));
  if (args.until) gitArgs.push('--until=' + String(args.until));
  const paths = parsePaths(args.path);
  if (paths.length) { gitArgs.push('--'); gitArgs.push.apply(gitArgs, paths); }

  const r = runGit(args, rp, gitArgs, { allowFail: true });
  const commits = parseLog(r.stdout);

  const L = [];
  L.push('▸ 仓库: ' + rp + '   (共 ' + commits.length + ' 条提交' +
    (paths.length ? '，路径过滤: ' + paths.join(', ') : '') + ')');
  L.push('');
  if (!commits.length) {
    L.push('  （无匹配提交）');
  } else if (oneline) {
    for (const c of commits) {
      L.push('  ' + c.shortHash + '  ' + c.author + '  ' + c.date + '  ' + c.subject);
    }
  } else {
    for (const c of commits) {
      L.push('  ● ' + c.shortHash + '  ' + c.author + ' <' + c.email + '>  ' + c.date);
      L.push('    ' + c.subject);
      L.push('    +' + c.added + ' / -' + c.deleted + '，' + c.files.length + ' 个文件');
      for (const f of c.files.slice(0, 20)) {
        const a = f.added == null ? '-' : '+' + f.added;
        const d = f.deleted == null ? '-' : '-' + f.deleted;
        L.push('      ' + a + ' ' + d + '  ' + f.path);
      }
      if (c.files.length > 20) L.push('      … 还有 ' + (c.files.length - 20) + ' 个文件');
      L.push('');
    }
  }
  const capped = truncate(L.join('\n'), 6000);

  return {
    _text: capped.text,
    truncated: capped.truncated,
    repo: rp,
    oneline,
    count: commits.length,
    commits: commits.map(c => ({
      hash: c.hash,
      shortHash: c.shortHash,
      author: c.author,
      email: c.email,
      date: c.date,
      subject: c.subject,
      added: c.added,
      deleted: c.deleted,
      files: c.files
    }))
  };
}

module.exports = {
  name: 'gitx_log',
  title: '提交历史（过滤/统计/oneline 或详细）',
  description:
    '查看提交历史。limit 控制条数（默认 20）；author 按作者过滤；since/until 按日期范围过滤；' +
    'path 只显示触及指定文件/目录的提交（可逗号分隔或数组）。oneline=true（默认）每提交一行；' +
    'oneline=false 显示每提交的文件增删统计。返回含每提交改动文件与增删行数。',
  inputSchema,
  run,
  parseLog,
  parsePaths
};
