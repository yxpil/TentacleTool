'use strict';
/**
 * fsx_move —— 移动/重命名（跨盘自动处理）
 */
const fs = require('fs');
const path = require('path');

const inputSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', description: '源路径（文件或目录）' },
    dest: { type: 'string', description: '目标路径（同盘即重命名，跨盘自动复制后删除源）' },
    overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false（存在则拒绝并报错）' }
  },
  required: ['source', 'dest']
};

function copyRecursive(src, dest, counter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(src)) copyRecursive(path.join(src, n), path.join(dest, n), counter);
  } else {
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

  let crossDevice = false;
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES') {
      // 跨盘或权限限制：复制后删除源
      crossDevice = true;
      const counter = { items: 0, bytes: 0 };
      copyRecursive(src, dst, counter);
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }

  return {
    _text:
      `▸ 已移动 ${type === 'dir' ? '目录' : '文件'}\n` +
      `  源: ${src}\n` +
      `  目标: ${dst}\n` +
      `  方式: ${crossDevice ? '跨盘复制+删除源' : '同盘重命名'}  覆盖: ${overwrite ? '是' : '否'}`,
    source: src,
    dest: dst,
    type,
    crossDevice,
    overwritten: overwrite
  };
}

module.exports = {
  name: 'fsx_move',
  title: '移动/重命名（跨盘自动处理）',
  description:
    '移动或重命名文件/目录。同盘直接 rename；跨盘（EXDEV）或受权限限制时自动"复制后删除源"。' +
    '目标已存在且 overwrite=false 时拒绝。返回移动方式与是否跨盘。',
  inputSchema,
  run
};
