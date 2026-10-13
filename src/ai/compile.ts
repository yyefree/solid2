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

import { newId, type SketchPlane } from '../sketch/types';
import type {
  ChamferFeature,
  CircularPatternFeature,
  EdgeRef,
  FaceRef,
  Feature,
  FilletFeature,
  HoleFeature,
  LinearPatternFeature,
  PrimitiveFeature,
  ShellFeature,
  SpringFeature,
} from '../doc/types';
import type { AiOp, AiSpringOp, ParseIssue, Placement, Vec3 } from './types';

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

// ---------- 向量小工具 ----------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

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
function unionBox(a: Box, b: Box): Box {
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
 * 编译入口：把一份建模计划变成文档特征。
 * 顺序即特征树顺序；后面的特征可以引用前面的实体。
 */
export function compilePlan(ops: AiOp[], opts: CompileOptions = {}): CompileResult {
  const namer = opts.namer ?? makeNamer();
  const features: Feature[] = [];
  const issues: ParseIssue[] = [];
  const names: string[] = [];

  /** 当前累计包围盒（所有实体并集）；追加模式下从现有模型续起 */
  let cur: Box | null = opts.initialBBox ?? null;
  /** 只有「上一个实体是纯长方体」时才非空，供解析式边/面引用使用 */
  let boxForRefs: Box | null = opts.initialBoxForRefs ?? null;
  /** 上一个特征 id（阵列的种子） */
  let lastId: string | null = opts.initialLastId ?? null;

  for (const op of ops) {
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
