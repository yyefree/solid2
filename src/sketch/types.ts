/**
 * 草图数据模型。
 *
 * 设计要点：一切都归约到"点"。直线由两个点定义，圆由圆心点 + 半径定义，
 * 圆弧由圆心点 + 起点 + 终点定义（半径由 |a-c| = |b-c| 约束保证）。
 * 这样所有约束都能统一写成对点坐标的方程，求解器只需处理一种变量类型。
 */

export type PointId = string;
export type EntityId = string;
export type ConstraintId = string;

export interface SkPoint {
  id: PointId;
  x: number;
  y: number;
  /** 被用户"固定"的点（拖拽时作为锚点，求解器会给它极高权重） */
  fixed?: boolean;
}

export interface SkLine {
  id: EntityId;
  kind: 'line';
  a: PointId;
  b: PointId;
  construction?: boolean;
}

export interface SkCircle {
  id: EntityId;
  kind: 'circle';
  c: PointId;
  r: number;
  construction?: boolean;
}

export interface SkArc {
  id: EntityId;
  kind: 'arc';
  c: PointId;
  a: PointId;
  b: PointId;
  /** 从 a 到 b 是逆时针方向 */
  ccw: boolean;
  construction?: boolean;
}

/**
 * 椭圆。
 *
 * 与圆一样，只有**圆心**是求解变量；`rx`/`ry`/`rot` 是实体自身的参数（不可被约束驱动），
 * 这与 `SkCircle` 把半径放在实体上、只把圆心做成点变量的做法一致。
 * `rot` 是长轴相对草图 u 轴的夹角（弧度）。
 */
export interface SkEllipse {
  id: EntityId;
  kind: 'ellipse';
  /** 中心点 */
  c: PointId;
  /** 长半轴（沿长轴方向） */
  rx: number;
  /** 短半轴 */
  ry: number;
  /** 长轴相对草图 u 轴的旋转角（弧度） */
  rot: number;
  construction?: boolean;
}

/**
 * 独立草图点（SolidWorks 的「点」）。
 *
 * 不属于任何曲线的自由参考点：可被异型孔向导当作孔心、可被标注尺寸。
 * 它不参与闭环搜索（不会影响轮廓）。
 */
export interface SkPointEntity {
  id: EntityId;
  kind: 'point';
  p: PointId;
  construction?: boolean;
}

/**
 * 抛物线（FreeCAD Sketcher 的 Parabola）。
 *
 * 与圆 / 椭圆一致：**只有顶点是求解变量**，`focal`（焦距）与 `rot`（对称轴方向）是
 * 实体自身的参数。`t0`/`t1` 是**参数范围**，含义见 `parabolaPointAt`。
 */
export interface SkParabola {
  id: EntityId;
  kind: 'parabola';
  /** 顶点 */
  c: PointId;
  /** 焦距：顶点到焦点的距离，恒 > 0 */
  focal: number;
  /** 对称轴（开口方向）相对草图 u 轴的夹角（弧度） */
  rot: number;
  /** 参数范围下界 */
  t0: number;
  /** 参数范围上界 */
  t1: number;
  construction?: boolean;
}

/**
 * 双曲线（FreeCAD Sketcher 的 Hyperbola）。
 *
 * `a` / `b` 分别是实半轴与虚半轴，`rot` 是实轴相对草图 u 轴的夹角。
 * 双曲线有两支，本实现只取**右支**（实轴正向那一支）。
 */
export interface SkHyperbola {
  id: EntityId;
  kind: 'hyperbola';
  /** 中心 */
  c: PointId;
  /** 实半轴 */
  a: number;
  /** 虚半轴 */
  b: number;
  /** 实轴相对草图 u 轴的夹角（弧度） */
  rot: number;
  t0: number;
  t1: number;
  construction?: boolean;
}

/**
 * B 样条曲线（FreeCAD Sketcher 的 B-spline）。
 *
 * 采用**通过点（插值）**表示：用户给出一串点，曲线严格穿过每一个点。
 * 与其它实体不同，通过点直接以坐标存进实体（不建 `SkPoint`），因为它们不是
 * 约束求解变量——这与 `SkEllipse` 把 `rx/ry` 放在实体上的做法一致。
 * 控制点由 `bsplineInterpolate`（纯数学，见 `sketch/curve.ts`）算出。
 */
export interface SkBSpline {
  id: EntityId;
  kind: 'bspline';
  /** 通过点（按顺序，至少 2 个） */
  pts: [number, number][];
  /** 是否闭合（首尾相接且切向连续） */
  closed: boolean;
  construction?: boolean;
}

export type SkEntity =
  | SkLine
  | SkCircle
  | SkArc
  | SkEllipse
  | SkParabola
  | SkHyperbola
  | SkBSpline
  | SkPointEntity;

/** 椭圆的参数方程：局部坐标（未含中心平移） */
export function ellipsePointAt(e: { rx: number; ry: number; rot: number }, t: number): [number, number] {
  const x = e.rx * Math.cos(t);
  const y = e.ry * Math.sin(t);
  const cs = Math.cos(e.rot);
  const sn = Math.sin(e.rot);
  return [x * cs - y * sn, x * sn + y * cs];
}

/**
 * 抛物线参数方程（局部坐标，顶点在原点、对称轴沿局部 +X，开口朝 +X）：
 *
 *     X(t) = t² / (4·focal)      Y(t) = t
 *
 * ⚠️ 这个参数化与 OCCT `Geom_Parabola::D0(U)` **完全一致**（U 就是 Y 坐标，
 * 标准抛物线 y² = 4fx 以 y 为参数），所以实体的 `t0`/`t1` 可以原样交给
 * `Geom_TrimmedCurve` —— 预览折线与实际边不会出现"形状对不上"的问题。
 *
 * 焦点在 (focal, 0)，准线 x = −focal。
 */
export function parabolaPointAt(e: { focal: number; rot: number }, t: number): [number, number] {
  const f = Math.abs(e.focal) > 1e-12 ? e.focal : 1e-12;
  const x = (t * t) / (4 * f);
  const y = t;
  const cs = Math.cos(e.rot);
  const sn = Math.sin(e.rot);
  return [x * cs - y * sn, x * sn + y * cs];
}

/**
 * 双曲线参数方程（局部坐标，中心在原点、实轴沿局部 +X，取右支）：
 *
 *     X(t) = a·cosh(t)      Y(t) = b·sinh(t)
 *
 * 同样与 OCCT `Geom_Hyperbola::D0(U)` 一致。
 */
export function hyperbolaPointAt(e: { a: number; b: number; rot: number }, t: number): [number, number] {
  const x = e.a * Math.cosh(t);
  const y = e.b * Math.sinh(t);
  const cs = Math.cos(e.rot);
  const sn = Math.sin(e.rot);
  return [x * cs - y * sn, x * sn + y * cs];
}

export type ConstraintType =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equal'
  | 'concentric'
  | 'tangent'
  | 'distance'
  | 'length'
  | 'radius'
  | 'minorRadius'
  | 'diameter'
  | 'angle'
  | 'pointOnLine'
  | 'midpoint'
  | 'symmetric'
  | 'fix';

export interface SkConstraint {
  id: ConstraintId;
  type: ConstraintType;
  /** 参与约束的实体/点，含义随 type 变化 */
  e1?: EntityId;
  e2?: EntityId;
  p1?: PointId;
  p2?: PointId;
  /** 尺寸值（mm 或弧度） */
  value?: number;
  /** 是否为驱动尺寸（用户可编辑）；否则为几何关系 */
  driving?: boolean;
}

export interface Sketch {
  entities: SkEntity[];
  points: Record<PointId, SkPoint>;
  constraints: SkConstraint[];
  /** 求解状态 */
  status?: SolveStatus;
}

export interface SolveStatus {
  /** 自由度：0 = 完全定义 */
  dof: number;
  state: 'under' | 'well' | 'over' | 'failed';
  iterations: number;
  residual: number;
  message: string;
}

export interface SketchPlane {
  /** 平面原点 */
  origin: [number, number, number];
  /** 平面 X 轴（草图 u 方向） */
  u: [number, number, number];
  /** 平面 Y 轴（草图 v 方向） */
  v: [number, number, number];
  /** 法向 = u × v */
  normal: [number, number, number];
  /** 来源标识，用于在特征树里显示 */
  ref?: string;
}

export const DEFAULT_PLANE: SketchPlane = {
  origin: [0, 0, 0],
  u: [1, 0, 0],
  v: [0, 1, 0],
  normal: [0, 0, 1],
  ref: '前视基准面',
};

export const TOP_PLANE: SketchPlane = {
  origin: [0, 0, 0],
  u: [1, 0, 0],
  v: [0, 0, -1],
  normal: [0, 1, 0],
  ref: '上视基准面',
};

export const RIGHT_PLANE: SketchPlane = {
  origin: [0, 0, 0],
  u: [0, 1, 0],
  v: [0, 0, 1],
  normal: [1, 0, 0],
  ref: '右视基准面',
};

/** 草图局部坐标 → 世界坐标 */
export function planeToWorld(pl: SketchPlane, x: number, y: number, z = 0): [number, number, number] {
  return [
    pl.origin[0] + pl.u[0] * x + pl.v[0] * y + pl.normal[0] * z,
    pl.origin[1] + pl.u[1] * x + pl.v[1] * y + pl.normal[1] * z,
    pl.origin[2] + pl.u[2] * x + pl.v[2] * y + pl.normal[2] * z,
  ];
}

/** 世界坐标 → 草图局部坐标（返回 u, v, w） */
export function worldToPlane(pl: SketchPlane, p: [number, number, number]): [number, number, number] {
  const dx = p[0] - pl.origin[0];
  const dy = p[1] - pl.origin[1];
  const dz = p[2] - pl.origin[2];
  return [
    dx * pl.u[0] + dy * pl.u[1] + dz * pl.u[2],
    dx * pl.v[0] + dy * pl.v[1] + dz * pl.v[2],
    dx * pl.normal[0] + dy * pl.normal[1] + dz * pl.normal[2],
  ];
}

let uid = 0;
export function newId(prefix: string): string {
  uid += 1;
  return `${prefix}${uid.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function emptySketch(): Sketch {
  return { entities: [], points: {}, constraints: [] };
}

/** 圆弧的起止角 */
export function arcAngles(sk: Sketch, arc: SkArc): { a0: number; a1: number; r: number } {
  const c = sk.points[arc.c];
  const a = sk.points[arc.a];
  const b = sk.points[arc.b];
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  let a0 = Math.atan2(a.y - c.y, a.x - c.x);
  let a1 = Math.atan2(b.y - c.y, b.x - c.x);
  if (arc.ccw) {
    while (a1 <= a0) a1 += Math.PI * 2;
  } else {
    while (a1 >= a0) a1 -= Math.PI * 2;
  }
  return { a0, a1, r };
}

// ============================================================
// 直槽口：模板（工具与测试共用同一份构造逻辑）
// ============================================================
export interface SlotTemplate {
  /** 点顺序：[c1, c2, p1, p2, p3, p4]（p1/p2 在 +n 侧，p3/p4 在 −n 侧） */
  points: [number, number][];
  entities: (
    | { kind: 'line'; a: number; b: number }
    | { kind: 'arc'; c: number; a: number; b: number; ccw: boolean }
  )[];
}

/**
 * 直槽口几何：两圆心 `c1`/`c2` + 半径 `r` → 6 个点 + 4 个实体（2 线 + 2 半圆）。
 *
 * 四个切点由「轴向 u = (c2−c1)/L、法向 n = perp(u)」推出，因此两条直边与两个半圆
 * 天然相切，不需要额外约束。
 *
 * 闭合顺序 p1 → p2 →(弧)→ p3 → p4 →(弧)→ p1，整体沿「顺时针」绕行
 * （顶边 +u、右端帽下行、底边 −u、左端帽上行），因此**两个端帽的 ccw 都是 false**：
 *   - c1 端：p4 → p1，绕 c1 向 −u 侧鼓出（经 (−u·r) 点）⇒ 角度递减 ⇒ ccw = false
 *   - c2 端：p2 → p3，绕 c2 向 +u 侧鼓出（经 (+u·r) 点）⇒ 角度递减 ⇒ ccw = false
 * 注意：若 c2 端误写成 ccw = true，右端帽会向内鼓，槽口退化成 2r·L 的矩形。
 */
export function slotTemplate(c1: [number, number], c2: [number, number], r: number): SlotTemplate | null {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9 || r < 1e-9) return null;
  const nx = -dy / L;
  const ny = dx / L;
  const p1: [number, number] = [c1[0] + nx * r, c1[1] + ny * r];
  const p2: [number, number] = [c2[0] + nx * r, c2[1] + ny * r];
  const p3: [number, number] = [c2[0] - nx * r, c2[1] - ny * r];
  const p4: [number, number] = [c1[0] - nx * r, c1[1] - ny * r];
  return {
    points: [c1, c2, p1, p2, p3, p4],
    entities: [
      { kind: 'line', a: 2, b: 3 },
      { kind: 'line', a: 4, b: 5 },
      { kind: 'arc', c: 0, a: 5, b: 2, ccw: false },
      { kind: 'arc', c: 1, a: 3, b: 4, ccw: false },
    ],
  };
}

// ============================================================
// 镜像实体
// ============================================================
/** 点 p 关于直线 AB 的镜像点 */
export function reflectPoint(
  p: [number, number],
  A: [number, number],
  B: [number, number]
): [number, number] {
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const L2 = dx * dx + dy * dy || 1e-12;
  const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2;
  const fx = A[0] + dx * t;
  const fy = A[1] + dy * t;
  return [2 * fx - p[0], 2 * fy - p[1]];
}

/**
 * 把 `targetIds` 里的实体关于 `axisId` 这条直线镜像，结果**就地追加**到草图中。
 *
 * 镜像会翻转手性：圆弧 `ccw` 取反、椭圆 `rot` 关于轴方向取反（θ → 2θa − θ）。
 * 返回新增实体数。镜像轴本身不在 targetIds 里时才会被镜像。
 */
export function mirrorEntitiesInPlace(sk: Sketch, axisId: EntityId, targetIds: EntityId[]): number {
  const axis = sk.entities.find((e) => e.id === axisId);
  if (!axis || axis.kind !== 'line') return 0;
  const A = sk.points[axis.a];
  const B = sk.points[axis.b];
  const axisAngle = Math.atan2(B.y - A.y, B.x - A.x);

  const mapPoint = new Map<PointId, PointId>();
  const ensure = (pid: PointId): PointId => {
    const got = mapPoint.get(pid);
    if (got) return got;
    const p = sk.points[pid];
    const [nx, ny] = reflectPoint([p.x, p.y], [A.x, A.y], [B.x, B.y]);
    const nid = newId('p');
    sk.points[nid] = { id: nid, x: nx, y: ny };
    mapPoint.set(pid, nid);
    return nid;
  };

  let n = 0;
  for (const id of targetIds) {
    if (id === axisId) continue;
    const e = sk.entities.find((x) => x.id === id);
    if (!e) continue;
    const cons = e.construction;
    if (e.kind === 'line') {
      sk.entities.push({ id: newId('e'), kind: 'line', a: ensure(e.a), b: ensure(e.b), construction: cons });
    } else if (e.kind === 'circle') {
      sk.entities.push({ id: newId('e'), kind: 'circle', c: ensure(e.c), r: e.r, construction: cons });
    } else if (e.kind === 'arc') {
      sk.entities.push({ id: newId('e'), kind: 'arc', c: ensure(e.c), a: ensure(e.a), b: ensure(e.b), ccw: !e.ccw, construction: cons });
    } else if (e.kind === 'ellipse') {
      sk.entities.push({
        id: newId('e'), kind: 'ellipse', c: ensure(e.c), rx: e.rx, ry: e.ry,
        rot: 2 * axisAngle - e.rot, construction: cons,
      });
    } else if (e.kind === 'parabola') {
      // 抛物线关于轴镜像：顶点跟着镜像、对称轴方向取反（θ → 2θ轴 − θ）
      sk.entities.push({
        id: newId('e'), kind: 'parabola', c: ensure(e.c), focal: e.focal,
        rot: 2 * axisAngle - e.rot, t0: e.t0, t1: e.t1, construction: cons,
      });
    } else if (e.kind === 'hyperbola') {
      sk.entities.push({
        id: newId('e'), kind: 'hyperbola', c: ensure(e.c), a: e.a, b: e.b,
        rot: 2 * axisAngle - e.rot, t0: e.t0, t1: e.t1, construction: cons,
      });
    } else if (e.kind === 'bspline') {
      // B 样条通过点直接存坐标，逐个镜像即可（无需翻转手性）
      const pts = e.pts.map((p) => reflectPoint(p, [A.x, A.y], [B.x, B.y]));
      sk.entities.push({ id: newId('e'), kind: 'bspline', pts, closed: e.closed, construction: cons });
    } else {
      sk.entities.push({ id: newId('e'), kind: 'point', p: ensure(e.p), construction: cons });
    }
    n++;
  }
  return n;
}
