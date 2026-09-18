'use strict';
/**
 * fsx_copy —— 复制（文件或目录、覆盖开关）
 */
const fs = require('fs');
const path = require('path');

const inputSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', description: '源路径（文件或目录）' },
    dest: { type: 'string', description: '目标路径' },
    overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false（存在则拒绝并报错）' }
  },
  required: ['source', 'dest']
};

function copyRecursive(src, dest, overwrite, counter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const names = fs.readdirSync(src);
    for (const n of names) copyRecursive(path.join(src, n), path.join(dest, n), overwrite, counter);
  } else {
    if (fs.existsSync(dest) && !overwrite) {
      throw new Error('目标已存在：' + dest + '（需要 overwrite=true 才能覆盖）');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    counter.items++;
    counter.bytes += st.size;
  }
}

function run(args) {
  const src = path.resolve(args.source || '');
  const dst = path.resolve(args.dest || '');
  const overwrite = !!args.overwrite;

  if (!fs.existsSync(src)) throw new Error('源不存在：' + src);
  const srcStat = fs.statSync(src);
  const type = srcStat.isDirectory() ? 'dir' : 'file';

  if (fs.existsSync(dst) && !overwrite) {
    throw new Error('目标已存在：' + dst + '（需要 overwrite=true 才能覆盖）');
  }

  const counter = { items: 0, bytes: 0 };
  copyRecursive(src, dst, overwrite, counter);

  return {
    _text:
      `▸ 已复制 ${type === 'dir' ? '目录' : '文件'}\n` +
      `  源: ${src}\n` +
      `  目标: ${dst}\n` +
      `  项数: ${counter.items}  字节: ${counter.bytes}  覆盖: ${overwrite ? '是' : '否'}`,
    source: src,
    dest: dst,
    type,
    items: counter.items,
    bytes: counter.bytes,
    overwritten: overwrite
  };
}

module.exports = {
  name: 'fsx_copy',
  title: '复制（文件或目录/覆盖开关）',
  description:
    '复制文件或整个目录到目标位置。目标已存在且 overwrite=false 时拒绝并报错；' +
    'overwrite=true 覆盖。返回复制的项数与总字节数。',
  inputSchema,
  run
};
