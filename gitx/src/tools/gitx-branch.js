'use strict';
/**
 * gitx_branch —— 列出/创建/切换/删除分支（含安全检查）
 *
 * ★ 安全检查：不能删当前分支；删除未合并分支需显式 force=true。
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, baseProps, truncate } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    action: { type: 'string', enum: ['list', 'create', 'switch', 'delete'], description: '操作：list(默认)/create/switch/delete' },
    name: { type: 'string', description: 'create/switch/delete 时的分支名' },
    force: { type: 'boolean', description: 'delete 时删除未合并分支需 force=true（git branch -D）' }
  })
};

function currentBranch(args, rp) {
  const r = runGit(args, rp, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  if (!r.ok) return null;
  const v = r.stdout.trim();
  return v === 'HEAD' ? null : v; // 分离 HEAD 时返回 HEAD
}

function listBranches(args, rp) {
  const r = runGit(args, rp, ['branch', '-vv'], { allowFail: true });
  const branches = [];
  let current = null;
  for (const raw of r.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    let isCur = false;
    let s = line;
    if (s[0] === '*') { isCur = true; s = s.slice(2); }
    else { s = s.slice(2); }
    const m = s.match(/^(\S+)\s*(?:\[([^\]]+)\])?\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    let upstream = null, ahead = 0, behind = 0;
    if (m[2]) {
      const info = m[2];
      const up = info.match(/^(\S+?)(?::\s*(.*))?$/);
      upstream = up ? up[1] : info;
      const tail = up ? up[2] : null;
      if (tail) {
        const a = tail.match(/ahead (\d+)/), b = tail.match(/behind (\d+)/);
        ahead = a ? +a[1] : 0;
        behind = b ? +b[1] : 0;
      }
    }
    branches.push({ name, current: isCur, upstream, ahead, behind, subject: m[3] || '' });
    if (isCur) current = name;
  }
  return { branches, current };
}

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const action = args.action || 'list';
  const name = args.name ? String(args.name).trim() : null;

  if (action === 'list') {
    const { branches, current } = listBranches(args, rp);
    const L = [];
    L.push('▸ 分支列表: ' + rp + '  (共 ' + branches.length + ' 个，当前 ' + (current || '(分离 HEAD)') + ')');
    L.push('');
    const rows = branches.map(b => [
      (b.current ? '* ' : '  ') + b.name,
      b.upstream || '—',
      (b.ahead || b.behind) ? ('↑' + b.ahead + ' ↓' + b.behind) : '—',
      b.subject
    ]);
    L.push(truncate(require('../utils/gitutil').table(['分支', '上游', '领先/落后', '最近提交'], rows), 6000).text);
    return { _text: L.join('\n'), repo: rp, current, branches };
  }

  if (!name) throw new Error('action=' + action + ' 需要提供 name（分支名）');

  if (action === 'create') {
    const r = runGit(args, rp, ['branch', name], { allowFail: true });
    if (!r.ok) throw new Error('创建分支失败：' + (r.stderr || '').trim());
    const { branches, current } = listBranches(args, rp);
    return {
      _text: '▸ 已创建分支: ' + name + '\n  当前仍停留在: ' + (current || '(分离 HEAD)') +
        '\n  切换过去: gitx_branch(action="switch", name="' + name + '")',
      repo: rp, action: 'create', name, branches
    };
  }

  if (action === 'switch') {
    const r = runGit(args, rp, ['switch', name], { allowFail: true });
    if (!r.ok) throw new Error('切换分支失败：' + (r.stderr || '').trim());
    const cur = currentBranch(args, rp);
    return {
      _text: '▸ 已切换到分支: ' + cur,
      repo: rp, action: 'switch', name, current: cur
    };
  }

  if (action === 'delete') {
    const cur = currentBranch(args, rp);
    if (name === cur) {
      throw new Error('不能删除当前所在的分支（' + cur + '）。请先切换到其它分支再删除。');
    }
    const force = !!args.force;
    const r = runGit(args, rp, ['branch', force ? '-D' : '-d', name], { allowFail: true });
    if (!r.ok) {
      const msg = (r.stderr || '').trim();
      if (!force && /not.*merged|not fully merged/i.test(msg)) {
        throw new Error('分支 ' + name + ' 含有未合并的提交，拒绝删除。若确认要删除，传 force=true（git branch -D）。\n  git 原信息: ' + msg);
      }
      throw new Error('删除分支失败：' + msg);
    }
    const { branches } = listBranches(args, rp);
    return {
      _text: '▸ 已删除分支: ' + name + (force ? '（强制 -D，含未合并提交）' : '') +
        '\n  剩余分支: ' + branches.map(b => b.name).join(', '),
      repo: rp, action: 'delete', name, force, branches
    };
  }

  throw new Error('未知 action: ' + action + '（应为 list/create/switch/delete）');
}

module.exports = {
  name: 'gitx_branch',
  title: '分支操作（list/create/switch/delete，含安全检查）',
  description:
    '分支管理。action=list（默认）列出分支、上游与领先/落后；create 创建分支；switch 切换分支；' +
    'delete 删除分支。★ 安全检查：不能删除当前分支；删除未合并分支必须显式 force=true（git branch -D），' +
    '否则用 -d 且未合并会拒绝。',
  inputSchema,
  run,
  listBranches,
  currentBranch
};
