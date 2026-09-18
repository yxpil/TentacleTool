'use strict';
/**
 * find_tool：定位可执行工具（"AI 想调用某个工具，先找到它在哪"）
 *
 * 两级查找：
 *   1. PATH 扫描：按 PATHEXT 逐目录探测，命中即可直接调用（第一个 = 主命令）
 *   2. 全盘索引兜底：按文件名在索引里找 exe/bat/cmd/ps1 等（不在 PATH 的工具，如
 *      "Beyond Compare 4\\BCompare.exe"），需完整路径调用
 */
const fs = require('fs');
const path = require('path');
const { getIndex, status } = require('../utils/indexer');
const { searchEntries } = require('../utils/matcher');
const { extOf, fmtSize, fmtTime, relTime } = require('../utils/format');

const TOOL_EXTS = ['exe', 'bat', 'cmd', 'ps1', 'com', 'msc', 'lnk'];
const PATHEXTS_DEFAULT = ['.com', '.exe', '.bat', '.cmd', '.ps1', '.msc'];

function pathDirs() {
  return (process.env.PATH || '')
    .split(';')
    .map(s => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function resolveFirst(dir, nameWithExt) {
  const candidate = path.join(dir, nameWithExt);
  try {
    const real = fs.realpathSync(candidate);       // 顺带解析 8.3 短名/junction
    if (fs.statSync(real).isFile()) return real;
  } catch (e) { /* 不存在 */ }
  return null;
}

async function run(args = {}) {
  const name = String(args.name || '').trim();
  if (!name) {
    return '用法: find_tool(name="node") / find_tool(name="code", all=true)\n'
      + '返回可直接调用的绝对路径；PATH 命中在前，全盘索引兜底在后。';
  }
  if (/[/\\]/.test(name)) {
    return 'name 应为工具名（如 "node"），不要带路径。已知完整路径时无需查找。';
  }
  const wantAll = !!args.all;
  const hasExt = /\.(exe|bat|cmd|ps1|com|msc|lnk)$/i.test(name);
  const tryExts = hasExt ? [''] : PATHEXTS_DEFAULT;

  // 1) PATH 扫描
  const pathHits = [];
  const seen = new Set();
  outer:
  for (const dir of pathDirs()) {
    for (const ext of tryExts) {
      const real = resolveFirst(dir, name + ext);
      if (!real) continue;
      const key = real.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pathHits.push(real);
      if (!wantAll && pathHits.length >= 3) break outer;
    }
  }

  // 2) 索引兜底（只认文件名含查询词的可执行，避免"目录同名"噪声）
  let indexHits = [];
  try {
    const index = await getIndex();
    const { matches } = searchEntries(index.entries, { query: name, mode: 'sub' });
    indexHits = matches
      .filter(m => !m.e.d
        && TOOL_EXTS.includes(extOf(m.e.p))
        && path.basename(m.e.p).toLowerCase().includes(name.toLowerCase())
        && !seen.has(m.e.p.toLowerCase()))
      .map(m => m.e)
      .slice(0, wantAll ? 20 : 8);
  } catch (e) { /* 索引不可用则只报 PATH 结果 */ }

  // 渲染
  const lines = [];
  lines.push(`## find_tool: "${name}"`);
  lines.push('');
  if (!pathHits.length && !indexHits.length) {
    lines.push(`未找到 "${name}"。可以尝试：`);
    lines.push(`- 按文件名模糊找: find_files(query="${name}", mode="fuzzy")`);
    lines.push('- 确认拼写，或用通配: find_files(query="*' + name + '*.exe", mode="glob")');
  } else {
    if (pathHits.length) {
      lines.push('**PATH 中可用（可直接按名调用）:**');
      pathHits.forEach((p, i) => {
        lines.push(`${i + 1}. ${p}${i === 0 ? '  ← 主命令' : ''}`);
      });
    }
    if (indexHits.length) {
      if (pathHits.length) lines.push('');
      lines.push('**其他位置（全盘索引，需完整路径调用）:**');
      for (const e of indexHits) {
        lines.push(`- ${e.p}  (${fmtSize(e.s)}, ${fmtTime(e.m)})`);
      }
    }
  }
  const st = status();
  lines.push('');
  if (st) {
    const engine = st.engine === 'native-c' ? '原生C' : 'JS';
    lines.push(`> 索引: ${st.count} 项（${engine} 引擎），构建于 ${fmtTime(st.builtAt)}（${relTime(st.builtAt)}）`);
  }
  lines.push('> 建议: 脚本/命令中使用完整路径，避免 PATH 差异');
  return lines.join('\n');
}

module.exports = { run };
