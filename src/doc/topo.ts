/**
 * 拓扑信息提取 —— 为拾取与"几何命名"式的基准引用服务。
 */
import { oc, enumValue } from '../core/occt';
import * as S from '../core/solid';
import { tessellate, discretizeEdge, extractSharpEdgeShapes } from '../core/mesh';
import type { AxisRef, EdgeCurveType, FaceSurfaceType, Vec3 } from '../core/kernel-types';

export interface EdgeInfo {
  edge: any;
  /** 中点 */
  mid: [number, number, number];
  /** 单位方向 */
  dir: [number, number, number];
  /** 长度 */
  length: number;
  /** 曲线类型 */
  curveType: EdgeCurveType;
  /** 圆的轴线（中心 + 法向）；直线时 {point:起点, dir} */
  axis?: AxisRef;
  /** 圆的半径 */
  radius?: number;
  /** 直线两端点 */
  endpoints?: [Vec3, Vec3];
}

export interface FaceInfo {
  face: any;
  /** 面积质心 */
  centroid: [number, number, number];
  /** 面法向（面积加权平均） */
  normal: [number, number, number];
  /** 面积 */
  area: number;
  /** 解析曲面类型 */
  surfaceType: FaceSurfaceType;
  /** 圆柱/圆锥的轴线 */
  axis?: AxisRef;
  /** 圆柱/球面半径 */
  radius?: number;
}

/** gp_Ax1 → {point, dir} */
function ax1Of(a: any): AxisRef {
  const loc = a.Location();
  const d = a.Direction();
  return { point: [loc.X(), loc.Y(), loc.Z()], dir: [d.X(), d.Y(), d.Z()] };
}

const sub = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const norm = (v: [number, number, number]): [number, number, number] => {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
};

function edgeInfoOf(e: any): EdgeInfo | null {
  const o = oc();
  const poly = discretizeEdge(e, 16);
  if (poly.points.length < 2) return null;
  const p0 = poly.points[0];
  const p1 = poly.points[poly.points.length - 1];
  const mid: [number, number, number] = [
    (p0[0] + p1[0]) / 2,
    (p0[1] + p1[1]) / 2,
    (p0[2] + p1[2]) / 2,
  ];
  let length = 0;
  for (let i = 1; i < poly.points.length; i++) {
    const a = poly.points[i - 1];
    const b = poly.points[i];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const dir = norm(sub(p1, p0));
  let curveType: EdgeCurveType = 'other';
  let axis: AxisRef | undefined;
  let radius: number | undefined;
  try {
    const c = new o.BRepAdaptor_Curve_2(e);
    const t = enumValue(c.GetType());
    const gear = o.GeomAbs_CurveType;
    if (gear && t === enumValue(gear.GeomAbs_Line)) {
      curveType = 'line';
      axis = { point: [p0[0], p0[1], p0[2]], dir };
    } else if (gear && t === enumValue(gear.GeomAbs_Circle)) {
      curveType = 'circle';
      const circ = c.Circle();
      axis = ax1Of(circ.Axis());
      radius = circ.Radius();
    }
  } catch {
    /* 退化边：保留 other */
  }
  return {
    edge: e,
    mid,
    dir,
    length,
    curveType,
    axis,
    radius,
    endpoints: [p0, p1],
  };
}

export function edgeInfos(shape: any): EdgeInfo[] {
  if (!shape) return [];
  const out: EdgeInfo[] = [];
  for (const e of S.edges(shape)) {
    const info = edgeInfoOf(e);
    if (info) out.push(info);
  }
  return out;
}

/**
 * 只返回"特征边"（可被用户拾取的真实棱边）。
 * 圆柱/球面的缝合线会被剔除 —— 否则用户在线框里看到一条并不存在的竖线。
 */
export function featureEdgeInfos(shape: any, angleDeg = 25): EdgeInfo[] {
  if (!shape) return [];
  const out: EdgeInfo[] = [];
  for (const e of extractSharpEdgeShapes(shape, angleDeg)) {
    const info = edgeInfoOf(e);
    if (info) out.push(info);
  }
  return out;
}

export function faceInfos(shape: any): FaceInfo[] {
  const o = oc();
  if (!shape) return [];
  const out: FaceInfo[] = [];
  for (const f of S.faces(shape)) {
    let area = 0;
    let centroid: [number, number, number] = [0, 0, 0];
    let normal: [number, number, number] = [0, 0, 1];
    try {
      const g = new o.GProp_GProps_1();
      o.BRepGProp.SurfaceProperties_1(f, g, false, false);
      area = g.Mass();
      const c = g.CentreOfMass();
      centroid = [c.X(), c.Y(), c.Z()];
    } catch {
      /* 退化面 */
    }
    // 面积加权的平均法向（用三角网格）
    const m = tessellate(f, { linearDeflection: 0.4, angularDeflection: 0.6 });
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let t = 0; t < m.triangleCount; t++) {
      const i0 = m.indices[t * 3] * 3;
      const i1 = m.indices[t * 3 + 1] * 3;
      const i2 = m.indices[t * 3 + 2] * 3;
      const ux = m.positions[i1] - m.positions[i0];
      const uy = m.positions[i1 + 1] - m.positions[i0 + 1];
      const uz = m.positions[i1 + 2] - m.positions[i0 + 2];
      const vx = m.positions[i2] - m.positions[i0];
      const vy = m.positions[i2 + 1] - m.positions[i0 + 1];
      const vz = m.positions[i2 + 2] - m.positions[i0 + 2];
      const cx = uy * vz - uz * vy;
      const cy = uz * vx - ux * vz;
      const cz = ux * vy - uy * vx;
      const L = Math.hypot(cx, cy, cz) || 1;
      nx += cx / L;
      ny += cy / L;
      nz += cz / L;
    }
    if (Math.hypot(nx, ny, nz) > 1e-9) normal = norm([nx, ny, nz]);

    // 解析曲面类型 + 轴线（供装配拾取：平面 / 圆柱面 / 圆锥面…）
    let surfaceType: FaceSurfaceType = 'other';
    let axis: AxisRef | undefined;
    let radius: number | undefined;
    try {
      const ad = new o.BRepAdaptor_Surface_2(f, true);
      const t = enumValue(ad.GetType());
      const gs = o.GeomAbs_SurfaceType;
      if (gs) {
        if (t === enumValue(gs.GeomAbs_Plane)) surfaceType = 'plane';
        else if (t === enumValue(gs.GeomAbs_Cylinder)) {
          surfaceType = 'cylinder';
          const cyl = ad.Cylinder();
          axis = ax1Of(cyl.Axis());
          radius = cyl.Radius();
        } else if (t === enumValue(gs.GeomAbs_Cone)) {
          surfaceType = 'cone';
          axis = ax1Of(ad.Cone().Axis());
        } else if (t === enumValue(gs.GeomAbs_Sphere)) {
          surfaceType = 'sphere';
          const sp = ad.Sphere();
          const loc = sp.Location();
          axis = { point: [loc.X(), loc.Y(), loc.Z()], dir: [0, 0, 1] };
          radius = sp.Radius();
        } else if (t === enumValue(gs.GeomAbs_Torus)) surfaceType = 'torus';
      }
    } catch {
      /* 退化面 */
    }

    out.push({ face: f, centroid, normal, area, surfaceType, axis, radius });
  }
  return out;
}

/** 面是否为平面（用于抽壳/孔的候选筛选） */
export function isPlanarFace(face: any): boolean {
  const o = oc();
  try {
    const s = new o.BRepAdaptor_Surface_2(face, true);
    return enumValue(s.GetType()) === enumValue(o.GeomAbs_SurfaceType?.GeomAbs_Plane ?? 0);
  } catch {
    return false;
  }
}
