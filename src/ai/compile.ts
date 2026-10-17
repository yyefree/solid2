/**
 * 编译层：AiOp[] → Feature[]（文档层特征）。
 *
 * 这是「意图 → 落地」的一步，只依赖 `doc/types` 的类型定义，**不 import 任何几何内核**，
 * 因此在主线程与 Node 单测里都能跑。
 *
 * 关键设计：编译过程中维护一个**解析式包围盒**。
 * 因为引擎的基本体约定是「角在原点、沿 +Z 生长」（`BRepPrimAPI_MakeBox_1` 等），
 * 直接拼装会得到一堆挤在第一象限的重叠体。这里统一做两件事：
 *   1. 给每个基本体算出把它**摆到世界原点居中**的 origin 偏移；
 *   2. 按 `place`（上面/右边/中心…）相对**当前累计包围盒**再平移。
 * 于是「长方体，上面加一个圆柱」能自然落到位，而「中心开孔」也能算准孔位。
 *
 * 孔 / 圆角 / 倒角 / 抽壳需要几何引用（面 / 边）。对**长方体**这些引用可以解析式算出来
 * （12 条棱、6 个面都有闭式坐标），所以这四类特征只在「上一个实体是长方体」时可用；
 * 其余情况给出明确 issue，而不是丢一个必定失败的引用给引擎。
 */

import { newId, DEFAULT_PLANE, type PointId, type Sketch, type SketchPlane } from '../sketch/types';
import type {
  ChamferFeature,
  CircularPatternFeature,
  CombineFeature,
  DeleteBodyFeature,
  DraftFeature,
  EdgeRef,
  FaceRef,
  Feature,
  FilletFeature,
  HoleFeature,
  LinearPatternFeature,
  MirrorFeature,
  MoveBodyFeature,
  PrimitiveFeature,
  ScaleFeature,
  SheetBaseFlangeFeature,
  ShellFeature,
  SketchFeature,
  SpiralFeature,
  SpringFeature,
} from '../doc/types';
import type { AiOp, AiSpiralOp, AiSpringOp, ParseIssue, Placement, Vec3 } from './types';

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface CompileResult {
  features: Feature[];
  issues: ParseIssue[];
  /** 最终累计包围盒（供 UI 显示尺寸 / 视图适配） */
  bbox: Box | null;
  /** 编译出的特征名列表（UI 回显） */
  names: string[];
  /**
   * 编译结束时「可作解析式边/面引用」的长方体包围盒。
   * 非空表示下一个圆角/倒角/抽壳/孔还能算出几何引用（供追加编辑接力）。
   */
  refBox: Box | null;
}

export interface CompileOptions {
  /** 名称分配器；不传则用内置计数器 */
  namer?: (type: string) => string;
  /**
   * 追加编译：以现有模型的包围盒作为初始「当前累计包围盒」。
   * 有了它，「再加一个…」才能相对已有实体正确落位。
   */
  initialBBox?: Box | null;
  /**
   * 追加编译：若现有模型最后是一个长方体，把它的包围盒交进来，
   * 这样「打个孔」「倒圆角」就能解析式地生成面/边引用。
   */
  initialBoxForRefs?: Box | null;
  /** 追加编译：上一个特征 id（供阵列做种子） */
  initialLastId?: string | null;
}

export const DEFAULT_LABELS: Record<string, string> = {
  primitive: '基本体',
  hole: '孔',
  fillet: '圆角',
  chamfer: '倒角',
  shell: '抽壳',
  linearPattern: '线性阵列',
  circularPattern: '圆周阵列',
  spring: '弹簧',
  spiral: '涡状线',
  scale: '缩放',
  mirror: '镜像',
  draft: '拔模',
  moveBody: '移动/复制实体',
  deleteBody: '删除实体',
  combine: '组合',
};

/** 内置名称分配器（与 doc.nextName 的标签一致） */
function makeNamer(): (type: string) => string {
  const counters: Record<string, number> = {};
  return (type) => {
    const n = (counters[type] ?? 0) + 1;
    counters[type] = n;
    return `${DEFAULT_LABELS[type] ?? type}${n}`;
  };
}

/**
 * 安全上限（白名单闸门的兜底）。
 *
 * 解析层（本地规则或未来云端大模型）只产出「意图」`AiOp`，校验逻辑不能只散落在
 * `compilePlan` 各 case 的下限判断里——那样云端模型吐出的巨大 count/turns/dims 会
 * 直达内核 Worker（无取消手段），轻则卡死、重则 OOM。
 *
 * 故在编译入口统一钳制：所有数值字段限制在 `±MAX_DIM`、阵列/复制份数 ≤ MAX_COUNT、
 * 弹簧/涡线圈数 ≤ MAX_TURNS；非有限值回退安全下限并记一条 warn。
 * 本地 parse 与云端 provider 都走 `compilePlan` 入口，故一次覆盖两条路径。
 */
const MAX_DIM = 1e6;
const MAX_COUNT = 64;
const MAX_TURNS = 1000;

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** 白名单校验 + 钳制 AI 动作的越界数值（详见 MAX_* 注释） */
export function validateAiOps(ops: AiOp[]): { ops: AiOp[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const out: AiOp[] = [];
  for (const op of ops) {
    let cloned = false;
    const next: Record<string, unknown> = {};
    const changed: string[] = [];
    const clampField = (k: string, v: unknown) => {
      if (typeof v === 'number') {
        const nv = clampNum(v, -MAX_DIM, MAX_DIM);
        if (nv !== v) changed.push(k);
        return nv;
      }
      if (Array.isArray(v)) {
        let any = false;
        const arr = v.map((x) => {
          if (typeof x === 'number') {
            const nx = clampNum(x, -MAX_DIM, MAX_DIM);
            if (nx !== x) any = true;
            return nx;
          }
          return x;
        });
        if (any) changed.push(k);
        return arr;
      }
      return v;
    };
    switch (op.kind) {
      case 'linearPattern':
      case 'circularPattern': {
        const c = clampNum(op.count, 2, MAX_COUNT);
        if (c !== op.count) changed.push('count');
        cloned = true;
        out.push({ ...op, count: c });
        break;
      }
      case 'moveBody': {
        const c = op.count !== undefined ? clampNum(op.count, 1, MAX_COUNT) : undefined;
        if (op.count !== undefined && c !== op.count) changed.push('count');
        cloned = c !== undefined;
        out.push(cloned ? { ...op, count: c } : op);
        break;
      }
      case 'spring':
      case 'spiral': {
        const t = clampNum(op.turns, 0.05, MAX_TURNS);
        if (t !== op.turns) changed.push('turns');
        out.push({ ...op, turns: t });
        break;
      }
      default: {
        // 其余：逐数值字段钳制（dims / delta / 半径 / 深度 / 角度 …）
        for (const k of Object.keys(op)) {
          const v = (op as unknown as Record<string, unknown>)[k];
          next[k] = clampField(k, v);
        }
        if (changed.length) {
          cloned = true;
          out.push(next as unknown as AiOp);
        } else {
          out.push(op);
        }
      }
    }
    if (changed.length) {
      issues.push({
        clause: op.source,
        message: `参数越界已钳制：${changed.join(', ')}（安全范围 ±${MAX_DIM} / count≤${MAX_COUNT} / turns≤${MAX_TURNS}）`,
        level: 'warn',
      });
    }
    void cloned;
  }
  return { ops: out, issues };
}

// ---------- 向量小工具 ----------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const axisVec = (a: 'x' | 'y' | 'z'): Vec3 => (a === 'x' ? [1, 0, 0] : a === 'y' ? [0, 1, 0] : [0, 0, 1]);

/**
 * 基本体在「引擎原生坐标系」里的包围盒（未加 origin 偏移）。
 * 对外导出，供编辑层（edit.ts）解析式估算现有模型的包围盒。
 */
export function primitiveBounds(kind: string, dims: number[]): Box {
  return localBounds(kind, dims);
}

/** 基本体在「引擎原生坐标系」里的包围盒（未加 origin 偏移） */
function localBounds(kind: string, dims: number[]): Box {
  switch (kind) {
    case 'box':
      return { min: [0, 0, 0], max: [dims[0], dims[1], dims[2]] };
    case 'cylinder':
      return { min: [-dims[0], -dims[0], 0], max: [dims[0], dims[0], dims[1]] };
    case 'sphere':
      return { min: [-dims[0], -dims[0], -dims[0]], max: [dims[0], dims[0], dims[0]] };
    case 'cone':
      return { min: [-dims[0], -dims[0], 0], max: [dims[0], dims[0], dims[2]] };
    case 'torus': {
      const R = dims[0] + dims[1];
      return { min: [-R, -R, -dims[1]], max: [R, R, dims[1]] };
    }
    default:
      return { min: [0, 0, 0], max: [0, 0, 0] };
  }
}

/** 依据 place 求平移量：把「以原点居中」的实体搬到目标位置 */
function placementOffset(size: Vec3, place: Placement, cur: Box | null): Vec3 {
  if (!cur) return [0, 0, 0];
  const c = mid(cur.min, cur.max);
  switch (place) {
    case 'top':
      return [c[0], c[1], cur.max[2] + size[2] / 2];
    case 'bottom':
      return [c[0], c[1], cur.min[2] - size[2] / 2];
    case 'right':
      return [cur.max[0] + size[0] / 2, c[1], c[2]];
    case 'left':
      return [cur.min[0] - size[0] / 2, c[1], c[2]];
    case 'front':
      return [c[0], cur.max[1] + size[1] / 2, c[2]];
    case 'back':
      return [c[0], cur.min[1] - size[1] / 2, c[2]];
    default:
      return c;
  }
}

/** 长方体的 12 条棱 → EdgeRef[]（解析式；供圆角/倒角引用） */
export function boxEdges(b: Box, scope: 'all' | 'vertical' | 'top' | 'bottom'): EdgeRef[] {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;

  const vertical: EdgeRef[] = [
    { point: [x0, y0, cz], dir: [0, 0, 1] },
    { point: [x1, y0, cz], dir: [0, 0, 1] },
    { point: [x0, y1, cz], dir: [0, 0, 1] },
    { point: [x1, y1, cz], dir: [0, 0, 1] },
  ];
  const ring = (z: number): EdgeRef[] => [
    { point: [cx, y0, z], dir: [1, 0, 0] },
    { point: [cx, y1, z], dir: [1, 0, 0] },
    { point: [x0, cy, z], dir: [0, 1, 0] },
    { point: [x1, cy, z], dir: [0, 1, 0] },
  ];
  if (scope === 'vertical') return vertical;
  if (scope === 'top') return ring(z1);
  if (scope === 'bottom') return ring(z0);
  return [...vertical, ...ring(z1), ...ring(z0)];
}

/** 长方体的上/下表面 → FaceRef（供抽壳引用） */
export function boxFace(b: Box, which: 'top' | 'bottom'): FaceRef {
  const c = mid(b.min, b.max);
  return which === 'top'
    ? { point: [c[0], c[1], b.max[2]], normal: [0, 0, 1] }
    : { point: [c[0], c[1], b.min[2]], normal: [0, 0, -1] };
}

/**
 * 圆角 / 倒角的半径上限（超过会导致自交，引擎会失败）。
 * 竖直棱只受 X/Y 两向限制；顶/底棱与「全部棱」还受高度限制。
 */
export function edgeLimit(size: Vec3, scope: 'all' | 'vertical' | 'top' | 'bottom'): number {
  const planar = Math.min(size[0], size[1]) / 2;
  if (scope === 'vertical') return planar;
  return Math.min(planar, size[2] / 2);
}

/** 沿某轴的孔用平面：原点在对应表面的中心，法向朝外 */
function holePlane(b: Box, which: 'top' | 'bottom'): SketchPlane {
  const c = mid(b.min, b.max);
  if (which === 'bottom') {
    return { origin: [c[0], c[1], b.min[2]], u: [1, 0, 0], v: [0, -1, 0], normal: [0, 0, -1], ref: 'AI 孔·底面' };
  }
  return { origin: [c[0], c[1], b.max[2]], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], ref: 'AI 孔·顶面' };
}

/** 两个包围盒的并集 */
export function unionBox(a: Box, b: Box): Box {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/**
 * 弹簧的解析式包围盒（轴向固定为 +Z）。
 * 外径 = 中径 + 线径；高 = 螺距 × 圈数 + 线径。
 * 锥簧只让半径沿轴渐变，外轮廓不超过最大半径，故此式同样成立（略保守）。
 */
export function springBounds(op: AiSpringOp, origin: Vec3): Box {
  const R = (op.meanDiameter + op.wireDiameter) / 2;
  const H = op.pitch * op.turns + op.wireDiameter;
  return {
    min: [origin[0] - R, origin[1] - R, origin[2]],
    max: [origin[0] + R, origin[1] + R, origin[2] + H],
  };
}

/**
 * 涡状线带材的解析式包围盒。
 * 外轮廓最大半径 = 起始半径 + 螺距×圈数 + 带厚/2（与 `spiralRibbon2D` 一致）；
 * 沿平面法向拉伸 `width`。仅对「前视基准面（u=+X, v=+Y, normal=+Z）」成立。
 */
export function spiralBounds(
  p: { startRadius: number; pitch: number; turns: number; thickness: number; width: number },
  plane: SketchPlane
): Box {
  const R = p.startRadius + p.pitch * p.turns + p.thickness / 2;
  const o = plane.origin;
  return {
    min: [o[0] - R, o[1] - R, o[2]],
    max: [o[0] + R, o[1] + R, o[2] + p.width],
  };
}

/** 长方体的 4 个侧面 → FaceRef[]（解析式；供拔模引用） */
export function boxSideFaces(b: Box): FaceRef[] {
  const c = mid(b.min, b.max);
  return [
    { point: [b.min[0], c[1], c[2]], normal: [-1, 0, 0] },
    { point: [b.max[0], c[1], c[2]], normal: [1, 0, 0] },
    { point: [c[0], b.min[1], c[2]], normal: [0, -1, 0] },
    { point: [c[0], b.max[1], c[2]], normal: [0, 1, 0] },
  ];
}

/** 包围盒关于平面（点 p、法向 n）镜像后的包围盒 */
export function mirrorBox(b: Box, p: Vec3, n: Vec3): Box {
  const mp = (v: Vec3): Vec3 => {
    const d = (v[0] - p[0]) * n[0] + (v[1] - p[1]) * n[1] + (v[2] - p[2]) * n[2];
    return [v[0] - 2 * d * n[0], v[1] - 2 * d * n[1], v[2] - 2 * d * n[2]];
  };
  const a = mp(b.min);
  const c = mp(b.max);
  return {
    min: [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])],
    max: [Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])],
  };
}

/** 包围盒以 center 为中心、各轴乘 k 之后的包围盒（k > 0） */
export function scaleBox(b: Box, center: Vec3, k: Vec3): Box {
  const at = (v: Vec3, i: 0 | 1 | 2) => center[i] + (v[i] - center[i]) * k[i];
  return {
    min: [at(b.min, 0), at(b.min, 1), at(b.min, 2)],
    max: [at(b.max, 0), at(b.max, 1), at(b.max, 2)],
  };
}

/** 包围盒平移 */
export function translateBox(b: Box, d: Vec3): Box {
  return { min: add(b.min, d), max: add(b.max, d) };
}

/** 包围盒的 8 个角点 */
function boxCorners(b: Box): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/** 点集的最小轴对齐包围盒 */
function boxFromPoints(ps: Vec3[]): Box {
  const mn: Vec3 = [Infinity, Infinity, Infinity];
  const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of ps) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < mn[i]) mn[i] = p[i];
      if (p[i] > mx[i]) mx[i] = p[i];
    }
  }
  return { min: mn, max: mx };
}

/** 绕「过 origin、轴向对齐」的轴旋转一点 */
function rotateAboutAxis(p: Vec3, origin: Vec3, axis: 'x' | 'y' | 'z', ang: number): Vec3 {
  const v: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  let r: Vec3;
  if (axis === 'x') r = [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  else if (axis === 'y') r = [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  else r = [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
  return [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]];
}

/**
 * 「移动/复制实体」之后的解析式包围盒。
 *
 * 与引擎 `moveBody` 的口径严格对齐：**先绕轴旋转 `k` 倍角、再平移 `k` 倍位移**。
 * 旋转轴过包围盒中心（编译层把 `axisOrigin` 也设成中心）。
 * 长方体绕轴向对齐的轴旋转后仍是长方体，所以用 8 个角点求包围盒是**精确解**，不是保守估计。
 */
export function moveBox(
  b: Box,
  delta: Vec3,
  angleDeg: number,
  axis: 'x' | 'y' | 'z',
  copy?: boolean,
  count?: number
): Box {
  const origin = mid(b.min, b.max);
  const ang = (angleDeg * Math.PI) / 180;
  const at = (k: number): Box => {
    const pts = boxCorners(b).map((p) => rotateAboutAxis(p, origin, axis, ang * k));
    return boxFromPoints(pts.map((p) => add(p, [delta[0] * k, delta[1] * k, delta[2] * k])));
  };
  if (!copy) return at(1);
  const n = Math.max(1, Math.round(count ?? 1));
  let out = b; // 原件留在原位
  for (let i = 1; i <= n; i++) out = unionBox(out, at(i));
  return out;
}

/**
 * 编译入口：把一份建模计划变成文档特征。
 * 顺序即特征树顺序；后面的特征可以引用前面的实体。
 */
export function compilePlan(ops: AiOp[], opts: CompileOptions = {}): CompileResult {
  const namer = opts.namer ?? makeNamer();
  const features: Feature[] = [];
  const issues: ParseIssue[] = [];
  const names: string[] = [];

  // 白名单闸门：在编译前统一钳制越界数值（本地解析与云端 provider 共用此入口）
  const validated = validateAiOps(ops);
  issues.push(...validated.issues);
  const plan = validated.ops;

  /** 当前累计包围盒（所有实体并集）；追加模式下从现有模型续起 */
  let cur: Box | null = opts.initialBBox ?? null;
  /** 只有「上一个实体是纯长方体」时才非空，供解析式边/面引用使用 */
  let boxForRefs: Box | null = opts.initialBoxForRefs ?? null;
  /** 上一个特征 id（阵列的种子） */
  let lastId: string | null = opts.initialLastId ?? null;

  for (const op of plan) {
    switch (op.kind) {
      case 'box':
      case 'cylinder':
      case 'sphere':
      case 'cone':
      case 'torus': {
        const dims = op.dims.map((d) => Math.max(d, 0.01));
        const lb = localBounds(op.kind, dims);
        const size = sub(lb.max, lb.min);
        // 1) 以原点居中的偏移；2) 按 place 相对当前包围盒再平移
        const centerOffset: Vec3 = [-mid(lb.min, lb.max)[0], -mid(lb.min, lb.max)[1], -mid(lb.min, lb.max)[2]];
        const t = placementOffset(size, op.place, cur);
        const origin = add(centerOffset, t);

        const f: PrimitiveFeature = {
          id: newId('f'),
          type: 'primitive',
          name: namer('primitive'),
          params: { kind: op.kind, dims, origin, operation: op.operation },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;

        const nb: Box = { min: add(lb.min, origin), max: add(lb.max, origin) };
        cur = cur ? { min: [Math.min(cur.min[0], nb.min[0]), Math.min(cur.min[1], nb.min[1]), Math.min(cur.min[2], nb.min[2])], max: [Math.max(cur.max[0], nb.max[0]), Math.max(cur.max[1], nb.max[1]), Math.max(cur.max[2], nb.max[2])] } : nb;
        boxForRefs = op.kind === 'box' ? nb : null;
        break;
      }

      case 'sheetMetal': {
        if (op.mode === 'edge') {
          issues.push({
            clause: op.source,
            message: '边线法兰需要先选中模型中的一条直线边；请选中边后在「钣金」页签点「边线法兰」',
            level: 'warn',
          });
          break;
        }
        const L = Math.max(op.length ?? 100, 0.1);
        const W = Math.max(op.width ?? 60, 0.1);
        const T = Math.max(op.thickness, 0.01);
        // 展开轮廓 = 居中矩形（前视基准面），沿法向拉伸出薄板
        const hl = L / 2;
        const hw = W / 2;
        const sketch: Sketch = { entities: [], points: {}, constraints: [] };
        const ids: PointId[] = ([
          [-hl, -hw],
          [hl, -hw],
          [hl, hw],
          [-hl, hw],
        ] as [number, number][]).map(([x, y]) => {
          const pid = newId('p');
          sketch.points[pid] = { id: pid, x, y };
          return pid;
        });
        for (let i = 0; i < 4; i++) {
          const eid = newId('e');
          sketch.entities.push({ id: eid, kind: 'line', a: ids[i], b: ids[(i + 1) % 4] });
        }
        const skf: SketchFeature = {
          id: newId('f'),
          type: 'sketch',
          name: namer('sketch'),
          params: { plane: 'front', sketch },
        };
        features.push(skf);
        names.push(skf.name);
        const flange: SheetBaseFlangeFeature = {
          id: newId('f'),
          type: 'sheetBaseFlange',
          name: namer('sheetBaseFlange'),
          params: {
            sketchId: skf.id,
            thickness: T,
            bendRadius: op.bendRadius && op.bendRadius > 0 ? op.bendRadius : undefined,
            kFactor: op.kFactor,
            operation: 'new',
          },
        };
        features.push(flange);
        names.push(flange.name);
        lastId = flange.id;
        const nb: Box = { min: [-hl, -hw, 0], max: [hl, hw, T] };
        cur = cur ? unionBox(cur, nb) : nb;
        boxForRefs = null;
        break;
      }

      case 'hole': {
        if (!cur) {
          issues.push({ clause: op.source, message: '孔需要先有一个实体', level: 'error' });
          break;
        }
        const which = op.place === 'bottom' ? 'bottom' : 'top';
        const dia = op.radius * 2;
        // 沉头/埋头的直径必须大于主孔，否则布尔做不出台阶 —— 提前拦下而不是交给引擎
        if (op.holeType === 'counterbore' && op.boreDiameter !== undefined && op.boreDiameter <= dia) {
          issues.push({
            clause: op.source,
            message: `沉头直径 ${op.boreDiameter} 必须大于孔径 ${dia}`,
            level: 'error',
          });
          break;
        }
        if (op.holeType === 'countersink' && op.sinkDiameter !== undefined && op.sinkDiameter <= dia) {
          issues.push({
            clause: op.source,
            message: `埋头直径 ${op.sinkDiameter} 必须大于孔径 ${dia}`,
            level: 'error',
          });
          break;
        }
        const f: HoleFeature = {
          id: newId('f'),
          type: 'hole',
          name: namer('hole'),
          params: {
            plane: holePlane(cur, which),
            pos: [0, 0],
            type: op.holeType ?? 'simple',
            diameter: dia,
            depth: op.through ? 100 : op.depth,
            through: op.through,
            boreDiameter: op.boreDiameter,
            boreDepth: op.boreDepth,
            sinkDiameter: op.sinkDiameter,
            sinkDepth: op.sinkDepth,
          },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        // 孔是内部切除，既不改变包围盒也不动外表面的棱 —— 长方体引用继续有效
        break;
      }

      case 'spring': {
        const mean = Math.max(op.meanDiameter, 0.02);
        const wire = Math.max(op.wireDiameter, 0.01);
        // 落位：无先验 → 轴起点在原点；有先验 → 坐在当前包围盒顶面中心
        const origin: Vec3 = cur
          ? [(cur.min[0] + cur.max[0]) / 2, (cur.min[1] + cur.max[1]) / 2, cur.max[2]]
          : [0, 0, 0];
        const f: SpringFeature = {
          id: newId('f'),
          type: 'spring',
          name: namer('spring'),
          params: {
            origin,
            axis: [0, 0, 1],
            meanDiameter: mean,
            wireDiameter: wire,
            pitch: Math.max(op.pitch, 0.01),
            turns: Math.max(op.turns, 0.05),
            handedness: op.handedness,
            taperDeg: op.taperDeg,
            operation: op.operation,
          },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        const nb = springBounds({ ...op, meanDiameter: mean, wireDiameter: wire }, origin);
        cur = cur ? unionBox(cur, nb) : nb;
        boxForRefs = null;
        break;
      }

      case 'spiral': {
        const startRadius = Math.max(op.startRadius, 0.02);
        const thickness = Math.max(op.thickness, 0.01);
        const width = Math.max(op.width, 0.01);
        const turns = Math.max(op.turns, 0.05);
        const pitch = Math.max(op.pitch, 0.01);
        // 有先验实体时坐在其顶面中心（与前视基准面平行），否则落在原点
        const plane: SketchPlane = cur
          ? { ...DEFAULT_PLANE, origin: [mid(cur.min, cur.max)[0], mid(cur.min, cur.max)[1], cur.max[2]] }
          : { ...DEFAULT_PLANE };
        const f: SpiralFeature = {
          id: newId('f'),
          type: 'spiral',
          name: namer('spiral'),
          params: {
            plane,
            startRadius,
            pitch,
            turns,
            thickness,
            width,
            handedness: op.handedness,
            symmetric: false,
            operation: op.operation,
          },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        const nb = spiralBounds({ startRadius, pitch, turns, thickness, width }, plane);
        cur = cur ? unionBox(cur, nb) : nb;
        boxForRefs = null;
        break;
      }

      case 'scale': {
        if (!cur) {
          issues.push({ clause: op.source, message: '缩放需要先有一个实体', level: 'error' });
          break;
        }
        const k: Vec3 = op.nonUniform
          ? [op.factors?.[0] ?? 1, op.factors?.[1] ?? 1, op.factors?.[2] ?? 1]
          : [op.factor, op.factor, op.factor];
        if (k.some((v) => !Number.isFinite(v) || Math.abs(v) < 1e-6)) {
          issues.push({ clause: op.source, message: '缩放系数必须是非 0 的有限数', level: 'error' });
          break;
        }
        const center = mid(cur.min, cur.max);
        const f: ScaleFeature = {
          id: newId('f'),
          type: 'scale',
          name: namer('scale'),
          params: op.nonUniform
            ? { center, factor: op.factor, nonUniform: true, factors: [k[0], k[1], k[2]] }
            : { center, factor: op.factor },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        cur = scaleBox(cur, center, k);
        boxForRefs = boxForRefs ? scaleBox(boxForRefs, center, k) : null;
        break;
      }

      case 'mirror': {
        if (!lastId) {
          issues.push({ clause: op.source, message: '镜像需要先有一个特征', level: 'error' });
          break;
        }
        // 基准面都过「模型自己的原点」：新建模式下编译层已把实体居中，用世界原点；
        // 追加模式下用现有模型包围盒中心，等价于它的「原点」。
        const planePoint: Vec3 = opts.initialBBox
          ? mid(opts.initialBBox.min, opts.initialBBox.max)
          : [0, 0, 0];
        const planeNormal: Vec3 =
          op.plane === 'right' ? [1, 0, 0] : op.plane === 'top' ? [0, 1, 0] : [0, 0, 1];
        const f: MirrorFeature = {
          id: newId('f'),
          type: 'mirror',
          name: namer('mirror'),
          params: { seedFeatureId: lastId, planePoint, planeNormal },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        // 镜像只复制「上一个特征」，但整个模型关于该平面的包络 = cur ∪ mirror(cur)
        if (cur) cur = unionBox(cur, mirrorBox(cur, planePoint, planeNormal));
        boxForRefs = null;
        break;
      }

      case 'draft': {
        if (!boxForRefs) {
          issues.push({
            clause: op.source,
            message: '拔模目前只支持作用在长方体上（且需紧跟在长方体之后）',
            level: 'error',
          });
          break;
        }
        const ang = Math.abs(op.angleDeg);
        if (!Number.isFinite(ang) || ang <= 0 || ang >= 90) {
          issues.push({ clause: op.source, message: `拔模角 ${op.angleDeg}° 不合理（须在 0°~90° 之间）`, level: 'error' });
          break;
        }
        const f: DraftFeature = {
          id: newId('f'),
          type: 'draft',
          name: namer('draft'),
          params: {
            neutralFace: boxFace(boxForRefs, 'bottom'),
            draftFaces: boxSideFaces(boxForRefs),
            angleDeg: ang,
            reverse: op.reverse,
          },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        // 拔模会让侧面外扩：按「高 × tan(角)」保守放大包围盒
        const size = sub(boxForRefs.max, boxForRefs.min);
        const grow = size[2] * Math.tan((ang * Math.PI) / 180);
        const grown: Box = {
          min: [boxForRefs.min[0] - grow, boxForRefs.min[1] - grow, boxForRefs.min[2]],
          max: [boxForRefs.max[0] + grow, boxForRefs.max[1] + grow, boxForRefs.max[2]],
        };
        cur = cur ? unionBox(cur, grown) : grown;
        boxForRefs = null;
        break;
      }

      case 'moveBody': {
        if (!cur) {
          issues.push({ clause: op.source, message: '移动/复制实体需要先有一个实体', level: 'error' });
          break;
        }
        const f: MoveBodyFeature = {
          id: newId('f'),
          type: 'moveBody',
          name: namer('moveBody'),
          // 作用于**全部实体**（indices 省略）；旋转轴过当前模型包围盒中心
          params: {
            delta: op.delta,
            axisOrigin: mid(cur.min, cur.max),
            axisDir: axisVec(op.axis),
            angleDeg: op.angleDeg,
            copy: op.copy,
            count: op.count,
          },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        cur = moveBox(cur, op.delta, op.angleDeg, op.axis, op.copy, op.count);
        // 只有「纯平移、不复制」时长方体引用才跟着走；旋转会破坏轴向对齐
        boxForRefs =
          boxForRefs && !op.copy && Math.abs(op.angleDeg) < 1e-9
            ? translateBox(boxForRefs, op.delta)
            : null;
        break;
      }

      case 'deleteBody': {
        if (!cur) {
          issues.push({ clause: op.source, message: '删除实体需要先有实体', level: 'error' });
          break;
        }
        const f: DeleteBodyFeature = {
          id: newId('f'),
          type: 'deleteBody',
          name: namer('deleteBody'),
          params: { indices: op.indices },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        boxForRefs = null;
        break;
      }

      case 'combine': {
        if (!cur) {
          issues.push({ clause: op.source, message: '组合需要先有实体', level: 'error' });
          break;
        }
        const f: CombineFeature = {
          id: newId('f'),
          type: 'combine',
          name: namer('combine'),
          // 主体 = 第一个实体，工具体 = 其余全部（空数组由引擎解析成「所有其它实体」）
          params: { mainIndex: 0, toolIndices: [], operation: op.operation },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        boxForRefs = null;
        break;
      }

      case 'fillet':
      case 'chamfer': {
        if (!boxForRefs) {
          issues.push({
            clause: op.source,
            message: `${op.kind === 'fillet' ? '圆角' : '倒角'}目前只支持作用在长方体上（且需紧跟在长方体之后）`,
            level: 'error',
          });
          break;
        }
        const size = sub(boxForRefs.max, boxForRefs.min);
        const v = op.kind === 'fillet' ? op.radius : op.distance;
        const limit = edgeLimit(size, op.scope);
        if (v > limit) {
          issues.push({
            clause: op.source,
            message: `${op.kind === 'fillet' ? '圆角半径' : '倒角距离'} ${v} 超过限制（须不超过 ${limit.toFixed(2)}）`,
            level: 'error',
          });
          break;
        }
        const edges = boxEdges(boxForRefs, op.scope);
        if (op.kind === 'fillet') {
          const f: FilletFeature = {
            id: newId('f'),
            type: 'fillet',
            name: namer('fillet'),
            params: { edges, radius: v },
          };
          features.push(f);
          names.push(f.name);
          lastId = f.id;
        } else {
          const f: ChamferFeature = {
            id: newId('f'),
            type: 'chamfer',
            name: namer('chamfer'),
            params: { edges, distance: v },
          };
          features.push(f);
          names.push(f.name);
          lastId = f.id;
        }
        // 圆角/倒角不改变外轮廓的包围盒与上下表面位置，长方体引用继续有效
        break;
      }

      case 'shell': {
        if (!boxForRefs) {
          issues.push({ clause: op.source, message: '抽壳目前只支持作用在长方体上', level: 'error' });
          break;
        }
        const size = sub(boxForRefs.max, boxForRefs.min);
        const limit = Math.min(size[0], size[1], size[2]) / 2;
        if (op.thickness > limit) {
          issues.push({
            clause: op.source,
            message: `壁厚 ${op.thickness} 过大（须不超过 ${limit.toFixed(2)}）`,
            level: 'error',
          });
          break;
        }
        const f: ShellFeature = {
          id: newId('f'),
          type: 'shell',
          name: namer('shell'),
          params: { faces: [boxFace(boxForRefs, op.open)], thickness: op.thickness },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        break;
      }

      case 'linearPattern': {
        if (!lastId) {
          issues.push({ clause: op.source, message: '阵列需要先有一个特征作为种子', level: 'error' });
          break;
        }
        const dir: Vec3 = op.axis === 'y' ? [0, 1, 0] : op.axis === 'z' ? [0, 0, 1] : [1, 0, 0];
        const f: LinearPatternFeature = {
          id: newId('f'),
          type: 'linearPattern',
          name: namer('linearPattern'),
          params: { seedFeatureId: lastId, direction: dir, spacing: op.spacing, count: op.count },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        boxForRefs = null;
        break;
      }

      case 'circularPattern': {
        if (!lastId) {
          issues.push({ clause: op.source, message: '阵列需要先有一个特征作为种子', level: 'error' });
          break;
        }
        const axisDir: Vec3 = op.axis === 'x' ? [1, 0, 0] : op.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
        const origin = cur ? mid(cur.min, cur.max) : ([0, 0, 0] as Vec3);
        const f: CircularPatternFeature = {
          id: newId('f'),
          type: 'circularPattern',
          name: namer('circularPattern'),
          params: {
            seedFeatureId: lastId,
            axisOrigin: origin,
            axisDir,
            count: op.count,
            totalAngleDeg: op.totalAngleDeg,
            equalSpacing: true,
          },
        };
        features.push(f);
        names.push(f.name);
        lastId = f.id;
        boxForRefs = null;
        break;
      }
    }
  }

  return { features, issues, bbox: cur, names, refBox: boxForRefs };
}
