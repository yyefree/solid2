/**
 * 本地规则解析器：中文自然语言 → AiOp[]。
 *
 * 设计原则：
 *   1. **纯函数、零依赖、可离线**：不 import 任何几何内核 / 网络模块，因此主线程可直接用，
 *      也能在 Node 里跑单测（tools/ai-test.ts）。
 *   2. **子句独立解析**：先按标点与连接词切子句，每个子句单独判定「是什么动作」，
 *      互不干扰；这样「A，然后 B」这类复合描述天然支持。
 *   3. **角色化取数**：数字按「前面紧邻的角色词」归类（长/宽/高/半径/直径/深……），
 *      而不是靠位置猜；`60x40x10` 这类连乘写法单独识别成三元组。
 *   4. **读不懂就说**：解析不了的子句进 `issues`，不静默丢弃。
 *
 * 支持的动作见 `types.ts` 的 `AiOp`。典型输入：
 *   - 「60x40x10 的长方体，中心开半径 8 的通孔，四角倒圆角 R5」
 *   - 「半径 20 高 50 的圆柱，上面加一个半径 8 高 10 的圆柱」
 *   - 「边长 30 的立方体，顶面抽壳 2」
 */

import type {
  AiBoolOp,
  AiOp,
  AiPlan,
  EdgeScope,
  ModelProvider,
  ParseIssue,
  Placement,
  PrimitiveKind,
} from './types';

// ============================================================
// 1. 文本归一化
// ============================================================

/**
 * 归一化：全角→半角、统一乘号与直径符号、小写化、去空格。
 * 归一化后所有后续匹配都只需要考虑一种写法。
 */
export function normalizeInput(raw: string): string {
  let s = raw;
  // 全角 ASCII（！～～）→ 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // 全角空格
  s = s.replace(/\u3000/g, ' ');
  // 小写（英文关键词与 R 半径前缀统一）
  // ⚠️ 必须在「直径符号归一」之前：否则 Φ(U+03A6) 会被小写成 φ(U+03C6)，
  //    之后再用 Φ 做角色匹配就永远匹配不上了。
  s = s.toLowerCase();
  // 各种乘号 → x
  s = s.replace(/[×✕✖✗╳∗*]/g, 'x');
  // 各种直径符号 → Φ（此时输入里已是小写 φ / ϕ / ø / ∅）
  s = s.replace(/[φϕ⌀ø∅Φ]/g, 'Φ');
  // 去空白
  s = s.replace(/[ \t\r]+/g, '');
  return s;
}

// ============================================================
// 2. 关键词表（全部小写；使用时按长度降序做最长匹配）
// ============================================================

/** 基本体种类关键词 */
const KIND_WORDS: [string, PrimitiveKind][] = [
  ['长方体', 'box'],
  ['立方体', 'box'],
  ['正方体', 'box'],
  ['矩形体', 'box'],
  ['圆柱体', 'cylinder'],
  ['圆柱', 'cylinder'],
  ['圆盘', 'cylinder'],
  ['圆环体', 'torus'],
  ['圆环', 'torus'],
  ['圆锥体', 'cone'],
  ['圆锥', 'cone'],
  ['球体', 'sphere'],
  ['圆球', 'sphere'],
  ['方块', 'box'],
  ['方体', 'box'],
  ['方板', 'box'],
  ['盒子', 'box'],
  ['箱体', 'box'],
  ['柱体', 'cylinder'],
  ['锥体', 'cone'],
  ['圆柱', 'cylinder'],
  ['板材', 'box'],
  ['平板', 'box'],
  ['盘子', 'cylinder'],
  ['垫片', 'cylinder'],
  ['轴套', 'cylinder'],
  ['block', 'box'],
  ['plate', 'box'],
  ['cuboid', 'box'],
  ['cube', 'box'],
  ['cylinder', 'cylinder'],
  ['sphere', 'sphere'],
  ['cone', 'cone'],
  ['torus', 'torus'],
  ['ball', 'sphere'],
  ['disc', 'cylinder'],
  ['disk', 'cylinder'],
  ['ring', 'torus'],
  ['板', 'box'],
  ['盘', 'cylinder'],
  ['球', 'sphere'],
  ['锥', 'cone'],
  ['轴', 'cylinder'],
];

/** 特征动作关键词（优先于基本体判定） */
const OP_WORDS: [string, string][] = [
  ['倒圆角', 'fillet'],
  ['圆角', 'fillet'],
  ['倒斜角', 'chamfer'],
  ['倒棱', 'chamfer'],
  ['倒角', 'chamfer'],
  ['抽壳', 'shell'],
  ['挖空', 'shell'],
  ['掏空', 'shell'],
  ['薄壁', 'shell'],
  ['通孔', 'hole'],
  ['盲孔', 'hole'],
  ['沉头孔', 'hole'],
  ['埋头孔', 'hole'],
  ['螺纹孔', 'hole'],
  ['钻孔', 'hole'],
  ['打孔', 'hole'],
  ['开孔', 'hole'],
  ['孔', 'hole'],
  ['线性阵列', 'linearPattern'],
  ['直线阵列', 'linearPattern'],
  ['矩形阵列', 'linearPattern'],
  ['圆周阵列', 'circularPattern'],
  ['环形阵列', 'circularPattern'],
  ['阵列', 'linearPattern'],
];

/** 数字角色词（紧贴在数字之前；按长度降序） */
const ROLE_WORDS: [string, string][] = [
  ['直径', 'diameter'],
  ['半径', 'radius'],
  ['深度', 'depth'],
  ['高度', 'height'],
  ['厚度', 'thickness'],
  ['边长', 'side'],
  ['Φ', 'diameter'],
  ['长', 'length'],
  ['宽', 'width'],
  ['高', 'height'],
  ['厚', 'thickness'],
  ['深', 'depth'],
  ['边', 'side'],
  ['r', 'radius'],
];

/** 布尔操作关键词 */
const CUT_WORDS = ['切除', '挖去', '挖掉', '减去', '减掉', '去掉', '去除', '镂空'];
const INTERSECT_WORDS = ['交集', '相交', '共同部分', '公共部分'];

/** 摆放位置关键词 */
const PLACE_WORDS: [string, Placement][] = [
  ['上面', 'top'],
  ['顶部', 'top'],
  ['上表面', 'top'],
  ['顶面', 'top'],
  ['下面', 'bottom'],
  ['底部', 'bottom'],
  ['下表面', 'bottom'],
  ['底面', 'bottom'],
  ['右边', 'right'],
  ['右侧', 'right'],
  ['左边', 'left'],
  ['左侧', 'left'],
  ['前面', 'front'],
  ['前侧', 'front'],
  ['后面', 'back'],
  ['后侧', 'back'],
  ['中心', 'center'],
  ['居中', 'center'],
  ['正中', 'center'],
  ['原点', 'center'],
];

/** 单位 → mm 系数 */
const UNIT_MM: Record<string, number> = {
  mm: 1,
  毫米: 1,
  cm: 10,
  厘米: 10,
  dm: 100,
  分米: 100,
  m: 1000,
  米: 1000,
  km: 1_000_000,
  in: 25.4,
  英寸: 25.4,
  ft: 304.8,
};

const NUM_RE = /(\d+(?:\.\d+)?)(mm|cm|dm|km|in|ft|m|毫米|厘米|分米|米|英寸)?/g;

// ============================================================
// 3. 通用工具
// ============================================================

export interface WordMatch {
  word: string;
  tag: string;
  start: number;
  end: number;
}

/** 按长度降序排序的关键词表（最长匹配优先，避免「圆柱」被「圆」抢先） */
function sortDict<T extends [string, string]>(dict: T[]): T[] {
  return [...dict].sort((a, b) => b[0].length - a[0].length);
}

const KIND_DICT = sortDict(KIND_WORDS as [string, string][]);
const OP_DICT = sortDict(OP_WORDS);
const ROLE_DICT = sortDict(ROLE_WORDS);
const PLACE_DICT = sortDict(PLACE_WORDS as [string, string][]);

/**
 * 从左到右扫描，每到一个位置尝试匹配最长的关键词；命中则记录并跳过，
 * 保证不出现子串重复匹配（如「长方体」不会再匹配到「方体」）。
 */
function scanWords(text: string, dict: [string, string][]): WordMatch[] {
  const out: WordMatch[] = [];
  let i = 0;
  while (i < text.length) {
    let hit: [string, string] | null = null;
    for (const entry of dict) {
      if (text.startsWith(entry[0], i)) {
        hit = entry;
        break;
      }
    }
    if (hit) {
      out.push({ word: hit[0], tag: hit[1], start: i, end: i + hit[0].length });
      i += hit[0].length;
    } else {
      i++;
    }
  }
  return out;
}

/** 把命中的区间替换成占位符 '·'，便于后续只看「没被吃掉」的文本 */
function maskRanges(text: string, ranges: { start: number; end: number }[]): string {
  if (!ranges.length) return text;
  const chars = text.split('');
  for (const r of ranges) {
    for (let i = r.start; i < r.end && i < chars.length; i++) chars[i] = '·';
  }
  return chars.join('');
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/** 取最后一个匹配（用于「A 上面加一个 B」里 B 才是主体） */
function lastKind(kinds: WordMatch[]): PrimitiveKind | null {
  return kinds.length ? (kinds[kinds.length - 1].tag as PrimitiveKind) : null;
}

// ============================================================
// 4. 数字与角色提取
// ============================================================

export interface NumHit {
  value: number;
  role: string | null;
  start: number;
  end: number;
}

/**
 * 提取数字并归类角色。
 * 角色判定：取数字前最多 5 个字符，看是否**以**某个角色词结尾
 * （角色词紧贴数字之前，如「半径8」「高20」「60宽40」里的「宽」）。
 */
function extractNumbers(masked: string): NumHit[] {
  const hits: NumHit[] = [];
  NUM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUM_RE.exec(masked))) {
    const value = parseFloat(m[1]);
    const unit = m[2] ?? 'mm';
    const scale = UNIT_MM[unit] ?? 1;
    const before = masked.slice(Math.max(0, m.index - 5), m.index);
    let role: string | null = null;
    for (const [word, tag] of ROLE_DICT) {
      if (before.endsWith(word)) {
        role = tag;
        break;
      }
    }
    hits.push({ value: value * scale, role, start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

/** 找出用 x 连接的连乘尺寸组（`60x40x10` → 三元组，`20x30` → 二元组） */
function findDimensionGroups(masked: string, hits: NumHit[]): NumHit[][] {
  const groups: NumHit[][] = [];
  let run: NumHit[] = [];
  for (let i = 0; i < hits.length; i++) {
    if (i === 0) {
      run = [hits[i]];
      continue;
    }
    const gap = masked.slice(hits[i - 1].end, hits[i].start);
    if (gap === 'x') run.push(hits[i]);
    else {
      if (run.length >= 2) groups.push(run);
      run = [hits[i]];
    }
  }
  if (run.length >= 2) groups.push(run);
  return groups;
}

// ============================================================
// 5. 子句解析
// ============================================================

function placeOf(text: string): Placement {
  for (const [word, place] of PLACE_DICT) {
    if (text.includes(word)) return place as Placement;
  }
  return 'center';
}

function scopeOf(text: string): EdgeScope {
  if (hasAny(text, ['四角', '四个角', '四边', '四条', '竖向', '立柱', '竖直'])) return 'vertical';
  if (hasAny(text, ['顶面', '上面', '顶部', '上表面', '上边'])) return 'top';
  if (hasAny(text, ['底面', '下面', '底部', '下表面', '下边'])) return 'bottom';
  return 'all';
}

function boolOpOf(text: string, hasPrior: boolean): AiBoolOp {
  if (hasAny(text, CUT_WORDS)) return 'cut';
  if (hasAny(text, INTERSECT_WORDS)) return 'intersect';
  return hasPrior ? 'add' : 'new';
}

/** 取第一个「非连乘组内」的裸数字（按出现顺序） */
function bareNumbers(hits: NumHit[], grouped: Set<NumHit>): number[] {
  return hits.filter((h) => !grouped.has(h)).map((h) => h.value);
}

function byRole(hits: NumHit[], role: string): number[] {
  return hits.filter((h) => h.role === role).map((h) => h.value);
}

interface ClauseCtx {
  clause: string;
  masked: string;
  kinds: WordMatch[];
  ops: WordMatch[];
  hits: NumHit[];
  groups: NumHit[][];
  hasPrior: boolean;
}

/** 解析单个子句 → 0 或 1 个 AiOp（解析不了则返回 issue） */
function parseClause(ctx: ClauseCtx): { op?: AiOp; issue?: ParseIssue } {
  const { clause, masked, kinds, ops, hits, groups, hasPrior } = ctx;
  const grouped = new Set<NumHit>();
  for (const g of groups) for (const h of g) grouped.add(h);
  const bare = bareNumbers(hits, grouped);

  const opTag = ops.length ? ops[ops.length - 1].tag : null;
  const kind = lastKind(kinds);

  // ---------- 特征动作 ----------
  if (opTag) {
    if (opTag === 'hole') {
      const r = (byRole(hits, 'radius')[0] ?? (byRole(hits, 'diameter')[0] ?? 0) / 2) || bare[0];
      if (!r) {
        return { issue: { clause, message: '孔缺少半径或直径（可写「半径8」「Φ16」）', level: 'error' } };
      }
      const through = hasAny(clause, ['通孔', '贯穿', '打通', '通透', '通']) || !byRole(hits, 'depth').length;
      return {
        op: {
          kind: 'hole',
          source: clause,
          radius: r,
          through,
          depth: byRole(hits, 'depth')[0] ?? 10,
          place: placeOf(clause),
        },
      };
    }

    if (opTag === 'fillet' || opTag === 'chamfer') {
      const v = (byRole(hits, 'radius')[0] ?? byRole(hits, 'diameter')[0] / 2) || bare[0];
      if (!v) {
        return {
          issue: {
            clause,
            message: `${opTag === 'fillet' ? '圆角' : '倒角'}缺少尺寸（可写「R5」或「倒角2」）`,
            level: 'error',
          },
        };
      }
      const scope = scopeOf(clause);
      return opTag === 'fillet'
        ? { op: { kind: 'fillet', source: clause, radius: v, scope } }
        : { op: { kind: 'chamfer', source: clause, distance: v, scope } };
    }

    if (opTag === 'shell') {
      const t = byRole(hits, 'thickness')[0] ?? byRole(hits, 'radius')[0] ?? bare[0];
      if (!t) {
        return { issue: { clause, message: '抽壳缺少壁厚（可写「抽壳2」或「壁厚2mm」）', level: 'error' } };
      }
      return {
        op: {
          kind: 'shell',
          source: clause,
          thickness: t,
          open: hasAny(clause, ['底面', '下面', '底部', '下表面']) ? 'bottom' : 'top',
        },
      };
    }

    if (opTag === 'linearPattern' || opTag === 'circularPattern') {
      const countM = /(\d+)\s*个/.exec(clause) ?? /数量(\d+)/.exec(clause);
      const count = countM ? parseInt(countM[1], 10) : 0;
      if (count < 2) {
        return { issue: { clause, message: '阵列需要个数（可写「阵列3个」）', level: 'error' } };
      }
      const spacing = /间距(\d+(?:\.\d+)?)/.exec(clause);
      if (opTag === 'linearPattern') {
        const axis: 'x' | 'y' | 'z' = hasAny(clause, ['沿y', 'y向', '前后'])
          ? 'y'
          : hasAny(clause, ['沿z', 'z向', '竖向', '上下'])
            ? 'z'
            : 'x';
        return {
          op: {
            kind: 'linearPattern',
            source: clause,
            axis,
            spacing: spacing ? parseFloat(spacing[1]) : 20,
            count,
          },
        };
      }
      return {
        op: { kind: 'circularPattern', source: clause, axis: 'z', count, totalAngleDeg: 360 },
      };
    }
  }

  // ---------- 基本体 ----------
  if (kind) {
    const dims = resolvePrimitiveDims(kind, hits, bare, groups);
    if (!dims) {
      return { issue: { clause, message: `「${kindLabel(kind)}」尺寸不完整或无法识别`, level: 'error' } };
    }
    return {
      op: {
        kind,
        source: clause,
        dims,
        operation: boolOpOf(clause, hasPrior),
        place: placeOf(clause),
      },
    };
  }

  // 有数字但没有可识别动作 —— 若是「上面」这类纯位置子句，静默忽略
  if (!hits.length && !clause.trim()) return {};
  if (!hits.length && PLACE_DICT.some(([w]) => clause.includes(w))) return {};

  return { issue: { clause, message: '没有识别出实体类型（如长方体/圆柱/球/孔/圆角）', level: 'warn' } };
}

function kindLabel(kind: PrimitiveKind): string {
  return { box: '长方体', cylinder: '圆柱', sphere: '球', cone: '圆锥', torus: '圆环' }[kind];
}

/**
 * 按种类把「角色化数字 + 裸数字」拼成引擎要的 dims 数组。
 * 返回 null 表示尺寸不足。
 */
function resolvePrimitiveDims(
  kind: PrimitiveKind,
  hits: NumHit[],
  bare: number[],
  groups: NumHit[][]
): number[] | null {
  const triple = groups.find((g) => g.length >= 3);
  const pair = groups.find((g) => g.length === 2);

  if (kind === 'box') {
    if (triple) return triple.slice(0, 3).map((h) => h.value);
    const side = byRole(hits, 'side')[0];
    let dx = byRole(hits, 'length')[0];
    let dy = byRole(hits, 'width')[0];
    let dz = byRole(hits, 'height')[0] ?? byRole(hits, 'thickness')[0];
    if (pair && dx === undefined) {
      dx = pair[0].value;
      dy = pair[1].value;
    }
    if (side !== undefined) {
      dx = dx ?? side;
      dy = dy ?? side;
      dz = dz ?? side;
    }
    const rest = bare.slice();
    const take = () => rest.shift();
    if (dx === undefined) dx = take();
    if (dy === undefined) dy = take();
    if (dz === undefined) dz = take();
    if (dx === undefined || dy === undefined || dz === undefined) return null;
    return [dx, dy, dz];
  }

  if (kind === 'cylinder') {
    const r = byRole(hits, 'radius')[0] ?? (byRole(hits, 'diameter')[0] ?? 0) / 2;
    const h = byRole(hits, 'height')[0] ?? byRole(hits, 'depth')[0] ?? byRole(hits, 'thickness')[0];
    const rest = bare.slice();
    const rr = r || rest.shift();
    const hh = h ?? rest.shift();
    if (!rr || hh === undefined) return null;
    return [rr, hh];
  }

  if (kind === 'sphere') {
    const r = (byRole(hits, 'radius')[0] ?? (byRole(hits, 'diameter')[0] ?? 0) / 2) || bare[0];
    return r ? [r] : null;
  }

  if (kind === 'cone') {
    const r1 = (byRole(hits, 'radius')[0] ?? (byRole(hits, 'diameter')[0] ?? 0) / 2) || bare[0];
    const h = byRole(hits, 'height')[0] ?? bare[1];
    if (!r1 || h === undefined) return null;
    return [r1, 0, h];
  }

  // torus
  const r1 = byRole(hits, 'radius')[0] ?? bare[0];
  const r2 = byRole(hits, 'radius')[1] ?? bare[1];
  if (!r1 || !r2) return null;
  return [r1, r2];
}

// ============================================================
// 6. 主入口
// ============================================================

/** 切子句：标点 + 连接词；刻意不切「加」（否则「上面加一个圆柱」会被切碎）。
 *  句点只在**不紧邻数字**时才当分隔符，否则会把 `0.06` 的小数点切开。 */
const CLAUSE_SPLIT = /[,;!?、。\n]+|\.(?!\d)|然后|接着|并且|同时|以及|再加上|外加/g;

/** 归一化 + 切子句（供 parseText 与 edit.ts 共用） */
export function splitClauses(raw: string): string[] {
  return normalizeInput(raw)
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * 扫描单个子句：抽出「种类词 / 动作词 / 数字（带角色）/ 连乘组」。
 * 这是解析层的公共底座 —— `parseText` 与 `parseEdit` 都建在它上面。
 */
export interface ClauseScan {
  clause: string;
  /** 遮掉种类词与动作词之后的文本（角色词保留，供取数） */
  masked: string;
  kinds: WordMatch[];
  ops: WordMatch[];
  hits: NumHit[];
  groups: NumHit[][];
}

export function scanClause(clause: string): ClauseScan {
  const kinds = scanWords(clause, KIND_DICT);
  const ops = scanWords(clause, OP_DICT);
  // 只把「种类词 + 动作词」遮掉，角色词（半径/长/宽…）必须保留给取数用
  const masked = maskRanges(clause, [...kinds, ...ops]);
  const hits = extractNumbers(masked);
  const groups = findDimensionGroups(masked, hits);
  return { clause, masked, kinds, ops, hits, groups };
}

/** 从一次扫描里取「最后一个基本体种类」（「上面加一个圆柱」里圆柱才是主体） */
export function kindOf(scan: ClauseScan): PrimitiveKind | null {
  return lastKind(scan.kinds);
}

/** 从一次扫描里取「最后一个特征动作」tag（孔 / 圆角 / 抽壳 / 阵列…） */
export function opTagOf(scan: ClauseScan): string | null {
  return scan.ops.length ? scan.ops[scan.ops.length - 1].tag : null;
}

/**
 * 单子句解析入口（`parseText` 与 `edit.ts` 共用）。
 * 已经把 `scanClause` 与 `parseClause` 串好，外部不必再拼 ctx。
 */
export function parseSingleClause(
  clause: string,
  hasPrior = false
): { op?: AiOp; issue?: ParseIssue } {
  return parseClause({ ...scanClause(clause), hasPrior });
}

/** 某子句里是否有基本体 / 特征动作关键词（edit.ts 判断「这是建模描述还是编辑指令」用） */
export function hasModelingWords(clause: string): boolean {
  const scan = scanClause(clause);
  return scan.kinds.length > 0 || scan.ops.length > 0;
}

/**
 * 核心：文本 → AiPlan（同步、纯函数）。
 * `localProvider.plan` 只是把它包成 Promise。
 */
export function parseText(raw: string): AiPlan {
  const clauses = splitClauses(raw);
  const ops: AiOp[] = [];
  const issues: ParseIssue[] = [];

  for (const clause of clauses) {
    const scan = scanClause(clause);
    const r = parseClause({ ...scan, hasPrior: ops.length > 0 });
    if (r.op) ops.push(r.op);
    if (r.issue) issues.push(r.issue);
  }

  return {
    ops,
    issues,
    summary: summarize(ops),
    provider: 'local',
  };
}

/** 生成一句话概括，供 UI 回显「我理解成了什么」 */
export function summarize(ops: AiOp[]): string {
  if (!ops.length) return '没有识别出任何建模动作';
  return ops.map(describeOp).join(' → ');
}

export function describeOp(op: AiOp): string {
  switch (op.kind) {
    case 'box':
      return `长方体 ${fmt(op.dims)}`;
    case 'cylinder':
      return `圆柱 ⌀${fmt([op.dims[0] * 2])}×${op.dims[1]}`;
    case 'sphere':
      return `球 ⌀${fmt([op.dims[0] * 2])}`;
    case 'cone':
      return `圆锥 ⌀${fmt([op.dims[0] * 2])}→⌀${fmt([op.dims[1] * 2])}×${op.dims[2]}`;
    case 'torus':
      return `圆环 R${fmt([op.dims[0]])}/r${fmt([op.dims[1]])}`;
    case 'hole':
      return `${op.through ? '通孔' : `盲孔深${fmt([op.depth])}`} ⌀${fmt([op.radius * 2])}`;
    case 'fillet':
      return `圆角 R${fmt([op.radius])}`;
    case 'chamfer':
      return `倒角 ${fmt([op.distance])}`;
    case 'shell':
      return `抽壳 ${fmt([op.thickness])}`;
    case 'linearPattern':
      return `线性阵列 ${op.count} 个·间距${fmt([op.spacing])}`;
    case 'circularPattern':
      return `圆周阵列 ${op.count} 个`;
  }
}

function fmt(ns: number[]): string {
  return ns.map((n) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(2))).join('×');
}

// ============================================================
// 7. Provider：本地规则解析器
// ============================================================

/** 本地规则解析器（离线可用，恒可用） */
export const localProvider: ModelProvider = {
  id: 'local',
  label: '本地规则解析',
  available: () => true,
  async plan(text: string): Promise<AiPlan> {
    return parseText(text);
  },
};
