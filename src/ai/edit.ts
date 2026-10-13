/**
 * AI 编辑现有模型 —— 在已有特征树之上做「追加 / 改尺寸 / 删除」。
 *
 * 与 `parse.ts + compile.ts`（从零建模型）的关系：
 *
 *   编辑指令 ──(parseEdit)──▶ AiEdit[] ──(applyEdits)──▶ 新的 Feature[]
 *
 * - `append` 复用编译层，但把**现有模型的包围盒**作为起始基准传进 `compilePlan`，
 *   于是「再加一个圆柱」「打个孔」能相对已有实体正确落位；
 * - `resize` / `delete` 直接在特征数组上原地改 / 删，不需要几何内核；
 * - 全过程纯计算、零内核依赖，可在 Node 里单测。
 *
 * 删除时会顺手**剪掉悬空引用**（阵列的种子、拉伸引用的草图……），
 * 避免留下一条注定求值失败的特征。
 */

import type { EdgeRef, Feature, PrimitiveFeature } from '../doc/types';
import { FEATURE_LABEL } from '../doc/types';
import {
  boxEdges,
  boxFace,
  compilePlan,
  DEFAULT_LABELS,
  edgeLimit,
  mirrorBox,
  primitiveBounds,
  scaleBox,
  spiralBounds,
  springBounds,
  unionBox,
  type Box,
  type CompileResult,
} from './compile';
import {
  hasModelingWords,
  kindOf,
  normalizeInput,
  opTagOf,
  parseHoleDetail,
  parseSingleClause,
  scanClause,
  splitClauses,
  summarize,
  applyModifierTo,
} from './parse';
import type { AiHoleOp, AiOp, ParseIssue, PrimitiveKind, Vec3 } from './types';

// ============================================================
// 1. 编辑意图（IR）
// ============================================================

/** 编辑目标：描述「改/删哪一个特征」 */
export interface EditTarget {
  /** 特征类型（'hole' | 'fillet' | 'primitive' | 'linearPattern' …）；空 = 任意 */
  type?: string;
  /** type === 'primitive' 时进一步限定基本体种类 */
  primitiveKind?: PrimitiveKind;
  /** 同类特征里的第几个（0 起）；与 `last` 互斥 */
  index?: number;
  /** 取同类里的最后一个 */
  last?: boolean;
}

export type AiEdit =
  | { kind: 'append'; ops: AiOp[]; source: string }
  | {
      kind: 'resize';
      target: EditTarget;
      /** 角色：length / width / height / thickness / depth / radius / diameter / side / distance / dims */
      role: string;
      /** 单个数值（role !== 'dims' 时使用） */
      value?: number;
      /** 整体三边尺寸（role === 'dims' 时使用） */
      dims?: number[];
      source: string;
    }
  | { kind: 'delete'; target: EditTarget; source: string };

/** 一次编辑带来的可见变化（供 UI 回显） */
export type EditChange =
  | { kind: 'append'; names: string[]; summary: string }
  | { kind: 'resize'; name: string; label: string; from?: number; to?: number; text?: string }
  | { kind: 'delete'; names: string[] };

// ============================================================
// 2. 关键词
// ============================================================

/** 强删除词：出现即按删除理解 */
const DELETE_WORDS = ['删除', '删掉', '删去', '移除'];
/** 弱删除词：与建模词同现时让位给「布尔切除」（如「挖掉一个圆柱」） */
const SOFT_DELETE_WORDS = ['去掉', '去除'];

/** 改尺寸触发词（按长度降序，先匹配长的） */
const RESIZE_WORDS = ['调整为', '调整成', '设置为', '改成', '改为', '修改为', '修改成', '变成', '调成', '改到', '调到', '换成', '设为'];

/** 角色词 → 语义 tag（用于「把高改成20」里的「高」） */
const ROLE_WORDS: [string, string][] = [
  ['起始半径', 'startRadius'],
  ['拔模角', 'draftAngle'],
  ['直径', 'diameter'],
  ['半径', 'radius'],
  ['厚度', 'thickness'],
  ['深度', 'depth'],
  ['高度', 'height'],
  ['长度', 'length'],
  ['宽度', 'width'],
  ['边长', 'side'],
  ['距离', 'distance'],
  ['角度', 'angle'],
  ['中径', 'meanDia'],
  ['线径', 'wireDia'],
  ['丝径', 'wireDia'],
  ['螺距', 'pitch'],
  ['圈数', 'turns'],
  ['匝数', 'turns'],
  ['锥度', 'taper'],
  ['Φ', 'diameter'],
  ['长', 'length'],
  ['宽', 'width'],
  ['高', 'height'],
  ['厚', 'thickness'],
  ['深', 'depth'],
  ['边', 'side'],
  ['r', 'radius'],
];

/** 可用于改尺寸的角色 */
const RESIZE_ROLES = new Set([
  'length',
  'width',
  'height',
  'thickness',
  'depth',
  'radius',
  'diameter',
  'side',
  'distance',
  'startRadius',
  'meanDia',
  'wireDia',
  'pitch',
  'turns',
  'taper',
  'angle',
  'draftAngle',
  'factor',
]);

const OP_FEATURE: Record<string, string> = {
  hole: 'hole',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  linearPattern: 'linearPattern',
  circularPattern: 'circularPattern',
  spring: 'spring',
  spiral: 'spiral',
  scale: 'scale',
  mirror: 'mirror',
  draft: 'draft',
};

const KIND_LABEL: Record<PrimitiveKind, string> = {
  box: '长方体',
  cylinder: '圆柱',
  sphere: '球',
  cone: '圆锥',
  torus: '圆环',
};

const ROLE_LABEL: Record<string, string> = {
  length: '长',
  width: '宽度',
  height: '高',
  thickness: '厚度',
  depth: '深度',
  radius: '半径',
  diameter: '直径',
  side: '边长',
  distance: '距离',
  startRadius: '起始半径',
  meanDia: '中径',
  wireDia: '线径',
  pitch: '螺距',
  turns: '圈数',
  taper: '锥度',
  angle: '角度',
  draftAngle: '拔模角',
  factor: '倍数',
  dims: '三边尺寸',
};

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

// ============================================================
// 3. 解析编辑指令
// ============================================================

/**
 * 文本 → AiEdit[]。
 * `features` 是当前文档的特征快照（只用于判断「已有实体」以决定布尔操作是 new 还是 add）。
 */
export function parseEdit(raw: string, features: Feature[] = []): { edits: AiEdit[]; issues: ParseIssue[] } {
  const clauses = splitClauses(raw);
  const edits: AiEdit[] = [];
  const issues: ParseIssue[] = [];
  let hasPrior = features.length > 0;
  /** 最近一个追加进来的孔 —— 供「沉头直径14深6」这类细节子句回填 */
  let lastHole: AiHoleOp | null = null;
  /** 最近一个追加进来的动作 —— 供「修饰词」子句回填（反向 / 左旋…） */
  let lastOp: AiOp | null = null;

  for (const clause of clauses) {
    // (1) 删除
    if (isDeleteClause(clause)) {
      const target = resolveTarget(clause, true);
      if (!target) {
        issues.push({ clause, message: '没说要删掉哪个特征（可写「删掉孔」「删掉最后一个圆角」）', level: 'error' });
        continue;
      }
      edits.push({ kind: 'delete', target, source: clause });
      lastHole = null;
      lastOp = null;
      continue;
    }

    // (2) 改尺寸
    const rs = parseResize(clause);
    if (rs) {
      edits.push(rs);
      lastHole = null;
      lastOp = null;
      continue;
    }

    // (3) 追加建模（复用建模型解析器）
    const r = parseSingleClause(clause, hasPrior);
    if (r.op) {
      const last = edits[edits.length - 1];
      if (last && last.kind === 'append') last.ops.push(r.op);
      else edits.push({ kind: 'append', ops: [r.op], source: clause });
      hasPrior = true;
      lastHole = r.op.kind === 'hole' ? r.op : null;
      lastOp = r.op;
      continue;
    }
    if (r.issue) {
      const detail = lastHole ? parseHoleDetail(clause) : null;
      if (detail && lastHole) Object.assign(lastHole, detail);
      else issues.push(r.issue);
      continue;
    }
    if (lastOp && applyModifierTo(lastOp, clause)) continue;
  }

  return { edits, issues };
}

function isDeleteClause(clause: string): boolean {
  if (hasAny(clause, DELETE_WORDS)) return true;
  // 「去掉/去除」在建模语境里也可能表示布尔切除，此时让位
  if (hasAny(clause, SOFT_DELETE_WORDS)) return !hasAny(clause, ['切除', '挖去', '挖掉', '减去', '镂空']);
  return false;
}

/**
 * 找出「改 / 删」的目标。
 *
 * - 显式目标：`第N个` / `最后` / 种类词（长方体、圆柱…）/ 动作词（孔、圆角…）；
 * - 都没说时：删除返回 null（让上层报「没说要删什么」），改尺寸返回 `{}`
 *   —— 由 `applyEdits` 用「谁支持这个角色」来智能选（见 `resolveResizeTarget`）。
 */
function resolveTarget(clause: string, forDelete: boolean): EditTarget | null {
  const scan = scanClause(clause);
  const opTag = opTagOf(scan);
  const kind = kindOf(scan);
  const t: EditTarget = {};

  if (opTag && OP_FEATURE[opTag]) t.type = OP_FEATURE[opTag];
  else if (kind) {
    t.type = 'primitive';
    t.primitiveKind = kind;
  }

  const m = /第(\d+)/.exec(clause);
  if (m) t.index = Math.max(0, parseInt(m[1], 10) - 1);
  else if (hasAny(clause, ['最后', '最新', '末端', '末尾'])) t.last = true;

  if (!Object.keys(t).length) return forDelete ? null : {};
  return t;
}

/** 在文本里找**最靠右**的角色词（「把长方体的高」→ 高，而不是长） */
function roleIn(text: string): string | null {
  let best: { role: string; at: number } | null = null;
  for (const [word, tag] of ROLE_WORDS) {
    const at = text.lastIndexOf(word);
    if (at < 0) continue;
    if (!best || at > best.at) best = { role: tag, at };
  }
  return best ? best.role : null;
}

function parseResize(clause: string): AiEdit | null {
  const word = RESIZE_WORDS.find((w) => clause.includes(w));
  if (!word) return null;
  const at = clause.indexOf(word);
  const before = clause.slice(0, at);
  const after = clause.slice(at + word.length);

  const target = resolveTarget(clause, false) ?? {};
  const scanAfter = scanClause(after);

  // 整体三边尺寸：把长方体改成 60x40x10
  const group = scanAfter.groups.find((g) => g.length >= 3);
  if (group) {
    return { kind: 'resize', target, role: 'dims', dims: group.map((h) => h.value), source: clause };
  }

  // 单个数值：角色优先取「改」之前的文字，其次取数值自带的角色（如「改成直径10」）
  let role = roleIn(before) ?? roleIn(after) ?? null;
  const value = scanAfter.hits.length ? scanAfter.hits[0].value : undefined;
  if (value === undefined) return null;
  // 「把缩放改成 2 倍」——「倍」在数字**后面**，角色词（前缀匹配）取不到，这里补一刀
  if (!role && clause.includes('倍')) role = 'factor';
  if (!role || !RESIZE_ROLES.has(role)) return null;

  return { kind: 'resize', target, role, value, source: clause };
}

// ============================================================
// 4. 应用编辑
// ============================================================

export interface EditContext {
  /** 当前特征快照 */
  features: Feature[];
  /** 当前模型包围盒（世界坐标）—— 追加特征的落位基准 */
  bbox?: Box | null;
  /** 若当前模型「最后是一个长方体」，给出它的包围盒，供解析式面/边引用 */
  boxForRefs?: Box | null;
}

export interface EditResult {
  /** 编辑后的完整特征数组 */
  features: Feature[];
  issues: ParseIssue[];
  changes: EditChange[];
  /** 本次新增的特征（供 UI 高亮 / 选中） */
  added: Feature[];
  /** 编辑后的估算包围盒（App 重建后会拿到精确值） */
  bbox: Box | null;
}

export interface EditRun extends EditResult {
  edits: AiEdit[];
}

interface WriteResult {
  label: string;
  from?: number;
  to?: number;
  text?: string;
}

/**
 * 端到端：一句话 → 新的特征数组。
 * 不碰几何内核，App 拿到结果后自行 `setFeatures` + 重建。
 */
export function editModel(raw: string, ctx: EditContext): EditRun {
  const { edits, issues: parseIssues } = parseEdit(raw, ctx.features);
  const applied = applyEdits(edits, ctx);
  return { ...applied, edits, issues: [...parseIssues, ...applied.issues] };
}

/** 逐条应用编辑意图 */
export function applyEdits(edits: AiEdit[], ctx: EditContext): EditResult {
  let features: Feature[] = ctx.features.map((f) => cloneFeature(f));
  const issues: ParseIssue[] = [];
  const changes: EditChange[] = [];
  const added: Feature[] = [];
  let bbox: Box | null = ctx.bbox ?? estimateBBox(features);
  let boxForRefs: Box | null = ctx.boxForRefs ?? boxRefOf(features);
  const namer = namerFrom(features);
  /**
   * 「它」指的是谁：若上一条编辑刚追加了特征，那么后续无主语的改尺寸默认指向它
   * —— 支持「再加一个半径8高12的圆柱，把高改成20」这种连贯说法。
   */
  let preferIdx = -1;

  for (const ed of edits) {
    if (ed.kind === 'append') {
      const lastId = features.length ? features[features.length - 1].id : null;
      const r: CompileResult = compilePlan(ed.ops, {
        namer,
        initialBBox: bbox,
        initialBoxForRefs: boxForRefs,
        initialLastId: lastId,
      });
      issues.push(...r.issues);
      if (!r.features.length) {
        preferIdx = -1;
        continue;
      }
      features.push(...r.features);
      added.push(...r.features);
      changes.push({ kind: 'append', names: r.names, summary: summarize(ed.ops) });
      bbox = r.bbox;
      boxForRefs = r.refBox;
      preferIdx = features.length - 1;
      continue;
    }

    if (ed.kind === 'resize') {
      const i = resolveResizeTarget(features, ed.target, ed.role, ed.dims, preferIdx);
      preferIdx = -1;
      if (i < 0) {
        const what = ROLE_LABEL[ed.role] ?? ed.role;
        issues.push({
          clause: ed.source,
          message: ed.target.type
            ? `没找到要修改的${targetLabel(ed.target)}`
            : `没找到可修改「${what}」的特征`,
          level: 'error',
        });
        continue;
      }
      const f = features[i];
      const oldBox = primitiveBox(f);
      const res = ed.dims ? writeDims(f, ed.dims) : writeParam(f, ed.role, ed.value ?? 0);
      if (!res) {
        issues.push({
          clause: ed.source,
          message: `${f.name}（${FEATURE_LABEL[f.type] ?? f.type}）不支持修改「${ROLE_LABEL[ed.role] ?? ed.role}」`,
          level: 'error',
        });
        continue;
      }
      changes.push({ kind: 'resize', name: f.name, label: res.label, from: res.from, to: res.to, text: res.text });
      // 尺寸变了 —— 让「挂在这个实体上」的孔 / 圆角 / 倒角 / 抽壳跟着新面走
      const newBox = primitiveBox(f);
      if (oldBox && newBox) retargetAfter(features, i, oldBox, newBox, issues);
      // 用解析式重算包围盒（仅当模型全是基本体时准确）
      const est = estimateBBox(features);
      if (est) bbox = est;
      boxForRefs = boxRefOf(features);
      continue;
    }

    // delete
    preferIdx = -1;
    const idx = pickTargets(features, ed.target);
    if (!idx.length) {
      issues.push({ clause: ed.source, message: `没找到要删除的${targetLabel(ed.target)}`, level: 'error' });
      continue;
    }
    const dead = new Set(idx.map((i) => features[i].id));
    const names = idx.map((i) => features[i].name);
    let kept = features.filter((f) => !dead.has(f.id));
    // 剪掉引用已删特征的「悬空」特征（阵列种子 / 草图引用……）
    const pruned = pruneDangling(kept);
    kept = pruned.kept;
    changes.push({ kind: 'delete', names: [...names, ...pruned.removed.map((f) => f.name)] });
    features = kept;
    bbox = estimateBBox(features);
    boxForRefs = boxRefOf(features);
  }

  return { features, issues, changes, added, bbox };
}

// ---------- 目标匹配 ----------

function matchTargets(features: Feature[], t: EditTarget): number[] {
  const all = features.map((_, i) => i);
  if (!t.type) return all;
  let hit = all.filter((i) => features[i].type === t.type);
  // 「阵列」既可能是线性也可能是圆周 —— 互相兜底
  if (!hit.length && t.type === 'linearPattern') hit = all.filter((i) => features[i].type === 'circularPattern');
  if (!hit.length && t.type === 'circularPattern') hit = all.filter((i) => features[i].type === 'linearPattern');
  if (t.type === 'primitive' && t.primitiveKind) {
    hit = hit.filter((i) => (features[i] as PrimitiveFeature).params.kind === t.primitiveKind);
  }
  return hit;
}

function pickTargets(features: Feature[], t: EditTarget): number[] {
  const hit = matchTargets(features, t);
  if (!hit.length) return [];
  if (t.index !== undefined) return hit[t.index] === undefined ? [] : [hit[t.index]];
  if (t.last) return [hit[hit.length - 1]];
  return hit;
}

/** 该特征能不能改这个角色（用「克隆试写」判断，保证与 writeParam 同一口径） */
function supportsRole(f: Feature, role: string, dims?: number[]): boolean {
  const probe = cloneFeature(f);
  return dims ? !!writeDims(probe, dims) : !!writeParam(probe, role, 1);
}

/**
 * 改尺寸的目标选择。
 *
 * - 用户说清了（种类词 / 第N个 / 最后）→ 照办；
 * - 刚追加过特征（`prefer` 指向它）→ 优先改它，支持「加一个圆柱，把高改成20」；
 * - 都没说清 → 在**支持这个角色**的特征里挑：
 *   优先第一个基本体（通常是"主体"，如「把高改成20」改的是那块板而不是它上面的孔），
 *   没有基本体可用时取最后一个（如「把直径改成12」改的是孔）。
 *
 * 返回 -1 表示没有可改的对象。
 */
function resolveResizeTarget(
  features: Feature[],
  t: EditTarget,
  role: string,
  dims?: number[],
  prefer = -1
): number {
  const explicit = t.type !== undefined || t.index !== undefined || t.last === true;
  if (explicit) {
    const hit = pickTargets(features, t);
    return hit.length ? hit[hit.length - 1] : -1;
  }
  if (prefer >= 0 && prefer < features.length && supportsRole(features[prefer], role, dims)) {
    return prefer;
  }
  const ok: number[] = [];
  for (let i = 0; i < features.length; i++) {
    if (supportsRole(features[i], role, dims)) ok.push(i);
  }
  if (!ok.length) return -1;
  const prims = ok.filter((i) => features[i].type === 'primitive');
  return prims.length ? prims[0] : ok[ok.length - 1];
}

function targetLabel(t: EditTarget): string {
  if (t.type === 'primitive' && t.primitiveKind) return KIND_LABEL[t.primitiveKind];
  if (t.type) return FEATURE_LABEL[t.type] ?? t.type;
  if (t.index !== undefined) return `第 ${t.index + 1} 个特征`;
  if (t.last) return '最后一个特征';
  // 没显式指定对象（由 applyEdits 智能选）→ 不硬报一个可能不对的标签
  return '';
}

// ---------- 参数写入 ----------

function setNum(arr: number[], i: number, v: number, label: string): WriteResult {
  const from = arr[i];
  arr[i] = v;
  return { label, from, to: v };
}

function setDiameter(arr: number[], i: number, dia: number): WriteResult {
  const from = arr[i] * 2;
  arr[i] = dia / 2;
  return { label: '直径', from, to: dia };
}

/** 把「角色 + 数值」写进某个特征；返回 null 表示该特征不支持这个角色 */
export function writeParam(f: Feature, role: string, value: number): WriteResult | null {
  switch (f.type) {
    case 'primitive': {
      const p = f.params;
      const d = p.dims;
      switch (p.kind) {
        case 'box':
          if (role === 'length') return setNum(d, 0, value, '长');
          if (role === 'width') return setNum(d, 1, value, '宽');
          if (role === 'height' || role === 'thickness' || role === 'depth') return setNum(d, 2, value, '高');
          if (role === 'side') {
            const from = d[0];
            d[0] = d[1] = d[2] = value;
            return { label: '边长', from, to: value };
          }
          return null;
        case 'cylinder':
          if (role === 'radius') return setNum(d, 0, value, '半径');
          if (role === 'diameter') return setDiameter(d, 0, value);
          if (role === 'height' || role === 'depth') return setNum(d, 1, value, '高');
          return null;
        case 'sphere':
          if (role === 'radius') return setNum(d, 0, value, '半径');
          if (role === 'diameter') return setDiameter(d, 0, value);
          return null;
        case 'cone':
          if (role === 'radius') return setNum(d, 0, value, '底半径');
          if (role === 'diameter') return setDiameter(d, 0, value);
          if (role === 'height') return setNum(d, 2, value, '高');
          return null;
        case 'torus':
          if (role === 'radius' || role === 'meanDia' || role === 'diameter')
            return role === 'diameter' ? setDiameter(d, 0, value) : setNum(d, 0, value, '中径');
          if (role === 'thickness' || role === 'depth' || role === 'wireDia') return setNum(d, 1, value, '线径');
          return null;
      }
      return null;
    }
    case 'spring': {
      const p = f.params;
      if (role === 'meanDia') {
        const from = p.meanDiameter;
        p.meanDiameter = value;
        return { label: '中径', from, to: value };
      }
      if (role === 'wireDia') {
        const from = p.wireDiameter;
        p.wireDiameter = value;
        return { label: '线径', from, to: value };
      }
      if (role === 'pitch') {
        const from = p.pitch;
        p.pitch = value;
        return { label: '螺距', from, to: value };
      }
      if (role === 'turns') {
        const from = p.turns;
        p.turns = value;
        return { label: '圈数', from, to: value };
      }
      if (role === 'taper') {
        const from = p.taperDeg ?? 0;
        p.taperDeg = value;
        return { label: '锥度', from, to: value };
      }
      return null;
    }
    case 'spiral': {
      const p = f.params;
      if (role === 'startRadius' || role === 'radius') {
        const from = p.startRadius;
        p.startRadius = value;
        return { label: '起始半径', from, to: value };
      }
      if (role === 'pitch') {
        const from = p.pitch;
        p.pitch = value;
        return { label: '螺距', from, to: value };
      }
      if (role === 'turns') {
        const from = p.turns;
        p.turns = value;
        return { label: '圈数', from, to: value };
      }
      if (role === 'thickness') {
        const from = p.thickness;
        p.thickness = value;
        return { label: '带厚', from, to: value };
      }
      if (role === 'width') {
        const from = p.width;
        p.width = value;
        return { label: '带宽', from, to: value };
      }
      return null;
    }
    case 'draft': {
      if (role !== 'angle' && role !== 'draftAngle') return null;
      const p = f.params;
      const from = p.angleDeg;
      p.angleDeg = value;
      return { label: '拔模角', from, to: value };
    }
    case 'scale': {
      if (role !== 'factor') return null;
      const p = f.params;
      const from = p.factor;
      p.factor = value;
      // 一旦直接改倍数，就退回「统一缩放」
      p.nonUniform = false;
      delete p.factors;
      return { label: '倍数', from, to: value };
    }
    case 'hole': {
      const p = f.params;
      if (role === 'radius') {
        const from = p.diameter / 2;
        p.diameter = value * 2;
        return { label: '半径', from, to: value };
      }
      if (role === 'diameter') {
        const from = p.diameter;
        p.diameter = value;
        return { label: '直径', from, to: value };
      }
      if (role === 'depth') {
        const from = p.depth;
        p.depth = value;
        p.through = false;
        return { label: '深度', from, to: value };
      }
      return null;
    }
    case 'fillet': {
      if (role !== 'radius' && role !== 'distance') return null;
      const p = f.params;
      const from = p.radius;
      p.radius = value;
      return { label: '半径', from, to: value };
    }
    case 'chamfer': {
      if (role !== 'distance' && role !== 'length' && role !== 'radius') return null;
      const p = f.params;
      const from = p.distance;
      p.distance = value;
      return { label: '距离', from, to: value };
    }
    case 'shell': {
      if (role !== 'thickness') return null;
      const p = f.params;
      const from = p.thickness;
      p.thickness = value;
      return { label: '壁厚', from, to: value };
    }
    default:
      return null;
  }
}

/** 整体三边尺寸（只对长方体有意义） */
function writeDims(f: Feature, dims: number[]): WriteResult | null {
  if (f.type !== 'primitive' || f.params.kind !== 'box') return null;
  const p = f.params;
  const from = p.dims.slice(0, 3);
  for (let i = 0; i < 3; i++) if (dims[i] !== undefined) p.dims[i] = dims[i];
  const fmt = (ns: number[]) => ns.map((n) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(2))).join('×');
  return { label: '三边尺寸', text: `${fmt(from)} → ${fmt(p.dims.slice(0, 3))}` };
}

// ---------- 特征工具 ----------

function cloneFeature(f: Feature): Feature {
  const copy = { ...f, params: JSON.parse(JSON.stringify(f.params)) } as Feature;
  if (f.expressions) copy.expressions = { ...f.expressions };
  return copy;
}

/** 名称分配器：从现有特征名续号，避免新特征重名 */
function namerFrom(features: Feature[]): (type: string) => string {
  const counters: Record<string, number> = {};
  for (const f of features) {
    const label = DEFAULT_LABELS[f.type] ?? f.type;
    const m = new RegExp(`^${label}(\\d+)$`).exec(f.name);
    if (m) counters[f.type] = Math.max(counters[f.type] ?? 0, parseInt(m[1], 10));
  }
  return (type) => {
    const n = (counters[type] ?? 0) + 1;
    counters[type] = n;
    return `${DEFAULT_LABELS[type] ?? type}${n}`;
  };
}

/** 某个特征引用了哪些特征 id（用于删除后剪悬空引用） */
function refsOf(f: Feature): string[] {
  const p = f.params as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['seedFeatureId', 'sketchId', 'profileSketchId', 'pathSketchId']) {
    const v = p[key];
    if (typeof v === 'string') out.push(v);
  }
  const ids = p['sketchIds'];
  if (Array.isArray(ids)) for (const v of ids) if (typeof v === 'string') out.push(v);
  return out;
}

/** 反复剔除引用了不存在特征的特征，直到稳定 */
function pruneDangling(features: Feature[]): { kept: Feature[]; removed: Feature[] } {
  const removed: Feature[] = [];
  let kept = features;
  for (let guard = 0; guard < 64; guard++) {
    const ids = new Set(kept.map((f) => f.id));
    const next = kept.filter((f) => refsOf(f).every((r) => ids.has(r)));
    if (next.length === kept.length) break;
    const gone = new Set(kept.filter((f) => !next.includes(f)).map((f) => f.id));
    for (const f of kept) if (gone.has(f.id)) removed.push(f);
    kept = next;
  }
  return { kept, removed };
}

/** 解析式估算包围盒（基本体 + 弹簧 + 涡状线，并跟进缩放/镜像/拔模等变换；
 *  孔/圆角/倒角不改变外轮廓，与编译层口径一致） */
export function estimateBBox(features: Feature[]): Box | null {
  let cur: Box | null = null;
  for (const f of features) {
    // ---- 变换类：直接改写当前累计包围盒 ----
    if (f.type === 'scale') {
      if (!cur) continue;
      const p = f.params;
      const k: Vec3 = p.nonUniform
        ? [p.factors?.[0] ?? 1, p.factors?.[1] ?? 1, p.factors?.[2] ?? 1]
        : [p.factor, p.factor, p.factor];
      cur = scaleBox(cur, p.center, k);
      continue;
    }
    if (f.type === 'mirror') {
      if (!cur) continue;
      const p = f.params;
      cur = unionBox(cur, mirrorBox(cur, p.planePoint, p.planeNormal));
      continue;
    }
    if (f.type === 'draft') {
      if (!cur) continue;
      const grow = (cur.max[2] - cur.min[2]) * Math.tan((Math.abs(f.params.angleDeg) * Math.PI) / 180);
      cur = {
        min: [cur.min[0] - grow, cur.min[1] - grow, cur.min[2]],
        max: [cur.max[0] + grow, cur.max[1] + grow, cur.max[2]],
      };
      continue;
    }

    let b: Box | null = null;
    if (f.type === 'primitive') {
      const p = f.params;
      const lb = primitiveBounds(p.kind, p.dims);
      const o = p.origin ?? [0, 0, 0];
      b = {
        min: [lb.min[0] + o[0], lb.min[1] + o[1], lb.min[2] + o[2]],
        max: [lb.max[0] + o[0], lb.max[1] + o[1], lb.max[2] + o[2]],
      };
    } else if (f.type === 'spring') {
      const p = f.params;
      b = springBounds(
        {
          kind: 'spring',
          source: '',
          meanDiameter: p.meanDiameter,
          wireDiameter: p.wireDiameter,
          pitch: p.pitch,
          turns: p.turns,
          handedness: p.handedness,
          taperDeg: p.taperDeg,
          operation: 'new',
          place: 'center',
        },
        p.origin
      );
    } else if (f.type === 'spiral') {
      const p = f.params;
      b = spiralBounds(
        { startRadius: p.startRadius, pitch: p.pitch, turns: p.turns, thickness: p.thickness, width: p.width },
        p.plane
      );
    }
    if (!b) continue;
    cur = cur ? unionBox(cur, b) : b;
  }
  return cur;
}

/**
 * 若「最后产生的实体是一个长方体」，返回它的包围盒 —— 供圆角/倒角/抽壳/孔
 * 解析式生成边/面引用。孔 / 圆角 / 倒角不改变外轮廓，向前穿透继续找；
 * 其后的缩放会把包围盒一起变换（缩放后的长方体仍然是长方体）。
 */
export function boxRefOf(features: Feature[]): Box | null {
  let i = features.length - 1;
  for (; i >= 0; i--) {
    const t = features[i].type;
    if (t === 'hole' || t === 'fillet' || t === 'chamfer') continue;
    break;
  }
  if (i < 0) return null;
  const last = features[i];
  if (last.type !== 'primitive' || last.params.kind !== 'box') return null;
  const o = last.params.origin ?? [0, 0, 0];
  let box: Box = {
    min: [o[0], o[1], o[2]],
    max: [o[0] + last.params.dims[0], o[1] + last.params.dims[1], o[2] + last.params.dims[2]],
  };
  // 其后的变换：缩放跟着走；其它产生几何的特征则让解析式引用失效
  for (let k = i + 1; k < features.length; k++) {
    const g = features[k];
    if (g.type === 'hole' || g.type === 'fillet' || g.type === 'chamfer') continue;
    if (g.type === 'scale') {
      const p = g.params;
      const kk: Vec3 = p.nonUniform
        ? [p.factors?.[0] ?? 1, p.factors?.[1] ?? 1, p.factors?.[2] ?? 1]
        : [p.factor, p.factor, p.factor];
      box = scaleBox(box, p.center, kk);
      continue;
    }
    return null;
  }
  return box;
}

/** 基本体的世界包围盒（非基本体返回 null） */
function primitiveBox(f: Feature): Box | null {
  if (f.type !== 'primitive') return null;
  const p = f.params;
  const lb = primitiveBounds(p.kind, p.dims);
  const o = p.origin ?? [0, 0, 0];
  return {
    min: [lb.min[0] + o[0], lb.min[1] + o[1], lb.min[2] + o[2]],
    max: [lb.max[0] + o[0], lb.max[1] + o[1], lb.max[2] + o[2]],
  };
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/** 从一串棱反推圆角/倒角当初的作用范围 */
function inferScope(edges: EdgeRef[], oldBox: Box): 'all' | 'vertical' | 'top' | 'bottom' | null {
  if (!edges.length) return null;
  if (edges.length === 12) return 'all';
  if (edges.length === 4) {
    const allVertical = edges.every((e) => e.dir && Math.abs(Math.abs(e.dir[2]) - 1) < 1e-6);
    if (allVertical) return 'vertical';
    if (near(edges[0].point[2], oldBox.max[2])) return 'top';
    if (near(edges[0].point[2], oldBox.min[2])) return 'bottom';
  }
  return null;
}

/**
 * 某个基本体改了尺寸后，让它「身后」的依赖特征跟着走：
 *
 * - 孔 / 圆角 / 倒角 / 抽壳：按新面位置刷新几何引用；
 * - 叠在它顶面（或 +X / +Y 面）上的后续基本体：整体平移同样的增量，并递归处理它的依赖。
 *
 * 只跟踪「下一个基本体之前」这一段 —— 与编译层的 boxForRefs 口径一致，
 * 不做全局依赖图，够用且可预测。
 */
function retargetAfter(features: Feature[], i: number, oldBox: Box, newBox: Box, issues: ParseIssue[]): void {
  const size: [number, number, number] = [
    newBox.max[0] - newBox.min[0],
    newBox.max[1] - newBox.min[1],
    newBox.max[2] - newBox.min[2],
  ];
  // origin 不动 ⇒ min 面不动，只有 max 面沿 +轴 移动
  const delta: [number, number, number] = [
    newBox.max[0] - oldBox.max[0],
    newBox.max[1] - oldBox.max[1],
    newBox.max[2] - oldBox.max[2],
  ];

  for (let k = i + 1; k < features.length; k++) {
    const f = features[k];

    if (f.type === 'primitive') {
      const pb = primitiveBox(f);
      if (!pb) return;
      const shift: [number, number, number] = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(delta[a]) < 1e-9) continue;
        if (near(pb.min[a], oldBox.max[a])) shift[a] = delta[a];
      }
      if (shift[0] || shift[1] || shift[2]) {
        const o = f.params.origin ?? [0, 0, 0];
        f.params.origin = [o[0] + shift[0], o[1] + shift[1], o[2] + shift[2]];
        retargetAfter(features, k, pb, primitiveBox(f)!, issues);
      }
      return;
    }

    if (f.type === 'hole') {
      const o = f.params.plane.origin;
      const onTop = near(o[2], oldBox.max[2]);
      const onBottom = near(o[2], oldBox.min[2]);
      if (!onTop && !onBottom) continue;
      const cx = (newBox.min[0] + newBox.max[0]) / 2;
      const cy = (newBox.min[1] + newBox.max[1]) / 2;
      const z = onTop ? newBox.max[2] : newBox.min[2];
      f.params.plane = {
        ...f.params.plane,
        origin: [cx + f.params.pos[0], cy + f.params.pos[1], z],
      };
      continue;
    }

    if (f.type === 'fillet' || f.type === 'chamfer') {
      const scope = inferScope(f.params.edges, oldBox);
      if (!scope) continue;
      const v = f.type === 'fillet' ? f.params.radius : f.params.distance;
      const limit = edgeLimit(size, scope);
      if (v > limit) {
        issues.push({
          clause: f.name,
          message: `${f.name} 的${f.type === 'fillet' ? '圆角半径' : '倒角距离'} ${v} 超过新尺寸限制（须不超过 ${limit.toFixed(2)}）`,
          level: 'warn',
        });
      }
      f.params.edges = boxEdges(newBox, scope);
      continue;
    }

    if (f.type === 'shell') {
      const n = f.params.faces[0]?.normal;
      const which: 'top' | 'bottom' = n && n[2] < 0 ? 'bottom' : 'top';
      const limit = Math.min(size[0], size[1], size[2]) / 2;
      if (f.params.thickness > limit) {
        issues.push({
          clause: f.name,
          message: `${f.name} 的壁厚 ${f.params.thickness} 超过新尺寸限制（须不超过 ${limit.toFixed(2)}）`,
          level: 'warn',
        });
      }
      f.params.faces = [boxFace(newBox, which)];
      continue;
    }
  }
}

// ============================================================
// 5. 回显
// ============================================================

function fmtNum(n: number | undefined): string {
  if (n === undefined) return '?';
  return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(2);
}

export function describeEdit(ed: AiEdit): string {
  switch (ed.kind) {
    case 'append':
      return `追加 ${summarize(ed.ops)}`;
    case 'resize': {
      const who = targetLabel(ed.target);
      const role = ROLE_LABEL[ed.role] ?? ed.role;
      const to = ed.dims ? ed.dims.join('×') : fmtNum(ed.value);
      return who ? `改 ${who} 的${role}为 ${to}` : `改${role}为 ${to}`;
    }
    case 'delete':
      return `删除 ${targetLabel(ed.target)}`;
  }
}

/** 去掉与「新增/修改/删除」徽标重复的动词前缀，供 UI 列表使用 */
export function describeChangeBare(c: EditChange): string {
  switch (c.kind) {
    case 'append':
      return `${c.names.join('、')}（${c.summary}）`;
    case 'resize':
      return describeChange(c);
    case 'delete':
      return c.names.join('、');
  }
}

export function describeChange(c: EditChange): string {
  switch (c.kind) {
    case 'append':
      return `新增 ${c.names.join('、')}（${c.summary}）`;
    case 'resize':
      return `${c.name}：${c.label} ${c.text ?? `${fmtNum(c.from)} → ${fmtNum(c.to)}`}`;
    case 'delete':
      return `删除 ${c.names.join('、')}`;
  }
}

export function summarizeEdits(changes: EditChange[]): string {
  if (!changes.length) return '没有任何改动';
  return changes.map(describeChange).join('；');
}

/** 便于 UI 判断「这句话到底是建模型还是编辑」（仅用于提示语，不参与逻辑） */
export function looksLikeEdit(raw: string): boolean {
  const s = normalizeInput(raw);
  if (hasAny(s, [...DELETE_WORDS, ...SOFT_DELETE_WORDS, ...RESIZE_WORDS])) return true;
  return !hasModelingWords(s) && hasAny(s, ['最后', '刚才', '上面那个', '现有']);
}
