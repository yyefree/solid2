/**
 * 薄壁特征（旋转 / 扫描）测试 —— 第十五轮。
 *
 * 验证 `engine.ts` 的 `thinLoops3D` / `thinProfileFaces` 在 **旋转** 与 **扫描** 上的接入：
 *  - 旋转薄壁：开环轮廓（线段）→ 圆筒；闭环轮廓（矩形）→ 方管（环带旋转）
 *  - 扫描薄壁：闭环轮廓（圆）→ 中空管（外管 − 内管布尔）；开环轮廓（线段）→ 平板带
 *  - 错误处理：厚度 0
 *
 * 全部为**解析精确值**（Pappus 定理 / 面积 × 长度）。
 *
 * 运行: node tools/run-ts.mjs tools/thin-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument, newSketchFeature } from '../src/doc/model';
import { rebuildFeatures } from '../src/doc/engine';
import { emptySketch, newId, type Sketch } from '../src/sketch/types';
import type { RevolveFeature, SweepFeature, FeatureId, ThinSpec } from '../src/doc/types';

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

const oc = await initOcctNode();
setOcct(oc);
console.log('内核已注入\n');

function rebuild(d: CadDocument): any {
  const { shape, errors } = rebuildFeatures(d.features);
  for (const f of d.features) f.error = undefined;
  for (const e of errors) {
    const f = d.getFeature(e.id);
    if (f) f.error = e.message;
  }
  return shape;
}

// ---------- 草图构造 ----------
function mkSketch(points: [number, number][], edges: (id: string[]) => any[]): Sketch {
  const sk = emptySketch();
  const ids = points.map(([x, y]) => {
    const id = newId('p');
    sk.points[id] = { id, x, y };
    return id;
  });
  sk.entities.push(...edges(ids));
  return sk;
}
/** 闭合矩形（逆时针） */
function rectSketch(x0: number, y0: number, x1: number, y1: number): Sketch {
  return mkSketch([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], (ids) =>
    ids.map((a, i) => ({ id: newId('e'), kind: 'line', a, b: ids[(i + 1) % 4] })));
}
/** 开放折线 */
function polylineSketch(pts: [number, number][]): Sketch {
  return mkSketch(pts, (ids) =>
    ids.slice(0, -1).map((a, i) => ({ id: newId('e'), kind: 'line', a, b: ids[i + 1] })));
}
/** 整圆 */
function circleSketch(cx: number, cy: number, r: number): Sketch {
  const sk = emptySketch();
  const cid = newId('p');
  sk.points[cid] = { id: cid, x: cx, y: cy };
  sk.entities.push({ id: newId('e'), kind: 'circle', c: cid, r });
  return sk;
}
function addSketch(d: CadDocument, sk: Sketch): FeatureId {
  const sf = newSketchFeature('front', sk);
  d.add(sf);
  return sf.id;
}

/** 旋转（可带薄壁），轴取草图 v 轴 */
function revolveDoc(sk: Sketch, angleDeg: number, thin?: ThinSpec): { shape: any; d: CadDocument } {
  const d = new CadDocument();
  const sid = addSketch(d, sk);
  const f: RevolveFeature = {
    id: newId('f'), type: 'revolve', name: '旋转1',
    params: { sketchId: sid, axisA: [0, 0], axisB: [0, 10], angleDeg, operation: 'new', thin },
  };
  d.add(f);
  return { shape: rebuild(d), d };
}

/** 扫描（可带薄壁）：轮廓 + 路径都在 front 平面 */
function sweepDoc(prof: Sketch, path: Sketch, thin?: ThinSpec): { shape: any; d: CadDocument } {
  const d = new CadDocument();
  const pid = addSketch(d, prof);
  const qid = addSketch(d, path);
  const f: SweepFeature = {
    id: newId('f'), type: 'sweep', name: '扫描1',
    params: { profileSketchId: pid, pathSketchId: qid, operation: 'new', thin },
  };
  d.add(f);
  return { shape: rebuild(d), d };
}

// ============================================================
// 1. 旋转薄壁：开环线段 → 圆筒
// ============================================================
console.log('【旋转薄壁 · 开环轮廓（竖直线段 x=10, y∈[0,10]）→ 圆筒】');
{
  // 基准：无薄壁时是薄片，体积 ≈ 0
  const { shape: flat } = revolveDoc(polylineSketch([[10, 0], [10, 10]]), 360);
  check('开环线段无薄壁 → 旋转不出实体（体积≈0）', S.solidVolume(flat) < 1e-3, `= ${S.solidVolume(flat).toFixed(4)}`);

  // 两侧对称厚 2 → 壁面 r ∈ [9, 11]，高 10 → π(11²−9²)·10 = 400π
  const { shape } = revolveDoc(polylineSketch([[10, 0], [10, 10]]), 360, { type: 'midPlane', thickness: 2 });
  const expect = Math.PI * (11 * 11 - 9 * 9) * 10; // 400π ≈ 1256.64
  check('两侧对称厚 2 → 圆筒体积 = π(11²−9²)·10', near(S.volume(shape), expect, 0.5), `= ${S.volume(shape).toFixed(3)} / 期望 ${expect.toFixed(3)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);
  const bb = S.shapeBBox(shape);
  check('半径方向 x ∈ [-11, 11]', near(bb.min[0], -11, 0.05) && near(bb.max[0], 11, 0.05), `[${bb.min[0].toFixed(2)}, ${bb.max[0].toFixed(2)}]`);

  // 单侧厚 2 → 壁面 r ∈ [10, 12] → π(12²−10²)·10 = 440π
  const { shape: s2 } = revolveDoc(polylineSketch([[10, 0], [10, 10]]), 360, { type: 'oneSide', thickness: 2 });
  const exp2 = Math.PI * (12 * 12 - 10 * 10) * 10; // 440π
  check('单向厚 2 → 圆筒体积 = π(12²−10²)·10', near(S.volume(s2), exp2, 0.5), `= ${S.volume(s2).toFixed(3)} / 期望 ${exp2.toFixed(3)}`);
}

// ============================================================
// 2. 旋转薄壁：闭环矩形 → 方管（环带旋转）
// ============================================================
console.log('\n【旋转薄壁 · 闭环轮廓（矩形 x∈[10,20], y∈[0,10]）→ 方管】');
{
  // 基准：实心环柱 = π(20²−10²)·10 = 3000π
  const { shape: solid } = revolveDoc(rectSketch(10, 0, 20, 10), 360);
  const base = Math.PI * (20 * 20 - 10 * 10) * 10;
  check('无薄壁 → 实心环柱 3000π', near(S.volume(solid), base, 1), `= ${S.volume(solid).toFixed(2)} / 期望 ${base.toFixed(2)}`);

  // 单向厚 2：外环 π(22²−8²)·14 − 内环 π(20²−10²)·10 = 2880π
  const { shape } = revolveDoc(rectSketch(10, 0, 20, 10), 360, { type: 'oneSide', thickness: 2 });
  const expect = Math.PI * (22 * 22 - 8 * 8) * 14 - Math.PI * (20 * 20 - 10 * 10) * 10; // 2880π
  check('单向厚 2 → 方管体积 = 外环 − 内环 = 2880π', near(S.volume(shape), expect, 1), `= ${S.volume(shape).toFixed(2)} / 期望 ${expect.toFixed(2)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);

  // 两侧对称厚 2：外 π(21²−9²)·12 − 内 π(19²−11²)·8 = 2400π
  const { shape: s2 } = revolveDoc(rectSketch(10, 0, 20, 10), 360, { type: 'midPlane', thickness: 2 });
  const exp2 = Math.PI * (21 * 21 - 9 * 9) * 12 - Math.PI * (19 * 19 - 11 * 11) * 8;
  check('两侧对称厚 2 → 方管体积 = 2400π', near(S.volume(s2), exp2, 1), `= ${S.volume(s2).toFixed(2)} / 期望 ${exp2.toFixed(2)}`);
}

// ============================================================
// 3. 扫描薄壁：闭环圆轮廓 → 中空管
// ============================================================
console.log('\n【扫描薄壁 · 闭环轮廓（Φ20 圆）沿直线路径长 60 → 中空管】');
{
  const path = polylineSketch([[0, 0], [60, 0]]);
  // 基准：实心圆柱 r=10 长 60（多边形逼近）→ π·100·60
  const { shape: solid } = sweepDoc(circleSketch(0, 0, 10), path);
  const base = Math.PI * 100 * 60;
  check('无薄壁 → 实心圆柱 ≈ π·10²·60（±2%）', Math.abs(S.volume(solid) - base) / base < 0.02, `= ${S.volume(solid).toFixed(1)} / 解析 ${base.toFixed(1)}`);

  // 两侧对称厚 2 → 中空管，壁面 r ∈ [9,11] → 40π × 60
  const { shape } = sweepDoc(circleSketch(0, 0, 10), path, { type: 'midPlane', thickness: 2 });
  const expect = Math.PI * (11 * 11 - 9 * 9) * 60; // 2400π ≈ 7539.8
  check('两侧对称厚 2 → 中空管 ≈ π(11²−9²)·60（±2%）', Math.abs(S.volume(shape) - expect) / expect < 0.02, `= ${S.volume(shape).toFixed(1)} / 解析 ${expect.toFixed(1)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);
  check('确实是中空（体积 < 实心圆柱）', S.volume(shape) < S.volume(solid) * 0.5, `薄壁 ${S.volume(shape).toFixed(1)} vs 实心 ${S.volume(solid).toFixed(1)}`);

  // 单向厚 3 → 壁面 r ∈ [10,13] → π(13²−10²)·60
  const { shape: s3 } = sweepDoc(circleSketch(0, 0, 10), path, { type: 'oneSide', thickness: 3 });
  const exp3 = Math.PI * (13 * 13 - 10 * 10) * 60;
  check('单向厚 3 → 中空管 ≈ π(13²−10²)·60（±2%）', Math.abs(S.volume(s3) - exp3) / exp3 < 0.02, `= ${S.volume(s3).toFixed(1)} / 解析 ${exp3.toFixed(1)}`);
}

// ============================================================
// 4. 扫描薄壁：开环轮廓 → 平板带
// ============================================================
console.log('\n【扫描薄壁 · 开环轮廓（竖直线段长 20）沿直线路径长 60 → 平板带】');
{
  const prof = polylineSketch([[0, -10], [0, 10]]); // 开放线段，长 20
  const path = polylineSketch([[0, 0], [60, 0]]);
  // 两侧对称厚 2 → 带宽 2、长 20，扫掠 60 → 2×20×60 = 2400
  const { shape } = sweepDoc(prof, path, { type: 'midPlane', thickness: 2 });
  check('两侧对称厚 2 → 平板带体积 2×20×60 = 2400', near(S.volume(shape), 2400, 2), `= ${S.volume(shape).toFixed(2)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);
}

// ============================================================
// 5. 错误处理
// ============================================================
console.log('\n【错误处理】');
{
  const { d: d1 } = revolveDoc(rectSketch(10, 0, 20, 10), 360, { type: 'midPlane', thickness: 0 });
  const e1 = d1.features.find((x) => x.type === 'revolve')?.error ?? '';
  check('旋转薄壁厚度 0 → 报错', /厚度必须大于 0/.test(e1), e1);

  const { d: d2 } = sweepDoc(circleSketch(0, 0, 10), polylineSketch([[0, 0], [60, 0]]), { type: 'midPlane', thickness: 0 });
  const e2 = d2.features.find((x) => x.type === 'sweep')?.error ?? '';
  check('扫描薄壁厚度 0 → 报错', /厚度必须大于 0/.test(e2), e2);
}

console.log(`\n薄壁特征（旋转/扫描）单测：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
