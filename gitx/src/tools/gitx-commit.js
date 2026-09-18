'use strict';
/**
 * gitx_commit —— 提交已暂存内容（必须显式 message；可选 addAll 先暂存全部）
 *
 * ★ 刻意不做 push / force push / reset --hard / clean -fdx / rebase —— 这些交给用户在终端。
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, baseProps } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    message: { type: 'string', description: '提交说明（必填，必须显式提供）' },
    addAll: { type: 'boolean', description: '提交前先用 git add -A 暂存全部改动（默认 false，仅提交已暂存内容）' }
  })
};

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const message = args.message ? String(args.message) : null;
  if (!message || !message.trim()) {
    throw new Error('提交必须显式提供 message（提交说明）。');
  }

  if (args.addAll) {
    const ar = runGit(args, rp, ['add', '-A'], { allowFail: true });
    if (!ar.ok) throw new Error('git add -A 失败：' + (ar.stderr || '').trim());
  }

  const cr = runGit(args, rp, ['commit', '-m', message], { allowFail: true });
  if (!cr.ok) {
    const msg = (cr.stderr || cr.stdout || '').trim();
    if (/nothing to commit/i.test(msg)) {
      throw new Error('没有可提交的内容（工作区与暂存区无改动，或 addAll=false 且暂存区为空）。');
    }
    throw new Error('提交失败：' + msg);
  }

  const h = runGit(args, rp, ['rev-parse', 'HEAD'], { allowFail: true });
  const hash = h.ok ? h.stdout.trim() : null;
  const br = runGit(args, rp, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  const branch = br.ok ? br.stdout.trim() : null;

  const L = [];
  L.push('▸ 已提交' + (branch ? ' 到分支 ' + branch : '') + (args.addAll ? '（已先 add -A）' : ''));
  L.push('  提交: ' + (hash ? hash.slice(0, 7) : '?'));
  L.push('  说明: ' + message);
  if (hash) {
    L.push('  查看改动: gitx_show(ref="' + (hash ? hash.slice(0, 7) : 'HEAD') + '")');
  }

  return {
    _text: L.join('\n'),
    repo: rp,
    hash,
    shortHash: hash ? hash.slice(0, 7) : null,
    message,
    branch,
    addAll: !!args.addAll
  };
}

module.exports = {
  name: 'gitx_commit',
  title: '提交已暂存内容（需 message，可选 addAll）',
  description:
    '提交已暂存内容。message 必填（必须显式提供，不能为空）；addAll=true 时先 git add -A 暂存全部改动。' +
    '返回新提交哈希、所在分支。★ 本工具只做本地提交，不做 push / force push / reset --hard / rebase 等改写历史或远端操作。',
  inputSchema,
  run
};
