/**
 * 拉伸终止条件测试（SW 式「起始条件 + 方向1 + 方向2」）。
 *
 * 验证 `engine.ts` 的 `extrudeEndDistance` 与 extrude case：
 *  - 给定深度 / 两侧对称 / 起始等距
 *  - 成形到顶点（顶点到草图平面沿拉伸方向的距离）
 *  - 成形到面（目标平面与拉伸射线的交点距离，解析解）
 *  - 完全贯穿（按模型包围盒自动定长，穿透整个模型）
 *  - 方向 2（两侧不对称）
 *  - 错误处理（目标面平行 / 顶点在反方向）
 *
 * 运行: node tools/run-ts.mjs tools/extrude-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument, newSketchFeature } from '../src/doc/model';
import { rebuildFeatures } from '../src/doc/engine';
import { emptySketch, newId, type Sketch } from '../src/sketch/types';
import type { ExtrudeFeature, FeatureId, PrimitiveFeature } from '../src/doc/types';

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

/** 闭合矩形草图（可指定左下/右上） */
function rectSketch(x0: number, y0: number, x1: number, y1: number): Sketch {
  const sk = emptySketch();
  const pts = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
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

/** 居中矩形草图（w×h） */
function centeredRect(w: number, h: number): Sketch {
  return rectSketch(-w / 2, -h / 2, w / 2, h / 2);
}

/** 开放折线草图（依次连线，首尾不闭合） */
function openSketch(pts2d: [number, number][]): Sketch {
  const sk = emptySketch();
  const ids = pts2d.map(([x, y]) => {
    const id = newId('p');
    sk.points[id] = { id, x, y };
    return id;
  });
  for (let i = 0; i + 1 < ids.length; i++) {
    sk.entities.push({ id: newId('e'), kind: 'line', a: ids[i], b: ids[i + 1] });
  }
  return sk;
}

/** 整圆草图 */
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

/** 在 front 平面放草图 + 拉伸特征，返回求值后的形状 */
function extrudeDoc(sk: Sketch, params: Partial<ExtrudeFeature['params']>, base?: Feature[]): { shape: any; d: CadDocument } {
  const d = new CadDocument();
  if (base) for (const b of base) d.add(b);
  const sid = addSketch(d, sk);
  const f: ExtrudeFeature = {
    id: newId('f'), type: 'extrude', name: '拉伸1',
    params: { sketchId: sid, distance: 10, operation: base ? 'cut' : 'new', ...params } as ExtrudeFeature['params'],
  };
  d.add(f);
  const shape = rebuild(d);
  return { shape, d };
}
type Feature = ExtrudeFeature | PrimitiveFeature;

const AREA = 20 * 20; // 400

// ---------- 1. 给定深度（基线） ----------
console.log('【给定深度（blind）】');
{
  const { shape } = extrudeDoc(centeredRect(20, 20), { distance: 12, endCondition: 'blind' });
  const bb = S.shapeBBox(shape);
  check('体积 = 面积 × 深度', near(S.volume(shape), AREA * 12), `= ${S.volume(shape).toFixed(2)}`);
  check('z ∈ [0, 12]', near(bb.min[2], 0) && near(bb.max[2], 12), `[${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
}

// ---------- 2. 两侧对称 ----------
console.log('\n【两侧对称（midPlane）】');
{
  const { shape } = extrudeDoc(centeredRect(20, 20), { distance: 10, endCondition: 'midPlane' });
  const bb = S.shapeBBox(shape);
  check('体积 = 面积 × 深度', near(S.volume(shape), AREA * 10), `= ${S.volume(shape).toFixed(2)}`);
  check('z ∈ [-5, 5]', near(bb.min[2], -5) && near(bb.max[2], 5), `[${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
  // 兼容旧的 symmetric 标志
  const { shape: s2 } = extrudeDoc(centeredRect(20, 20), { distance: 10, symmetric: true });
  const bb2 = S.shapeBBox(s2);
  check('旧 symmetric 标志仍生效', near(bb2.min[2], -5) && near(bb2.max[2], 5));
}

// ---------- 3. 起始条件：等距 ----------
console.log('\n【起始条件：等距（offset）】');
{
  const { shape } = extrudeDoc(centeredRect(20, 20), {
    distance: 10, start: 'offset', startOffset: 30, endCondition: 'blind',
  });
  const bb = S.shapeBBox(shape);
  check('体积不变', near(S.volume(shape), AREA * 10), `= ${S.volume(shape).toFixed(2)}`);
  check('z ∈ [30, 40]', near(bb.min[2], 30) && near(bb.max[2], 40), `[${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
  // 偏移反向
  const { shape: s2 } = extrudeDoc(centeredRect(20, 20), {
    distance: 10, start: 'offset', startOffset: 30, startReverse: true, endCondition: 'blind',
  });
  const bb2 = S.shapeBBox(s2);
  check('偏移反向 → z ∈ [-30, -20]', near(bb2.min[2], -30) && near(bb2.max[2], -20), `[${bb2.min[2].toFixed(2)}, ${bb2.max[2].toFixed(2)}]`);
}

// ---------- 4. 成形到顶点 ----------
console.log('\n【成形到顶点（upToVertex）】');
{
  const { shape } = extrudeDoc(centeredRect(20, 20), {
    endCondition: 'upToVertex', vertex: [0, 0, 25],
  });
  const bb = S.shapeBBox(shape);
  check('深度 = 顶点沿拉伸方向的距离', near(S.volume(shape), AREA * 25), `= ${S.volume(shape).toFixed(2)}`);
  check('z ∈ [0, 25]', near(bb.min[2], 0) && near(bb.max[2], 25), `[${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
}

// ---------- 5. 成形到面 ----------
console.log('\n【成形到面（upToSurface）】');
{
  const { shape } = extrudeDoc(centeredRect(20, 20), {
    endCondition: 'upToSurface', targetFace: { point: [0, 0, 15], normal: [0, 0, 1] },
  });
  const bb = S.shapeBBox(shape);
  check('深度 = 目标面距离', near(S.volume(shape), AREA * 15), `= ${S.volume(shape).toFixed(2)}`);
  check('z ∈ [0, 15]', near(bb.min[2], 0) && near(bb.max[2], 15), `[${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
  // 目标面反向（法向 -Z）：距离仍取到该平面的有符号投影
  const { shape: s2 } = extrudeDoc(centeredRect(20, 20), {
    endCondition: 'upToSurface', targetFace: { point: [0, 0, 8], normal: [0, 0, -1] },
  });
  check('目标面法向反向仍得 8', near(S.volume(s2), AREA * 8), `= ${S.volume(s2).toFixed(2)}`);
}

// ---------- 6. 完全贯穿（切除） ----------
console.log('\n【完全贯穿（throughAll）】');
{
  const box: PrimitiveFeature = {
    id: newId('f'), type: 'primitive', name: '基本体1',
    params: { kind: 'box', dims: [40, 30, 20], operation: 'new' },
  };
  // 草图 20×20 位于 x∈[0,20], y∈[0,20] ⊂ box（z ∈ [0,20]）
  const { shape } = extrudeDoc(rectSketch(0, 0, 20, 20), { endCondition: 'throughAll' }, [box]);
  const expect = 40 * 30 * 20 - 20 * 20 * 20;
  check('贯穿切除体积 = 24000 − 8000', near(S.volume(shape), expect, 1), `= ${S.volume(shape).toFixed(2)} / 期望 ${expect}`);
  check('贯穿后仍为 1 实体', S.bodiesOf(shape).length === 1);
}

// ---------- 7. 方向 2（两侧不对称） ----------
console.log('\n【方向 2：两侧不对称】');
{
  const { shape } = extrudeDoc(centeredRect(20, 20), {
    distance: 15, endCondition: 'blind', end2: 'blind', distance2: 5,
  });
  const bb = S.shapeBBox(shape);
  check('体积 = 面积 × (d1 + d2)', near(S.volume(shape), AREA * 20), `= ${S.volume(shape).toFixed(2)}`);
  check('z ∈ [-5, 15]', near(bb.min[2], -5) && near(bb.max[2], 15), `[${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
  check('两侧合为一个实体', S.bodiesOf(shape).length === 1);
}

// ---------- 8. 错误处理 ----------
console.log('\n【错误处理】');
{
  // 目标面与拉伸方向平行
  const { d: d1 } = extrudeDoc(centeredRect(20, 20), {
    endCondition: 'upToSurface', targetFace: { point: [0, 0, 5], normal: [0, 1, 0] },
  });
  const e1 = d1.features.find((x) => x.type === 'extrude')?.error ?? '';
  check('目标面平行于拉伸方向 → 报错', /平行/.test(e1), e1);

  // 顶点在反方向
  const { d: d2 } = extrudeDoc(centeredRect(20, 20), {
    endCondition: 'upToVertex', vertex: [0, 0, -5],
  });
  const e2 = d2.features.find((x) => x.type === 'extrude')?.error ?? '';
  check('顶点在拉伸反方向 → 报错', /反方向|不在拉伸方向/.test(e2), e2);

  // 未指定目标面
  const { d: d3 } = extrudeDoc(centeredRect(20, 20), { endCondition: 'upToSurface' });
  const e3 = d3.features.find((x) => x.type === 'extrude')?.error ?? '';
  check('未指定目标面 → 报错', /未指定目标面/.test(e3), e3);
}

// ---------- 9. 薄壁特征 ----------
console.log('\n【薄壁特征：闭环轮廓 → 环带】');
{
  // 居中矩形 20×20，两侧对称厚 2 → 壁面介于 18×18 与 22×22 之间（斜接直角）
  const { shape } = extrudeDoc(centeredRect(20, 20), {
    distance: 10, thin: { type: 'midPlane', thickness: 2 },
  });
  const expect = (22 * 22 - 18 * 18) * 10; // 1600
  check('两侧对称厚 2 → 环带体积 1600', near(S.volume(shape), expect, 1), `= ${S.volume(shape).toFixed(2)} / 期望 ${expect}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);

  // 单侧厚 2 → 壁面介于 20×20 与 24×24
  const { shape: s2 } = extrudeDoc(centeredRect(20, 20), {
    distance: 10, thin: { type: 'oneSide', thickness: 2 },
  });
  const exp2 = (24 * 24 - 20 * 20) * 10; // 1760
  check('单侧厚 2 → 环带体积 1760', near(S.volume(s2), exp2, 1), `= ${S.volume(s2).toFixed(2)} / 期望 ${exp2}`);

  // 单侧反向 → 材料落到轮廓另一侧（闭环时即「向内」）：壁面介于 16×16 与 20×20
  const { shape: s3 } = extrudeDoc(centeredRect(20, 20), {
    distance: 10, thin: { type: 'oneSide', thickness: 2, reverse: true },
  });
  const exp3 = (20 * 20 - 16 * 16) * 10; // 1440
  check('单侧反向 → 材料在内侧 1440', near(S.volume(s3), exp3, 1), `= ${S.volume(s3).toFixed(2)} / 期望 ${exp3}`);

  // 两侧不对称：正向 2 + 反向 4 → 壁面介于 12×12 与 24×24
  const { shape: s4 } = extrudeDoc(centeredRect(20, 20), {
    distance: 10, thin: { type: 'twoSides', thickness: 2, thickness2: 4 },
  });
  const exp4 = (24 * 24 - 12 * 12) * 10; // 4320
  check('两侧不对称 2+4 → 环带体积 4320', near(S.volume(s4), exp4, 1), `= ${S.volume(s4).toFixed(2)} / 期望 ${exp4}`);
}

console.log('\n【薄壁特征：开环轮廓 → 带状】');
{
  // L 形开放折线（0,0)→(30,0)→(30,20)，总长 50
  const L: [number, number][] = [[0, 0], [30, 0], [30, 20]];
  // 两侧对称厚 2 → 斜接折角效应恰好抵消，体积 = 50×2×10 = 1000
  const { shape } = extrudeDoc(openSketch(L), {
    distance: 10, thin: { type: 'midPlane', thickness: 2 },
  });
  check('开环两侧对称 → 带状体积 1000', near(S.volume(shape), 1000, 1), `= ${S.volume(shape).toFixed(2)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);

  // 单侧厚 2 → 材料在路径一侧；凸角 miter 外扩、凹角内收，净 +4%：1040
  const { shape: s2 } = extrudeDoc(openSketch(L), {
    distance: 10, thin: { type: 'oneSide', thickness: 2 },
  });
  check('开环单侧厚 2 → 带状体积 1040（斜接）', near(S.volume(s2), 1040, 2), `= ${S.volume(s2).toFixed(2)}`);

  // 单侧反向（换到另一侧）→ 斜接净 -4%：960
  const { shape: s3 } = extrudeDoc(openSketch(L), {
    distance: 10, thin: { type: 'oneSide', thickness: 2, reverse: true },
  });
  check('开环单侧反向 → 带状体积 960（斜接）', near(S.volume(s3), 960, 2), `= ${S.volume(s3).toFixed(2)}`);
}

console.log('\n【薄壁特征：闭环圆 → 圆管】');
{
  // Φ40 圆，两侧对称厚 3，拉 12：多边形逼近，误差 < 3%
  const { shape } = extrudeDoc(circleSketch(0, 0, 20), {
    distance: 12, thin: { type: 'midPlane', thickness: 3 },
  });
  const expect = Math.PI * (21.5 * 21.5 - 18.5 * 18.5) * 12; // ≈ 4523.9
  check('圆管体积 ≈ 解析值（±3%）', Math.abs(S.volume(shape) - expect) / expect < 0.03, `= ${S.volume(shape).toFixed(2)} / 解析 ${expect.toFixed(2)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);
}

console.log('\n【薄壁特征：错误处理】');
{
  const { d } = extrudeDoc(centeredRect(20, 20), {
    distance: 10, thin: { type: 'midPlane', thickness: 0 },
  });
  const e = d.features.find((x) => x.type === 'extrude')?.error ?? '';
  check('厚度为 0 → 报错', /厚度必须大于 0/.test(e), e);
}

console.log(`\n拉伸终止条件单测：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
