'use strict';
/**
 * find_recent：列出最近修改的文件/目录
 *
 * 直接利用索引里的 mtime 排序（无需再扫盘），默认近 24 小时，
 * 可用 within 指定时间窗（"30m"/"2h"/"7d"/"4w" 或小时数）。
 */
const { getIndex, status } = require('../utils/indexer');
const { extOf, fmtSize, fmtTime, relTime, parseWithin } = require('../utils/format');
const { parseExt } = require('./find-files');

async function run(args = {}) {
  const withinMs = parseWithin(args.within);
  if (withinMs == null) {
    return 'within 参数无法解析: ' + args.within + '（支持 "30m" / "2h" / "7d" / "4w"，或纯数字按小时）';
  }
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 200);
  const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
  const type = args.type === 'file' || args.type === 'dir' ? args.type : null;
  const ext = parseExt(args.ext);
  const root = args.root ? String(args.root) : null;
  const rootLc = root ? root.replace(/[/\\]+$/, '').toLowerCase() : null;

  const index = await getIndex({ refresh: !!args.refresh });
  const cutoff = Date.now() - withinMs;

  const hits = [];
  for (let i = 0; i < index.entries.length; i++) {
    const e = index.entries[i];
    if (!e.m || e.m < cutoff) continue;
    if (type === 'file' && e.d) continue;
    if (type === 'dir' && !e.d) continue;
    if (ext && !ext.includes(extOf(e.p))) continue;
    if (rootLc) {
      const lp = e.p.toLowerCase();
      if (lp !== rootLc && !lp.startsWith(rootLc + '\\')) continue;
    }
    hits.push(e);
  }
  hits.sort((a, b) => b.m - a.m);

  const lines = [];
  const head = [`within=${args.within || '24h'}`];
  if (root) head.push(`root=${root}`);
  if (ext) head.push(`ext=${ext.join('/')}`);
  if (type) head.push(`type=${type}`);
  lines.push(`## find_recent (${head.join(', ')})`);

  if (!hits.length) {
    lines.push('');
    lines.push(`最近 ${humanWindow(withinMs)} 内没有符合条件的修改记录。`);
    lines.push('- 放宽时间窗: within="7d" 或 "4w"');
    lines.push('- 放宽 ext / root / type 过滤条件');
  } else {
    const page = hits.slice(offset, offset + limit);
    lines.push('');
    lines.push(`共 ${hits.length} 条（显示 ${offset + 1}-${offset + page.length}，按修改时间新→旧）`);
    lines.push('');
    for (let i = 0; i < page.length; i++) {
      const e = page[i];
      const n = offset + i + 1;
      if (e.d) {
        lines.push(`${n}. ${e.p}\\  (${fmtTime(e.m)}, ${relTime(e.m)})`);
      } else {
        lines.push(`${n}. ${e.p}  (${fmtSize(e.s)}, ${fmtTime(e.m)}, ${relTime(e.m)})`);
      }
    }
  }

  const st = status();
  lines.push('');
  if (st) {
    const engine = st.engine === 'native-c' ? '原生C' : 'JS';
    lines.push(`> 索引: ${st.count} 项（${engine} 引擎），构建于 ${fmtTime(st.builtAt)}（${relTime(st.builtAt)}）。mtime 取自索引时刻，索引之后的新改动需要 refresh=true`);
  }
  if (hits.length > offset + limit) {
    const more = [`within="${args.within || '24h'}"`, `offset=${offset + limit}`];
    if (root) more.push(`root="${root}"`);
    if (type) more.push(`type="${type}"`);
    lines.push(`> 翻页: find_recent(${more.join(', ')})`);
  }
  return lines.join('\n');
}

function humanWindow(ms) {
  const m = ms / 60000;
  if (m < 60) return Math.round(m) + ' 分钟';
  const h = m / 60;
  if (h < 48) return Math.round(h) + ' 小时';
  return Math.round(h / 24) + ' 天';
}

module.exports = { run };
