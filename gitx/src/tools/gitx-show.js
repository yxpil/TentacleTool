'use strict';
/**
 * gitx_show —— 查看某提交详情，或某文件在某提交时的内容
 *
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, baseProps, truncate } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    ref: { type: 'string', description: '提交/分支/标签引用（默认 HEAD）' },
    path: { type: 'string', description: '若给定，则显示该文件在此引用时的内容（git show <ref>:<path>）' },
    maxLines: { type: 'number', description: '显示文件内容或提交 diff 时的最大行数（默认 200，超出截断）' }
  })
};

const MAX_CONTENT_BYTES = 200 * 1024;

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const ref = args.ref ? String(args.ref) : 'HEAD';
  const maxLines = Math.min(Math.max(parseInt(args.maxLines, 10) || 200, 1), 5000);

  if (args.path) {
    const p = String(args.path);
    const sizeR = runGit(args, rp, ['cat-file', '-s', ref + ':' + p], { allowFail: true });
    const size = sizeR.ok ? parseInt((sizeR.stdout || '').trim(), 10) : 0;
    if (!sizeR.ok || isNaN(size)) {
      throw new Error('找不到该路径在该引用下的版本：' + ref + ':' + p);
    }
    if (size > MAX_CONTENT_BYTES) {
      return {
        _text: '▸ 文件: ' + p + ' @ ' + ref + '\n  大小 ' + size + ' 字节，超过 ' + MAX_CONTENT_BYTES +
          ' 字节上限，不在此回显（可用 repoPath 配合你的编辑器查看）。',
        repo: rp,
        type: 'file',
        ref,
        path: p,
        size,
        binary: null,
        truncated: false,
        content: null
      };
    }
    const contentR = runGit(args, rp, ['show', ref + ':' + p], { allowFail: true });
    let content = contentR.stdout;
    if (!contentR.ok) throw new Error('读取文件内容失败：' + (contentR.stderr || '').trim());
    let truncated = false;
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      content = lines.slice(0, maxLines).join('\n');
      truncated = true;
    }
    const L = [];
    L.push('▸ 文件: ' + p + ' @ ' + ref + '  (' + size + ' 字节' +
      (truncated ? '，仅显示前 ' + maxLines + ' 行' : '') + ')');
    L.push('');
    L.push(content.replace(/\n+$/, ''));
    return {
      _text: L.join('\n'),
      repo: rp,
      type: 'file',
      ref,
      path: p,
      size,
      binary: false,
      truncated,
      content
    };
  }

  // 提交详情
  const headR = runGit(args, rp, ['show', '--numstat', '--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e', '--date=short', ref], { allowFail: true });
  if (!headR.ok) throw new Error('找不到该引用：' + ref);
  // 解析头 + 文件统计
  const headLine = headR.stdout.split('\n').find(l => /^[0-9a-f]{7,40}\x1f/.test(l.replace(/\x1e$/, '')));
  let meta = null, files = [], added = 0, deleted = 0;
  if (headLine) {
    const parts = headLine.replace(/\x1e$/, '').split('\x1f');
    meta = { hash: parts[0], shortHash: parts[0].slice(0, 7), author: parts[1], email: parts[2], date: parts[3], subject: parts.slice(4).join('\x1f') };
  }
  for (const raw of headR.stdout.split('\n')) {
    const m = raw.replace(/\r$/, '').match(/^([-0-9]+)\t([-0-9]+)\t(.*)$/);
    if (m) {
      const a = m[1] === '-' ? null : parseInt(m[1], 10);
      const d = m[2] === '-' ? null : parseInt(m[2], 10);
      files.push({ path: m[3], added: a, deleted: d });
      if (a != null) added += a;
      if (d != null) deleted += d;
    }
  }
  // 完整 diff 文本（截断）
  const fullR = runGit(args, rp, ['show', ref], { allowFail: true });
  let body = fullR.ok ? fullR.stdout : '';
  const lines = body.split('\n');
  let truncated = false;
  if (lines.length > maxLines) { body = lines.slice(0, maxLines).join('\n'); truncated = true; }

  const L = [];
  L.push('▸ 提交: ' + (meta ? meta.shortHash : ref));
  if (meta) {
    L.push('  作者: ' + meta.author + ' <' + meta.email + '>');
    L.push('  日期: ' + meta.date);
    L.push('  主题: ' + meta.subject);
  }
  L.push('  改动: ' + files.length + ' 个文件，+' + added + ' / -' + deleted);
  L.push('');
  L.push(body.replace(/\n+$/, ''));

  return {
    _text: L.join('\n'),
    repo: rp,
    type: 'commit',
    ref,
    commit: meta ? Object.assign(meta, { added, deleted, files }) : null,
    files,
    added,
    deleted,
    truncated
  };
}

module.exports = { name: 'gitx_show', title: '查看提交详情 / 文件历史内容', description:
    '查看某引用（提交/分支/标签，默认 HEAD）的详情与 diff；或给定 path 时，' +
    '显示该文件在此引用时的内容（git show <ref>:<path>）。大文件（>200KB）只报告大小不回显；' +
    '文本用 maxLines 限制行数（默认 200）。', inputSchema, run };
