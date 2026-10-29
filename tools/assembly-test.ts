/**
 * 装配体配合求解测试（纯 three.js，无 OCCT）。
 *
 * 覆盖：可视化拾取产生的"局部几何参考"（localPoint/localDir）驱动的配合求解：
 * 重合、同心、距离、平行。验证组件被移动到满足约束的位置。
 */
import * as THREE from 'three';
import { CadDocument } from '../src/doc/model';

// assembly.ts 在模块加载时构造内核 Worker；Node 无 Worker，注入空桩（测试不触发内核）。
class StubWorker {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  terminate(): void {}
}
(globalThis as unknown as { Worker: unknown }).Worker = StubWorker;
const { Assembly, mateRefLabel } = await import('../src/app/assembly');
type MateRef = import('../src/app/assembly').MateRef;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

function emptyDoc(): CadDocument {
  return new CadDocument();
}
const ref = (comp: string, p: [number, number, number], d: [number, number, number]): MateRef => ({
  comp,
  localPoint: p,
  localDir: d,
  kind: 'planar',
});

// ---------- 1. 重合：两个平行面法向反向对齐 ----------
console.log('【重合配合（可视拾取参考）】');
{
  const a = new Assembly();
  const c1 = a.addComponent(emptyDoc(), 'A');
  const c2 = a.addComponent(emptyDoc(), 'B');
  c2.fixed = false;
  c1.fixed = true;
  c2.position = [10, 3, 2];
  // A 的顶面（法向 +Z），B 的底面（法向 -Z）
  a.mates.push({
    id: 'm1', type: 'coincident', name: 'M',
    a: ref(c1.id, [0, 0, 5], [0, 0, 1]),
    b: ref(c2.id, [0, 0, 0], [0, 0, -1]),
  });
  const r = a.solve();
  check('求解收敛', r.residual < 1e-3, `residual=${r.residual.toExponential(1)} iters=${r.iterations}`);
  // B 的底面应贴到 A 的顶面 z=5，且法向相反 → B 原点在 z=5
  check('B 底面贴合 z=5', near(c2.position[2], 5, 0.05), `z=${c2.position[2].toFixed(4)}`);
}

// ---------- 2. 同心：两轴共线 ----------
console.log('\n【同心配合】');
{
  const a = new Assembly();
  const c1 = a.addComponent(emptyDoc(), 'A');
  const c2 = a.addComponent(emptyDoc(), 'B');
  c1.fixed = true;
  c2.fixed = false;
  c2.position = [7, 9, 1];
  // 轴：沿 Z，散布点不同 → 求解后应轴向对齐（垂直分量归零）
  a.mates.push({
    id: 'm1', type: 'concentric', name: 'M',
    a: ref(c1.id, [0, 0, 0], [0, 0, 1]),
    b: ref(c2.id, [0, 0, 0], [0, 0, 1]),
  });
  a.solve();
  // 两轴共线：B 原点在 A 轴（x=y=0）
  check('B 轴对齐到 A 轴', near(c2.position[0], 0, 0.05) && near(c2.position[1], 0, 0.05),
    `xy=(${c2.position[0].toFixed(3)}, ${c2.position[1].toFixed(3)})`);
}

// ---------- 3. 距离：平行面间保持间距 ----------
console.log('\n【距离配合】');
{
  const a = new Assembly();
  const c1 = a.addComponent(emptyDoc(), 'A');
  const c2 = a.addComponent(emptyDoc(), 'B');
  c1.fixed = true;
  c2.fixed = false;
  c2.position = [0, 0, 0];
  a.mates.push({
    id: 'm1', type: 'distance', name: 'M', value: 10,
    a: ref(c1.id, [0, 0, 0], [0, 0, 1]),
    b: ref(c2.id, [0, 0, 0], [0, 0, 1]),
  });
  a.solve();
  const worldB = new THREE.Vector3(...c2.position);
  const dist = worldB.dot(new THREE.Vector3(0, 0, 1));
  check('间距 = 10', near(Math.abs(dist), 10, 0.05), `dist=${dist.toFixed(3)}`);
}

// ---------- 4. 平行：法向对齐 ----------
console.log('\n【平行配合】');
{
  const a = new Assembly();
  const c1 = a.addComponent(emptyDoc(), 'A');
  const c2 = a.addComponent(emptyDoc(), 'B');
  c1.fixed = true;
  c2.fixed = false;
  c2.rotation = [0, 0, 0];
  a.mates.push({
    id: 'm1', type: 'parallel', name: 'M',
    a: ref(c1.id, [0, 0, 0], [0, 0, 1]),
    b: ref(c2.id, [0, 0, 0], [0, 1, 1]),
  });
  a.solve();
  // B 的局部 dir (0,1,1) 旋转后应平行于 (0,0,1)
  const m = a.matrixOf(c2);
  const d = new THREE.Vector3(0, 1, 1).normalize().applyMatrix3(new THREE.Matrix3().setFromMatrix4(m));
  const dot = Math.abs(d.dot(new THREE.Vector3(0, 0, 1)));
  check('B 面法向平行于 A', near(dot, 1, 0.01), `|dot|=${dot.toFixed(4)}`);
}

// ---------- 5. 圆柱面/轴线参考（可视化拾取圆柱面或圆边产生）----------
console.log('\n【轴线参考（圆柱面/圆边拾取）】');
{
  const a = new Assembly();
  const c1 = a.addComponent(emptyDoc(), 'A');
  const c2 = a.addComponent(emptyDoc(), 'B');
  c1.fixed = true;
  c2.fixed = false;
  c2.position = [3, 4, 7];
  // 圆柱面拾取：轴线上一点 + 轴向；注意 A 的轴点沿轴偏 -390（圆柱轴位置任意）
  const cylRef = (comp: string, p: [number, number, number]): MateRef => ({
    comp, localPoint: p, localDir: [0, 0, 1], kind: 'cylindrical', isAxis: true, radius: 3,
  });
  a.mates.push({
    id: 'm1', type: 'concentric', name: 'M',
    a: cylRef(c1.id, [10, 20, -390]),
    b: cylRef(c2.id, [0, 0, 0]),
  });
  const r = a.solve();
  check('轴线同心收敛', r.residual < 1e-3, `residual=${r.residual.toExponential(1)}`);
  check('B 轴心对齐到 (10,20)', near(c2.position[0], 10, 0.05) && near(c2.position[1], 20, 0.05),
    `xy=(${c2.position[0].toFixed(3)}, ${c2.position[1].toFixed(3)})`);
  check('标签显示为圆柱轴 Φ', mateRefLabel(cylRef(c1.id, [0, 0, 0])) === '圆柱/轴 Φ6.0',
    mateRefLabel(cylRef(c1.id, [0, 0, 0])));
  check('棱边标签', mateRefLabel({ ...cylRef(c1.id, [0, 0, 0]), kind: 'edge' }) === '棱边');
  check('平面标签', mateRefLabel(ref(c1.id, [0, 0, 0], [0, 0, 1])) === '平面');
}

// ---------- 6. 明细表（BOM）数量联动 ----------
console.log('\n【BOM 数量联动】');
{
  function packedDoc(dims: [number, number, number]): CadDocument {
    const doc = emptyDoc();
    doc.add({ id: 'f1', type: 'primitive', name: '基本体1', params: { kind: 'box', dims, operation: 'new' } } as never);
    return doc;
  }
  const a = new Assembly();
  const base = packedDoc([10, 10, 10]);
  a.addComponent(base, '底座');
  a.insertFromDocument(base, '底座副本'); // 同特征 → 应合并
  a.addComponent(packedDoc([5, 5, 5]), '轴');
  const rows = a.bomEntries();
  check('同类零件数量合并为 2',
    rows.some((r) => r.name === '底座' && r.qty === 2),
    JSON.stringify(rows.map((r) => `${r.name}:${r.qty}`)));
  check('独立零件数量为 1',
    rows.some((r) => r.name === '轴' && r.qty === 1),
    JSON.stringify(rows.map((r) => `${r.name}:${r.qty}`)));
  const first = a.components[0];
  a.removeComponent(first.id);
  const rows2 = a.bomEntries();
  check('删除组件后数量联动为 1',
    rows2.length === 2 && rows2.some((r) => (r.name === '底座' || r.name === '底座副本') && r.qty === 1),
    JSON.stringify(rows2.map((r) => `${r.name}:${r.qty}`)));
}

// ---------- 7. 序列化往返 + 与快照解耦（撤销栈依赖）----------
console.log('\n【序列化往返 / 快照解耦】');
{
  function boxDoc(dims: [number, number, number]): CadDocument {
    const doc = emptyDoc();
    doc.add({ id: 'f1', type: 'primitive', name: '基本体1', params: { kind: 'box', dims, operation: 'new' } } as never);
    return doc;
  }
  const a = new Assembly();
  const c1 = a.addComponent(boxDoc([10, 10, 10]), '底座');
  const c2 = a.addComponent(boxDoc([5, 5, 5]), '轴');
  c1.fixed = true;
  c2.position = [3, 4, 5];
  c2.rotation = [0.1, 0.2, 0.3];
  c2.explodeDir = [1, 0, 0];
  a.explodeAmount = 12;
  a.mates.push({
    id: 'm1', type: 'distance', name: '距离1',
    a: ref(c1.id, [0, 0, 0], [0, 0, 1]),
    b: ref(c2.id, [1, 2, 3], [0, 0, 1]),
    value: 25,
  });

  const json = a.toJSON();
  const b = Assembly.fromJSON(JSON.parse(JSON.stringify(json)));
  check('往返后组件数一致', b.components.length === 2, `n=${b.components.length}`);
  check('往返后名称/固定/位姿保留',
    b.components[0].name === '底座' && b.components[0].fixed === true &&
    near(b.components[1].position[1], 4) && near(b.components[1].rotation[2], 0.3),
    `${b.components[1].name} pos=${b.components[1].position.map(v => v.toFixed(1)).join(',')}`);
  check('往返后爆炸距离保留', near(b.explodeAmount, 12), `explode=${b.explodeAmount}`);
  check('往返后配合保留',
    b.mates.length === 1 && b.mates[0].type === 'distance' && b.mates[0].value === 25 &&
    near(b.mates[0].b.localPoint[2], 3),
    JSON.stringify(b.mates[0]?.b?.localPoint));
  check('往返后组件零件文档特征保留',
    (b.components[1].doc.toJSON().features ?? []).length === 1,
    `features=${(b.components[1].doc.toJSON().features ?? []).length}`);
  check('往返后视图为 null（网格由 syncScene 重建）', b.components[0].view === null);

  // ⚠️ 撤销快照直接存 toJSON() 的结果 → 快照必须与实时对象**无共享引用**
  const snap = a.toJSON();
  a.mates[0].b.localPoint[0] = 999;
  a.mates[0].value = 777;
  a.components[1].position[0] = 999;
  check('改实时配合坐标不污染快照', snap.mates[0].b.localPoint[0] !== 999,
    `snap=${snap.mates[0].b.localPoint[0]}`);
  check('改实时配合数值不污染快照', snap.mates[0].value === 25, `snap=${snap.mates[0].value}`);
  check('改实时组件位姿不污染快照', snap.components[1].position[0] !== 999,
    `snap=${snap.components[1].position[0]}`);

  // fromJSON 也不能把入参数组的引用直接交给实时对象（否则 push 会改快照）
  const snap2 = a.toJSON();
  const c = Assembly.fromJSON(snap2);
  c.mates.push({
    id: 'm2', type: 'coincident', name: '重合1',
    a: ref(c1.id, [0, 0, 0], [0, 0, 1]), b: ref(c2.id, [0, 0, 0], [0, 0, 1]),
  });
  check('fromJSON 后 push 配合不污染入参快照', snap2.mates.length === 1, `snap=${snap2.mates.length}`);

  // 换 Assembly 实例（撤销 / 打开项目）前必须显式释放旧视图，否则 ShapeView 常驻显存
  const d = new Assembly();
  d.addComponent(emptyDoc(), 'A');
  let disposed = 0;
  let removed = 0;
  d.components[0].view = {
    group: { removeFromParent: () => { removed++; } },
    dispose: () => { disposed++; },
  } as never;
  d.disposeViews();
  check('disposeViews 摘除并释放视图、置空引用',
    disposed === 1 && removed === 1 && d.components[0].view === null,
    `disposed=${disposed} removed=${removed} view=${d.components[0].view}`);
  d.disposeViews(); // 幂等：没有视图时不得重复释放
  check('disposeViews 幂等（无视图时不再释放）', disposed === 1, `disposed=${disposed}`);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
