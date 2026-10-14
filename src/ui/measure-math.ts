/**
 * 「测量」工具的纯几何计算（不 import DOM / 内核 / three）。
 *
 * 与 `sketch/curve.ts` 同样的原则：主线程对话框与 Node 单测都能直接用。
 * 三角网格距离为精确到面片的扫描（平面/直线情形即精确值）；
 * 面↔面 / 边↔边 / 面↔边 的最小距离走内核 BRepExtrema（见 measure.ts）。
 */
import type { MeshResult, Vec3 } from '../core/kernel-types';

export function vecDist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 点 p 到线段 ab 的最短距离 */
export function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  if (len2 < 1e-18) return vecDist(p, a);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return vecDist(p, [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t]);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 点 p 到三角形 abc 的最短距离（Ericson, Real-Time Collision Detection） */
export function pointTriangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return vecDist(p, a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return vecDist(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return vecDist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return vecDist(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return vecDist(p, [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return vecDist(p, [b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t, b[2] + (c[2] - b[2]) * t]);
  }
  const denom = 1 / (va + vb + vc);
  const t = vb * denom;
  const w = vc * denom;
  return vecDist(p, [
    a[0] + ab[0] * t + ac[0] * w,
    a[1] + ab[1] * t + ac[1] * w,
    a[2] + ab[2] * t + ac[2] * w,
  ]);
}

/** 点 p 到第 faceIdx 个面（三角网格）的最短距离 */
export function pointFaceDistance(p: Vec3, faceIdx: number, mesh: MeshResult): number {
  const r = mesh.faceRanges[faceIdx];
  if (!r || r.count < 3) return Number.NaN;
  const pos = new Float32Array(mesh.positions);
  const idx = new Uint32Array(mesh.indices);
  let best = Number.POSITIVE_INFINITY;
  for (let t = r.start; t + 2 < r.start + r.count; t += 3) {
    const i0 = idx[t] * 3;
    const i1 = idx[t + 1] * 3;
    const i2 = idx[t + 2] * 3;
    const a: Vec3 = [pos[i0], pos[i0 + 1], pos[i0 + 2]];
    const b: Vec3 = [pos[i1], pos[i1 + 1], pos[i1 + 2]];
    const c: Vec3 = [pos[i2], pos[i2 + 1], pos[i2 + 2]];
    const d = pointTriangleDistance(p, a, b, c);
    if (d < best) best = d;
  }
  return best;
}

/** 点 p 到第 edgeIdx 条边（离散折线）的最短距离 */
export function pointEdgeDistance(p: Vec3, edgeIdx: number, mesh: MeshResult): number {
  const flat = mesh.edgePolylines[edgeIdx];
  if (!flat || flat.length < 6) return Number.NaN;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 5 < flat.length; i += 3) {
    const a: Vec3 = [flat[i], flat[i + 1], flat[i + 2]];
    const b: Vec3 = [flat[i + 3], flat[i + 4], flat[i + 5]];
    const d = pointSegmentDistance(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

/** 两方向夹角（度，取锐角 0~90） */
export function angleBetweenDeg(u: Vec3, v: Vec3): number {
  const nu = Math.sqrt(dot(u, u));
  const nv = Math.sqrt(dot(v, v));
  if (nu < 1e-12 || nv < 1e-12) return 0;
  const c = Math.min(1, Math.abs(dot(u, v)) / (nu * nv));
  return (Math.acos(c) * 180) / Math.PI;
}
