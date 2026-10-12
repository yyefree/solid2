/**
 * 特征测试：异型孔向导（孔）+ 参考基准面。
 *
 * 这两个特征此前只在 `src/doc/types.ts` 里有类型声明，引擎与 UI 都未实现；
 * 本测试驱动 `rebuildFeatures()` 验证几何结果。
 *
 * 运行: node tools/run-ts.mjs tools/features-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument, newSketchFeature, PLANES, planeFromFace, offsetPlane, parallelPlane, perpendicularPlane, angledPlane, rotateAbout, makeFaceRef } from '../src/doc/model';
import { rebuildFeatures, buildMeshResult } from '../src/doc/engine';
import { faceInfos } from '../src/doc/topo';
import { buildRibProfile, offsetRibbon } from '../src/sketch/rib';
import { emptySketch, newId, type Sketch } from '../src/sketch/types';
import type { Feature, FeatureId, HoleFeature, DraftFeature, RibFeature } from '../src/doc/types';

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

function rebuild(doc: CadDocument, upto?: FeatureId): any {
  const { shape, errors } = rebuildFeatures(doc.features, upto);
  for (const f of doc.features) f.error = undefined;
  for (const e of errors) {
    const f = doc.getFeature(e.id);
    if (f) f.error = e.message;
  }
  return shape;
}

function rectSketch(w: number, h: number): Sketch {
  const sk = emptySketch();
  const pts = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map(([x, y]) => {
    const id = newId('p');
    sk.points[id] = { id, x, y };
    return id;
  });
  for (let i = 0; i < 4; i++) {
    sk.entities.push({ id: newId('e'), kind: 'line', a: pts[i], b: pts[(i + 1) % 4] });
  }
  return sk;
}

// 40 × 25 × 10 长方体，顶面质心 (20, 12.5, 10)，法向 +Z
const BOX_VOL = 40 * 25 * 10; // 10000
function boxDoc(): CadDocument {
  const d = new CadDocument();
  const box: Feature = {
    id: newId('f'),
    type: 'primitive',
    name: '基本体1',
    params: { kind: 'box', dims: [40, 25, 10], operation: 'new' },
  };
  d.add(box);
  return d;
}
const TOP_PLANE_FACE = planeFromFace([20, 12.5, 10], [0, 0, 1]);

function holeDoc(p: Partial<HoleFeature['params']>): CadDocument {
  const d = boxDoc();
  const hole: HoleFeature = {
    id: newId('f'),
    type: 'hole',
    name: '孔1',
    params: {
      plane: TOP_PLANE_FACE,
      pos: [0, 0],
      type: 'simple',
      diameter: 6,
      depth: 10,
      through: true,
      ...p,
    },
  };
  d.add(hole);
  return d;
}

// ---------- 1. 平面辅助 ----------
console.log('【基准面辅助】');
{
  const pl = planeFromFace([20, 12.5, 10], [0, 0, 1]);
  check('平面上原点正确', near(pl.origin[0], 20) && near(pl.origin[2], 10));
  check('法向归一化', near(Math.hypot(...pl.normal), 1, 1e-9));
  // 正交：u·v = u·n = v·n = 0
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  check('局部基正交', near(dot(pl.u, pl.v), 0, 1e-9) && near(dot(pl.u, pl.normal), 0, 1e-9));
  const off = offsetPlane(PLANES.front, 20);
  check('沿法向偏移', near(off.origin[2], 20) && near(off.normal[2], 1));
}

// ---------- 2. 简单孔 ----------
console.log('\n【异型孔 · 简单孔】');
{
  const d = holeDoc({ through: true });
  const v = S.volume(rebuild(d));
  const expect = BOX_VOL - Math.PI * 9 * 10;
  check('通孔体积', near(v, expect, 1), `= ${v.toFixed(2)} / 期望 ${expect.toFixed(2)}`);
  check('无错误', d.features.every((f) => !f.error), d.features.map((f) => f.error).filter(Boolean).join('; '));

  const d2 = holeDoc({ through: false, depth: 4 });
  const v2 = S.volume(rebuild(d2));
  const expect2 = BOX_VOL - Math.PI * 9 * 4;
  check('盲孔体积', near(v2, expect2, 1), `= ${v2.toFixed(2)} / 期望 ${expect2.toFixed(2)}`);
}

// ---------- 2b. 孔心定位（U/V 偏移） ----------
console.log('\n【异型孔 · 位置 U/V】');
{
  // 偏置仍在面内：体积不变（仍是完整圆柱）
  const d = holeDoc({ pos: [8, 0], through: true });
  const v = S.volume(rebuild(d));
  check('偏置孔（域内）体积不变', near(v, BOX_VOL - Math.PI * 9 * 10, 1), `= ${v.toFixed(2)}`);
  check('偏置孔无错误', d.features.every((f) => !f.error));

  // 偏置盲孔使质心偏移 → 证明 pos 真正生效
  const dc = holeDoc({ pos: [8, 0], through: false, depth: 5 });
  const c = S.massProperties(rebuild(dc)).centroid;
  const shift = Math.hypot(c[0] - 20, c[1] - 12.5);
  check('偏置使质心偏移', shift > 0.05, `shift = ${shift.toFixed(3)} mm`);

  // 居中盲孔质心应在长方体中心（z 略偏）
  const d0 = holeDoc({ pos: [0, 0], through: false, depth: 5 });
  const c0 = S.massProperties(rebuild(d0)).centroid;
  check('居中孔质心 x/y 不变', near(c0[0], 20, 0.02) && near(c0[1], 12.5, 0.02), `(${c0[0].toFixed(2)}, ${c0[1].toFixed(2)})`);
}

// ---------- 3. 柱形沉头孔 ----------
console.log('\n【异型孔 · 柱形沉头孔】');
{
  const d = holeDoc({ type: 'counterbore', boreDiameter: 10, boreDepth: 3 });
  const v = S.volume(rebuild(d));
  // 主孔 90π + 沉头环 ((25π-9π)*3)
  const expect = BOX_VOL - (Math.PI * 9 * 10 + Math.PI * 16 * 3);
  check('沉头孔体积', near(v, expect, 1), `= ${v.toFixed(2)} / 期望 ${expect.toFixed(2)}`);
}

// ---------- 4. 锥形沉头孔 ----------
console.log('\n【异型孔 · 锥形沉头孔】');
{
  const d = holeDoc({ type: 'countersink', sinkDiameter: 12, sinkDepth: 3 });
  const v = S.volume(rebuild(d));
  // 主孔 90π + 圆台 π*3/3*(36+18+9) = 126π
  const expect = BOX_VOL - 126 * Math.PI;
  check('锥沉孔体积', near(v, expect, 1), `= ${v.toFixed(2)} / 期望 ${expect.toFixed(2)}`);
}

// ---------- 5. 基准面 + 草图 + 拉伸 ----------
console.log('\n【基准面 → 草图 → 拉伸】');
{
  const d = new CadDocument();
  const plane = offsetPlane(PLANES.front, 20); // z = 20 平面
  const rp: Feature = {
    id: newId('f'),
    type: 'referencePlane',
    name: '基准面1',
    params: { kind: 'offset', plane, distance: 20 },
  };
  d.add(rp);

  const skf = newSketchFeature('custom', rectSketch(20, 10));
  skf.params.customPlane = plane;
  skf.name = '草图1';
  d.add(skf);

  const ex: Feature = {
    id: newId('f'),
    type: 'extrude',
    name: '拉伸1',
    params: { sketchId: skf.id, distance: 5, operation: 'new' },
  };
  d.add(ex);

  const shape = rebuild(d);
  check('无错误', d.features.every((f) => !f.error), d.features.map((f) => f.error).filter(Boolean).join('; '));
  const v = S.volume(shape);
  check('在偏移面上拉伸体积', near(v, 20 * 10 * 5, 1), `= ${v.toFixed(2)} / 期望 1000`);
  const c = S.massProperties(shape).centroid;
  check('位于 z=[20,25]', near(c[2], 22.5, 0.05), `z = ${c[2].toFixed(3)}`);
}

// ---------- 6. 孔阵列（复用工具实体） ----------
console.log('\n【孔 + 线性阵列】');
{
  const d = boxDoc();
  const hole: HoleFeature = {
    id: newId('f'),
    type: 'hole',
    name: '孔1',
    params: { plane: TOP_PLANE_FACE, pos: [-8, 0], type: 'simple', diameter: 4, depth: 10, through: true },
  };
  d.add(hole);
  const pat: Feature = {
    id: newId('f'),
    type: 'linearPattern',
    name: '线性阵列1',
    params: { seedFeatureId: hole.id, direction: [1, 0, 0], spacing: 16, count: 2 },
  };
  d.add(pat);
  const v = S.volume(rebuild(d));
  // 两个 Φ4 通孔
  const expect = BOX_VOL - 2 * Math.PI * 4 * 10;
  check('两个孔体积', near(v, expect, 1), `= ${v.toFixed(2)} / 期望 ${expect.toFixed(2)}`);
}

// ---------- 7. 拔模 ----------
console.log('\n【拔模】');
{
  const d = boxDoc(); // 40×25×10，底面 z=0
  const shape = rebuild(d);
  const infos = faceInfos(shape);
  const bottom = infos.find((i) => i.normal[2] < -0.99)!;
  const sides = infos.filter((i) => Math.abs(i.normal[2]) < 1e-6);
  check('找到底面与 4 个侧面', !!bottom && sides.length === 4, `sides=${sides.length}`);
  const draft: DraftFeature = {
    id: newId('f'),
    type: 'draft',
    name: '拔模1',
    params: {
      neutralFace: { point: bottom.centroid, normal: bottom.normal },
      draftFaces: sides.map(makeFaceRef),
      angleDeg: 5,
      reverse: false,
    },
  };
  d.add(draft);
  const vGrow = S.volume(rebuild(d));
  check('拔模无错误', !draft.error, draft.error ?? '');
  check('正向拔模体积增大', vGrow > BOX_VOL, `${BOX_VOL} → ${vGrow.toFixed(1)}`);
  (draft.params as any).reverse = true;
  const vShrink = S.volume(rebuild(d));
  check('反向拔模体积减小', vShrink < BOX_VOL, `${BOX_VOL} → ${vShrink.toFixed(1)}`);
  check('正反拔模体积不等', Math.abs(vGrow - vShrink) > 100, `${vGrow.toFixed(1)} vs ${vShrink.toFixed(1)}`);
}

// ---------- 8. 筋 ----------
console.log('\n【筋（开口轮廓加厚）】');
{
  // 纯几何：10 长直线、厚 2 → 面积 20
  const straight = offsetRibbon([[0, 0], [10, 0]], 2);
  const area = (poly: [number, number][]) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      s += x1 * y2 - x2 * y1;
    }
    return Math.abs(s) / 2;
  };
  check('直线加厚成矩形（面积 20）', near(area(straight), 20, 1e-6), `= ${area(straight)}`);

  const closed = emptySketch();
  {
    const ids = [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => {
      const id = newId('p');
      closed.points[id] = { id, x, y };
      return id;
    });
    for (let i = 0; i < 4; i++) closed.entities.push({ id: newId('e'), kind: 'line', a: ids[i], b: ids[(i + 1) % 4] });
  }
  check('闭环草图不适用筋', buildRibProfile(closed, 2) === null);

  // 集成：底板 20×20×2 + 竖直筋（x=5, y 0→10, 厚 2, 深 6）
  const d = new CadDocument();
  d.add({ id: newId('f'), type: 'primitive', name: '底板', params: { kind: 'box', dims: [20, 20, 2], operation: 'new' } } as Feature);
  const ribSketch = emptySketch();
  {
    const a = newId('p');
    const b = newId('p');
    ribSketch.points[a] = { id: a, x: 5, y: 0 };
    ribSketch.points[b] = { id: b, x: 5, y: 10 };
    ribSketch.entities.push({ id: newId('e'), kind: 'line', a, b });
  }
  const skf = newSketchFeature('front', ribSketch);
  skf.name = '筋草图';
  d.add(skf);
  const rib: RibFeature = {
    id: newId('f'),
    type: 'rib',
    name: '筋1',
    params: { sketchId: skf.id, thickness: 2, depth: 6 },
  };
  d.add(rib);
  const v = S.volume(rebuild(d));
  // 底板 800 + 筋露出部分 2×10×4(=80)（z 0..2 与底板重叠）
  check('筋无错误', !rib.error, rib.error ?? '');
  check('筋并集体积', near(v, 880, 2), `= ${v.toFixed(2)} / 期望 880`);
}

// ---------- 9. 面/边几何元数据（供装配拾取：平面/圆柱/圆/直线）----------
console.log('\n【面/边几何元数据】');
{
  // 40×25×10 板上打 Φ6 通孔，孔心在顶面质心 (20,12.5)
  const d = holeDoc({ diameter: 6, through: true });
  const shape = rebuild(d);
  const mr = buildMeshResult(shape);

  const cyls = mr.faceMetas.filter((m) => m.surfaceType === 'cylinder');
  check('识别出圆柱面', cyls.length === 1, `= ${cyls.length}`);
  const cyl = cyls[0];
  if (cyl) {
    check('圆柱面有轴线', !!cyl.axis, cyl.axis ? `dir=(${cyl.axis.dir.map((v) => v.toFixed(2)).join(',')})` : '');
    check('圆柱半径 ≈ 3', near(cyl.radius ?? 0, 3, 1e-3), `= ${(cyl.radius ?? 0).toFixed(3)}`);
    if (cyl.axis) {
      check('轴线通过孔心', near(cyl.axis.point[0], 20, 1e-3) && near(cyl.axis.point[1], 12.5, 1e-3),
        `(${cyl.axis.point.map((v) => v.toFixed(2)).join(',')})`);
      check('轴线方向 ∥ Z', Math.abs(Math.abs(cyl.axis.dir[2]) - 1) < 1e-6);
    }
  }

  const planes = mr.faceMetas.filter((m) => m.surfaceType === 'plane');
  check('识别平面面', planes.length >= 6, `= ${planes.length}`);

  const circles = mr.edgeMetas.filter((m) => m.curveType === 'circle');
  check('识别圆边（上下孔口）', circles.length >= 2, `= ${circles.length}`);
  const cr = circles[0];
  if (cr) {
    check('圆边有轴线与半径', !!cr.axis && near(cr.radius ?? 0, 3, 1e-2),
      cr.axis ? `R=${(cr.radius ?? 0).toFixed(2)} dir=(${cr.axis.dir.map((v) => v.toFixed(2)).join(',')})` : '');
    if (cr.axis) check('圆边中心在孔轴上', near(cr.axis.point[0], 20, 1e-2) && near(cr.axis.point[1], 12.5, 1e-2));
  }

  const lines = mr.edgeMetas.filter((m) => m.curveType === 'line');
  check('识别直线边', lines.length >= 4, `= ${lines.length}`);
  const ln = lines[0];
  if (ln) {
    const e = ln.endpoints;
    const len = e ? Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1], e[1][2] - e[0][2]) : 0;
    check('直线边端点长度吻合', !!e && near(len, ln.length, 1e-2), `= ${len.toFixed(2)} vs ${ln.length.toFixed(2)}`);
  }
}

// ---------- 10. 基准面：平行 / 垂直 / 成角度（纯数学） ----------
console.log('\n【基准面 · 平行/垂直/成角度】');
{
  const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len3 = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
  const orthonormal = (p: { u: number[]; v: number[]; normal: number[] }) =>
    near(dot3(p.u, p.v), 0, 1e-9) &&
    near(dot3(p.u, p.normal), 0, 1e-9) &&
    near(dot3(p.v, p.normal), 0, 1e-9) &&
    near(len3(p.u), 1, 1e-9) && near(len3(p.v), 1, 1e-9) && near(len3(p.normal), 1, 1e-9);

  const base = PLANES.front; // 法向 +Z

  const par = parallelPlane(base, [3, 4, 7]);
  check('平行面：法向与基准一致', near(dot3(par.normal, base.normal), 1, 1e-9));
  check('平行面：过指定点 (3,4,7)', near(par.origin[0], 3) && near(par.origin[1], 4) && near(par.origin[2], 7));
  check('平行面：正交基', orthonormal(par));

  const perp = perpendicularPlane(base, 'u');
  check('垂直面：法向 ⊥ 基准法向', near(dot3(perp.normal, base.normal), 0, 1e-9), `n=(${perp.normal.map((v) => v.toFixed(2)).join(',')})`);
  check('垂直面：正交基', orthonormal(perp));

  const ang = angledPlane(base, 30, 'u');
  const angDeg = (Math.acos(Math.max(-1, Math.min(1, dot3(ang.normal, base.normal)))) * 180) / Math.PI;
  check('成角度面：法向夹角 = 30°', near(angDeg, 30, 1e-6), `= ${angDeg.toFixed(4)}°`);
  check('成角度面：正交基', orthonormal(ang));
  check('成角度面：旋转轴保留为局部 U', near(dot3(ang.u, base.u), 1, 1e-9));

  const r = rotateAbout([1, 0, 0], [0, 0, 1], Math.PI / 2);
  check('Rodrigues 绕 Z 转 90°: +X → +Y', near(r[0], 0, 1e-9) && near(r[1], 1, 1e-9) && near(r[2], 0, 1e-9), `= (${r.map((v) => v.toFixed(2)).join(',')})`);
}

// ---------- 11. 垂直基准面上的草图 → 拉伸（集成） ----------
console.log('\n【垂直基准面 → 草图 → 拉伸】');
{
  const d = new CadDocument();
  const perp = perpendicularPlane(PLANES.front, 'u'); // 法向 -Y
  d.add({ id: newId('f'), type: 'referencePlane', name: '基准面1', params: { kind: 'perpendicular', plane: perp, axis: PLANES.front.u } } as Feature);
  const skf = newSketchFeature('custom', rectSketch(20, 10));
  skf.params.customPlane = perp;
  skf.name = '草图1';
  d.add(skf);
  d.add({ id: newId('f'), type: 'extrude', name: '拉伸1', params: { sketchId: skf.id, distance: 5, operation: 'new' } } as Feature);
  const shape = rebuild(d);
  check('垂直面拉伸：无错误', d.features.every((f) => !f.error), d.features.map((f) => f.error).filter(Boolean).join('; '));
  check('垂直面拉伸：体积 1000', near(S.volume(shape), 1000, 1), `= ${S.volume(shape).toFixed(2)}`);
  const c = S.massProperties(shape).centroid;
  check('垂直面拉伸：质心 x≈10, z≈5', near(c[0], 10, 0.05) && near(c[2], 5, 0.05), `(${c.map((v) => v.toFixed(2)).join(',')})`);
}

// ---------- 12. 螺纹孔 & 侧面钻孔 ----------
console.log('\n【异型孔 · 螺纹孔 / 侧面】');
{
  // 螺纹孔几何 = 标称直径光孔（与简单孔同体积）
  const dT = holeDoc({ type: 'threaded', through: true });
  const vT = S.volume(rebuild(dT));
  const dS = holeDoc({ type: 'simple', through: true });
  const vS = S.volume(rebuild(dS));
  check('螺纹孔体积 = 简单孔体积', near(vT, vS, 1e-6), `${vT.toFixed(2)} vs ${vS.toFixed(2)}`);
  check('螺纹孔无错误', dT.features.every((f) => !f.error));

  // 侧面钻孔：在 +X 面（质心 (40,12.5,5)，法向 +X）钻 Φ6 通孔 → 沿 X 贯穿 40
  const dSide = boxDoc();
  const sidePlane = planeFromFace([40, 12.5, 5], [1, 0, 0]);
  dSide.add({
    id: newId('f'), type: 'hole', name: '孔1',
    params: { plane: sidePlane, pos: [0, 0], type: 'simple', diameter: 6, depth: 10, through: true },
  } as HoleFeature);
  const vSide = S.volume(rebuild(dSide));
  const expectSide = BOX_VOL - Math.PI * 9 * 40;
  check('侧面通孔体积', near(vSide, expectSide, 1), `= ${vSide.toFixed(2)} / 期望 ${expectSide.toFixed(2)}`);
  check('侧面钻孔无错误', dSide.features.every((f) => !f.error), dSide.features.map((f) => f.error).filter(Boolean).join('; '));
}

// ---------- 13. 筋：对称拉伸 ----------
console.log('\n【筋 · 对称拉伸】');
{
  const mk = (symmetric: boolean) => {
    const d = new CadDocument();
    d.add({ id: newId('f'), type: 'primitive', name: '底板', params: { kind: 'box', dims: [20, 20, 2], operation: 'new' } } as Feature);
    const sk = emptySketch();
    const a = newId('p');
    const b = newId('p');
    sk.points[a] = { id: a, x: 5, y: 0 };
    sk.points[b] = { id: b, x: 5, y: 10 };
    sk.entities.push({ id: newId('e'), kind: 'line', a, b });
    const skf = newSketchFeature('front', sk);
    skf.name = '筋草图';
    d.add(skf);
    d.add({ id: newId('f'), type: 'rib', name: '筋1', params: { sketchId: skf.id, thickness: 2, depth: 6, symmetric } } as RibFeature);
    return d;
  };
  const dSym = mk(true);
  const shapeSym = rebuild(dSym);
  check('对称筋：无错误', dSym.features.every((f) => !f.error), dSym.features.map((f) => f.error).filter(Boolean).join('; '));
  const vSym = S.volume(shapeSym);
  check('对称筋：并集体积 880', near(vSym, 880, 2), `= ${vSym.toFixed(2)}`);
  const cSym = S.massProperties(shapeSym).centroid;
  const dOne = mk(false);
  const cOne = S.massProperties(rebuild(dOne)).centroid;
  check('对称筋使质心低于单向筋', cSym[2] < cOne[2] - 0.05, `sym z=${cSym[2].toFixed(3)} vs one z=${cOne[2].toFixed(3)}`);
}

// ---------- 14. 对称拉伸（总长居中） ----------
console.log('\n【对称拉伸】');
{
  const d = new CadDocument();
  const skf = newSketchFeature('front', rectSketch(20, 10));
  skf.name = '草图1';
  d.add(skf);
  d.add({ id: newId('f'), type: 'extrude', name: '拉伸1', params: { sketchId: skf.id, distance: 6, symmetric: true, operation: 'new' } } as Feature);
  const shape = rebuild(d);
  check('对称拉伸：无错误', d.features.every((f) => !f.error), d.features.map((f) => f.error).filter(Boolean).join('; '));
  check('对称拉伸：体积 = 20×10×6', near(S.volume(shape), 1200, 1), `= ${S.volume(shape).toFixed(2)}`);
  const c = S.massProperties(shape).centroid;
  check('对称拉伸：居中（质心 z ≈ 0）', near(c[2], 0, 1e-3), `z = ${c[2].toFixed(4)}`);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);