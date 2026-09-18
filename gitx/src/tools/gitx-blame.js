'use strict';
/**
 * gitx_blame —— 逐行归属
 *
 * 文件 + 可选行范围，输出 行号/提交/作者/日期/内容。
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, baseProps, truncate } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    path: { type: 'string', description: '要 blame 的文件路径（相对于仓库，必填）' },
    startLine: { type: 'number', description: '起始行（含），与 endLine 一起限定范围' },
    endLine: { type: 'number', description: '结束行（含）' },
    ref: { type: 'string', description: '从哪个提交/分支开始 blame（默认工作区当前内容）' },
    maxLines: { type: 'number', description: '未指定行范围时，纯文本与结构化最多返回的行数（默认 1000，超出截断）' }
  })
};

/** 解析 git blame --line-porcelain 输出 */
function parseBlame(text) {
  const lines = text.split('\n');
  const entries = [];
  let h = null;
  let remaining = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const hm = line.match(/^(\^?)([0-9a-f]{7,40})(?:\s+[0-9a-f]{7,40})?\s+(\d+)\s+(\d+)\s+(\d+)$/);
    if (hm) {
      h = {
        hash: hm[2], boundary: hm[1] === '^',
        origLine: +hm[3], finalLine: +hm[4], numLines: +hm[5],
        author: '', mail: '', time: 0, tz: '', summary: ''
      };
      remaining = +hm[5];
      continue;
    }
    if (h && line.startsWith('\t')) {
      entries.push({
        line: h.finalLine,
        hash: h.hash,
        shortHash: h.hash.slice(0, 7),
        author: h.author,
        date: h.time ? new Date(h.time * 1000).toISOString().slice(0, 10) : '',
        summary: h.summary,
        content: line.slice(1)
      });
      remaining--;
      if (remaining <= 0) h = null;
      continue;
    }
    if (h) {
      if (line.startsWith('author ')) h.author = line.slice(7);
      else if (line.startsWith('author-mail ')) h.mail = line.slice(12);
      else if (line.startsWith('author-time ')) h.time = +line.slice(12);
      else if (line.startsWith('author-tz ')) h.tz = line.slice(10);
      else if (line.startsWith('summary ')) h.summary = line.slice(8);
      // 忽略 committer-* / filename / previous / boundary 等
    }
  }
  return entries;
}

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const p = String(args.path || '').trim();
  if (!p) throw new Error('需要提供 path（要 blame 的文件路径）');
  const ref = args.ref ? String(args.ref) : null;
  const maxLines = Math.min(Math.max(parseInt(args.maxLines, 10) || 1000, 1), 10000);

  const blameArgs = ['blame', '--line-porcelain'];
  if (args.startLine && args.endLine) {
    blameArgs.push('-L', String(args.startLine) + ',' + String(args.endLine));
  }
  if (ref) blameArgs.push(ref);
  blameArgs.push('--', p);

  const r = runGit(args, rp, blameArgs, { allowFail: true });
  if (!r.ok) throw new Error('blame 失败：' + (r.stderr || '').trim());

  let entries = parseBlame(r.stdout);
  let truncated = false;
  if (!args.startLine && entries.length > maxLines) {
    entries = entries.slice(0, maxLines);
    truncated = true;
  }

  const L = [];
  L.push('▸ blame: ' + p + (ref ? ' @ ' + ref : '') +
    (args.startLine && args.endLine ? '  (行 ' + args.startLine + '-' + args.endLine + ')' : '') +
    (truncated ? '  [仅前 ' + maxLines + ' 行]' : ''));
  L.push('  行号  提交      作者            日期          内容');
  L.push('  ----  --------  ---------------  ----------  -----');
  for (const e of entries) {
    L.push(
      '  ' + String(e.line).padEnd(4) + '  ' +
      e.shortHash + '  ' +
      (e.author || '').padEnd(15) + '  ' +
      e.date + '  ' +
      e.content
    );
  }

  return {
    _text: L.join('\n'),
    repo: rp,
    path: p,
    ref,
    truncated,
    count: entries.length,
    lines: entries
  };
}

module.exports = {
  name: 'gitx_blame',
  title: '逐行归属（行号/提交/作者/日期/内容）',
  description:
    '对文件逐行 blame，输出每行：行号 / 提交短哈希 / 作者 / 日期 / 内容。' +
    'path 必填；startLine+endLine 限定行范围；ref 指定从哪个提交开始。' +
    '未指定行范围时最多返回 maxLines 行（默认 1000）。',
  inputSchema,
  run,
  parseBlame
};
