/**
 * 表达式引擎测试（参考 FreeCAD Expressions，纯计算，不依赖 OCCT）。
 * 运行: node tools/run-ts.mjs tools/expr-test.ts
 */
import {
  tokenize,
  parse,
  evaluate,
  evalExpression,
  collectRefs,
  resolveExpressions,
  previewExpression,
  getParamPath,
  setParamPath,
  listNumericParams,
  ExprError,
  type ParamDef,
} from '../src/doc/expr';
import type { Feature } from '../src/doc/types';

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
const err = (fn: () => unknown): string => {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

/** 无引用的求值 */
const ev = (src: string) => evalExpression(src, (parts) => {
  throw new ExprError(`未知参数「${parts.join('.')}」`);
});

// ============================================================
console.log('【词法分析】');
{
  const t = tokenize('1 + 2.5 * A1');
  check('tokenize：数字/运算符/标识符', t.map((x) => x.text).join('|') === '1|+|2.5|*|A1|',
    t.map((x) => x.text).join('|'));
  check('tokenize：数字带值', t[0].value === 1 && t[2].value === 2.5);
  const t2 = tokenize('2+3*4');
  check('tokenize：紧贴无空格', t2.length === 6 && t2[1].text === '+');
  const t3 = tokenize('a and b or not c');
  check('tokenize：and/or/not 归一为运算符', t3.filter((x) => x.kind === 'op').map((x) => x.text).join(',') === 'and,or,not');
  const t4 = tokenize('长 度 + 2');
  check('tokenize：支持中文标识符', t4[0].kind === 'ident' && t4[0].text === '长' && t4[1].text === '度');
  check('tokenize：无法识别字符报错', /无法识别/.test(err(() => tokenize('1 $ 2'))));
}

// ============================================================
console.log('\n【运算符优先级与结合性】');
{
  check('2+3*4 = 14', ev('2+3*4') === 14);
  check('(2+3)*4 = 20', ev('(2+3)*4') === 20);
  check('2*3^2 = 18（幂优先于乘）', ev('2*3^2') === 18);
  check('2^3^2 = 512（幂右结合）', ev('2^3^2') === 512);
  check('-2^2 = -4（幂优先于一元负号）', ev('-2^2') === -4);
  check('2^-3 = 0.125（指数可为负）', near(ev('2^-3'), 0.125));
  check('10-3-2 = 5（减法左结合）', ev('10-3-2') === 5);
  check('100/10/2 = 5（除法左结合）', ev('100/10/2') === 5);
  check('7%3 = 1', ev('7%3') === 1);
  check('2*(3+4)^2 = 98', ev('2*(3+4)^2') === 98);
  check('.5*4 = 2（省略整数部分）', ev('.5*4') === 2);
  check('1e3 = 1000（科学计数法）', ev('1e3') === 1000);
  check('1.5e-2 = 0.015', near(ev('1.5e-2'), 0.015));
}

// ============================================================
console.log('\n【比较与逻辑】');
{
  check('1<2 → 1', ev('1<2') === 1);
  check('2>3 → 0', ev('2>3') === 0);
  check('3>=3 → 1', ev('3>=3') === 1);
  check('3!=3 → 0', ev('3!=3') === 0);
  check('3==3 → 1', ev('3==3') === 1);
  check('3=3 → 1（单个 = 也接受）', ev('3=3') === 1);
  check('1 and 0 → 0', ev('1 and 0') === 0);
  check('1 or 0 → 1', ev('1 or 0') === 1);
  check('not 0 → 1', ev('not 0') === 1);
  check('&& 等价 and', ev('1 && 1') === 1);
  check('|| 等价 or', ev('0 || 1') === 1);
  check('1<2 and 3>2 → 1', ev('1<2 and 3>2') === 1);
}

// ============================================================
console.log('\n【函数与常量】');
{
  check('sin(90) = 1（角度制）', near(ev('sin(90)'), 1, 1e-12));
  check('cos(0) = 1', near(ev('cos(0)'), 1));
  check('tan(45) = 1', near(ev('tan(45)'), 1, 1e-12));
  check('asin(1) = 90（返回度）', near(ev('asin(1)'), 90, 1e-9));
  check('acos(1) = 0', near(ev('acos(1)'), 0));
  check('atan(1) = 45', near(ev('atan(1)'), 45, 1e-9));
  check('atan2(1,1) = 45', near(ev('atan2(1,1)'), 45, 1e-9));
  check('sqrt(16) = 4', ev('sqrt(16)') === 4);
  check('abs(-3) = 3', ev('abs(-3)') === 3);
  check('pow(2,10) = 1024', ev('pow(2,10)') === 1024);
  check('mod(7,3) = 1', ev('mod(7,3)') === 1);
  check('round(2.5) = 3', ev('round(2.5)') === 3);
  check('floor(2.9) = 2', ev('floor(2.9)') === 2);
  check('ceil(2.1) = 3', ev('ceil(2.1)') === 3);
  check('log10(1000) = 3', near(ev('log10(1000)'), 3));
  check('exp(0) = 1', ev('exp(0)') === 1);
  check('min(3,1,2) = 1', ev('min(3,1,2)') === 1);
  check('max(3,1,2) = 3', ev('max(3,1,2)') === 3);
  check('sum(1,2,3) = 6', ev('sum(1,2,3)') === 6);
  check('avg(2,4,6) = 4', ev('avg(2,4,6)') === 4);
  check('count(1,2,3) = 3', ev('count(1,2,3)') === 3);
  check('pi ≈ 3.14159265', near(ev('pi'), Math.PI, 1e-12));
  check('e ≈ 2.71828182', near(ev('e'), Math.E, 1e-12));
  check('嵌套：sqrt(pow(3,2)+pow(4,2)) = 5', near(ev('sqrt(pow(3,2)+pow(4,2))'), 5, 1e-12));
  check('函数名大小写不敏感 SIN(90)=1', near(ev('SIN(90)'), 1, 1e-12));
  check('sin 需要 1 个参数 → 报错', /需要 1 个参数/.test(err(() => ev('sin(1,2)'))));
  check('未知函数 → 报错', /未知函数/.test(err(() => ev('foo(1)'))));
}

// ============================================================
console.log('\n【单位后缀（紧贴数字）】');
{
  check('10mm = 10', ev('10mm') === 10);
  check('1cm = 10', ev('1cm') === 10);
  check('1m = 1000', ev('1m') === 1000);
  check('1km = 1000000', ev('1km') === 1e6);
  check('1in = 25.4', near(ev('1in'), 25.4));
  check('2ft = 609.6', near(ev('2ft'), 609.6));
  check('100mil = 2.54', near(ev('100mil'), 2.54));
  check('1rad ≈ 57.29578', near(ev('1rad'), 180 / Math.PI, 1e-9));
  check('90deg = 90', ev('90deg') === 90);
  check('100gon = 90', near(ev('100gon'), 90));
  check('45° = 45', ev('45°') === 45);
  check('2cm+3mm = 23', near(ev('2cm+3mm'), 23));
  check('有空格则不是单位（2 mm → 解析成两个记号）', /多余的内容/.test(err(() => ev('2 mm'))));
}

// ============================================================
console.log('\n【引用解析】');
{
  const table: Record<string, number> = { 板厚: 10, 宽度: 40 };
  const res = (parts: string[], index?: number) => {
    if (parts.length === 1) {
      if (parts[0] in table) return table[parts[0]];
      throw new ExprError(`未知参数「${parts[0]}」`);
    }
    throw new ExprError('no');
  };
  check('裸标识符引用参数', evalExpression('板厚*2', res) === 20);
  check('中文参数名参与运算', evalExpression('(板厚+宽度)*2', res) === 100);
  const refs = collectRefs(parse('板厚*2 + sqrt(宽度)'));
  check('collectRefs 收集引用（不含函数名）', JSON.stringify(refs) === JSON.stringify([['板厚'], ['宽度']]),
    JSON.stringify(refs));

  const propRes = (parts: string[], index?: number) => {
    if (parts.join('.') === '拉伸1.distance') return 25;
    if (parts[0] === '长方体1' && parts[1] === 'dims' && index === 0) return 8;
    throw new ExprError('no');
  };
  check('特征属性引用 拉伸1.distance', evalExpression('拉伸1.distance*2', propRes) === 50);
  check('数组属性引用 长方体1.dims[0]', evalExpression('长方体1.dims[0]*5', propRes) === 40);
}

// ============================================================
console.log('\n【参数路径工具】');
{
  const p: any = { distance: 10, dims: [3, 4, 5], nested: { a: 1 } };
  check('getParamPath 标量', getParamPath(p, 'distance') === 10);
  check('getParamPath 数组元素', getParamPath(p, 'dims[1]') === 4);
  check('getParamPath 越界 → undefined', getParamPath(p, 'dims[9]') === undefined);
  check('getParamPath 非数值 → undefined', getParamPath(p, 'nested') === undefined);
  setParamPath(p, 'distance', 99);
  check('setParamPath 标量', p.distance === 99);
  setParamPath(p, 'dims[2]', 50);
  check('setParamPath 数组元素', p.dims[2] === 50);

  const list = listNumericParams({ distance: 10, reverse: true, dims: [3, 4], name: 'x' });
  check('listNumericParams 只收数值/数值数组', list.length === 3, JSON.stringify(list.map((x) => x.path)));
  check('listNumericParams 数组展开为 dims[0]/dims[1]', list.some((x) => x.path === 'dims[0]') && list.some((x) => x.path === 'dims[1]'));
  check('listNumericParams 带中文标签', list.find((x) => x.path === 'distance')?.label === '距离');
}

// ============================================================
console.log('\n【错误处理】');
{
  check('除数为 0 → 报错', /除数为 0/.test(err(() => ev('1/0'))));
  check('取模 0 → 报错', /除数为 0/.test(err(() => ev('1%0'))));
  check('括号不匹配 → 报错', /期望/.test(err(() => ev('(1+2'))));
  check('多余内容 → 报错', /多余/.test(err(() => ev('1 2'))));
  check('表达式不完整 → 报错', /不完整/.test(err(() => ev('1+'))));
  check('下标必须是非负整数', /下标/.test(err(() => ev('a[-1]'))));
  check('只有引用可带下标', /下标/.test(err(() => ev('(1+2)[0]'))));
  check('空表达式 → 报错', /不完整/.test(err(() => ev(''))));
  check('文档级空表达式 → 报错', /为空/.test(
    (() => { const r = resolveExpressions({ features: [], params: [{ name: 'z', expr: '  ' }] }); return r.issues[0]?.message ?? ''; })()
  ));
  check('未知参数 → 报错', /未知参数/.test(err(() => ev('不存在'))));
}

// ============================================================
console.log('\n【文档级解析：参数表】');
{
  const doc = {
    features: [] as Feature[],
    params: [
      { name: '宽', expr: '40' },
      { name: '高', expr: '=宽/2' },
      { name: '面积', expr: '宽*高' },
    ] as ParamDef[],
  };
  const r = resolveExpressions(doc);
  check('参数求值：宽 = 40', r.paramValues['宽'] === 40);
  check('参数引用参数：高 = 20（支持 = 前缀）', r.paramValues['高'] === 20);
  check('参数参与运算：面积 = 800', r.paramValues['面积'] === 800);
  check('无问题', r.issues.length === 0, JSON.stringify(r.issues));

  const doc2 = {
    features: [] as Feature[],
    params: [
      { name: 'a', expr: 'b+1' },
      { name: 'b', expr: 'a+1' },
    ] as ParamDef[],
  };
  const r2 = resolveExpressions(doc2);
  check('循环引用被检测', r2.issues.length >= 1 && /循环引用/.test(r2.issues[0].message), r2.issues[0]?.message);

  const doc3 = { features: [] as Feature[], params: [{ name: 'x', expr: '未知的' }] as ParamDef[] };
  const r3 = resolveExpressions(doc3);
  check('未知引用 → 问题列表带位置', r3.issues[0]?.where === '参数:x', r3.issues[0]?.where);
  check('未知引用 → 值为 undefined', r3.paramValues['x'] === undefined);
}

// ============================================================
console.log('\n【文档级解析：特征表达式】');
{
  const feat = (over: Partial<Feature> & { id: string; name: string; params: any }): Feature =>
    ({ type: 'primitive', ...over } as unknown as Feature);

  const box = feat({ id: 'f1', name: '长方体1', params: { kind: 'box', dims: [20, 20, 20] } });
  const doc = { features: [box], params: [{ name: '边长', expr: '30' }] as ParamDef[] };
  (box as any).expressions = { 'dims[0]': '=边长', 'dims[1]': '边长/2' };
  const r = resolveExpressions(doc);
  check('特征表达式求值写入解析后特征', (r.features[0].params as any).dims[0] === 30 && (r.features[0].params as any).dims[1] === 15,
    JSON.stringify((r.features[0].params as any).dims));
  check('原文档未被修改（深拷贝）', (box.params as any).dims[0] === 20);
  check('未绑定的字段保持原值', (r.features[0].params as any).dims[2] === 20);

  // 特征之间互相引用
  const a = feat({ id: 'fa', name: '长方体1', params: { kind: 'box', dims: [10, 10, 10] } });
  const b = feat({ id: 'fb', name: '长方体2', params: { kind: 'box', dims: [1, 1, 1] } });
  (b as any).expressions = { 'dims[0]': '长方体1.dims[0]*3' };
  const r2 = resolveExpressions({ features: [a, b], params: [] });
  check('特征引用特征属性', (r2.features[1].params as any).dims[0] === 30, JSON.stringify((r2.features[1].params as any).dims));

  // 特征 ← 参数 ← 特征 的跨链引用
  const c = feat({ id: 'fc', name: '长方体1', params: { kind: 'box', dims: [8, 8, 8] } });
  const d = feat({ id: 'fd', name: '长方体2', params: { kind: 'box', dims: [1, 1, 1] } });
  (d as any).expressions = { 'dims[0]': 'k*2' };
  const r3 = resolveExpressions({ features: [c, d], params: [{ name: 'k', expr: '长方体1.dims[0]+2' }] });
  check('参数引用特征、特征再引用参数', (r3.features[1].params as any).dims[0] === 20, JSON.stringify((r3.features[1].params as any).dims));

  // 错误聚合到特征
  const e1 = feat({ id: 'fe', name: '长方体1', params: { kind: 'box', dims: [1, 1, 1] } });
  (e1 as any).expressions = { 'dims[0]': '不存在的参数' };
  const r4 = resolveExpressions({ features: [e1], params: [] });
  check('特征表达式错误 → featureIssues', r4.featureIssues.length === 1 && r4.featureIssues[0].id === 'fe',
    JSON.stringify(r4.featureIssues));
  check('特征表达式错误 → issues 位置正确', r4.issues[0].where === '特征:长方体1.dims[0]', r4.issues[0].where);
  check('出错时保留字面值', (r4.features[0].params as any).dims[0] === 1);

  // 特征自身循环
  const g = feat({ id: 'fg', name: '长方体1', params: { kind: 'box', dims: [1, 1, 1] } });
  (g as any).expressions = { 'dims[0]': '长方体1.dims[1]', 'dims[1]': '长方体1.dims[0]' };
  const r5 = resolveExpressions({ features: [g], params: [] });
  check('特征属性自环被检测', r5.issues.some((i) => /循环引用/.test(i.message)), JSON.stringify(r5.issues.map((i) => i.message)));

  // 引用不存在的属性
  const h = feat({ id: 'fh', name: '长方体1', params: { kind: 'box', dims: [1, 1, 1] } });
  (h as any).expressions = { 'dims[0]': '长方体1.不存在' };
  const r6 = resolveExpressions({ features: [h], params: [] });
  check('引用不存在的属性 → 报错', /没有数值属性/.test(r6.issues[0].message), r6.issues[0]?.message);
}

// ============================================================
console.log('\n【表达式预览】');
{
  const doc = { features: [] as Feature[], params: [{ name: '板厚', expr: '6' }] as ParamDef[] };
  const ok = previewExpression('板厚*3+2', doc);
  check('preview 正常求值', ok.ok && ok.value === 20, JSON.stringify(ok));
  const bad = previewExpression('板厚*', doc);
  check('preview 语法错误返回 message', !bad.ok && /解析失败/.test(bad.message ?? ''), JSON.stringify(bad));
  const bad2 = previewExpression('没有这个', doc);
  check('preview 未知引用返回 message', !bad2.ok && /未知参数/.test(bad2.message ?? ''), JSON.stringify(bad2));
}

// ============================================================
console.log(`\n表达式引擎：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
