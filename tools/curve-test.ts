/**
 * 曲线族测试：螺旋线 / 弹簧 / 涡状线盘簧 / 扫掠（含开放路径）。
 *
 * 本套件的重点是驱动两件事：
 *  1. **修复「扫描」只支持闭环路径的缺陷** —— 开放折线（线/弧串）现在也能扫掠；
 *  2. 新增的「弹簧」「涡状线」特征几何正确性（体积与解析值对照）。
 *
 * 运行: node tools/run-ts.mjs tools/curve-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument, newSketchFeature, PLANES } from '../src/doc/model';
import { rebuildFeatures, buildMeshResult } from '../src/doc/engine';
import {
  circleProfile,
  cleanLoop,
  cleanLoop2,
  helixPoints,
  pathLength3,
  placeSections,
  polylineTangents,
  sampleSketchPath,
  spiralPoints2D,
  spiralRibbon2D,
  transportFrames,
  type Vec3,
} from '../src/sketch/curve';
import { emptySketch, newId, type Sketch, type SkEntity } from '../src/sketch/types';
import type { Feature, FeatureId, SpringFeature, SpiralFeature, SweepFeature } from '../src/doc/types';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}  ${detail}`);
  }
}
const near = (a: number, b: number, tol = 1e-2) => Math.abs(a - b) <= tol;
const nearRel = (a: number, b: number, rel = 0.02) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-6;

const oc = await initOcctNode();
setOcct(oc);
console.log('内核已注入\n');

// ============================================================
// 草图构造辅助
// ============================================================
function mkSketch(build: (sk: Sketch, P: (x: number, y: number) => string, add: (e: SkEntity) => void) => void): Sketch {
  const sk = emptySketch();
  const P = (x: number, y: number) => {
    const id = newId('p');
    sk.points[id] = { id, x, y };
    return id;
  };
  const add = (e: SkEntity) => sk.entities.push(e);
  build(sk, P, add);
  return sk;
}

const circleSketch = (r: number, cx = 0, cy = 0) =>
  mkSketch((_sk, P, add) => add({ id: newId('e'), kind: 'circle', c: P(cx, cy), r }));

const lineChainSketch = (pts: [number, number][]) =>
  mkSketch((_sk, P, add) => {
    const ids = pts.map(([x, y]) => P(x, y));
    for (let i = 0; i + 1 < ids.length; i++) add({ id: newId('e'), kind: 'line', a: ids[i], b: ids[i + 1] });
  });

/** 直线 + 圆弧 的开放链：从 (0,0) 到 (30,0)，再以 (30,30) 为圆心、r=30 逆时针到 (60,30) */
/** 闭合多边形草图（首尾复用同一个点，形成真正的闭环） */
const closedPolygonSketch = (pts: [number, number][]) =>
  mkSketch((_sk, P, add) => {
    const ids = pts.map(([x, y]) => P(x, y));
    for (let i = 0; i < ids.length; i++) add({ id: newId('e'), kind: 'line', a: ids[i], b: ids[(i + 1) % ids.length] });
  });

/** 单段圆弧路径：圆心在原点、半径 r、从 60° 逆时针扫到 60°+sweepDeg */
const arcSketch = (r: number, sweepDeg: number) =>
  mkSketch((_sk, P, add) => {
    const a0 = Math.PI / 3;
    const a1 = a0 + (sweepDeg * Math.PI) / 180;
    const a = P(r * Math.cos(a0), r * Math.sin(a0));
    const b = P(r * Math.cos(a1), r * Math.sin(a1));
    const c = P(0, 0);
    add({ id: newId('e'), kind: 'arc', c, a, b, ccw: true });
  });

const lineArcSketch = () =>
  mkSketch((_sk, P, add) => {
    const a = P(0, 0);
    const b = P(30, 0);
    const c = P(30, 30);
    const d = P(60, 30);
    add({ id: newId('e'), kind: 'line', a, b });
    add({ id: newId('e'), kind: 'arc', c, a: b, b: d, ccw: true });
  });

function rebuild(doc: CadDocument, upto?: FeatureId): any {
  const { shape, errors } = rebuildFeatures(doc.features, upto);
  for (const f of doc.features) f.error = undefined;
  for (const e of errors) {
    const f = doc.getFeature(e.id);
    if (f) f.error = e.message;
  }
  return shape;
}

function featureErrors(doc: CadDocument): string[] {
  return doc.features.filter((f) => f.error).map((f) => `${f.name}: ${f.error}`);
}

/** null 安全的度量（求值失败时返回 NaN/0，让断言自然失败而不是崩溃） */
const volOf = (s: any): number => (s && !s.IsNull() ? S.volume(s) : NaN);
const solidsOf = (s: any): number => (s && !s.IsNull() ? S.solids(s).length : 0);

// ============================================================
// A. 螺旋线数学（纯计算）
// ============================================================
console.log('▶ A. 螺旋线数学');
{
  const pts = helixPoints({ origin: [0, 0, 0], axis: [0, 0, 1], radius: 15, pitch: 10, turns: 5, segsPerTurn: 24 });
  check('点数 = 每圈段数 × 圈数 + 1', pts.length === 121, `实际 ${pts.length}`);
  check('起点在 (R,0,0)', near(pts[0][0], 15) && near(pts[0][1], 0) && near(pts[0][2], 0));
  check('总高 = 螺距 × 圈数', near(pts[pts.length - 1][2], 50), `实际 ${pts[pts.length - 1][2].toFixed(3)}`);
  const allOnCyl = pts.every((p) => near(Math.hypot(p[0], p[1]), 15, 1e-6));
  check('所有点都在半径 15 的圆柱面上', allOnCyl);
  check('螺旋长与解析值一致（折线弦长略短）', nearRel(pathLength3(pts), 5 * Math.hypot(2 * Math.PI * 15, 10), 0.005), `实际 ${pathLength3(pts).toFixed(2)}`);

  const left = helixPoints({ origin: [0, 0, 0], axis: [0, 0, 1], radius: 15, pitch: 10, turns: 1, handedness: 'left', segsPerTurn: 24 });
  check('左旋：1/4 圈处 y 为负', left[6][1] < 0, `y=${left[6][1].toFixed(3)}`);
  const right = helixPoints({ origin: [0, 0, 0], axis: [0, 0, 1], radius: 15, pitch: 10, turns: 1, handedness: 'right', segsPerTurn: 24 });
  check('右旋：1/4 圈处 y 为正', right[6][1] > 0, `y=${right[6][1].toFixed(3)}`);

  const taper = helixPoints({ origin: [0, 0, 0], axis: [0, 0, 1], radius: 10, pitch: 20, turns: 1, taperDeg: 10, segsPerTurn: 12 });
  const endR = Math.hypot(taper[taper.length - 1][0], taper[taper.length - 1][1]);
  check('锥度：末半径 = R + tan(锥度)·高', near(endR, 10 + Math.tan((10 * Math.PI) / 180) * 20, 1e-3), `实际 ${endR.toFixed(3)}`);

  // 轴为 X 的螺旋：所有点应满足 (y² + z²) = R²
  const axX = helixPoints({ origin: [5, 0, 0], axis: [1, 0, 0], radius: 8, pitch: 5, turns: 2 });
  const onX = axX.every((p) => near(Math.hypot(p[1], p[2]), 8, 1e-6));
  check('任意轴向：点都在以该轴为轴的圆柱面上', onX);
}

// ============================================================
// B. 平行移动标架（纯计算）
// ============================================================
console.log('\n▶ B. 平行移动标架');
{
  const straight: Vec3[] = Array.from({ length: 11 }, (_, i) => [i * 5, 0, 0]);
  const f1 = transportFrames(polylineTangents(straight));
  const same = f1.every((f) => near(f.u[0], f1[0].u[0], 1e-9) && near(f.u[1], f1[0].u[1], 1e-9) && near(f.u[2], f1[0].u[2], 1e-9));
  check('直线路径：标架不旋转（无扭转）', same);

  const helix = helixPoints({ origin: [0, 0, 0], axis: [0, 0, 1], radius: 15, pitch: 10, turns: 2, segsPerTurn: 24 });
  const tangents = polylineTangents(helix);
  const frames = transportFrames(tangents);
  check('帧数 = 点数', frames.length === helix.length);
  const orth = frames.every((f, i) => {
    const t = tangents[i];
    const dotUV = f.u[0] * f.v[0] + f.u[1] * f.v[1] + f.u[2] * f.v[2];
    const dotUT = f.u[0] * t[0] + f.u[1] * t[1] + f.u[2] * t[2];
    const dotVT = f.v[0] * t[0] + f.v[1] * t[1] + f.v[2] * t[2];
    return Math.abs(dotUV) < 1e-6 && Math.abs(dotUT) < 1e-6 && Math.abs(dotVT) < 1e-6;
  });
  check('每帧 u⊥v、u⊥t、v⊥t（正交标架）', orth);
  const unit = frames.every((f) => near(Math.hypot(...f.u), 1, 1e-6) && near(Math.hypot(...f.v), 1, 1e-6));
  check('u/v 均为单位向量', unit);

  // 连续性：相邻帧的 u 夹角应小于该站路径转角（旋转最小化）
  let maxRatio = 0;
  for (let i = 1; i < frames.length; i++) {
    const du = Math.acos(Math.max(-1, Math.min(1, frames[i - 1].u[0] * frames[i].u[0] + frames[i - 1].u[1] * frames[i].u[1] + frames[i - 1].u[2] * frames[i].u[2])));
    const dt = Math.acos(Math.max(-1, Math.min(1, tangents[i - 1][0] * tangents[i][0] + tangents[i - 1][1] * tangents[i][1] + tangents[i - 1][2] * tangents[i][2])));
    if (dt > 1e-9) maxRatio = Math.max(maxRatio, du / dt);
  }
  check('标架转角 ≤ 路径转角（旋转最小化）', maxRatio <= 1.001, `最大比值 ${maxRatio.toFixed(4)}`);

  const sections = placeSections(circleProfile(2, 16), helix.slice(0, 3), frames.slice(0, 3));
  check('截面放置：每站点数 = 截面点数', sections.every((s) => s.length === 16));
  const centered = sections.every((s, i) => {
    const c = s.reduce<Vec3>((acc, p) => [acc[0] + p[0] / s.length, acc[1] + p[1] / s.length, acc[2] + p[2] / s.length], [0, 0, 0]);
    return near(c[0], helix[i][0], 1e-9) && near(c[1], helix[i][1], 1e-9) && near(c[2], helix[i][2], 1e-9);
  });
  check('截面质心落在对应路径站点上', centered);
  const radiusKept = sections.every((s, i) => s.every((p) => near(Math.hypot(p[0] - helix[i][0], p[1] - helix[i][1], p[2] - helix[i][2]), 2, 1e-6)));
  check('截面半径保持为 2（截面不变形）', radiusKept);
}

// ============================================================
// C. 草图路径采样（纯计算）
// ============================================================
console.log('\n▶ C. 草图路径采样');
{
  const single = sampleSketchPath(lineChainSketch([[0, 0], [40, 0]]), PLANES.front);
  check('单条直线 → 2 点', single.length === 2, `实际 ${single.length}`);
  check('直线端点映射到世界坐标', near(single[1][0], 40) && near(single[1][1], 0) && near(single[1][2], 0));

  const chain = sampleSketchPath(lineArcSketch(), PLANES.front);
  check('线+弧开放链 → 采样点 > 2', chain.length > 2, `实际 ${chain.length}`);
  check('链起点 = (0,0,0)', near(chain[0][0], 0) && near(chain[0][1], 0));
  const last = chain[chain.length - 1];
  check('链终点 = (60,30,0)', near(last[0], 60, 1e-3) && near(last[1], 30, 1e-3), `实际 (${last[0].toFixed(2)}, ${last[1].toFixed(2)})`);
  check('链总长 = 30 + 30·π/2', nearRel(pathLength3(chain), 30 + 30 * (Math.PI / 2), 0.01), `实际 ${pathLength3(chain).toFixed(2)}`);

  const circ = sampleSketchPath(circleSketch(10), PLANES.front);
  check('整圆 → 首尾重合', near(circ[0][0], circ[circ.length - 1][0], 1e-6) && near(circ[0][1], circ[circ.length - 1][1], 1e-6));
  check('整圆周长 = 2πr', nearRel(pathLength3(circ), 2 * Math.PI * 10, 0.01), `实际 ${pathLength3(circ).toFixed(2)}`);

  const rect = sampleSketchPath(lineChainSketch([[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]]), PLANES.front);
  check('闭环矩形 → 周长 60', nearRel(pathLength3(rect), 60, 0.01), `实际 ${pathLength3(rect).toFixed(2)}`);
}

// ============================================================
// D. 弹簧（需 OCCT）
// ============================================================
console.log('\n▶ D. 弹簧');
{
  const R = 15, pitch = 10, turns = 5, wireD = 3;
  const doc = new CadDocument();
  const spring: SpringFeature = {
    id: newId('f'), type: 'spring', name: '弹簧1',
    params: {
      origin: [0, 0, 0], axis: [0, 0, 1],
      meanDiameter: R * 2, wireDiameter: wireD, pitch, turns,
      handedness: 'right', operation: 'new',
    },
  };
  doc.add(spring);
  const shape = rebuild(doc);
  check('弹簧求值无错误', featureErrors(doc).length === 0, featureErrors(doc).join('; '));
  // 周期性快路径（见 engine.ts springSolid）：只放样一圈再刚体复制，
  // 各圈在公共截面处严格重合、互不干涉，因此合成**复合体**而非融合实体
  //（本绑定下 fuse 对共面端盖要 50~124s，不可用）。故实体段数 = 圈数。
  check('弹簧实体段数 = 圈数（周期性快路径）', solidsOf(shape) === turns, `solids=${solidsOf(shape)}`);

  const L = turns * Math.hypot(2 * Math.PI * R, pitch);
  const vExp = Math.PI * (wireD / 2) ** 2 * L;
  const v = volOf(shape);
  check('弹簧体积 ≈ π r² × 螺旋长', nearRel(v, vExp, 0.01), `${v.toFixed(2)} vs ${vExp.toFixed(2)}`);

  const bb = shapeBBox(shape);
  check('包围盒外径 = 中径 + 线径', near(bb.max[0] - bb.min[0], R * 2 + wireD, 0.6), `实际 ${(bb.max[0] - bb.min[0]).toFixed(2)}`);
  check('包围盒高 ≈ 螺距×圈数 + 线径', near(bb.max[2] - bb.min[2], pitch * turns + wireD, 0.6), `实际 ${(bb.max[2] - bb.min[2]).toFixed(2)}`);

  // 左旋对照：几何不同
  const docL = new CadDocument();
  docL.add({ ...spring, id: newId('f'), name: '弹簧2', params: { ...spring.params, handedness: 'left' } } as SpringFeature);
  const shapeL = rebuild(docL);
  check(
    '左旋弹簧同样成立',
    solidsOf(shapeL) === turns && nearRel(volOf(shapeL), vExp, 0.01),
    `solids=${solidsOf(shapeL)} vol=${volOf(shapeL).toFixed(1)} vs ${vExp.toFixed(1)}`
  );

  // 锥形弹簧
  const docT = new CadDocument();
  docT.add({ ...spring, id: newId('f'), name: '弹簧3', params: { ...spring.params, taperDeg: 15 } } as SpringFeature);
  const shapeT = rebuild(docT);
  check('锥形弹簧求值成功', featureErrors(docT).length === 0, featureErrors(docT).join('; '));
  const bbT = shapeBBox(shapeT);
  const rBottomT = maxRadiusAt(shapeT, bbT.min[2] + 1);
  const rTopT = maxRadiusAt(shapeT, bbT.max[2] - 1);
  check('锥形弹簧：顶部外径 > 底部外径', rTopT > rBottomT + 1, `底 ⌀${(rBottomT * 2).toFixed(1)} → 顶 ⌀${(rTopT * 2).toFixed(1)}`);

  // 弹簧作为切除工具
  const docCut = new CadDocument();
  docCut.add({
    id: newId('f'), type: 'primitive', name: '圆柱',
    params: { kind: 'cylinder', dims: [40, 60], origin: [0, 0, -5], operation: 'new' },
  } as Feature);
  docCut.add({
    id: newId('f'), type: 'spring', name: '弹簧切除',
    params: { ...spring.params, operation: 'cut', turns: 4, meanDiameter: 70, wireDiameter: 8 },
  } as SpringFeature);
  const shapeCut = rebuild(docCut);
  check('弹簧可作切除工具（螺旋槽）', featureErrors(docCut).length === 0, featureErrors(docCut).join('; '));
  const cylVol = Math.PI * 40 * 40 * 60;
  check('切除后体积小于原圆柱', volOf(shapeCut) < cylVol, `${volOf(shapeCut).toFixed(1)} < ${cylVol.toFixed(1)}`);
  // 弹簧完全落在圆柱内部（外径 39 < 40，z 跨度也在柱内），所以
  // 「被挖掉的体积」应当**精确等于**弹簧体积 π r² L —— 这是对布尔精度最强的校验。
  const vSpringCut = Math.PI * (8 / 2) ** 2 * 4 * Math.hypot(2 * Math.PI * 35, 10);
  check(
    '切除量 = 弹簧解析体积（布尔精确）',
    nearRel(cylVol - volOf(shapeCut), vSpringCut, 0.01),
    `${(cylVol - volOf(shapeCut)).toFixed(1)} vs ${vSpringCut.toFixed(1)}`
  );

  // ---- 周期性快路径：性能回归护栏 ----
  // 整条放样 8 圈 = 193 个截面，实测 ~50s（且偶发失败要靠抽稀兜底）；
  // 周期性快路径只放样一圈再复制，应 ≈0.7s。
  const t8 = Date.now();
  const doc8 = new CadDocument();
  doc8.add({ ...spring, id: newId('f'), name: '弹簧8', params: { ...spring.params, turns: 8 } } as SpringFeature);
  const shape8 = rebuild(doc8);
  const ms8 = Date.now() - t8;
  const vExp8 = Math.PI * (wireD / 2) ** 2 * 8 * Math.hypot(2 * Math.PI * R, pitch);
  check(
    '8 圈弹簧走周期性快路径（< 10s；整条放样需 ~50s）',
    featureErrors(doc8).length === 0 && ms8 < 10000,
    `${ms8}ms`
  );
  check('8 圈弹簧体积仍精确', nearRel(volOf(shape8), vExp8, 0.01), `${volOf(shape8).toFixed(1)} vs ${vExp8.toFixed(1)}`);

  // ---- 缝合点对齐：侧面必须是整片 ----
  // `gp_Ax2(P, N)` 的 X 轴是按法向自动推导的，相邻截面法向略异时 X 轴会跳变，
  // 各截面的"缝"彼此错位，`ThruSections` 为了迁就它会把侧面切成十几片
  //（实测单圈 24 截面：12 面 / 30 边，网格与质量属性都慢数倍）。
  // 引擎沿路径用平行移动标架把缝搬连续后，每圈应是 1 侧面 + 2 端盖 = 3 面。
  const f8 = S.topologyCount(shape8).faces;
  check('8 圈弹簧面数 ≈ 3×圈数（缝合点对齐、侧面整片）', f8 <= 3 * 8 + 6, `面=${f8}（未对齐时 96）`);

  // ---- 退路：螺距 ≤ 线径（相邻圈穿插）不满足周期化条件，退回整条放样 ----
  const docD = new CadDocument();
  docD.add({
    ...spring, id: newId('f'), name: '密圈弹簧',
    params: { ...spring.params, turns: 2, pitch: wireD * 0.6 },
  } as SpringFeature);
  const shapeD = rebuild(docD);
  check(
    '密圈弹簧（螺距<线径）退回整条放样且成功',
    featureErrors(docD).length === 0 && solidsOf(shapeD) === 1,
    `solids=${solidsOf(shapeD)} ${featureErrors(docD).join('; ')}`
  );

  // ---- 小数圈：整数圈刚体复制 + 一段不足一圈的尾段 ----
  const docF = new CadDocument();
  docF.add({ ...spring, id: newId('f'), name: '小数圈弹簧', params: { ...spring.params, turns: 3.5 } } as SpringFeature);
  const shapeF = rebuild(docF);
  const vExpF = Math.PI * (wireD / 2) ** 2 * 3.5 * Math.hypot(2 * Math.PI * R, pitch);
  check(
    '小数圈弹簧（3.5 圈）体积正确',
    featureErrors(docF).length === 0 && nearRel(volOf(shapeF), vExpF, 0.01),
    `${volOf(shapeF).toFixed(1)} vs ${vExpF.toFixed(1)}`
  );

  // ---- 非原点 + 斜轴：验证周期性复制的仿射矩阵 ----
  // 这里专门盯住一个易错点：`gp_Trsf.SetRotation_1(ax1, ang)` 会把平移分量设成
  // `origin − R·origin`，若随后用 SetTranslationPart 覆盖它，只有 origin 在原点时才碰巧正确。
  // 因此「非原点 + 斜轴」是必须覆盖的用例。
  const originO: Vec3 = [100, -50, 30];
  const axisO: Vec3 = [1, 1, 1];
  const docO = new CadDocument();
  docO.add({
    ...spring, id: newId('f'), name: '斜置弹簧',
    params: { ...spring.params, origin: originO, axis: axisO },
  } as SpringFeature);
  const shapeO = rebuild(docO);
  check('非原点/斜轴弹簧求值成功', featureErrors(docO).length === 0, featureErrors(docO).join('; '));
  check(
    '非原点/斜轴弹簧体积不变（复制是刚体变换）',
    nearRel(volOf(shapeO), vExp, 0.01),
    `${volOf(shapeO).toFixed(1)} vs ${vExp.toFixed(1)}`
  );
  // 管体包围盒 = 中心线点云包围盒 ⊕ 半径 w（闵可夫斯基和的包围盒性质）
  const cloudO = helixPoints({
    origin: originO, axis: axisO, radius: R, pitch, turns, handedness: 'right', taperDeg: 0, segsPerTurn: 24,
  });
  const mn: number[] = [Infinity, Infinity, Infinity];
  const mx: number[] = [-Infinity, -Infinity, -Infinity];
  for (const q of cloudO) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], q[i]); mx[i] = Math.max(mx[i], q[i]); }
  const wHalf = wireD / 2;
  const bbO = shapeBBox(shapeO);
  const bbOk = [0, 1, 2].every(
    (i) => Math.abs(bbO.min[i] - (mn[i] - wHalf)) < 0.5 && Math.abs(bbO.max[i] - (mx[i] + wHalf)) < 0.5
  );
  check(
    '非原点/斜轴弹簧包围盒 = 螺旋点云 ± 线径半径',
    bbOk,
    `实测 [${bbO.min.map((v) => v.toFixed(1)).join(',')}]~[${bbO.max.map((v) => v.toFixed(1)).join(',')}]` +
      ` 期望 [${mn.map((v) => (v - wHalf).toFixed(1)).join(',')}]~[${mx.map((v) => (v + wHalf).toFixed(1)).join(',')}]`
  );
}

/** 由实体网格算包围盒 */
function shapeBBox(shape: any): { min: Vec3; max: Vec3 } {
  if (!shape || shape.IsNull()) return { min: [0, 0, 0], max: [0, 0, 0] };
  const mesh = buildMeshResult(shape, 0.2, 0.5);
  return S.boundingBox({ positions: new Float32Array(mesh.positions) });
}

/** 在 z ≈ z0 的截面上取最大径向距离（用于判断锥度） */
function maxRadiusAt(shape: any, z0: number, band = 1.5): number {
  const mesh = buildMeshResult(shape, 0.2, 0.5);
  const p = new Float32Array(mesh.positions);
  let r = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (Math.abs(p[i + 2] - z0) <= band) r = Math.max(r, Math.hypot(p[i], p[i + 1]));
  }
  return r;
}

// ============================================================
// E. 涡状线盘簧（需 OCCT）
// ============================================================
console.log('\n▶ E. 涡状线盘簧');
{
  const startRadius = 20, pitch = 8, turns = 4, thickness = 3, width = 10;
  const doc = new CadDocument();
  const spiral: SpiralFeature = {
    id: newId('f'), type: 'spiral', name: '涡状线1',
    params: {
      plane: PLANES.front, startRadius, pitch, turns, thickness, width,
      handedness: 'right', operation: 'new',
    },
  };
  doc.add(spiral);
  const shape = rebuild(doc);
  check('涡状线求值无错误', featureErrors(doc).length === 0, featureErrors(doc).join('; '));
  check('涡状线是单个实体', solidsOf(shape) === 1, `solids=${solidsOf(shape)}`);

  const mid = spiralPoints2D({ startRadius, pitch, turns, segsPerTurn: 720 });
  let len = 0;
  for (let i = 1; i < mid.length; i++) len += Math.hypot(mid[i][0] - mid[i - 1][0], mid[i][1] - mid[i - 1][1]);
  const vExp = thickness * width * len;
  const v = volOf(shape);
  check('盘簧体积 ≈ 带厚 × 带宽 × 螺线长', nearRel(v, vExp, 0.06), `${v.toFixed(1)} vs ${vExp.toFixed(1)}`);

  const ribbon = spiralRibbon2D({ startRadius, pitch, turns, thickness });
  check('带材轮廓点数 = 内外螺线点数之和（默认 24 段/圈）', ribbon.length >= turns * 24 * 2 * 0.95, `实际 ${ribbon.length}`);
  check('带材轮廓无连续重复点', cleanLoop2(ribbon).length === ribbon.length);
}

// ============================================================
// F. 扫掠（开放路径修复 + 回归）
// ============================================================
console.log('\n▶ F. 扫掠');
{
  const R = 3;
  const mkSweepDoc = (pathSketch: Sketch): CadDocument => {
    const d = new CadDocument();
    d.add(newSketchFeature('front', circleSketch(R)) as Feature);
    d.add(newSketchFeature('front', pathSketch) as Feature);
    const [a, b] = d.features;
    d.add({
      id: newId('f'), type: 'sweep', name: '扫描1',
      params: { profileSketchId: a.id, pathSketchId: b.id, operation: 'new' },
    } as SweepFeature);
    return d;
  };

  // 开放直线路径（旧实现在这里会报「路径草图没有可用轮廓」）
  {
    const doc = mkSweepDoc(lineChainSketch([[0, 0], [40, 0]]));
    const shape = rebuild(doc);
    check('开放直线路径：求值成功（旧实现报错）', featureErrors(doc).length === 0, featureErrors(doc).join('; '));
    const vExp = Math.PI * R * R * 40;
    check('直线路径扫掠体积 = π r² L', nearRel(volOf(shape), vExp, 0.01), `${volOf(shape).toFixed(2)} vs ${vExp.toFixed(2)}`);
  }

  // 开放 L 形路径（两段线）
  {
    const doc = mkSweepDoc(lineChainSketch([[0, 0], [30, 0], [30, 30]]));
    const shape = rebuild(doc);
    check('开放 L 形路径：求值成功', featureErrors(doc).length === 0, featureErrors(doc).join('; '));
    const vExp = Math.PI * R * R * 60;
    check('L 形路径扫掠体积 ≈ π r² × 总长（含转角）', nearRel(volOf(shape), vExp, 0.06), `${volOf(shape).toFixed(2)} vs ${vExp.toFixed(2)}`);
  }

  // 开放 线+弧 路径
  {
    const doc = mkSweepDoc(lineArcSketch());
    const shape = rebuild(doc);
    check('开放 线+弧 路径：求值成功', featureErrors(doc).length === 0, featureErrors(doc).join('; '));
    const len = 30 + 30 * (Math.PI / 2);
    const vExp = Math.PI * R * R * len;
    // 路径中间有 90° 尖角：放样在尖角处会"切角"，体积略小于 π r² L（已知限制）
    check('线+弧路径扫掠体积 ≈ π r² × 路径长（尖角切角 ≤12%）', nearRel(volOf(shape), vExp, 0.12), `${volOf(shape).toFixed(2)} vs ${vExp.toFixed(2)}`);
  }

  // 纯圆弧路径（无尖角）—— 验证弯曲路径的扫掠精度
  {
    const doc = mkSweepDoc(arcSketch(30, 120));
    const shape = rebuild(doc);
    check('纯圆弧路径：求值成功', featureErrors(doc).length === 0, featureErrors(doc).join('; '));
    const len = 30 * ((120 * Math.PI) / 180);
    const vExp = Math.PI * R * R * len;
    check('纯圆弧路径扫掠体积 ≈ π r² × 弧长', nearRel(volOf(shape), vExp, 0.03), `${volOf(shape).toFixed(2)} vs ${vExp.toFixed(2)}`);
  }

  // 闭环路径（回归：原本就支持）
  {
    const doc = mkSweepDoc(circleSketch(20));
    const shape = rebuild(doc);
    check('闭环路径（整圆）：求值成功', featureErrors(doc).length === 0, featureErrors(doc).join('; '));
    const vExp = 2 * Math.PI * Math.PI * 20 * R * R; // 环体 2π²Rr²
    check('闭环扫掠体积 ≈ 环体 2π²Rr²', nearRel(volOf(shape), vExp, 0.06), `${volOf(shape).toFixed(2)} vs ${vExp.toFixed(2)}`);
  }

  // 矩形截面（非圆截面，验证标架放置）
  {
    const d = new CadDocument();
    d.add(newSketchFeature('front', closedPolygonSketch([[0, 0], [6, 0], [6, 4], [0, 4]])) as Feature);
    d.add(newSketchFeature('front', lineChainSketch([[0, 0], [50, 0]])) as Feature);
    const [a, b] = d.features;
    d.add({ id: newId('f'), type: 'sweep', name: '扫描2', params: { profileSketchId: a.id, pathSketchId: b.id, operation: 'new' } } as SweepFeature);
    const shape = rebuild(d);
    check('矩形截面扫掠：求值成功', featureErrors(d).length === 0, featureErrors(d).join('; '));
    const vExp = 6 * 4 * 50;
    check('矩形截面扫掠体积 = 面积 × 长度', nearRel(volOf(shape), vExp, 0.03), `${volOf(shape).toFixed(2)} vs ${vExp.toFixed(2)}`);
  }
}

// ============================================================
console.log(`\n${'='.repeat(56)}`);
console.log(`曲线族测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
