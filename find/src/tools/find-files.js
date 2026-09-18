'use strict';
/**
 * find_files：按文件名/路径搜索本机文件（Everything 风格）
 *
 * 输出为省 token 的折叠式紧凑列表（每行：序号. 路径 (大小, 修改时间)），
 * 匹配过多时只显示前 limit 条，页脚给翻页与重建索引提示。
 */
const { getIndex, status } = require('../utils/indexer');
const { searchEntries } = require('../utils/matcher');
const { fmtSize, fmtTime, relTime } = require('../utils/format');

const MODES = ['sub', 'fuzzy', 'glob', 'regex'];

/** ext 参数归一化："js,.md" | ["js",".md"] → ["js","md"] */
function parseExt(v) {
  if (!v) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const set = arr.map(s => String(s).trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  return set.length ? set : null;
}

async function run(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    return '用法: find_files(query="文件名或关键词", mode="sub|fuzzy|glob|regex", ext="js,md", root="C:\\\\path", type="file|dir", limit=30, offset=0, refresh=false)\n'
      + '示例: find_files("mcp-server") / find_files("*.sln", mode="glob") / find_files("tntl", mode="fuzzy")';
  }
  const mode = MODES.includes(args.mode) ? args.mode : 'sub';
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 200);
  const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
  const type = args.type === 'file' || args.type === 'dir' ? args.type : null;
  const ext = parseExt(args.ext);
  const root = args.root ? String(args.root) : null;

  const index = await getIndex({ refresh: !!args.refresh });
  const { total, matches } = searchEntries(index.entries, { query, mode, root, ext, type });

  const lines = [];
  const head = [`mode=${mode}`];
  if (root) head.push(`root=${root}`);
  if (ext) head.push(`ext=${ext.join('/')}`);
  if (type) head.push(`type=${type}`);
  lines.push(`## find_files: "${query}" (${head.join(', ')})`);

  if (!total) {
    lines.push('');
    lines.push('没有匹配结果。可以尝试：');
    lines.push('- 改用模糊模式: find_files(query="' + query + '", mode="fuzzy")');
    lines.push('- 通配模式: find_files(query="*' + query + '*", mode="glob")');
    lines.push('- 放宽 ext / root / type 过滤条件');
    if (index.truncated) {
      lines.push('- 注意：索引已达条目上限（' + index.count + ' 条），目标若在被跳过的目录（AppData/系统目录/缓存目录等）将搜不到');
    }
  } else {
    const page = matches.slice(offset, offset + limit);
    lines.push('');
    lines.push(`共 ${total} 条匹配（显示 ${offset + 1}-${offset + page.length}）`);
    lines.push('');
    for (let i = 0; i < page.length; i++) {
      const m = page[i];
      const n = offset + i + 1;
      if (m.e.d) {
        lines.push(`${n}. ${m.e.p}\\  (${fmtTime(m.e.m)}, ${relTime(m.e.m)})`);
      } else {
        lines.push(`${n}. ${m.e.p}  (${fmtSize(m.e.s)}, ${fmtTime(m.e.m)})`);
      }
    }
  }

  // 页脚：索引状态 + 翻页/重建提示
  const st = status();
  lines.push('');
  if (st) {
    const engine = st.engine === 'native-c' ? '原生C' : 'JS';
    lines.push(`> 索引: ${st.count} 项（${engine} 引擎），构建于 ${fmtTime(st.builtAt)}（${relTime(st.builtAt)}，耗时 ${(st.tookMs / 1000).toFixed(1)}s）${st.truncated ? ' | 注意：已达条目上限，部分深/噪声目录未收录' : ''}`);
    lines.push('> 重建索引: refresh=true（AppData/系统目录等默认跳过，见 README）');
  }
  if (total > offset + limit) {
    const more = [`query="${query}"`, `offset=${offset + limit}`];
    if (mode !== 'sub') more.push(`mode="${mode}"`);
    if (root) more.push(`root="${root}"`);
    if (type) more.push(`type="${type}"`);
    lines.push(`> 翻页: find_files(${more.join(', ')})`);
  }
  return lines.join('\n');
}

module.exports = { run, parseExt };
