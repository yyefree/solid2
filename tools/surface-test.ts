/**
 * 曲面特征测试：拉伸曲面 / 旋转曲面 / 平面区域 + 曲面实体计数。
 *
 * 验证 `rebuildFeatures()` 对曲面特征的求值：生成**壳**（非实体），
 * 不参与实体布尔，且面积/面数/曲面体计数正确。
 *
 * 运行: node tools/run-ts.mjs tools/surface-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument, newSketchFeature } from '../src/doc/model';
import { rebuildFeatures, buildMeshResult } from '../src/doc/engine';
import { emptySketch, newId, type Sketch } from '../src/sketch/types';
import type { Feature, FeatureId, SurfaceExtrudeFeature, SurfaceRevolveFeature, SurfacePlanarFeature, PrimitiveFeature } from '../src/doc/types';

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

function rebuild(doc: CadDocument): { shape: any; surfaces: number } {
  const { shape, errors, surfaces } = rebuildFeatures(doc.features);
  for (const f of doc.features) f.error = undefined;
  for (const e of errors) {
    const f = doc.getFeature(e.id);
    if (f) f.error = e.message;
  }
  return { shape, surfaces };
}

/** 闭合矩形草图（w×h） */
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

/** 开放折线草图 */
function polylineSketch(pts: [number, number][]): Sketch {
  const sk = emptySketch();
  const ids = pts.map(([x, y]) => {
    const id = newId('p');
    sk.points[id] = { id, x, y };
    return id;
  });
  for (let i = 0; i < ids.length - 1; i++) {
    sk.entities.push({ id: newId('e'), kind: 'line', a: ids[i], b: ids[i + 1] });
  }
  return sk;
}

/** 在前视基准面上放一个草图特征，返回其 id */
function addSketch(d: CadDocument, sk: Sketch): FeatureId {
  const sf = newSketchFeature('front', sk);
  d.add(sf);
  return sf.id;
}

// ---------- 1. 拉伸曲面（闭合矩形） ----------
console.log('【拉伸曲面 · 闭合轮廓】');
{
  const d = new CadDocument();
  const sid = addSketch(d, rectSketch(40, 25));
  const f: SurfaceExtrudeFeature = {
    id: newId('f'), type: 'surfaceExtrude', name: '拉伸曲面1',
    params: { sketchId: sid, distance: 20 },
  };
  d.add(f);
  const { shape, surfaces } = rebuild(d);
  const faces = S.faces(shape).length;
  const area = S.surfaceArea(shape);
  const bodies = S.bodiesOf(shape).length;
  const expectArea = 2 * (40 + 25) * 20; // 周长 × 距离 = 2600
  check('生成 1 个曲面实体', surfaces === 1 && S.surfacesOf(shape).length === 1);
  check('不产生实体', bodies === 0, `solids=${bodies}`);
  check('体积为 0（曲面不贡献体积）', near(S.solidVolume(shape), 0, 1e-6));
  check('4 个侧面（无上下盖）', faces === 4, `faces=${faces}`);
  check('面积 = 周长 × 距离', near(area, expectArea, 1e-2), `= ${area.toFixed(3)} / 期望 ${expectArea}`);
  check('无求值错误', d.features.every((x) => !x.error), d.features.map((x) => x.error).filter(Boolean).join('; '));
}

// ---------- 2. 拉伸曲面（开放折线） ----------
console.log('\n【拉伸曲面 · 开放轮廓】');
{
  const d = new CadDocument();
  const sid = addSketch(d, polylineSketch([[0, 0], [30, 0], [30, 20]]));
  const f: SurfaceExtrudeFeature = {
    id: newId('f'), type: 'surfaceExtrude', name: '拉伸曲面1',
    params: { sketchId: sid, distance: 15 },
  };
  d.add(f);
  const { shape, surfaces } = rebuild(d);
  const area = S.surfaceArea(shape);
  const expectArea = (30 + 20) * 15; // 折线总长 × 距离 = 750
  check('生成 1 个曲面实体', surfaces === 1);
  check('面积 = 折线长 × 距离', near(area, expectArea, 1e-2), `= ${area.toFixed(3)} / 期望 ${expectArea}`);
}

// ---------- 3. 旋转曲面 ----------
console.log('\n【旋转曲面】');
{
  const d = new CadDocument();
  // 竖直线 x=10（y 从 0 到 20），绕局部 Y 轴（x=0）旋转 360° → 半径 10、高 20 的圆柱面
  const sid = addSketch(d, polylineSketch([[10, 0], [10, 20]]));
  const f: SurfaceRevolveFeature = {
    id: newId('f'), type: 'surfaceRevolve', name: '旋转曲面1',
    params: { sketchId: sid, axisA: [0, 0], axisB: [0, 10], angleDeg: 360 },
  };
  d.add(f);
  const { shape, surfaces } = rebuild(d);
  const area = S.surfaceArea(shape);
  const expectArea = 2 * Math.PI * 10 * 20; // 2πrh = 1256.637
  check('生成 1 个曲面实体', surfaces === 1);
  check('面积 = 2πrh（圆柱面）', near(area, expectArea, 1), `= ${area.toFixed(3)} / 期望 ${expectArea.toFixed(3)}`);
  check('不产生实体', S.bodiesOf(shape).length === 0);
}

// ---------- 4. 平面区域 ----------
console.log('\n【平面区域】');
{
  const d = new CadDocument();
  const sid = addSketch(d, rectSketch(40, 25));
  const f: SurfacePlanarFeature = {
    id: newId('f'), type: 'surfacePlanar', name: '平面区域1',
    params: { sketchId: sid },
  };
  d.add(f);
  const { shape, surfaces } = rebuild(d);
  const faces = S.faces(shape).length;
  const area = S.surfaceArea(shape);
  check('生成 1 个曲面实体', surfaces === 1);
  check('1 个面', faces === 1, `faces=${faces}`);
  check('面积 = 40 × 25', near(area, 1000, 1e-2), `= ${area.toFixed(3)}`);
}

// ---------- 5. 曲面与实体共存（曲面不参与布尔 / 不计入体积） ----------
console.log('\n【曲面 + 实体共存】');
{
  const d = new CadDocument();
  const box: PrimitiveFeature = {
    id: newId('f'), type: 'primitive', name: '基本体1',
    params: { kind: 'box', dims: [40, 25, 10], operation: 'new' },
  };
  d.add(box);
  const sid = addSketch(d, rectSketch(30, 20));
  const f: SurfaceExtrudeFeature = {
    id: newId('f'), type: 'surfaceExtrude', name: '拉伸曲面1',
    params: { sketchId: sid, distance: 8 },
  };
  d.add(f);
  const { shape, surfaces } = rebuild(d);
  const bodies = S.bodiesOf(shape).length;
  check('1 个实体 + 1 个曲面实体', bodies === 1 && surfaces === 1, `solids=${bodies} surfaces=${surfaces}`);
  check('体积仅由实体贡献', near(S.solidVolume(shape), 40 * 25 * 10, 1e-3), `= ${S.solidVolume(shape).toFixed(3)}`);
}

// ---------- 6. 错误处理：平面区域需闭合轮廓 ----------
console.log('\n【错误处理】');
{
  const d = new CadDocument();
  const sid = addSketch(d, polylineSketch([[0, 0], [10, 0]]));
  const f: SurfacePlanarFeature = {
    id: newId('f'), type: 'surfacePlanar', name: '平面区域1',
    params: { sketchId: sid },
  };
  d.add(f);
  const { surfaces } = rebuild(d);
  check('开放轮廓 → 报错', !!d.getFeature(f.id)?.error, d.getFeature(f.id)?.error ?? '');
  check('未生成曲面实体', surfaces === 0);
}

// ---------- 7. 网格化（曲面可被三角化渲染） ----------
console.log('\n【网格化】');
{
  const d = new CadDocument();
  const sid = addSketch(d, rectSketch(40, 25));
  d.add({ id: newId('f'), type: 'surfaceExtrude', name: '拉伸曲面1', params: { sketchId: sid, distance: 20 } } as SurfaceExtrudeFeature);
  const { shape } = rebuild(d);
  const mesh = buildMeshResult(shape, 0.12, 0.28);
  const positions = new Float32Array(mesh.positions);
  check('网格有顶点', positions.length > 0, `verts=${positions.length / 3}`);
  check('面元数据与面区段对齐', mesh.faceMetas.length === mesh.faceRanges.length);
}

console.log(`\n曲面特征单测：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
