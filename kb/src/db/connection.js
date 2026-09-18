'use strict';
/**
 * MySQL 连接（零依赖，Node net socket 上实现的 MySQL 客户端协议）
 *
 * 实现范围：
 *  - 握手包解析（协议版本 / 服务器版本 / 连接 id / salt / capability）
 *  - 认证：mysql_native_password、caching_sha2_password（含 fast-auth 与明文回退）
 *  - COM_QUERY 文本协议：结果集 / OK 包 / ERR 包
 *  - COM_PING、COM_QUIT
 *  - 可选 TLS（服务器支持 SSL 且未禁用时）
 *
 * 刻意不做的事（本工具集用不到，做了只是风险）：
 *  - 预处理语句（binary protocol）
 *  - 多结果集（SERVER_MORE_RESULTS_EXISTS 直接忽略）
 *  - 本地 infile、压缩协议、多语句
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { Reader, Writer, readPacket, writePackets } = require('./protocol');
const { decodeValue, parseColumnDefinition } = require('./types');

/* ======================== capability 常量 ======================== */

const CLIENT = {
  LONG_PASSWORD: 0x00000001,
  FOUND_ROWS: 0x00000002,
  LONG_FLAG: 0x00000004,
  CONNECT_WITH_DB: 0x00000008,
  PROTOCOL_41: 0x00000200,
  INTERACTIVE: 0x00000400,
  SSL: 0x00000800,
  TRANSACTIONS: 0x00002000,
  SECURE_CONNECTION: 0x00008000,
  MULTI_STATEMENTS: 0x00010000,
  MULTI_RESULTS: 0x00020000,
  PS_MULTI_RESULTS: 0x00040000,
  PLUGIN_AUTH: 0x00080000,
  CONNECT_ATTRS: 0x00100000,
  PLUGIN_AUTH_LENENC_CLIENT_DATA: 0x00200000,
  DEPRECATE_EOF: 0x01000000
};

const SERVER = {
  MORE_RESULTS: 0x0008,
  PROTOCOL_41: 0x0200,
  SSL: 0x0800,
  PLUGIN_AUTH: 0x00080000
};

const STATUS = { MORE_RESULTS: 0x0008 };

/* ======================== 错误 ======================== */

/** MySQL 服务器返回的 ERR 包，保留 errno 方便上层判分支 */
class MySqlError extends Error {
  constructor(code, message, sqlState, sql) {
    super(message);
    this.name = 'MySqlError';
    this.code = code;             // 数字错误码，如 1045（Access denied）
    this.sqlState = sqlState || null;
    this.sql = sql || null;
    this.isMySqlError = true;
  }
}

/** 协议/网络层的错误，与"服务器明确报错"区分开 */
class MySqlProtocolError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'MySqlProtocolError';
    this.detail = detail;
  }
}

/* ======================== 认证算法 ======================== */

/**
 * mysql_native_password
 * SHA1(password) XOR SHA1( salt + SHA1(SHA1(password)) )
 */
function scrambleNative(password, salt) {
  const pw = Buffer.from(password, 'utf8');
  if (pw.length === 0) return Buffer.alloc(0);
  const h1 = crypto.createHash('sha1').update(pw).digest();
  const h2 = crypto.createHash('sha1').update(h1).digest();
  const mixed = crypto.createHash('sha1').update(Buffer.concat([salt, h2])).digest();
  const out = Buffer.alloc(h1.length);
  for (let i = 0; i < h1.length; i++) out[i] = h1[i] ^ mixed[i];
  return out;
}

/**
 * caching_sha2_password（MySQL 8 默认）
 * XOR(SHA256(password), SHA256( SHA256(SHA256(password)) + salt ))
 */
function scrambleSha2(password, salt) {
  const pw = Buffer.from(password, 'utf8');
  if (pw.length === 0) return Buffer.alloc(0);
  const h1 = crypto.createHash('sha256').update(pw).digest();
  const h2 = crypto.createHash('sha256').update(h1).digest();
  const h3 = crypto.createHash('sha256').update(Buffer.concat([h2, salt])).digest();
  const out = Buffer.alloc(h1.length);
  for (let i = 0; i < h1.length; i++) out[i] = h1[i] ^ h3[i];
  return out;
}

/* ======================== 连接 ======================== */

class Connection {
  /**
   * @param {object} cfg
   *   host, port, user, password, database, charset,
   *   connectTimeout, queryTimeout, ssl (false | true | {rejectUnauthorized}),
   *   dateStrings, bigIntAsString
   */
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database: undefined,
      charset: 'utf8mb4',
      connectTimeout: 10000,
      queryTimeout: 30000,
      ssl: false,
      dateStrings: true,      // 默认给字符串，避免时区/格式歧义
      bigIntAsString: true
    }, cfg);

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.seq = 0;
    this.threadId = null;
    this.serverVersion = null;
    this.serverCapabilities = 0;
    this.connected = false;
    this.destroyed = false;
    this._pending = null;       // 当前等待中的请求 { resolve, reject, timer }
    this._closing = false;

    this.capabilities = 0;
    this.connectionId = Connection._nextId++;
  }

  get state() {
    if (this.destroyed) return 'destroyed';
    if (this.connected) return 'connected';
    return 'idle';
  }

  /* ---------- 连接建立 ---------- */

  connect() {
    return new Promise((resolve, reject) => {
      const { host, port, connectTimeout } = this.cfg;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { this._forceDestroy(); reject(err); }
        else resolve(this);
      };
      const timer = setTimeout(() => {
        done(this._netError(`连接 ${host}:${port} 超时（${connectTimeout}ms）`));
      }, connectTimeout);
      timer.unref && timer.unref();

      const sock = net.connect({ host, port });
      this.socket = sock;
      sock.setNoDelay(true);

      sock.on('connect', () => {
        this._readHandshake().then(() => {
          if (this.cfg.ssl && (this.serverCapabilities & SERVER.SSL) && this._sslUpgraded !== false) {
            this._upgradeTls().then(() => this._sendAuth()).then(() => done()).catch(done);
          } else {
            this._sendAuth().then(() => done()).catch(done);
          }
        }).catch(done);
      });

      sock.on('error', (e) => {
        if (this._pending) {
          const p = this._pending; this._pending = null;
          clearTimeout(p.timer);
          p.reject(this._netError(e.message, e));
        }
        done(this._netError(e.message, e));
      });

      sock.on('close', () => {
        this.connected = false;
        this.destroyed = true;
        sock.removeAllListeners('data');
        this.buffer = Buffer.alloc(0);
        if (this._pending) {
          const p = this._pending; this._pending = null;
          clearTimeout(p.timer);
          p.reject(this._netError('连接被服务器关闭（查询进行中）'));
        }
      });

      sock.on('data', (chunk) => this._onData(chunk));
    });
  }

  _netError(message, cause) {
    const e = new Error(message);
    e.name = 'MySqlConnectionError';
    if (cause) e.cause = cause;
    return e;
  }

  /* ---------- 读握手包 ---------- */

  _readHandshake() {
    return new Promise((resolve, reject) => {
      const onFirst = () => {
        try {
          const { payload } = readPacket(this.buffer);
          const r = new Reader(payload);
          const protocolVersion = r.u8();
          if (protocolVersion === 0xff) {
            return reject(this._parseErr(r, null));
          }
          if (protocolVersion !== 10) {
            return reject(new MySqlProtocolError('不支持的 MySQL 协议版本: ' + protocolVersion));
          }

          this.serverVersion = r.nulStr('latin1');
          this.threadId = r.u32();

          // auth-plugin-data-part-1（8 字节）
          const salt1 = r.bytes(8);
          r.u8();                                  // filler
          const capLow = r.u16();

          let salt2 = Buffer.alloc(0);
          let capHigh = 0;
          let authPlugin = 'mysql_native_password';

          if (r.remaining > 0) {
            const charsetId = r.u8();
            this.serverCharset = charsetId;
            r.u16();                               // status flags
            capHigh = r.u16();
            const capLen = r.u8();
            r.skip(10);                            // reserved
            if (capLen > 0) {
              // auth-plugin-data-part-2（最少 13 字节，末尾 \0 不算 salt）
              const part2len = Math.max(13, capLen - 8);
              const avail = Math.min(part2len, r.remaining);
              salt2 = r.bytes(avail);
            }
            if (this.serverCapabilities & SERVER.PLUGIN_AUTH && r.remaining > 0) {
              authPlugin = r.nulStr('latin1') || authPlugin;
            }
          }

          this.serverCapabilities = capLow | (capHigh << 16);
          // salt 去掉结尾的 \0
          let saltFull = Buffer.concat([salt1, salt2]);
          while (saltFull.length > 0 && saltFull[saltFull.length - 1] === 0) {
            saltFull = saltFull.slice(0, -1);
          }
          this.salt = saltFull.slice(0, 20);
          this.authPlugin = authPlugin;

          clearTimeout(this._hsTimer);
          resolve();
        } catch (e) { reject(e); }
      };

      this._hsTimer = setTimeout(() => {
        reject(this._netError('等待 MySQL 握手包超时'));
      }, this.cfg.connectTimeout);
      this._hsTimer.unref && this._hsTimer.unref();

      const waitData = () => {
        if (this.buffer.length >= 4) {
          const len = this.buffer.readUIntLE(0, 3);
          if (this.buffer.length >= 4 + len) { onFirst(); return; }
        }
        const h = (chunk) => {
          this._removeDataHandler(h);
          this._onHandshakeData = null;
          if (this.buffer.length >= 4) {
            const len = this.buffer.readUIntLE(0, 3);
            if (this.buffer.length >= 4 + len) { onFirst(); return; }
          }
          // 还不够一个完整包，继续等
          const again = (c2) => {
            this._removeDataHandler(again);
            this._onHandshakeData = null;
            if (this.buffer.length >= 4) {
              const l2 = this.buffer.readUIntLE(0, 3);
              if (this.buffer.length >= 4 + l2) { onFirst(); return; }
            }
            waitData();
          };
          this._onHandshakeData = again;
          this.socket.on('data', again);
        };
        this._onHandshakeData = h;
        this.socket.on('data', h);
      };

      // 握手数据可能已随首个 data 事件到达（_onData 已在累积到 this.buffer）
      waitData();
    });
  }

  /** 临时摘掉握手阶段的数据监听，避免和命令阶段的解析器打架 */
  _removeDataHandler(h) {
    if (this.socket && h) this.socket.removeListener('data', h);
  }

  /* ---------- TLS 升级 ---------- */

  _upgradeTls() {
    return new Promise((resolve, reject) => {
      const sslOpts = typeof this.cfg.ssl === 'object' ? this.cfg.ssl : {};
      // SSL_REQUEST 包：capability 4 字节 + max packet 4 字节 + charset 1 字节 + 23 字节填充
      const w = new Writer();
      const caps = this._clientCapabilities() | CLIENT.SSL;
      w.u32(caps).u32(0x1000000).u8(45);
      w.fill(23);
      this.buffer = Buffer.alloc(0);
      this.socket.write(this._frame(w.toBuffer(), 1));

      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');

      const tlsSock = tls.connect(Object.assign({
        socket: plain,
        servername: this.cfg.host,
        rejectUnauthorized: false
      }, sslOpts), () => {
        this.socket = tlsSock;
        this.tls = true;
        this.seq = 2;
        this.buffer = Buffer.alloc(0);
        tlsSock.on('data', (c) => this._onData(c));
        tlsSock.on('error', (e) => {
          if (this._pending) {
            const p = this._pending; this._pending = null;
            clearTimeout(p.timer);
            p.reject(this._netError(e.message, e));
          }
        });
        tlsSock.on('close', () => { this.connected = false; this.destroyed = true; });
        resolve();
      });
      tlsSock.once('error', reject);
    });
  }

  _clientCapabilities() {
    let caps = CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION |
               CLIENT.LONG_PASSWORD | CLIENT.TRANSACTIONS |
               CLIENT.PLUGIN_AUTH | CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA |
               CLIENT.LONG_FLAG | CLIENT.MULTI_RESULTS;
    if (this.cfg.database) caps |= CLIENT.CONNECT_WITH_DB;
    // 只在服务器支持时启用，否则老服务器会拒绝
    caps &= (this.serverCapabilities | CLIENT.PROTOCOL_41 | CLIENT.SSL |
             CLIENT.PLUGIN_AUTH | CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA | CLIENT.SECURE_CONNECTION);
    if (this.serverCapabilities & CLIENT.DEPRECATE_EOF) caps |= CLIENT.DEPRECATE_EOF;
    return caps;
  }

  /* ---------- 认证 ---------- */

  _sendAuth() {
    return new Promise((resolve, reject) => {
      const caps = this._clientCapabilities();
      this.capabilities = caps;

      const plugin = this.authPlugin || 'mysql_native_password';
      let authData;
      if (plugin === 'caching_sha2_password') {
        authData = scrambleSha2(this.cfg.password, this.salt);
      } else if (plugin === 'mysql_clear_password') {
        authData = Buffer.from(this.cfg.password, 'utf8');
      } else {
        authData = scrambleNative(this.cfg.password, this.salt);
      }

      const w = new Writer();
      w.u32(caps).u32(0x1000000).u8(45);
      w.fill(23);
      w.nulStr(this.cfg.user, 'utf8');
      w.lenencBytes(authData);
      if (caps & CLIENT.CONNECT_WITH_DB) w.nulStr(this.cfg.database, 'utf8');
      if (caps & CLIENT.PLUGIN_AUTH) w.nulStr(plugin, 'latin1');

      // auth 阶段单独处理响应，先摘掉通用 handler
      this._authResolve = resolve;
      this._authReject = reject;
      this._authPlugin = plugin;
      this._authStage = 'auth-switch';

      this.seq = 1;
      this.buffer = Buffer.alloc(0);
      this.socket.write(this._frame(w.toBuffer(), 1));
    });
  }

  /** 认证阶段的响应处理（与命令阶段分开，因为要处理 AuthSwitch/AuthMoreData） */
  _handleAuthPacket(payload) {
    const first = payload[0];
    const r = new Reader(payload, 1);

    if (first === 0x00) {                    // OK
      this._finishAuth();
      return;
    }
    if (first === 0xff) {                    // ERR
      const e = this._parseErr(r, null);
      const rej = this._authReject;
      this._authResolve = this._authReject = null;
      return rej(e);
    }
    if (first === 0xfe) {                    // AuthSwitchRequest
      const r2 = new Reader(payload, 1);
      const newPlugin = r2.nulStr('latin1');
      let newSalt = r2.rest();
      while (newSalt.length > 0 && newSalt[newSalt.length - 1] === 0) newSalt = newSalt.slice(0, -1);
      if (newSalt.length > 0) this.salt = newSalt.slice(0, 20);
      this._authPlugin = newPlugin;

      let authData;
      if (newPlugin === 'caching_sha2_password') authData = scrambleSha2(this.cfg.password, this.salt);
      else if (newPlugin === 'mysql_clear_password') authData = Buffer.from(this.cfg.password, 'utf8');
      else authData = scrambleNative(this.cfg.password, this.salt);

      const w = new Writer();
      w.raw(authData);
      this.socket.write(this._frame(w.toBuffer(), this.seq));
      return;
    }
    if (first === 0x01) {                    // AuthMoreData（caching_sha2 的 fast-auth / full-auth）
      const statusByte = r.u8();
      if (statusByte === 0x03) {              // fast auth success → 等 OK
        this._authStage = 'auth-switch';
        return;
      }
      if (statusByte === 0x04) {              // full auth required
        if (this.tls || this.cfg.allowCleartextPassword) {
          // 有 TLS（或用户明确允许）才发明文密码，否则宁可失败
          const w = new Writer();
          w.raw(Buffer.from(this.cfg.password, 'utf8')).u8(0);
          this.socket.write(this._frame(w.toBuffer(), this.seq));
          return;
        }
        const rej = this._authReject;
        this._authResolve = this._authReject = null;
        return rej(new MySqlError(
          1045,
          'caching_sha2_password 要求 full authentication（明文密码），' +
          '但当前连接未启用 TLS。请为该连接开启 ssl:true，或把账号改为 mysql_native_password。',
          '28000'
        ));
      }
      // 其它状态字节：不知道如何处理，明确报错而不是死等
      const rej2 = this._authReject;
      this._authResolve = this._authReject = null;
      return rej2(new MySqlProtocolError('caching_sha2_password 未知状态字节: 0x' + statusByte.toString(16)));
    }

    // 其它未知包：明确报错
    const rej = this._authReject;
    this._authResolve = this._authReject = null;
    rej(new MySqlProtocolError('认证阶段收到未知包，首字节 0x' + first.toString(16)));
  }

  _finishAuth() {
    this.connected = true;
    this._authStage = null;
    const res = this._authResolve;
    this._authResolve = this._authReject = null;
    if (res) res();
  }

  /* ---------- 数据流分发 ---------- */

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    // 握手阶段的数据由 _readHandshake 自己的监听器处理
    if (!this.connected && this._authStage === 'auth-switch') {
      // 认证阶段的包
      while (this.buffer.length >= 4) {
        const len = this.buffer.readUIntLE(0, 3);
        if (this.buffer.length < 4 + len) break;
        const seq = this.buffer[3];
        const payload = this.buffer.slice(4, 4 + len);
        this.buffer = this.buffer.slice(4 + len);
        // 记录 seq，便于后续发包续号
        this.seq = (seq + 1) & 0xff;
        try { this._handleAuthPacket(payload); }
        catch (e) {
          const rej = this._authReject;
          this._authResolve = this._authReject = null;
          if (rej) rej(e); else if (this._pending) { const p = this._pending; this._pending = null; clearTimeout(p.timer); p.reject(e); }
        }
      }
      return;
    }

    if (!this._pending) {
      // 没有等待中的请求，多余数据不预期；保留 buffer 防止半包丢失
      return;
    }

    const pending = this._pending;
    try {
      this._consumeResponse(pending);
    } catch (e) {
      this._pending = null;
      clearTimeout(pending.timer);
      pending.reject(e);
    }
  }

  /**
   * 解析一个完整的命令响应
   * 结构：OK 包 | ERR 包 | (列数包 + N 列定义 + [EOF] + 行... + EOF/OK)
   */
  _consumeResponse(pending) {
    if (this.buffer.length < 4) {
      this._armMore(pending);
      return;
    }
    const len = this.buffer.readUIntLE(0, 3);
    if (this.buffer.length < 4 + len) {
      this._armMore(pending);
      return;
    }
    const first = this.buffer[4];

    if (first === 0x00) {                       // OK 包（非 SELECT 语句）
      const payload = this.buffer.slice(4, 4 + len);
      this.buffer = this.buffer.slice(4 + len);
      const ok = this._parseOk(payload);
      this._resolvePending(pending, { type: 'ok', ...ok, columns: [], rows: [], affectedRows: ok.affectedRows, lastInsertId: ok.lastInsertId });
      return;
    }
    if (first === 0xff) {                       // ERR 包
      const payload = this.buffer.slice(4, 4 + len);
      this.buffer = this.buffer.slice(4 + len);
      const r = new Reader(payload, 1);
      this._rejectPending(pending, this._parseErr(r, pending.sql));
      return;
    }
    if (first === 0xfb) {                       // LOCAL INFILE（本工具集不支持）
      this._rejectPending(pending, new MySqlProtocolError('服务器请求 LOCAL INFILE，本客户端不支持'));
      return;
    }

    // 其余：length-encoded 整数 = 列数
    this._readResultSet(pending);
  }

  /** 数据还没到齐，装回 pending 等下一次 _onData */
  _armMore(pending) {
    // 不做事：_onData 会在新数据到达时再次调用 _consumeResponse
    // 这里只需保证 pending 仍在 this._pending 上
  }

  _readResultSet(pending) {
    const r0 = new Reader(this.buffer.slice(4, 4 + this.buffer.readUIntLE(0, 3)));
    const columnCount = r0.lenencInt();
    if (columnCount === null || typeof columnCount === 'bigint') {
      this._rejectPending(pending, new MySqlProtocolError('结果集列数解析失败'));
      return;
    }
    this.buffer = this.buffer.slice(4 + this.buffer.readUIntLE(0, 3));

    const columns = [];
    let needEofAfterColumns = !(this.capabilities & CLIENT.DEPRECATE_EOF);

    const readNext = () => {
      // 逐个读取列定义
      while (columns.length < columnCount) {
        if (this.buffer.length < 4) return false;
        const len = this.buffer.readUIntLE(0, 3);
        if (this.buffer.length < 4 + len) return false;
        const payload = this.buffer.slice(4, 4 + len);
        this.buffer = this.buffer.slice(4 + len);
        const cr = new Reader(payload);
        columns.push(parseColumnDefinition(cr));
      }

      // 列定义后可能有 EOF 包（未启用 DEPRECATE_EOF 时）
      if (needEofAfterColumns) {
        if (this.buffer.length < 4) return false;
        const len = this.buffer.readUIntLE(0, 3);
        if (this.buffer.length < 4 + len) return false;
        const payload = this.buffer.slice(4, 4 + len);
        this.buffer = this.buffer.slice(4 + len);
        if (payload[0] !== 0xfe) {
          // 不是 EOF，说明服务器仍发了一行数据（极少见）；把它当作数据行处理
          this.buffer = Buffer.concat([this._frameOf(payload), this.buffer]);
        }
        needEofAfterColumns = false;
      }

      // 逐行读取，直到 EOF（0xfe 且长度 < 9）或 OK
      for (;;) {
        if (this.buffer.length < 4) return false;
        const len = this.buffer.readUIntLE(0, 3);
        if (this.buffer.length < 4 + len) return false;
        const payload = this.buffer.slice(4, 4 + len);

        if (payload[0] === 0xff) {
          this.buffer = this.buffer.slice(4 + len);
          const r = new Reader(payload, 1);
          this._rejectPending(pending, this._parseErr(r, pending.sql));
          return true;
        }
        // EOF 包：首字节 0xfe 且 payload 长度 < 9
        if (payload[0] === 0xfe && len < 9) {
          this.buffer = this.buffer.slice(4 + len);
          pending.eofCount = (pending.eofCount || 0) + 1;
          const done = this._rowsDone(pending, columns);
          if (done) return true;
          continue;
        }
        // 普通数据行
        this.buffer = this.buffer.slice(4 + len);
        pending.rawRows.push(payload);
        if (pending.rawRows.length > pending.maxRows) {
          this._rejectPending(pending, new MySqlError(
            0, `结果集超过上限（${pending.maxRows} 行）。请加 LIMIT 或缩小查询范围。`, 'HY000', pending.sql));
          return true;
        }
      }
    };

    if (readNext()) return;
    // 数据不足：等更多数据
    this._pending = pending;
    this._pendingContinue = readNext;
  }

  /** 把 payload 重新包成带包头的 buffer（处理"列后不是 EOF"的罕见情况） */
  _frameOf(payload) {
    const h = Buffer.allocUnsafe(4);
    h.writeUIntLE(payload.length, 0, 3);
    h[3] = this.seq;
    return Buffer.concat([h, payload]);
  }

  /** 行读完后：可能还有续结果集（忽略），然后 resolve */
  _rowsDone(pending, columns) {
    if (this._pendingContinue) this._pendingContinue = null;

    // 简化处理：无论是否声明 MORE_RESULTS，都到这里就结束
    const rows = pending.rawRows.map((raw) => {
      const r = new Reader(raw);
      const row = {};
      const arr = [];
      for (let i = 0; i < columns.length; i++) {
        const cell = r.lenencBytes();
        const col = columns[i];
        const v = decodeValue(cell, col.type, col.flags, col.charset, {
          dateStrings: this.cfg.dateStrings,
          bigIntAsString: this.cfg.bigIntAsString
        });
        // 别名字段：`SELECT a AS x` 用 x，同时保留下标访问
        arr.push(v);
        const key = col.name || ('col' + i);
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          row[key + '_' + i] = v;       // 重名列不覆盖，加后缀
        } else {
          row[key] = v;
        }
      }
      row.__values = arr;
      return row;
    });

    this._resolvePending(pending, {
      type: 'resultset', columns, rows, affectedRows: 0, lastInsertId: 0
    });
    return true;
  }

  /* ---------- 包解析辅助 ---------- */

  _parseOk(payload) {
    const r = new Reader(payload, 1);
    const affectedRows = r.lenencInt();
    const lastInsertId = r.lenencInt();
    let statusFlags = 0, warnings = 0;
    try {
      statusFlags = r.u16();
      warnings = r.u16();
    } catch (e) { /* 极简 OK 包没有这两个字段 */ }
    return {
      affectedRows: typeof affectedRows === 'bigint' ? Number(affectedRows) : (affectedRows || 0),
      lastInsertId: typeof lastInsertId === 'bigint' ? Number(lastInsertId) : (lastInsertId || 0),
      statusFlags, warnings
    };
  }

  _parseErr(r, sql) {
    const code = r.u16();
    let sqlState = null;
    let message;
    if (r.remaining > 0 && r.buf[r.pos] === 0x23) {   // '#'
      r.u8();
      sqlState = r.bytes(5).toString('ascii');
      message = r.rest().toString('utf8');
    } else {
      message = r.rest().toString('utf8');
    }
    return new MySqlError(code, message, sqlState, sql);
  }

  /* ---------- 发包 ---------- */

  _frame(payload, seq) {
    const { buffers } = writePackets(payload, seq);
    return Buffer.concat(buffers);
  }

  /** 发送一个命令并等待完整响应 */
  _command(command, payloadBuf, sql, maxRows) {    return new Promise((resolve, reject) => {
      if (this.destroyed || !this.socket) {
        return reject(this._netError('连接已关闭，无法执行查询'));
      }
      if (!this.connected) {
        return reject(this._netError('连接尚未完成握手，无法执行查询'));
      }
      if (this._pending) {
        return reject(new MySqlProtocolError('该连接上已有查询在执行（本客户端不支持并发复用单连接）'));
      }

      const body = Buffer.concat([Buffer.from([command]), payloadBuf || Buffer.alloc(0)]);
      const pending = {
        resolve, reject, sql: sql || null,
        rawRows: [], eofCount: 0,
        maxRows: maxRows || this.cfg.maxRows || 5000
      };
      pending.timer = setTimeout(() => {
        if (this._pending === pending) {
          this._pending = null;
          this._pendingContinue = null;
          reject(new MySqlError(0, `查询超时（${this.cfg.queryTimeout}ms）：${(sql || '').slice(0, 120)}`, 'HY000', sql));
        }
      }, this.cfg.queryTimeout);
      pending.timer.unref && pending.timer.unref();

      this._pending = pending;
      this.buffer = Buffer.alloc(0);
      this.seq = 0;
      this.socket.write(this._frame(body, 0));
    });
  }

  _resolvePending(pending, result) {
    if (this._pending !== pending) return;
    this._pending = null;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  _rejectPending(pending, err) {
    if (this._pending !== pending) return;
    this._pending = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  /* ---------- 对外的查询接口 ---------- */

  /**
   * 安全的参数占位符替换（只支持 ? 占位）
   *
   * 为什么不用服务端预处理语句：本工具集只需要文本协议，
   * 引入 binary protocol 会让代码量翻倍而收益极小。
   * 这里用严格的字面量转义达到同等安全性：
   *   - 字符串：单引号包裹，转义 \ ' " \0 \n \r \x1a
   *   - 数字：直接内联（已用 Number.isFinite 校验，杜绝 "1 OR 1=1" 这类注入）
   *   - null → NULL，boolean → 1/0，Date → 格式化字符串
   *   - Buffer → 十六进制字面量 X'..'
   *   - 其它对象 → 直接拒绝，避免把整个对象 stringify 进 SQL
   */
  static escapeValue(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new MySqlProtocolError('SQL 参数是非法数字：' + v);
      return String(v);
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) throw new MySqlProtocolError('SQL 参数是非法日期');
      const p = (n, w = 2) => String(n).padStart(w, '0');
      return `'${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ` +
        `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}.${p(v.getMilliseconds(), 3)}'`;
    }
    if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
    if (Array.isArray(v)) {
      if (v.length === 0) return '(NULL)';
      return '(' + v.map(x => Connection.escapeValue(x)).join(', ') + ')';
    }
    if (typeof v === 'object') {
      throw new MySqlProtocolError('SQL 参数不支持对象类型（请手动 JSON.stringify 后传字符串）：' +
        JSON.stringify(v).slice(0, 100));
    }
    // 字符串 / 其它原始类型
    const s = String(v);
    let out = '';
    for (const ch of s) {
      switch (ch) {
        case "'": out += "\\'"; break;
        case '"': out += '\\"'; break;
        case '\\': out += '\\\\'; break;
        case '\n': out += '\\n'; break;
        case '\r': out += '\\r'; break;
        case '\0': out += '\\0'; break;
        case '\x1a': out += '\\Z'; break;
        default: out += ch;
      }
    }
    return "'" + out + "'";
  }

  /** 把 ? 占位符替换成安全字面量（跳过字符串字面量里的 ?） */
  static bindParams(sql, params) {
    if (!params || params.length === 0) return sql;
    let out = '';
    let idx = 0;
    let i = 0;
    let quote = null;
    while (i < sql.length) {
      const c = sql[i];
      if (quote) {
        out += c;
        if (c === '\\' && i + 1 < sql.length) { out += sql[i + 1]; i += 2; continue; }
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
      if (c === '?') {
        if (idx >= params.length) {
          throw new MySqlProtocolError(`SQL 里的 ? 占位符多于提供的参数（需要至少 ${idx + 1} 个，只给了 ${params.length} 个）`);
        }
        out += Connection.escapeValue(params[idx++]);
        i++;
        continue;
      }
      out += c;
      i++;
    }
    if (idx < params.length) {
      throw new MySqlProtocolError(`提供了 ${params.length} 个参数，但 SQL 里只有 ${idx} 个 ? 占位符`);
    }
    return out;
  }

  /** 执行 SQL，返回 { columns, rows, affectedRows } */
  query(sql, opts = {}) {
    const finalSql = (opts.params && opts.params.length)
      ? Connection.bindParams(sql, opts.params)
      : sql;
    return this._command(0x03, Buffer.from(finalSql, 'utf8'), finalSql, opts.maxRows)
      .then((res) => {
        if (res.rows && res.rows.length) {
          // 带 __values 是内部实现细节，摘掉避免污染 JSON 输出
          for (const row of res.rows) delete row.__values;
        }
        res.sql = finalSql;
        return res;
      });
  }

  ping() {
    return this._command(0x0e, null, null, 1).then(() => true);
  }

  /* ---------- 关闭 ---------- */

  close() {
    return new Promise((resolve) => {
      if (this.destroyed || !this.socket) return resolve();
      this._closing = true;
      try {
        this.seq = 0;
        this.socket.write(this._frame(Buffer.from([0x01]), 0));   // COM_QUIT
      } catch (e) { /* 忽略：可能已经断了 */ }
      const t = setTimeout(() => { this._forceDestroy(); resolve(); }, 300);
      t.unref && t.unref();
      this.socket.once('close', () => { clearTimeout(t); this._forceDestroy(); resolve(); });
      try { this.socket.end(); } catch (e) { /* ignore */ }
    });
  }

  _forceDestroy() {
    this.destroyed = true;
    this.connected = false;
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
      try { this.socket.destroy(); } catch (e) { /* ignore */ }
    }
  }
}

Connection._nextId = 1;

module.exports = {
  Connection, MySqlError, MySqlProtocolError, CLIENT, SERVER, STATUS,
  scrambleNative, scrambleSha2
};
