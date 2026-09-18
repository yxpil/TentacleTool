'use strict';
/**
 * 连接池（极简实现：按需创建、串行复用、闲置回收）
 *
 * 为什么需要池：MCP 服务器是长驻进程，Agent 会连续发起多次查询。
 * 每次新建连接的握手 + 认证开销（尤其走 TLS 时）不必要；
 * 但也不能无限增长，所以设上限 + 闲置超时回收。
 *
 * 并发模型：本工具集的调用是"一问一答"，不做复杂调度。
 * 池满时排队（FIFO），而不是报错——Agent 侧表现为"稍微慢一点"。
 */

const { Connection } = require('./connection');

class Pool {
  /**
   * @param {object} cfg 连接配置（与 Connection 相同）
   * @param {object} opts { max: 4, idleTimeout: 60000 }
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.max = opts.max || 4;
    this.idleTimeout = opts.idleTimeout || 60000;
    this.idle = [];            // 空闲连接
    this.all = new Set();      // 所有活连接（用于 shutdown）
    this.waiters = [];         // 等待连接的 Promise resolver
    this.closed = false;
    this.stats = { created: 0, reused: 0, timedOut: 0, errors: 0 };
    this._reaper = setInterval(() => this._reap(), 15000);
    this._reaper.unref && this._reaper.unref();
  }

  get size() { return this.all.size; }
  get idleCount() { return this.idle.length; }
  get waitingCount() { return this.waiters.length; }

  /** 借一个连接；返回 { conn, release } */
  async acquire() {
    if (this.closed) throw new Error('连接池已关闭');

    // 1. 复用空闲连接（优先取最久未用的，避免有的连接一直闲着）
    while (this.idle.length) {
      const entry = this.idle.shift();
      if (entry.conn.destroyed) { this.all.delete(entry.conn); continue; }
      clearTimeout(entry.timer);
      // 轻量探活已经在 _reap 里做过；这里直接复用
      this.stats.reused++;
      return { conn: entry.conn, release: () => this.release(entry.conn) };
    }

    // 2. 未达上限则新建
    if (this.all.size < this.max) {
      const conn = new Connection(this.cfg);
      this.all.add(conn);
      try {
        await conn.connect();
        this.stats.created++;
      } catch (e) {
        this.all.delete(conn);
        conn._forceDestroy();
        throw e;
      }
      return { conn, release: () => this.release(conn) };
    }

    // 3. 池满 → 排队等待
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.stats.timedOut++;
        const i = this.waiters.findIndex(w => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('等待数据库连接超时（连接池已满）'));
      }, this.cfg.queryTimeout || 30000);
      t.unref && t.unref();
      this.waiters.push({
        resolve: (conn) => {
          clearTimeout(t);
          resolve({ conn, release: () => this.release(conn) });
        },
        reject
      });
    });
  }

  /** 归还连接 */
  release(conn) {
    if (!conn || conn.destroyed) {
      if (conn) this.all.delete(conn);
      this._dispatch();
      return;
    }
    // 有人在等就直接交接，避免多余的中转
    if (this.waiters.length) {
      const w = this.waiters.shift();
      w.resolve(conn);
      return;
    }
    if (this.closed) { this._destroy(conn); return; }

    const entry = { conn, timer: null };
    entry.timer = setTimeout(() => {
      const i = this.idle.indexOf(entry);
      if (i >= 0) this.idle.splice(i, 1);
      this._destroy(conn);
    }, this.idleTimeout);
    entry.timer.unref && entry.timer.unref();
    this.idle.push(entry);
  }

  /** 有连接被销毁时，让排队者有机会新建 */
  _dispatch() {
    if (!this.waiters.length) return;
    if (this.all.size < this.max) {
      const w = this.waiters.shift();
      const conn = new Connection(this.cfg);
      this.all.add(conn);
      conn.connect()
        .then(() => { this.stats.created++; w.resolve(conn); })
        .catch((e) => { this.all.delete(conn); conn._forceDestroy(); w.reject(e); this._dispatch(); });
    }
  }

  _destroy(conn) {
    conn._forceDestroy();
    this.all.delete(conn);
  }

  /** 闲置连接回收 + 探活 */
  _reap() {
    const now = Date.now();
    const survivors = [];
    for (const entry of this.idle) {
      if (entry.deadline && now > entry.deadline) { this._destroy(entry.conn); continue; }
      survivors.push(entry);
    }
    this.idle = survivors;
  }

  /** 用连接执行一个异步任务，自动归还 */
  async with(fn) {
    const { conn, release } = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      release();
    }
  }

  /** 执行查询（带一次重试：连接被服务器掐断时换连接重试） */
  async query(sourceOrSql, sqlOrOpts, maybeOpts) {
    // 支持两种签名：
    //   pool.query(sql, opts)
    //   pool.query(sourceName, sql, opts)   → 由 PoolManager 使用
    let sql, opts;
    if (typeof sqlOrOpts === 'string') { sql = sqlOrOpts; opts = maybeOpts || {}; }
    else { sql = sourceOrSql; opts = sqlOrOpts || {}; }
    try {
      return await this.with((conn) => conn.query(sql, opts));
    } catch (e) {
      // 服务器主动断开的连接不可复用；清掉池里的死连接后重试一次
      if (e && e.name === 'MySqlConnectionError' && !opts._retried) {
        this._purgeDead();
        this.stats.errors++;
        return await this.query(sql, Object.assign({}, opts, { _retried: true }));
      }
      if (e && e.name === 'MySqlError') this.stats.errors++;
      throw e;
    }
  }

  _purgeDead() {
    for (const c of Array.from(this.all)) {
      if (c.destroyed) this.all.delete(c);
    }
    this.idle = this.idle.filter((e) => {
      if (e.conn.destroyed) { clearTimeout(e.timer); return false; }
      return true;
    });
  }

  async shutdown() {
    this.closed = true;
    clearInterval(this._reaper);
    for (const w of this.waiters) {
      w.reject(new Error('连接池已关闭'));
    }
    this.waiters = [];
    for (const entry of this.idle) clearTimeout(entry.timer);
    this.idle = [];
    const conns = Array.from(this.all);
    this.all.clear();
    await Promise.all(conns.map(c => c.close().catch(() => { })));
  }
}

module.exports = { Pool };
