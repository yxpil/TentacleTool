'use strict';
/**
 * gitx_remote —— 远程列表、URL、跟踪关系；可选 fetch（只拉取不改工作区）
 *
 * 一律用 `git -C <repoPath>`。
 */
const { isGitRepo, runGit, baseProps, truncate } = require('../utils/gitutil');

const inputSchema = {
  type: 'object',
  properties: Object.assign(baseProps(), {
    action: { type: 'string', enum: ['list', 'fetch'], description: '操作：list(默认)/fetch' },
    name: { type: 'string', description: 'fetch 时指定拉取某个远程（默认拉取所有远程）' }
  })
};

function listRemotes(args, rp) {
  const r = runGit(args, rp, ['remote', '-v'], { allowFail: true });
  const map = {};
  for (const raw of r.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const [_, name, url, kind] = m;
    if (!map[name]) map[name] = { name, fetch: null, push: null };
    map[name][kind] = url;
  }
  const remotes = Object.values(map);
  // 跟踪关系：本地分支 -> 上游
  const tr = runGit(args, rp, ['for-each-ref', '--format=%(refname:short) %(upstream:short)', 'refs/heads'], { allowFail: true });
  const tracking = [];
  for (const raw of tr.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    const sp = line.indexOf(' ');
    const branch = sp === -1 ? line : line.slice(0, sp);
    const upstream = sp === -1 ? '' : line.slice(sp + 1).trim();
    tracking.push({ branch, upstream: upstream || null });
  }
  return { remotes, tracking };
}

function run(args = {}) {
  const rp = isGitRepo(args, args.repoPath);
  const action = args.action || 'list';

  if (action === 'list') {
    const { remotes, tracking } = listRemotes(args, rp);
    const L = [];
    L.push('▸ 远程列表: ' + rp + '  (共 ' + remotes.length + ' 个)');
    L.push('');
    const rows = remotes.map(r => [r.name, r.fetch || '—', r.push || '—']);
    L.push(truncate(require('../utils/gitutil').table(['名称', 'Fetch URL', 'Push URL'], rows), 6000).text);
    L.push('');
    L.push('■ 跟踪关系（本地分支 → 上游）');
    if (!tracking.length) L.push('  （无本地分支或均未设置上游）');
    else for (const t of tracking) L.push('  ' + t.branch + '  →  ' + (t.upstream || '(无上游)'));
    return { _text: L.join('\n'), repo: rp, remotes, tracking };
  }

  if (action === 'fetch') {
    const target = args.name ? String(args.name) : null;
    const cmd = target ? ['fetch', target] : ['fetch'];
    const r = runGit(args, rp, cmd, { allowFail: true });
    const out = (r.stdout || r.stderr || '').trim();
    if (!r.ok) throw new Error('fetch 失败：' + out);
    const capped = truncate('▸ 已 fetch' + (target ? ' ' + target : ' 所有远程') + '\n' + out, 4000);
    return {
      _text: capped.text,
      truncated: capped.truncated,
      repo: rp, action: 'fetch', fetched: target || 'all', output: out
    };
  }

  throw new Error('未知 action: ' + action + '（应为 list/fetch）');
}

module.exports = {
  name: 'gitx_remote',
  title: '远程管理（列表/URL/跟踪/fetch）',
  description:
    '查看/拉取远程。action=list（默认）列出远程名称、fetch/push URL，以及本地分支到上游的跟踪关系；' +
    'action=fetch 拉取远程（只更新远端引用，不改工作区），name 可指定单个远程，默认拉取所有。',
  inputSchema,
  run,
  listRemotes
};
