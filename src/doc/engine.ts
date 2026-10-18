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
import { translateOcctError } from '../core/solid';
import { tessellate, discretizeEdge } from '../core/mesh';
import { sketchToRegions, regionToFace } from '../sketch/toShape';
import { buildRibProfile } from '../sketch/rib';
import { solveSketch } from '../sketch/solver';
import {
  cleanLoop,
  cleanLoop2,
  cross3,
  helixPoints,
  len3,
  norm3,
  placeSections,
  polylineTangents,
  sampleSketchPath,
  spiralRibbon2D,
  transportFrames,
  type Vec2,
  type Vec3,
} from '../sketch/curve';
import { edgeInfos, faceInfos, featureEdgeInfos, type EdgeInfo, type FaceInfo } from './topo';
import { CadDocument, planeFromFace, planeOf, worldFromSketch, type EvalOut } from './model';
import type { MeshResult, FaceMeta, EdgeMeta } from '../core/kernel-types';
import type {
  BooleanOp,
  EdgeRef,
  ExtrudeFeature,
  FaceRef,
  Feature,
  FeatureId,
  MirrorFeature,
  PlaneRef,
  SheetBaseFlangeFeature,
  SheetEdgeFlangeFeature,
  SketchFeature,
  ThinSpec,
} from './types';
import type { SketchPlane } from '../sketch/types';
import { worldToPlane } from '../sketch/types';

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

/** 形状包围盒的 8 个角点 */
function bboxCorners(shape: any): Vec3[] {
  const bb = S.shapeBBox(shape);
  const out: Vec3[] = [];
  for (const x of [bb.min[0], bb.max[0]]) {
    for (const y of [bb.min[1], bb.max[1]]) {
      for (const z of [bb.min[2], bb.max[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * 按 SW 终止条件算「沿 dir 的有效拉伸距离」（恒为正，mm）。
 *
 *  - `blind`      给定深度（默认）
 *  - `midPlane`   两侧对称（总深度 = distance）
 *  - `throughAll` 完全贯穿：按当前模型的包围盒在 dir 上的投影跨度自动定长（两侧对称，保证穿透）
 *  - `upToVertex` 成形到顶点：顶点到草图平面沿 dir 的有符号距离
 *  - `upToSurface` 成形到面：目标平面与「过草图平面沿 dir 的射线」的交点距离（解析求解）
 *
 * 返回 `symmetric=true` 时调用方应把轮廓向两侧各拉 distance/2。
 */
function extrudeEndDistance(
  p: ExtrudeFeature['params'],
  baseOrigin: Vec3,
  dir: Vec3,
  current: any
): { distance: number; symmetric: boolean } {
  const end = p.endCondition ?? 'blind';
  if (end === 'midPlane') return { distance: Math.abs(p.distance), symmetric: true };

  if (end === 'throughAll') {
    const fallback = Math.max(Math.abs(p.distance) || 0, 100);
    if (!current) return { distance: fallback, symmetric: true };
    let maxAbs = 0;
    for (const c of bboxCorners(current)) maxAbs = Math.max(maxAbs, Math.abs(dot3(sub3(c, baseOrigin), dir)));
    return { distance: maxAbs > 1e-6 ? maxAbs * 2 + 20 : fallback, symmetric: true };
  }

  if (end === 'upToVertex') {
    if (!p.vertex) throw new Error('成形到顶点：未指定目标顶点');
    const d = dot3(sub3(p.vertex, baseOrigin), dir);
    if (d <= 1e-6) throw new Error('成形到顶点：目标顶点不在拉伸方向上（试试「反向」）');
    return { distance: d, symmetric: false };
  }

  if (end === 'upToSurface') {
    if (!p.targetFace) throw new Error('成形到面：未指定目标面');
    if (!p.targetFace.normal) throw new Error('成形到面：目标面缺少法向信息');
    const pl = planeFromFace(p.targetFace.point, p.targetFace.normal);
    const denom = dot3(pl.normal as Vec3, dir);
    if (Math.abs(denom) < 1e-6) throw new Error('成形到面：目标面与拉伸方向平行，无法成形');
    const d = dot3(sub3(pl.origin as Vec3, baseOrigin), pl.normal as Vec3) / denom;
    if (d <= 1e-6) throw new Error('成形到面：目标面不在拉伸方向上（试试「反向」）');
    return { distance: d, symmetric: false };
  }

  // blind（默认）
  return { distance: Math.abs(p.distance), symmetric: !!p.symmetric };
}

/**
 * 平面内「斜接（miter）偏置」：每个顶点沿角平分线偏移 t，并乘 1/cos θ 补偿折角。
 * 光滑点自动退化为普通法向偏移。N = cross(tangent, planeNormal)：
 * 当轮廓在平面上绕 nrm **逆时针**时，t>0 朝外（右侧即外侧）。
 * 折角补偿系数封顶 4×（1/0.25），避免过尖的折角炸出尖刺。
 */
function offsetPathMiter(pts: Vec3[], nrm: Vec3, t: number, closed: boolean): Vec3[] {
  const n = pts.length;
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const d1raw = sub3(pts[i], prev);
    const d2raw = sub3(next, pts[i]);
    const d1 = len3(d1raw) > 1e-9 ? norm3(d1raw) : null;
    const d2 = len3(d2raw) > 1e-9 ? norm3(d2raw) : null;
    const ref = d1 ?? d2;
    if (!ref) {
      out.push([pts[i][0], pts[i][1], pts[i][2]]);
      continue;
    }
    const N1 = norm3(cross3(d1 ?? ref, nrm));
    const N2 = norm3(cross3(d2 ?? ref, nrm));
    const sum: Vec3 = [N1[0] + N2[0], N1[1] + N2[1], N1[2] + N2[2]];
    let N: Vec3;
    let scale = 1;
    if (len3(sum) < 1e-6) {
      N = N1;
    } else {
      N = norm3(sum);
      scale = 1 / Math.max(0.25, dot3(N, N1));
    }
    out.push([
      pts[i][0] + N[0] * t * scale,
      pts[i][1] + N[1] * t * scale,
      pts[i][2] + N[2] * t * scale,
    ]);
  }
  return out;
}

/** 多边形绕 nrm 的有符号面积（>0 = 逆时针） */
function signedArea(pts: Vec3[], nrm: Vec3): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = cross3(pts[i], pts[(i + 1) % pts.length]);
    s += dot3(c, nrm);
  }
  return s / 2;
}

/** 薄壁厚度映射：`tOut` = 轮廓外侧（逆时针时朝外）厚度，`tIn` = 内侧厚度 */
function thinOffsets(thin: ThinSpec): { tOut: number; tIn: number } {
  const t = Math.abs(thin.thickness) || 0;
  const t2 = Math.abs(thin.thickness2 ?? thin.thickness) || 0;
  let tOut: number;
  let tIn: number;
  if (thin.type === 'midPlane') {
    tOut = t / 2;
    tIn = t / 2;
  } else if (thin.type === 'twoSides') {
    tOut = t;
    tIn = t2;
  } else {
    // oneSide
    tOut = thin.reverse ? 0 : t;
    tIn = thin.reverse ? t : 0;
  }
  if (tOut <= 1e-9 && tIn <= 1e-9) throw new Error('薄壁：厚度必须大于 0');
  return { tOut, tIn };
}

/**
 * 薄壁特征：把草图轮廓偏置成带状（**世界坐标环**，供拉伸/旋转/扫描共用）。
 *
 *  - **闭环轮廓**（有封闭区域）→ `{ outer, inner }` 两条环（内环未反向，调用方按需处理）；
 *  - **开环轮廓**（无封闭区域）→ 双侧偏置首尾相接拼成**一条**闭合带，`inner` 为 null。
 *
 * 与 SW 一致：开环/闭环、单侧/两侧/对称三种模式共用同一套偏置逻辑。
 */
function thinLoops3D(
  skf: SketchFeature,
  pl: SketchPlane,
  thin: ThinSpec
): { outer: Vec3[]; inner: Vec3[] | null }[] {
  const { tOut, tIn } = thinOffsets(thin);
  solveSketch(skf.params.sketch);
  const nrm = pl.normal as Vec3;
  const regions = sketchToRegions(skf.params.sketch, pl);
  const loops: { outer: Vec3[]; inner: Vec3[] | null }[] = [];
  if (regions.length) {
    for (const r of regions) {
      // ⚠️ 区域多边形在实体接缝处会有重复点（相邻实体共享端点），
      //    必须先 cleanLoop 去重，否则 miter 折角会因「零长边」退化成切角。
      const poly = cleanLoop(r.polygon.map(([x, y]) => worldFromSketch(pl, x, y) as Vec3));
      if (poly.length < 3) continue;
      // 统一成逆时针，保证 tOut 朝外
      const ccw = signedArea(poly, nrm) < 0 ? [...poly].reverse() : poly;
      // 闭环轮廓恒有内环（tIn=0 时内环即原轮廓，仍需挖孔）
      loops.push({
        outer: offsetPathMiter(ccw, nrm, tOut, true),
        inner: offsetPathMiter(ccw, nrm, -tIn, true),
      });
    }
  } else {
    const pts = cleanLoop(sampleSketchPath(skf.params.sketch, pl, 64));
    if (pts.length < 2) throw new Error('薄壁：草图没有可用轮廓');
    loops.push({
      outer: [
        ...offsetPathMiter(pts, nrm, tOut, false),
        ...offsetPathMiter(pts, nrm, -tIn, false).reverse(),
      ],
      inner: null,
    });
  }
  return loops;
}

/**
 * 薄壁特征：把草图轮廓偏置成带状**面**（供拉伸/旋转使用）。
 * 闭环 → 外环 + 反向内环 `faceWithHoles` 挖孔成环带；开环 → 单条闭合带面。
 */
function thinProfileFaces(skf: SketchFeature, pl: SketchPlane, thin: ThinSpec): any[] {
  return thinLoops3D(skf, pl, thin).map((l) => {
    const outer = S.wireFromPoints(l.outer, true);
    if (!l.inner) return S.faceFromWire(outer);
    return S.faceWithHoles(outer, [S.wireFromPoints([...l.inner].reverse(), true)]);
  });
}

/**
 * 沿路径扫掠一个 2D 截面。
 *
 * 实现要点（这是对旧实现的修复）：
 *  - 路径允许是**开放**折线（线/弧串），旧实现只认 `sketchToRegions` 的闭环，开放路径直接报错；
 *  - 用「平行移动标架」逐站放置截面，再交给 `loftSections` 蒙皮；
 *  - 不用 `BRepOffsetAPI_MakePipe`——实测它在弯曲路径上会算出退化结果。
 */
function sweepProfileAlongPath(pathPts: Vec3[], profile2d: Vec2[], upNormal?: Vec3, isSolid = true): any {
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
  return S.loftSections(sections, isSolid, false);
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

/**
 * 取一个草图特征的轮廓 wire（供曲面特征扫掠）。
 * 闭合草图 → 取首个区域的**外环** wire；开放草图（线/弧串）→ 采样成开放折线 wire。
 */
function profileWireOf(skf: SketchFeature): any {
  const pl = planeOf(skf);
  solveSketch(skf.params.sketch);
  const regions = sketchToRegions(skf.params.sketch, pl);
  if (regions.length && regions[0].outer) return regions[0].outer;
  const pts = sampleSketchPath(skf.params.sketch, pl, 64);
  if (pts.length >= 2) return S.wireFromPoints(pts, false);
  throw new Error('曲面：草图没有可用轮廓');
}


/**
 * 特征求值处理器注册表。
 *
 * 把原先 530 行 `switch (f.type)` 求值分派改为「类型 → 处理器」映射：
 * - 用 mapped type（`FeatureHandlers`）让每个 handler 的 `f` 在编译期严格收窄到对应特征变体，
 *   与 switch 的 case 收窄等价；新增特征类型时只需在 `FEATURE_HANDLERS` 里加一项，
 *   缺漏会被编译期强制报错，无需再维护 switch 的 default 分支。
 * - dispatch 处只做一次局部 cast（见 `FEATURE_REGISTRY` 构造），运行期行为与 switch 完全一致，
 *   递归调用点（`rebuildFeatures` 内 `evaluateFeature(...)`）签名不变。
 */

type FeatureHandlerFn = (f: Feature, current: any, ctx: EvalCtx) => EvalOut;

type FeatureHandlers = {
  [K in Feature['type']]: (f: Extract<Feature, { type: K }>, current: any, ctx: EvalCtx) => EvalOut;
};

const FEATURE_HANDLERS: FeatureHandlers = {
  sketch: (f, current) => ({ shape: current }),

  primitive: (f, current) => {
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
  },

  extrude: (f, current, ctx) => {
    const skf = ctx.doc.getFeature(f.params.sketchId);
    if (!skf || skf.type !== 'sketch') throw new Error('拉伸：找不到引用的草图');
    const pl = planeOf(skf);
    const p = f.params;
    const thin = p.thin;
    const faces = thin ? thinProfileFaces(skf, pl, thin) : facesOfSketch(skf);
    if (!faces.length) throw new Error(thin ? '薄壁：草图没有可用轮廓' : '拉伸：草图没有封闭轮廓');
    const sign = p.reverse ? -1 : 1;
    const dir: Vec3 = [pl.normal[0] * sign, pl.normal[1] * sign, pl.normal[2] * sign];
    const off = p.start === 'offset' ? (p.startOffset ?? 0) * (p.startReverse ? -1 : 1) : 0;
    const baseFaces = off
      ? faces.map((fc) => S.translate(fc, pl.normal[0] * off, pl.normal[1] * off, pl.normal[2] * off))
      : faces;
    const baseOrigin: Vec3 = [
      pl.origin[0] + pl.normal[0] * off,
      pl.origin[1] + pl.normal[1] * off,
      pl.origin[2] + pl.normal[2] * off,
    ];
    const e1 = extrudeEndDistance(p, baseOrigin, dir, current);
    let solid = extrudeFaces(baseFaces, dir, e1.distance, e1.symmetric);
    const end2 = p.end2 ?? 'none';
    if (end2 !== 'none') {
      const dir2: Vec3 = [-dir[0], -dir[1], -dir[2]];
      const d2 = end2 === 'throughAll'
        ? extrudeEndDistance({ ...p, endCondition: 'throughAll' }, baseOrigin, dir2, current).distance
        : Math.abs(p.distance2 ?? 0);
      if (d2 > 1e-6) solid = S.fuse(solid, extrudeFaces(baseFaces, dir2, d2, false));
    }
    const op = p.operation;
    return {
      shape: applyBoolean(op, current, solid),
      added: op === 'add' || op === 'new' ? solid : undefined,
      tool: op === 'cut' ? solid : undefined,
    };
  },

  revolve: (f, current, ctx) => {
    const skf = ctx.doc.getFeature(f.params.sketchId);
    if (!skf || skf.type !== 'sketch') throw new Error('旋转：找不到引用的草图');
    const pl = planeOf(skf);
    const thin = f.params.thin;
    const faces = thin ? thinProfileFaces(skf, pl, thin) : facesOfSketch(skf);
    if (!faces.length) throw new Error(thin ? '旋转：薄壁草图没有可用轮廓' : '旋转：草图没有封闭轮廓');
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
  },

  loft: (f, current, ctx) => {
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
  },

  sweep: (f, current, ctx) => {
    const prof = ctx.doc.getFeature(f.params.profileSketchId);
    const path = ctx.doc.getFeature(f.params.pathSketchId);
    if (!prof || prof.type !== 'sketch' || !path || path.type !== 'sketch') {
      throw new Error('扫描：缺少轮廓或路径草图');
    }
    const plP = planeOf(prof);
    solveSketch(prof.params.sketch);
    const plPath = planeOf(path);
    solveSketch(path.params.sketch);
    const pathPts = sampleSketchPath(path.params.sketch, plPath, 48);
    if (pathPts.length < 2) throw new Error('扫描：路径草图没有可用曲线');
    let solid: any;
    const thin = f.params.thin;
    if (thin) {
      const loops = thinLoops3D(prof, plP, thin);
      if (!loops.length) throw new Error('扫描：薄壁轮廓草图没有可用轮廓');
      const to2 = (p: Vec3): Vec2 => {
        const q = worldToPlane(plP, p);
        return [q[0], q[1]];
      };
      const parts = loops.map((l) => {
        const outerSolid = sweepProfileAlongPath(pathPts, l.outer.map(to2), plP.normal);
        if (!l.inner) return outerSolid;
        return S.cutAll(outerSolid, [sweepProfileAlongPath(pathPts, l.inner.map(to2), plP.normal)]);
      });
      solid = parts.length === 1 ? parts[0] : S.fuseAll(parts);
    } else {
      const pRegions = sketchToRegions(prof.params.sketch, plP);
      if (!pRegions.length) throw new Error('扫描：轮廓草图没有封闭区域');
      solid = sweepProfileAlongPath(pathPts, pRegions[0].polygon, plP.normal);
    }
    const op = f.params.operation;
    return { shape: applyBoolean(op, current, solid), added: solid, tool: op === 'cut' ? solid : undefined };
  },

  spring: (f, current) => {
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
  },

  spiral: (f, current) => {
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
  },

  fillet: (f, current) => {
    if (!current) throw new Error('圆角：没有可操作的实体');
    const edges = resolveEdges(current, f.params.edges);
    if (!edges.length) throw new Error('圆角：找不到对应的边');
    return { shape: S.fillet(current, edges, f.params.radius, f.params.radius2) };
  },

  scale: (f, current) => {
    if (!current) throw new Error('缩放：没有可操作的实体');
    const p = f.params;
    const factors: [number, number, number] = p.nonUniform
      ? [p.factors?.[0] ?? 1, p.factors?.[1] ?? 1, p.factors?.[2] ?? 1]
      : [p.factor, p.factor, p.factor];
    if (factors.some((k) => !Number.isFinite(k) || Math.abs(k) < 1e-9)) {
      throw new Error('缩放：系数不能为 0');
    }
    return { shape: S.scale(current, p.center, factors) };
  },

  split: (f, current) => {
    if (!current) throw new Error('分割：没有可操作的实体');
    const pl = f.params.plane;
    return { shape: S.splitByPlane(current, pl, f.params.keep) };
  },

  moveBody: (f, current) => {
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
      out.push(...targets);
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
  },

  deleteBody: (f, current) => {
    if (!current) throw new Error('删除实体：没有可操作的实体');
    const bodies = S.bodiesOf(current);
    const del = new Set((f.params.indices ?? []).map((i) => (i < 0 ? bodies.length + i : i)));
    if (!del.size) throw new Error('删除实体：没有选择要删除的实体');
    for (const i of del) {
      if (!Number.isInteger(i) || i < 0 || i >= bodies.length) {
        throw new Error(`删除实体：实体下标 ${i} 越界（当前 ${bodies.length} 个实体）`);
      }
    }
    const kept = bodies.filter((_, i) => !del.has(i));
    if (!kept.length) throw new Error('删除实体：不能删除全部实体');
    return { shape: kept.length === 1 ? kept[0] : S.compoundOf(kept) };
  },

  combine: (f, current) => {
    if (!current) throw new Error('组合：没有可操作的实体');
    const bodies = S.bodiesOf(current);
    const { mainIndex, toolIndices, operation } = f.params;
    if (!Number.isInteger(mainIndex) || mainIndex < 0 || mainIndex >= bodies.length) {
      throw new Error(`组合：主体下标 ${mainIndex} 越界（当前 ${bodies.length} 个实体）`);
    }
    const tools = (toolIndices ?? []).length
      ? (toolIndices ?? []).filter((i) => i !== mainIndex)
      : bodies.map((_, i) => i).filter((i) => i !== mainIndex);
    if (!tools.length) throw new Error('组合：没有选择工具体');
    for (const i of tools) {
      if (!Number.isInteger(i) || i < 0 || i >= bodies.length) {
        throw new Error(`组合：工具体下标 ${i} 越界（当前 ${bodies.length} 个实体）`);
      }
    }
    const merged = S.combineBodies(bodies[mainIndex], tools.map((i) => bodies[i]), operation);
    const used = new Set([mainIndex, ...tools]);
    const out = [...S.bodiesOf(merged), ...bodies.filter((_, i) => !used.has(i))];
    return { shape: out.length === 1 ? out[0] : S.compoundOf(out) };
  },

  chamfer: (f, current) => {
    if (!current) throw new Error('倒角：没有可操作的实体');
    const edges = resolveEdges(current, f.params.edges);
    if (!edges.length) throw new Error('倒角：找不到对应的边');
    return { shape: S.chamfer(current, edges, f.params.distance) };
  },

  shell: (f, current) => {
    if (!current) throw new Error('抽壳：没有可操作的实体');
    const faces = resolveFaces(current, f.params.faces);
    if (!faces.length) throw new Error('抽壳：找不到要移除的面');
    return { shape: S.shell(current, faces, f.params.thickness) };
  },

  linearPattern: (f, current, ctx) => {
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
  },

  circularPattern: (f, current, ctx) => {
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
  },

  mirror: (f, current, ctx) => {
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
  },

  referencePlane: (f, current) => ({ shape: current }),

  hole: (f, current) => {
    if (!current) throw new Error('孔：没有可操作的实体');
    const tool = S.holeTool(f.params);
    return { shape: S.cut(current, tool), tool };
  },

  draft: (f, current) => {
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
  },

  rib: (f, current, ctx) => {
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
  },

  surfaceExtrude: (f, current, ctx) => {
    const skf = ctx.doc.getFeature(f.params.sketchId);
    if (!skf || skf.type !== 'sketch') throw new Error('拉伸曲面：找不到引用的草图');
    const pl = planeOf(skf);
    const wire = profileWireOf(skf);
    const sign = f.params.reverse ? -1 : 1;
    const dir: [number, number, number] = [pl.normal[0] * sign, pl.normal[1] * sign, pl.normal[2] * sign];
    ctx.surfaceById.set(f.id, [S.surfaceExtrude(wire, dir, f.params.distance, !!f.params.symmetric)]);
    return { shape: current };
  },

  surfaceRevolve: (f, current, ctx) => {
    const skf = ctx.doc.getFeature(f.params.sketchId);
    if (!skf || skf.type !== 'sketch') throw new Error('旋转曲面：找不到引用的草图');
    const pl = planeOf(skf);
    const wire = profileWireOf(skf);
    const origin = worldFromSketch(pl, f.params.axisA[0], f.params.axisA[1]);
    const p2 = worldFromSketch(pl, f.params.axisB[0], f.params.axisB[1]);
    const axis: [number, number, number] = [p2[0] - origin[0], p2[1] - origin[1], p2[2] - origin[2]];
    const sign = f.params.reverse ? -1 : 1;
    const ang = ((f.params.angleDeg * Math.PI) / 180) * sign;
    ctx.surfaceById.set(f.id, [S.surfaceRevolve(wire, origin, axis, ang)]);
    return { shape: current };
  },

  surfacePlanar: (f, current, ctx) => {
    const skf = ctx.doc.getFeature(f.params.sketchId);
    if (!skf || skf.type !== 'sketch') throw new Error('平面区域：找不到引用的草图');
    const faces = facesOfSketch(skf);
    if (!faces.length) throw new Error('平面区域：草图没有闭合轮廓');
    ctx.surfaceById.set(f.id, [faces[0]]);
    return { shape: current };
  },

  surfaceLoft: (f, current, ctx) => {
    const wires: any[] = [];
    for (const sid of f.params.sketchIds) {
      const skf = ctx.doc.getFeature(sid);
      if (!skf || skf.type !== 'sketch') continue;
      wires.push(profileWireOf(skf));
    }
    if (wires.length < 2) throw new Error('放样曲面：至少需要两个截面草图');
    ctx.surfaceById.set(f.id, [S.loftRobust(wires, false, !!f.params.ruled)]);
    return { shape: current };
  },

  surfaceSweep: (f, current, ctx) => {
    const prof = ctx.doc.getFeature(f.params.profileSketchId);
    const path = ctx.doc.getFeature(f.params.pathSketchId);
    if (!prof || prof.type !== 'sketch' || !path || path.type !== 'sketch') {
      throw new Error('扫描曲面：缺少轮廓或路径草图');
    }
    const plP = planeOf(prof);
    solveSketch(prof.params.sketch);
    const pRegions = sketchToRegions(prof.params.sketch, plP);
    if (!pRegions.length) throw new Error('扫描曲面：轮廓草图没有封闭区域');
    const plPath = planeOf(path);
    solveSketch(path.params.sketch);
    const pathPts = sampleSketchPath(path.params.sketch, plPath, 48);
    if (pathPts.length < 2) throw new Error('扫描曲面：路径草图没有可用曲线');
    ctx.surfaceById.set(f.id, [sweepProfileAlongPath(pathPts, pRegions[0].polygon, plP.normal, false)]);
    return { shape: current };
  },

  surfaceTrim: (f, current, ctx) => {
    const inputs = collectSurfaceShells(ctx, f.params.surfaceIds, '裁剪曲面');
    const axisIdx = f.params.axis === 'x' ? 0 : f.params.axis === 'y' ? 1 : 2;
    const BIG = 1e5;
    const base = inputs.length === 1 ? inputs[0] : S.compoundOf(inputs);
    const bb = S.shapeBBox(base);
    const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
    const origin: [number, number, number] = [c[0] - BIG / 2, c[1] - BIG / 2, c[2] - BIG / 2];
    origin[axisIdx] = f.params.keep === 'positive' ? f.params.offset : f.params.offset - BIG;
    const box = S.translate(S.primitives.box(BIG, BIG, BIG), origin[0], origin[1], origin[2]);
    const kept: any[] = [];
    for (const s of inputs) {
      try {
        kept.push(...S.surfacesOf(S.common(s, box)));
      } catch {
        /* 该曲面与裁剪盒无交集 → 被整片裁掉；其余曲面继续裁剪 */
      }
    }
    if (!kept.length) throw new Error('裁剪曲面：裁剪后没有任何剩余');
    for (const sid of f.params.surfaceIds) ctx.surfaceById.delete(sid);
    ctx.surfaceById.set(f.id, kept);
    return { shape: current };
  },

  surfaceSew: (f, current, ctx) => {
    const inputs = collectSurfaceShells(ctx, f.params.surfaceIds, '缝合曲面');
    if (inputs.length < 2) throw new Error('缝合曲面：至少需要两个曲面体');
    const sewn = S.sewShapes(inputs, f.params.tolerance ?? 1e-4);
    let shells = S.surfacesOf(sewn);
    if (!shells.length) shells = [sewn];
    for (const sid of f.params.surfaceIds) ctx.surfaceById.delete(sid);
    ctx.surfaceById.set(f.id, shells);
    return { shape: current };
  },

  sheetBaseFlange: (f, current, ctx) => {
    const p = f.params;
    if (!(p.thickness > 0)) throw new Error('基体法兰：板厚必须大于 0');
    const skf = ctx.doc.getFeature(p.sketchId);
    if (!skf || skf.type !== 'sketch') throw new Error('基体法兰：找不到引用的草图');
    const pl = planeOf(skf);
    const faces = facesOfSketch(skf);
    if (!faces.length) throw new Error('基体法兰：草图没有封闭轮廓');
    const sign = p.reverse ? -1 : 1;
    const dir: Vec3 = [pl.normal[0] * sign, pl.normal[1] * sign, pl.normal[2] * sign];
    const solid = extrudeFaces(faces, dir, Math.abs(p.thickness), false);
    const op = p.operation;
    return {
      shape: applyBoolean(op, current, solid),
      added: op === 'add' || op === 'new' ? solid : undefined,
      tool: op === 'cut' ? solid : undefined,
    };
  },

  sheetEdgeFlange: (f, current) => {
    if (!current) throw new Error('边线法兰：请先创建钣金基体（基体法兰）');
    const p = f.params;
    if (!(p.length > 0)) throw new Error('边线法兰：法兰长度必须大于 0');
    if (!(p.thickness > 0)) throw new Error('边线法兰：板厚必须大于 0');
    const edges = resolveEdges(current, [p.edge]);
    if (!edges.length) throw new Error('边线法兰：找不到选中的边');
    const wall = buildEdgeFlange(edges[0], current, p);
    const op = p.operation;
    return {
      shape: applyBoolean(op, current, wall),
      added: op === 'add' || op === 'new' ? wall : undefined,
      tool: op === 'cut' ? wall : undefined,
    };
  },
};

const FEATURE_REGISTRY = new Map<Feature['type'], FeatureHandlerFn>(
  Object.entries(FEATURE_HANDLERS) as any
);

export function evaluateFeature(f: Feature, current: any, ctx: EvalCtx): EvalOut {
  const h = FEATURE_REGISTRY.get(f.type);
  if (!h) throw new Error(`未知特征类型：${f.type}`);
  return h(f, current, ctx);
}

/**
 * 边线法兰几何：沿选中的**直线边**放样一个「L 形截面」生成带折弯的钣金壁，再交给调用方布尔融合。
 *
 * 截面定义在由「边方向 d × 钣金外法向 n」张成的局部坐标系（u = 平面内、指向基体外部；
 * n = 钣金外法向）。截面是一块厚 T 的弯板：
 *  - 根部沿 +u 平贴一段（长度 = 折弯半径 R）桥接到边，再以四分之一圆弧折起，
 *    最后沿 +n 直立 length 高（墙）；
 *  - 板厚 T 沿截面左法向 ±T/2 偏移，根部与基体薄板重叠 T/2 以保证布尔融合干净。
 * 默认 angleDeg=90° 即竖直墙；其它角度把整面墙绕边轴旋转 (angleDeg−90°) 实现倾斜。
 * `reverse` 仅把墙翻到边的另一侧（u → −u）。
 */
function buildEdgeFlange(edge: any, base: any, p: SheetEdgeFlangeFeature['params']): any {
  const einfo = edgeInfos(edge)[0];
  if (!einfo) throw new Error('边线法兰：边几何解析失败');
  if (einfo.curveType !== 'line' || !einfo.endpoints) throw new Error('边线法兰：仅支持直线边');
  const [A, B] = einfo.endpoints;
  let d = sub3(B, A);
  const L = len3(d);
  if (L < 1e-6) throw new Error('边线法兰：边过短');
  d = norm3(d);

  // 钣金外法向 n：取面积最大的平面面法向，并让其指向远离基体中心的一侧
  const fis = faceInfos(base);
  let n: Vec3 = [0, 0, 1];
  let bestArea = -1;
  for (const fi of fis) {
    if (fi.surfaceType === 'plane' && fi.area > bestArea) { bestArea = fi.area; n = fi.normal; }
  }
  n = norm3(n);
  let centroid: Vec3 = [0, 0, 0];
  try {
    const mp = S.massProperties(base);
    if (mp && mp.centroid) centroid = mp.centroid as Vec3;
  } catch { /* 退化基体 */ }
  const mid: Vec3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];

  // 平面内、垂直于边、指向基体外部的方向 u
  let u = norm3(cross3(d, n));
  if (!isFinite(u[0]) || (u[0] === 0 && u[1] === 0 && u[2] === 0)) u = [1, 0, 0];
  // 从边中点到基体中心、剔除 n 分量（投影到钣金平面）→ 指向内部；u 取指向外部的一侧
  let vplane = sub3(mid, centroid);
  const dn = dot3(vplane, n);
  vplane = [vplane[0] - dn * n[0], vplane[1] - dn * n[1], vplane[2] - dn * n[2]];
  if (len3(vplane) < 1e-4) vplane = u;
  if (dot3(u, vplane) < 0) u = [-u[0], -u[1], -u[2]] as Vec3;
  // 反向：把墙翻到边的另一侧
  if (p.reverse) u = [-u[0], -u[1], -u[2]] as Vec3;

  const T = p.thickness;
  const R = Math.max(p.bendRadius || 0, T / 2); // 内折弯半径不可小于板厚一半，否则自交
  const H = Math.max(p.length, 1e-3);
  const m = 14; // 折弯弧 / 墙 的采样数

  // ---- 构造 L 形截面（局部坐标 x=沿u, y=沿n），先外表面正向、再内表面逆向，自动闭合 ----
  const sec: [number, number][] = [];
  // seg1（平贴段）：s ∈ [0, R] 沿 +u，外表面 y=+T/2
  for (let i = 0; i <= m; i++) sec.push([(R * i) / m, T / 2]);
  // arc 外表面：φ ∈ [0, π/2]，外 = 中 + (T/2)·左法向
  for (let i = 1; i <= m; i++) {
    const phi = (Math.PI / 2) * (i / m);
    sec.push([R + (R - T / 2) * Math.sin(phi), R - (R - T / 2) * Math.cos(phi)]);
  }
  // wall 外表面：t ∈ [0, H]，x = 2R − T/2，y = R + t
  for (let i = 1; i <= m; i++) sec.push([2 * R - T / 2, R + (H * i) / m]);
  // 顶边：外 → 内
  sec.push([2 * R + T / 2, R + H]);
  // wall 内表面：t ∈ [H, 0]
  for (let i = m - 1; i >= 0; i--) sec.push([2 * R + T / 2, R + (H * i) / m]);
  // arc 内表面：φ ∈ [π/2, 0]
  for (let i = m - 1; i >= 0; i--) {
    const phi = (Math.PI / 2) * (i / m);
    sec.push([R + (R + T / 2) * Math.sin(phi), R - (R + T / 2) * Math.cos(phi)]);
  }
  // seg1 内表面：s ∈ [R, 0]
  for (let i = m - 1; i >= 0; i--) sec.push([(R * i) / m, -T / 2]);

  // ---- 沿边放样（直线边 → 等截面棱柱）----
  const stations = 6;
  const sections: [number, number, number][][] = [];
  for (let s = 0; s < stations; s++) {
    const tt = (L * s) / (stations - 1);
    const o: Vec3 = [A[0] + d[0] * tt, A[1] + d[1] * tt, A[2] + d[2] * tt];
    sections.push(
      sec.map(([x, y]) => [
        o[0] + u[0] * x + n[0] * y,
        o[1] + u[1] * x + n[1] * y,
        o[2] + u[2] * x + n[2] * y,
      ] as [number, number, number])
    );
  }
  let wall = S.loftSections(sections, true, false);

  // 非 90°：绕边轴旋转 (angleDeg−90°)，使墙倾斜
  const ang = p.angleDeg ?? 90;
  if (Math.abs(ang - 90) > 0.5) {
    wall = S.rotateAxis(wall, A, d, (ang - 90) * Math.PI / 180);
  }
  return wall;
}

interface EvalCtx {
  doc: CadDocument;
  byId: Map<FeatureId, Feature>;
  /**
   * 每个曲面类特征产出的壳（按特征 id 存）。求值末尾汇总与实体合成一个可网格化形状。
   * 裁剪/缝合会「消费」被引用曲面：删除其条目并写入自身新的壳，从而替换而非叠加。
   */
  surfaceById: Map<FeatureId, any[]>;
}

/**
 * 汇总被引用「曲面类」特征产出的壳（供裁剪/缝合消费）。
 * 引用缺失、引用了非曲面特征、或该壳已被上游曲面操作替换时明确报错。
 */
function collectSurfaceShells(ctx: EvalCtx, ids: FeatureId[], what: string): any[] {
  const out: any[] = [];
  for (const sid of ids) {
    const shells = ctx.surfaceById.get(sid);
    if (!shells || !shells.length) throw new Error(`${what}：引用的特征不是曲面体或已被其它曲面操作替换`);
    out.push(...shells);
  }
  return out;
}

export interface RebuildOutcome {
  shape: any;
  errors: { id: string; message: string }[];
  ms: number;
  /** 曲面实体（壳）数量 */
  surfaces: number;
}

/**
 * 这些特征类型**合法地**可能让 `out.shape` 不产出实体（也不报错）：
 *  - `sketch` / `referencePlane`：纯拓扑/参照特征，`out.shape` 原样透传 `current`；
 *  - 全部 `surface*`：几何输出写入 `ctx.surfaceById`（供末尾汇总），`out.shape` 透传 `current`。
 * 它们本身从不"吃掉"已有几何，因此即便 `bodiesOf==0 && surfacesOf==0` 也不应被当成缺陷。
 * 与之相反，`combine`(差集/交集)/`primitive`(cut)/`hole`/`shell`(切除)/`scale`/`split`/`moveBody`/
 * `deleteBody`/`draft`/`rib` 等**应当**保留至少一个实体——它们若把主体整体移除就是真正缺陷
 * （OCCT 此时返回空复合体且不抛异常），正是 rebuildFeatures 里的断言要拦截的。
 */
const MAY_EMPTY_RESULT = new Set<Feature['type']>([
  'sketch',
  'referencePlane',
  'surfaceExtrude',
  'surfaceRevolve',
  'surfacePlanar',
  'surfaceLoft',
  'surfaceSweep',
  'surfaceTrim',
  'surfaceSew',
]);

/**
 * 重放整棵特征树，返回最终 TopoDS（仅在 Worker 内有效）与出错特征列表。
 *
 * 曲面特征产生的壳按特征 id 记入 `ctx.surfaceById`（裁剪/缝合会引用并替换其中条目），
 * 末尾汇总与实体合成一个复合形状（供三角化渲染）；
 * 因此返回的 `shape` 可能同时含实体与曲面体，`surfaces` 给出曲面体数量。
 */
export function rebuildFeatures(features: Feature[], upto?: FeatureId): RebuildOutcome {
  const t0 = performance.now();
  const doc = new CadDocument();
  doc.features = features as Feature[];
  const ctx: EvalCtx = { doc, byId: new Map(features.map((f) => [f.id, f])), surfaceById: new Map() };
  let current: any = null;
  const errors: { id: string; message: string }[] = [];
  const stopAt = upto === undefined ? features.length : doc.indexOf(upto) + 1;

  for (let i = 0; i < stopAt; i++) {
    const f = features[i];
    if ((f as any).suppressed) {
      doc.evalCache.set(f.id, { shape: current });
      continue;
    }
    // 进入此特征前已有的几何（用于下方「求值后几何被静默清空」判定）
    const prevHadGeometry =
      current != null && (S.bodiesOf(current).length + S.surfacesOf(current).length > 0);
    try {
      const out = evaluateFeature(f, current, ctx);
      doc.evalCache.set(f.id, out);
      current = out.shape;
      // 健壮性：布尔切除/相交等可能把主体整体吃掉，而 OCCT 此时返回的是**空复合体**
      // （IsNull 为 false、实体数为 0），不会抛异常——若不拦截就会静默产出一个空模型。
      // 合法特征都不会把「有几何」变成「零实体零曲面」，故此处断言零误报。
      if (out.shape && !MAY_EMPTY_RESULT.has(f.type)) {
        const bodies = S.bodiesOf(out.shape).length;
        if (bodies === 0) {
          const shells = S.surfacesOf(out.shape).length;
          if (shells === 0 && prevHadGeometry) {
            errors.push({
              id: f.id,
              message: '求值后几何变为空（布尔/切除把主体整体移除，几何条件不满足）',
            });
          }
        }
      }
    } catch (e) {
      const msg = translateOcctError(e);
      errors.push({ id: f.id, message: msg });
      doc.evalCache.set(f.id, { shape: current });
    }
  }

  // 实体 + 曲面体合成一个形状供网格化/渲染；体积/实体数仍只由实体部分贡献。
  const parts: any[] = [];
  if (current) parts.push(current);
  let surfaceCount = 0;
  for (const shells of ctx.surfaceById.values()) {
    parts.push(...shells);
    surfaceCount += shells.length;
  }
  const shape = parts.length === 0 ? null : parts.length === 1 ? parts[0] : S.compoundOf(parts);
  return { shape, errors, ms: performance.now() - t0, surfaces: surfaceCount };
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

  // 实体归属（供主线程「选择过滤器 = 实体」使用）：
  // 按 bodiesOf 展开顺序逐 body 枚举面，用 IsSame 与 tessellate 的 faceList 匹配。
  // 注意 bodiesOf 顺序 ≠ compound 的 TopExp 面序，所以不能按顺序拼，必须逐个 IsSame 比对。
  try {
    const bodies = S.bodiesOf(shape);
    if (bodies.length > 1) {
      for (let b = 0; b < bodies.length; b++) {
        for (const f of S.faces(bodies[b])) {
          for (let i = 0; i < md.faceList.length; i++) {
            if (faceMetas[i].bodyIndex !== undefined) continue;
            if (md.faceList[i].IsSame(f)) {
              faceMetas[i].bodyIndex = b;
              break;
            }
          }
        }
      }
    }
  } catch {
    /* IsSame 不可用时退化为无实体归属（行为与旧版一致） */
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
