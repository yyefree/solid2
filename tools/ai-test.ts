/**
 * AI 建模助手测试（解析层 + 编译层，纯计算，不依赖 OCCT / 浏览器）。
 * 运行: node tools/run-ts.mjs tools/ai-test.ts
 */
import {
  parseText,
  compilePlan,
  interpret,
  localProvider,
  normalizeInput,
  describeOp,
  summarize,
} from '../src/ai';
import type { AiOp } from '../src/ai';
import type { PrimitiveFeature, HoleFeature, FilletFeature, ShellFeature } from '../src/doc/types';

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
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

/** 解析出第一个 op（便于断言） */
const op1 = (text: string): AiOp | undefined => parseText(text).ops[0];

// ============================================================
console.log('\n【1. 文本归一化】');
{
  check('全角数字 → 半角', normalizeInput('６０×４０') === '60x40', normalizeInput('６０×４０'));
  check('乘号统一为 x', normalizeInput('60×40*10') === '60x40x10', normalizeInput('60×40*10'));
  check('直径符号统一为 Φ', normalizeInput('φ20⌀10Ø8') === 'Φ20Φ10Φ8', normalizeInput('φ20⌀10Ø8'));
  check('去空格 + 小写', normalizeInput('  R8  CYL  ') === 'r8cyl', normalizeInput('  R8  CYL  '));
}

// ============================================================
console.log('\n【2. 基本体与尺寸】');
{
  const box = op1('60x40x10 的长方体');
  check('连乘三元组 → 长方体', box?.kind === 'box' && JSON.stringify((box as any).dims) === '[60,40,10]', JSON.stringify(box));

  const box2 = op1('长60宽40高10的板');
  check('角色词 长/宽/高 → 长方体', box2?.kind === 'box' && JSON.stringify((box2 as any).dims) === '[60,40,10]', JSON.stringify(box2));

  const cube = op1('边长30的立方体');
  check('边长 → 立方体三边相等', cube?.kind === 'box' && JSON.stringify((cube as any).dims) === '[30,30,30]', JSON.stringify(cube));

  const cyl = op1('半径8高20的圆柱');
  check('半径+高 → 圆柱 [r,h]', cyl?.kind === 'cylinder' && JSON.stringify((cyl as any).dims) === '[8,20]', JSON.stringify(cyl));

  const cyl2 = op1('直径16高20的圆柱');
  check('直径 → 半径折算', cyl2?.kind === 'cylinder' && near((cyl2 as any).dims[0], 8), JSON.stringify(cyl2));

  const cyl3 = op1('Φ20 的圆柱，高 30');
  check('Φ 前缀识别为直径', cyl3?.kind === 'cylinder' && near((cyl3 as any).dims[0], 10), JSON.stringify(cyl3));

  const cyl4 = op1('R8 的圆柱高 20');
  check('R 前缀识别为半径', cyl4?.kind === 'cylinder' && near((cyl4 as any).dims[0], 8), JSON.stringify(cyl4));

  const sph = op1('球半径5');
  check('球 → [r]', sph?.kind === 'sphere' && near((sph as any).dims[0], 5), JSON.stringify(sph));

  const cone = op1('圆锥底半径12高25');
  check('圆锥 → [r1,r2,h]', cone?.kind === 'cone' && near((cone as any).dims[0], 12) && near((cone as any).dims[2], 25), JSON.stringify(cone));

  const tor = op1('圆环主半径20管半径5');
  check('圆环 → [R,r]', tor?.kind === 'torus' && near((tor as any).dims[0], 20) && near((tor as any).dims[1], 5), JSON.stringify(tor));
}

// ============================================================
console.log('\n【3. 单位换算】');
{
  const a = op1('长60mm宽40mm高10mm的长方体');
  check('mm 单位', a?.kind === 'box' && JSON.stringify((a as any).dims) === '[60,40,10]', JSON.stringify(a));
  const b = op1('长6cm宽4cm高1cm的长方体');
  check('cm → mm（×10）', b?.kind === 'box' && JSON.stringify((b as any).dims) === '[60,40,10]', JSON.stringify(b));
  const c = op1('半径1in的球');
  check('in → mm（×25.4）', c?.kind === 'sphere' && near((c as any).dims[0], 25.4), JSON.stringify(c));
  const d = op1('长0.06m宽0.04m高0.01m的长方体');
  check('m → mm（×1000）', d?.kind === 'box' && near((d as any).dims[0], 60), JSON.stringify(d));
}

// ============================================================
console.log('\n【4. 特征动作：孔】');
{
  const h1 = op1('中心开半径8的通孔');
  check('通孔 → through', h1?.kind === 'hole' && (h1 as any).through === true && near((h1 as any).radius, 8), JSON.stringify(h1));

  const h2 = op1('开直径10的盲孔深20');
  check('盲孔 → 带深度', h2?.kind === 'hole' && (h2 as any).through === false && near((h2 as any).radius, 5) && near((h2 as any).depth, 20), JSON.stringify(h2));

  const h3 = op1('打Φ6的孔');
  check('打孔 + Φ → 半径折算', h3?.kind === 'hole' && near((h3 as any).radius, 3), JSON.stringify(h3));

  const bad = parseText('开一个孔');
  check('孔缺尺寸 → 报 error', bad.issues.some((i) => i.level === 'error'), JSON.stringify(bad.issues));
}

// ============================================================
console.log('\n【5. 特征动作：圆角 / 倒角 / 抽壳 / 阵列】');
{
  const f1 = op1('四角倒圆角R5');
  check('四角圆角 → scope=vertical', f1?.kind === 'fillet' && (f1 as any).scope === 'vertical' && near((f1 as any).radius, 5), JSON.stringify(f1));

  const f2 = op1('倒圆角R3');
  check('无范围 → scope=all', f2?.kind === 'fillet' && (f2 as any).scope === 'all', JSON.stringify(f2));

  const c1 = op1('四角倒角4');
  check('倒角 → distance', c1?.kind === 'chamfer' && near((c1 as any).distance, 4), JSON.stringify(c1));

  const s1 = op1('顶面抽壳3');
  check('抽壳 → 壁厚 + 顶面开口', s1?.kind === 'shell' && near((s1 as any).thickness, 3) && (s1 as any).open === 'top', JSON.stringify(s1));

  const p1 = op1('线性阵列3个间距30');
  check('线性阵列 → 个数 + 间距', p1?.kind === 'linearPattern' && (p1 as any).count === 3 && near((p1 as any).spacing, 30), JSON.stringify(p1));

  const p2 = op1('圆周阵列6个');
  check('圆周阵列 → 个数', p2?.kind === 'circularPattern' && (p2 as any).count === 6, JSON.stringify(p2));

  const bad = parseText('阵列一下');
  check('阵列缺个数 → 报 error', bad.issues.some((i) => i.level === 'error'), JSON.stringify(bad.issues));
}

// ============================================================
console.log('\n【6. 布尔与位置】');
{
  const cut = op1('切除一个半径5高10的圆柱');
  check('切除 → operation=cut', cut?.kind === 'cylinder' && (cut as any).operation === 'cut', JSON.stringify(cut));

  const inter = op1('与半径5的球相交');
  check('相交 → operation=intersect', inter?.kind === 'sphere' && (inter as any).operation === 'intersect', JSON.stringify(inter));

  const plan = parseText('半径20高50的圆柱，上面加一个半径8高12的圆柱');
  check('两个子句 → 两个 op', plan.ops.length === 2, `ops=${plan.ops.length}`);
  check('第二个 op place=top', plan.ops[1] && (plan.ops[1] as any).place === 'top', JSON.stringify(plan.ops[1]));
  check('第二个 op 默认布尔=add', plan.ops[1] && (plan.ops[1] as any).operation === 'add', JSON.stringify(plan.ops[1]));
}

// ============================================================
console.log('\n【7. 编译：基本体居中与包围盒】');
{
  const r = compilePlan(parseText('60x40x10 的长方体').ops);
  const f = r.features[0] as PrimitiveFeature;
  check('产出 1 个特征', r.features.length === 1, `n=${r.features.length}`);
  check('type=primitive / kind=box', f.type === 'primitive' && f.params.kind === 'box');
  check('origin 使实体居中', JSON.stringify(f.params.origin) === '[-30,-20,-5]', JSON.stringify(f.params.origin));
  check('包围盒尺寸 = 60×40×10', !!r.bbox && near(r.bbox.max[0] - r.bbox.min[0], 60) && near(r.bbox.max[2] - r.bbox.min[2], 10));
  check('包围盒关于原点对称', !!r.bbox && near(r.bbox.min[0], -30) && near(r.bbox.max[2], 5), JSON.stringify(r.bbox));
  check('第一个实体 operation=new', f.params.operation === 'new', String(f.params.operation));
}

console.log('\n【8. 编译：叠放与孔位】');
{
  const r = compilePlan(parseText('半径20高50的圆柱，上面加一个半径8高12的圆柱').ops);
  const [a, b] = r.features as [PrimitiveFeature, PrimitiveFeature];
  check('圆柱1 居中（origin z=-25）', near(a.params.origin![2], -25), JSON.stringify(a.params.origin));
  check('圆柱2 落在圆柱1 顶面', near(b.params.origin![2], 25), JSON.stringify(b.params.origin));
  check('累计包围盒高 = 50+12 = 62', !!r.bbox && near(r.bbox.max[2] - r.bbox.min[2], 62), JSON.stringify(r.bbox));

  const r2 = compilePlan(parseText('60x40x10 的长方体，中心开半径8的通孔').ops);
  const hole = r2.features[1] as HoleFeature;
  check('孔 type=hole', hole.type === 'hole');
  check('孔直径 = 16', near(hole.params.diameter, 16), String(hole.params.diameter));
  check('孔为通孔', hole.params.through === true);
  check('孔平面原点在长方体顶面中心', JSON.stringify(hole.params.plane.origin) === '[0,0,5]', JSON.stringify(hole.params.plane.origin));
  check('孔平面法向 +Z', JSON.stringify(hole.params.plane.normal) === '[0,0,1]');
}

console.log('\n【9. 编译：长方体解析式边/面引用】');
{
  const r = compilePlan(parseText('60x40x10 的长方体，四角倒圆角R5').ops);
  const fil = r.features[1] as FilletFeature;
  check('圆角特征产出', fil?.type === 'fillet');
  check('四角 → 4 条竖直棱', fil?.params.edges.length === 4, `n=${fil?.params.edges.length}`);
  check('棱方向为 Z', JSON.stringify(fil?.params.edges[0].dir) === '[0,0,1]', JSON.stringify(fil?.params.edges[0]));

  const r2 = compilePlan(parseText('60x40x10 的长方体，倒圆角R2').ops);
  const fil2 = r2.features[1] as FilletFeature;
  check('全部棱 → 12 条', fil2?.params.edges.length === 12, `n=${fil2?.params.edges.length}`);

  const r3 = compilePlan(parseText('60x40x10 的长方体，顶面抽壳3').ops);
  const sh = r3.features[1] as ShellFeature;
  check('抽壳特征产出', sh?.type === 'shell');
  check('移除面为顶面', JSON.stringify(sh?.params.faces[0].point) === '[0,0,5]' && JSON.stringify(sh?.params.faces[0].normal) === '[0,0,1]', JSON.stringify(sh?.params.faces[0]));
}

console.log('\n【10. 编译：错误与边界】');
{
  const r1 = compilePlan(parseText('半径8高20的圆柱，四角倒圆角R5').ops);
  check('圆柱上圆角 → 明确报错', r1.issues.some((i) => /只支持作用在长方体/.test(i.message)), JSON.stringify(r1.issues));
  check('圆柱上圆角 → 不产出 fillet 特征', !r1.features.some((f) => f.type === 'fillet'));

  const r2 = compilePlan(parseText('60x40x10 的长方体，四角倒圆角R50').ops);
  check('圆角半径过大 → 报错', r2.issues.some((i) => /超过限制/.test(i.message)), JSON.stringify(r2.issues));

  const r3 = compilePlan(parseText('60x40x10 的长方体，顶面抽壳30').ops);
  check('壁厚过大 → 报错', r3.issues.some((i) => /过大/.test(i.message)), JSON.stringify(r3.issues));

  const r4 = parseText('把那个东西弄一下');
  check('无法识别 → warn', r4.issues.some((i) => i.level === 'warn') && r4.ops.length === 0, JSON.stringify(r4.issues));
}

console.log('\n【11. 综合场景】');
{
  const text = '60x40x10 的长方体，中心开半径8的通孔，四角倒圆角R5';
  const plan = parseText(text);
  check('综合输入 → 3 个动作', plan.ops.length === 3, `n=${plan.ops.length}`);
  check('动作顺序：box → hole → fillet', plan.ops.map((o) => o.kind).join(',') === 'box,hole,fillet', plan.ops.map((o) => o.kind).join(','));

  const r = compilePlan(plan.ops);
  check('编译出 3 个特征', r.features.length === 3, `n=${r.features.length}`);
  check('特征名自动编号', r.names.join(',') === '基本体1,孔1,圆角1', r.names.join(','));
  check('summary 可读', /长方体/.test(plan.summary) && /通孔/.test(plan.summary) && /圆角/.test(plan.summary), plan.summary);

  const text2 = '长80宽60高20的板，四角倒角4，顶面抽壳3';
  const r2 = compilePlan(parseText(text2).ops);
  check('板+倒角+抽壳 → 3 特征', r2.features.length === 3, `n=${r2.features.length}`);
  check('倒角在抽壳之前', r2.features.map((f) => f.type).join(',') === 'primitive,chamfer,shell', r2.features.map((f) => f.type).join(','));
}

// ============================================================
console.log('\n【12. 端到端 interpret（provider 契约）】');
{
  check('localProvider 恒可用', localProvider.available() === true);
  check('localProvider.id = local', localProvider.id === 'local');

  const res = await interpret('半径15高30的圆柱，中心开直径6的通孔，线性阵列3个间距30');
  check('plan.provider = local', res.plan.provider === 'local', res.plan.provider);
  check('产出 3 个特征', res.compiled.features.length === 3, `n=${res.compiled.features.length}`);
  check('特征类型顺序正确', res.compiled.features.map((f) => f.type).join(',') === 'primitive,hole,linearPattern', res.compiled.features.map((f) => f.type).join(','));
  check('阵列种子指向孔', (res.compiled.features[2] as any).params.seedFeatureId === res.compiled.features[1].id);

  const describe = describeOp({ kind: 'box', source: '', dims: [60, 40, 10], operation: 'new', place: 'center' });
  check('describeOp 输出尺寸', describe === '长方体 60×40×10', describe);
  check('summarize 空计划', summarize([]) === '没有识别出任何建模动作', summarize([]));
}

// ============================================================
console.log(`\nAI 建模助手：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
