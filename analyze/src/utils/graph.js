'use strict';
/**
 * 代码知识图谱：存储 + 查询原语
 *
 * 数据模型（两张表 + 一张索引）：
 *   - cards   符号节点：{ id, name, kind, file, line, col, container, exported, params, doc, lang }
 *   - edges   关系边：  { from, to, kind, file, line }
 *   - byName  名字 → 符号 id 列表（跨文件同名符号靠它做归属判定）
 *
 * 边类型：
 *   contains    文件 → 它定义的符号（结构）
 *   imports     文件 → 文件名（模块依赖）
 *   include     文件 → 文件名（C/C++ 头文件）
 *   calls       符号 → 符号（调用关系，本工具集最有价值的一条边）
 *   extends     符号 → 符号（继承）
 *   implements  符号 → 符号（实现接口）
 *   type-ref    符号 → 符号（类型引用）
 *   defines     文件 → 符号（同 contains，语义更贴近"定义"）
 *
 * 设计取舍：**不做真正的跨文件类型推断**。零依赖下要 100% 准确知道
 * `foo()` 调的是哪个文件的 foo 是不可能的（重载、动态派发、同名遮蔽）。
 * 所以解析策略是"就近优先"：
 *   1) 同文件内有同名符号 → 连同文件（最强的确定性）
 *   2) 该文件 import 过的名字 → 连到对应模块文件里的同名符号
 *   3) 全局唯一同名符号 → 连它
 *   4) 都不满足 → 落成"未解析调用"，单独统计，绝不乱连线
 * 这样得到的图可能有遗漏，但**几乎不会有假边**——对 Agent 来说，
 * 一条假的调用链比缺一条更致命。
 */

const path = require('path');

/**
 * 成员调用（`a.b(`）的目标只可能是这些类型。
 * 把普通 variable 排除在外，是因为 `arr.filter()` 里的 filter
 * 和某个叫 filter 的局部变量毫无关系——连上就是假边。
 */
const METHOD_KINDS = new Set(['method', 'property', 'function', 'field']);

class Graph {
  constructor() {
    this.cards = [];              // 符号节点
    this.edges = [];              // 关系边
    this.files = new Map();       // 相对路径 → 文件元信息
    this.byName = new Map();      // 名字 → 节点下标数组
    this.unresolved = [];         // 无法归属的调用点
    this.builtAt = null;
    this.root = null;
    this.errors = [];             // 解析失败的文件
    this.extIndex = new Map();    // 扩展名 → 文件数（统计用）
  }

  /* ---------------- 构建 ---------------- */

  /**
   * 登记一个文件及其解析结果
   * @param {string} rel      仓库相对路径（统一用 / 分隔）
   * @param {object} parsed   { symbols, imports, calls, refs, moduleVars, lang }
   */
  addFile(rel, parsed) {
    const lang = parsed.lang || null;
    this.files.set(rel, {
      rel,
      lang,
      symbolCount: 0,
      lineCount: parsed.lineCount || 0,
      size: parsed.size || 0
    });
    const ext = path.extname(rel).toLowerCase() || '(none)';
    this.extIndex.set(ext, (this.extIndex.get(ext) || 0) + 1);

    const fileNodeIdx = this._addNode({
      name: rel,
      kind: 'file',
      file: rel,
      line: 1,
      lang
    });

    // 符号 → 节点
    const localIdx = new Map();   // 名字 → 节点下标数组（本文件内）
    for (const s of parsed.symbols || []) {
      const idx = this._addNode({
        name: s.name,
        kind: s.kind,
        file: rel,
        line: s.line,
        pos: s.pos,
        container: s.container || null,
        exported: !!s.exported,
        params: s.params || [],
        typeName: s.typeName || null,
        doc: s.doc || '',
        lang
      });
      this._addEdge(fileNodeIdx, idx, 'contains', rel, s.line);
      if (!localIdx.has(s.name)) localIdx.set(s.name, []);
      localIdx.get(s.name).push(idx);
    }
    this.files.get(rel).symbolCount = (parsed.symbols || []).length;

    // 文件 → 文件 依赖
    for (const im of parsed.imports || []) {
      this._addFileRef(rel, im.from, im.kind, im.line);
    }

    // 待解析的关系（需要跨文件，留到 finalize 统一处理）
    this._pending = this._pending || [];
    for (const r of parsed.refs || []) {
      if (!r.name) continue;
      this._pending.push({
        kind: r.kind,
        name: r.name,
        file: rel,
        line: r.line,
        module: r.module || null,
        fromContainer: r.from || null
      });
    }
    for (const c of parsed.calls || []) {
      this._pending.push({
        kind: 'calls',
        name: c.name,
        file: rel,
        line: c.line,
        from: c.from || null,
        member: !!c.member
      });
    }
  }

  /** 记录一条文件级依赖（目标可能不在索引里，也要记下来） */
  _addFileRef(fromRel, target, kind, line) {
    const edgeKind = (kind === 'include-system' || kind === 'include-local') ? 'include' : 'imports';
    const fromIdx = this.files.has(fromRel) ? this._fileNodeIdx(fromRel) : -1;
    // 记录原始目标串，等 finalize 时尽量解析成真实文件
    this._fileRefs = this._fileRefs || [];
    this._fileRefs.push({ from: fromRel, fromIdx, target, kind: edgeKind, rawKind: kind, line });
  }

  _fileNodeIdx(rel) {
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      if (c.kind === 'file' && c.file === rel) return i;
    }
    return -1;
  }

  _addNode(card) {
    const idx = this.cards.length;
    this.cards.push(card);
    if (!this.byName.has(card.name)) this.byName.set(card.name, []);
    this.byName.get(card.name).push(idx);
    return idx;
  }

  _addEdge(from, to, kind, file, line) {
    if (from < 0 || to < 0 || from === to) return;
    this.edges.push({ from, to, kind, file, line });
  }

  /* ---------------- 终结：解析跨文件引用 ---------------- */

  /**
   * 所有文件登记完毕后调用：把 pending 里的调用/继承/类型引用
   * 解析成真实的节点-节点边。
   * @param {Map<string,string[]>} importMap 文件 → 其 import 的原始模块串列表
   */
  finalize(fileResolver) {
    // 1) 文件级依赖：把 import 串解析成真实文件
    for (const fr of (this._fileRefs || [])) {
      const target = fileResolver ? fileResolver(fr.from, fr.target) : null;
      if (!target) continue;
      const toIdx = this._fileNodeIdx(target);
      if (toIdx >= 0) this._addEdge(fr.fromIdx, toIdx, fr.kind, fr.from, fr.line);
    }

    // 2) 符号级关系
    for (const p of (this._pending || [])) {
      const resolved = this._resolveRef(p);
      if (!resolved) {
        if (p.kind === 'calls') this.unresolved.push({ name: p.name, file: p.file, line: p.line });
        continue;
      }
      const fromIdx = p.kind === 'calls'
        ? this._resolveSource(p)
        : this._containerOrFile(p.file, p.fromContainer);
      if (fromIdx < 0) continue;
      const edgeKind = p.kind === 'import'
        ? 'imports'
        : p.kind === 'extends' ? 'extends'
          : p.kind === 'implements' ? 'implements'
            : p.kind === 'type-ref' ? 'type-ref'
              : p.kind;
      this._addEdge(fromIdx, resolved, edgeKind, p.file, p.line);
    }

    // 去重：同一 (from,to,kind,line) 只留一条
    const seen = new Set();
    this.edges = this.edges.filter(e => {
      const k = e.from + '|' + e.to + '|' + e.kind + '|' + e.line;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    this.builtAt = new Date().toISOString();
    return this;
  }

  _containerOrFile(file, containerName) {
    if (containerName) {
      const idx = this._findSymbol(containerName, file, null);
      if (idx >= 0) return idx;
    }
    return this._fileNodeIdx(file);
  }

  /**
   * 按名字找符号，优先同文件。
   * @param {string} name
   * @param {string|null} preferFile
   * @param {string|null} preferContainer
   * @param {Set<string>|null} kinds 限定目标类型；成员调用只能命中方法/属性
   */
  _findSymbol(name, preferFile, preferContainer, kinds) {
    let list = this.byName.get(name);
    if (!list || !list.length) return -1;
    if (kinds) {
      list = list.filter(i => kinds.has(this.cards[i].kind));
      if (!list.length) return -1;
    }
    if (preferFile) {
      const same = list.filter(i => this.cards[i].file === preferFile);
      if (preferContainer) {
        const both = same.find(i => this.cards[i].container === preferContainer);
        if (both !== undefined) return both;
      }
      if (same.length) {
        // 同文件多个同名：优先非 file 节点
        return same.find(i => this.cards[i].kind !== 'file') ?? same[0];
      }
    }
    // 跨文件：只在全局唯一时连边，避免乱连
    const globals = list.filter(i => this.cards[i].kind !== 'file');
    return globals.length === 1 ? globals[0] : -1;
  }

  /** 解析一条引用：返回目标节点下标，解析不了返回 -1 */
  _resolveRef(p) {
    // 成员调用（`x.filter(...)`）只可能指向方法/属性，不可能指向某个局部变量。
    // 不加这条限制的话，`arr.filter(...)` 会被连到任意一个名叫 filter 的变量上，
    // 制造出假枢纽——这类假边对调用链分析的伤害比缺边大得多。
    const kinds = p.kind === 'calls' && p.member
      ? METHOD_KINDS
      : null;

    // 同文件优先：先在调用点所在文件里找同名符号
    const same = this._findSymbol(p.name, p.file, p.from, kinds);
    if (same >= 0) return same;
    // 跨文件：仅当全局唯一（且类型相容）
    return this._findSymbol(p.name, null, null, kinds);
  }

  /**
   * 找"发起调用/引用的那个符号"。
   * 调用点归属很重要：`a()` 写在 foo() 里，from 就应该是 foo，而不是整个文件。
   * 找不到就退回文件节点——宁可粒度粗一点，也不要丢边。
   */
  _resolveSource(p) {
    if (p.from) {
      const idx = this._findSymbol(p.from, p.file, null);
      if (idx >= 0) return idx;
    }
    return this._fileNodeIdx(p.file);
  }

  /* ---------------- 查询原语 ---------------- */

  /** 按名字/关键字搜符号 */
  findSymbol(query, opts = {}) {
    const q = String(query || '').toLowerCase();
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    const fileFilter = opts.file ? String(opts.file).toLowerCase() : null;
    const out = [];
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      if (c.kind === 'file') continue;
      if (kinds && !kinds.has(c.kind)) continue;
      if (fileFilter && !c.file.toLowerCase().includes(fileFilter)) continue;
      const nm = c.name.toLowerCase();
      let score = -1;
      if (nm === q) score = 100;
      else if (nm.startsWith(q)) score = 80;
      else if (nm.includes(q)) score = 60;
      else if ((c.doc || '').toLowerCase().includes(q)) score = 30;
      if (score < 0) continue;
      if (opts.exportedOnly && !c.exported) continue;
      out.push({ idx: i, card: c, score });
    }
    out.sort((a, b) => b.score - a.score || a.card.name.length - b.card.name.length || a.card.name.localeCompare(b.card.name));
    return out;
  }

  /** 某符号的所有出入边 */
  refsOf(idx) {
    const incoming = this.edges.filter(e => e.to === idx);
    const outgoing = this.edges.filter(e => e.from === idx);
    return { incoming, outgoing };
  }

  /** 谁调用了它（incoming calls） */
  callersOf(idx) {
    return this.edges.filter(e => e.to === idx && e.kind === 'calls');
  }

  /** 它调用了谁（outgoing calls） */
  calleesOf(idx) {
    return this.edges.filter(e => e.from === idx && e.kind === 'calls');
  }

  /** 某文件依赖谁 / 被谁依赖 */
  depsOf(file, direction = 'out') {
    const idx = this._fileNodeIdx(file);
    if (idx < 0) return { out: [], in: [] };
    const out = this.edges.filter(e => e.from === idx && (e.kind === 'imports' || e.kind === 'include'));
    const inn = this.edges.filter(e => e.to === idx && (e.kind === 'imports' || e.kind === 'include'));
    return { out, in: inn };
  }

  /** 从 a 到 b 的最短路径（BFS，跨文件调用链） */
  shortestPath(fromIdx, toIdx, kinds) {
    const allow = kinds ? new Set(kinds) : null;
    const adj = new Map();
    for (const e of this.edges) {
      if (allow && !allow.has(e.kind)) continue;
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e);
    }
    const prev = new Map();
    const queue = [fromIdx];
    const visited = new Set([fromIdx]);
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toIdx) break;
      for (const e of (adj.get(cur) || [])) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        prev.set(e.to, { from: cur, edge: e });
        queue.push(e.to);
      }
    }
    if (!visited.has(toIdx)) return null;
    const path = [];
    let cur = toIdx;
    while (cur !== fromIdx) {
      const p = prev.get(cur);
      if (!p) break;
      path.unshift(p.edge);
      cur = p.from;
    }
    return path;
  }

  /** 影响面：改了它会波及谁（反向可达） */
  impactOf(idx, kinds, maxDepth = 5) {
    const allow = kinds ? new Set(kinds) : new Set(['calls', 'extends', 'implements', 'type-ref', 'imports', 'include']);
    const rev = new Map();
    for (const e of this.edges) {
      if (!allow.has(e.kind)) continue;
      if (!rev.has(e.to)) rev.set(e.to, []);
      rev.get(e.to).push(e);
    }
    const levels = [];
    let frontier = [idx];
    const seen = new Set([idx]);
    for (let d = 0; d < maxDepth; d++) {
      const next = [];
      const hits = [];
      for (const cur of frontier) {
        for (const e of (rev.get(cur) || [])) {
          if (seen.has(e.from)) continue;
          seen.add(e.from);
          hits.push(e);
          next.push(e.from);
        }
      }
      if (!hits.length) break;
      levels.push({ depth: d + 1, edges: hits });
      frontier = next;
    }
    return levels;
  }

  /** 图统计 */
  stats() {
    const byKind = {};
    const byLang = {};
    const byEdge = {};
    for (const c of this.cards) {
      if (c.kind === 'file') continue;
      byKind[c.kind] = (byKind[c.kind] || 0) + 1;
      if (c.lang) byLang[c.lang] = (byLang[c.lang] || 0) + 1;
    }
    for (const e of this.edges) byEdge[e.kind] = (byEdge[e.kind] || 0) + 1;
    // 中心度：按出边+入边数排的 top 符号
    const deg = new Map();
    for (const e of this.edges) {
      if (e.kind === 'contains' || e.kind === 'imports' || e.kind === 'include') continue;
      deg.set(e.from, (deg.get(e.from) || 0) + 1);
      deg.set(e.to, (deg.get(e.to) || 0) + 1);
    }
    const top = [...deg.entries()]
      .map(([i, d]) => ({ card: this.cards[i], degree: d }))
      .filter(x => x.card && x.card.kind !== 'file')
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 20);
    return {
      files: this.files.size,
      symbols: this.cards.filter(c => c.kind !== 'file').length,
      edges: this.edges.length,
      unresolvedCalls: this.unresolved.length,
      byKind,
      byLang,
      byEdge,
      topDegree: top,
      builtAt: this.builtAt,
      root: this.root,
      errors: this.errors
    };
  }

  /** 序列化（供磁盘缓存） */
  toJSON() {
    return {
      version: 1,
      root: this.root,
      builtAt: this.builtAt,
      cards: this.cards,
      edges: this.edges,
      unresolved: this.unresolved,
      errors: this.errors,
      files: [...this.files.entries()],
      byName: [...this.byName.entries()],
      extIndex: [...this.extIndex.entries()]
    };
  }

  static fromJSON(obj) {
    const g = new Graph();
    g.root = obj.root;
    g.builtAt = obj.builtAt;
    g.cards = obj.cards || [];
    g.edges = obj.edges || [];
    g.unresolved = obj.unresolved || [];
    g.errors = obj.errors || [];
    g.files = new Map(obj.files || []);
    g.byName = new Map(obj.byName || []);
    g.extIndex = new Map(obj.extIndex || []);
    return g;
  }
}

module.exports = { Graph };
