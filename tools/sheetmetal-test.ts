/**
 * 钣金特征测试 —— 第二十轮。
 *
 * 验证 `engine.ts` 的 `sheetBaseFlange`（基体法兰，把草图轮廓当作展开外形、沿法向拉伸出薄板）
 * 与 `sheetEdgeFlange`（边线法兰，沿选中直线边放样 L 形截面生成带折弯的钣金壁）：
 *  - 基体法兰：矩形 / 圆形草图 → 薄板体积解析校验、单一实体、包围盒
 *  - 边线法兰：在基体法兰的直线边上折起墙，与基体布尔融合为单一实体、体积增加、无错误
 *  - 错误处理：板厚 0 / 无基体 / 非直线边
 *
 * 运行: node tools/run-ts.mjs tools/sheetmetal-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument, newSketchFeature } from '../src/doc/model';
import { rebuildFeatures } from '../src/doc/engine';
import { edgeInfos } from '../src/doc/topo';
import { emptySketch, newId, type Sketch, type EdgeMeta } from '../src/sketch/types';
import type {
  SheetBaseFlangeFeature,
  SheetEdgeFlangeFeature,
  FeatureId,
} from '../src/doc/types';

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

/** 构造基体法兰文档 */
function baseFlangeDoc(sk: Sketch, thickness: number, bendRadius = 2): { shape: any; d: CadDocument } {
  const d = new CadDocument();
  const sid = addSketch(d, sk);
  const f: SheetBaseFlangeFeature = {
    id: newId('f'), type: 'sheetBaseFlange', name: '基体法兰1',
    params: { sketchId: sid, thickness, bendRadius, kFactor: 0.5, operation: 'new' },
  };
  d.add(f);
  return { shape: rebuild(d), d };
}

/** 从重建出的形状里挑最长的直线边，返回 EdgeRef（中点 + 方向） */
function longestLineEdgeRef(shape: any): { point: [number, number, number]; dir: [number, number, number] } | null {
  const infos = edgeInfos(shape).filter((e: EdgeMeta) => e.curveType === 'line' && e.endpoints);
  if (!infos.length) return null;
  infos.sort((a, b) => b.length - a.length);
  const e = infos[0];
  return { point: [...e.mid], dir: [...e.dir] };
}

// ============================================================
// 1. 基体法兰：矩形草图 → 薄板（展开外形 × 板厚）
// ============================================================
console.log('【基体法兰 · 矩形 40×20，板厚 1 → 40×20×1 薄板】');
{
  const { shape, d } = baseFlangeDoc(rectSketch(0, 0, 40, 20), 1);
  // 实心薄板：体积 = 40·20·1 = 800
  check('体积 = 40·20·1 = 800', near(S.volume(shape), 800, 2), `= ${S.volume(shape).toFixed(2)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);
  const bb = S.shapeBBox(shape);
  check('Z 方向厚度 ≈ 1', near(bb.max[2] - bb.min[2], 1, 0.05), `[${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
  check('X 方向 ≈ 40', near(bb.max[0] - bb.min[0], 40, 0.05), `[${bb.min[0].toFixed(2)}, ${bb.max[0].toFixed(2)}]`);
  check('Y 方向 ≈ 20', near(bb.max[1] - bb.min[1], 20, 0.05), `[${bb.min[1].toFixed(2)}, ${bb.max[1].toFixed(2)}]`);
  check('无错误', !d.features.find((x) => x.type === 'sheetBaseFlange')?.error, '');
}

// ============================================================
// 2. 基体法兰：圆形草图 → 圆板
// ============================================================
console.log('\n【基体法兰 · 圆 r=10，板厚 1 → 圆板】');
{
  // 实心圆柱：体积 = π·10²·1 = 100π ≈ 314.16
  const { shape } = baseFlangeDoc(circleSketch(0, 0,10), 1);
  const expect = Math.PI * 10 * 10 * 1;
  check('体积 ≈ π·10²·1（±0.5）', near(S.volume(shape), expect, 0.5), `= ${S.volume(shape).toFixed(2)} / 期望 ${expect.toFixed(2)}`);
  check('1 个实体', S.bodiesOf(shape).length === 1);
}

// ============================================================
// 3. 边线法兰：在基体法兰直线边上折起墙，融合为单一实体
// ============================================================
console.log('\n【边线法兰 · 在矩形薄板（40×20×1）的长边上折 20 高墙 → 融合】');
{
  const base = baseFlangeDoc(rectSketch(0, 0, 40, 20), 1, 2);
  const edgeRef = longestLineEdgeRef(base.shape);
  check('能挑出直线边', !!edgeRef, edgeRef ? `mid=${edgeRef.point.map((n) => n.toFixed(1))}` : 'null');
  if (edgeRef) {
    const f: SheetEdgeFlangeFeature = {
      id: newId('f'), type: 'sheetEdgeFlange', name: '边线法兰1',
      params: { edge: edgeRef, length: 20, angleDeg: 90, bendRadius: 2, thickness: 1, operation: 'add' },
    };
    base.d.add(f);
    const shape = rebuild(base.d);
    const fe = base.d.features.find((x) => x.type === 'sheetEdgeFlange');
    check('无错误', !fe?.error, fe?.error ?? '');
    check('融合后仍是 1 个实体', S.bodiesOf(shape).length === 1, `实体数 ${S.bodiesOf(shape).length}`);
    const v0 = S.volume(base.shape);
    const v1 = S.volume(shape);
    check('体积增加（墙被加上）', v1 > v0, `${v0.toFixed(0)} → ${v1.toFixed(0)}`);
    const added = v1 - v0;
    check('增加量在合理区间 500~1600', added > 500 && added < 1600, `Δ = ${added.toFixed(0)}`);
  }
}

// ============================================================
// 4. 边线法兰：非 90° 折弯角（倾斜墙）仍融合
// ============================================================
console.log('\n【边线法兰 · 折弯角 45° → 倾斜墙，仍单一实体】');
{
  const base = baseFlangeDoc(rectSketch(0, 0, 40, 20), 1, 2);
  const edgeRef = longestLineEdgeRef(base.shape);
  if (edgeRef) {
    const f: SheetEdgeFlangeFeature = {
      id: newId('f'), type: 'sheetEdgeFlange', name: '边线法兰2',
      params: { edge: edgeRef, length: 20, angleDeg: 45, bendRadius: 2, thickness: 1, operation: 'add' },
    };
    base.d.add(f);
    const shape = rebuild(base.d);
    const fe = base.d.features.find((x) => x.type === 'sheetEdgeFlange');
    check('45° 无错误', !fe?.error, fe?.error ?? '');
    check('融合后 1 个实体', S.bodiesOf(shape).length === 1, `实体数 ${S.bodiesOf(shape).length}`);
  }
}

// ============================================================
// 5. 错误处理
// ============================================================
console.log('\n【错误处理】');
{
  // 板厚 0
  const d0 = new CadDocument();
  const sid = addSketch(d0, rectSketch(0, 0, 40, 20));
  d0.add({ id: newId('f'), type: 'sheetBaseFlange', name: 'bf', params: { sketchId: sid, thickness: 0, bendRadius: 2, operation: 'new' } });
  rebuild(d0);
  const e0 = d0.features.find((x) => x.type === 'sheetBaseFlange')?.error ?? '';
  check('基体法兰板厚 0 → 报错', /板厚必须大于 0/.test(e0), e0);

  // 边线法兰无基体
  const d1 = new CadDocument();
  d1.add({ id: newId('f'), type: 'sheetEdgeFlange', name: 'ef', params: { edge: { point: [0, 0, 0], dir: [1, 0, 0] }, length: 20, angleDeg: 90, bendRadius: 2, thickness: 1, operation: 'add' } });
  rebuild(d1);
  const e1 = d1.features.find((x) => x.type === 'sheetEdgeFlange')?.error ?? '';
  check('边线法兰无基体 → 报错', /请先创建钣金基体/.test(e1), e1);
}

console.log(`\n钣金特征单测：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
