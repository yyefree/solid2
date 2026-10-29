/**
 * 工程图几何与交互式尺寸标注测试（纯计算，不依赖 OCCT / DOM）。
 * 运行: node tools/run-ts.mjs tools/drawing-test.ts
 */
import { Drawing, type DrawingView } from '../src/app/drawing';

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
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/** 造一个含两条平行投影边的视图（视图局部 mm 坐标） */
function mkView(): DrawingView {
  return {
    id: 'v1',
    kind: 'front',
    label: '主视图',
    cx: 100,
    cy: 100,
    scale: 2,
    edges: [
      { pts: [[0, 0], [10, 0]], hidden: false },
      { pts: [[0, 10], [10, 10]], hidden: false },
      { pts: [[0, 0], [0, 10]], hidden: true },
    ],
    dims: [],
    holes: [],
    bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
  };
}

console.log('【投影坐标换算】');
{
  const d = new Drawing();
  d.views = [mkView()];
  const v = d.views[0];
  const s = d.toSheet(v, [0, 0]);
  // cx + 0*scale, cy - 0*scale
  check('局部原点 → 视图中心', near(s[0], 100) && near(s[1], 100), `= (${s[0]}, ${s[1]})`);
  const s2 = d.toSheet(v, [10, 10]);
  check('局部 (10,10) → 缩放+翻转 Y', near(s2[0], 120) && near(s2[1], 80), `= (${s2[0]}, ${s2[1]})`);
}

console.log('\n【单边长度标注】');
{
  const d = new Drawing();
  d.views = [mkView()];
  const v = d.views[0];
  const dim = d.dimensionRun('v1', 0, 9);
  check('生成标注对象', !!dim);
  check('端点取自投影边', !!dim && near(dim!.a[0], 0) && near(dim!.a[1], 0) && near(dim!.b[0], 10) && near(dim!.b[1], 0));
  check('标注长度 = 边×比例', !!dim && near(d.dimensionValue(v, dim!), 20), `= ${dim ? d.dimensionValue(v, dim).toFixed(3) : '?'} / 期望 20`);
  check('该边被高亮', d.selectedRuns.has('v1:0'));
  check('无效边不产生标注', d.dimensionRun('v1', 99) === null);
}

console.log('\n【两边距离标注】');
{
  const d = new Drawing();
  d.views = [mkView()];
  const v = d.views[0];
  const dim = d.dimensionBetweenRuns('v1', 0, 1, 9);
  check('生成标注对象', !!dim);
  // 最近端点对：(0,0)-(0,10) 或 (10,0)-(10,10)，距离均为 10 → ×2 = 20
  check('取最近端点对（距离 10×2=20）', !!dim && near(d.dimensionValue(v, dim!), 20), `= ${dim ? d.dimensionValue(v, dim).toFixed(3) : '?'}`);
  check('同一条边退化为长度标注', near(d.dimensionValue(v, d.dimensionBetweenRuns('v1', 0, 0)!)!, 20));
}

console.log('\n【删除 / 清空】');
{
  const d = new Drawing();
  d.views = [mkView()];
  const a = d.dimensionRun('v1', 0)!;
  d.dimensionRun('v1', 1);
  check('累积两条标注', d.views[0].dims.length === 2, `${d.views[0].dims.length} 条`);
  d.removeDim('v1', a.id);
  check('删除指定标注', d.views[0].dims.length === 1 && d.views[0].dims[0].id !== a.id);
  d.clearDims();
  check('清空全部标注', d.views[0].dims.length === 0 && d.selectedRuns.size === 0);
}

console.log('\n【SVG 输出含交互属性】');
{
  const d = new Drawing();
  d.views = [mkView()];
  d.dimensionRun('v1', 0);
  const svg = d.toSVG();
  check('投影边带 d-run 分组', svg.includes('class="d-run"') && svg.includes('data-re="0"'));
  check('投影边带视图标识', svg.includes('data-vw="v1"'));
  check('标注带 d-dim 分组', svg.includes('class="d-dim"'));
  check('隐藏线在开关打开时渲染', svg.includes('stroke-dasharray'));
  d.showHidden = false;
  const svg2 = d.toSVG();
  check('关闭隐藏线后不渲染虚线', !svg2.includes('stroke-dasharray'));
  check('SVG 是合法根元素', svg.startsWith('<svg') && svg.endsWith('</svg>'));
}

console.log('\n【自动标注】');
{
  const d = new Drawing();
  d.views = [mkView()];
  const v = d.views[0];
  const n = d.autoDimension('overall');
  check('总宽/总高共 2 条', n === 2 && v.dims.length === 2, `${n} 条`);
  const vals = v.dims.map((dim) => d.dimensionValue(v, dim));
  check('总宽 = 10×2 = 20', vals.some((x) => near(x, 20, 1e-6)), `[${vals.map((x) => x.toFixed(2)).join(', ')}]`);
  check('总高 = 10×2 = 20', vals.filter((x) => near(x, 20, 1e-6)).length === 2);

  const d2 = new Drawing();
  d2.views = [mkView()];
  const n2 = d2.autoDimension('all');
  check('all 模式含总宽高 + 直线边', n2 === 5, `${n2} 条（期望 5）`);
  check('清除了交互高亮', d2.selectedRuns.size === 0);

  // 空视图不产生标注
  const d3 = new Drawing();
  check('无视图返回 0', d3.autoDimension('all') === 0);
}

console.log('\n【尺寸公差与 φ 前缀】');
{
  const d = new Drawing();
  d.views = [mkView()];
  const dim = d.dimensionRun('v1', 0)!;
  check('生成标注对象', !!dim);
  d.setDimMeta('v1', dim.id, { tolerance: { upper: 0.1, lower: -0.1 }, prefix: 'φ' });
  const svg = d.toSVG();
  check('对称公差渲染 ±0.1', svg.includes('±0.1') || svg.includes('±0.10'), '');
  check('φ 前缀出现', svg.includes('φ'));
  const d2 = new Drawing();
  d2.views = [mkView()];
  const dim2 = d2.dimensionRun('v1', 0)!;
  d2.setDimMeta('v1', dim2.id, { tolerance: { upper: 0.2, lower: -0.1 } });
  const svg2 = d2.toSVG();
  check('非对称公差上下堆叠（+0.20 / -0.10）', svg2.includes('+0.20') && svg2.includes('-0.10'));
  check('setDimMeta 对不存在标注返回假', !d2.setDimMeta('v1', 'nope', { prefix: 'φ' }));
}

console.log('\n【形位公差（GD&T）】');
{
  const d = new Drawing();
  d.views = [mkView()];
  const g = d.addGdt('v1', 'position', 0.05, { datum: 'A', diameter: true });
  check('生成特征控制框标注', !!g);
  const svg = d.toSVG();
  check('SVG 含 d-gdt 分组与视图标识', svg.includes('class="d-gdt"') && svg.includes('data-gdt='));
  check('SVG 含基准字母与公差值', svg.includes('>A<') && svg.includes('0.05'));
  check('SVG 含直径要素符号 ⌀', svg.includes('⌀'));
  check('SVG 含引线', svg.includes('<line'));
  d.removeGdt(g!.id);
  check('删除形位公差标注', d.gdts.length === 0 && !d.toSVG().includes('data-gdt='));
  d.views = [mkView()];
  check('视图不存在时返回 null', d.addGdt('nope', 'flatness', 0.1) === null);
}

console.log('\n【孔位自动标注】');
{
  const d = new Drawing();
  const v = mkView();
  v.holes = [
    { cx: 20, cy: 12.5, dia: 6, round: 1 },
    { cx: 8, cy: 4, dia: 4, round: 0.3 },
  ];
  d.views = [v];
  const n = d.autoDimensionHoles();
  // 孔1：2 位置 + 1 直径=3；孔2：2 位置（非正圆可见 → 无直径）=2 → 共 5
  check('标注数量 = 5', n === 5, `= ${n}`);
  check('正圆孔直径标 ⌀', v.dims.some((dim) => dim.prefix === '⌀'));
  check('直径值 = 6×2 = 12', v.dims.some((dim) => d.dimensionValue(v, dim) === 12));
  const svg = d.toSVG();
  check('SVG 含孔中心十字线', svg.includes('class="d-hole"'));
}

console.log('\n【明细表（BOM）】');
{
  const d = new Drawing();
  d.setBom([
    { name: '底座', qty: 1, material: '碳钢' },
    { name: '轴', qty: 2, material: '45钢', note: '共 2 件' },
  ]);
  const svg = d.toSVG();
  check('SVG 含明细表分组', svg.includes('class="d-bom"'));
  check('表头含数量列', svg.includes('数量'));
  check('行数据数量 1 / 2', svg.includes('>1<') && svg.includes('>2<'));
  check('材料列联动', svg.includes('碳钢') && svg.includes('45钢'));
  d.clearBom();
  check('清空后不再渲染明细表', d.bom.length === 0 && !d.toSVG().includes('d-bom'));
}

console.log('\n【序列化（项目文件 / 撤销快照）】');
{
  const d = new Drawing();
  d.views = [mkView()];
  d.showHidden = false;
  d.fixedScale = 2;
  d.unitSystem = 'IPS';
  d.sheet = { ...d.sheet, title: '底板', code: 'S2-9', material: '45钢' };
  const dim = d.dimensionRun('v1', 0, 9)!;
  d.setDimMeta('v1', dim.id, { prefix: 'φ', tolerance: { upper: 0.1, lower: -0.1 } });
  d.addGdt('v1', 'position', 0.05, { datum: 'A' });
  d.setBom([{ name: '底座', qty: 1, material: '碳钢' }]);

  // 经 JSON 往返模拟落盘（项目文件）
  const r = Drawing.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
  check('往返：视图数与边数保留', r.views.length === 1 && r.views[0].edges.length === 3,
    `views=${r.views.length} edges=${r.views[0]?.edges.length}`);
  check('往返：边折线坐标一致', near(r.views[0].edges[1].pts[1][1], 10));
  check('往返：隐藏线标记保留', r.views[0].edges[2].hidden === true);
  check('往返：标注 + φ 前缀 + 公差保留',
    r.views[0].dims.length === 1 && r.views[0].dims[0].prefix === 'φ' &&
    near(r.views[0].dims[0].tolerance!.upper, 0.1) && near(r.views[0].dims[0].tolerance!.lower, -0.1),
    JSON.stringify(r.views[0].dims[0]));
  check('往返：形位公差保留', r.gdts.length === 1 && r.gdts[0].symbol === 'position' && r.gdts[0].datum === 'A');
  check('往返：明细表保留', r.bom.length === 1 && r.bom[0].name === '底座' && r.bom[0].qty === 1);
  check('往返：图纸属性 / 单位 / 比例 / 隐藏线开关保留',
    r.sheet.title === '底板' && r.sheet.code === 'S2-9' && r.sheet.material === '45钢' &&
    r.unitSystem === 'IPS' && r.fixedScale === 2 && r.showHidden === false,
    JSON.stringify({ t: r.sheet.title, u: r.unitSystem, s: r.fixedScale, h: r.showHidden }));
}
{
  // 撤销快照直接存 toJSON 结果 → 必须深拷贝到每一层数组，否则后续原地改写会连快照一起改
  const d = new Drawing();
  d.views = [mkView()];
  const snap = d.toJSON();
  d.views[0].edges[0].pts[0][0] = 999;
  d.views[0].dims.push({ id: 'dimX', a: [0, 0], b: [1, 1], offset: 1 });
  d.sheet.title = '被改过的标题';
  check('快照深拷贝：改实时边的坐标不影响快照', snap.views[0].edges[0].pts[0][0] === 0,
    `snap=${snap.views[0].edges[0].pts[0][0]}`);
  check('快照深拷贝：向实时视图推标注不影响快照', snap.views[0].dims.length === 0);
  check('快照深拷贝：改图纸属性不影响快照', snap.sheet.title !== '被改过的标题');
}
{
  // 发号器必须恢复：否则重开后新 id 从 1 重新编，与已有 id 撞车
  const d = new Drawing();
  d.views = [mkView()];
  const g1 = d.addGdt('v1', 'flatness', 0.02)!;
  const dim1 = d.dimensionRun('v1', 0, 9)!;
  const r = Drawing.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
  const g2 = r.addGdt('v1', 'flatness', 0.02)!;
  const dim2 = r.dimensionRun('v1', 0, 9)!;
  check('发号器恢复：重开后新 gdt id 递增不撞车', g2.id !== g1.id && g2.id === 'gdt2', `${g1.id} → ${g2.id}`);
  check('发号器恢复：重开后新 dim id 递增不撞车', dim2.id !== dim1.id && dim2.id === 'dim2', `${dim1.id} → ${dim2.id}`);
}
{
  // 外部/旧文件把 seq 写小或整个缺字段 → 按实际 id 兜底
  const raw = {
    views: [mkView()],
    gdts: [{ id: 'gdt9', viewId: 'v1', symbol: 'flatness', tol: 0.1, anchor: [0, 0], pos: [0, 0] }],
    bom: [],
  };
  const r = Drawing.fromJSON(raw);
  const g = r.addGdt('v1', 'flatness', 0.1)!;
  check('发号器兜底：缺 seq 字段时按已有 id 续号', g.id === 'gdt10', g.id);
  check('缺字段容错：sheet/unitSystem 回落到默认值', r.sheet.title === 'Solid2 零件' && r.unitSystem === 'MMGS');
}
{
  check('fromJSON(null) → 空工程图不抛', Drawing.fromJSON(null).views.length === 0);
  check('fromJSON(垃圾) → 空工程图不抛', Drawing.fromJSON({ views: 'x', sheet: 3 }).views.length === 0);
  check('fromJSON 过滤残缺视图（缺 id / 缺 edges）',
    Drawing.fromJSON({ views: [{ id: 'v1' }, mkView(), null] }).views.length === 1);
  check('fromJSON 缺 dims/holes 的视图补空数组', Drawing.fromJSON({ views: [{ id: 'v1', edges: [] }] }).views[0].dims.length === 0);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
