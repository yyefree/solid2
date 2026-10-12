/**
 * 草图 → 实体 集成测试（需要 OCCT）。
 * 运行: node tools/run-ts.mjs tools/sketch-shape-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { tessellate } from '../src/core/mesh';
import { solveSketch } from '../src/sketch/solver';
import { emptySketch, newId, slotTemplate, DEFAULT_PLANE, type Sketch } from '../src/sketch/types';
import { sketchToRegions, regionToFace, sketchToFaces, advancedCurveEdge } from '../src/sketch/toShape';
import { sampleSketchPath } from '../src/sketch/curve';

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
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

const oc = await initOcctNode();
setOcct(oc);
console.log('内核已注入\n');

function mkPt(sk: Sketch, x: number, y: number) {
  const id = newId('p');
  sk.points[id] = { id, x, y };
  return id;
}
function mkLine(sk: Sketch, a: string, b: string) {
  const id = newId('e');
  sk.entities.push({ id, kind: 'line', a, b });
  return id;
}
function mkCircle(sk: Sketch, c: string, r: number) {
  const id = newId('e');
  sk.entities.push({ id, kind: 'circle', c, r });
  return id;
}
function mkArc(sk: Sketch, c: string, a: string, b: string, ccw: boolean) {
  const id = newId('e');
  sk.entities.push({ id, kind: 'arc', c, a, b, ccw });
  return id;
}
function mkEllipse(sk: Sketch, c: string, rx: number, ry: number, rot: number) {
  const id = newId('e');
  sk.entities.push({ id, kind: 'ellipse', c, rx, ry, rot });
  return id;
}

// ---------- 1. 矩形草图 → 面 → 拉伸 ----------
console.log('【矩形草图】');
{
  const sk = emptySketch();
  const p1 = mkPt(sk, 0, 0);
  const p2 = mkPt(sk, 40, 0);
  const p3 = mkPt(sk, 40, 25);
  const p4 = mkPt(sk, 0, 25);
  mkLine(sk, p1, p2);
  mkLine(sk, p2, p3);
  mkLine(sk, p3, p4);
  mkLine(sk, p4, p1);

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('识别 1 个区域', regions.length === 1, `${regions.length} 个`);
  check('区域为外轮廓', regions[0]?.isOuter === true);
  check('区域面积 = 1000', near(regions[0]?.area, 1000, 0.5), `= ${regions[0]?.area.toFixed(2)}`);

  const face = regionToFace(regions[0]);
  const solid = S.extrude(face, [0, 0, 1], 15);
  check('拉伸体积 = 15000', near(S.volume(solid), 15000, 0.5), `= ${S.volume(solid).toFixed(2)}`);
}

// ---------- 2. 带圆孔的板 ----------
console.log('\n【带圆孔的板】');
{
  const sk = emptySketch();
  const p1 = mkPt(sk, 0, 0);
  const p2 = mkPt(sk, 60, 0);
  const p3 = mkPt(sk, 60, 40);
  const p4 = mkPt(sk, 0, 40);
  mkLine(sk, p1, p2);
  mkLine(sk, p2, p3);
  mkLine(sk, p3, p4);
  mkLine(sk, p4, p1);
  const cc = mkPt(sk, 30, 20);
  mkCircle(sk, cc, 8);

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('识别 1 个区域（外轮廓 + 1 孔）', regions.length === 1, `${regions.length} 个`);
  check('孔数 = 1', regions[0]?.holes.length === 1, `${regions[0]?.holes.length} 个`);

  const face = regionToFace(regions[0]);
  const solid = S.extrude(face, [0, 0, 1], 10);
  const expect = (60 * 40 - Math.PI * 64) * 10;
  check('拉伸体积（含孔）', near(S.volume(solid), expect, 1), `= ${S.volume(solid).toFixed(2)} / 期望 ${expect.toFixed(2)}`);
}

// ---------- 3. 带约束的草图 ----------
console.log('\n【带约束的草图】');
{
  const sk = emptySketch();
  const p1 = mkPt(sk, 0, 0);
  const p2 = mkPt(sk, 33, 2);
  const p3 = mkPt(sk, 31, 21);
  const p4 = mkPt(sk, 1, 19);
  const l1 = mkLine(sk, p1, p2);
  const l2 = mkLine(sk, p2, p3);
  const l3 = mkLine(sk, p3, p4);
  const l4 = mkLine(sk, p4, p1);
  sk.points[p1].fixed = true;
  sk.constraints.push(
    { id: newId('c'), type: 'horizontal', e1: l1 },
    { id: newId('c'), type: 'horizontal', e1: l3 },
    { id: newId('c'), type: 'vertical', e1: l2 },
    { id: newId('c'), type: 'vertical', e1: l4 },
    { id: newId('c'), type: 'length', e1: l1, value: 50 },
    { id: newId('c'), type: 'length', e1: l2, value: 30 },
  );
  const st = solveSketch(sk);
  check('求解收敛', st.residual < 1e-6, `res=${st.residual.toExponential(2)}`);

  const solid = S.extrude(regionToFace(sketchToRegions(sk, DEFAULT_PLANE)[0]), [0, 0, 1], 8);
  check('约束驱动体积 = 50×30×8', near(S.volume(solid), 12000, 0.5), `= ${S.volume(solid).toFixed(2)}`);
}

// ---------- 4. 圆角矩形（直线 + 圆弧）----------
console.log('\n【直线 + 圆弧闭合轮廓】');
{
  const sk = emptySketch();
  // 矩形 40×20，右上角 R10 倒圆
  const p1 = mkPt(sk, 0, 0);
  const p2 = mkPt(sk, 40, 0);
  const p3 = mkPt(sk, 40, 10);
  const c1 = mkPt(sk, 30, 10); // 圆弧圆心
  const p4 = mkPt(sk, 30, 20);
  const p5 = mkPt(sk, 0, 20);

  mkLine(sk, p1, p2);
  mkLine(sk, p2, p3);
  mkArc(sk, c1, p3, p4, true); // 从 (40,10) 逆时针到 (30,20)
  mkLine(sk, p4, p5);
  mkLine(sk, p5, p1);

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('识别 1 个闭合区域', regions.length === 1, `${regions.length} 个`);
  if (regions.length) {
    const area = regions[0].area;
    // 矩形 40×20 去掉右上角直角补上 R10 圆弧：800 − 100 + π·100/4 = 778.54
    check('面积含圆弧', near(area, 778.54, 1), `= ${area.toFixed(2)} / 期望 778.54`);
    const face = regionToFace(regions[0]);
    const solid = S.extrude(face, [0, 0, 1], 5);
    check('拉伸体积 = 面积×5', near(S.volume(solid), 778.54 * 5, 2), `= ${S.volume(solid).toFixed(2)}`);
  }
}

// ---------- 5. 多区域（两个分离的圆）----------
console.log('\n【多区域】');
{
  const sk = emptySketch();
  const a = mkPt(sk, 0, 0);
  const b = mkPt(sk, 50, 0);
  mkCircle(sk, a, 10);
  mkCircle(sk, b, 5);
  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('识别 2 个独立区域', regions.length === 2, `${regions.length} 个`);
  const faces = sketchToFaces(sk, DEFAULT_PLANE);
  check('生成 2 个面', faces.length === 2, `${faces.length} 个`);
  // 注意：这里的面积是"内接多边形"近似值（用于嵌套判定），比精确值小约 0.6%
  const areas = regions.map((r) => r.area).sort((x, y) => x - y);
  check('面积近似 π·25 与 π·100', near(areas[0], Math.PI * 25, 1) && near(areas[1], Math.PI * 100, 2),
    `${areas.map((a2) => a2.toFixed(2)).join(', ')}`);
}

// ---------- 6. 不同草图平面 ----------
console.log('\n【草图平面】');
{
  const { TOP_PLANE, RIGHT_PLANE } = await import('../src/sketch/types');
  const sk = emptySketch();
  const p1 = mkPt(sk, 0, 0);
  const p2 = mkPt(sk, 20, 0);
  const p3 = mkPt(sk, 20, 20);
  const p4 = mkPt(sk, 0, 20);
  mkLine(sk, p1, p2);
  mkLine(sk, p2, p3);
  mkLine(sk, p3, p4);
  mkLine(sk, p4, p1);

  const top = S.extrude(regionToFace(sketchToRegions(sk, TOP_PLANE)[0]), TOP_PLANE.normal, 5);
  const bb = S.boundingBox(tessellate(top));
  check('上视基准面上拉伸（法向 +Y）', near(bb.max[1], 5, 0.01) && near(bb.max[0], 20, 0.01),
    `BBox max = [${bb.max.map((v) => v.toFixed(1)).join(', ')}]`);

  const right = S.extrude(regionToFace(sketchToRegions(sk, RIGHT_PLANE)[0]), RIGHT_PLANE.normal, 5);
  const bb2 = S.boundingBox(tessellate(right));
  check('右视基准面上拉伸（法向 +X）', near(bb2.max[0], 5, 0.01),
    `BBox max = [${bb2.max.map((v) => v.toFixed(1)).join(', ')}]`);
}

// ---------- 7. 椭圆 → 面 → 拉伸 ----------
console.log('\n【椭圆草图】');
{
  const sk = emptySketch();
  const c = mkPt(sk, 0, 0);
  mkEllipse(sk, c, 10, 5, 0);

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('椭圆自成一环，识别 1 个区域', regions.length === 1, `${regions.length} 个`);
  check('区域为外轮廓', regions[0]?.isOuter === true);
  // 精确椭圆边 ⇒ 面面积等于 π·a·b；但 regions[].area 是用于嵌套判定的内接多边形近似值，
  // 会比精确值略小（160 段内接多边形约 −0.03%），故容差取 0.1。
  const expectArea = Math.PI * 10 * 5;
  check('椭圆面面积 ≈ π·a·b（内接多边形近似）', near(regions[0]?.area, expectArea, 0.1),
    `= ${regions[0]?.area.toFixed(4)} / 期望 ${expectArea.toFixed(4)}`);

  const face = regionToFace(regions[0]);
  const solid = S.extrude(face, [0, 0, 1], 10);
  check('拉伸体积 = π·a·b·h', near(S.volume(solid), expectArea * 10, 0.5), `= ${S.volume(solid).toFixed(2)}`);
}

// ---------- 8. 旋转椭圆 ----------
console.log('\n【旋转椭圆】');
{
  const sk = emptySketch();
  const c = mkPt(sk, 0, 0);
  mkEllipse(sk, c, 12, 4, Math.PI / 2); // 长轴竖立

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('旋转椭圆仍识别 1 个区域', regions.length === 1, `${regions.length} 个`);
  check('旋转不改变面积（π·a·b，内接多边形近似）', near(regions[0]?.area, Math.PI * 12 * 4, 0.1),
    `= ${regions[0]?.area.toFixed(4)}`);
  const bb = S.boundingBox(tessellate(regionToFace(regions[0])));
  // 长轴竖立 ⇒ u 方向跨度 = 2·ry = 8，v 方向跨度 = 2·rx = 24
  check('包围盒：长轴竖立（u 跨 8、v 跨 24）',
    near(bb.max[0] - bb.min[0], 8, 0.05) && near(bb.max[1] - bb.min[1], 24, 0.05),
    `du=${(bb.max[0] - bb.min[0]).toFixed(2)} dv=${(bb.max[1] - bb.min[1]).toFixed(2)}`);
}

// ---------- 9. 直槽口 → 面 → 拉伸 ----------
console.log('\n【直槽口草图】');
{
  const sk = emptySketch();
  const tpl = slotTemplate([0, 0], [40, 0], 5)!;
  // tpl.points 顺序 [c1, c2, p1, p2, p3, p4]，直接为它们建点
  const ids = tpl.points.map(([x, y]) => mkPt(sk, x, y));
  for (const t of tpl.entities) {
    if (t.kind === 'line') mkLine(sk, ids[t.a], ids[t.b]);
    else mkArc(sk, ids[t.c], ids[t.a], ids[t.b], t.ccw);
  }

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('槽口闭合成 1 个区域', regions.length === 1, `${regions.length} 个`);
  const expectArea = 2 * 5 * 40 + Math.PI * 25; // 2rL + πr²
  // 两个半圆各按 24 段弦逼近，故区域面积（内接多边形）比精确值小约 0.5
  check('槽口面面积 ≈ 2rL + πr²', near(regions[0]?.area, expectArea, 1),
    `= ${regions[0]?.area.toFixed(3)} / 期望 ${expectArea.toFixed(3)}`);

  const solid = S.extrude(regionToFace(regions[0]), [0, 0, 1], 6);
  check('槽口拉伸体积', near(S.volume(solid), expectArea * 6, 2), `= ${S.volume(solid).toFixed(2)}`);
}

// ---------- 10. 草图点：不参与轮廓，可作孔心 ----------
console.log('\n【草图点】');
{
  // 矩形 + 内部独立点：点不应影响闭环识别
  const sk = emptySketch();
  const p1 = mkPt(sk, 0, 0);
  const p2 = mkPt(sk, 50, 0);
  const p3 = mkPt(sk, 50, 30);
  const p4 = mkPt(sk, 0, 30);
  mkLine(sk, p1, p2);
  mkLine(sk, p2, p3);
  mkLine(sk, p3, p4);
  mkLine(sk, p4, p1);
  const freePt = mkPt(sk, 25, 15);
  sk.entities.push({ id: newId('e'), kind: 'point', p: freePt });

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('独立点不影响闭环识别', regions.length === 1, `${regions.length} 个`);
  check('矩形面积仍为 1500', near(regions[0]?.area, 1500, 0.5), `= ${regions[0]?.area.toFixed(2)}`);

  // 点作为孔心：矩形 + 圆（圆心处放一个独立点，模拟异型孔向导的定位点）
  const sk2 = emptySketch();
  const q1 = mkPt(sk2, 0, 0);
  const q2 = mkPt(sk2, 60, 0);
  const q3 = mkPt(sk2, 60, 40);
  const q4 = mkPt(sk2, 0, 40);
  mkLine(sk2, q1, q2);
  mkLine(sk2, q2, q3);
  mkLine(sk2, q3, q4);
  mkLine(sk2, q4, q1);
  const hc = mkPt(sk2, 30, 20);
  mkCircle(sk2, hc, 6);
  sk2.entities.push({ id: newId('e'), kind: 'point', p: hc }); // 与孔心重合的定位点

  const r2 = sketchToRegions(sk2, DEFAULT_PLANE);
  check('带定位点的孔仍识别 1 个区域', r2.length === 1, `${r2.length} 个`);
  check('孔数 = 1', r2[0]?.holes.length === 1, `${r2[0]?.holes.length} 个`);
  const expect2 = (60 * 40 - Math.PI * 36) * 8;
  check('带定位点孔的拉伸体积正确', near(S.volume(S.extrude(regionToFace(r2[0]), [0, 0, 1], 8)), expect2, 1),
    `= ${S.volume(S.extrude(regionToFace(r2[0]), [0, 0, 1], 8)).toFixed(2)}`);
}

// ---------- 10. 闭合 B 样条 → 面 → 拉伸 ----------
console.log('\n【闭合 B 样条草图】');
{
  const R = 20;
  const N = 16;
  const sk = emptySketch();
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  sk.entities.push({ id: newId('e'), kind: 'bspline', pts, closed: true });

  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('闭合 B 样条识别 1 个区域', regions.length === 1, `${regions.length} 个`);
  const idealArea = Math.PI * R * R;
  check('区域面积 ≈ π·R²（内接多边形近似）',
    Math.abs(regions[0].area - idealArea) / idealArea < 0.02,
    `${regions[0].area.toFixed(2)} vs ${idealArea.toFixed(2)} (${((regions[0].area / idealArea - 1) * 100).toFixed(3)}%)`);

  const vol = S.volume(S.extrude(regionToFace(regions[0]), [0, 0, 1], 10));
  const idealVol = idealArea * 10;
  check('拉伸体积 ≈ π·R²·h（面是精确 B 样条）',
    Math.abs(vol - idealVol) / idealVol < 0.005,
    `${vol.toFixed(1)} mm³ vs ${idealVol.toFixed(1)} (${((vol / idealVol - 1) * 100).toFixed(3)}%)`);
}

// ---------- 11. 开放 B 样条不成环 ----------
console.log('\n【开放 B 样条】');
{
  const sk = emptySketch();
  sk.entities.push({
    id: newId('e'), kind: 'bspline',
    pts: [[0, 0], [10, 20], [30, -10], [50, 5]], closed: false,
  });
  const regions = sketchToRegions(sk, DEFAULT_PLANE);
  check('开放 B 样条不构成闭环', regions.length === 0, `${regions.length} 个`);
}

// ---------- 12. 抛物线边 + 弦 → 面 → 面积（解析值 T³/(3f)） ----------
console.log('\n【抛物线几何】');
{
  const focal = 5;
  const T = 10;
  const sk = emptySketch();
  const v = mkPt(sk, 0, 0);
  sk.entities.push({ id: newId('e'), kind: 'parabola', c: v, focal, rot: 0, t0: -T, t1: T });

  const edge = advancedCurveEdge(sk, sk.entities[0], DEFAULT_PLANE);
  check('抛物线边构造成功', !!edge);

  // 弦：从 (T²/(4f), T) 到 (T²/(4f), −T)
  const xEnd = (T * T) / (4 * focal);
  const o = oc as any;
  const chord = new o.BRepBuilderAPI_MakeEdge_3(
    new o.gp_Pnt_3(xEnd, T, 0),
    new o.gp_Pnt_3(xEnd, -T, 0)
  ).Edge();
  const mk = new o.BRepBuilderAPI_MakeWire_2(edge);
  mk.Add_1(chord);
  check('抛物线 + 弦 组成闭合线框', mk.IsDone());
  const face = new o.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();

  // 解析面积：∫_{-T}^{T} (T²/(4f) − y²/(4f)) dy = T³/(3f)
  const idealArea = (T * T * T) / (3 * focal);
  const props = new o.GProp_GProps_1();
  o.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const measured = props.Mass();
  check('抛物线围成面积 = T³/(3f)（精确边）',
    Math.abs(measured - idealArea) / idealArea < 1e-3,
    `${measured.toFixed(4)} vs ${idealArea.toFixed(4)}`);
}

// ---------- 13. 双曲线边构造 ----------
console.log('\n【双曲线几何】');
{
  const a = 8;
  const b = 5;
  const T = 1.2;
  const sk = emptySketch();
  const c = mkPt(sk, 0, 0);
  sk.entities.push({ id: newId('e'), kind: 'hyperbola', c, a, b, rot: 0, t0: -T, t1: T });
  const edge = advancedCurveEdge(sk, sk.entities[0], DEFAULT_PLANE);
  check('双曲线边构造成功', !!edge);

  const o = oc as any;
  const xEnd = a * Math.cosh(T);
  const yEnd = b * Math.sinh(T);
  const chord = new o.BRepBuilderAPI_MakeEdge_3(
    new o.gp_Pnt_3(xEnd, yEnd, 0),
    new o.gp_Pnt_3(xEnd, -yEnd, 0)
  ).Edge();
  const mk = new o.BRepBuilderAPI_MakeWire_2(edge);
  mk.Add_1(chord);
  check('双曲线 + 弦 组成闭合线框', mk.IsDone());
  const face = new o.BRepBuilderAPI_MakeFace_15(mk.Wire(), true).Face();

  // 解析面积：∫(a·coshT − a·√(1+(y/b)²)) dy = a·b·(sinh(2T)/2 − T)
  const idealArea = a * b * (Math.sinh(2 * T) / 2 - T);
  const props = new o.GProp_GProps_1();
  o.BRepGProp.SurfaceProperties_1(face, props, false, false);
  check('双曲线围成面积 = a·b·(sinh2T/2 − T)（精确边）',
    Math.abs(props.Mass() - idealArea) / idealArea < 1e-3,
    `${props.Mass().toFixed(4)} vs ${idealArea.toFixed(4)}`);
}

// ---------- 14. 高级曲线族可作为扫描路径 ----------
console.log('\n【高级曲线族 → 扫描路径】');
{
  // 抛物线路径
  const sk1 = emptySketch();
  const v = mkPt(sk1, 0, 0);
  sk1.entities.push({ id: newId('e'), kind: 'parabola', c: v, focal: 6, rot: 0, t0: -8, t1: 8 });
  const path1 = sampleSketchPath(sk1, DEFAULT_PLANE, 64);
  check('抛物线可被采样为扫描路径', path1.length > 10, `${path1.length} 个点`);
  check('路径起点 ≈ 抛物线 t=−8 端点',
    near(path1[0][0], (64 / 24), 1e-6) && near(path1[0][1], -8, 1e-6),
    `(${path1[0][0].toFixed(4)}, ${path1[0][1].toFixed(4)})`);

  // 开放 B 样条路径
  const sk2 = emptySketch();
  sk2.entities.push({
    id: newId('e'), kind: 'bspline',
    pts: [[0, 0], [15, 25], [35, -15], [50, 10]], closed: false,
  });
  const path2 = sampleSketchPath(sk2, DEFAULT_PLANE, 64);
  check('开放 B 样条可被采样为扫描路径', path2.length > 10, `${path2.length} 个点`);

  // 双曲线路径
  const sk3 = emptySketch();
  const c3 = mkPt(sk3, 0, 0);
  sk3.entities.push({ id: newId('e'), kind: 'hyperbola', c: c3, a: 10, b: 6, rot: 0, t0: -1.5, t1: 1.5 });
  const path3 = sampleSketchPath(sk3, DEFAULT_PLANE, 64);
  check('双曲线可被采样为扫描路径', path3.length > 10, `${path3.length} 个点`);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);