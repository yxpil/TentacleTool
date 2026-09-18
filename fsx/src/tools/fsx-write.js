'use strict';
/**
 * fsx_write —— 写文件（覆盖/追加、自动建父目录、返回字节数与行数）
 */
const fs = require('fs');
const path = require('path');
const { countLines } = require('../utils/fsutil');

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要写入的文件路径' },
    content: { type: 'string', description: '要写入的内容（字符串）' },
    mode: { type: 'string', enum: ['overwrite', 'append'], description: 'overwrite=覆盖（默认），append=追加到文件末尾' },
    encoding: { type: 'string', description: '写入编码，默认 utf8' },
    createDirs: { type: 'boolean', description: '父目录不存在时自动创建，默认 true' }
  },
  required: ['path']
};

function run(args) {
  const p = path.resolve(args.path || '');
  const content = (args.content == null ? '' : String(args.content));
  const mode = args.mode === 'append' ? 'append' : 'overwrite';
  const encoding = args.encoding || 'utf8';
  const createDirs = args.createDirs !== false;

  if (createDirs) {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const existed = fs.existsSync(p);
  if (mode === 'append') {
    fs.appendFileSync(p, content, encoding);
  } else {
    fs.writeFileSync(p, content, encoding);
  }

  const st = fs.statSync(p);
  const finalContent = fs.readFileSync(p, encoding);
  const lines = countLines(finalContent);

  const action = mode === 'append' ? '追加' : '覆盖写入';
  const createdNote = existed ? '' : '（文件为新建）';

  return {
    _text:
      `▸ 已${action} ${p}${createdNote}\n` +
      `  字节: ${st.size}  行数: ${lines}  编码: ${encoding}  模式: ${mode}`,
    path: p,
    bytes: st.size,
    lines,
    mode,
    created: !existed,
    encoding
  };
}

module.exports = {
  name: 'fsx_write',
  title: '写文件（覆盖/追加/自动建目录）',
  description:
    '创建或写入一个文件。mode=overwrite 覆盖（默认），mode=append 追加到末尾；' +
    '默认自动创建不存在的父目录（createDirs=false 可关闭）。返回写入后的字节数、行数与是否新建。',
  inputSchema,
  run
};
