'use strict';
/**
 * gitx_stash —— list / save / pop / apply / drop（可逆操作）
 *
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, baseProps, truncate } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    action: { type: 'string', enum: ['list', 'save', 'pop', 'apply', 'drop'], description: '操作：list(默认)/save/pop/apply/drop' },
    message: { type: 'string', description: 'save 时的说明（git stash push -m）' },
    index: { type: 'number', description: 'pop/apply/drop 的 stash 下标（默认 0，即 stash@{0}）' },
    includeUntracked: { type: 'boolean', description: 'save 时是否一并暂存未跟踪文件（git stash push -u）' }
  })
};

function stashRef(index) {
  if (typeof index === 'string' && /^stash@\{\d+\}$/.test(index)) return index;
  const i = parseInt(index, 10) || 0;
  return 'stash@{' + i + '}';
}

function listStash(args, rp) {
  const r = runGit(args, rp, ['stash', 'list'], { allowFail: true });
  const items = [];
  for (const raw of r.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    const m = line.match(/^stash@\{(\d+)\}:(.*)$/);
    if (m) items.push({ index: +m[1], ref: 'stash@{' + m[1] + '}', description: m[2].trim() });
  }
  return items;
}

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const action = args.action || 'list';
  const ref = stashRef(args.index);

  if (action === 'list') {
    const items = listStash(args, rp);
    const L = [];
    L.push('▸ Stash 列表: ' + rp + '  (共 ' + items.length + ' 条)');
    if (!items.length) L.push('  （无 stash）');
    else for (const it of items) L.push('  ' + it.ref + ': ' + it.description);
    return { _text: L.join('\n'), repo: rp, count: items.length, items };
  }

  if (action === 'save') {
    const cmd = ['stash', 'push'];
    if (args.message) cmd.push('-m', String(args.message));
    if (args.includeUntracked) cmd.push('-u');
    const r = runGit(args, rp, cmd, { allowFail: true });
    if (!r.ok) throw new Error('stash 保存失败：' + (r.stderr || r.stdout || '').trim());
    const items = listStash(args, rp);
    const msg = (r.stdout || r.stderr || '').trim();
    return {
      _text: '▸ 已保存 stash（' + (args.message || '无说明') + '）\n  ' + msg +
        '\n  现有 stash: ' + items.length + ' 条',
      repo: rp, action: 'save', message: args.message || null, items
    };
  }

  // pop / apply / drop 需要指定 ref
  const r = runGit(args, rp, ['stash', action, ref], { allowFail: true });
  if (!r.ok) throw new Error('stash ' + action + ' ' + ref + ' 失败：' + (r.stderr || '').trim());
  const items = listStash(args, rp);
  const msg = (r.stdout || r.stderr || '').trim();
  const L = [];
  L.push('▸ 已 ' + action + ' ' + ref + (action === 'drop' ? '（已删除该 stash）' : '') );
  L.push('  ' + msg);
  if (action !== 'drop') L.push('  剩余 stash: ' + items.length + ' 条');
  return {
    _text: L.join('\n'),
    repo: rp, action, ref, items
  };
}

module.exports = {
  name: 'gitx_stash',
  title: 'Stash 操作（list/save/pop/apply/drop）',
  description:
    'Git stash 管理（都是可逆操作）。action=list（默认）列出 stash；save 保存（message 说明，' +
    'includeUntracked 一并暂存未跟踪）；pop 弹出并应用后删除；apply 应用但保留；drop 删除。' +
    'pop/apply/drop 用 index 指定下标（默认 0 = stash@{0}）。',
  inputSchema,
  run,
  listStash,
  stashRef
};
