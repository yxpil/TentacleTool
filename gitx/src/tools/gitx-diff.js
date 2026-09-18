'use strict';
/**
 * gitx_diff —— 差异比较
 *
 * 支持工作区/暂存区/两提交间比较、stat 模式（只看统计）、路径过滤、限制输出行数。
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, baseProps, truncate } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    staged: { type: 'boolean', description: 'true 时比较暂存区与 HEAD（git diff --cached）；默认比较工作区与暂存区' },
    commit: { type: 'string', description: '单个提交/引用：git diff <commit>（该提交到工作树的差异）；与 commit2 同时给出则比较两提交' },
    commit2: { type: 'string', description: '第二个提交/引用：与 commit 一起，比较 git diff <commit> <commit2>' },
    stat: { type: 'boolean', description: 'true 时只返回统计（git diff --stat），不看具体改动' },
    path: { type: 'string', description: '只比较指定路径（文件/目录），可逗号分隔或数组' },
    maxLines: { type: 'number', description: '非 stat 模式下文本输出的最大行数（默认 400，超出截断+续读提示）' }
  })
};

function parsePaths(pathArg) {
  if (!pathArg) return [];
  if (Array.isArray(pathArg)) return pathArg.map(String);
  return String(pathArg).split(',').map(s => s.trim()).filter(Boolean);
}

function parseNumstat(text) {
  const files = [];
  let added = 0, deleted = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^([-0-9]+)\t([-0-9]+)\t(.*)$/);
    if (m) {
      const a = m[1] === '-' ? null : parseInt(m[1], 10);
      const d = m[2] === '-' ? null : parseInt(m[2], 10);
      files.push({ path: m[3], added: a, deleted: d });
      if (a != null) added += a;
      if (d != null) deleted += d;
    }
  }
  return { files, added, deleted };
}

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const staged = !!args.staged;
  const stat = !!args.stat;
  const commit = args.commit ? String(args.commit) : null;
  const commit2 = args.commit2 ? String(args.commit2) : null;
  const maxLines = Math.min(Math.max(parseInt(args.maxLines, 10) || 400, 1), 5000);

  const target = ['diff'];
  if (staged) target.push('--cached');
  if (commit2) { target.push(commit || 'HEAD'); target.push(commit2); }
  else if (commit) target.push(commit);

  const paths = parsePaths(args.path);
  const textArgs = target.slice();
  if (stat) textArgs.push('--stat');
  if (paths.length) { textArgs.push('--'); textArgs.push.apply(textArgs, paths); }

  const numArgs = target.slice().concat(['--numstat']);
  if (paths.length) { numArgs.push('--'); numArgs.push.apply(numArgs, paths); }

  const rt = runGit(args, rp, textArgs, { allowFail: true });
  const rn = runGit(args, rp, numArgs, { allowFail: true });
  const parsed = parseNumstat(rn.stdout);

  // 描述比较对象
  let what;
  if (staged) what = '暂存区 ↔ HEAD';
  else if (commit2) what = (commit || 'HEAD') + ' ↔ ' + commit2;
  else if (commit) what = commit + ' ↔ 工作树';
  else what = '工作区 ↔ 暂存区';

  let body = rt.stdout;
  let truncated = false;
  if (!stat) {
    const lines = body.split('\n');
    if (lines.length > maxLines) {
      body = lines.slice(0, maxLines).join('\n');
      truncated = true;
    }
  }

  const L = [];
  L.push('▸ 差异: ' + what + (paths.length ? '  (路径: ' + paths.join(', ') + ')' : ''));
  L.push('  文件 ' + parsed.files.length + ' 个，+' + parsed.added + ' / -' + parsed.deleted +
    (stat ? '  [stat 模式]' : '') + (truncated ? '  [文本截断，仅显示前 ' + maxLines + ' 行]' : ''));
  if (stat && body.trim()) {
    L.push('');
    L.push(body.replace(/\n+$/, ''));
  } else if (!stat) {
    if (body.trim()) {
      L.push('');
      L.push(body.replace(/\n+$/, ''));
    } else {
      L.push('');
      L.push('  （无差异）');
    }
  }

  return {
    _text: L.join('\n'),
    repo: rp,
    mode: { staged, stat, commit, commit2, paths },
    fileCount: parsed.files.length,
    added: parsed.added,
    deleted: parsed.deleted,
    files: parsed.files,
    truncated
  };
}

module.exports = {
  name: 'gitx_diff',
  title: '差异比较（工作区/暂存区/两提交，stat 模式）',
  description:
    '比较差异。默认比较工作区与暂存区；staged=true 比较暂存区与 HEAD；' +
    'commit 单给则比较该提交到工作树，commit+commit2 则比较两提交。' +
    'stat=true 只返回增删统计（不看具体改动）。path 限定文件/目录。' +
    '非 stat 模式用 maxLines 限制纯文本输出行数（默认 400，超出截断+续读提示）。',
  inputSchema,
  run,
  parseNumstat,
  parsePaths
};
