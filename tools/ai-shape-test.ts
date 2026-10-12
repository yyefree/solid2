/**
 * AI 建模助手 · 几何验证（需要 OCCT）。
 *
 * 纯逻辑由 tools/ai-test.ts 覆盖；这里验证「自然语言 → 特征 → 真几何」这一整条链路，
 * 并把结果与**解析解**对拍（体积），确保 AI 产出的不是"看起来对"而是真的对。
 *
 * 运行: node tools/run-ts.mjs tools/ai-shape-test.ts
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { CadDocument } from '../src/doc/model';
import { rebuildFeatures } from '../src/doc/engine';
import { interpret } from '../src/ai';

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
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

const oc = await initOcctNode();
setOcct(oc);
console.log('内核已注入\n');

interface Built {
  vol: number;
  errors: string[];
  features: number;
}

/** 自然语言 → 特征 → 重建 → 体积 */
async function build(text: string): Promise<Built> {
  const { compiled } = await interpret(text);
  const doc = new CadDocument();
  for (const f of compiled.features) doc.add(f);
  const { shape, errors } = rebuildFeatures(doc.features);
  return {
    vol: shape ? S.volume(shape) : 0,
    errors: errors.map((e) => e.message),
    features: doc.features.length,
  };
}

const PI = Math.PI;

// ============================================================
console.log('\n【A. 基本体】');
{
  const r = await build('60x40x10 的长方体');
  check('长方体 60×40×10 = 24000', near(r.vol, 24000, 0.5), `= ${r.vol.toFixed(2)}`);
  check('无内核错误', r.errors.length === 0, r.errors.join('; '));

  const c = await build('半径20高50的圆柱');
  check('圆柱 ⌀40×50 = 62831.85', near(c.vol, PI * 400 * 50, 2), `= ${c.vol.toFixed(2)}`);

  const s = await build('球半径15');
  check('球 R15 = 14137.17', near(s.vol, (4 / 3) * PI * 3375, 2), `= ${s.vol.toFixed(2)}`);

  const cube = await build('边长40的立方体');
  check('立方体 40³ = 64000', near(cube.vol, 64000, 0.5), `= ${cube.vol.toFixed(2)}`);
}

// ============================================================
console.log('\n【B. 布尔与孔】');
{
  const r = await build('60x40x10 的长方体，中心开半径8的通孔');
  const expect = 24000 - PI * 64 * 10;
  check('长方体 − Φ16 通孔 = 21989.38', near(r.vol, expect, 2), `= ${r.vol.toFixed(2)} 期望 ${expect.toFixed(2)}`);
  check('无内核错误', r.errors.length === 0, r.errors.join('; '));

  const r2 = await build('半径20高50的圆柱，上面加一个半径8高12的圆柱');
  const expect2 = PI * 400 * 50 + PI * 64 * 12;
  check('两段圆柱叠放 = 65244.60', near(r2.vol, expect2, 3), `= ${r2.vol.toFixed(2)} 期望 ${expect2.toFixed(2)}`);

  const r3 = await build('边长40的立方体，中心开Φ12通孔');
  const expect3 = 64000 - PI * 36 * 40;
  check('立方体 − Φ12 通孔 = 59476.11', near(r3.vol, expect3, 2), `= ${r3.vol.toFixed(2)} 期望 ${expect3.toFixed(2)}`);

  const r4 = await build('60x40x10 的长方体，切除一个半径5高30的圆柱');
  const expect4 = 24000 - PI * 25 * 10; // 切除圆柱贯穿板厚
  check('长方体 − R5 圆柱切除 ≈ 23214.60', near(r4.vol, expect4, 3), `= ${r4.vol.toFixed(2)} 期望 ${expect4.toFixed(2)}`);
}

// ============================================================
console.log('\n【C. 圆角 / 倒角 / 抽壳】');
{
  const r = await build('60x40x10 的长方体，四角倒圆角R5');
  const expect = 24000 - 4 * (25 - (PI * 25) / 4) * 10;
  check('四角圆角 R5 = 23785.40', near(r.vol, expect, 1), `= ${r.vol.toFixed(2)} 期望 ${expect.toFixed(2)}`);
  check('无内核错误', r.errors.length === 0, r.errors.join('; '));

  const c = await build('60x40x10 的长方体，四角倒角4');
  const expect2 = 24000 - 4 * (16 / 2) * 10; // 每个角去掉 4×4/2 的三角棱柱
  check('四角倒角 4 = 23680.00', near(c.vol, expect2, 1), `= ${c.vol.toFixed(2)} 期望 ${expect2.toFixed(2)}`);

  const sh = await build('长80宽60高20的板，顶面抽壳3');
  const expect3 = 80 * 60 * 20 - 74 * 54 * 17;
  check('顶面抽壳 3 = 28068.00', near(sh.vol, expect3, 2), `= ${sh.vol.toFixed(2)} 期望 ${expect3.toFixed(2)}`);
  check('无内核错误', sh.errors.length === 0, sh.errors.join('; '));
}

// ============================================================
console.log('\n【D. 综合：一句话多特征】');
{
  const r = await build('60x40x10 的长方体，中心开半径8的通孔，四角倒圆角R5');
  const expect = 24000 - PI * 64 * 10 - 4 * (25 - (PI * 25) / 4) * 10;
  check('3 特征链路 = 21774.78', near(r.vol, expect, 3), `= ${r.vol.toFixed(2)} 期望 ${expect.toFixed(2)}`);
  check('产出 3 个特征', r.features === 3, `n=${r.features}`);
  check('无内核错误', r.errors.length === 0, r.errors.join('; '));

  const r2 = await build('长80宽60高20的板，四角倒角4，顶面抽壳3');
  // 外壳先倒角再抽壳：倒角在外轮廓上，抽壳按偏移内缩
  check('倒角+抽壳链路产出 3 特征', r2.features === 3, `n=${r2.features}`);
  check('倒角+抽壳体积合理（< 实心）', r2.vol > 0 && r2.vol < 80 * 60 * 20, `= ${r2.vol.toFixed(2)}`);
}

// ============================================================
console.log(`\nAI 几何验证：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
