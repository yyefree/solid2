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
import { interpret, editModel, boxRefOf } from '../src/ai';
import { spiralRibbon2D } from '../src/sketch/curve';

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
console.log('\n【E. 编辑现有模型：追加 / 改尺寸 / 删除】');
{
  /**
   * 先按 `createText` 建模，再依次执行编辑指令；
   * 每一步都真重建一次，返回各阶段体积（stages[0] = 初始模型）。
   */
  async function flow(createText: string, steps: string[]) {
    const { compiled } = await interpret(createText);
    let features = compiled.features;
    let bbox = compiled.bbox;
    const stages: Built[] = [];
    const errors: string[] = [];
    const snap = () => {
      const { shape, errors: es } = rebuildFeatures(features);
      stages.push({ vol: shape ? S.volume(shape) : 0, errors: es.map((e) => e.message), features: features.length });
    };
    snap();
    for (const s of steps) {
      const run = editModel(s, { features, bbox, boxForRefs: boxRefOf(features) });
      errors.push(...run.issues.filter((i) => i.level === 'error').map((i) => i.message));
      features = run.features;
      bbox = run.bbox;
      snap();
    }
    return { stages, errors };
  }

  // E1 追加：长方体 + 顶部圆柱凸台
  const e1 = await flow('60x40x10 的长方体', ['上面加一个半径8高12的圆柱']);
  const e1Expect = 24000 + PI * 64 * 12;
  check('追加凸台 = 24000 + π·8²·12 = 26412.74', near(e1.stages[1].vol, e1Expect, 3), `= ${e1.stages[1].vol.toFixed(2)} 期望 ${e1Expect.toFixed(2)}`);
  check('追加后无内核错误', e1.stages[1].errors.length === 0, e1.stages[1].errors.join('; '));

  // E2 改尺寸：板变厚，通孔仍贯穿（依赖特征跟随）
  const e2 = await flow('60x40x10 的长方体，中心开半径8的通孔', ['把高改成20']);
  const e2Expect = 60 * 40 * 20 - PI * 64 * 20;
  check('板厚 10→20 后孔仍贯穿 = 43978.76', near(e2.stages[1].vol, e2Expect, 3), `= ${e2.stages[1].vol.toFixed(2)} 期望 ${e2Expect.toFixed(2)}`);
  check('改尺寸后无内核错误', e2.stages[1].errors.length === 0, e2.stages[1].errors.join('; '));

  // E3 改尺寸：加长后圆角跟随到新角点
  const e3 = await flow('60x40x10 的长方体，四角倒圆角R5', ['把长改成80']);
  const e3Expect = 80 * 40 * 10 - 4 * (25 - (PI * 25) / 4) * 10;
  check('加长 60→80 后四角圆角 = 31785.40', near(e3.stages[1].vol, e3Expect, 2), `= ${e3.stages[1].vol.toFixed(2)} 期望 ${e3Expect.toFixed(2)}`);
  check('圆角跟随到新角点（体积 = 纯圆角板）', e3.stages[1].errors.length === 0, e3.stages[1].errors.join('; '));

  // E4 删除：删掉孔后剩下的实体体积正确
  const e4 = await flow('60x40x10 的长方体，中心开半径8的通孔，四角倒圆角R5', ['删掉孔']);
  const e4Expect = 24000 - 4 * (25 - (PI * 25) / 4) * 10;
  check('删孔后 = 23785.40', near(e4.stages[1].vol, e4Expect, 2), `= ${e4.stages[1].vol.toFixed(2)} 期望 ${e4Expect.toFixed(2)}`);
  check('删孔后剩 2 个特征', e4.stages[1].features === 2, `n=${e4.stages[1].features}`);

  // E5 叠放：长方体加高，顶部圆柱随之抬升
  const e5 = await flow('60x40x10 的长方体，上面加一个半径8高12的圆柱', ['把高改成20']);
  const e5Expect = 60 * 40 * 20 + PI * 64 * 12;
  check('加高后凸台随之抬升 = 50412.74', near(e5.stages[1].vol, e5Expect, 3), `= ${e5.stages[1].vol.toFixed(2)} 期望 ${e5Expect.toFixed(2)}`);
  check('抬升后无内核错误', e5.stages[1].errors.length === 0, e5.stages[1].errors.join('; '));

  // E6 连续编辑：建模 → 加凸台 → 改凸台半径 → 删圆角
  const e6 = await flow('长80宽60高20的板，中心开半径8的通孔，四角倒圆角R4', [
    '上面加一个半径12高10的圆柱',
    '把半径改成15',
    '删掉圆角',
  ]);
  check('三步编辑均无错误', e6.errors.length === 0, e6.errors.join('; '));
  check('编辑后特征数 = 3', e6.stages[3].features === 3, `n=${e6.stages[3].features}`);
  // 板(去圆角) + 凸台，再减贯穿孔
  const e6Expect = 80 * 60 * 20 + PI * 225 * 10 - PI * 64 * 20;
  check('终态体积与解析解一致', near(e6.stages[3].vol, e6Expect, 4), `= ${e6.stages[3].vol.toFixed(2)} 期望 ${e6Expect.toFixed(2)}`);
}

// ============================================================
console.log('\n【F. 异型孔（柱形沉头 / 锥形埋头）】');
{
  // 柱形沉头：主孔 Φ8 通 + 沉头 Φ14 深 3
  //   挖掉 = π·4²·10 + π·(7²−4²)·3 = 160π + 99π = 259π
  const cb = await build('60x40x10 的长方体，中心开Φ8的通孔，沉头直径14深3');
  const cbExp = 24000 - (PI * 16 * 10 + PI * (49 - 16) * 3);
  check('柱形沉头孔无内核错误', cb.errors.length === 0, cb.errors.join('; '));
  check('柱形沉头孔体积 = 23186.33', near(cb.vol, cbExp, 3), `= ${cb.vol.toFixed(2)} 期望 ${cbExp.toFixed(2)}`);

  // 锥形埋头：主孔 Φ8 通 + 圆台 R4→R6 高 3（与主孔重叠部分要扣掉）
  //   挖掉 = π·16·10 + (π·3/3·(16+24+36) − π·16·3) = 160π + 28π = 188π
  const cs = await build('60x40x10 的长方体，中心开Φ8的通孔，埋头直径12深3');
  const csExp = 24000 - (PI * 16 * 10 + (PI * 3 / 3 * (16 + 4 * 6 + 36) - PI * 16 * 3));
  check('锥形埋头孔无内核错误', cs.errors.length === 0, cs.errors.join('; '));
  check('锥形埋头孔体积 = 23409.38', near(cs.vol, csExp, 3), `= ${cs.vol.toFixed(2)} 期望 ${csExp.toFixed(2)}`);

  // 盲孔 + 沉头：深度只算主孔，沉头另外扣
  const blind = await build('60x40x10 的长方体，中心开Φ8的盲孔深6，沉头直径14深3');
  const blindExp = 24000 - (PI * 16 * 6 + PI * (49 - 16) * 3);
  check('盲孔 + 沉头 = 23186.33', near(blind.vol, blindExp, 3), `= ${blind.vol.toFixed(2)} 期望 ${blindExp.toFixed(2)}`);
}

// ============================================================
console.log('\n【G. 弹簧】');
{
  const R = 10, wireR = 1, pitch = 5, turns = 8;
  const L = turns * Math.hypot(2 * PI * R, pitch);
  const exp = PI * wireR * wireR * L;

  const r = await build('中径20线径2螺距5圈数8的弹簧');
  check('弹簧无内核错误', r.errors.length === 0, r.errors.join('; '));
  check('弹簧特征数 = 1', r.features === 1, `n=${r.features}`);
  check('弹簧体积 ≈ π·r²·螺旋长（1% 内）', Math.abs(r.vol - exp) / exp <= 0.01, `= ${r.vol.toFixed(2)} 期望 ${exp.toFixed(2)}`);

  const left = await build('中径20线径2螺距5圈数8的左旋弹簧');
  check('左旋弹簧同样成立', left.errors.length === 0 && Math.abs(left.vol - exp) / exp <= 0.01, `= ${left.vol.toFixed(2)} 期望 ${exp.toFixed(2)}`);

  const taper = await build('中径20线径2螺距5圈数8锥度15的弹簧');
  check('锥形弹簧求值成功', taper.errors.length === 0, taper.errors.join('; '));
  check('锥形弹簧体积明显大于等参数圆柱弹簧（半径沿轴增大 → 螺旋更长）', taper.vol > r.vol * 1.2,
    `${taper.vol.toFixed(2)} > ${(r.vol * 1.2).toFixed(2)}`);

  // 弹簧坐在长方体顶面（不相交，体积应相加）
  const combo = await build('60x40x10 的长方体，上面加一个中径20线径2螺距5圈数8的弹簧');
  const comboExp = 24000 + exp;
  check('长方体 + 顶部弹簧无内核错误', combo.errors.length === 0, combo.errors.join('; '));
  check('长方体 + 顶部弹簧 ≈ 24000 + 弹簧体积（3% 内）', Math.abs(combo.vol - comboExp) / comboExp <= 0.03,
    `= ${combo.vol.toFixed(2)} 期望 ${comboExp.toFixed(2)}`);
}

// ============================================================
console.log('\n【H. 变换与曲线：缩放 / 镜像 / 涡状线 / 拔模】');
{
  // ---- 缩放（以模型包围盒中心为不动点）----
  const s2 = await build('20x20x20的长方体，整体放大2倍');
  check('缩放 2× 无内核错误', s2.errors.length === 0, s2.errors.join('; '));
  check('缩放 2×：体积 ×8 = 64000', near(s2.vol, 64000, 0.5), `= ${s2.vol.toFixed(2)}`);

  const s15 = await build('40x30x10的长方体，整体放大1.5倍');
  check('缩放 1.5×：体积 ×1.5³ = 40500', near(s15.vol, 12000 * 1.5 ** 3, 0.5), `= ${s15.vol.toFixed(2)}`);

  const sh = await build('40x30x10的长方体，缩小一半');
  check('缩小一半：体积 ×1/8 = 1500', near(sh.vol, 1500, 0.5), `= ${sh.vol.toFixed(2)}`);

  const sx = await build('40x30x10的长方体，沿X放大2倍');
  check('非均匀缩放：80×30×10 = 24000', near(sx.vol, 24000, 0.5), `= ${sx.vol.toFixed(2)}`);

  const sf = await build('20x20x20的长方体，整体放大2倍，四角倒圆角R2');
  check('缩放后仍可倒圆角（解析式引用保留）', sf.errors.length === 0 && sf.vol < 64000 && sf.vol > 60000,
    `= ${sf.vol.toFixed(2)}`);

  // ---- 镜像 ----
  const mir = await build('长40宽30高10的板，右边加一个半径5高10的圆柱，沿右视基准面镜像');
  const mirExp = 40 * 30 * 10 + 2 * PI * 25 * 10;
  check('镜像无内核错误', mir.errors.length === 0, mir.errors.join('; '));
  check('镜像：板 + 两侧圆柱 = 解析值', near(mir.vol, mirExp, 1), `= ${mir.vol.toFixed(2)} 期望 ${mirExp.toFixed(2)}`);

  const mirSelf = await build('长40宽30高10的板，沿右视基准面镜像');
  check('对称件镜像自身：体积不变 = 12000', near(mirSelf.vol, 12000, 1), `= ${mirSelf.vol.toFixed(2)}`);

  // ---- 涡状线 ----
  const ribbon = spiralRibbon2D({
    startRadius: 12,
    pitch: 6,
    turns: 4,
    thickness: 2.5,
    handedness: 'right',
    segsPerTurn: 36,
  });
  let acc = 0;
  for (let i = 0; i < ribbon.length; i++) {
    const [x1, y1] = ribbon[i];
    const [x2, y2] = ribbon[(i + 1) % ribbon.length];
    acc += x1 * y2 - x2 * y1;
  }
  const spExp = (Math.abs(acc) / 2) * 5; // 带材多边形面积（鞋带公式）× 宽度
  const sp = await build('涡状线起始半径12螺距6圈数4厚度2.5宽度5');
  check('涡状线无内核错误', sp.errors.length === 0, sp.errors.join('; '));
  check('涡状线体积 = 带材多边形面积 × 宽度', near(sp.vol, spExp, spExp * 0.01),
    `= ${sp.vol.toFixed(2)} 期望 ${spExp.toFixed(2)}`);

  const spOn = await build('60x40x10的长方体，上面加一个涡状线起始半径12螺距6圈数4厚度2.5宽度5');
  const spOnExp = 24000 + spExp;
  check('长方体 + 顶部涡状线 ≈ 解析值（1% 内）',
    Math.abs(spOn.vol - spOnExp) / spOnExp <= 0.01, `= ${spOn.vol.toFixed(2)} 期望 ${spOnExp.toFixed(2)}`);

  // ---- 拔模 ----
  // 中性面取底面、侧面外扩：V = W·D·H + (W+D)·t·H² + (4/3)·t²·H³（t = tan 角）
  const t5 = Math.tan((5 * PI) / 180);
  const draftExp = 24000 + 100 * t5 * 100 + (4 / 3) * t5 * t5 * 1000;
  const dr = await build('60x40x10的长方体，侧面拔模5度');
  check('拔模无内核错误', dr.errors.length === 0, dr.errors.join('; '));
  check('拔模 5°：体积 = 线性锥化解析值', near(dr.vol, draftExp, 1), `= ${dr.vol.toFixed(2)} 期望 ${draftExp.toFixed(2)}`);

  const t3 = Math.tan((3 * PI) / 180);
  const revExp = 24000 - 100 * t3 * 100 + (4 / 3) * t3 * t3 * 1000;
  const rev = await build('60x40x10的长方体，拔模角3度，反向');
  check('反向拔模 3°：侧面内收，体积 = 解析值', near(rev.vol, revExp, 1), `= ${rev.vol.toFixed(2)} 期望 ${revExp.toFixed(2)}`);

  const fd = await build('60x40x10的长方体，四角倒圆角R3，侧面拔模5度');
  check('先倒圆角再拔模：无内核错误且体积略小于纯拔模',
    fd.errors.length === 0 && fd.vol < draftExp && fd.vol > draftExp - 500,
    `= ${fd.vol.toFixed(2)}（纯拔模 ${draftExp.toFixed(2)}）`);
}

// ============================================================
console.log('\n【I. 多实体编辑：移动/复制 · 删除 · 组合】');
{
  /** 需要体积 / 实体数 / 包围盒的完整构建 */
  async function buildFull(text: string) {
    const { compiled } = await interpret(text);
    const doc = new CadDocument();
    for (const f of compiled.features) doc.add(f);
    const { shape, errors } = rebuildFeatures(doc.features);
    return {
      vol: shape ? S.volume(shape) : 0,
      solids: shape ? S.bodiesOf(shape).length : 0,
      bb: shape ? S.shapeBBox(shape) : null,
      errors: errors.map((e) => e.message),
    };
  }

  // ---- 平移：体积不变、位置整体移动 ----
  const t1 = await buildFull('80x60x20的长方体，整体沿Z移动50');
  check('平移：无内核错误', t1.errors.length === 0, t1.errors.join('; '));
  check('平移：体积不变 = 96000', near(t1.vol, 96000, 0.5), `= ${t1.vol.toFixed(2)}`);
  check(
    '平移：包围盒 Z 由 [-10,10] → [40,60]',
    !!t1.bb && near(t1.bb.min[2], 40, 0.5) && near(t1.bb.max[2], 60, 0.5),
    t1.bb ? `Z ∈ [${t1.bb.min[2].toFixed(2)}, ${t1.bb.max[2].toFixed(2)}]` : 'null'
  );
  check('平移：仍是 1 个实体', t1.solids === 1, `${t1.solids} 实体`);

  // ---- 旋转：体积不变、包围盒按解析式扩张 ----
  const r1 = await buildFull('80x60x20的长方体，绕Z轴旋转90度');
  check('绕Z轴旋转90°：无内核错误', r1.errors.length === 0, r1.errors.join('; '));
  check('绕Z轴旋转90°：体积不变 = 96000', near(r1.vol, 96000, 0.5), `= ${r1.vol.toFixed(2)}`);
  check(
    '绕Z轴旋转90°：X/Y 尺寸互换（80×60 → 60×80）',
    !!r1.bb &&
      near(r1.bb.max[0] - r1.bb.min[0], 60, 0.5) &&
      near(r1.bb.max[1] - r1.bb.min[1], 80, 0.5),
    r1.bb
      ? `${(r1.bb.max[0] - r1.bb.min[0]).toFixed(2)} × ${(r1.bb.max[1] - r1.bb.min[1]).toFixed(2)}`
      : 'null'
  );

  const r45 = await buildFull('80x60x20的长方体，绕Z轴旋转45度');
  const w45 = 70 / Math.SQRT2;
  check(
    '绕Z轴旋转45°：包围盒 X ∈ ±(80+60)/√2',
    !!r45.bb && near(r45.bb.max[0], w45, 0.5),
    r45.bb ? `X ∈ [${r45.bb.min[0].toFixed(2)}, ${r45.bb.max[0].toFixed(2)}] 期望 ±${w45.toFixed(2)}` : 'null'
  );

  // ---- 复制实体：体积 ×2、2 个实体 ----
  const c1 = await buildFull('20x20x20的长方体，复制一份沿X偏移30');
  check('复制一份：无内核错误', c1.errors.length === 0, c1.errors.join('; '));
  check('复制一份：2 个实体', c1.solids === 2, `${c1.solids} 实体`);
  check('复制一份：体积 ×2 = 16000', near(c1.vol, 16000, 0.5), `= ${c1.vol.toFixed(2)}`);

  // ---- 组合（并集 · 分离体）：体积守恒，但 OCCT 的 Fuse 对分离体仍返回多实体复合体 ----
  const cb = await buildFull('20x20x20的长方体，复制一份沿X偏移30，把两个实体合并');
  check('组合（并集·分离体）：无内核错误', cb.errors.length === 0, cb.errors.join('; '));
  check('组合（并集·分离体）：体积守恒 = 16000', near(cb.vol, 16000, 0.5), `= ${cb.vol.toFixed(2)}`);
  check(
    '组合（并集·分离体）：仍是 2 个实体（OCCT 语义：Fuse 不连接分离体）',
    cb.solids === 2,
    `${cb.solids} 实体`
  );

  // ---- 组合（并集 / 差集 / 交集）：用**相交**的两块验证真合并 ----
  // 两块 20³ 沿 X 错开 10 → 重叠 10×20×20 = 4000
  const ovAdd = await buildFull('20x20x20的长方体，复制一份沿X偏移10，把两个实体合并');
  check('组合（并集·相交）：合并成 1 个实体', ovAdd.solids === 1, `${ovAdd.solids} 实体`);
  check('组合（并集·相交）：体积 = 16000 − 4000 = 12000', near(ovAdd.vol, 12000, 0.5), `= ${ovAdd.vol.toFixed(2)}`);

  const ovSub = await buildFull('20x20x20的长方体，复制一份沿X偏移10，把两个实体相减');
  check('组合（差集）：无内核错误', ovSub.errors.length === 0, ovSub.errors.join('; '));
  check('组合（差集）：体积 = 4000（只留下不重叠的部分）', near(ovSub.vol, 4000, 0.5), `= ${ovSub.vol.toFixed(2)}`);

  const ovCom = await buildFull('20x20x20的长方体，复制一份沿X偏移10，把两个实体的交集取出来');
  check('组合（交集）：无内核错误', ovCom.errors.length === 0, ovCom.errors.join('; '));
  check('组合（交集）：体积 = 重叠部分 4000', near(ovCom.vol, 4000, 0.5), `= ${ovCom.vol.toFixed(2)}`);

  // ---- 删除实体：倒数第 1 个 → 剩原件 ----
  const dl = await buildFull('20x20x20的长方体，复制一份沿X偏移30，删除最后一个实体');
  check('删除最后一个实体：无内核错误', dl.errors.length === 0, dl.errors.join('; '));
  check('删除最后一个实体：回到 1 个实体', dl.solids === 1, `${dl.solids} 实体`);
  check('删除最后一个实体：体积 = 8000', near(dl.vol, 8000, 0.5), `= ${dl.vol.toFixed(2)}`);

  // ---- 平移后仍能解析式倒圆角（长方体引用跟着走） ----
  const base = await interpret('20x20x20的长方体');
  const doc = new CadDocument();
  for (const f of base.compiled.features) doc.add(f);
  const first = rebuildFeatures(doc.features);
  const run = editModel('整体沿X移动100，四角倒圆角R2', {
    features: doc.features,
    bbox: first.shape ? S.shapeBBox(first.shape) : null,
    boxForRefs: boxRefOf(doc.features),
  });
  const doc2 = new CadDocument();
  for (const f of run.features) doc2.add(f);
  const r2 = rebuildFeatures(doc2.features);
  const v2 = r2.shape ? S.volume(r2.shape) : 0;
  // 20³ 四角 R2 竖直圆角：8000 − (4 − π)·R²·H = 8000 − (4−π)·4·20
  const filletExp = 8000 - (4 - PI) * 4 * 20;
  check('平移 100 后四角倒圆角 R2：无内核错误', r2.errors.length === 0, r2.errors.map((e) => e.message).join('; '));
  check('  体积 = 解析值', near(v2, filletExp, 1), `= ${v2.toFixed(2)} 期望 ${filletExp.toFixed(2)}`);
  check(
    '  包围盒随平移落到 X ∈ [90,110]',
    !!r2.shape && near(S.shapeBBox(r2.shape).min[0], 90, 0.5),
    r2.shape ? JSON.stringify(S.shapeBBox(r2.shape).min) : 'null'
  );
}

// ============================================================
console.log(`\nAI 几何验证：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
process.exit(fail ? 1 : 0);
