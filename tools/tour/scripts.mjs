/**
 * 巡演脚本库。
 *
 * 每个脚本描述「这次巡演演什么」：
 *   - 能力巡演（草图/特征/阵列/装配/工程图…）的参数化内容：AI 提示词、底板尺寸、
 *     工程特征参数、基本体清单、曲线参数、阵列参数、缩放系数、表达式参数；
 *   - 以及若干**专属场景**（`extras`）——由脚本自己给出的代码片段构成，
 *     用页面内的 `__D` 建模句柄搭建，是每个脚本最有辨识度的部分。
 *
 * 运行器 `tools/all-features-demo.mjs` 默认**轮换**：每次运行自动挑一个与上次不同的脚本，
 * 于是每次录出来的视频都不一样。也可以用 `--script <id>` 指定、`--list` 列出全部。
 *
 * 字段全部可选，缺省即「经典」脚本的值 —— 新脚本只写自己关心的部分即可。
 *
 * ⚠️ 几何约定（写 extras 时必须遵守）：
 *   - `__D.box/prim` 的 `origin` 是**角点**（不是中心）：`box(dx,dy,dz,o)` 占据
 *     `o ~ o+[dx,dy,dz]`；圆柱/圆锥/圆环同理，底面在 `o`、沿 +Z 生长。
 *   - 只有 `sphere` 是**中心**落位（`BRepPrimAPI_MakeSphere_1`）。
 *   - 布尔 `op`：`'new'` 独立新体、`'add'` 并、`'cut'` 差。默认 `'new'`。
 *   - `__D.cirPattern(axisOrigin, axisDir, count, totalAngleDeg, equalSpacing)` **不接受 seed**，
 *     它阵列「特征树里最后一个特征」——所以要先建种子再调它。
 */

/** 经典全功能（基线，数值与历史巡演一致） */
const classic = {
  id: 'classic',
  label: '经典全功能',
  desc: '全功能基线：板 + 沉头孔 + 圆角，五种基本体，阵列与多实体',
  ai: {
    create: '长80宽60高20的板，中心开Φ8的沉头孔，沉头直径14深3，四角倒圆角R4',
    edit: '上面加一个半径8高12的圆柱，把高改成20',
    createKw: ['沉头', '圆角'],
    transform: '20x20x20的长方体，整体放大2倍',
  },
  base: { w: 80, h: 60, t: 14, holeR: 12 },
  features: { filletR: 3, chamferD: 2, shellT: 3, draftDeg: 8, ribT: 6, ribD: 14 },
  primitives: [
    ['box', [24, 24, 24], [-70, -10, 0]],
    ['cylinder', [12, 40], [-30, -10, 0]],
    ['sphere', [14], [6, -10, 0]],
    ['cone', [14, 6, 36], [42, -10, 0]],
    ['torus', [16, 5], [86, -10, 0]],
  ],
  curve: {
    spring: { meanDiameter: 30, wireDiameter: 4, pitch: 10, turns: 6 },
    spiral: { startRadius: 12, pitch: 6, turns: 4, thickness: 2.5, width: 5 },
  },
  pattern: {
    linear: { count: 5, spacing: 20, size: 10, at: [-40, 0, 0] },
    // 圆周阵列：圆盘 discR/h 上开一个 φ2·holeR 通孔，再绕 Z 均布 count 份
    circular: { count: 6, discR: 40, h: 16, holeR: 5, at: 30 },
  },
  scale: 2,
  param: { name: '板厚', a: 8, b: 20, rect: [50, 30] },
  extras: [
    {
      title: '专属场景 · 组合体（底板 + 4 角凸台 + 中心通孔）',
      sub: '板 → 4 次布尔并 → 通孔切除',
      code: `(async () => {
        __D.reset();
        __D.box(100, 70, 12, [0,0,0]);
        for (const [x, y] of [[0,0],[84,0],[0,54],[84,54]]) {
          __D.box(16, 16, 10, [x, y, 9], 'add');
        }
        await __D.app.rebuild();
        const f = __D.topFace();
        const pl = { origin: [...f.centroid], u: [1,0,0], v: [0,1,0], normal: [...f.normal], ref: '顶面' };
        __D.hole(pl, [0,0], 'simple', 30, 12, true);
        return __D.rebuild();
      })()`,
      // 84000 + 4·2560 − 4·768 = 91168；再减通孔 π·15²·12 = 8482.3 → 82685.7
      holdMs: 2600,
      expect: { solids: 1, volumeBetween: [80000, 85500] },
    },
  ],
};

/** 法兰 / 端盖专题：圆盘 + 均布孔 */
const flange = {
  id: 'flange',
  label: '法兰 · 端盖专题',
  desc: '圆盘类零件：中心阶梯孔 + 圆周均布沉头孔 + 均布通孔',
  ai: {
    create: '直径120高20的圆盘，中心开Φ40的通孔',
    edit: '上面加一个半径40高12的圆柱，把直径改成60',
    createKw: ['通孔', '圆盘', '圆柱'],
    transform: '长120宽80高20的板，右边加一个半径15高20的圆柱，沿右视基准面镜像',
  },
  base: { w: 100, h: 100, t: 12, holeR: 20 },
  features: { filletR: 4, chamferD: 3, shellT: 4, draftDeg: 6, ribT: 8, ribD: 16 },
  primitives: [
    ['box', [30, 30, 30], [-110, -15, 0]],
    ['cylinder', [16, 50], [-60, -15, 0]],
    ['sphere', [18], [0, -15, 0]],
    ['cone', [18, 8, 44], [60, -15, 0]],
    ['torus', [20, 6], [120, -15, 0]],
  ],
  curve: {
    spring: { meanDiameter: 40, wireDiameter: 5, pitch: 12, turns: 5 },
    spiral: { startRadius: 16, pitch: 8, turns: 3, thickness: 3, width: 6 },
  },
  pattern: {
    linear: { count: 4, spacing: 30, size: 12, at: [-60, 0, 0] },
    circular: { count: 8, discR: 50, h: 20, holeR: 6, at: 35 },
  },
  scale: 3,
  param: { name: '法兰厚', a: 12, b: 24, rect: [60, 60] },
  extras: [
    {
      title: '专属场景 · 法兰盘（Φ140 外圆 + 中心通孔 + 8×沉头孔）',
      sub: '中心孔 + 一个沉头孔 → 圆周阵列 8 份',
      code: `(async () => {
        __D.reset();
        __D.prim('cylinder', [70, 18], [0,0,0]);
        await __D.app.rebuild();
        const f = __D.topFace();
        const pl = { origin: [...f.centroid], u: [1,0,0], v: [0,1,0], normal: [...f.normal], ref: '顶面' };
        __D.hole(pl, [0,0], 'simple', 50, 18, true);
        const hb = __D.hole(pl, [55,0], 'counterbore', 10, 18, true, { boreDiameter: 18, boreDepth: 6 });
        __D.cirPattern([0,0,0], [0,0,1], 8, 360, true, hb);
        return __D.rebuild();
      })()`,
      // π·70²·18 = 277088.9 − 中心孔 π·25²·18 = 35342.9 − 8×(π·5²·18 + π·(9²−5²)·6) = 8×2469.3
      holdMs: 2800,
      expect: { solids: 1, volumeBetween: [215000, 228000] },
    },
    {
      title: '专属场景 · 端盖（圆盘 + 中心阶梯孔 + 6×均布通孔）',
      sub: '中心柱形沉头孔 + 6 个 φ16 通孔圆周均布',
      code: `(async () => {
        __D.reset();
        __D.prim('cylinder', [60, 25], [0,0,0]);
        await __D.app.rebuild();
        const f = __D.topFace();
        const pl = { origin: [...f.centroid], u: [1,0,0], v: [0,1,0], normal: [...f.normal], ref: '顶面' };
        __D.hole(pl, [0,0], 'counterbore', 30, 25, true, { boreDiameter: 50, boreDepth: 8 });
        const hb = __D.hole(pl, [45,0], 'simple', 16, 25, true);
        __D.cirPattern([0,0,0], [0,0,1], 6, 360, true, hb);
        return __D.rebuild();
      })()`,
      // π·60²·25 = 282743.3 − π·15²·25 = 17671.5 − π·(25²−15²)·8 = 10053.1 − 6·π·8²·25 = 30159.3
      holdMs: 2800,
      expect: { solids: 1, volumeBetween: [218000, 232000] },
    },
  ],
};

/** 支架 / 筋板专题：板类 + L 形 + 加强筋 */
const bracket = {
  id: 'bracket',
  label: '支架 · 筋板专题',
  desc: '板类结构件：L 形支架、加强筋、大圆角',
  ai: {
    create: '长120宽80高15的板，中心开Φ30的通孔，四角倒圆角R6',
    edit: '上面加一个半径12高40的圆柱，把高改成30',
    createKw: ['通孔', '圆角'],
    transform: '长120宽80高15的板，侧面拔模5度',
  },
  base: { w: 120, h: 80, t: 15, holeR: 15 },
  features: { filletR: 6, chamferD: 4, shellT: 5, draftDeg: 5, ribT: 10, ribD: 20 },
  primitives: [
    ['box', [40, 40, 20], [-130, -20, 0]],
    ['cylinder', [20, 60], [-68, -20, 0]],
    ['sphere', [16], [0, -20, 0]],
    ['cone', [20, 10, 50], [70, -20, 0]],
    ['torus', [24, 6], [140, -20, 0]],
  ],
  curve: {
    spring: { meanDiameter: 36, wireDiameter: 4, pitch: 9, turns: 7 },
    spiral: { startRadius: 14, pitch: 7, turns: 5, thickness: 2.5, width: 5 },
  },
  pattern: {
    linear: { count: 6, spacing: 25, size: 10, at: [-60, 0, 0] },
    circular: { count: 4, discR: 45, h: 24, holeR: 8, at: 28 },
  },
  scale: 1.5,
  param: { name: '底板厚', a: 10, b: 25, rect: [100, 60] },
  extras: [
    {
      title: '专属场景 · L 形支架（底板 + 立板，两次布尔并）',
      sub: '两块长方体错位融合成 L 形',
      code: `(async () => {
        __D.reset();
        __D.box(120, 80, 15, [0,0,0]);
        __D.box(15, 80, 70, [0,0,10], 'add');
        return __D.rebuild();
      })()`,
      // 144000 + 84000 − 15·80·5（重叠）= 222000
      holdMs: 2400,
      expect: { solids: 1, volumeNear: [222000, 300] },
    },
    {
      title: '专属场景 · 加强筋板（底板 + 筋特征）',
      sub: '开口轮廓沿法向加厚成薄壁并融合',
      code: `(async () => {
        __D.reset();
        __D.box(100, 60, 12, [0,0,0]);
        await __D.app.rebuild();
        const id = __D.sketch('front', (h) => { const a = h.pt(0, 6), b = h.pt(0, 44); h.line(a, b); });
        __D.rib(id, 8, 30);
        return __D.rebuild();
      })()`,
      holdMs: 2600,
      expect: { solids: 1, volumeNear: [79296, 300] },
    },
  ],
};

/** 弹簧 / 曲线专题 */
const spring = {
  id: 'spring',
  label: '弹簧 · 曲线专题',
  desc: '螺旋类零件：左右旋成对、锥形弹簧、涡状线',
  ai: {
    create: '中径30线径4螺距10圈数6的弹簧',
    edit: '把圈数改成10',
    createKw: ['弹簧', '螺旋'],
    transform: '涡状线起始半径12螺距6圈数4厚度2.5宽度5',
  },
  base: { w: 60, h: 40, t: 10, holeR: 8 },
  features: { filletR: 2, chamferD: 1.5, shellT: 2, draftDeg: 10, ribT: 4, ribD: 10 },
  primitives: [
    ['box', [20, 20, 20], [-100, -10, 0]],
    ['cylinder', [10, 30], [-60, -10, 0]],
    ['sphere', [12], [-15, -10, 0]],
    ['cone', [12, 6, 30], [30, -10, 0]],
    ['torus', [14, 4], [80, -10, 0]],
  ],
  curve: {
    spring: { meanDiameter: 50, wireDiameter: 6, pitch: 16, turns: 4 },
    spiral: { startRadius: 20, pitch: 10, turns: 3, thickness: 3, width: 8 },
  },
  pattern: {
    linear: { count: 3, spacing: 40, size: 14, at: [-40, 0, 0] },
    circular: { count: 3, discR: 35, h: 30, holeR: 10, at: 20 },
  },
  scale: 2,
  param: { name: '簧丝', a: 3, b: 5, rect: [40, 20] },
  extras: [
    {
      title: '专属场景 · 双弹簧对（右旋 + 左旋并排）',
      sub: '同一螺旋参数、两种旋向',
      code: `(async () => {
        __D.reset();
        __D.spring({ origin: [-30,0,0], meanDiameter: 30, wireDiameter: 4, pitch: 10, turns: 6, handedness: 'right' });
        __D.spring({ origin: [ 30,0,0], meanDiameter: 30, wireDiameter: 4, pitch: 10, turns: 6, handedness: 'left' });
        return __D.rebuild();
      })()`,
      // 单圈路径长 √((2π·15)²+10²) = 94.76，截面积 π·2² → 每圈 1190.8，6 圈 ×2 支 ≈ 14290
      holdMs: 2600,
      expect: { solids: 12, volumeBetween: [13000, 15600] },
    },
    {
      title: '专属场景 · 弹簧 + 座圈（锥度弹簧坐在圆柱座上）',
      sub: '圆柱底座 + 锥度弹簧布尔并',
      code: `(async () => {
        __D.reset();
        __D.prim('cylinder', [26, 8], [0,0,0]);
        await __D.app.rebuild();
        __D.spring({ origin: [0,0,8], meanDiameter: 40, wireDiameter: 5, pitch: 14, turns: 5, taperDeg: 18, operation: 'add' });
        return __D.rebuild();
      })()`,
      // 底座 π·26²·8 = 16989.7；锥度弹簧（半径 20 → 44.4）路径长约 1012 → 体积 ≈ 19870
      holdMs: 2800,
      expect: { volumeBetween: [32000, 43000] },
    },
  ],
};

export const SCRIPTS = [classic, flange, bracket, spring];

/** 按 id 取脚本；未找到返回 null */
export function scriptById(id) {
  return SCRIPTS.find((s) => s.id === id) ?? null;
}

/** 把脚本的缺省字段补成完整对象（未写的字段回落到「经典」脚本） */
export function withDefaults(script) {
  const merged = { ...classic, ...script };
  merged.ai = { ...classic.ai, ...(script.ai ?? {}) };
  merged.base = { ...classic.base, ...(script.base ?? {}) };
  merged.features = { ...classic.features, ...(script.features ?? {}) };
  merged.curve = {
    spring: { ...classic.curve.spring, ...(script.curve?.spring ?? {}) },
    spiral: { ...classic.curve.spiral, ...(script.curve?.spiral ?? {}) },
  };
  merged.pattern = {
    linear: { ...classic.pattern.linear, ...(script.pattern?.linear ?? {}) },
    circular: { ...classic.pattern.circular, ...(script.pattern?.circular ?? {}) },
  };
  merged.param = { ...classic.param, ...(script.param ?? {}) };
  merged.primitives = script.primitives ?? classic.primitives;
  merged.extras = script.extras ?? [];
  merged.scale = script.scale ?? classic.scale;
  return merged;
}
