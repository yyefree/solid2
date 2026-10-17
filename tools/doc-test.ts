/**
 * 文档/特征引擎集成测试。
 *
 * 适配 Worker 重构后的架构：文档数据在 `src/doc/model.ts`（纯数据），
 * 求值在 `src/doc/engine.ts` 的 `rebuildFeatures()`（仅内核侧调用）。
 * 本测试直接在 Node 里注入 OCCT，跳过 Worker，直接驱动 engine。
 *
 * 运行: node tools/run-ts.mjs tools/doc-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument, newSketchFeature, makeEdgeRef, makeFaceRef } from '../src/doc/model';
import { resolveExpressions } from '../src/doc/expr';
import { rebuildFeatures } from '../src/doc/engine';
import { faceInfos, featureEdgeInfos } from '../src/doc/topo';
import { emptySketch, newId, type Sketch } from '../src/sketch/types';
import type { Feature, FeatureId } from '../src/doc/types';

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

/**
 * 重放整棵特征树（等价于 Worker 的 opRebuild 求值部分），
 * 把错误回写到特征上，返回最终 TopoDS（仅在 Node/Worker 内有效）。
 */
function rebuild(doc: CadDocument, upto?: FeatureId): any {
  const { shape, errors } = rebuildFeatures(doc.features, upto);
  for (const f of doc.features) f.error = undefined;
  for (const e of errors) {
    const f = doc.getFeature(e.id);
    if (f) f.error = e.message;
  }
  doc.rebuildCount++;
  return shape;
}

// ---------- 草图构造助手 ----------
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
function circleSketch(cx: number, cy: number, r: number): Sketch {
  const sk = emptySketch();
  const c = newId('p');
  sk.points[c] = { id: c, x: cx, y: cy };
  sk.entities.push({ id: newId('e'), kind: 'circle', c, r });
  return sk;
}

// ---------- 1. 板 + 孔 ----------
console.log('【板 + 孔】');
const doc = new CadDocument();
{
  const sk1 = newSketchFeature('front', rectSketch(60, 40));
  doc.add(sk1);
  const ex1: Feature = {
    id: newId('f'),
    type: 'extrude',
    name: '拉伸1',
    params: { sketchId: sk1.id, distance: 10, operation: 'new' },
  };
  doc.add(ex1);

  const sk2 = newSketchFeature('front', circleSketch(22, 20, 6));
  doc.add(sk2);
  const ex2: Feature = {
    id: newId('f'),
    type: 'extrude',
    name: '拉伸2',
    // 距离给足，保证是通孔（否则改板厚时孔会变成盲孔）
    params: { sketchId: sk2.id, distance: 60, operation: 'cut' },
  };
  doc.add(ex2);

  const shape = rebuild(doc);
  const v = S.volume(shape);
  const expect = (60 * 40 - Math.PI * 36) * 10;
  check('板 + 孔 体积', near(v, expect, 1), `= ${v.toFixed(2)} / 期望 ${expect.toFixed(2)}`);
  check('重建无错误', doc.features.every((f) => !f.error), doc.features.map((f) => f.error).filter(Boolean).join('; '));
}

// ---------- 2. 参数化修改 ----------
console.log('\n【参数化修改】');
{
  const ex1 = doc.features[1] as any;
  ex1.params.distance = 25;
  const v = S.volume(rebuild(doc));
  const expect = (60 * 40 - Math.PI * 36) * 25;
  check('改拉伸深度后体积更新', near(v, expect, 1), `= ${v.toFixed(2)} / 期望 ${expect.toFixed(2)}`);
  ex1.params.distance = 10;
  rebuild(doc);
}

// ---------- 3. 圆角（几何引用） ----------
console.log('\n【圆角（几何引用解析）】');
{
  const shape = rebuild(doc);
  const infos = featureEdgeInfos(shape); // 只取特征边（缝合线已被剔除）
  check('可提取特征边', infos.length > 0, `${infos.length} 条特征边`);
  // 四条竖直侧棱：方向平行于 Z、长度 = 板厚
  const vertical = infos.filter((i) => Math.abs(Math.abs(i.dir[2]) - 1) < 1e-6 && i.length > 9);
  check('找到 4 条竖直侧棱', vertical.length === 4, `${vertical.length} 条`);
  const before = S.volume(shape);
  const fil: Feature = {
    id: newId('f'),
    type: 'fillet',
    name: '圆角1',
    params: { edges: vertical.slice(0, 4).map(makeEdgeRef), radius: 3 },
  };
  doc.add(fil);
  const after = S.volume(rebuild(doc));
  check('圆角无错误', !fil.error, fil.error ?? '');
  check('圆角后体积减小', after < before, `${before.toFixed(1)} → ${after.toFixed(1)}`);

  // 改半径 → 重建
  (fil.params as any).radius = 5;
  const after2 = S.volume(rebuild(doc));
  check('改半径后重新求解', after2 < after, `r=3: ${after.toFixed(1)} → r=5: ${after2.toFixed(1)}`);
  (fil.params as any).radius = 3;
  rebuild(doc);
}

// ---------- 4. 抽壳（面引用） ----------
console.log('\n【抽壳（面引用解析）】');
{
  const infos = faceInfos(rebuild(doc));
  const top = infos
    .filter((i) => Math.abs(i.normal[2] - 1) < 1e-3)
    .sort((a, b) => b.centroid[2] - a.centroid[2])[0];
  check('找到顶面', !!top, top ? `z = ${top.centroid[2].toFixed(2)}` : '');
  if (top) {
    const before = S.volume(rebuild(doc));
    const sh: Feature = {
      id: newId('f'),
      type: 'shell',
      name: '抽壳1',
      params: { faces: [makeFaceRef(top)], thickness: 1.5 },
    };
    doc.add(sh);
    const after = S.volume(rebuild(doc));
    check('抽壳无错误', !sh.error, sh.error ?? '');
    check('抽壳后体积减小', after < before, `${before.toFixed(1)} → ${after.toFixed(1)}`);
    doc.remove(sh.id);
    rebuild(doc);
  }
}

// ---------- 5. 阵列一个孔 ----------
console.log('\n【阵列孔】');
{
  const holeFeature = doc.features[3]; // 拉伸2（cut）
  const filletFeature = doc.features[4]; // 圆角1：先压缩，避免干扰体积核对
  filletFeature.suppressed = true;
  const pat: Feature = {
    id: newId('f'),
    type: 'linearPattern',
    name: '线性阵列1',
    // 间距 13、3 个 → x = 22 / 35 / 48，三个孔互不重叠且都完整落在板内
    params: { seedFeatureId: holeFeature.id, direction: [1, 0, 0], spacing: 13, count: 3 },
  };
  doc.add(pat);
  const v = S.volume(rebuild(doc));
  check('阵列无错误', !pat.error, pat.error ?? '');
  const expect = (60 * 40 - 3 * Math.PI * 36) * 10;
  check('三个孔的体积', near(v, expect, 2), `= ${v.toFixed(2)} / 期望 ${expect.toFixed(2)}`);
  doc.remove(pat.id);
  filletFeature.suppressed = false;
  rebuild(doc);
}

// ---------- 6. 压缩 / 回退 / 重排 ----------
console.log('\n【压缩与重建】');
{
  const v0 = S.volume(rebuild(doc));
  const hole = doc.features[3];
  hole.suppressed = true;
  const vSuppressed = S.volume(rebuild(doc));
  // 注意：圆角特征仍在，所以不是精确的 24000
  check('压缩孔特征后体积增大', vSuppressed > v0, `${v0.toFixed(1)} → ${vSuppressed.toFixed(1)}`);
  hole.suppressed = false;
  const vRestored = S.volume(rebuild(doc));
  check('恢复后回到原体积', near(vRestored, v0, 0.01));

  // 回退到第 2 个特征（只到拉伸1，无孔无圆角）
  const rolledBack = S.volume(rebuild(doc, doc.features[1].id));
  check('回退重建（只到拉伸1）', near(rolledBack, 60 * 40 * 10, 1), `= ${rolledBack.toFixed(2)}`);
  rebuild(doc);
}

// ---------- 7. 序列化往返 ----------
console.log('\n【序列化】');
{
  const v0 = S.volume(rebuild(doc));
  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  const doc2 = CadDocument.fromJSON(json);
  const v2 = S.volume(rebuild(doc2));
  check('JSON 往返后体积一致', near(v2, v0, 0.01), `${v0.toFixed(2)} vs ${v2.toFixed(2)}`);
  check('特征数量一致', doc2.features.length === doc.features.length,
    `${doc2.features.length} vs ${doc.features.length}`);
}

// ---------- 7b. 快照解耦（toJSON 必须深拷贝 params） ----------
// 撤销快照直接存 toJSON() 结果。若只浅拷贝，快照的 params 与实时文档共享同一对象，
// 之后 Object.assign(f.params, patch) 会连快照一起改掉 → 撤销恢复不出旧值。
console.log('\n【快照解耦】');
{
  const live = doc.features.find((f) => f.type === 'extrude');
  const snap = doc.toJSON();
  const snapF = snap.features.find((f) => f.type === 'extrude');
  if (live && snapF) {
    const p0 = (live.params as { distance: number }).distance;
    const s0 = (snapF.params as { distance: number }).distance;
    (live.params as { distance: number }).distance = p0 + 100; // 模拟 updateFeatureParams
    const s1 = (snapF.params as { distance: number }).distance;
    check('toJSON 快照与实时文档解耦（改实时参数不影响快照）', s0 === p0 && s1 === p0,
      `快照 ${s0}→${s1}，实时 ${p0}→${p0 + 100}`);
    (live.params as { distance: number }).distance = p0; // 复原
  } else {
    check('toJSON 快照与实时文档解耦（改实时参数不影响快照）', false, '未找到 extrude 特征');
  }
}

// ---------- 8. 错误处理 ----------
console.log('\n【错误处理】');
{
  const d = new CadDocument();
  const bad: Feature = {
    id: newId('f'),
    type: 'extrude',
    name: '拉伸X',
    params: { sketchId: 'nope', distance: 5, operation: 'new' },
  };
  d.add(bad);
  const shape = rebuild(d);
  check('引用缺失草图时报错但不崩溃', !!bad.error, bad.error ?? '(无错误)');
  check('最终实体为空', shape === null);
}

// ---------- 9. 表达式驱动几何（参考 FreeCAD Expressions） ----------
console.log('\n【表达式驱动几何】');
{
  /** 先解析表达式、再把解析后的具体数值交给引擎重放 */
  function rebuildResolved(d: CadDocument): any {
    const r = resolveExpressions(d);
    const { shape, errors } = rebuildFeatures(r.features);
    for (const f of d.features) f.error = undefined;
    for (const e of errors) {
      const f = d.getFeature(e.id);
      if (f) f.error = e.message;
    }
    for (const fi of r.featureIssues) {
      const f = d.getFeature(fi.id);
      if (f) f.error = fi.message;
    }
    return shape;
  }

  const d = new CadDocument();
  const sk = newSketchFeature('front', rectSketch(50, 30));
  d.add(sk);
  const ex: Feature = {
    id: newId('f'),
    type: 'extrude',
    name: '拉伸1',
    params: { sketchId: sk.id, distance: 1, operation: 'new' },
    expressions: { distance: '=板厚' },
  };
  d.add(ex);
  d.setParam('板厚', '8');

  const v1 = S.volume(rebuildResolved(d));
  check('全局参数驱动拉伸深度（板厚=8）', near(v1, 50 * 30 * 8, 1), `= ${v1.toFixed(2)} / 期望 12000`);
  check('文档里的字面值未被解析过程修改', (ex.params as any).distance === 1);
  check('无表达式问题', (d.features[0].error ?? null) === null && (ex.error ?? null) === null,
    [d.features[0].error, ex.error].filter(Boolean).join('; '));

  // 改全局参数 → 几何联动（FreeCAD 的核心体验）
  d.setParam('板厚', '20');
  const v2 = S.volume(rebuildResolved(d));
  check('改参数后几何自动联动（板厚=20）', near(v2, 50 * 30 * 20, 1), `= ${v2.toFixed(2)} / 期望 30000`);

  // 参数引用特征属性 + 特征再引用参数（跨链）
  d.setParam('孔深', '拉伸1.distance*2'); // = 40
  const sk2 = newSketchFeature('front', circleSketch(25, 15, 5));
  d.add(sk2);
  const cut: Feature = {
    id: newId('f'),
    type: 'extrude',
    name: '拉伸2',
    params: { sketchId: sk2.id, distance: 1, operation: 'cut' },
    expressions: { distance: '=孔深' },
  };
  d.add(cut);
  const v3 = S.volume(rebuildResolved(d));
  const expect3 = (50 * 30 - Math.PI * 25) * 20;
  check('参数引用特征属性、特征再引用参数', near(v3, expect3, 2), `= ${v3.toFixed(2)} / 期望 ${expect3.toFixed(2)}`);

  // 表达式出错时：特征被标红、几何退回字面值
  const bad = d.getFeature(cut.id)!;
  (bad as any).expressions = { distance: '不存在的参数' };
  const shapeBad = rebuildResolved(d);
  check('表达式错误回写到特征 error', /未知参数/.test(bad.error ?? ''), bad.error ?? '(无错误)');
  check('出错时退回字面值（盲孔，体积变大）', S.volume(shapeBad) > v3, `${S.volume(shapeBad).toFixed(1)} > ${v3.toFixed(1)}`);
  (bad as any).expressions = { distance: '=孔深' };
  rebuildResolved(d);

  // 序列化往返：参数表与表达式都要保住
  const round = CadDocument.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
  check('序列化保留参数表', round.params.length === 2 && round.params.some((p) => p.name === '孔深'),
    JSON.stringify(round.params.map((p) => p.name)));
  const cut2 = round.features.find((f) => f.name === '拉伸2')!;
  check('序列化保留特征表达式', (cut2 as any).expressions?.distance === '=孔深',
    JSON.stringify((cut2 as any).expressions));
  check('往返后体积一致', near(S.volume(rebuildResolved(round)), v3, 2));
}

// ---------- 10. 性能 ----------
console.log('\n【性能】');
{
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) rebuild(doc);
  const ms = (performance.now() - t0) / 10;
  check('平均重建耗时 < 500ms', ms < 500, `${ms.toFixed(1)} ms/次`);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
