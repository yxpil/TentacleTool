'use strict';
/**
 * MySQL 协议底层编解码（零依赖，纯 Buffer 操作）
 *
 * 覆盖：定长整数 / 长度编码整数 / 长度编码字符串 / NULL 结尾字符串 / 包头分片
 *
 * 协议要点：
 *  - 每个包 = 3 字节小端长度 + 1 字节序号 + payload
 *  - payload 长度达到 0xFFFFFF (16MB-1) 表示后续还有续包，需拼接
 *  - 长度编码整数：首字节 < 0xFB 直接就是值；0xFC/0xFD/0xFE 后跟 2/3/8 字节
 *  - 0xFB 在整数位置是 NULL 标记，0xFB 在字符串位置是 NULL 字符串
 */

const MAX_PAYLOAD = 0xffffff;   // 单个包 payload 上限

/* ======================== 读 ======================== */

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.pos = offset;
  }

  get remaining() { return this.buf.length - this.pos; }
  get eof() { return this.pos >= this.buf.length; }

  _need(n) {
    if (this.pos + n > this.buf.length) {
      throw new RangeError(`MySQL 包读取越界：需要 ${n} 字节，剩余 ${this.remaining}（pos=${this.pos}, len=${this.buf.length}）`);
    }
  }

  u8() { this._need(1); return this.buf[this.pos++]; }
  u16() { this._need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u24() { this._need(3); const v = this.buf.readUIntLE(this.pos, 3); this.pos += 3; return v; }
  u32() { this._need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u48() { this._need(6); const v = this.buf.readUIntLE(this.pos, 6); this.pos += 6; return v; }
  u64() { this._need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }

  /** 3 字节小端（包头长度 / 某些协议字段） */
  int3() { return this.u24(); }

  /**
   * 长度编码整数
   * 若读到 0xFB 返回 null（在列值语境表示 SQL NULL）
   */
  lenencInt() {
    const first = this.u8();
    if (first < 0xfb) return first;
    if (first === 0xfb) return null;              // NULL
    if (first === 0xfc) return this.u16();
    if (first === 0xfd) return this.u24();
    if (first === 0xfe) {
      const v = this.u64();
      // 超出 Number.MAX_SAFE_INTEGER 时退回字符串，避免精度丢失
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }
    throw new Error('非法的长度编码整数首字节: 0x' + first.toString(16));
  }

  /** 长度编码字符串；返回 Buffer（调用方按需 toString） */
  lenencBytes() {
    const len = this.lenencInt();
    if (len === null) return null;
    const n = typeof len === 'bigint' ? Number(len) : Number(len);
    this._need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  lenencStr(encoding = 'utf8') {
    const b = this.lenencBytes();
    return b === null ? null : b.toString(encoding);
  }

  /** NULL 结尾字符串（\0 终止） */
  nulStr(encoding = 'utf8') {
    let end = this.buf.indexOf(0, this.pos);
    if (end === -1) end = this.buf.length;
    const out = this.buf.toString(encoding, this.pos, end);
    this.pos = end + 1;   // 跳过 \0
    return out;
  }

  bytes(n) { this._need(n); const b = this.buf.slice(this.pos, this.pos + n); this.pos += n; return b; }
  rest() { const b = this.buf.slice(this.pos); this.pos = this.buf.length; return b; }
  skip(n) { this._need(n); this.pos += n; }
}

/* ======================== 写 ======================== */

class Writer {
  constructor() { this.chunks = []; }

  raw(buf) { this.chunks.push(buf); return this; }
  u8(v) { this.chunks.push(Buffer.from([v & 0xff])); return this; }
  u16(v) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(v & 0xffff); this.chunks.push(b); return this; }
  u24(v) { const b = Buffer.allocUnsafe(3); b.writeUIntLE(v & 0xffffff, 0, 3); this.chunks.push(b); return this; }
  u32(v) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v >>> 0); this.chunks.push(b); return this; }

  /** 长度编码整数（仅编码 0 ~ 2^32-1 范围内的值，足够本工具集使用） */
  lenencInt(v) {
    if (v < 0xfb) return this.u8(v);
    if (v < 0x10000) return this.u8(0xfc).u16(v);
    if (v < 0x1000000) return this.u8(0xfd).u24(v);
    return this.u8(0xfe).raw(u64le(v));
  }

  lenencBytes(buf) {
    this.lenencInt(buf.length);
    this.chunks.push(buf);
    return this;
  }

  lenencStr(s, encoding = 'utf8') { return this.lenencBytes(Buffer.from(s, encoding)); }
  nulStr(s, encoding = 'utf8') { this.chunks.push(Buffer.from(s, encoding)); return this.u8(0); }
  fill(n, byte = 0) { this.chunks.push(Buffer.alloc(n, byte)); return this; }

  toBuffer() { return Buffer.concat(this.chunks); }
}

function u64le(v) {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

/* ======================== 包头 ======================== */

/** 读一个包：[len:3][seq:1][payload] */
function readPacket(buf) {
  if (buf.length < 4) throw new Error('MySQL 包不完整：长度 ' + buf.length + ' < 4');
  const len = buf.readUIntLE(0, 3);
  const seq = buf[3];
  if (buf.length < 4 + len) {
    throw new Error(`MySQL 包不完整：包头声明 ${len} 字节 payload，实际只有 ${buf.length - 4}`);
  }
  return { length: len, seq, payload: buf.slice(4, 4 + len), consumed: 4 + len };
}

/**
 * 把 payload 切成一个或多个包（>= 16MB-1 时需要续包）
 * seq 起始值由调用方决定，返回值里给出下一个可用 seq
 */
function writePackets(payload, startSeq = 0) {
  const out = [];
  let seq = startSeq;
  let offset = 0;
  // 注意：长度正好等于 MAX_PAYLOAD 时，后面必须补一个空包表示结束
  do {
    const len = Math.min(MAX_PAYLOAD, payload.length - offset);
    const header = Buffer.allocUnsafe(4);
    header.writeUIntLE(len, 0, 3);
    header[3] = seq & 0xff;
    out.push(header);
    out.push(payload.slice(offset, offset + len));
    offset += len;
    seq = (seq + 1) & 0xff;
  } while (offset < payload.length || (payload.length > 0 && payload.length % MAX_PAYLOAD === 0));
  return { buffers: out, nextSeq: seq };
}

module.exports = { Reader, Writer, readPacket, writePackets, MAX_PAYLOAD, u64le };
