/**
 * 截面属性（SolidWorks → 评估 → 截面属性，Section Properties）。
 *
 * 算法：把当前网格（三角面）与用户选定的平面求交，得到一系列 2D 线段，
 * 再把这些线段**缝合**成闭合多边形（支持多实体产生的多个外环、实体上的孔
 * 产生的内环）。随后用 Green 定理对每个环求带符号面积 / 质心 / 二阶矩，
 * 按带符号面积自动区分「外环(+)/孔(-)」并叠加，得到截面总面积、形心、
 * 形心轴惯性矩 Ixx/Iyy/Ixy、极惯性矩 Izz、主惯性矩与主方向、回转半径。
 *
 * 全部为纯几何（不 import DOM / 内核 / three），与 `units.ts` / `measure-math.ts`
 * 同惯例，可单测。网格法在显示精度下足够准确（与屏幕看到的截面一致）。
 */
import type { Vec3 } from './kernel-types';

export interface Plane {
  /** 单位法向 */
  n: Vec3;
  /** 平面上一点 */
  p0: Vec3;
}

export interface SectionProps {
  /** 截面总面积（长度²） */
  area: number;
  /** 形心（截面局部 2D 坐标） */
  cx: number;
  cy: number;
  /** 关于形心轴的惯性矩（长度⁴） */
  Ixx: number;
  Iyy: number;
  Ixy: number;
  /** 极惯性矩 Ixx+Iyy（长度⁴） */
  Izz: number;
  /** 主惯性矩（长度⁴） */
  Ix1: number;
  Iy1: number;
  /** 主方向角（弧度，关于局部 X 轴） */
  theta: number;
  /** 回转半径（长度） */
  Rx: number;
  Ry: number;
  /** 多边形环数（外环 + 孔） */
  loops: number;
}

/** 三个标准基准面对应的平面（法向 + 过原点） */
export type StandardPlaneId = 'front' | 'top' | 'right';

export function standardPlane(id: StandardPlaneId): { n: Vec3 } {
  switch (id) {
    case 'front': return { n: [0, 1, 0] }; // 前视：垂直 Y（XZ 平面）
    case 'top': return { n: [0, 0, 1] };   // 上视：垂直 Z（XY 平面）
    case 'right': return { n: [1, 0, 0] }; // 右视：垂直 X（YZ 平面）
  }
}

/** 求平面上一点 p0 沿法向偏移 d 后的截面平面 */
export function planeThrough(id: StandardPlaneId, offsetAlongNormal: number): Plane {
  const { n } = standardPlane(id);
  return { n, p0: [n[0] * offsetAlongNormal, n[1] * offsetAlongNormal, n[2] * offsetAlongNormal] };
}

/** 把 3D 点投影到平面局部 2D（选一组与法向正交的基 u,v） */
function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  // 选一个不与 n 平行的方向
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ux = n[1] * ref[2] - n[2] * ref[1];
  const uy = n[2] * ref[0] - n[0] * ref[2];
  const uz = n[0] * ref[1] - n[1] * ref[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  const u: Vec3 = [ux / ul, uy / ul, uz / ul];
  const v: Vec3 = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ];
  return { u, v };
}

const EPS = 1e-9;
/** 缝合用的坐标量化精度（mm）—— 远小于模型尺度，足以合并同一顶点 */
const KEY_EPS = 1e-3;

function keyOf(x: number, y: number): string {
  return `${Math.round(x / KEY_EPS)}|${Math.round(y / KEY_EPS)}`;
}

/**
 * 用平面切割三角网格，返回缝合后的闭合多边形（每个多边形是一组 2D 点）。
 * 空数组表示平面未与任何三角形相交。
 */
export function sliceMeshPlane(
  positions: Float32Array,
  indices: Uint32Array,
  plane: Plane
): [number, number][][] {
  const { u, v } = planeBasis(plane.n);
  const proj = (p: number[]): [number, number] => [
    p[0] * u[0] + p[1] * u[1] + p[2] * u[2],
    p[0] * v[0] + p[1] * v[1] + p[2] * v[2],
  ];

  // 收集线段（2D 端点对）
  type Seg = { a: [number, number]; b: [number, number] };
  const segs: Seg[] = [];
  const n = indices.length;
  for (let t = 0; t < n; t += 3) {
    const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
    const A: number[] = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
    const B: number[] = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
    const C: number[] = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];
    const dA = (A[0] - plane.p0[0]) * plane.n[0] + (A[1] - plane.p0[1]) * plane.n[1] + (A[2] - plane.p0[2]) * plane.n[2];
    const dB = (B[0] - plane.p0[0]) * plane.n[0] + (B[1] - plane.p0[1]) * plane.n[1] + (B[2] - plane.p0[2]) * plane.n[2];
    const dC = (C[0] - plane.p0[0]) * plane.n[0] + (C[1] - plane.p0[1]) * plane.n[1] + (C[2] - plane.p0[2]) * plane.n[2];
    const verts: number[][] = [A, B, C];
    const dists = [dA, dB, dC];
    // 统计严格正 / 负
    let pos = 0, neg = 0;
    for (const d of dists) {
      if (d > EPS) pos++;
      else if (d < -EPS) neg++;
    }
    if (pos === 0 || neg === 0) continue; // 平面未穿过该三角形（含相切）
    // 收集交点：每条跨越 0 的边插值
    const cross: number[][] = [];
    for (let e = 0; e < 3; e++) {
      const j = (e + 1) % 3;
      const de = dists[e], df = dists[j];
      if ((de > EPS && df < -EPS) || (de < -EPS && df > EPS)) {
        const t = de / (de - df);
        const P = [
          verts[e][0] + t * (verts[j][0] - verts[e][0]),
          verts[e][1] + t * (verts[j][1] - verts[e][1]),
          verts[e][2] + t * (verts[j][2] - verts[e][2]),
        ];
        cross.push(P);
      }
    }
    if (cross.length === 2) segs.push({ a: proj(cross[0]), b: proj(cross[1]) });
  }

  if (!segs.length) return [];

  // 按端点量化键建立邻接，缝合闭合多边形
  const used = new Array(segs.length).fill(false);
  const byKey = new Map<string, number[]>();
  const linkKey = (k: string, i: number) => {
    const arr = byKey.get(k);
    if (arr) arr.push(i);
    else byKey.set(k, [i]);
  };
  segs.forEach((s, i) => {
    linkKey(keyOf(s.a[0], s.a[1]), i);
    linkKey(keyOf(s.b[0], s.b[1]), i);
  });

  const loops: [number, number][][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    let cur = i;
    used[i] = true;
    const loop: [number, number][] = [segs[i].a];
    let endKey = keyOf(segs[i].b[0], segs[i].b[1]);
    const startKey = keyOf(segs[i].a[0], segs[i].a[1]);
    let guard = 0;
    while (guard++ < segs.length + 2) {
      const cands = (byKey.get(endKey) ?? []).filter((k) => !used[k]);
      if (!cands.length) break;
      const next = cands[0];
      used[next] = true;
      const s = segs[next];
      // 前进方向：让 b 接续当前 end
      const sKeyB = keyOf(s.b[0], s.b[1]);
      if (sKeyB === endKey) {
        loop.push(s.a);
        endKey = keyOf(s.a[0], s.a[1]);
      } else {
        loop.push(s.b);
        endKey = keyOf(s.b[0], s.b[1]);
      }
      if (endKey === startKey) break; // 闭合
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * 由闭合多边形（2D）计算截面属性。loops 为缝合后的多边形集合；
 * 带符号面积自动区分外环 / 孔。返回 null 表示无有效截面。
 */
export function computeSectionProps(loops: [number, number][][]): SectionProps | null {
  if (!loops.length) return null;

  let A = 0, Mx = 0, My = 0;          // 带符号面积、对原点的一次矩
  let Ix0 = 0, Iy0 = 0, Ixy0 = 0;      // 对原点的二阶矩（带符号）
  let valid = 0;

  for (const poly of loops) {
    const m = poly.length;
    if (m < 3) continue;
    let a = 0;
    let cx = 0, cy = 0;
    let ixx = 0, iyy = 0, ixy = 0;
    for (let i = 0; i < m; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % m];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
      ixx += (y0 * y0 + y0 * y1 + y1 * y1) * cross;
      iyy += (x0 * x0 + x0 * x1 + x1 * x1) * cross;
      ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < EPS) continue;
    cx /= 6 * a;
    cy /= 6 * a;
    ixx /= 12;
    iyy /= 12;
    ixy /= 24;
    A += a;
    Mx += a * cx;
    My += a * cy;
    Ix0 += ixx;
    Iy0 += iyy;
    Ixy0 += ixy;
    valid++;
  }
  if (!valid || Math.abs(A) < EPS) return null;

  const area = Math.abs(A);
  const Cx = Mx / A;
  const Cy = My / A;
  // 平行轴定理：平移到形心轴
  const Ixx = Ix0 - A * Cy * Cy;
  const Iyy = Iy0 - A * Cx * Cx;
  const Ixy = Ixy0 - A * Cx * Cy;
  const Izz = Ixx + Iyy;

  // 主惯性矩与方向
  const avg = (Ixx + Iyy) / 2;
  const diff = (Ixx - Iyy) / 2;
  const R = Math.hypot(diff, Ixy);
  const Ix1 = avg + R;
  const Iy1 = avg - R;
  const theta = 0.5 * Math.atan2(-2 * Ixy, Ixx - Iyy);
  const Rx = Math.sqrt(Math.max(Ixx, 0) / area);
  const Ry = Math.sqrt(Math.max(Iyy, 0) / area);

  return { area, cx: Cx, cy: Cy, Ixx, Iyy, Ixy, Izz, Ix1, Iy1, theta, Rx, Ry, loops: valid };
}
