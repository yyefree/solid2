/**
 * 几何内核引擎（仅 Worker 调用）。
 *
 * 这一层把"特征树 → TopoDS_Shape"的求值逻辑完整搬进 Worker：
 * 主线程把纯 JSON 特征传进来，这里用 opencascade 重放一遍，
 * 返回不透明的 TopoDS_Shape（只在 Worker 内存在）。再配合 `mesh.ts` / `topo.ts`
 * 把结果转成可序列化的 MeshResult / 统计量，交给主线程渲染。
 *
 * ⚠️ 本文件 import 了 `solid` / `mesh` / `topo` / `toShape` —— 全部 OCCT 耦合，
 * 绝不能出现在主线程的 import 链里。
 */
import * as S from '../core/solid';
import { tessellate, discretizeEdge } from '../core/mesh';
import { sketchToRegions, regionToFace } from '../sketch/toShape';
import { buildRibProfile } from '../sketch/rib';
import { solveSketch } from '../sketch/solver';
import {
  cleanLoop,
  cleanLoop2,
  helixPoints,
  placeSections,
  polylineTangents,
  sampleSketchPath,
  spiralRibbon2D,
  transportFrames,
  type Vec2,
  type Vec3,
} from '../sketch/curve';
import { edgeInfos, faceInfos, featureEdgeInfos, type EdgeInfo, type FaceInfo } from './topo';
import { CadDocument, planeOf, worldFromSketch, type EvalOut } from './model';
import type { MeshResult, FaceMeta, EdgeMeta } from '../core/kernel-types';
import type {
  BooleanOp,
  EdgeRef,
  FaceRef,
  Feature,
  FeatureId,
  MirrorFeature,
  PlaneRef,
  SketchFeature,
} from './types';

// ============================================================
// 几何命名的引用解析（用近似几何在最新拓扑里找对应元素）
// ============================================================
export function resolveEdges(shape: any, refs: EdgeRef[]): any[] {
  const infos = edgeInfos(shape);
  const out: any[] = [];
  for (const r of refs) {
    let best: EdgeInfo | null = null;
    let bestScore = Infinity;
    for (const info of infos) {
      const d = Math.hypot(
        info.mid[0] - r.point[0],
        info.mid[1] - r.point[1],
        info.mid[2] - r.point[2]
      );
      let score = d;
      if (r.dir) {
        const dot = Math.abs(info.dir[0] * r.dir[0] + info.dir[1] * r.dir[1] + info.dir[2] * r.dir[2]);
        score += (1 - dot) * 2;
      }
      if (score < bestScore) {
        bestScore = score;
        best = info;
      }
    }
    if (best && !out.some((e) => e.IsSame(best!.edge))) out.push(best.edge);
  }
  return out;
}

export function resolveFaces(shape: any, refs: FaceRef[]): any[] {
  const infos = faceInfos(shape);
  const out: any[] = [];
  for (const r of refs) {
    let best: FaceInfo | null = null;
    let bestScore = Infinity;
    for (const info of infos) {
      const d = Math.hypot(
        info.centroid[0] - r.point[0],
        info.centroid[1] - r.point[1],
        info.centroid[2] - r.point[2]
      );
      let score = d;
      if (r.normal) {
        const dot =
          info.normal[0] * r.normal[0] + info.normal[1] * r.normal[1] + info.normal[2] * r.normal[2];
        score += (1 - dot) * 2;
      }
      if (score < bestScore) {
        bestScore = score;
        best = info;
      }
    }
    if (best && !out.some((f) => f.IsSame(best!.face))) out.push(best.face);
  }
  return out;
}

// ============================================================
// 求值
// ============================================================
function applyBoolean(op: BooleanOp, base: any, tool: any): any {
  if (!base) return tool;
  switch (op) {
    case 'add':
      return S.fuse(base, tool);
    case 'cut':
      return S.cut(base, tool);
    case 'intersect':
      return S.common(base, tool);
    case 'new':
      // 「新建实体」（UI 标签即此）＝保留已有实体、把新实体作为**独立实体**追加，不做布尔融合。
      // 与 SolidWorks 一致：多实体零件里「新建」产生新实体而非并入。旧实现误走 `fuse`，
      // 导致两个**相交**的「新建」实体会被静默合并成一个（体积也不是相加），与标签语义不符。
      // 用 `bodiesOf` 先展开再复合，避免复合体套复合体。
      return S.compoundOf([...S.bodiesOf(base), tool]);
    default:
      return S.fuse(base, tool);
  }
}

/** 取某个草图特征的所有面（多区域 → 多个面） */
function facesOfSketch(skf: SketchFeature): any[] {
  const pl = planeOf(skf);
  solveSketch(skf.params.sketch);
  const regions = sketchToRegions(skf.params.sketch, pl);
  return regions.map(regionToFace);
}

function extrudeFaces(faces: any[], dir: [number, number, number], distance: number, symmetric: boolean): any {
  const parts = faces.map((f) => S.extrude(f, dir, distance, symmetric));
  return parts.length === 1 ? parts[0] : S.fuseAll(parts);
}

/**
 * 沿路径扫掠一个 2D 截面。
 *
 * 实现要点（这是对旧实现的修复）：
 *  - 路径允许是**开放**折线（线/弧串），旧实现只认 `sketchToRegions` 的闭环，开放路径直接报错；
 *  - 用「平行移动标架」逐站放置截面，再交给 `loftSections` 蒙皮；
 *  - 不用 `BRepOffsetAPI_MakePipe`——实测它在弯曲路径上会算出退化结果。
 */
function sweepProfileAlongPath(pathPts: Vec3[], profile2d: Vec2[], upNormal?: Vec3): any {
  const pts = cleanLoop(pathPts, 1e-6);
  if (pts.length < 2) throw new Error('扫描：路径过短');
  const profile = cleanLoop2(profile2d);
  if (profile.length < 3) throw new Error('扫描：轮廓草图退化');
  // 站点切向取中心差分：在折点处即「角平分线」，截面落在斜接面（miter）上，
  // 与 SolidWorks 的折线扫掠一致。
  // ⚠️ 已知限制：放样曲面是逐段直纹面，尖锐折角处仍会切掉一小角
  //    （L 形路径约 -2.9%，线+弧约 -8.4%）；纯圆弧 / 直线 / 闭环路径误差 ≤ 3%。
  //    曾尝试「折点放两个共位截面（入射/出射切向）」补斜接面，实测会生成自相交
  //    几何（体积反而放大到 3.5 倍），故不采用。
  const tangents = polylineTangents(pts);
  const frames = transportFrames(tangents, upNormal);
  const sections = placeSections(profile, pts, frames).map((s) => cleanLoop(s));
  return S.loftSections(sections, true, false);
}

// ============================================================
// 弹簧 / 螺旋：周期性快路径
// ============================================================

/**
 * 螺旋对称的 3×4 仿射矩阵：绕 (origin, axis) 旋转 angleRad，同时沿 axis 平移 dist。
 *
 * ⚠️ 不能图省事用 `gp_Trsf.SetRotation_1(ax1, ang)` + `SetTranslationPart`：
 * 前者会把平移分量设成 `origin − R·origin`，后者再把它**整个覆盖**掉，
 * 只有 origin 恰在原点时才碰巧正确。这里显式算 `origin − R·origin + dist·u`。
 */
function screwMatrix(origin: Vec3, axis: Vec3, angleRad: number, dist: number): number[] {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const u: Vec3 = [axis[0] / n, axis[1] / n, axis[2] / n];
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const k = 1 - c;
  const [x, y, z] = u;
  // Rodrigues 旋转矩阵（行主序）
  const m = [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
  const rx = m[0] * origin[0] + m[1] * origin[1] + m[2] * origin[2];
  const ry = m[3] * origin[0] + m[4] * origin[1] + m[5] * origin[2];
  const rz = m[6] * origin[0] + m[7] * origin[1] + m[8] * origin[2];
  return [
    m[0], m[1], m[2], origin[0] - rx + u[0] * dist,
    m[3], m[4], m[5], origin[1] - ry + u[1] * dist,
    m[6], m[7], m[8], origin[2] - rz + u[2] * dist,
  ];
}

interface SpringSpec {
  origin: Vec3;
  axis: Vec3;
  radius: number;
  wireR: number;
  pitch: number;
  turns: number;
  handedness: 'right' | 'left';
  taperDeg: number;
  segsPerTurn: number;
}

/**
 * 弹簧（圆截面沿螺旋线成体）。
 *
 * ⚠️ 性能：`BRepOffsetAPI_ThruSections` 的代价随截面数**近似平方增长**
 * （实测 2/4/5/6/8 圈 → 2.1 / 7.5 / 15.1 / 27.2 / 50 s）。8 圈默认参数要 50 s，
 * 12 圈超过 2 分钟；调 `SetMaxDegree` / 精度、分块放样再融合都无效（实测更慢）。
 *
 * 但螺旋线是**周期性**的：第 k 圈恰好是第 0 圈绕轴旋转 2πk、并沿轴平移 k·螺距。
 * 于是只放样**一圈**（25 个截面 ≈ 0.6 s），再刚体复制出其余各圈。
 * 相邻圈在公共截面处严格重合、内部互不干涉，所以直接合成**复合体**即可——
 * 实测体积精确到 0.006%，三角化 / 布尔（作为工具与作为基体，双向）/ 特征链续算全部正常。
 * 整体 ≈ 0.7 s，比整条放样快约 100×。
 *
 * 下列情形不满足"各圈互不干涉"，退回整条放样（慢，但几何语义不变）：
 *  - 有锥度：各圈半径不同，不再周期；
 *  - 螺距 ≤ 线径：相邻圈互相穿插；
 *  - 中径 ≤ 线径：线圈穿过轴线，单圈即自相交。
 */
function springSolid(spec: SpringSpec): any {
  const { origin, axis, radius, wireR, pitch, turns, handedness, taperDeg, segsPerTurn } = spec;
  // 沿路径用平行移动标架搬一个截面 X 方向，作为圆截面的**缝合点方向**。
  // 缝对齐后 ThruSections 才会把侧面做成整片（3 面），否则会被切成十几片。
  const chain = (t: number, segs: number) => {
    const pts = helixPoints({ origin, axis, radius, pitch, turns: t, handedness, taperDeg, segsPerTurn: segs });
    const frames = transportFrames(polylineTangents(pts));
    return S.loftCircleChain(
      pts,
      wireR,
      undefined,
      frames.map((fr) => fr.u)
    );
  };

  const full = Math.floor(turns + 1e-9);
  const frac = turns - full;
  const periodic =
    Math.abs(taperDeg) < 1e-9 &&
    full >= 1 &&
    pitch > 2 * wireR * 1.0001 &&
    radius > wireR * 1.0001;

  if (!periodic) {
    // 慢路径：整条放样。按总截面数上限收缩每圈段数，避免长弹簧直接卡死。
    const segs = Math.max(8, Math.min(segsPerTurn, Math.floor(150 / Math.max(turns, 1))));
    return chain(turns, segs);
  }

  const one = chain(1, segsPerTurn);
  const parts: any[] = [];
  for (let k = 0; k < full; k++) {
    parts.push(k === 0 ? one : S.transform(one, screwMatrix(origin, axis, k * 2 * Math.PI, k * pitch)));
  }
  if (frac > 1e-6) {
    const tail = chain(frac, segsPerTurn);
    parts.push(S.transform(tail, screwMatrix(origin, axis, full * 2 * Math.PI, full * pitch)));
  }
  return S.compoundOf(parts);
}

export function evaluateFeature(f: Feature, current: any, ctx: EvalCtx): EvalOut {
  switch (f.type) {
    case 'sketch':
      return { shape: current };

    case 'primitive': {
      const { kind, dims, origin } = f.params;
      let shape: any;
      if (kind === 'box') shape = S.primitives.box(dims[0], dims[1], dims[2]);
      else if (kind === 'cylinder') shape = S.primitives.cylinder(dims[0], dims[1]);
      else if (kind === 'sphere') shape = S.primitives.sphere(dims[0]);
      else if (kind === 'cone') shape = S.primitives.cone(dims[0], dims[1], dims[2]);
      else shape = S.primitives.torus(dims[0], dims[1]);
      if (origin && (origin[0] || origin[1] || origin[2])) {
        shape = S.translate(shape, origin[0], origin[1], origin[2]);
      }
      const op = f.params.operation ?? 'new';
      return { shape: applyBoolean(op, current, shape), added: shape, tool: op === 'cut' ? shape : undefined };
    }

    case 'extrude': {
      const skf = ctx.doc.getFeature(f.params.sketchId);
      if (!skf || skf.type !== 'sketch') throw new Error('拉伸：找不到引用的草图');
      const pl = planeOf(skf);
      const faces = facesOfSketch(skf);
      if (!faces.length) throw new Error('拉伸：草图没有封闭轮廓');
      const sign = f.params.reverse ? -1 : 1;
      const dir: [number, number, number] = [
        pl.normal[0] * sign,
        pl.normal[1] * sign,
        pl.normal[2] * sign,
      ];
      const solid = extrudeFaces(faces, dir, f.params.distance, !!f.params.symmetric);
      const op = f.params.operation;
      return {
        shape: applyBoolean(op, current, solid),
        added: op === 'add' || op === 'new' ? solid : undefined,
        tool: op === 'cut' ? solid : undefined,
      };
    }

    case 'revolve': {
      const skf = ctx.doc.getFeature(f.params.sketchId);
      if (!skf || skf.type !== 'sketch') throw new Error('旋转：找不到引用的草图');
      const pl = planeOf(skf);
      const faces = facesOfSketch(skf);
      if (!faces.length) throw new Error('旋转：草图没有封闭轮廓');
      const a = skf.params.sketch;
      const axisA = f.params.axisA;
      const axisB = f.params.axisB;
      const origin = worldFromSketch(pl, axisA[0], axisA[1]);
      const p2 = worldFromSketch(pl, axisB[0], axisB[1]);
      const axis: [number, number, number] = [p2[0] - origin[0], p2[1] - origin[1], p2[2] - origin[2]];
      void a;
      const ang = (f.params.angleDeg * Math.PI) / 180;
      const parts = faces.map((face) => S.revolve(face, origin, axis, ang));
      const solid = parts.length === 1 ? parts[0] : S.fuseAll(parts);
      const op = f.params.operation;
      return {
        shape: applyBoolean(op, current, solid),
        added: op === 'add' || op === 'new' ? solid : undefined,
        tool: op === 'cut' ? solid : undefined,
      };
    }

    case 'loft': {
      const wires: any[] = [];
      for (const sid of f.params.sketchIds) {
        const skf = ctx.doc.getFeature(sid);
        if (!skf || skf.type !== 'sketch') continue;
        const pl = planeOf(skf);
        solveSketch(skf.params.sketch);
        const regions = sketchToRegions(skf.params.sketch, pl);
        if (regions.length) wires.push(regions[0].outer);
      }
      if (wires.length < 2) throw new Error('放样：至少需要两个截面草图');
      const solid = S.loftRobust(wires, true, !!f.params.ruled);
      const op = f.params.operation;
      return { shape: applyBoolean(op, current, solid), added: solid, tool: op === 'cut' ? solid : undefined };
    }

    case 'sweep': {
      const prof = ctx.doc.getFeature(f.params.profileSketchId);
      const path = ctx.doc.getFeature(f.params.pathSketchId);
      if (!prof || prof.type !== 'sketch' || !path || path.type !== 'sketch') {
        throw new Error('扫描：缺少轮廓或路径草图');
      }
      const plP = planeOf(prof);
      solveSketch(prof.params.sketch);
      const pRegions = sketchToRegions(prof.params.sketch, plP);
      if (!pRegions.length) throw new Error('扫描：轮廓草图没有封闭区域');
      const plPath = planeOf(path);
      solveSketch(path.params.sketch);
      // 路径支持开放折线（线/弧串）与闭环
      const pathPts = sampleSketchPath(path.params.sketch, plPath, 48);
      if (pathPts.length < 2) throw new Error('扫描：路径草图没有可用曲线');
      const solid = sweepProfileAlongPath(pathPts, pRegions[0].polygon, plP.normal);
      const op = f.params.operation;
      return { shape: applyBoolean(op, current, solid), added: solid, tool: op === 'cut' ? solid : undefined };
    }

    case 'spring': {
      const p = f.params;
      const solid = springSolid({
        origin: p.origin,
        axis: p.axis,
        radius: Math.max(p.meanDiameter, 0.02) / 2,
        wireR: Math.max(p.wireDiameter, 0.01) / 2,
        pitch: p.pitch,
        turns: Math.max(p.turns, 0.05),
        handedness: p.handedness,
        taperDeg: p.taperDeg ?? 0,
        segsPerTurn: p.segmentsPerTurn ?? 24,
      });
      const op = p.operation;
      return { shape: applyBoolean(op, current, solid), added: solid, tool: op === 'cut' ? solid : undefined };
    }

    case 'spiral': {
      const p = f.params;
      const pl = p.plane;
      const ribbon = spiralRibbon2D({
        startRadius: Math.max(p.startRadius, 0.02),
        pitch: p.pitch,
        turns: Math.max(p.turns, 0.05),
        thickness: Math.max(p.thickness, 0.01),
        handedness: p.handedness,
        segsPerTurn: 36,
      });
      if (ribbon.length < 3) throw new Error('涡状线：参数退化');
      const world = ribbon.map(([x, y]) => worldFromSketch(pl, x, y));
      const face = S.faceFromPoints(world);
      const solid = S.extrude(face, pl.normal, Math.max(p.width, 0.01), !!p.symmetric);
      const op = p.operation;
      return { shape: applyBoolean(op, current, solid), added: solid, tool: op === 'cut' ? solid : undefined };
    }

    case 'fillet': {
      if (!current) throw new Error('圆角：没有可操作的实体');
      const edges = resolveEdges(current, f.params.edges);
      if (!edges.length) throw new Error('圆角：找不到对应的边');
      return { shape: S.fillet(current, edges, f.params.radius, f.params.radius2) };
    }

    case 'scale': {
      if (!current) throw new Error('缩放：没有可操作的实体');
      const p = f.params;
      const factors: [number, number, number] = p.nonUniform
        ? [p.factors?.[0] ?? 1, p.factors?.[1] ?? 1, p.factors?.[2] ?? 1]
        : [p.factor, p.factor, p.factor];
      if (factors.some((k) => !Number.isFinite(k) || Math.abs(k) < 1e-9)) {
        throw new Error('缩放：系数不能为 0');
      }
      return { shape: S.scale(current, p.center, factors) };
    }

    case 'split': {
      if (!current) throw new Error('分割：没有可操作的实体');
      const pl = f.params.plane;
      return { shape: S.splitByPlane(current, pl, f.params.keep) };
    }

    case 'moveBody': {
      if (!current) throw new Error('移动/复制实体：没有可操作的实体');
      const { delta, axisOrigin, axisDir, angleDeg, copy: doCopy, count, indices } = f.params;
      const all = S.bodiesOf(current);
      if (!all.length) throw new Error('移动/复制实体：当前没有实体');
      const sel = indices && indices.length ? new Set(indices) : null;
      if (sel) {
        for (const i of sel) {
          if (!Number.isInteger(i) || i < 0 || i >= all.length) {
            throw new Error(`移动/复制实体：实体下标 ${i} 越界（当前 ${all.length} 个实体）`);
          }
        }
      }
      const targets = all.filter((_, i) => !sel || sel.has(i));
      const others = all.filter((_, i) => sel && !sel.has(i));
      const ang = ((angleDeg ?? 0) * Math.PI) / 180;
      const out: any[] = [...others];
      if (doCopy) {
        const n = Math.max(1, Math.round(count ?? 1));
        out.push(...targets); // 原件留在原位
        for (let i = 1; i <= n; i++) {
          for (const b of targets) {
            out.push(
              S.moveBody(b, axisOrigin, axisDir, ang * i, [delta[0] * i, delta[1] * i, delta[2] * i])
            );
          }
        }
      } else {
        for (const b of targets) out.push(S.moveBody(b, axisOrigin, axisDir, ang, delta));
      }
      return { shape: out.length === 1 ? out[0] : S.compoundOf(out) };
    }

    case 'deleteBody': {
      if (!current) throw new Error('删除实体：没有可操作的实体');
      const bodies = S.bodiesOf(current);
      const del = new Set(f.params.indices ?? []);
      if (!del.size) throw new Error('删除实体：没有选择要删除的实体');
      for (const i of del) {
        if (!Number.isInteger(i) || i < 0 || i >= bodies.length) {
          throw new Error(`删除实体：实体下标 ${i} 越界（当前 ${bodies.length} 个实体）`);
        }
      }
      const kept = bodies.filter((_, i) => !del.has(i));
      if (!kept.length) throw new Error('删除实体：不能删除全部实体');
      return { shape: kept.length === 1 ? kept[0] : S.compoundOf(kept) };
    }

    case 'combine': {
      if (!current) throw new Error('组合：没有可操作的实体');
      const bodies = S.bodiesOf(current);
      const { mainIndex, toolIndices, operation } = f.params;
      if (!Number.isInteger(mainIndex) || mainIndex < 0 || mainIndex >= bodies.length) {
        throw new Error(`组合：主体下标 ${mainIndex} 越界（当前 ${bodies.length} 个实体）`);
      }
      const tools = (toolIndices ?? []).filter((i) => i !== mainIndex);
      if (!tools.length) throw new Error('组合：没有选择工具体');
      for (const i of tools) {
        if (!Number.isInteger(i) || i < 0 || i >= bodies.length) {
          throw new Error(`组合：工具体下标 ${i} 越界（当前 ${bodies.length} 个实体）`);
        }
      }
      const merged = S.combineBodies(bodies[mainIndex], tools.map((i) => bodies[i]), operation);
      // 未被选中的实体原样保留；merged 可能仍是多实体（如「添加」两个不相交实体）
      const used = new Set([mainIndex, ...tools]);
      const out = [...S.bodiesOf(merged), ...bodies.filter((_, i) => !used.has(i))];
      return { shape: out.length === 1 ? out[0] : S.compoundOf(out) };
    }

    case 'chamfer': {
      if (!current) throw new Error('倒角：没有可操作的实体');
      const edges = resolveEdges(current, f.params.edges);
      if (!edges.length) throw new Error('倒角：找不到对应的边');
      return { shape: S.chamfer(current, edges, f.params.distance) };
    }

    case 'shell': {
      if (!current) throw new Error('抽壳：没有可操作的实体');
      const faces = resolveFaces(current, f.params.faces);
      if (!faces.length) throw new Error('抽壳：找不到要移除的面');
      return { shape: S.shell(current, faces, f.params.thickness) };
    }

    case 'linearPattern': {
      if (!current) throw new Error('阵列：没有可操作的实体');
      const seed = f.params.seedFeatureId ? ctx.doc.getFeature(f.params.seedFeatureId) : null;
      const seedOut = seed ? ctx.doc.evalCache.get(seed.id) : undefined;
      const { direction, spacing, count } = f.params;
      if (count < 2) return { shape: current };
      const base = seedOut?.tool ?? seedOut?.added ?? null;
      if (base) {
        const instances = S.linearPatternInstances(base, direction, spacing, count);
        const merged = S.fuseAll(instances);
        const isCut = !!seedOut?.tool;
        return { shape: isCut ? S.cut(current, merged) : S.fuse(current, merged), tool: isCut ? merged : undefined };
      }
      const copies = S.linearPatternInstances(current, direction, spacing, count);
      return { shape: S.fuseAll(copies) };
    }

    case 'circularPattern': {
      if (!current) throw new Error('阵列：没有可操作的实体');
      const seed = f.params.seedFeatureId ? ctx.doc.getFeature(f.params.seedFeatureId) : null;
      const seedOut = seed ? ctx.doc.evalCache.get(seed.id) : undefined;
      const { axisOrigin, axisDir, count, totalAngleDeg, equalSpacing } = f.params;
      if (count < 2) return { shape: current };
      const total = (totalAngleDeg * Math.PI) / 180;
      const step = equalSpacing && total >= Math.PI * 2 - 1e-6 ? total / count : total / Math.max(count - 1, 1);
      const base = seedOut?.tool ?? seedOut?.added ?? null;
      const mk = (shape: any) =>
        Array.from({ length: count }, (_, i) => S.rotateAxis(shape, axisOrigin, axisDir, step * i));
      if (base) {
        const merged = S.fuseAll(mk(base));
        const isCut = !!seedOut?.tool;
        return { shape: isCut ? S.cut(current, merged) : S.fuse(current, merged), tool: isCut ? merged : undefined };
      }
      return { shape: S.fuseAll(mk(current)) };
    }

    case 'mirror': {
      if (!current) throw new Error('镜像：没有可操作的实体');
      const seed = f.params.seedFeatureId ? ctx.doc.getFeature(f.params.seedFeatureId) : null;
      const seedOut = seed ? ctx.doc.evalCache.get(seed.id) : undefined;
      const { planePoint, planeNormal } = f.params;
      const base = seedOut?.tool ?? seedOut?.added ?? null;
      if (base) {
        const m = S.mirrorPlane(base, planePoint, planeNormal);
        const isCut = !!seedOut?.tool;
        return { shape: isCut ? S.cut(current, m) : S.fuse(current, m), tool: isCut ? m : undefined };
      }
      const m = S.mirrorPlane(current, planePoint, planeNormal);
      return { shape: S.fuse(current, m) };
    }

    case 'referencePlane':
      // 基准面纯数据：创建时已算好平面，求值时透传当前实体（供其上的草图复用）
      return { shape: current };

    case 'hole': {
      if (!current) throw new Error('孔：没有可操作的实体');
      const tool = S.holeTool(f.params);
      return { shape: S.cut(current, tool), tool };
    }

    case 'draft': {
      if (!current) throw new Error('拔模：没有可操作的实体');
      const faces = resolveFaces(current, f.params.draftFaces);
      if (!faces.length) throw new Error('拔模：找不到要拔模的面');
      const nf = f.params.neutralFace;
      const shape = S.draft(
        current,
        faces,
        nf.point,
        nf.normal ?? [0, 0, 1],
        f.params.angleDeg,
        !!(f.params as any).reverse
      );
      return { shape };
    }

    case 'rib': {
      if (!current) throw new Error('筋：没有可操作的实体');
      const skf = ctx.doc.getFeature(f.params.sketchId);
      if (!skf || skf.type !== 'sketch') throw new Error('筋：找不到引用的草图');
      const pl = planeOf(skf);
      solveSketch(skf.params.sketch);
      const prof = buildRibProfile(skf.params.sketch, f.params.thickness);
      if (!prof) throw new Error('筋：草图需为一条连续的开口轮廓');
      const world = prof.map((p) => worldFromSketch(pl, p[0], p[1]));
      const face = S.faceFromPoints(world);
      const depth = Math.max(f.params.depth ?? 10, 0.01);
      const solid = S.extrude(face, pl.normal, depth, !!f.params.symmetric);
      return { shape: S.fuse(current, solid), added: solid };
    }

    default:
      throw new Error(`未知特征类型：${(f as Feature).type}`);
  }
}

interface EvalCtx {
  doc: CadDocument;
  byId: Map<FeatureId, Feature>;
}

export interface RebuildOutcome {
  shape: any;
  errors: { id: string; message: string }[];
  ms: number;
}

/**
 * 重放整棵特征树，返回最终 TopoDS（仅在 Worker 内有效）与出错特征列表。
 */
export function rebuildFeatures(features: Feature[], upto?: FeatureId): RebuildOutcome {
  const t0 = performance.now();
  const doc = new CadDocument();
  doc.features = features as Feature[];
  const ctx: EvalCtx = { doc, byId: new Map(features.map((f) => [f.id, f])) };
  let current: any = null;
  const errors: { id: string; message: string }[] = [];
  const stopAt = upto === undefined ? features.length : doc.indexOf(upto) + 1;

  for (let i = 0; i < stopAt; i++) {
    const f = features[i];
    if ((f as any).suppressed) {
      doc.evalCache.set(f.id, { shape: current });
      continue;
    }
    try {
      const out = evaluateFeature(f, current, ctx);
      doc.evalCache.set(f.id, out);
      current = out.shape;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ id: f.id, message: msg });
      doc.evalCache.set(f.id, { shape: current });
    }
  }
  return { shape: current, errors, ms: performance.now() - t0 };
}

export type { PlaneRef };

// ============================================================
// TopoDS → 可序列化 MeshResult
// ============================================================
const TESS_LINEAR = 0.12;
const TESS_ANGULAR = 0.28;

/**
 * 把 TopoDS 实体转成主线程可消费的 MeshResult。
 * faceMetas / edgeMetas 与 faceRanges / edgePolylines 严格按下标对齐，
 * 主线程据此做拾取与高亮（不需要任何 OCCT 句柄）。
 */
export function buildMeshResult(shape: any, linear = TESS_LINEAR, angular = TESS_ANGULAR): MeshResult {
  const md = tessellate(shape, { linearDeflection: linear, angularDeflection: angular });

  // 面元数据：顺序与 tessellate 的 faceRanges 一致（同一 Explorer 顺序；实体面必被三角化）
  const fis = faceInfos(shape);
  const faceMetas: FaceMeta[] = fis.slice(0, md.faceRanges.length).map((f, i) => ({
    id: i,
    area: f.area,
    centroid: f.centroid,
    normal: f.normal,
    surfaceType: f.surfaceType,
    axis: f.axis,
    radius: f.radius,
  }));
  // 若 faceInfos 比 faceRanges 少（理论不会发生），补零保证对齐
  while (faceMetas.length < md.faceRanges.length) {
    const i = faceMetas.length;
    faceMetas.push({ id: i, area: 0, centroid: [0, 0, 0], normal: [0, 0, 1], surfaceType: 'other' });
  }

  // 特征边：离散成折线，并附元数据（中点/方向/长度）
  const eis = featureEdgeInfos(shape, 25);
  const edgePolylines: number[][] = [];
  const edgeMetas: EdgeMeta[] = [];
  for (const ei of eis) {
    const poly = discretizeEdge(ei.edge, 32);
    const flat: number[] = [];
    for (const p of poly.points) flat.push(p[0], p[1], p[2]);
    if (flat.length >= 6) {
      edgePolylines.push(flat);
      edgeMetas.push({
        id: edgeMetas.length,
        length: ei.length,
        mid: ei.mid,
        dir: ei.dir,
        curveType: ei.curveType,
        axis: ei.axis,
        radius: ei.radius,
        endpoints: ei.endpoints,
      });
    }
  }

  return {
    positions: md.positions.buffer as ArrayBuffer,
    normals: md.normals.buffer as ArrayBuffer,
    indices: md.indices.buffer as ArrayBuffer,
    faceRanges: md.faceRanges,
    edgePolylines,
    faceMetas,
    edgeMetas,
  };
}
