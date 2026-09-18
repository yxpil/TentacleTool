'use strict';
/**
 * 全局运行时：配置 + 连接池 + schema 缓存的单例持有者
 *
 * 工具模块通过这里拿资源，避免每个工具各自加载配置 / 各自建池。
 * 配置加载是懒加载的：没配好的环境里，服务器仍能启动并给出清晰的配置指引，
 * 而不是启动即崩（用户第一次跑最需要看到的是"该怎么配"）。
 */

const { loadConfig } = require('./config');
const { PoolManager } = require('../db/pool-manager');
const { SchemaCache } = require('./schema');
const logger = require('../utils/logger');

let state = {
  loaded: false,
  error: null,
  config: null,
  configPath: null,
  warnings: [],
  pools: null,
  schema: null
};

/**
 * 懒加载初始化
 * @param {boolean} force 强制重载配置（会重建连接池）
 */
function init(force = false) {
  if (state.loaded && !force) return state;
  if (state.loaded && force && state.pools) {
    state.pools.shutdown().catch(() => { });
  }
  try {
    const { config, path, warnings } = loadConfig();
    state.config = config;
    state.configPath = path;
    state.warnings = warnings || [];
    state.pools = new PoolManager(config);
    state.schema = new SchemaCache(state.pools);
    state.error = null;
    state.loaded = true;
    logger.log(`[runtime] 配置已加载: ${path} | sources=${Object.keys(config.sources).join(',')} ` +
      `| knowledgeBases=${Object.keys(config.knowledgeBases).join(',')}`);
  } catch (e) {
    // 配置缺失/非法不应该让整个服务器挂掉：记下来，让工具返回配置指引
    state.loaded = false;
    state.error = e;
    state.config = null;
    state.pools = null;
    state.schema = null;
    logger.error('[runtime] 配置加载失败', e);
  }
  return state;
}

/** 取运行时；未配置好则抛出一个带配置指引的错误 */
function require$() {
  const s = init(false);
  if (!s.loaded) {
    const e = new Error(
      '知识库尚未配置。\n\n' + (s.error ? s.error.message : '未知原因') +
      '\n\n可运行工具 kb_config 查看当前配置状态与示例。'
    );
    e.code = 'KB_NOT_CONFIGURED';
    throw e;
  }
  return s;
}

/** 取配置（不抛错，供 kb_config 等诊断工具使用） */
function peek() { return init(false); }

/** 强制重载配置 */
function reload() { return init(true); }

async function shutdown() {
  if (state.pools) {
    await state.pools.shutdown().catch(() => { });
  }
  state.pools = null;
  state.schema = null;
  state.loaded = false;
}

module.exports = { init, require: require$, peek, reload, shutdown, get state() { return state; } };
