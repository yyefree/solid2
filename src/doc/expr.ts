/**
 * 表达式引擎（参考 FreeCAD 的「表达式 / Expressions」）。
 *
 * FreeCAD 最有辨识度的能力：任意数值属性都能写成以 `=` 开头的公式，
 * 公式里可以引用全局命名参数（Spreadsheet 别名）或其他对象的属性，
 * 改一处、整棵特征树自动重算。本模块把这套能力做成**纯计算**的一层：
 *   tokenize → parse（Pratt）→ evaluate（带引用解析）
 * 完全不碰 OCCT / three，因此可在 Node 里直接测试。
 *
 * 语法（FreeCAD 子集）：
 *   数字      12  3.14  .5  1e-3
 *   单位后缀  10mm  2in  30deg  45°        （紧贴数字，长度归一到 mm、角度归一到度）
 *   运算符    + - * / % ^（右结合）  一元 - + not
 *   比较      < > <= >= == !=（也接受单个 =）
 *   逻辑      and or not
 *   函数      sin cos tan asin acos atan atan2 sinh cosh tanh exp log log10
 *             sqrt abs ceil floor round trunc pow mod min max avg sum count
 *   常量      pi  e
 *   引用      参数名                     → 全局参数表
 *            特征名.属性键               → 其他特征的数值参数（如 拉伸1.distance）
 *            特征名.属性键[下标]          → 数组参数元素（如 长方体1.dims[0]）
 *
 * ⚠️ 三角函数按 FreeCAD 惯例以**度**为单位（sin(90) = 1）；反三角返回度。
 *
 * ⚠️ 本文件只 import 类型，不 import `oc` / `solid` / `three` / `mesh`。
 */
import type { Feature } from './types';

// ============================================================
// 错误
// ============================================================
export class ExprError extends Error {
  constructor(message: string, readonly pos = -1) {
    super(message);
    this.name = 'ExprError';
  }
}

// ============================================================
// 词法分析
// ============================================================
type TokKind = 'num' | 'ident' | 'op' | 'punc' | 'eof';

interface Token {
  kind: TokKind;
  text: string;
  value?: number;
  pos: number;
}

/** 紧贴数字的单位后缀 → 换算到规范单位（长度 mm / 角度 deg） */
const LENGTH_UNITS: Record<string, number> = {
  km: 1e6, m: 1000, dm: 100, cm: 10, mm: 1, um: 1e-3, 'µm': 1e-3, nm: 1e-6,
  in: 25.4, ft: 304.8, mil: 0.0254,
};
const ANGLE_UNITS: Record<string, number> = { deg: 1, gon: 0.9, rad: 180 / Math.PI };

const IDENT_START = /[A-Za-z_\u3400-\u4dbf\u4e00-\u9fff]/;
const IDENT_PART = /[A-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff]/;
const DIGIT = /[0-9]/;

/** 双字符运算符（先匹配长的） */
const OPS2 = ['<=', '>=', '==', '!=', '&&', '||'];
const OPS1 = '+-*/%^<>()[],.=';
const PUNCS = '()[],.';

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // 数字（含 .5 形式）
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < n && DIGIT.test(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (i < n && DIGIT.test(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (DIGIT.test(src[i] ?? '')) {
          while (i < n && DIGIT.test(src[i])) i++;
        } else {
          i = save; // 不是指数，回退
        }
      }
      let value = parseFloat(src.slice(start, i));
      // 紧贴的单位后缀（不允许空格，避免与变量名混淆）
      if (src[i] === '°') {
        i++;
      } else {
        const rest = src.slice(i);
        const unit = matchUnit(rest);
        if (unit) {
          value *= unit.factor;
          i += unit.len;
        }
      }
      toks.push({ kind: 'num', text: src.slice(start, i), value, pos: start });
      continue;
    }
    // 标识符（允许中文）
    if (IDENT_START.test(c)) {
      const start = i;
      i++;
      while (i < n && IDENT_PART.test(src[i])) i++;
      const text = src.slice(start, i);
      const low = text.toLowerCase();
      if (low === 'and' || low === 'or' || low === 'not') {
        toks.push({ kind: 'op', text: low, pos: start });
      } else {
        toks.push({ kind: 'ident', text, pos: start });
      }
      continue;
    }
    // 双字符运算符
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      // 支持 && || 作为 and or 的别名
      const text = two === '&&' ? 'and' : two === '||' ? 'or' : two;
      toks.push({ kind: 'op', text, pos: i });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      const kind: TokKind = PUNCS.includes(c) ? 'punc' : 'op';
      toks.push({ kind, text: c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`无法识别的字符「${c}」`, i);
  }
  toks.push({ kind: 'eof', text: '', pos: n });
  return toks;
}

function matchUnit(rest: string): { len: number; factor: number } | null {
  // 长单位优先，避免 m 抢先匹配 mm
  const candidates = [...Object.keys(LENGTH_UNITS), ...Object.keys(ANGLE_UNITS)].sort(
    (a, b) => b.length - a.length
  );
  for (const u of candidates) {
    if (rest.startsWith(u)) {
      // 单位后必须是非标识符字符（数字/字母/中文都不能接），否则是变量名的一部分
      const after = rest[u.length] ?? '';
      if (after && IDENT_PART.test(after)) continue;
      const factor = LENGTH_UNITS[u] ?? ANGLE_UNITS[u];
      return { len: u.length, factor };
    }
  }
  return null;
}

// ============================================================
// 语法树 + 解析（Pratt）
// ============================================================
export type ExprNode =
  | { t: 'num'; v: number }
  | { t: 'ref'; parts: string[]; index?: number }
  | { t: 'call'; name: string; args: ExprNode[] }
  | { t: 'un'; op: string; a: ExprNode }
  | { t: 'bin'; op: string; a: ExprNode; b: ExprNode };

/** 二元运算符结合力（越大越紧）。`^` 单独在 parsePower 里处理（右结合、优先级高于一元负号） */
const BIND: Record<string, number> = {
  or: 1,
  and: 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '==': 3, '!=': 3, '=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
};

export function parse(src: string): ExprNode {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (text: string) => {
    const t = next();
    if (t.text !== text) throw new ExprError(`期望「${text}」，实际是「${t.text || '结尾'}」`, t.pos);
    return t;
  };

  function parseExpr(minBind = 0): ExprNode {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.kind !== 'op') break;
      const bind = BIND[t.text];
      if (bind === undefined || bind <= minBind) break;
      next();
      const right = parseExpr(bind);
      left = { t: 'bin', op: t.text, a: left, b: right };
    }
    return left;
  }

  function parseUnary(): ExprNode {
    const t = peek();
    if (t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === 'not')) {
      next();
      return { t: 'un', op: t.text, a: parseUnary() };
    }
    return parsePower();
  }

  /** 幂：右结合，且优先级高于一元负号（-2^2 = -(2^2) = -4） */
  function parsePower(): ExprNode {
    const base = parsePostfix();
    if (peek().kind === 'op' && peek().text === '^') {
      next();
      const exp = parseUnary(); // 允许 2^-3，并保证右结合
      return { t: 'bin', op: '^', a: base, b: exp };
    }
    return base;
  }

  function parsePostfix(): ExprNode {
    let node = parsePrimary();
    while (peek().kind === 'punc' && peek().text === '[') {
      if (node.t !== 'ref') throw new ExprError('只有属性引用可以带下标', peek().pos);
      next();
      const idxTok = next();
      if (idxTok.kind !== 'num') throw new ExprError('下标必须是整数', idxTok.pos);
      const idx = idxTok.value ?? 0;
      if (!Number.isInteger(idx) || idx < 0) throw new ExprError('下标必须是非负整数', idxTok.pos);
      node = { t: 'ref', parts: node.parts, index: idx };
      expect(']');
    }
    return node;
  }

  function parsePrimary(): ExprNode {
    const t = next();
    if (t.kind === 'num') return { t: 'num', v: t.value ?? 0 };
    if (t.kind === 'punc' && t.text === '(') {
      const e = parseExpr(0);
      expect(')');
      return e;
    }
    if (t.kind === 'ident') {
      // 函数调用
      if (peek().kind === 'punc' && peek().text === '(') {
        next();
        const args: ExprNode[] = [];
        if (!(peek().kind === 'punc' && peek().text === ')')) {
          args.push(parseExpr(0));
          while (peek().kind === 'punc' && peek().text === ',') {
            next();
            args.push(parseExpr(0));
          }
        }
        expect(')');
        return { t: 'call', name: t.text, args };
      }
      // 属性引用：A.B.C
      const parts = [t.text];
      while (peek().kind === 'punc' && peek().text === '.') {
        next();
        const seg = next();
        if (seg.kind !== 'ident' && seg.kind !== 'num') {
          throw new ExprError('属性名无效', seg.pos);
        }
        parts.push(seg.text);
      }
      return { t: 'ref', parts };
    }
    throw new ExprError(`表达式不完整（遇到「${t.text || '结尾'}」）`, t.pos);
  }

  const node = parseExpr(0);
  const tail = peek();
  if (tail.kind !== 'eof') throw new ExprError(`多余的内容「${tail.text}」`, tail.pos);
  return node;
}

// ============================================================
// 求值
// ============================================================
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const DEG = Math.PI / 180;
const toDeg = (r: number) => r / DEG;

type Fn1 = (x: number) => number;
const FN1: Record<string, Fn1> = {
  sin: (x) => Math.sin(x * DEG),
  cos: (x) => Math.cos(x * DEG),
  tan: (x) => Math.tan(x * DEG),
  asin: (x) => toDeg(Math.asin(x)),
  acos: (x) => toDeg(Math.acos(x)),
  atan: (x) => toDeg(Math.atan(x)),
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, log: Math.log, log10: Math.log10,
  sqrt: Math.sqrt, abs: Math.abs,
  ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc,
};

/** 引用解析回调：给定引用路径返回数值；找不到时抛 ExprError */
export type RefResolver = (parts: string[], index: number | undefined) => number;

export function evaluate(node: ExprNode, resolve: RefResolver): number {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'ref': {
      // 常量（pi / e）在引擎内解析，无需外部 resolver
      if (node.parts.length === 1) {
        const c = CONSTS[node.parts[0].toLowerCase()];
        if (c !== undefined) return c;
      }
      return resolve(node.parts, node.index);
    }
    case 'un': {
      const v = evaluate(node.a, resolve);
      if (node.op === '-') return -v;
      if (node.op === '+') return v;
      return v ? 0 : 1; // not
    }
    case 'call':
      return callFn(node.name, node.args.map((a) => evaluate(a, resolve)));
    case 'bin': {
      const op = node.op;
      // 短路逻辑
      if (op === 'and') return evaluate(node.a, resolve) && evaluate(node.b, resolve) ? 1 : 0;
      if (op === 'or') return evaluate(node.a, resolve) || evaluate(node.b, resolve) ? 1 : 0;
      const a = evaluate(node.a, resolve);
      const b = evaluate(node.b, resolve);
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw new ExprError('除数为 0');
          return a / b;
        case '%':
          if (b === 0) throw new ExprError('取模的除数为 0');
          return a % b;
        case '^': return Math.pow(a, b);
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '==': case '=': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        default: throw new ExprError(`未知运算符「${op}」`);
      }
    }
  }
}

function callFn(name: string, args: number[]): number {
  const low = name.toLowerCase();
  if (low in FN1) {
    if (args.length !== 1) throw new ExprError(`${name}() 需要 1 个参数`);
    return FN1[low](args[0]);
  }
  switch (low) {
    case 'atan2':
      if (args.length !== 2) throw new ExprError('atan2() 需要 2 个参数');
      return toDeg(Math.atan2(args[0], args[1]));
    case 'pow':
      if (args.length !== 2) throw new ExprError('pow() 需要 2 个参数');
      return Math.pow(args[0], args[1]);
    case 'mod':
      if (args.length !== 2) throw new ExprError('mod() 需要 2 个参数');
      return args[0] % args[1];
    case 'min': return Math.min(...need(args, 1, 'min'));
    case 'max': return Math.max(...need(args, 1, 'max'));
    case 'sum': return args.reduce((a, b) => a + b, 0);
    case 'avg': case 'average':
      return args.length ? args.reduce((a, b) => a + b, 0) / args.length : NaN;
    case 'count': return args.length;
    default:
      throw new ExprError(`未知函数「${name}()」`);
  }
}

function need(args: number[], n: number, name: string): number[] {
  if (args.length < n) throw new ExprError(`${name}() 至少需要 ${n} 个参数`);
  return args;
}

/** 解析并求值一条表达式 */
export function evalExpression(src: string, resolve: RefResolver): number {
  return evaluate(parse(src), resolve);
}

/** 收集表达式引用到的所有标识符（不含函数名与常量） */
export function collectRefs(node: ExprNode, out: string[][] = []): string[][] {
  switch (node.t) {
    case 'ref':
      out.push(node.parts);
      break;
    case 'un':
      collectRefs(node.a, out);
      break;
    case 'bin':
      collectRefs(node.a, out);
      collectRefs(node.b, out);
      break;
    case 'call':
      for (const a of node.args) collectRefs(a, out);
      break;
  }
  return out;
}

// ============================================================
// 参数路径（用于特征属性引用与 expressions 键）
// ============================================================
/** 读取 `dims[0]` / `distance` 这类路径的值 */
export function getParamPath(params: any, path: string): number | undefined {
  const m = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(path);
  if (!m) return undefined;
  const v = params?.[m[1]];
  if (m[2] === undefined) return typeof v === 'number' ? v : undefined;
  const i = parseInt(m[2], 10);
  return Array.isArray(v) && typeof v[i] === 'number' ? v[i] : undefined;
}

/** 写入 `dims[0]` / `distance` 这类路径 */
export function setParamPath(params: any, path: string, value: number): boolean {
  const m = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(path);
  if (!m) return false;
  if (m[2] === undefined) {
    params[m[1]] = value;
    return true;
  }
  const i = parseInt(m[2], 10);
  if (!Array.isArray(params[m[1]])) return false;
  params[m[1]][i] = value;
  return true;
}

/** 常用参数键的中文标签（表达式对话框里更友好） */
export const PARAM_LABEL: Record<string, string> = {
  distance: '距离', radius: '半径', radius2: '终止半径', angleDeg: '角度 (°)',
  thickness: '厚度', depth: '深度', diameter: '直径', spacing: '间距', count: '数量',
  totalAngleDeg: '总角度 (°)', factor: '缩放系数', width: '宽度', pitch: '螺距',
  turns: '圈数', meanDiameter: '中径', wireDiameter: '线径', startRadius: '起始半径',
  boreDiameter: '沉头直径', boreDepth: '沉头深度', sinkDiameter: '锥沉直径',
  sinkDepth: '锥沉深度', draft: '拔模角 (°)', dims: '尺寸', factors: '各轴系数',
};

/** 列出特征里所有「标量 / 数组元素」数值参数（供表达式对话框选择） */
export function listNumericParams(params: any): { path: string; label: string; value: number }[] {
  const out: { path: string; label: string; value: number }[] = [];
  if (!params || typeof params !== 'object') return out;
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (typeof v === 'number') {
      out.push({ path: key, label: PARAM_LABEL[key] ?? key, value: v });
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
      for (let i = 0; i < v.length; i++) {
        out.push({ path: `${key}[${i}]`, label: `${PARAM_LABEL[key] ?? key} ${i + 1}`, value: v[i] });
      }
    }
  }
  return out;
}

// ============================================================
// 文档级解析（参数表 + 特征表达式，含依赖拓扑与环检测）
// ============================================================
export interface ParamDef {
  /** 参数名（表达式里直接引用该名字） */
  name: string;
  /** 表达式（可写 `=公式` 或直接写公式） */
  expr: string;
  /** 备注 */
  comment?: string;
}

export interface ExprIssue {
  /** 位置：`参数:板厚` 或 `特征:拉伸1.distance` */
  where: string;
  message: string;
}

export interface ResolveResult {
  /** 解析后的特征（深拷贝，数值已替换为具体值） */
  features: Feature[];
  /** 参数名 → 数值 */
  paramValues: Record<string, number>;
  /** 全部问题 */
  issues: ExprIssue[];
  /** 按特征聚合的问题（供特征树标红） */
  featureIssues: { id: string; message: string }[];
}

interface DocLike {
  features: Feature[];
  params?: ParamDef[];
}

/** 去掉可选的 `=` 前缀 */
function stripEq(expr: string): string {
  const t = expr.trim();
  return t.startsWith('=') ? t.slice(1) : t;
}

export function resolveExpressions(doc: DocLike): ResolveResult {
  const features = doc.features ?? [];
  const params = doc.params ?? [];
  const issues: ExprIssue[] = [];
  const paramValues: Record<string, number> = {};
  const featureIssues: { id: string; message: string }[] = [];

  const byName = new Map<string, Feature>();
  for (const f of features) if (!byName.has(f.name)) byName.set(f.name, f);

  // 单元格：参数 或 特征属性。惰性求值 + 栈检测环。
  const cache = new Map<string, number>();
  const visiting = new Set<string>();

  const paramCell = (name: string) => `@p:${name}`;
  const featCell = (id: string, path: string) => `@f:${id}:${path}`;

  function resolveRef(parts: string[], index: number | undefined, from: string): number {
    if (parts.length === 1) {
      const name = parts[0];
      const low = name.toLowerCase();
      if (low in CONSTS) return CONSTS[low];
      const def = params.find((p) => p.name === name);
      if (def) return evalParam(def, from);
      // 也可能直接引用某个特征（无属性名）——不合法，明确报错
      throw new ExprError(`未知参数「${name}」`);
    }
    const fname = parts[0];
    const prop = parts.slice(1).join('.');
    const f = byName.get(fname);
    if (!f) throw new ExprError(`未知特征「${fname}」`);
    const path = index === undefined ? prop : `${prop}[${index}]`;
    return evalFeatureProp(f, path, from);
  }

  function evalParam(def: ParamDef, from: string): number {
    const key = paramCell(def.name);
    if (cache.has(key)) return cache.get(key)!;
    if (visiting.has(key)) throw new ExprError(`循环引用：参数「${def.name}」`);
    visiting.add(key);
    try {
      const v = evalExprText(def.expr, `参数:${def.name}`);
      if (!Number.isFinite(v)) throw new ExprError('结果不是有限数');
      cache.set(key, v);
      paramValues[def.name] = v;
      return v;
    } finally {
      visiting.delete(key);
      void from;
    }
  }

  function evalFeatureProp(f: Feature, path: string, from: string): number {
    const key = featCell(f.id, path);
    if (cache.has(key)) return cache.get(key)!;
    if (visiting.has(key)) throw new ExprError(`循环引用：${f.name}.${path}`);
    const expr = (f as any).expressions?.[path];
    if (expr === undefined) {
      // 无表达式 → 直接用字面值
      const lit = getParamPath(f.params, path);
      if (lit === undefined) throw new ExprError(`${f.name} 没有数值属性「${path}」`);
      cache.set(key, lit);
      return lit;
    }
    visiting.add(key);
    try {
      const v = evalExprText(expr, `特征:${f.name}.${path}`);
      if (!Number.isFinite(v)) throw new ExprError('结果不是有限数');
      cache.set(key, v);
      return v;
    } finally {
      visiting.delete(key);
      void from;
    }
  }

  function evalExprText(expr: string, where: string): number {
    const src = stripEq(expr);
    if (!src) throw new ExprError('表达式为空');
    let node: ExprNode;
    try {
      node = parse(src);
    } catch (e) {
      throw new ExprError(`解析失败：${(e as Error).message}`);
    }
    try {
      return evaluate(node, (parts, index) => resolveRef(parts, index, where));
    } catch (e) {
      throw new ExprError((e as Error).message);
    }
  }

  // 1) 求值所有参数（也顺带把它们写入 paramValues）
  for (const def of params) {
    try {
      evalParam(def, paramCell(def.name));
    } catch (e) {
      issues.push({ where: `参数:${def.name}`, message: (e as Error).message });
    }
  }

  // 2) 求值所有特征表达式，并生成解析后的特征
  const outFeatures: Feature[] = features.map((f) => JSON.parse(JSON.stringify(f)) as Feature);
  const outById = new Map(outFeatures.map((f) => [f.id, f]));
  for (const f of features) {
    const ex = (f as any).expressions as Record<string, string> | undefined;
    if (!ex) continue;
    for (const path of Object.keys(ex)) {
      try {
        const v = evalFeatureProp(f, path, featCell(f.id, path));
        setParamPath(outById.get(f.id)!.params, path, v);
      } catch (e) {
        const msg = (e as Error).message;
        issues.push({ where: `特征:${f.name}.${path}`, message: msg });
        featureIssues.push({ id: f.id, message: `${path}：${msg}` });
      }
    }
  }

  return { features: outFeatures, paramValues, issues, featureIssues };
}

/** 便捷：只求值一条表达式（给定全局参数与特征表），供 UI 预览用 */
export function previewExpression(
  src: string,
  doc: DocLike,
  extra?: { params?: ParamDef[] }
): { ok: boolean; value?: number; message?: string } {
  const probe: DocLike = { features: doc.features ?? [], params: extra?.params ?? doc.params ?? [] };
  try {
    const r = resolveExpressions({ ...probe, features: [] });
    void r;
    // 把表达式伪装成一个临时参数求值，复用同一套引用解析
    const tmp: ParamDef = { name: '__probe__', expr: src };
    const res = resolveExpressions({ features: probe.features, params: [...probe.params, tmp] });
    const bad = res.issues.find((i) => i.where === '参数:__probe__');
    if (bad) return { ok: false, message: bad.message };
    const v = res.paramValues['__probe__'];
    if (v === undefined) return { ok: false, message: '无法求值' };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
