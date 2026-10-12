/**
 * 三角剖分 —— 把 B-rep 实体转成渲染用的三角网格。
 *
 * 实测要点：
 *  - BRep_Tool.Triangulation 返回的是 Handle，必须 .get() 才是 Poly_Triangulation
 *  - Poly_Triangle.Value(k)（k=1..3）返回 1-based 节点索引
 *  - 面若为 TopAbs_REVERSED，需要翻转三角形绕序
 *  - 每个面有独立的节点集，因此曲面内部光滑、面与面之间保留硬边，正是 CAD 想要的
 */
import { oc, gp, shapeKind, enumValue } from './occt';
import type { Shape } from './solid';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** 每个面在索引缓冲中的区间，用于拾取 */
  faceRanges: { start: number; count: number }[];
  /**
   * 与 faceRanges 一一对应的 TopoDS 面对象。
   * ⚠️ 只包含"有三角剖分"的面，因此长度可能与 S.faces(shape).length 不同；
   * 拾取时必须用这个数组而不是重新遍历实体。
   */
  faceList: any[];
  /** 面在实体中的序号 → 面索引 */
  faceCount: number;
  vertexCount: number;
  triangleCount: number;
}

export interface TessellationOptions {
  /** 线性偏差，越小越精细 */
  linearDeflection?: number;
  /** 角度偏差（弧度） */
  angularDeflection?: number;
}

/** 把 gp_Trsf 转成 3×4 行主序（用于把局部坐标变换到世界坐标） */
function trsfToRows(t: any): number[] {
  const m: number[] = [];
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 4; j++) m.push(t.Value(i, j));
  return m;
}

export function tessellate(shape: Shape, opts: TessellationOptions = {}): MeshData {
  const o = oc();
  const linear = opts.linearDeflection ?? 0.15;
  const angular = opts.angularDeflection ?? 0.35;

  if (!shape || shape.IsNull()) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      faceRanges: [],
      faceList: [],
      faceCount: 0,
      vertexCount: 0,
      triangleCount: 0,
    };
  }

  new o.BRepMesh_IncrementalMesh_2(shape, linear, false, angular, false);

  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const faceRanges: { start: number; count: number }[] = [];
  const faceList: any[] = [];

  const ex = new o.TopExp_Explorer_2(shape, o.TopAbs_ShapeEnum.TopAbs_FACE, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const loc = new o.TopLoc_Location_1();

  while (ex.More()) {
    const face = o.TopoDS.Face_1(ex.Current());
    const h = o.BRep_Tool.Triangulation(face, loc);

    if (h && !h.IsNull()) {
      const tri = h.get();
      const nbNodes = tri.NbNodes();
      const nbTris = tri.NbTriangles();
      const hasNormals = tri.HasNormals();
      // embind 枚举是包装对象，必须比 .value 而不是引用
      const reversed = enumValue(face.Orientation_1()) === enumValue(o.TopAbs_Orientation.TopAbs_REVERSED);

      // 局部坐标 → 世界坐标（本应用总是把变换烘焙进几何，通常 loc 是单位阵）
      let xf: number[] | null = null;
      try {
        if (loc.IsIdentity && !loc.IsIdentity()) {
          xf = trsfToRows(loc.Transformation());
        }
      } catch {
        xf = null;
      }

      const base = pos.length / 3;
      const idxStart = idx.length;

      for (let i = 1; i <= nbNodes; i++) {
        const p = tri.Node(i);
        let x = p.X(), y = p.Y(), z = p.Z();
        if (xf) {
          const nx = xf[0] * x + xf[1] * y + xf[2] * z + xf[3];
          const ny = xf[4] * x + xf[5] * y + xf[6] * z + xf[7];
          const nz = xf[8] * x + xf[9] * y + xf[10] * z + xf[11];
          x = nx; y = ny; z = nz;
        }
        pos.push(x, y, z);

        if (hasNormals) {
          const n = tri.Normal(i);
          const s = reversed ? -1 : 1;
          nrm.push(n.X() * s, n.Y() * s, n.Z() * s);
        } else {
          nrm.push(0, 0, 1);
        }
      }

      for (let i = 1; i <= nbTris; i++) {
        const t = tri.Triangle(i);
        const a = t.Value(1);
        const b = t.Value(2);
        const c = t.Value(3);
        if (reversed) {
          idx.push(base + a - 1, base + c - 1, base + b - 1);
        } else {
          idx.push(base + a - 1, base + b - 1, base + c - 1);
        }
      }

      // 没有法线的面：由三角形算面法线
      if (!hasNormals) {
        for (let i = idxStart; i < idx.length; i += 3) {
          const i0 = idx[i] * 3, i1 = idx[i + 1] * 3, i2 = idx[i + 2] * 3;
          const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
          const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const L = Math.hypot(nx, ny, nz) || 1;
          nx /= L; ny /= L; nz /= L;
          for (const ii of [idx[i], idx[i + 1], idx[i + 2]]) {
            nrm[ii * 3] = nx; nrm[ii * 3 + 1] = ny; nrm[ii * 3 + 2] = nz;
          }
        }
      }

      faceRanges.push({ start: idxStart, count: idx.length - idxStart });
      faceList.push(face);
    }

    ex.Next();
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: new Uint32Array(idx),
    faceRanges,
    faceList,
    faceCount: faceRanges.length,
    vertexCount: pos.length / 3,
    triangleCount: idx.length / 3,
  };
}

/** 某个面单独网格化（用于高亮单个面） */
export function tessellateFace(face: any, opts: TessellationOptions = {}): MeshData {
  return tessellate(face, opts);
}

// ============================================================
// 边离散化 —— 线框显示 & 工程图都用它
// ============================================================
export interface EdgePolyline {
  points: [number, number, number][];
  /** 是否为直线段 */
  isLine: boolean;
  closed: boolean;
}

export function discretizeEdge(edge: any, maxSegments = 48): EdgePolyline {
  const o = oc();
  const pts: [number, number, number][] = [];
  try {
    const curve = new o.BRepAdaptor_Curve_2(edge);
    const t0 = curve.FirstParameter();
    const t1 = curve.LastParameter();
    const n = Math.max(2, Math.min(maxSegments, 24));
    const p = new o.gp_Pnt_1();
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      curve.D0(t, p);
      pts.push([p.X(), p.Y(), p.Z()]);
    }
  } catch {
    /* 退化边，丢弃 */
  }
  return { points: pts, isLine: pts.length === 2, closed: false };
}

/** 提取实体的全部边折线（已去重） */
export function extractEdges(shape: Shape, maxSegments = 32): EdgePolyline[] {
  const o = oc();
  const out: EdgePolyline[] = [];
  if (!shape || shape.IsNull()) return out;
  const ex = new o.TopExp_Explorer_2(shape, o.TopAbs_ShapeEnum.TopAbs_EDGE, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const seen: any[] = [];
  while (ex.More()) {
    const e = o.TopoDS.Edge_1(ex.Current());
    ex.Next();
    if (seen.some((s) => s.IsSame(e))) continue;
    seen.push(e);
    const poly = discretizeEdge(e, maxSegments);
    if (poly.points.length >= 2) out.push(poly);
  }
  return out;
}

/**
 * 提取"特征边"对应的 TopoDS 边（相邻面二面角超过阈值）。
 *
 * 做法：先建面↔边邻接关系，再在边中点处取两侧面法向比较夹角。
 * 只有 1 个邻面的（开边界）一律保留；同一面出现两次的（旋转面的缝合线，
 * 如圆柱侧面那条竖线）法向夹角为 0，会被正确剔除。
 *
 * 返回裸 TopoDS 边，供拾取/引用使用；extractSharpEdges 在其上做离散化。
 */
export function extractSharpEdgeShapes(shape: Shape, angleThresholdDeg = 25): any[] {
  const o = oc();
  if (!shape || shape.IsNull()) return [];
  const cosThr = Math.cos((angleThresholdDeg * Math.PI) / 180);

  // 1) 收集面
  const faceShapes: any[] = [];
  const exF = new o.TopExp_Explorer_2(shape, o.TopAbs_ShapeEnum.TopAbs_FACE, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exF.More()) {
    faceShapes.push(o.TopoDS.Face_1(exF.Current()));
    exF.Next();
  }

  // 2) 每个面的三角质心 + 法向（用于在边附近取该面的朝向）
  const faceTris: { cx: number; cy: number; cz: number; nx: number; ny: number; nz: number }[][] = faceShapes.map((f) => {
    const m = tessellate(f, { linearDeflection: 0.2, angularDeflection: 0.5 });
    const tris: { cx: number; cy: number; cz: number; nx: number; ny: number; nz: number }[] = [];
    for (let t = 0; t < m.triangleCount; t++) {
      const i0 = m.indices[t * 3] * 3;
      const i1 = m.indices[t * 3 + 1] * 3;
      const i2 = m.indices[t * 3 + 2] * 3;
      tris.push({
        cx: (m.positions[i0] + m.positions[i1] + m.positions[i2]) / 3,
        cy: (m.positions[i0 + 1] + m.positions[i1 + 1] + m.positions[i2 + 1]) / 3,
        cz: (m.positions[i0 + 2] + m.positions[i1 + 2] + m.positions[i2 + 2]) / 3,
        nx: m.normals[i0],
        ny: m.normals[i0 + 1],
        nz: m.normals[i0 + 2],
      });
    }
    return tris;
  });

  // 3) 每个面包含哪些边
  const faceEdgeSets: any[][] = faceShapes.map((f) => {
    const arr: any[] = [];
    const ex = new o.TopExp_Explorer_2(f, o.TopAbs_ShapeEnum.TopAbs_EDGE, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (ex.More()) {
      arr.push(o.TopoDS.Edge_1(ex.Current()));
      ex.Next();
    }
    return arr;
  });

  // 4) 逐边判定（去重后）
  const out: any[] = [];
  const seen: any[] = [];
  const exE = new o.TopExp_Explorer_2(shape, o.TopAbs_ShapeEnum.TopAbs_EDGE, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exE.More()) {
    const e = o.TopoDS.Edge_1(exE.Current());
    exE.Next();
    if (seen.some((s) => s.IsSame(e))) continue;
    seen.push(e);

    const poly = discretizeEdge(e, 8);
    if (poly.points.length < 2) continue;

    const adj: number[] = [];
    for (let fi = 0; fi < faceEdgeSets.length; fi++) {
      if (faceEdgeSets[fi].some((fe) => fe.IsSame(e))) adj.push(fi);
    }

    let keep = true;
    if (adj.length === 2) {
      const mid = poly.points[Math.floor(poly.points.length / 2)];
      const n1 = nearestNormal(faceTris[adj[0]], mid);
      const n2 = nearestNormal(faceTris[adj[1]], mid);
      if (n1 && n2) {
        const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
        keep = Math.abs(dot) < cosThr;
      }
    } else if (adj.length === 1) {
      // 单邻面：既可能是开边界（保留），也可能是周期性曲面的缝合线（必须剔除）。
      // 圆柱/球面的缝合线只出现在一个面里，靠"两面法向夹角"判不出来，只能用曲面周期性识别。
      try {
        const surf = new o.BRepAdaptor_Surface_2(faceShapes[adj[0]], true);
        if (surf.IsUPeriodic() || surf.IsVPeriodic()) keep = false;
      } catch {
        /* 取不到就保留 */
      }
    }
    if (keep) out.push(e);
  }
  return out;
}

/** 特征边折线（用于线框显示） */
export function extractSharpEdges(shape: Shape, angleThresholdDeg = 25): EdgePolyline[] {
  const out: EdgePolyline[] = [];
  for (const e of extractSharpEdgeShapes(shape, angleThresholdDeg)) {
    const poly = discretizeEdge(e, 32);
    if (poly.points.length >= 2) out.push(poly);
  }
  return out;
}

function nearestNormal(
  tris: { cx: number; cy: number; cz: number; nx: number; ny: number; nz: number }[],
  p: [number, number, number]
): [number, number, number] | null {
  let best = Infinity;
  let bn: [number, number, number] | null = null;
  for (const t of tris) {
    const dx = t.cx - p[0], dy = t.cy - p[1], dz = t.cz - p[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      bn = [t.nx, t.ny, t.nz];
    }
  }
  return bn;
}
