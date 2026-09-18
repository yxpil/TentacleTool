'use strict';
/**
 * fsx_delete —— 删除（四道安全闸：confirm / recursive / 受保护路径 / dryRun）
 *
 * 删除是天然危险品，闸门先于功能设计：
 *   1. 没有 confirm=true 一律拒绝执行，并返回"将要删除什么"的预览清单
 *   2. 删除目录必须 recursive=true，否则拒绝
 *   3. 拒绝删除盘符根 / 用户主目录 / 系统目录（Windows/Program Files/ProgramData 等）
 *      —— 路径先规范化（吸收大小写变体、末尾斜杠、.. 穿越）再判断
 *   4. dryRun=true 只预览不执行
 * 所有闸门都有绕过测试断言（不只是"正常路径能删"）。
 */
const fs = require('fs');
const path = require('path');
const { safeStat, isProtected, fmtTime } = require('../utils/fsutil');
const F = require('../utils/format');

const PREVIEW_LIMIT = 50;

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要删除的路径（文件或目录）' },
    confirm: { type: 'boolean', description: '★必须设为 true 才会真正删除；否则只返回预览清单、拒绝执行' },
    recursive: { type: 'boolean', description: '删除目录时必须设为 true；否则拒绝删除目录' },
    dryRun: { type: 'boolean', description: 'true 时只返回预览、不执行删除（与 confirm 并存时仍不删）' }
  },
  required: ['path']
};

/** 枚举将要删除的内容（不删除），返回清单与总大小 */
function enumerate(target) {
  const items = [];
  let totalBytes = 0;
  const st = safeStat(target);
  if (!st) return { items, totalBytes, exists: false, isDir: false };
  const isDir = st.isDirectory();
  if (!isDir) {
    items.push({ path: target, size: st.size, type: 'file' });
    totalBytes += st.size;
  } else {
    items.push({ path: target, size: st.size, type: 'dir' });
    const walk = (d) => {
      let names;
      try { names = fs.readdirSync(d); } catch (e) { return; }
      for (const n of names) {
        const f = path.join(d, n);
        const s = safeStat(f);
        if (!s) continue;
        if (s.isDirectory()) {
          items.push({ path: f, size: s.size, type: 'dir' });
          walk(f);
        } else {
          items.push({ path: f, size: s.size, type: 'file' });
          totalBytes += s.size;
        }
      }
    };
    walk(target);
  }
  return { items, totalBytes, exists: true, isDir };
}

function previewText(label, target, info) {
  const L = [];
  L.push(`⚠ ${label}`);
  L.push(`  目标: ${target}`);
  L.push(`  类型: ${info.isDir ? '目录' : '文件'}  项数: ${info.items.length}  文件总大小: ${F.size(info.totalBytes)}`);
  if (info.exists) {
    const head = info.items.slice(0, PREVIEW_LIMIT);
    L.push('');
    L.push('  将删除：');
    for (const it of head) {
      L.push(`    · ${it.type === 'dir' ? '[目录] ' : ''}${it.path}${it.type === 'file' ? '  (' + F.size(it.size) + ')' : ''}`);
    }
    if (info.items.length > PREVIEW_LIMIT) {
      L.push(`    · …另有 ${info.items.length - PREVIEW_LIMIT} 项`);
    }
  } else {
    L.push('  （目标不存在，无内容可删）');
  }
  return L.join('\n');
}

function run(args) {
  const target = path.resolve(args.path || '');
  const confirm = !!args.confirm;
  const recursive = !!args.recursive;
  const dryRun = !!args.dryRun;

  const info = enumerate(target);

  // 闸门 1：未确认且非 dryRun → 只预览，拒绝执行
  if (!confirm && !dryRun) {
    return {
      _text: previewText('未确认删除，仅预览（不会删除任何内容）', target, info) +
        '\n\n  若要执行删除，请显式传入 confirm=true；删除目录还需 recursive=true。',
      path: target,
      deleted: false,
      preview: true,
      protected: false,
      ...info
    };
  }

  // 闸门 2：目录必须 recursive
  if (info.isDir && !recursive) {
    const err = new Error('删除目录必须传入 recursive=true（已拒绝执行，避免误删整个目录）。预览：' +
      info.items.length + ' 项，' + F.size(info.totalBytes));
    err.preview = previewText('删除被拒绝：目录需要 recursive=true', target, info);
    throw err;
  }

  // 闸门 3：受保护路径一律拒绝
  const protectedReason = isProtected(target);
  if (protectedReason) {
    const err = new Error(protectedReason + '（已拒绝执行，未做任何删除）');
    err.preview = previewText('删除被拒绝：受保护路径', target, info);
    throw err;
  }

  // 闸门 4：dryRun → 只预览
  if (dryRun) {
    return {
      _text: previewText('dryRun 预览（未执行删除）', target, info) +
        '\n\n  dryRun=true：以上为将要删除的内容，未实际删除。',
      path: target,
      deleted: false,
      preview: true,
      dryRun: true,
      protected: false,
      ...info
    };
  }

  // 真正删除
  if (!info.exists) {
    return {
      _text: `▸ 目标不存在，无需删除：${target}`,
      path: target,
      deleted: false,
      existed: false,
      preview: false,
      protected: false,
      items: [],
      totalBytes: 0
    };
  }

  const count = info.items.length;
  const bytes = info.totalBytes;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    throw new Error('删除失败：' + e.message);
  }
  const gone = !fs.existsSync(target);

  return {
    _text:
      `▸ 已删除 ${info.isDir ? '目录' : '文件'}\n` +
      `  目标: ${target}\n` +
      `  项数: ${count}  文件总大小: ${F.size(bytes)}\n` +
      `  删除${gone ? '成功' : '后目标仍存在（可能有权限残留）'}`,
    path: target,
    deleted: true,
    existed: true,
    gone,
    preview: false,
    protected: false,
    items: count,
    totalBytes: bytes
  };
}

module.exports = {
  name: 'fsx_delete',
  title: '删除（四道安全闸：confirm/recursive/受保护路径/dryRun）',
  description:
    '删除文件或目录。★安全设计：confirm=true 才会真正删除，否则只返回"将要删除什么"的预览清单；' +
    '删除目录必须 recursive=true；盘符根/用户主目录/系统目录（Windows/Program Files/ProgramData 等）' +
    '一律拒绝（路径先规范化再判断，吸收大小写变体/末尾斜杠/.. 穿越）；dryRun=true 只预览不执行。',
  inputSchema,
  run,
  enumerate,
  previewText
};
