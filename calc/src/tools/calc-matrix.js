'use strict';
/**
 * calc_matrix：矩阵运算
 *
 * 矩阵用二维数组表示：[[1,2],[3,4]]
 * 支持：加/减/乘、数乘、转置、行列式、逆、秩、迹、解线性方程组、特征值（简单幂迭代）
 */
const { formatValue } = require('../utils/format');

/* ======================== 基础校验 ======================== */

function asMatrix(v, name) {
  if (!Array.isArray(v) || !v.length || !Array.isArray(v[0])) {
    throw new Error(`${name || '参数'} 必须是二维数组，如 [[1,2],[3,4]]`);
  }
  const rows = v.length, cols = v[0].length;
  const M = v.map((row, i) => {
    if (!Array.isArray(row) || row.length !== cols) {
      throw new Error(`${name || '矩阵'} 第 ${i + 1} 行长度不一致（应为 ${cols}）`);
    }
    return row.map((x, j) => {
      const n = Number(x);
      if (!isFinite(n)) throw new Error(`${name || '矩阵'} 第 ${i + 1} 行第 ${j + 1} 列不是有效数字`);
      return n;
    });
  });
  if (!rows || !cols) throw new Error('矩阵不能为空');
  return M;
}

const shape = (M) => `${M.length}×${M[0].length}`;

function clone(M) { return M.map(r => r.slice()); }

function assertSameShape(A, B) {
  if (A.length !== B.length || A[0].length !== B[0].length) {
    throw new Error(`形状不匹配: ${shape(A)} vs ${shape(B)}`);
  }
}

/* ======================== 基本运算 ======================== */

function add(A, B) {
  assertSameShape(A, B);
  return A.map((row, i) => row.map((x, j) => x + B[i][j]));
}

function sub(A, B) {
  assertSameShape(A, B);
  return A.map((row, i) => row.map((x, j) => x - B[i][j]));
}

function mul(A, B) {
  if (A[0].length !== B.length) {
    throw new Error(`无法相乘: ${shape(A)} × ${shape(B)}（左矩阵列数须等于右矩阵行数）`);
  }
  const n = A.length, m = B[0].length, k = B.length;
  const C = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m).fill(0);
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let t = 0; t < k; t++) s += A[i][t] * B[t][j];
      row[j] = s;
    }
    C.push(row);
  }
  return C;
}

function scale(A, k) { return A.map(r => r.map(x => x * k)); }

function transpose(A) {
  const n = A.length, m = A[0].length;
  const T = [];
  for (let j = 0; j < m; j++) {
    const row = new Array(n);
    for (let i = 0; i < n; i++) row[i] = A[i][j];
    T.push(row);
  }
  return T;
}

function trace(A) {
  if (A.length !== A[0].length) throw new Error(`迹要求方阵，当前 ${shape(A)}`);
  let s = 0;
  for (let i = 0; i < A.length; i++) s += A[i][i];
  return s;
}

/* ======================== 行列式 / 逆 / 秩 ======================== */

function determinant(A) {
  if (A.length !== A[0].length) throw new Error(`行列式要求方阵，当前 ${shape(A)}`);
  const n = A.length;
  const M = clone(A);
  let det = 1;
  let sign = 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return 0;
    if (piv !== col) { [M[col], M[piv]] = [M[piv], M[col]]; sign = -sign; }
    det *= M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return sign * det;
}

function inverse(A) {
  if (A.length !== A[0].length) throw new Error(`求逆要求方阵，当前 ${shape(A)}`);
  const n = A.length;
  const M = A.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) {
      throw new Error('矩阵不可逆（行列式为 0）');
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    const p = M[col][col];
    for (let c = 0; c < 2 * n; c++) M[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row.slice(n).map(round12));
}

/** 行阶梯化求秩 */
function rank(A) {
  const M = clone(A);
  const rows = M.length, cols = M[0].length;
  let r = 0;
  for (let c = 0; c < cols && r < rows; c++) {
    let piv = r;
    for (let i = r + 1; i < rows; i++) if (Math.abs(M[i][c]) > Math.abs(M[piv][c])) piv = i;
    if (Math.abs(M[piv][c]) < 1e-12) continue;
    [M[r], M[piv]] = [M[piv], M[r]];
    const p = M[r][c];
    for (let cc = c; cc < cols; cc++) M[r][cc] /= p;
    for (let i = 0; i < rows; i++) {
      if (i === r) continue;
      const f = M[i][c];
      if (f === 0) continue;
      for (let cc = c; cc < cols; cc++) M[i][cc] -= f * M[r][cc];
    }
    r++;
  }
  return r;
}

/* ======================== 解线性方程组 Ax = b ======================== */

function solve(A, b) {
  if (A.length !== A[0].length) throw new Error(`解方程组要求系数矩阵为方阵，当前 ${shape(A)}`);
  if (b.length !== A.length) throw new Error(`b 的长度 (${b.length}) 必须等于 A 的行数 (${A.length})`);
  try {
    const Ainv = inverse(A);
    return mul(Ainv, b.map(x => [x])).map(r => round12(r[0]));
  } catch (e) {
    throw new Error('方程组无唯一解：' + e.message);
  }
}

/* ======================== 特征值（幂迭代 + 收缩） ======================== */

function eigenvalues(A) {
  if (A.length !== A[0].length) throw new Error(`特征值要求方阵，当前 ${shape(A)}`);
  const n = A.length;
  let M = clone(A);
  const found = [];
  for (let k = 0; k < n; k++) {
    let v = new Array(n).fill(1 / Math.sqrt(n));
    let lambda = 0;
    for (let iter = 0; iter < 500; iter++) {
      const w = mul(M, v.map(x => [x])).map(r => r[0]);
      const norm = Math.hypot(...w);
      if (norm < 1e-300) break;
      const nv = w.map(x => x / norm);
      const nl = w.map((x, i) => x * nv[i]).reduce((a, b) => a + b, 0);
      if (Math.abs(nl - lambda) < 1e-14) { lambda = nl; v = nv; break; }
      lambda = nl; v = nv;
    }
    found.push(round12(lambda));
    // 收缩：M ← M - λ v vᵀ
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i][j] -= lambda * v[i] * v[j];
    }
  }
  return found.sort((a, b) => b - a);
}

/* ======================== 渲染 ======================== */

function round12(v) {
  if (!isFinite(v)) return v;
  const r = Number(v.toPrecision(12));
  return r === 0 ? 0 : r;
}

function matText(M, opts) {
  // 对齐成表格，便于人读
  const strs = M.map(row => row.map(x => formatValue(round12(x), opts).text));
  const widths = [];
  for (let j = 0; j < strs[0].length; j++) {
    widths[j] = Math.max(...strs.map(r => r[j].length));
  }
  return strs.map(r => '  [ ' + r.map((s, j) => s.padStart(widths[j])).join('  ') + ' ]').join('\n');
}

function wrap(M) { return { M }; }

/* ======================== 主逻辑 ======================== */

function run(args = {}) {
  const op = String(args.op || '').toLowerCase().trim();
  const opts = { precision: args.precision || 12 };

  const USAGE = '用法: calc_matrix(op="...", a=[[..]], b=[[..]])\n\n'
    + '可用运算:\n'
    + '  add / sub        矩阵加减         calc_matrix(op="add", a=[[1,2]], b=[[3,4]])\n'
    + '  mul              矩阵相乘         calc_matrix(op="mul", a=[[1,2],[3,4]], b=[[5,6],[7,8]])\n'
    + '  scale            数乘             calc_matrix(op="scale", a=[[1,2]], k=3)\n'
    + '  transpose        转置             calc_matrix(op="transpose", a=[[1,2],[3,4]])\n'
    + '  det              行列式           calc_matrix(op="det", a=[[1,2],[3,4]])\n'
    + '  inv              逆矩阵           calc_matrix(op="inv", a=[[1,2],[3,4]])\n'
    + '  rank             秩               calc_matrix(op="rank", a=[[1,2],[3,4]])\n'
    + '  trace            迹               calc_matrix(op="trace", a=[[1,2],[3,4]])\n'
    + '  solve            解 Ax=b          calc_matrix(op="solve", a=[[2,3],[1,-1]], b=[8,-1])\n'
    + '  eig              特征值（幂迭代） calc_matrix(op="eig", a=[[2,0],[0,3]])\n\n'
    + '矩阵用二维数组；方程组求解时 b 是一维数组。';

  if (!op) return USAGE;

  const out = [];
  out.push('## calc_matrix');
  out.push('');

  try {
    switch (op) {
      case 'add':
      case 'sub': {
        const A = asMatrix(args.a, 'a'), B = asMatrix(args.b, 'b');
        const C = op === 'add' ? add(A, B) : sub(A, B);
        out.push(`**${op === 'add' ? 'A + B' : 'A - B'}**  (${shape(A)})`);
        out.push('');
        out.push('```');
        out.push(matText(C, opts));
        out.push('```');
        return out.join('\n');
      }
      case 'mul':
      case 'multiply': {
        const A = asMatrix(args.a, 'a'), B = asMatrix(args.b, 'b');
        const C = mul(A, B);
        out.push(`**A × B**  (${shape(A)} × ${shape(B)} = ${shape(C)})`);
        out.push('');
        out.push('```');
        out.push(matText(C, opts));
        out.push('```');
        return out.join('\n');
      }
      case 'scale': {
        const A = asMatrix(args.a, 'a');
        const k = Number(args.k);
        if (!isFinite(k)) return 'scale 需要参数 k（数字），例如 calc_matrix(op="scale", a=[[1,2]], k=3)';
        out.push(`**${k} × A**  (${shape(A)})`);
        out.push('');
        out.push('```');
        out.push(matText(scale(A, k), opts));
        out.push('```');
        return out.join('\n');
      }
      case 'transpose': case 't': {
        const A = asMatrix(args.a, 'a');
        const T = transpose(A);
        out.push(`**Aᵀ**  (${shape(A)} → ${shape(T)})`);
        out.push('');
        out.push('```');
        out.push(matText(T, opts));
        out.push('```');
        return out.join('\n');
      }
      case 'det': case 'determinant': {
        const A = asMatrix(args.a, 'a');
        const d = determinant(A);
        const { text, extra } = formatValue(round12(d), opts);
        out.push(`**det(A)** = **${text}**${extra ? `  _(${extra})_` : ''}　(${shape(A)})`);
        if (Math.abs(d) < 1e-12) {
          out.push('');
          out.push('> 行列式为 0 → 矩阵奇异，不可逆；方程组可能无解或有无穷多解。');
        }
        return out.join('\n');
      }
      case 'inv': case 'inverse': {
        const A = asMatrix(args.a, 'a');
        const I = inverse(A);
        out.push(`**A⁻¹**  (${shape(A)} → ${shape(I)})`);
        out.push('');
        out.push('```');
        out.push(matText(I, opts));
        out.push('```');
        // 验证
        const chk = mul(A, I);
        const err = Math.max(...chk.flat().map((v, i) => Math.abs(v - (Math.floor(i / chk.length) === i % chk.length ? 1 : 0))));
        out.push('');
        out.push(`> 校验 A·A⁻¹ 与单位阵最大偏差: ${err.toExponential(2)}`);
        return out.join('\n');
      }
      case 'rank': {
        const A = asMatrix(args.a, 'a');
        const r = rank(A);
        out.push(`**rank(A)** = **${r}**　(${shape(A)})`);
        return out.join('\n');
      }
      case 'trace': {
        const A = asMatrix(args.a, 'a');
        out.push(`**tr(A)** = **${formatValue(round12(trace(A)), opts).text}**　(${shape(A)})`);
        return out.join('\n');
      }
      case 'solve': {
        const A = asMatrix(args.a, 'a');
        let b = args.b;
        if (Array.isArray(b) && Array.isArray(b[0])) b = b.map(r => r[0]);
        if (!Array.isArray(b)) return 'solve 需要 b（一维数组），例如 calc_matrix(op="solve", a=[[2,3],[1,-1]], b=[8,-1])';
        const x = solve(A, b.map(Number));
        out.push('**解 Ax = b**');
        out.push('');
        out.push('```');
        out.push(matText(A, opts));
        out.push('');
        out.push('  x = [ ' + x.map(v => formatValue(v, opts).text).join(', ') + ' ]');
        out.push('```');
        out.push('');
        x.forEach((v, i) => out.push(`- x${i + 1} = **${formatValue(v, opts).text}**`));
        return out.join('\n');
      }
      case 'eig': case 'eigen': case 'eigenvalues': {
        const A = asMatrix(args.a, 'a');
        const vals = eigenvalues(A);
        out.push(`**特征值**（幂迭代 + 收缩，共 ${vals.length} 个）`);
        out.push('');
        vals.forEach((v, i) => out.push(`${i + 1}. λ${i + 1} = **${formatValue(v, opts).text}**`));
        out.push('');
        out.push('> 幂迭代适合主特征值明显的情况；重根/复特征值可能不准，可用 det(A-λI)=0 自行校验。');
        return out.join('\n');
      }
      default:
        out.push(`未知运算 "${op}"。`);
        out.push('');
        out.push(USAGE);
        return out.join('\n');
    }
  } catch (e) {
    out.push('**错误**: ' + (e.message || e));
    return out.join('\n');
  }
}

module.exports = {
  run, asMatrix, add, sub, mul, scale, transpose, determinant, inverse, rank, trace, solve, eigenvalues
};
