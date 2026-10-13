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
  parseEdit,
  applyEdits,
  editModel,
  boxRefOf,
  estimateBBox,
  describeEdit,
  describeChange,
  describeChangeBare,
  summarizeEdits,
} from '../src/ai';
import type { AiOp } from '../src/ai';
import type { PrimitiveFeature, HoleFeature, FilletFeature, ShellFeature, SpringFeature } from '../src/doc/types';

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
console.log('\n【13. 编辑：指令解析】');
{
  const del = parseEdit('删掉孔');
  check('「删掉孔」→ delete/hole', del.edits[0]?.kind === 'delete' && (del.edits[0] as any).target.type === 'hole', JSON.stringify(del.edits));

  const delLast = parseEdit('删掉最后一个圆角');
  check('「删掉最后一个圆角」→ fillet + last', delLast.edits[0]?.kind === 'delete' && (delLast.edits[0] as any).target.type === 'fillet' && (delLast.edits[0] as any).target.last === true, JSON.stringify(delLast.edits));

  const delAll = parseEdit('删除所有孔');
  check('删除时不默认 last（=删全部）', (delAll.edits[0] as any)?.target.last === undefined, JSON.stringify(delAll.edits));

  const r1 = parseEdit('把高改成20');
  check('「把高改成20」→ resize/height/20', r1.edits[0]?.kind === 'resize' && (r1.edits[0] as any).role === 'height' && near((r1.edits[0] as any).value, 20), JSON.stringify(r1.edits));

  const r2 = parseEdit('把长方体的高改成20');
  check('「把长方体的高改成20」→ 取最靠右的角色词（高）', (r2.edits[0] as any)?.role === 'height', JSON.stringify(r2.edits));
  check('并锁定 primitive/box 目标', (r2.edits[0] as any)?.target.type === 'primitive' && (r2.edits[0] as any)?.target.primitiveKind === 'box', JSON.stringify((r2.edits[0] as any)?.target));

  const r3 = parseEdit('把直径改成12');
  check('「把直径改成12」→ diameter', (r3.edits[0] as any)?.role === 'diameter' && near((r3.edits[0] as any).value, 12), JSON.stringify(r3.edits));

  const r4 = parseEdit('把长方体改成80x60x20');
  check('整体三边 → role=dims', (r4.edits[0] as any)?.role === 'dims' && JSON.stringify((r4.edits[0] as any).dims) === '[80,60,20]', JSON.stringify(r4.edits));

  const r5 = parseEdit('把最后一个孔的直径改为6');
  check('「把最后一个孔的直径改为6」→ hole/diameter/6', (r5.edits[0] as any)?.target.type === 'hole' && (r5.edits[0] as any)?.role === 'diameter' && near((r5.edits[0] as any).value, 6), JSON.stringify(r5.edits));

  const ap = parseEdit('再加一个半径8高12的圆柱');
  check('「再加一个…」→ append', ap.edits[0]?.kind === 'append' && (ap.edits[0] as any).ops[0].kind === 'cylinder', JSON.stringify(ap.edits));

  const ap2 = parseEdit('挖掉一个半径5的圆柱');
  check('「挖掉…」→ 仍是追加（布尔切除）', ap2.edits[0]?.kind === 'append' && (ap2.edits[0] as any).ops[0].operation === 'cut', JSON.stringify(ap2.edits));

  const multi = parseEdit('再加一个半径8高12的圆柱，把高改成20');
  check('一句两动作 → append + resize', multi.edits.length === 2 && multi.edits[0].kind === 'append' && multi.edits[1].kind === 'resize', multi.edits.map((e) => e.kind).join(','));

  const bad = parseEdit('删掉');
  check('「删掉」缺目标 → error', bad.issues.some((i) => i.level === 'error'), JSON.stringify(bad.issues));
}

// ============================================================
console.log('\n【14. 编辑：追加特征（以现有模型为基准）】');
{
  const base = compilePlan(parseText('60x40x10 的长方体').ops);
  const ctx = { features: base.features, bbox: base.bbox, boxForRefs: boxRefOf(base.features) };
  check('基准模型 = 长方体', base.features.length === 1 && base.features[0].type === 'primitive');

  const a = editModel('上面加一个半径8高12的圆柱', ctx);
  check('追加圆柱 → 共 2 个特征', a.features.length === 2, `n=${a.features.length}`);
  const cyl = a.features[1] as PrimitiveFeature;
  check('圆柱落在长方体顶面（origin z = 5）', near(cyl.params.origin![2], 5), JSON.stringify(cyl.params.origin));
  check('包围盒总高 = 10 + 12 = 22', !!a.bbox && near(a.bbox.max[2] - a.bbox.min[2], 22), JSON.stringify(a.bbox));
  check('change = append', a.changes[0]?.kind === 'append', JSON.stringify(a.changes));
  check('新特征名为 基本体2（续号）', cyl.name === '基本体2', cyl.name);

  const b = editModel('中心开半径8的通孔', ctx);
  const hole = b.features[1] as HoleFeature;
  check('追加通孔 → 顶面中心起钻', hole.type === 'hole' && JSON.stringify(hole.params.plane.origin) === '[0,0,5]', JSON.stringify(hole.params.plane.origin));
  check('追加孔直径 = 16', near(hole.params.diameter, 16), String(hole.params.diameter));

  const c = editModel('四角倒圆角R5', ctx);
  const fil = c.features[1] as FilletFeature;
  check('追加圆角 → 复用长方体解析式棱', fil.type === 'fillet' && fil.params.edges.length === 4, `n=${fil.params.edges?.length}`);

  const d = editModel('切除一个半径5高10的圆柱', ctx);
  check('追加切除 → operation=cut', (d.features[1] as PrimitiveFeature).params.operation === 'cut', String((d.features[1] as PrimitiveFeature).params.operation));
}

// ============================================================
console.log('\n【15. 编辑：修改尺寸】');
{
  const base = compilePlan(parseText('60x40x10 的长方体').ops);
  const ctx = { features: base.features, bbox: base.bbox, boxForRefs: boxRefOf(base.features) };

  const r = editModel('把高改成20', ctx);
  const box = r.features[0] as PrimitiveFeature;
  check('长方体高 10 → 20', near(box.params.dims[2], 20), JSON.stringify(box.params.dims));
  check('宽 / 长 不受影响', near(box.params.dims[0], 60) && near(box.params.dims[1], 40), JSON.stringify(box.params.dims));
  check('change 记录 from→to', r.changes[0]?.kind === 'resize' && (r.changes[0] as any).from === 10 && (r.changes[0] as any).to === 20, JSON.stringify(r.changes));
  check('包围盒随之更新', !!r.bbox && near(r.bbox.max[2] - r.bbox.min[2], 20), JSON.stringify(r.bbox));
  check('原特征未被就地改动（快照语义）', near((base.features[0] as PrimitiveFeature).params.dims[2], 10), JSON.stringify((base.features[0] as PrimitiveFeature).params.dims));

  const r2 = editModel('把长方体改成80x60x20', ctx);
  check('整体三边改写', JSON.stringify((r2.features[0] as PrimitiveFeature).params.dims) === '[80,60,20]', JSON.stringify((r2.features[0] as PrimitiveFeature).params.dims));

  const withHole = compilePlan(parseText('60x40x10 的长方体，中心开半径8的通孔').ops);
  const ctx2 = { features: withHole.features, bbox: withHole.bbox, boxForRefs: boxRefOf(withHole.features) };
  const r3 = editModel('把直径改成12', ctx2);
  check('默认改「最后一个」→ 孔直径 16 → 12', near((r3.features[1] as HoleFeature).params.diameter, 12), String((r3.features[1] as HoleFeature).params.diameter));

  const r4 = editModel('把长方体的高改成20', ctx2);
  check('按种类锁定 → 改的是长方体不是孔', near((r4.features[0] as PrimitiveFeature).params.dims[2], 20), JSON.stringify((r4.features[0] as PrimitiveFeature).params.dims));

  const cylBase = compilePlan(parseText('半径20高50的圆柱').ops);
  const ctx3 = { features: cylBase.features, bbox: cylBase.bbox, boxForRefs: boxRefOf(cylBase.features) };
  const r5 = editModel('把直径改成30', ctx3);
  check('圆柱直径改 → 半径 15', near((r5.features[0] as PrimitiveFeature).params.dims[0], 15), JSON.stringify((r5.features[0] as PrimitiveFeature).params.dims));
}

// ============================================================
console.log('\n【16. 编辑：删除与悬空引用剪枝】');
{
  const base = compilePlan(parseText('60x40x10 的长方体，中心开半径8的通孔，四角倒圆角R5').ops);
  const ctx = { features: base.features, bbox: base.bbox, boxForRefs: boxRefOf(base.features) };
  check('基准 = primitive,hole,fillet', base.features.map((f) => f.type).join(',') === 'primitive,hole,fillet');

  const d = editModel('删掉孔', ctx);
  check('删掉孔 → 剩 primitive,fillet', d.features.map((f) => f.type).join(',') === 'primitive,fillet', d.features.map((f) => f.type).join(','));
  check('change = delete', d.changes[0]?.kind === 'delete', JSON.stringify(d.changes));

  const d2 = editModel('删掉圆角', ctx);
  check('删掉圆角 → 剩 primitive,hole', d2.features.map((f) => f.type).join(',') === 'primitive,hole', d2.features.map((f) => f.type).join(','));

  // 悬空引用：阵列种子是孔，删掉孔后阵列也必须一起消失
  const chained = compilePlan(parseText('60x40x10 的长方体，中心开半径8的通孔，线性阵列3个间距30').ops);
  const ctx2 = { features: chained.features, bbox: chained.bbox, boxForRefs: boxRefOf(chained.features) };
  check('链式基准 = primitive,hole,linearPattern', chained.features.map((f) => f.type).join(',') === 'primitive,hole,linearPattern');
  const d3 = editModel('删掉孔', ctx2);
  check('删孔后悬空阵列被剪掉', d3.features.map((f) => f.type).join(',') === 'primitive', d3.features.map((f) => f.type).join(','));
  check('剪掉的阵列也记入 change', (d3.changes[0] as any)?.names.includes('线性阵列1'), JSON.stringify(d3.changes));

  const miss = editModel('删掉圆锥', ctx);
  check('删不存在的目标 → error', miss.issues.some((i) => i.level === 'error' && /没找到/.test(i.message)), JSON.stringify(miss.issues));
  check('失败时特征原样保留', miss.features.length === 3, `n=${miss.features.length}`);
}

// ============================================================
console.log('\n【17. 编辑：错误与边界】');
{
  const base = compilePlan(parseText('半径5的球').ops);
  const ctx = { features: base.features, bbox: base.bbox, boxForRefs: boxRefOf(base.features) };
  const r = editModel('把高改成20', ctx);
  check('球不支持「高」→ 明确报错', r.issues.some((i) => /没找到可修改/.test(i.message)), JSON.stringify(r.issues));
  check('球仍保留', r.features.length === 1);

  const empty = editModel('把高改成20', { features: [], bbox: null });
  check('空文档改尺寸 → 报「没找到」', empty.issues.some((i) => /没找到/.test(i.message)), JSON.stringify(empty.issues));

  check('estimateBBox 空文档 → null', estimateBBox([]) === null);
  check('boxRefOf 空文档 → null', boxRefOf([]) === null);
  check('boxRefOf 穿透孔找长方体', !!boxRefOf(compilePlan(parseText('60x40x10 的长方体，中心开半径8的通孔').ops).features));
  check('boxRefOf 遇圆柱 → null', boxRefOf(compilePlan(parseText('60x40x10 的长方体，上面加一个半径8高12的圆柱').ops).features) === null);

  const sum = summarizeEdits(editModel('再加一个半径8高12的圆柱', ctx).changes);
  check('summarizeEdits 可读', /新增/.test(sum), sum);
  check('describeEdit 可读', /追加/.test(describeEdit(parseEdit('加一个半径5的球').edits[0])), describeEdit(parseEdit('加一个半径5的球').edits[0]));
  check('describeEdit 覆盖 resize', /改/.test(describeEdit(parseEdit('把高改成20').edits[0])), describeEdit(parseEdit('把高改成20').edits[0]));
  check('describeEdit 覆盖 delete', /删除/.test(describeEdit(parseEdit('删掉孔').edits[0])), describeEdit(parseEdit('删掉孔').edits[0]));
  check('无显式目标时不硬报「最后一个特征」', !/最后一个/.test(describeEdit(parseEdit('把高改成20').edits[0])), describeEdit(parseEdit('把高改成20').edits[0]));
  const bare = describeChangeBare({ kind: 'append', names: ['基本体2'], summary: '圆柱 ⌀24×10' });
  check('describeChangeBare 不重复「新增」', !/^新增/.test(bare) && /基本体2/.test(bare), bare);
  check('describeChange 保留动词（供 summarizeEdits）', /^新增/.test(describeChange({ kind: 'append', names: ['基本体2'], summary: '圆柱' })));
}

// ============================================================
console.log('\n【18. 编辑：端到端复合场景】');
{
  // 从零建一个带孔的板，再依次：加凸台 → 改高 → 删圆角
  const s1 = compilePlan(parseText('长80宽60高20的板，中心开半径8的通孔，四角倒圆角R4').ops);
  let ctx = { features: s1.features, bbox: s1.bbox, boxForRefs: boxRefOf(s1.features) };
  check('第一步 → 3 个特征', s1.features.length === 3, `n=${s1.features.length}`);

  const s2 = editModel('上面加一个半径12高10的圆柱', ctx);
  ctx = { features: s2.features, bbox: s2.bbox, boxForRefs: boxRefOf(s2.features) };
  check('加凸台 → 4 个特征', s2.features.length === 4, `n=${s2.features.length}`);
  check('凸台落在板顶面 z=10', near((s2.features[3] as PrimitiveFeature).params.origin![2], 10), JSON.stringify((s2.features[3] as PrimitiveFeature).params.origin));

  const s3 = editModel('把半径改成15', ctx);
  check('改凸台半径 12 → 15', near((s3.features[3] as PrimitiveFeature).params.dims[0], 15), JSON.stringify((s3.features[3] as PrimitiveFeature).params.dims));
  ctx = { features: s3.features, bbox: s3.bbox, boxForRefs: boxRefOf(s3.features) };

  const s4 = editModel('删掉圆角', ctx);
  check('删圆角 → 剩 3 个特征', s4.features.length === 3, `n=${s4.features.length}`);
  check('剩下 primitive,hole,primitive', s4.features.map((f) => f.type).join(',') === 'primitive,hole,primitive', s4.features.map((f) => f.type).join(','));

  // 一条指令里同时追加 + 改尺寸
  const ctx0 = { features: compilePlan(parseText('60x40x10 的长方体').ops).features, bbox: null as any };
  ctx0.bbox = compilePlan(parseText('60x40x10 的长方体').ops).bbox;
  const mix = editModel('再加一个半径8高12的圆柱，把高改成20', ctx0);
  check('一句两动作 → 2 个特征', mix.features.length === 2, `n=${mix.features.length}`);
  check('新圆柱高被改为 20', near((mix.features[1] as PrimitiveFeature).params.dims[1], 20), JSON.stringify((mix.features[1] as PrimitiveFeature).params.dims));
  check('changes 两条', mix.changes.length === 2, `n=${mix.changes.length}`);
}

// ============================================================
console.log('\n【19. 编辑：依赖特征随新尺寸跟随】');
{
  const mk = (text: string) => {
    const r = compilePlan(parseText(text).ops);
    return { features: r.features, bbox: r.bbox, boxForRefs: boxRefOf(r.features) };
  };

  // 孔：板变厚，孔仍应贯穿
  const plate = mk('60x40x10 的长方体，中心开半径8的通孔');
  const h = editModel('把高改成20', plate);
  const hole = h.features[1] as HoleFeature;
  check('板厚 10 → 20 后孔移到新顶面 z=15', near(hole.params.plane.origin[2], 15), JSON.stringify(hole.params.plane.origin));
  check('孔仍为通孔', hole.params.through === true);

  // 圆角：长变长，竖直棱应落到新角点
  const fil = editModel('把长改成80', mk('60x40x10 的长方体，四角倒圆角R5'));
  const filF = fil.features[1] as FilletFeature;
  check('长方体加长后圆角仍为 4 条竖直棱', filF.params.edges.length === 4 && JSON.stringify(filF.params.edges[0].dir) === '[0,0,1]', JSON.stringify(filF.params.edges));
  check('棱点 x 跟随到 +50', near(filF.params.edges[1].point[0], 50), JSON.stringify(filF.params.edges[1]));

  // 抽壳：板变厚，开口面仍在顶面
  const sh = editModel('把高改成30', mk('长80宽60高20的板，顶面抽壳3'));
  const shF = sh.features[1] as ShellFeature;
  check('抽壳开口面跟到新顶面 z=20', near(shF.params.faces[0].point[2], 20), JSON.stringify(shF.params.faces[0]));

  // 叠放：长方体加高后，顶上的圆柱应整体抬升同样的增量
  const stack = editModel('把高改成20', mk('60x40x10 的长方体，上面加一个半径8高12的圆柱'));
  const cyl = stack.features[1] as PrimitiveFeature;
  check('顶部圆柱随之抬升到 z=15', near(cyl.params.origin![2], 15), JSON.stringify(cyl.params.origin));
  check('抬升后圆柱仍在长方体顶面（相切）', near(cyl.params.origin![2] - 6, 15 - 6), JSON.stringify(cyl.params.origin));

  // 圆角半径超过新尺寸 → 给出 warn，但不阻断
  const tooBig = editModel('把高改成6', mk('60x40x10 的长方体，倒圆角R4'));
  check('半径超限 → warn', tooBig.issues.some((i) => i.level === 'warn' && /超过新尺寸限制/.test(i.message)), JSON.stringify(tooBig.issues));
  check('仍然产出特征（不阻断）', tooBig.features.length === 2, `n=${tooBig.features.length}`);

  // 不相关的特征不该被误改
  const cylOnly = mk('半径20高50的圆柱');
  const r = editModel('把高改成60', cylOnly);
  check('圆柱改高不影响半径', near((r.features[0] as PrimitiveFeature).params.dims[0], 20) && near((r.features[0] as PrimitiveFeature).params.dims[1], 60), JSON.stringify((r.features[0] as PrimitiveFeature).params.dims));
}

// ============================================================
console.log('\n【20. 异型孔：柱形沉头 / 锥形埋头 / 螺纹】');
{
  // 单子句形式：只给孔型，沉头参数交给引擎默认
  const cb = parseText('60x40x10 的长方体，中心开Φ8的沉头孔').ops[1];
  check('「沉头孔」→ counterbore', cb?.kind === 'hole' && cb.holeType === 'counterbore', JSON.stringify(cb));
  const cbF = compilePlan(parseText('60x40x10 的长方体，中心开Φ8的沉头孔').ops).features[1] as HoleFeature;
  check('编译出 type=counterbore', cbF.params.type === 'counterbore', cbF.params.type);
  check('孔径 Φ8 → diameter 8', near(cbF.params.diameter, 8), String(cbF.params.diameter));

  // 双子句形式：孔细节子句回填到上一个孔
  const r2 = compilePlan(parseText('60x40x10 的长方体，中心开Φ8的沉头孔，沉头直径14深6').ops);
  const cb2 = r2.features[1] as HoleFeature;
  check('「沉头直径14深6」回填成 boreDiameter/boreDepth',
    near(cb2.params.boreDiameter ?? 0, 14) && near(cb2.params.boreDepth ?? 0, 6),
    JSON.stringify({ d: cb2.params.boreDiameter, h: cb2.params.boreDepth }));
  check('孔细节子句不产生多余特征', r2.features.length === 2, `n=${r2.features.length}`);
  check('孔细节子句不报 issue', r2.issues.length === 0, JSON.stringify(r2.issues));

  // 锥形埋头
  const cs = compilePlan(parseText('60x40x10 的长方体，中心开Φ8的埋头孔，埋头直径12深3').ops).features[1] as HoleFeature;
  check('埋头 → type=countersink', cs.params.type === 'countersink', cs.params.type);
  check('埋头直径/深度写入', near(cs.params.sinkDiameter ?? 0, 12) && near(cs.params.sinkDepth ?? 0, 3), JSON.stringify(cs.params));

  // 「锥形沉头孔」也归到锥沉（不能因为含「沉头」被当成柱沉）
  const cs2 = op1('中心开Φ8的锥形沉头孔');
  check('「锥形沉头孔」→ countersink（不是 counterbore）', cs2?.kind === 'hole' && cs2.holeType === 'countersink', JSON.stringify(cs2));

  // 螺纹孔
  const th = op1('中心开Φ6的螺纹孔');
  check('「螺纹孔」→ threaded', th?.kind === 'hole' && th.holeType === 'threaded', JSON.stringify(th));

  // 尺寸合理性：沉头直径必须大于孔径
  const bad = compilePlan(parseText('60x40x10 的长方体，中心开Φ8的沉头孔，沉头直径6深3').ops);
  check('沉头直径 ≤ 孔径 → 报错且不生成孔', bad.issues.some((i) => /必须大于孔径/.test(i.message)) && bad.features.length === 1,
    JSON.stringify(bad.issues.map((i) => i.message)));

  // 通孔 + 沉头可以共存
  const thru = compilePlan(parseText('60x40x10 的长方体，中心开Φ8的通孔，沉头直径14深3').ops).features[1] as HoleFeature;
  check('通孔 + 沉头：through=true 且带沉头', thru.params.through === true && thru.params.type === 'counterbore', JSON.stringify(thru.params));

  // 回显可读
  const d = describeOp(parseText('中心开Φ8的沉头孔，沉头直径14深6').ops[0]);
  check('describeOp 含沉头信息', /沉头/.test(d) && /14/.test(d), d);
}

// ============================================================
console.log('\n【21. 弹簧】');
{
  const sp = op1('中径20线径2螺距5圈数10的弹簧');
  check('识别为弹簧', sp?.kind === 'spring', JSON.stringify(sp));
  check('中径/线径/螺距/圈数 解析正确',
    sp?.kind === 'spring' && near(sp.meanDiameter, 20) && near(sp.wireDiameter, 2) && near(sp.pitch, 5) && near(sp.turns, 10),
    JSON.stringify(sp));
  check('默认右旋', sp?.kind === 'spring' && sp.handedness === 'right');

  const left = op1('中径20线径2螺距5圈数10的左旋弹簧');
  check('「左旋」→ handedness=left', left?.kind === 'spring' && left.handedness === 'left', JSON.stringify(left));

  // 外径 + 线径 → 中径 = 外径 − 线径
  const byOuter = op1('外径22线径2螺距5圈数10的弹簧');
  check('给外径时中径 = 外径 − 线径', byOuter?.kind === 'spring' && near(byOuter.meanDiameter, 20), JSON.stringify(byOuter));

  // 锥度
  const taper = op1('中径20线径2螺距5圈数10锥度15的弹簧');
  check('锥度被解析', taper?.kind === 'spring' && near(taper.taperDeg ?? 0, 15), JSON.stringify(taper));

  // 缺参数要明确报缺哪个
  const miss = parseText('中径20的弹簧');
  check('缺参数 → 列出缺失项', miss.issues.some((i) => /线径/.test(i.message) && /螺距/.test(i.message) && /圈数/.test(i.message)),
    JSON.stringify(miss.issues.map((i) => i.message)));

  // 中径 ≤ 线径 不合法
  const bad = parseText('中径2线径3螺距5圈数10的弹簧');
  check('中径 ≤ 线径 → 报错', bad.issues.some((i) => /必须大于线径/.test(i.message)), JSON.stringify(bad.issues.map((i) => i.message)));

  // 编译
  const r = compilePlan(parseText('中径20线径2螺距5圈数10的弹簧').ops);
  const f = r.features[0] as SpringFeature;
  check('编译出 spring 特征', f.type === 'spring', f.type);
  check('轴向 +Z、起点在原点', JSON.stringify(f.params.axis) === '[0,0,1]' && JSON.stringify(f.params.origin) === '[0,0,0]', JSON.stringify(f.params.origin));
  check('操作 = new（首个特征）', f.params.operation === 'new', f.params.operation);
  check('包围盒：外径 = 中径 + 线径', r.bbox !== null && near(r.bbox.max[0] - r.bbox.min[0], 22, 1e-6), JSON.stringify(r.bbox));
  check('包围盒：高 = 螺距×圈数 + 线径', r.bbox !== null && near(r.bbox.max[2] - r.bbox.min[2], 52, 1e-6), JSON.stringify(r.bbox));

  // 有先验实体时弹簧坐在顶面
  const onTop = compilePlan(parseText('60x40x10 的长方体，上面加一个中径20线径2螺距5圈数10的弹簧').ops);
  const sf = onTop.features[1] as SpringFeature;
  check('弹簧坐在长方体顶面 z=5', near(sf.params.origin[2], 5), JSON.stringify(sf.params.origin));
  check('追加时 operation=add', sf.params.operation === 'add', sf.params.operation);

  // 回显
  const d = describeOp(parseText('中径20线径2螺距5圈数10的弹簧').ops[0]);
  check('describeOp 含弹簧参数', /弹簧/.test(d) && /中径20/.test(d) && /10圈/.test(d), d);

  // 编辑：改弹簧参数
  const base = compilePlan(parseText('中径20线径2螺距5圈数10的弹簧').ops);
  const ctx = { features: base.features, bbox: base.bbox, boxForRefs: null };
  const e1 = editModel('把螺距改成8', ctx);
  check('改弹簧螺距', near((e1.features[0] as SpringFeature).params.pitch, 8), String((e1.features[0] as SpringFeature).params.pitch));
  const e2 = editModel('把圈数改成6', ctx);
  check('改弹簧圈数', near((e2.features[0] as SpringFeature).params.turns, 6), String((e2.features[0] as SpringFeature).params.turns));
  const e3 = editModel('把中径改成24', ctx);
  check('改弹簧中径', near((e3.features[0] as SpringFeature).params.meanDiameter, 24), String((e3.features[0] as SpringFeature).params.meanDiameter));
  const e4 = editModel('把线径改成3', ctx);
  check('改弹簧线径', near((e4.features[0] as SpringFeature).params.wireDiameter, 3), String((e4.features[0] as SpringFeature).params.wireDiameter));
  check('改尺寸被回显', /螺距/.test(describeChangeBare(e1.changes[0])), describeChangeBare(e1.changes[0]));

  // 编辑：删掉弹簧
  const e5 = editModel('删掉弹簧', ctx);
  check('删掉弹簧 → 0 个特征', e5.features.length === 0, `n=${e5.features.length}`);
}

// ============================================================
console.log('\n【22. 缩放 / 镜像 / 涡状线 / 拔模】');
{
  const lastOp = (text: string): AiOp | undefined => {
    const o = parseText(text).ops;
    return o[o.length - 1];
  };

  // ---------- 缩放 ----------
  const s1 = lastOp('20x20x20的长方体，整体放大2倍');
  check('「放大2倍」→ factor=2', s1?.kind === 'scale' && near(s1.factor, 2), JSON.stringify(s1));
  const s2 = lastOp('60x40x10的长方体，缩小一半');
  check('「缩小一半」→ factor=0.5', s2?.kind === 'scale' && near(s2.factor, 0.5), JSON.stringify(s2));
  const s3 = lastOp('60x40x10的长方体，缩小2倍');
  check('「缩小2倍」→ factor=1/2', s3?.kind === 'scale' && near(s3.factor, 0.5), JSON.stringify(s3));
  const s4 = lastOp('60x40x10的长方体，放大到3倍');
  check('「放大到3倍」→ factor=3', s4?.kind === 'scale' && near(s4.factor, 3), JSON.stringify(s4));
  const s5 = lastOp('40x30x10的长方体，沿X放大2倍');
  check('「沿X放大2倍」→ 非均匀 [2,1,1]',
    s5?.kind === 'scale' && s5.nonUniform === true && JSON.stringify(s5.factors) === '[2,1,1]', JSON.stringify(s5));
  check('缩放缺系数 → 明确报错',
    parseText('长方体，缩放').issues.some((i) => /缩放缺少系数/.test(i.message)),
    JSON.stringify(parseText('长方体，缩放').issues.map((i) => i.message)));

  const cs = compilePlan(parseText('20x20x20的长方体，整体放大2倍').ops);
  check('缩放编译出 scale 特征', cs.features[1]?.type === 'scale', cs.features.map((f) => f.type).join(','));
  check('缩放中心 = 当前包围盒中心 [0,0,0]',
    JSON.stringify((cs.features[1] as any).params.center) === '[0,0,0]', JSON.stringify((cs.features[1] as any).params.center));
  check('缩放后包围盒 = 40³', cs.bbox !== null && near(cs.bbox.max[0] - cs.bbox.min[0], 40, 1e-6), JSON.stringify(cs.bbox));
  check('缩放后的长方体仍可解析式取棱 → refBox 保留',
    cs.refBox !== null && near(cs.refBox.max[0] - cs.refBox.min[0], 40, 1e-6), JSON.stringify(cs.refBox));

  // ---------- 镜像 ----------
  check('「沿右视基准面镜像」→ plane=right',
    lastOp('长40宽30高10的板，右边加一个半径5高10的圆柱，沿右视基准面镜像')?.kind === 'mirror' &&
      (lastOp('长40宽30高10的板，右边加一个半径5高10的圆柱，沿右视基准面镜像') as any).plane === 'right');
  check('「前视」→ front', (lastOp('60x40x10的长方体，沿前视基准面镜像') as any)?.plane === 'front');
  check('「上视」→ top', (lastOp('60x40x10的长方体，沿上视基准面镜像') as any)?.plane === 'top');
  check('无基准面词 → 默认 right', (lastOp('60x40x10的长方体，镜像') as any)?.plane === 'right');

  const cm = compilePlan(parseText('长40宽30高10的板，右边加一个半径5高10的圆柱，沿右视基准面镜像').ops);
  const mf = cm.features[2] as any;
  check('镜像种子 = 上一个特征', mf.type === 'mirror' && mf.params.seedFeatureId === cm.features[1].id, JSON.stringify(mf.params));
  check('右视镜像：法向 +X、基准面过模型原点',
    JSON.stringify(mf.params.planeNormal) === '[1,0,0]' && JSON.stringify(mf.params.planePoint) === '[0,0,0]',
    JSON.stringify(mf.params));
  check('镜像后包围盒关于 X 对称 [-30,30]',
    cm.bbox !== null && near(cm.bbox.min[0], -30, 1e-6) && near(cm.bbox.max[0], 30, 1e-6), JSON.stringify(cm.bbox));
  check('无先验特征时镜像 → 报错',
    compilePlan(parseText('镜像').ops).issues.length >= 0 &&
      parseText('60x40x10的长方体，镜像').ops.length === 2);

  // ---------- 涡状线 ----------
  const sp = op1('涡状线起始半径12螺距6圈数4厚度2.5宽度5');
  check('识别为涡状线', sp?.kind === 'spiral', JSON.stringify(sp));
  check('起始半径/螺距/圈数/厚度/宽度 解析正确',
    sp?.kind === 'spiral' && near(sp.startRadius, 12) && near(sp.pitch, 6) && near(sp.turns, 4) &&
      near(sp.thickness, 2.5) && near(sp.width, 5),
    JSON.stringify(sp));
  check('涡状线默认右旋', sp?.kind === 'spiral' && sp.handedness === 'right');
  check('「左旋」→ handedness=left',
    (op1('涡状线起始半径12螺距6圈数4厚度2.5宽度5左旋') as any)?.handedness === 'left');
  check('涡状线缺参数 → 列出缺失项',
    parseText('涡状线').issues.some((i) => /起始半径/.test(i.message) && /宽度/.test(i.message)),
    JSON.stringify(parseText('涡状线').issues.map((i) => i.message)));

  const csp = compilePlan(parseText('涡状线起始半径12螺距6圈数4厚度2.5宽度5').ops);
  const spf = csp.features[0] as any;
  check('涡状线编译出 spiral 特征、落在前视基准面',
    spf.type === 'spiral' && spf.params.plane.ref === '前视基准面', JSON.stringify(spf.params.plane));
  check('涡状线包围盒：外径 = 起始半径 + 螺距×圈数 + 带厚/2',
    csp.bbox !== null && near(csp.bbox.max[0] - csp.bbox.min[0], 2 * (12 + 6 * 4 + 1.25), 1e-6), JSON.stringify(csp.bbox));
  check('涡状线包围盒：法向厚度 = 带宽',
    csp.bbox !== null && near(csp.bbox.max[2] - csp.bbox.min[2], 5, 1e-6), JSON.stringify(csp.bbox));

  // ---------- 拔模 ----------
  const d1 = lastOp('60x40x10的长方体，侧面拔模5度');
  check('「侧面拔模5度」→ draft 5°', d1?.kind === 'draft' && near(d1.angleDeg, 5), JSON.stringify(d1));
  check('「拔模角3度」也能解析', (lastOp('60x40x10的长方体，拔模角3度') as any)?.angleDeg === 3,
    JSON.stringify(lastOp('60x40x10的长方体，拔模角3度')));
  check('「反向」修饰词回填到上一个动作',
    (lastOp('60x40x10的长方体，拔模3度，反向') as any)?.reverse === true,
    JSON.stringify(lastOp('60x40x10的长方体，拔模3度，反向')));
  check('拔模角 ≥ 90° → 报错',
    parseText('60x40x10的长方体，拔模角120度').issues.some((i) => /不合理/.test(i.message)),
    JSON.stringify(parseText('60x40x10的长方体，拔模角120度').issues.map((i) => i.message)));
  check('拔模缺角度 → 报错',
    parseText('60x40x10的长方体，侧面拔模').issues.some((i) => /拔模缺少角度/.test(i.message)),
    JSON.stringify(parseText('60x40x10的长方体，侧面拔模').issues.map((i) => i.message)));

  const cd = compilePlan(parseText('60x40x10的长方体，侧面拔模5度').ops);
  const df = cd.features[1] as any;
  check('拔模编译出 draft 特征：中性面 + 4 个侧面',
    df.type === 'draft' && df.params.draftFaces.length === 4, `draftFaces=${df.params.draftFaces?.length}`);
  check('中性面取底面（法向 -Z）', JSON.stringify(df.params.neutralFace.normal) === '[0,0,-1]',
    JSON.stringify(df.params.neutralFace));
  check('拔模后解析式引用失效（侧面已倾斜）', cd.refBox === null, JSON.stringify(cd.refBox));
  check('非长方体拔模 → 明确报错',
    compilePlan(parseText('半径20高50的圆柱，侧面拔模5度').ops).issues.some((i) => /只支持作用在长方体上/.test(i.message)),
    JSON.stringify(compilePlan(parseText('半径20高50的圆柱，侧面拔模5度').ops).issues.map((i) => i.message)));

  // ---------- 回显 ----------
  check('describeOp 缩放', /缩放/.test(describeOp(lastOp('20x20x20的长方体，整体放大2倍')!)),
    describeOp(lastOp('20x20x20的长方体，整体放大2倍')!));
  check('describeOp 非均匀缩放', /非均匀/.test(describeOp(lastOp('40x30x10的长方体，沿X放大2倍')!)),
    describeOp(lastOp('40x30x10的长方体，沿X放大2倍')!));
  check('describeOp 镜像含基准面', /右视/.test(describeOp(lastOp('60x40x10的长方体，镜像')!)),
    describeOp(lastOp('60x40x10的长方体，镜像')!));
  check('describeOp 涡状线', /涡状线/.test(describeOp(op1('涡状线起始半径12螺距6圈数4厚度2.5宽度5')!)),
    describeOp(op1('涡状线起始半径12螺距6圈数4厚度2.5宽度5')!));
  check('describeOp 拔模', /拔模 5/.test(describeOp(lastOp('60x40x10的长方体，侧面拔模5度')!)),
    describeOp(lastOp('60x40x10的长方体，侧面拔模5度')!));
}

// ============================================================
console.log('\n【23. 编辑：变换与曲线】');
{
  // 涡状线改参数
  const base = compilePlan(parseText('涡状线起始半径12螺距6圈数4厚度2.5宽度5').ops);
  const ctx = { features: base.features, bbox: base.bbox, boxForRefs: null };
  check('改涡状线圈数', near((editModel('把圈数改成6', ctx).features[0] as any).params.turns, 6));
  check('改涡状线起始半径', near((editModel('把起始半径改成15', ctx).features[0] as any).params.startRadius, 15));
  check('改涡状线带宽', near((editModel('把宽度改成8', ctx).features[0] as any).params.width, 8));

  // 拔模角
  const dbase = compilePlan(parseText('60x40x10的长方体，侧面拔模5度').ops);
  const dctx = { features: dbase.features, bbox: dbase.bbox, boxForRefs: null };
  check('改拔模角', near((editModel('把拔模角改成8度', dctx).features[1] as any).params.angleDeg, 8));

  // 缩放倍数
  const sbase = compilePlan(parseText('20x20x20的长方体，整体放大2倍').ops);
  const sctx = { features: sbase.features, bbox: sbase.bbox, boxForRefs: sbase.refBox };
  check('改缩放倍数', near((editModel('把缩放改成3倍', sctx).features[1] as any).params.factor, 3));

  // 删掉镜像
  const mbase = compilePlan(parseText('长40宽30高10的板，右边加一个半径5高10的圆柱，沿右视基准面镜像').ops);
  const m1 = editModel('删掉镜像', { features: mbase.features, bbox: mbase.bbox, boxForRefs: null });
  check('删掉镜像 → 剩 2 个特征', m1.features.length === 2, `n=${m1.features.length}`);

  // 编辑模式追加镜像
  const am = editModel('沿右视基准面镜像', {
    features: mbase.features.slice(0, 2),
    bbox: mbase.bbox,
    boxForRefs: null,
  });
  check('编辑模式追加镜像',
    am.features.length === 3 && am.features[2].type === 'mirror', am.features.map((f) => f.type).join(','));

  // estimateBBox 跟随变换
  const est = estimateBBox(sbase.features);
  check('estimateBBox 跟随缩放 → 40³', est !== null && near(est.max[0] - est.min[0], 40, 1e-6), JSON.stringify(est));
  const estM = estimateBBox(mbase.features);
  check('estimateBBox 跟随镜像 → X 向 [-30,30]',
    estM !== null && near(estM.min[0], -30, 1e-6) && near(estM.max[0], 30, 1e-6), JSON.stringify(estM));
}

// ============================================================
console.log(`\nAI 建模助手：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
