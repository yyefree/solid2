/**
 * 曲线几何（纯数学，不依赖几何内核）。
 *
 * 这里解决三件事：
 *  1. **草图路径采样**：把草图里的线/弧/圆串成一条有序 3D 折线（支持开放链与闭环）。
 *     —— 这是「扫描」能用开放路径的关键：草图求区域只认闭环，路径却必须是开放的。
 *  2. **螺旋 / 涡状线点列**：弹簧、螺纹、发条的骨架。
 *  3. **沿路径放置截面**：平行移动标架（旋转最小化）保证截面在整条路径上不扭转，
 *     再据此把 2D 截面放到每一站，交给放样（ThruSections）成体。
 *
 * ⚠️ 本文件绝不能 import oc/solid/mesh —— 主线程也要用它（对话框预览、特征树）。
 */
import {
  arcAngles, hyperbolaPointAt, parabolaPointAt, planeToWorld,
  type SkArc, type SkBSpline, type SkEntity, type SkHyperbola, type SkLine, type SkParabola,
  type Sketch, type SketchPlane,
} from './types';

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

// ============================================================
// 小工具
// ============================================================
export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function len3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function norm3(a: Vec3): Vec3 {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Rodrigues：把向量 v 绕单位轴 k 旋转 angRad */
export function rotateAbout(v: Vec3, k: Vec3, angRad: number): Vec3 {
  const kk = norm3(k);
  const c = Math.cos(angRad);
  const s = Math.sin(angRad);
  const kv = cross3(kk, v);
  const kd = dot3(kk, v);
  return [
    v[0] * c + kv[0] * s + kk[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + kk[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + kk[2] * kd * (1 - c),
  ];
}

/** 取一个与 t 垂直的单位向量 */
export function perpTo(t: Vec3): Vec3 {
  const tn = norm3(t);
  const ref: Vec3 = Math.abs(tn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const p = sub3(ref, scale3(tn, dot3(ref, tn)));
  return len3(p) > 1e-9 ? norm3(p) : [1, 0, 0];
}

// ============================================================
// 1. 草图路径 → 有序 3D 折线
// ============================================================
function sampleLine(a: Vec2, b: Vec2): Vec2[] {
  return [a, b];
}

/** 采样圆弧；forward=true 表示按 a→b 方向 */
function sampleArc(sk: Sketch, arc: SkArc, forward: boolean, segsPerTurn: number): Vec2[] {
  const { a0, a1, r } = arcAngles(sk, arc);
  const c = sk.points[arc.c];
  const [s0, s1] = forward ? [a0, a1] : [a1, a0];
  const sweep = Math.abs(s1 - s0);
  const n = Math.max(4, Math.ceil((segsPerTurn * sweep) / (Math.PI * 2)));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = s0 + ((s1 - s0) * i) / n;
    out.push([c.x + r * Math.cos(t), c.y + r * Math.sin(t)]);
  }
  return out;
}

function sampleCircle(sk: Sketch, e: { c: string; r: number }, segsPerTurn: number): Vec2[] {
  const c = sk.points[e.c];
  const n = Math.max(16, segsPerTurn);
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t)]);
  }
  return out;
}

type OpenEntity = SkLine | SkArc;

/**
 * 把草图实体串成若干条链（开放链优先，闭环次之），并采样成 2D 折线。
 * 排序规则：从"自由端"（只连一条实体的端点）出发，保证得到的折线是连续的路径。
 */
export function sketchPathPolylines(sk: Sketch, segsPerTurn = 64): Vec2[][] {
  const ents = sk.entities.filter((e) => !e.construction);
  if (!ents.length) return [];

  const open = ents.filter((e) => e.kind === 'line' || e.kind === 'arc') as OpenEntity[];
  const circles = ents.filter((e) => e.kind === 'circle') as { kind: 'circle'; c: string; r: number }[];
  // 高级曲线族（抛物线 / 双曲线 / B 样条）本身就是一条连续曲线，各自单独成链
  const curves = ents.filter(
    (e) => e.kind === 'parabola' || e.kind === 'hyperbola' || e.kind === 'bspline'
  ) as (SkParabola | SkHyperbola | SkBSpline)[];

  // 端点 → 关联实体
  const at = new Map<string, OpenEntity[]>();
  for (const e of open) {
    for (const p of [e.a, e.b]) {
      const arr = at.get(p);
      if (arr) arr.push(e);
      else at.set(p, [e]);
    }
  }
  const degAt = (p: string) => (at.get(p) ?? []).length;

  const used = new Set<OpenEntity>();
  const chains: Vec2[][] = [];

  // 先处理有自由端的链；再从剩余里任取（纯闭环）
  const starts = [...open].sort((x, y) => {
    const dx = Math.min(degAt(x.a), degAt(x.b));
    const dy = Math.min(degAt(y.a), degAt(y.b));
    return dx - dy;
  });

  for (const start of starts) {
    if (used.has(start)) continue;
    const from0 = degAt(start.a) === 1 ? start.a : degAt(start.b) === 1 ? start.b : start.a;
    const poly: Vec2[] = [];
    let cur: OpenEntity | undefined = start;
    let from = from0;
    for (let guard = 0; guard <= open.length + 2 && cur; guard++) {
      if (used.has(cur)) break;
      used.add(cur);
      const to = from === cur.a ? cur.b : cur.a;
      const forward = from === cur.a;
      const pts =
        cur.kind === 'line'
          ? sampleLine(
              forward ? [sk.points[cur.a].x, sk.points[cur.a].y] : [sk.points[cur.b].x, sk.points[cur.b].y],
              forward ? [sk.points[cur.b].x, sk.points[cur.b].y] : [sk.points[cur.a].x, sk.points[cur.a].y]
            )
          : sampleArc(sk, cur, forward, segsPerTurn);
      for (const p of pts) pushUnique(poly, p);
      const next = (at.get(to) ?? []).find((x) => !used.has(x));
      cur = next;
      from = to;
    }
    if (poly.length >= 2) chains.push(poly);
  }

  for (const c of circles) chains.push(sampleCircle(sk, c, segsPerTurn));
  for (const c of curves) {
    const pts = sampleCurveEntity(sk, c, segsPerTurn);
    if (pts.length >= 2) chains.push(pts);
  }
  return chains;
}

/** 采样「高级曲线族」实体为 2D 折线（纯数学，供路径链与预览使用） */
function sampleCurveEntity(sk: Sketch, e: SkParabola | SkHyperbola | SkBSpline, segsPerTurn: number): Vec2[] {
  const n = Math.max(segsPerTurn * 2, 96);
  if (e.kind === 'parabola') {
    const c = sk.points[e.c];
    const out: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = e.t0 + ((e.t1 - e.t0) * i) / n;
      const [dx, dy] = parabolaPointAt(e, t);
      out.push([c.x + dx, c.y + dy]);
    }
    return out;
  }
  if (e.kind === 'hyperbola') {
    const c = sk.points[e.c];
    const out: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = e.t0 + ((e.t1 - e.t0) * i) / n;
      const [dx, dy] = hyperbolaPointAt(e, t);
      out.push([c.x + dx, c.y + dy]);
    }
    return out;
  }
  const data = bsplineInterpolate(e.pts, 3, e.closed);
  return data ? bsplinePolyline(data, n) : [];
}

function pushUnique(poly: Vec2[], p: Vec2, eps = 1e-9): void {
  const last = poly[poly.length - 1];
  if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) <= eps) return;
  poly.push(p);
}

/**
 * 草图 → 世界坐标下的一条路径折线。
 * 多链时取最长的一条（最符合"路径"的直觉），其余链忽略。
 */
export function sampleSketchPath(sk: Sketch, pl: SketchPlane, segsPerTurn = 64): Vec3[] {
  const chains = sketchPathPolylines(sk, segsPerTurn);
  if (!chains.length) return [];
  let best = chains[0];
  for (const c of chains) if (pathLength2(c) > pathLength2(best)) best = c;
  return best.map(([x, y]) => planeToWorld(pl, x, y));
}

export function pathLength2(poly: Vec2[]): number {
  let s = 0;
  for (let i = 1; i < poly.length; i++) s += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return s;
}

export function pathLength3(pts: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += len3(sub3(pts[i], pts[i - 1]));
  return s;
}

// ============================================================
// 2. 螺旋线 / 涡状线
// ============================================================
export interface HelixSpec {
  /** 螺旋轴起点（轴线上一点） */
  origin: Vec3;
  /** 螺旋轴方向 */
  axis: Vec3;
  /** 起始半径（中径的一半） */
  radius: number;
  /** 螺距（每圈轴向进给） */
  pitch: number;
  /** 圈数（可为小数） */
  turns: number;
  /** 旋向：右旋（默认）/ 左旋 */
  handedness?: 'right' | 'left';
  /** 起始角（度） */
  startAngleDeg?: number;
  /** 锥度（度）：半径沿轴向线性变化，0 = 圆柱螺旋 */
  taperDeg?: number;
  /** 每圈采样段数 */
  segsPerTurn?: number;
}

/** 由轴向构造正交基（e1, e2, e3=轴向） */
export function axisFrame(axis: Vec3): { e1: Vec3; e2: Vec3; e3: Vec3 } {
  const e3 = norm3(axis);
  const e1 = perpTo(e3);
  const e2 = norm3(cross3(e3, e1));
  return { e1, e2, e3 };
}

/** 螺旋线点列（世界坐标），圈数可为小数；支持锥度与旋向 */
export function helixPoints(spec: HelixSpec): Vec3[] {
  const {
    origin,
    axis,
    radius,
    pitch,
    turns,
    handedness = 'right',
    startAngleDeg = 0,
    taperDeg = 0,
    segsPerTurn = 24,
  } = spec;
  const { e1, e2, e3 } = axisFrame(axis);
  const n = Math.max(2, Math.round(segsPerTurn * turns));
  const dir = handedness === 'left' ? -1 : 1;
  const a0 = (startAngleDeg * Math.PI) / 180;
  const height = pitch * turns;
  const taper = Math.tan((taperDeg * Math.PI) / 180);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const t = a0 + dir * f * turns * Math.PI * 2;
    const r = Math.max(radius + taper * height * f, 1e-3);
    out.push([
      origin[0] + e1[0] * r * Math.cos(t) + e2[0] * r * Math.sin(t) + e3[0] * height * f,
      origin[1] + e1[1] * r * Math.cos(t) + e2[1] * r * Math.sin(t) + e3[1] * height * f,
      origin[2] + e1[2] * r * Math.cos(t) + e2[2] * r * Math.sin(t) + e3[2] * height * f,
    ]);
  }
  return out;
}

export interface SpiralSpec {
  /** 起始半径 */
  startRadius: number;
  /** 每圈径向增量（螺距） */
  pitch: number;
  turns: number;
  handedness?: 'right' | 'left';
  startAngleDeg?: number;
  segsPerTurn?: number;
}

/** 平面涡状线（阿基米德螺线）的 2D 点列 */
export function spiralPoints2D(spec: SpiralSpec): Vec2[] {
  const { startRadius, pitch, turns, handedness = 'right', startAngleDeg = 0, segsPerTurn = 24 } = spec;
  const n = Math.max(2, Math.round(segsPerTurn * turns));
  const dir = handedness === 'left' ? -1 : 1;
  const a0 = (startAngleDeg * Math.PI) / 180;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const t = a0 + dir * f * turns * Math.PI * 2;
    const r = Math.max(startRadius + pitch * turns * f, 1e-3);
    out.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return out;
}

/**
 * 涡状线带材的闭合 2D 轮廓（外螺线正向 + 内螺线反向），用于拉伸成"涡卷弹簧 / 发条"。
 * 带厚 = 径向宽度，沿法向拉伸得到带材宽度。
 */
export function spiralRibbon2D(spec: SpiralSpec & { thickness: number }): Vec2[] {
  const half = Math.max(spec.thickness, 1e-3) / 2;
  const outer = spiralPoints2D({ ...spec, startRadius: spec.startRadius + half });
  const inner = spiralPoints2D({ ...spec, startRadius: Math.max(spec.startRadius - half, 1e-3) });
  const poly: Vec2[] = [];
  for (const p of outer) pushUnique(poly, p);
  for (let i = inner.length - 1; i >= 0; i--) pushUnique(poly, inner[i]);
  return poly;
}

// ============================================================
// 3. 沿路径的标架与截面放置
// ============================================================
/** 折线每点的单位切向（中心差分） */
export function polylineTangents(pts: Vec3[]): Vec3[] {
  const n = pts.length;
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const d = sub3(b, a);
    out.push(len3(d) > 1e-12 ? norm3(d) : ([0, 0, 1] as Vec3));
  }
  return out;
}

export interface Frame {
  u: Vec3;
  v: Vec3;
}

/**
 * 平行移动标架（旋转最小化）：把首站的 u 沿最短弧逐站搬运，保证截面不扭转。
 * 这是替代 OCCT `MakePipe` 的关键——`MakePipe` 在折线/曲线上会算出退化结果。
 */
export function transportFrames(tangents: Vec3[], up?: Vec3): Frame[] {
  const n = tangents.length;
  if (!n) return [];
  const t0 = norm3(tangents[0]);
  let u0: Vec3;
  if (up) {
    const p = sub3(up, scale3(t0, dot3(up, t0)));
    u0 = len3(p) > 1e-9 ? norm3(p) : perpTo(t0);
  } else {
    u0 = perpTo(t0);
  }
  const out: Frame[] = [{ u: u0, v: norm3(cross3(t0, u0)) }];
  let u = u0;
  for (let i = 1; i < n; i++) {
    const tp = norm3(tangents[i - 1]);
    const tc = norm3(tangents[i]);
    const axis = cross3(tp, tc);
    const s = len3(axis);
    if (s > 1e-12) u = rotateAbout(u, scale3(axis, 1 / s), Math.atan2(s, dot3(tp, tc)));
    const proj = sub3(u, scale3(tc, dot3(u, tc)));
    u = len3(proj) > 1e-9 ? norm3(proj) : perpTo(tc);
    out.push({ u, v: norm3(cross3(tc, u)) });
  }
  return out;
}

/** 把 2D 截面逐站放到 3D 路径上（截面点 = 站点 + u·a + v·b） */
export function placeSections(profile2d: Vec2[], pts: Vec3[], frames: Frame[]): Vec3[][] {  const last = frames[frames.length - 1] ?? { u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 };
  return pts.map((p, i) => {
    const f = frames[i] ?? last;
    return profile2d.map(
      ([a, b]) =>
        [
          p[0] + f.u[0] * a + f.v[0] * b,
          p[1] + f.u[1] * a + f.v[1] * b,
          p[2] + f.u[2] * a + f.v[2] * b,
        ] as Vec3
    );
  });
}

/** 去掉连续重复点（放样要求截面点列干净） */
export function cleanLoop(poly: Vec3[], eps = 1e-7): Vec3[] {
  const out: Vec3[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && len3(sub3(last, p)) <= eps) continue;
    out.push(p);
  }
  while (out.length >= 2 && len3(sub3(out[0], out[out.length - 1])) <= eps) out.pop();
  return out;
}

// ============================================================
// 4. 常用截面
// ============================================================
/** 圆截面（局部坐标 (a,b)，a 沿 u，b 沿 v） */
export function circleProfile(radius: number, segs = 24): Vec2[] {
  const n = Math.max(8, segs);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([radius * Math.cos(t), radius * Math.sin(t)]);
  }
  return out;
}

/** 矩形截面（宽 w 沿 u，高 h 沿 v，居中） */
export function rectProfile(w: number, h: number): Vec2[] {
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

/** 去掉连续重复的 2D 点（草图区域轮廓在实体接缝处会重复） */
export function cleanLoop2(poly: Vec2[], eps = 1e-7): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) <= eps) continue;
    out.push(p);
  }
  while (out.length >= 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

/** 单位换算：把"圈/螺距/中径"换算成弹簧自由高度 */
export function springFreeHeight(pitch: number, turns: number): number {
  return pitch * turns;
}

// ============================================================
// 5. B 样条：全局曲线插值（Piegl & Tiller《The NURBS Book》A9.1）
// ============================================================
/**
 * 一条 B 样条的完整描述。
 *
 * `knots`/`mults` 是**去重后**的节点向量与多重度，可以直接喂给
 * OCCT `Geom_BSplineCurve_1(poles, knots, mults, degree, periodic)`；
 * 而 `bsplineEval` 内部会把它展开回完整节点向量做 Cox–de Boor 求值，
 * 因此**预览折线与 OCCT 边严格是同一条曲线**。
 */
export interface BsplineData {
  degree: number;
  /** 去重后的节点向量（长度 = mults.length） */
  knots: number[];
  /** 每个节点的多重度，Σ mults = poles.length + degree + 1 */
  mults: number[];
  /** 控制点（2D） */
  poles: Vec2[];
}

/**
 * B 样条基函数 `N_{i,p}(u)`（Cox–de Boor 递推）。
 *
 * 零次基函数用**半开区间** `[U_i, U_{i+1})`，只有最后一个区间取闭区间，
 * 这样 `u` 恰好等于末端节点时仍能命中最后一个非零基函数。
 */
export function bsplineBasis(i: number, p: number, u: number, U: number[]): number {
  if (p === 0) {
    const last = U.length - 1;
    if (u >= U[i] && (u < U[i + 1] || (i + 1 === last && u <= U[i + 1]))) return 1;
    return 0;
  }
  let left = 0;
  let right = 0;
  const d1 = U[i + p] - U[i];
  if (d1 > 1e-12) left = ((u - U[i]) / d1) * bsplineBasis(i, p - 1, u, U);
  const d2 = U[i + p + 1] - U[i + 1];
  if (d2 > 1e-12) right = ((U[i + p + 1] - u) / d2) * bsplineBasis(i + 1, p - 1, u, U);
  return left + right;
}

/** 解 n×n 线性方程组 A·x = b（高斯消元 + 部分主元） */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const t = M[piv];
      M[piv] = M[col];
      M[col] = t;
    }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * 全局曲线插值：给出一串**通过点**，求出一条**严格穿过每个点**的 B 样条。
 *
 * 1. 弦长参数化 `u_k = u_{k-1} + |Q_k − Q_{k-1}| / Σ|ΔQ|`
 * 2. 平均技术求节点向量 `U_{j+p} = (1/p)·Σ_{i=j}^{j+p-1} u_i`
 * 3. 对每个 `u_k` 列出 `Σ N_{i,p}(u_k)·P_i = Q_k`，解线性方程组得控制点
 *
 * 点数不足时自动降次（`p = min(degree, n)`），因此 2 个点也能画出直线段。
 * `closed` 时把前 `p` 个点补到末尾，得到首尾 p 阶连续（视觉光滑）的闭合曲线。
 */
export function bsplineInterpolate(pts: Vec2[], degree = 3, closed = false): BsplineData | null {
  // 1. 去掉连续重复点（会让弦长参数化退化）
  const Q: Vec2[] = [];
  for (const p of pts) {
    const last = Q[Q.length - 1];
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 1e-9) continue;
    Q.push([p[0], p[1]]);
  }
  // 闭合时若首尾已重合，去掉末尾那个重复点（避免参数化退化）
  if (closed) {
    while (Q.length >= 2 && Math.hypot(Q[0][0] - Q[Q.length - 1][0], Q[0][1] - Q[Q.length - 1][1]) < 1e-9) Q.pop();
  }
  if (Q.length < 2) return null;

  const p = Math.max(1, Math.min(degree, Q.length - 1));

  // 2. 闭合：末尾补回起点，使曲线回到 Q_0（首尾重合，可直接当闭合轮廓用）
  const P: Vec2[] = closed ? [...Q, Q[0]] : Q;
  const m = P.length - 1; // 控制点数 − 1

  // 3. 弦长参数化
  const uk: number[] = [0];
  let total = 0;
  for (let i = 1; i <= m; i++) {
    total += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    uk.push(total);
  }
  if (total < 1e-12) return null;
  for (let i = 0; i <= m; i++) uk[i] /= total;

  // 4. 平均技术节点向量（长度 m+p+2；前 p+1 个为 0，后 p+1 个为 1）
  const U: number[] = new Array(m + p + 2).fill(0);
  for (let i = m + 1; i <= m + p + 1; i++) U[i] = 1;
  for (let j = 1; j <= m - p; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += uk[i];
    U[j + p] = s / p;
  }

  // 5. 解方程组
  const A: number[][] = [];
  const bx: number[] = [];
  const by: number[] = [];
  for (let k = 0; k <= m; k++) {
    const uu = Math.min(uk[k], 1 - 1e-12);
    const row: number[] = [];
    for (let i = 0; i <= m; i++) row.push(bsplineBasis(i, p, uu, U));
    A.push(row);
    bx.push(P[k][0]);
    by.push(P[k][1]);
  }
  const px = solveLinear(A, bx);
  const py = solveLinear(A, by);
  if (!px || !py) return null;
  const poles: Vec2[] = px.map((x, i) => [x, py[i]] as Vec2);

  // 6. 节点去重 → knots + mults
  const knots: number[] = [];
  const mults: number[] = [];
  for (const u of U) {
    if (knots.length && Math.abs(u - knots[knots.length - 1]) < 1e-12) mults[mults.length - 1]++;
    else {
      knots.push(u);
      mults.push(1);
    }
  }
  return { degree: p, knots, mults, poles };
}

/** 把去重节点展开成完整节点向量 */
export function expandKnots(data: BsplineData): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.knots.length; i++) {
    for (let k = 0; k < data.mults[i]; k++) out.push(data.knots[i]);
  }
  return out;
}

/** 求值：`u ∈ [U_p, U_{n+1}]` → 曲线上的点（基函数加权和，等价于 De Boor） */
export function bsplineEval(data: BsplineData, u: number, full?: number[]): Vec2 {
  const U = full ?? expandKnots(data);
  const p = data.degree;
  const hi = U[U.length - 1 - p];
  let uu = Math.max(U[p], Math.min(u, hi));
  if (uu >= hi) uu = hi - 1e-12;
  let x = 0;
  let y = 0;
  for (let i = 0; i < data.poles.length; i++) {
    const b = bsplineBasis(i, p, uu, U);
    x += b * data.poles[i][0];
    y += b * data.poles[i][1];
  }
  return [x, y];
}

/** 采样为折线（预览 / 包围盒 / 命中测试用） */
export function bsplinePolyline(data: BsplineData, n = 96): Vec2[] {
  const U = expandKnots(data);
  const p = data.degree;
  const lo = U[p];
  const hi = U[U.length - 1 - p];
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = lo + ((hi - lo) * i) / n;
    out.push(bsplineEval(data, u, U));
  }
  return out;
}

export type { SkEntity };
