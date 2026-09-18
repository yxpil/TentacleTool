'use strict';
/**
 * 图缓存：把建好的图存到磁盘，避免每次调用都重新扫全仓。
 *
 * 缓存策略（够用就好，不做复杂的增量）：
 *   - key = 目标根目录 + 关键参数 的哈希
 *   - 存 <root>/.analyze-cache/graph.json
 *   - 带 TTL（默认 10 分钟）；过期就重建
 *   - 显式传 refresh:true 可强制重建
 *
 * 为什么不做文件级增量失效：图谱是整体关系，局部改动也可能影响
 * 跨文件边的解析结果（比如新增一个同名导出会抢走旧边）。
 * 全量重建在万行级项目只要几百毫秒，比维护增量一致性划算得多。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Graph } = require('./graph');
const { buildGraph } = require('./builder');

const CACHE_DIR_NAME = '.analyze-cache';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 内存缓存：同一进程内多次调用直接复用，连磁盘都不用读 */
const memory = new Map();

function cacheKey(root, opts) {
  const shape = JSON.stringify({
    root: path.resolve(root),
    skipDirs: (opts.skipDirs || []).slice().sort(),
    include: opts.include || null,
    exclude: opts.exclude || null,
    maxFiles: opts.maxFiles || null
  });
  return crypto.createHash('sha1').update(shape).digest('hex').slice(0, 16);
}

function cacheFile(root, key) {
  return path.join(root, CACHE_DIR_NAME, 'graph-' + key + '.json');
}

/**
 * 取图：优先内存 → 磁盘 → 重建
 * @param {string} root
 * @param {object} opts  { refresh, ttl, maxFiles, include, exclude, skipDirs, quiet }
 * @returns {{ graph: Graph, from: 'memory'|'disk'|'build', ms: number }}
 */
function loadGraph(root, opts = {}) {
  const resolved = path.resolve(root);
  const key = cacheKey(resolved, opts);
  const ttl = typeof opts.ttl === 'number' ? opts.ttl : DEFAULT_TTL_MS;
  const t0 = Date.now();

  // 1) 内存
  if (!opts.refresh) {
    const hit = memory.get(key);
    if (hit && (Date.now() - hit.at) < ttl) {
      return { graph: hit.graph, from: 'memory', ms: Date.now() - t0 };
    }
  }

  // 2) 磁盘
  const cf = cacheFile(resolved, key);
  if (!opts.refresh) {
    try {
      const st = fs.statSync(cf);
      if ((Date.now() - st.mtimeMs) < ttl) {
        const obj = JSON.parse(fs.readFileSync(cf, 'utf8'));
        const graph = Graph.fromJSON(obj);
        memory.set(key, { graph, at: Date.now() });
        return { graph, from: 'disk', ms: Date.now() - t0 };
      }
    } catch {
      // 缓存损坏/不存在 → 走重建
    }
  }

  // 3) 重建
  const graph = buildGraph(resolved, {
    maxFiles: opts.maxFiles,
    include: opts.include,
    exclude: opts.exclude,
    // 注意：skipDirs 一定要兜底成空数组，buildGraph 内部会与默认跳过表合并
    skipDirs: opts.skipDirs || []
  });
  memory.set(key, { graph, at: Date.now() });

  // 落盘（失败不影响主流程——可能是只读目录）
  try {
    fs.mkdirSync(path.dirname(cf), { recursive: true });
    fs.writeFileSync(cf, JSON.stringify(graph.toJSON()), 'utf8');
  } catch {
    // 忽略：磁盘缓存只是加速，不是必需品
  }
  return { graph, from: 'build', ms: Date.now() - t0 };
}

/** 清掉某个根目录的内存缓存（refresh 用） */
function clearMemory(root, opts = {}) {
  const key = cacheKey(path.resolve(root), opts);
  memory.delete(key);
  return key;
}

/** 删除磁盘缓存文件 */
function clearDiskCache(root) {
  const dir = path.join(path.resolve(root), CACHE_DIR_NAME);
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('graph-') && f.endsWith('.json')) {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      }
    }
  } catch {
    // 目录不存在就算了
  }
  return removed;
}

module.exports = { loadGraph, clearMemory, clearDiskCache, cacheKey, CACHE_DIR_NAME };
