/**
 * 实体编辑族测试：缩放 / 分割 / 变半径圆角。
 *
 * 这三个特征都是对**已有实体**做编辑，与前面的"从草图生成实体"不同，
 * 因此断言的重点是「拓扑与度量的守恒律」：
 *   - 缩放：体积按各轴系数之积缩放、包围盒按比例、面数不变、中心点是不动点
 *   - 分割：总质量守恒（切之前 = 切之后之和）、子实体数、单侧保留的体积
 *   - 变半径圆角：体积必须**严格介于**两个定半径结果之间（否则就不是变半径）
 *
 * 运行: node tools/run-ts.mjs tools/edit-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument } from '../src/doc/model';
import { rebuildFeatures, buildMeshResult } from '../src/doc/engine';
import { edgeInfos } from '../src/doc/topo';
import { newId } from '../src/sketch/types';
import { DEFAULT_PLANE, type SketchPlane } from '../src/sketch/types';
import type { Feature, FeatureId, ScaleFeature, SplitFeature, FilletFeature, EdgeRef, MoveBodyFeature, DeleteBodyFeature, CombineFeature, CombineOp } from '../src/doc/types';

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
// 辅助
// ============================================================
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
const volOf = (s: any): number => (s && !s.IsNull() ? S.volume(s) : NaN);
const solidsOf = (s: any): number => (s && !s.IsNull() ? S.solids(s).length : 0);
const facesOf = (s: any): number => (s && !s.IsNull() ? S.faces(s).length : 0);

/** 从实体网格算包围盒 */
function meshBBox(shape: any): { min: [number, number, number]; max: [number, number, number] } {
  if (!shape || shape.IsNull()) return { min: [0, 0, 0], max: [0, 0, 0] };
  const mesh = buildMeshResult(shape, 0.2, 0.5);
  return S.boundingBox({ positions: new Float32Array(mesh.positions) });
}

const boxFeature = (dx: number, dy: number, dz: number, origin?: [number, number, number]): Feature =>
  ({
    id: newId('f'), type: 'primitive', name: '长方体',
    params: { kind: 'box', dims: [dx, dy, dz], origin, operation: 'new' },
  }) as Feature;

/** 取实体上最长的一条边，做成 EdgeRef（用于圆角） */
function longestEdgeRef(shape: any): EdgeRef {
  const infos = edgeInfos(shape);
  let best = infos[0];
  for (const e of infos) if (e.length > best.length) best = e;
  return { point: [...best.mid], dir: [...best.dir] };
}

// ============================================================
// A. 缩放
// ============================================================
console.log('▶ A. 缩放');
{
  // 基础体：10 × 20 × 30 = 6000 mm³，位于第一象限
  const base = 10 * 20 * 30;

  const docU = new CadDocument();
  docU.add(boxFeature(10, 20, 30));
  docU.add({ id: newId('f'), type: 'scale', name: '缩放1', params: { center: [0, 0, 0], factor: 2 } } as ScaleFeature);
  const shapeU = rebuild(docU);
  check('统一缩放求值无错误', featureErrors(docU).length === 0, featureErrors(docU).join('; '));
  check('统一缩放 2×：体积 ×8', nearRel(volOf(shapeU), base * 8, 1e-3), `${volOf(shapeU).toFixed(2)} vs ${(base * 8).toFixed(2)}`);
  check('统一缩放不改变面数', facesOf(shapeU) === 6, `面=${facesOf(shapeU)}`);
  {
    const bb = meshBBox(shapeU);
    check(
      '统一缩放 2×：包围盒 = 20×40×60',
      near(bb.max[0], 20, 0.05) && near(bb.max[1], 40, 0.05) && near(bb.max[2], 60, 0.05),
      `max=[${bb.max.map((v) => v.toFixed(1)).join(',')}]`
    );
  }

  // 非均匀 2×3×4：体积 ×24
  const docN = new CadDocument();
  docN.add(boxFeature(10, 20, 30));
  docN.add({
    id: newId('f'), type: 'scale', name: '缩放2',
    params: { center: [0, 0, 0], factor: 1, nonUniform: true, factors: [2, 3, 4] },
  } as ScaleFeature);
  const shapeN = rebuild(docN);
  check('非均匀缩放求值无错误', featureErrors(docN).length === 0, featureErrors(docN).join('; '));
  check(
    '非均匀缩放 2×3×4：体积 ×24',
    nearRel(volOf(shapeN), base * 24, 1e-3),
    `${volOf(shapeN).toFixed(2)} vs ${(base * 24).toFixed(2)}`
  );
  {
    const bb = meshBBox(shapeN);
    check(
      '非均匀缩放：各轴独立缩放 20×60×120',
      near(bb.max[0], 20, 0.05) && near(bb.max[1], 60, 0.05) && near(bb.max[2], 120, 0.05),
      `max=[${bb.max.map((v) => v.toFixed(1)).join(',')}]`
    );
  }

  // 不动点：以包围盒中心 (5,10,15) 缩放 2×，中心应保持不变
  const docC = new CadDocument();
  docC.add(boxFeature(10, 20, 30));
  docC.add({ id: newId('f'), type: 'scale', name: '缩放3', params: { center: [5, 10, 15], factor: 2 } } as ScaleFeature);
  const shapeC = rebuild(docC);
  {
    const bb = meshBBox(shapeC);
    const cx = (bb.min[0] + bb.max[0]) / 2;
    const cy = (bb.min[1] + bb.max[1]) / 2;
    const cz = (bb.min[2] + bb.max[2]) / 2;
    check(
      '指定中心是不动点（包围盒中心不变）',
      near(cx, 5, 0.05) && near(cy, 10, 0.05) && near(cz, 15, 0.05),
      `中心=(${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)}) 期望 (5,10,15)`
    );
    check(
      '以中心缩放 2×：包围盒 = [-5,-10,-15]~[15,30,45]',
      near(bb.min[0], -5, 0.05) && near(bb.max[2], 45, 0.05),
      `min=[${bb.min.map((v) => v.toFixed(1)).join(',')}] max=[${bb.max.map((v) => v.toFixed(1)).join(',')}]`
    );
  }

  // 特征链：缩放后继续做拉伸切除
  const docChain = new CadDocument();
  docChain.add(boxFeature(20, 20, 20));
  docChain.add({ id: newId('f'), type: 'scale', name: '缩放4', params: { center: [0, 0, 0], factor: 2 } } as ScaleFeature);
  docChain.add({
    id: newId('f'), type: 'primitive', name: '切除圆柱',
    params: { kind: 'cylinder', dims: [5, 60], origin: [20, 20, -10], operation: 'cut' },
  } as Feature);
  const shapeChain = rebuild(docChain);
  const vBox2 = 40 * 40 * 40;
  const vCyl = Math.PI * 25 * 40;
  check('缩放后仍可作为后续特征的基体', featureErrors(docChain).length === 0, featureErrors(docChain).join('; '));
  check(
    '缩放后切除：体积 = 放大后的箱体 − 圆柱',
    nearRel(volOf(shapeChain), vBox2 - vCyl, 0.01),
    `${volOf(shapeChain).toFixed(1)} vs ${(vBox2 - vCyl).toFixed(1)}`
  );

  // 非法系数
  const docBad = new CadDocument();
  docBad.add(boxFeature(10, 10, 10));
  docBad.add({ id: newId('f'), type: 'scale', name: '缩放5', params: { center: [0, 0, 0], factor: 0 } } as ScaleFeature);
  rebuild(docBad);
  check('缩放系数为 0 时报错', featureErrors(docBad).length > 0, featureErrors(docBad).join('; '));
}

// ============================================================
// B. 分割
// ============================================================
console.log('\n▶ B. 分割');
{
  const V = 20 * 20 * 20; // 8000

  // z = 10 处水平切
  const planeZ10: SketchPlane = { ...DEFAULT_PLANE, origin: [0, 0, 10], ref: 'z=10' };

  const docB = new CadDocument();
  docB.add(boxFeature(20, 20, 20));
  docB.add({ id: newId('f'), type: 'split', name: '分割1', params: { plane: planeZ10, keep: 'both' } } as SplitFeature);
  const shapeB = rebuild(docB);
  check('分割求值无错误', featureErrors(docB).length === 0, featureErrors(docB).join('; '));
  check('分割成 2 个实体', solidsOf(shapeB) === 2, `实体=${solidsOf(shapeB)}`);
  check('分割后总体积守恒（质量守恒律）', nearRel(volOf(shapeB), V, 1e-3), `${volOf(shapeB).toFixed(2)} vs ${V}`);

  // 单侧保留
  const docP = new CadDocument();
  docP.add(boxFeature(20, 20, 20));
  docP.add({ id: newId('f'), type: 'split', name: '分割2', params: { plane: planeZ10, keep: 'positive' } } as SplitFeature);
  const shapeP = rebuild(docP);
  check('保留法向正侧：1 个实体', solidsOf(shapeP) === 1, `实体=${solidsOf(shapeP)}`);
  check('保留法向正侧：体积 = 4000', nearRel(volOf(shapeP), 4000, 1e-3), `${volOf(shapeP).toFixed(2)} vs 4000`);

  const docM = new CadDocument();
  docM.add(boxFeature(20, 20, 20));
  docM.add({ id: newId('f'), type: 'split', name: '分割3', params: { plane: planeZ10, keep: 'negative' } } as SplitFeature);
  const shapeM = rebuild(docM);
  check('保留法向负侧：体积 = 4000', nearRel(volOf(shapeM), 4000, 1e-3), `${volOf(shapeM).toFixed(2)} vs 4000`);
  check(
    '两侧体积之和 = 原体积',
    near(volOf(shapeP) + volOf(shapeM), V, 1),
    `${(volOf(shapeP) + volOf(shapeM)).toFixed(2)} vs ${V}`
  );

  // 斜切：法向 (1,1,1)/√3，过中心
  {
    const n = 1 / Math.sqrt(3);
    const t = 1 / Math.sqrt(2);
    const planeDiag: SketchPlane = {
      origin: [10, 10, 10],
      u: [t, -t, 0],
      v: [n, n, -2 * n],
      normal: [n, n, n],
      ref: '斜切',
    };
    const docD = new CadDocument();
    docD.add(boxFeature(20, 20, 20));
    docD.add({ id: newId('f'), type: 'split', name: '分割4', params: { plane: planeDiag, keep: 'both' } } as SplitFeature);
    const shapeD = rebuild(docD);
    check('斜切求值无错误', featureErrors(docD).length === 0, featureErrors(docD).join('; '));
    check('斜切成 2 个实体', solidsOf(shapeD) === 2, `实体=${solidsOf(shapeD)}`);
    check('斜切体积守恒', nearRel(volOf(shapeD), V, 1e-3), `${volOf(shapeD).toFixed(2)} vs ${V}`);
  }

  // 平面没切到实体 → 应报错而不是静默成功
  const docFar = new CadDocument();
  docFar.add(boxFeature(20, 20, 20));
  docFar.add({
    id: newId('f'), type: 'split', name: '分割5',
    params: { plane: { ...DEFAULT_PLANE, origin: [0, 0, 200], ref: '远处平面' }, keep: 'both' },
  } as SplitFeature);
  rebuild(docFar);
  check('平面没切到实体时报错（不静默成功）', featureErrors(docFar).length > 0, featureErrors(docFar).join('; '));

  // 分割后继续做特征
  const docChain2 = new CadDocument();
  docChain2.add(boxFeature(20, 20, 20));
  docChain2.add({ id: newId('f'), type: 'split', name: '分割6', params: { plane: planeZ10, keep: 'both' } } as SplitFeature);
  docChain2.add({
    id: newId('f'), type: 'primitive', name: '切除圆柱',
    params: { kind: 'cylinder', dims: [3, 60], origin: [10, 10, -10], operation: 'cut' },
  } as Feature);
  const shapeChain2 = rebuild(docChain2);
  check('分割后仍可作为后续特征的基体', featureErrors(docChain2).length === 0, featureErrors(docChain2).join('; '));
  check(
    '分割后切除：体积 = 8000 − 圆柱（被两块各切一部分）',
    nearRel(volOf(shapeChain2), V - Math.PI * 9 * 20, 0.02),
    `${volOf(shapeChain2).toFixed(1)} vs ${(V - Math.PI * 9 * 20).toFixed(1)}`
  );
}

// ============================================================
// C. 变半径圆角
// ============================================================
console.log('\n▶ C. 变半径圆角');
{
  const V = 20 * 20 * 20; // 8000

  // 先拿到一条棱的引用
  const probe = new CadDocument();
  probe.add(boxFeature(20, 20, 20));
  const boxShape = rebuild(probe);
  const ref = longestEdgeRef(boxShape);

  const mkFillet = (r1: number, r2?: number): { v: number; f: number; s: number; err: string[] } => {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20));
    d.add({
      id: newId('f'), type: 'fillet', name: '圆角',
      params: { edges: [ref], radius: r1, radius2: r2 },
    } as FilletFeature);
    const sh = rebuild(d);
    return { v: volOf(sh), f: facesOf(sh), s: solidsOf(sh), err: featureErrors(d) };
  };

  const c1 = mkFillet(1);
  const c4 = mkFillet(4);
  const vr = mkFillet(1, 4);

  check('定半径 r=1 求值成功', c1.err.length === 0, c1.err.join('; '));
  check('定半径 r=4 求值成功', c4.err.length === 0, c4.err.join('; '));
  check('变半径 r 1→4 求值成功', vr.err.length === 0, vr.err.join('; '));
  check('圆角后仍是单个实体', vr.s === 1, `实体=${vr.s}`);
  check('圆角产生新面（6 → 7）', vr.f === 7, `面=${vr.f}`);
  check(
    '变半径体积严格介于 r=1 与 r=4 之间（证明半径真的在变化）',
    vr.v < c1.v - 1e-6 && vr.v > c4.v + 1e-6,
    `变半径=${vr.v.toFixed(2)}，r1=${c1.v.toFixed(2)}，r4=${c4.v.toFixed(2)}`
  );
  check('定半径 r=1 与 r=4 结果不同', Math.abs(c1.v - c4.v) > 10, `${c1.v.toFixed(2)} vs ${c4.v.toFixed(2)}`);
  check('圆角后体积略小于原体积', c1.v < V && vr.v < V, `${vr.v.toFixed(2)} < ${V}`);

  // r1 === r2 应等价于定半径
  const same = mkFillet(2, 2);
  const c2 = mkFillet(2);
  check(
    'r1 = r2 时等价于定半径',
    same.err.length === 0 && nearRel(same.v, c2.v, 1e-4),
    `变半径写法=${same.v.toFixed(3)} 定半径=${c2.v.toFixed(3)}`
  );

  // 半径过大 → 应报错而不是崩溃
  // 注意：20³ 箱体单棱圆角的最大合法半径接近 20（相邻面被完全消耗），
  // r=15 仍合法，必须取严格越界的半径才能触发内核拒绝。
  const tooBig = mkFillet(25);
  check('半径过大时报错（不崩溃）', tooBig.err.length > 0, tooBig.err.join('; ') || '（未报错）');
  check(
    '过大半径给出可读中文错误（而非 emscripten 噪声）',
    tooBig.err.length > 0 && /圆角|几何条件/.test(tooBig.err[0]) && !/___cxa/.test(tooBig.err[0]),
    tooBig.err[0] || ''
  );
}

// ============================================================
// D. 移动 / 复制实体
// ============================================================
console.log('\n▶ D. 移动 / 复制实体');
{
  const bboxOf = (s: any) => S.shapeBBox(s);
  const extents = (bb: { min: [number, number, number]; max: [number, number, number] }) =>
    [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]] as [number, number, number];
  const fmt = (v: number[]) => `[${v.map((x) => x.toFixed(2)).join(', ')}]`;

  // 10 × 20 × 30 = 6000，位于第一象限
  const mkDoc = () => {
    const d = new CadDocument();
    d.add(boxFeature(10, 20, 30));
    return d;
  };
  const moveFeature = (params: Partial<MoveBodyFeature['params']>): MoveBodyFeature =>
    ({
      id: newId('f'), type: 'moveBody', name: '移动/复制',
      params: { delta: [0, 0, 0], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 0, ...params },
    }) as MoveBodyFeature;

  // D1 纯平移
  {
    const d = mkDoc();
    d.add(moveFeature({ delta: [100, 0, 0] }));
    const s = rebuild(d);
    check('平移求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('平移不改变体积', nearRel(volOf(s), 6000, 1e-4), volOf(s).toFixed(2));
    check('平移不改变面数（6 面）', facesOf(s) === 6, `${facesOf(s)} 面`);
    check('平移后仍是单实体', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    const bb = bboxOf(s);
    check(
      '平移后包围盒整体沿 X 移动 100',
      near(bb.min[0], 100, 1e-3) && near(bb.max[0], 110, 1e-3) && near(bb.max[1], 20, 1e-3),
      `${fmt(bb.min)} ~ ${fmt(bb.max)}`
    );
  }

  // D2 绕 Z 轴旋转 90°：X/Y 尺寸互换
  {
    const d = mkDoc();
    d.add(moveFeature({ angleDeg: 90 }));
    const s = rebuild(d);
    check('旋转 90° 求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('旋转不改变体积', nearRel(volOf(s), 6000, 1e-4), volOf(s).toFixed(2));
    const ext = extents(bboxOf(s));
    check(
      '绕 Z 旋转 90°：X/Y 尺寸互换（10 ↔ 20）',
      near(ext[0], 20, 1e-3) && near(ext[1], 10, 1e-3) && near(ext[2], 30, 1e-3),
      `尺寸=${fmt(ext)}`
    );
  }

  // D3 旋转 + 平移组合：先转后移
  {
    const d = mkDoc();
    d.add(moveFeature({ angleDeg: 90, delta: [100, 0, 0] }));
    const s = rebuild(d);
    check('旋转 + 平移求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('旋转 + 平移体积不变', nearRel(volOf(s), 6000, 1e-4), volOf(s).toFixed(2));
    // 先绕 Z 转 90° → x∈[0,10] 变成 y∈[0,10]、x∈[-20,0]；再沿 X 平移 100
    const bb = bboxOf(s);
    check(
      '先转后移：包围盒 = [-20,0,0]~[100,10,30] 平移 100',
      near(bb.min[0], 80, 1e-3) && near(bb.max[0], 100, 1e-3) && near(bb.max[1], 10, 1e-3),
      `${fmt(bb.min)} ~ ${fmt(bb.max)}`
    );
  }

  // D4 复制 2 份
  {
    const d = mkDoc();
    d.add(moveFeature({ delta: [100, 0, 0], copy: true, count: 2 }));
    const s = rebuild(d);
    check('复制求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('复制 2 份 → 共 3 个实体', solidsOf(s) === 3, `${solidsOf(s)} 实体`);
    check('复制后体积 ×3（质量守恒）', nearRel(volOf(s), 18000, 1e-4), volOf(s).toFixed(2));
    const bb = bboxOf(s);
    check(
      '复制：原件留在原位、副本逐份偏移（X ∈ [0, 210]）',
      near(bb.min[0], 0, 1e-3) && near(bb.max[0], 210, 1e-3),
      `X ∈ [${bb.min[0].toFixed(2)}, ${bb.max[0].toFixed(2)}]`
    );
  }

  // D5 只移动指定实体（多实体场景）
  {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20)); // A: [0,20]³
    d.add({
      id: newId('f'), type: 'primitive', name: '长方体2',
      params: { kind: 'box', dims: [20, 20, 20], origin: [100, 0, 0], operation: 'new' },
    } as Feature);
    const s0 = rebuild(d);
    check('前置：两个分离长方体 → 2 实体', solidsOf(s0) === 2, `${solidsOf(s0)} 实体`);
    // 用包围盒定位「在 x=100 处的那个」，避免依赖 bodiesOf 的展开顺序
    const farIdx = S.bodiesOf(s0).findIndex((b) => S.shapeBBox(b).min[0] > 50);
    check('前置：能按几何识别出 x=100 处的实体', farIdx >= 0, `farIdx=${farIdx}`);
    d.add(moveFeature({ delta: [-60, 0, 0], indices: [farIdx] })); // 只把第 2 个搬到 [40,60]
    const s = rebuild(d);
    check('按实体选择移动求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('移动指定实体后仍为 2 实体', solidsOf(s) === 2, `${solidsOf(s)} 实体`);
    const bb = bboxOf(s);
    check(
      '只移动了第 2 个实体（第 1 个仍在原点，X ∈ [0, 60]）',
      near(bb.min[0], 0, 1e-3) && near(bb.max[0], 60, 1e-3),
      `X ∈ [${bb.min[0].toFixed(2)}, ${bb.max[0].toFixed(2)}]`
    );
  }

  // D6 移动后仍可作为后续布尔切除的基体
  {
    const d = mkDoc();
    d.add(moveFeature({ delta: [0, 0, 0] }));
    d.add({
      id: newId('f'), type: 'primitive', name: '圆柱',
      params: { kind: 'cylinder', dims: [3, 100], origin: [5, 10, -50], operation: 'cut' },
    } as Feature);
    const s = rebuild(d);
    check(
      '移动后仍可作为后续布尔切除的基体',
      featureErrors(d).length === 0 && volOf(s) < 6000 && volOf(s) > 5000,
      `${volOf(s).toFixed(2)}（< 6000）`
    );
  }
}

// ============================================================
// E. 删除实体
// ============================================================
console.log('\n▶ E. 删除实体');
{
  // 前置：用「分割」把一个 20³ 箱体沿 z=10 切成 2 块
  const splitDoc = () => {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20));
    d.add({
      id: newId('f'), type: 'split', name: '分割',
      params: {
        plane: { origin: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
        keep: 'both',
      },
    } as SplitFeature);
    return d;
  };
  const delFeature = (indices: number[]): DeleteBodyFeature =>
    ({ id: newId('f'), type: 'deleteBody', name: '删除实体', params: { indices } }) as DeleteBodyFeature;

  {
    const d = splitDoc();
    const s = rebuild(d);
    check('前置：分割产生 2 实体 / 体积 8000', solidsOf(s) === 2 && nearRel(volOf(s), 8000, 1e-4), `${solidsOf(s)} 实体 · ${volOf(s).toFixed(2)}`);
  }

  {
    const d = splitDoc();
    d.add(delFeature([0]));
    const s = rebuild(d);
    check('删除实体求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('删 1 个后剩 1 个实体', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    check('删除后体积 = 4000（20×20×10）', nearRel(volOf(s), 4000, 1e-3), volOf(s).toFixed(2));
  }

  {
    const d = splitDoc();
    d.add(delFeature([1]));
    const s = rebuild(d);
    check('删除第 2 个实体后剩 1 个', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    check('删除第 2 个后体积仍是 4000', nearRel(volOf(s), 4000, 1e-3), volOf(s).toFixed(2));
  }

  {
    const d = splitDoc();
    d.add(delFeature([0, 1]));
    rebuild(d);
    check('删除全部实体时报错（不静默成功）', featureErrors(d).length > 0, featureErrors(d).join('; '));
  }

  {
    const d = splitDoc();
    d.add(delFeature([5]));
    rebuild(d);
    check('实体下标越界时报错', featureErrors(d).length > 0, featureErrors(d).join('; '));
  }

  {
    const d = splitDoc();
    d.add(delFeature([]));
    rebuild(d);
    check('未勾选任何实体时报错', featureErrors(d).length > 0, featureErrors(d).join('; '));
  }
}

// ============================================================
// F. 组合（多实体布尔）
// ============================================================
console.log('\n▶ F. 组合');
{
  // 前置：两个 20³ 长方体，B 从 x=100 搬回 x=10 → 与 A 重叠 10×20×20 = 4000
  const overlapDoc = () => {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20)); // A: [0,20]³
    d.add({
      id: newId('f'), type: 'primitive', name: '长方体2',
      params: { kind: 'box', dims: [20, 20, 20], origin: [100, 0, 0], operation: 'new' },
    } as Feature);
    // 用包围盒定位 B 的下标（不依赖 bodiesOf 的展开顺序），把它搬到 x=10
    const mid = rebuild(d);
    const farIdx = S.bodiesOf(mid).findIndex((b) => S.shapeBBox(b).min[0] > 50);
    d.add({
      id: newId('f'), type: 'moveBody', name: '移动',
      params: { delta: [-90, 0, 0], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 0, indices: [farIdx] },
    } as MoveBodyFeature); // B → [10,30]
    return d;
  };
  const combineFeature = (mainIndex: number, toolIndices: number[], operation: CombineOp): CombineFeature =>
    ({ id: newId('f'), type: 'combine', name: '组合', params: { mainIndex, toolIndices, operation } }) as CombineFeature;

  {
    const d = overlapDoc();
    const s = rebuild(d);
    check(
      '前置：两个相交长方体 → 2 实体 / 体积 16000',
      featureErrors(d).length === 0 && solidsOf(s) === 2 && nearRel(volOf(s), 16000, 1e-3),
      `${solidsOf(s)} 实体 · ${volOf(s).toFixed(2)}`
    );
  }

  {
    const d = overlapDoc();
    d.add(combineFeature(0, [1], 'add'));
    const s = rebuild(d);
    check('组合（添加）求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('添加后合成 1 个实体', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    check('添加后体积 = 12000（并集去重）', nearRel(volOf(s), 12000, 1e-3), volOf(s).toFixed(2));
  }

  {
    const d = overlapDoc();
    d.add(combineFeature(0, [1], 'subtract'));
    const s = rebuild(d);
    check('减除求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('减除后 1 个实体', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    check('减除后体积 = 4000（挖掉重叠块）', nearRel(volOf(s), 4000, 1e-3), volOf(s).toFixed(2));
  }

  {
    const d = overlapDoc();
    d.add(combineFeature(0, [1], 'common'));
    const s = rebuild(d);
    check('共同（交集）求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('交集后 1 个实体', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    check('交集后体积 = 4000（只有重叠块）', nearRel(volOf(s), 4000, 1e-3), volOf(s).toFixed(2));
  }

  // 未选中的实体原样保留
  {
    const d = overlapDoc();
    d.add({
      id: newId('f'), type: 'primitive', name: '长方体3',
      params: { kind: 'box', dims: [20, 20, 20], origin: [0, 0, 200], operation: 'new' },
    } as Feature); // C：远离
    const s0 = rebuild(d);
    check('前置：3 个实体', solidsOf(s0) === 3, `${solidsOf(s0)} 实体`);
    // `bodiesOf` 的展开顺序由拓扑决定，不保证等于插入顺序。
    // 用包围盒识别出「远离的那个」，确保组合作用在另外两个上（与顺序无关）。
    const bodies = S.bodiesOf(s0);
    const farIdx = bodies.findIndex((b) => S.shapeBBox(b).min[2] > 100);
    check('前置：能按几何识别出远离的实体', farIdx >= 0, `farIdx=${farIdx}`);
    const pair = [0, 1, 2].filter((i) => i !== farIdx);
    d.add(combineFeature(pair[0], [pair[1]], 'add'));
    const s = rebuild(d);
    check('组合只影响选中实体，其余原样保留 → 2 实体', solidsOf(s) === 2, `${solidsOf(s)} 实体`);
    check('总体积 = 12000 + 8000 = 20000', nearRel(volOf(s), 20000, 1e-3), volOf(s).toFixed(2));
  }

  // 主体被完全切除 → 报错
  {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20)); // A: [0,20]³
    d.add({
      id: newId('f'), type: 'primitive', name: '大箱',
      params: { kind: 'box', dims: [60, 60, 60], origin: [200, 0, 0], operation: 'new' },
    } as Feature); // B 先放远处——否则与 A 相交会被 fuse 合并成一个实体
    const mid = rebuild(d);
    check('前置：大箱与主体是 2 个独立实体', solidsOf(mid) === 2, `${solidsOf(mid)} 实体`);
    // 把大箱搬到包住 A 的位置
    const farIdx = S.bodiesOf(mid).findIndex((b) => S.shapeBBox(b).min[0] > 100);
    d.add({
      id: newId('f'), type: 'moveBody', name: '移动',
      params: { delta: [-220, -20, -20], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 0, indices: [farIdx] },
    } as MoveBodyFeature);
    const mid2 = rebuild(d);
    const bodies2 = S.bodiesOf(mid2);
    const bigIdx = bodies2.findIndex((b) => S.shapeBBox(b).max[0] - S.shapeBBox(b).min[0] > 50);
    const smallIdx = [0, 1].find((i) => i !== bigIdx) as number;
    check('前置：大箱已包住主体', bigIdx >= 0 && smallIdx !== undefined, `big=${bigIdx} small=${smallIdx}`);
    d.add(combineFeature(smallIdx, [bigIdx], 'subtract'));
    rebuild(d);
    check('主体被工具体完全切除时报错', featureErrors(d).length > 0, featureErrors(d).join('; '));
  }

  // 交集为空 → 报错
  {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20));
    d.add({
      id: newId('f'), type: 'primitive', name: '长方体2',
      params: { kind: 'box', dims: [20, 20, 20], origin: [100, 0, 0], operation: 'new' },
    } as Feature);
    d.add(combineFeature(0, [1], 'common'));
    rebuild(d);
    check('主体与工具体没有公共体积时报错', featureErrors(d).length > 0, featureErrors(d).join('; '));
  }

  {
    const d = overlapDoc();
    d.add(combineFeature(0, [9], 'add'));
    rebuild(d);
    check('工具体下标越界时报错', featureErrors(d).length > 0, featureErrors(d).join('; '));
  }

  {
    // 语义扩展：空 toolIndices = 「其余全部实体」（AI 层「把两个实体合并」就靠这条）
    const d = overlapDoc();
    d.add(combineFeature(0, [], 'add'));
    const s = rebuild(d);
    check('空 toolIndices = 其余全部实体 → 无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('  两块相交 20³ 合并 → 1 个实体', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
  }
}

// ============================================================
console.log('\n▶ G. 「新建实体」多实体语义');
{
  // 两个**相交**的 20³ 长方体（错开 10）：'new' 应保持 2 个独立实体、体积相加；
  // 'add' 才应融合成 1 个实体。
  const mkTwo = (op: 'new' | 'add') => {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20)); // A: [0,20]³
    d.add({
      id: newId('f'), type: 'primitive', name: '长方体2',
      params: { kind: 'box', dims: [20, 20, 20], origin: [10, 0, 0], operation: op },
    } as Feature); // B: [10,30]×[0,20]²，与 A 重叠 10×20×20 = 4000
    return d;
  };

  {
    const d = mkTwo('new');
    const s = rebuild(d);
    check('「新建实体」求值无错误', featureErrors(d).length === 0, featureErrors(d).join('; '));
    check('相交的两个「新建实体」保持 2 个独立实体', solidsOf(s) === 2, `${solidsOf(s)} 实体`);
    check('体积相加（不融合）8000 + 8000 = 16000', nearRel(volOf(s), 16000, 1e-3), volOf(s).toFixed(2));
  }

  {
    const d = mkTwo('add');
    const s = rebuild(d);
    check('「添加」把相交实体融合成 1 个实体', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    check('「添加」体积 = 8000+8000−4000 = 12000', nearRel(volOf(s), 12000, 1e-3), volOf(s).toFixed(2));
  }

  {
    // 三个依次叠加的「新建实体」→ 3 个独立实体
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20));
    d.add({ id: newId('f'), type: 'primitive', name: '长方体2',
      params: { kind: 'box', dims: [20, 20, 20], origin: [10, 0, 0], operation: 'new' } } as Feature);
    d.add({ id: newId('f'), type: 'primitive', name: '长方体3',
      params: { kind: 'box', dims: [20, 20, 20], origin: [20, 0, 0], operation: 'new' } } as Feature);
    const s = rebuild(d);
    check('三次「新建实体」→ 3 个独立实体', solidsOf(s) === 3, `${solidsOf(s)} 实体`);
    check('体积 = 3 × 8000 = 24000', nearRel(volOf(s), 24000, 1e-3), volOf(s).toFixed(2));
  }
}

// ============================================================
console.log('\n【H. 多实体语义扩展：负数下标 · 空工具体】');
{
  /** 20³ 长方体 + 沿 X 错开 offset 的第二块（operation='new' 保持独立实体） */
  function twoBoxes(offset: number): CadDocument {
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20));
    d.add({
      id: newId('f'),
      type: 'primitive',
      name: '长方体2',
      params: { kind: 'box', dims: [20, 20, 20], origin: [offset, 0, 0], operation: 'new' },
    } as Feature);
    return d;
  }

  {
    // deleteBody 负数下标：-1 = 最后一个（bodiesOf 展开顺序由拓扑决定，用负数才可靠）
    const d = twoBoxes(30);
    const before = solidsOf(rebuild(d));
    d.add({
      id: newId('f'),
      type: 'deleteBody',
      name: '删除实体1',
      params: { indices: [-1] },
    } as Feature);
    const s = rebuild(d);
    check('删除实体前是 2 个实体', before === 2, `${before} 实体`);
    check('deleteBody indices=[-1] → 删掉最后一个，剩 1 个', solidsOf(s) === 1, `${solidsOf(s)} 实体`);
    check('  体积 = 8000（剩下原件）', nearRel(volOf(s), 8000, 1e-3), volOf(s).toFixed(2));
  }

  {
    // 越界负数：-3 对 2 个实体 → 归一成 -1，越界报错
    const d = twoBoxes(30);
    d.add({
      id: newId('f'),
      type: 'deleteBody',
      name: '删除实体1',
      params: { indices: [-3] },
    } as Feature);
    const { errors } = rebuildFeatures(d.features);
    check('deleteBody indices=[-3] 越界 → 明确报错', errors.length === 1 && /越界/.test(errors[0].message),
      errors.map((e) => e.message).join('; '));
  }

  {
    // combine 空工具体 = 「其余全部实体」：两块 20³ 错开 10（重叠 4000）
    for (const [op, exp] of [['add', 12000], ['subtract', 4000], ['common', 4000]] as const) {
      const d = twoBoxes(10);
      d.add({
        id: newId('f'),
        type: 'combine',
        name: '组合1',
        params: { mainIndex: 0, toolIndices: [], operation: op },
      } as Feature);
      const s = rebuild(d);
      check(`combine 空 toolIndices（${op}）→ 体积 ${exp}`, nearRel(volOf(s), exp, 1e-3), volOf(s).toFixed(2));
    }
  }

  {
    // combine 单实体 + 空工具体 → 没有其它实体，应报错而不是静默通过
    const d = new CadDocument();
    d.add(boxFeature(20, 20, 20));
    d.add({
      id: newId('f'),
      type: 'combine',
      name: '组合1',
      params: { mainIndex: 0, toolIndices: [], operation: 'add' },
    } as Feature);
    const { errors } = rebuildFeatures(d.features);
    check('combine 只有 1 个实体 → 报「没有选择工具体」',
      errors.length === 1 && /没有选择工具体/.test(errors[0].message),
      errors.map((e) => e.message).join('; '));
  }

  {
    // moveBody 仍按原语义：indices 省略 = 全部实体
    const d = twoBoxes(30);
    d.add({
      id: newId('f'),
      type: 'moveBody',
      name: '移动1',
      params: { delta: [0, 0, 100], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 0 },
    } as Feature);
    const s = rebuild(d);
    check('moveBody 省略 indices → 两个实体一起抬升', solidsOf(s) === 2, `${solidsOf(s)} 实体`);
    check('  体积守恒 = 16000', nearRel(volOf(s), 16000, 1e-3), volOf(s).toFixed(2));
    const bb = S.shapeBBox(s);
    check('  包围盒整体上移 100（Z ∈ [100,120]）', nearRel(bb.min[2], 100, 1e-3) && nearRel(bb.max[2], 120, 1e-3),
      `Z ∈ [${bb.min[2].toFixed(2)}, ${bb.max[2].toFixed(2)}]`);
  }
}

// ============================================================
console.log(`\n${'='.repeat(56)}`);
console.log(`实体编辑测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
