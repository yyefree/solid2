/**
 * 工程图领域服务单测（纯编排 + 真 Drawing 子文档，不依赖 DOM / 内核 / OCCT）。
 *
 * 覆盖 `src/app/drawing-service.ts` 的核心路径：
 *   - ensureDrawing / setDrawing（子文档惰性创建与换引用）
 *   - generateDrawing / addDrawingView：无模型守卫 → 创建子文档 + 单位制传播 +
 *     固定比例 + emit(drawing,tree)
 *   - toggleDimensionMode 开关（守卫 / 状态栏 / 提示 / 广播）
 *   - placeDrawingDimension：非标注模式 no-op；单边长度；Shift 同视图 → 距离；
 *     无效边只更新 lastDimRun 不提示；lastDimRun 被清除后 Shift 退化为长度
 *   - removeDrawingDim / clearDrawingDims / 自动标注 / 孔位标注 / 标注元数据
 *   - toggleDrawingBOM：守卫 → 装配体来源 → 零件兜底（featureCount 命名）→ 再点清除
 *   - exportDrawingPNG：无工程图 reject + err 提示；正常路径 rasterizePNG → download
 *   - exitDimensionMode（setMode 离开工程图时取消标注会话）
 */
import { Drawing, type DrawingView } from '../src/app/drawing';
import { DrawingService, type DrawingHost } from '../src/app/drawing-service';
import type { MeshResult, ModelResult, BBox } from '../src/core/kernel-types';
import type { UnitSystem } from '../src/core/units';
import type { Assembly } from '../src/app/assembly';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

/** 造一个含两条平行投影边 + 一个正视孔的视图（视图局部 mm 坐标，scale=2） */
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
    holes: [{ cx: 5, cy: 5, dia: 4, round: 1 }],
    bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
  };
}

/** 空网格（generateStandardViews 可接受；产出的视图无边） */
function emptyMesh(): MeshResult {
  return {
    positions: new ArrayBuffer(0),
    normals: new ArrayBuffer(0),
    indices: new ArrayBuffer(0),
    faceRanges: [],
    edgePolylines: [],
    faceMetas: [],
    edgeMetas: [],
  };
}

const emptyBBox: BBox = { min: [0, 0, 0], max: [1, 1, 1] };
function modelWith(mesh: MeshResult): ModelResult {
  return { mesh, bbox: emptyBBox, stats: { volume: 1, area: 1, faces: 1, edges: 1, solids: 1 }, errors: [], rebuildMs: 0 };
}

function makeHost(overrides: Partial<DrawingHost> = {}) {
  const rec = {
    toasts: [] as { kind: string; msg: string }[],
    statuses: [] as { text: string; kind: string; detail?: string }[],
    emits: [] as string[][],
    downloads: [] as { content: ArrayBuffer; filename: string; mime: string }[],
    raster: [] as { svg: string; w: number; h: number; scale: number }[],
  };
  let unit: UnitSystem = 'MMGS';
  let scale = 0;
  const host: DrawingHost = {
    currentModel: () => null,
    unitSystem: () => unit,
    drawingScale: () => scale,
    hasModel: () => false,
    assembly: () => null,
    featureCount: () => 3,
    emit: (...evts) => { rec.emits.push(evts as string[]); },
    setStatus: (text, kind, detail) => { rec.statuses.push({ text, kind, detail }); },
    toast: (kind, msg) => { rec.toasts.push({ kind, msg }); },
    rasterizePNG: async (svg, w, h, sc) => { rec.raster.push({ svg, w, h, scale: sc }); return new ArrayBuffer(8); },
    download: (content, filename, mime) => { rec.downloads.push({ content, filename, mime }); },
    ...overrides,
  };
  const svc = new DrawingService(host);
  const api = {
    svc, rec,
    setUnit: (u: UnitSystem) => { unit = u; },
    setScale: (s: number) => { scale = s; },
  };
  return api;
}

// ---- ensureDrawing / setDrawing ----
{
  const h = makeHost();
  check('初始无子文档', h.svc.drawing === null);
  const d1 = h.svc.ensureDrawing();
  check('ensureDrawing 惰性创建', !!d1 && h.svc.drawing === d1);
  check('ensureDrawing 二次调用同一实例', h.svc.ensureDrawing() === d1);
  h.svc.setDrawing(null);
  check('setDrawing(null) 换引用为空', h.svc.drawing === null);
}

// ---- generateDrawing：守卫 ----
{
  const h = makeHost();
  h.svc.generateDrawing();
  check('generateDrawing 无模型：err 提示且不创建子文档/不广播',
    h.rec.toasts.length === 1 && h.rec.toasts[0].kind === 'err' && h.rec.toasts[0].msg === '没有可生成工程图的实体' &&
    h.svc.drawing === null && h.rec.emits.length === 0, JSON.stringify(h.rec.toasts));
}

// ---- generateDrawing：正常路径 ----
{
  const h = makeHost({ currentModel: () => modelWith(emptyMesh()) });
  h.setUnit('CGS');
  h.setScale(2);
  h.svc.generateDrawing();
  const d = h.svc.drawing!;
  check('generateDrawing：创建子文档 + 单位制传播到 Drawing',
    !!d && d.unitSystem === 'CGS');
  check('generateDrawing：生成 4 个标准视图', d.views.length === 4, `${d.views.length} 个`);
  check('generateDrawing：固定比例生效', d.fixedScale === 2, `fixedScale=${d.fixedScale}`);
  check('generateDrawing：emit(drawing, tree)',
    h.rec.emits.length === 1 && h.rec.emits[0].join(',') === 'drawing,tree');
  check('generateDrawing：无提示（成功路径静默）', h.rec.toasts.length === 0);
  // 再次生成 → 先清空（generateStandardViews 内部 clear）
  h.svc.generateDrawing(['front']);
  check('generateDrawing 指定 kinds：仅 1 个视图（先清空）', h.svc.drawing!.views.length === 1);
}

// ---- addDrawingView ----
{
  const h = makeHost();
  h.svc.addDrawingView('front');
  check('addDrawingView 无模型：err 提示且不创建子文档',
    h.rec.toasts.length === 1 && h.rec.toasts[0].kind === 'err' && h.svc.drawing === null);
}
{
  const h = makeHost({ currentModel: () => modelWith(emptyMesh()) });
  h.svc.generateDrawing(['front', 'top']);
  h.svc.addDrawingView('right');
  check('addDrawingView：追加到 3 个视图 + emit(drawing,tree)',
    h.svc.drawing!.views.length === 3 && h.rec.emits.length === 2 &&
    h.rec.emits[1].join(',') === 'drawing,tree');
}

// ---- refreshDrawing ----
{
  const h = makeHost();
  h.svc.refreshDrawing();
  check('refreshDrawing：仅 emit(drawing)',
    h.rec.emits.length === 1 && h.rec.emits[0].join(',') === 'drawing');
}

// ---- toggleDimensionMode ----
{
  const h = makeHost();
  h.svc.toggleDimensionMode();
  check('toggleDimensionMode 无子文档：info 守卫、模式不变',
    h.rec.toasts[0].msg === '请先生成工程图视图' && h.rec.toasts[0].kind === 'info' && h.svc.dimMode === false);
  const d = new Drawing(); // 0 视图
  h.svc.setDrawing(d);
  h.svc.toggleDimensionMode();
  check('toggleDimensionMode 无视图：info 守卫', h.svc.dimMode === false && h.rec.toasts.length === 2);
}
{
  const h = makeHost();
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDimensionMode();
  check('toggleDimensionMode 开：dimMode=true + 状态栏 busy + info 提示 + emit',
    h.svc.dimMode === true &&
    h.rec.statuses[0].text === '尺寸标注：点击边线添加标注' && h.rec.statuses[0].kind === 'busy' &&
    h.rec.toasts[0].kind === 'info' && h.rec.toasts[0].msg.includes('Shift+点击另一条边') &&
    h.rec.emits[h.rec.emits.length - 1].join(',') === 'drawing');
  h.svc.toggleDimensionMode();
  check('toggleDimensionMode 关：dimMode=false + 状态栏 ok + 提示',
    h.svc.dimMode === false && h.rec.statuses[1].text === '就绪' && h.rec.statuses[1].kind === 'ok' &&
    h.rec.toasts[1].msg === '已退出尺寸标注模式');
}

// ---- placeDrawingDimension ----
{
  const h = makeHost();
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  // 未开标注模式 → no-op
  h.svc.placeDrawingDimension('v1', 0);
  check('placeDrawingDimension 未开标注模式：no-op',
    h.svc.drawing!.views[0].dims.length === 0 && h.rec.toasts.length === 0 && h.rec.emits.length === 0);
  h.svc.toggleDimensionMode(); // toast[0] = info 开提示；emit[0]
  h.svc.placeDrawingDimension('v1', 0);
  check('placeDrawingDimension 长度标注：1 条标注 + ok 提示（10×2=20.00 mm）+ emit',
    h.svc.drawing!.views[0].dims.length === 1 &&
    h.rec.toasts[1].kind === 'ok' && h.rec.toasts[1].msg === '长度标注：20.00 mm' &&
    h.rec.emits.length === 2, JSON.stringify(h.rec.toasts[1]));
  h.svc.placeDrawingDimension('v1', 1, true);
  check('placeDrawingDimension Shift 同视图 → 距离标注（20.00 mm）',
    h.svc.drawing!.views[0].dims.length === 2 &&
    h.rec.toasts[2].msg === '距离标注：20.00 mm', JSON.stringify(h.rec.toasts[2]));
  h.svc.placeDrawingDimension('v1', 99, true);
  check('placeDrawingDimension 无效边：不提示但记录 lastDimRun',
    h.svc.drawing!.views[0].dims.length === 2 && h.rec.toasts.length === 3 &&
    h.rec.emits.length === 4);
}

// ---- clearDrawingDims：同时清 lastDimRun → Shift 退化为长度 ----
{
  const h = makeHost();
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDimensionMode();
  h.svc.placeDrawingDimension('v1', 0);
  h.svc.clearDrawingDims();
  check('clearDrawingDims：清标注 + info 提示 + emit',
    h.svc.drawing!.views[0].dims.length === 0 &&
    h.rec.toasts[h.rec.toasts.length - 1].msg === '已清除全部标注' &&
    h.rec.toasts[h.rec.toasts.length - 1].kind === 'info');
  h.svc.placeDrawingDimension('v1', 1, true);
  check('clearDrawingDims 后 Shift 退化为长度标注（lastDimRun 已清）',
    h.rec.toasts[h.rec.toasts.length - 1].msg === '长度标注：20.00 mm',
    JSON.stringify(h.rec.toasts[h.rec.toasts.length - 1]));
  h.svc.setDrawing(null);
  h.svc.clearDrawingDims();
  check('clearDrawingDims 无子文档：no-op', h.rec.toasts[h.rec.toasts.length - 1].msg === '长度标注：20.00 mm');
}

// ---- removeDrawingDim ----
{
  const h = makeHost();
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDimensionMode();
  h.svc.placeDrawingDimension('v1', 0);
  h.svc.placeDrawingDimension('v1', 1);
  const dims = h.svc.drawing!.views[0].dims;
  h.svc.removeDrawingDim('v1', dims[0].id);
  check('removeDrawingDim：删指定标注剩 1 条', h.svc.drawing!.views[0].dims.length === 1);
  const emits = h.rec.emits.length;
  h.svc.setDrawing(null);
  h.svc.removeDrawingDim('v1', 'x');
  check('removeDrawingDim 无子文档：no-op（无广播）', h.rec.emits.length === emits);
}

// ---- 自动标注 / 孔位标注 ----
{
  const h = makeHost();
  h.svc.autoDimensionDrawing();
  check('autoDimensionDrawing 无子文档：info 守卫', h.rec.toasts[0].msg === '请先生成工程图视图');
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.autoDimensionDrawing('overall');
  check('autoDimensionDrawing overall：2 条 + ok 提示',
    h.svc.drawing!.views[0].dims.length === 2 && h.rec.toasts[1].msg === '已自动标注 2 处尺寸');
  // all 在新视图上验证（避免与 overall 累积）：总宽高 + 直线边 = 5
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.autoDimensionDrawing('all');
  check('autoDimensionDrawing all：5 条（总宽高 + 直线边）',
    h.svc.drawing!.views[0].dims.length === 5 && h.rec.toasts[2].msg === '已自动标注 5 处尺寸',
    `${h.svc.drawing!.views[0].dims.length} 条`);
}
{
  const h = makeHost();
  h.svc.autoHoleDimensionDrawing();
  check('autoHoleDimensionDrawing 无子文档：info 守卫', h.rec.toasts[0].msg === '请先生成工程图视图');
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.autoHoleDimensionDrawing();
  check('autoHoleDimensionDrawing：孔位 3 条（X/Y 定位 + ⌀ 直径）+ ok 提示',
    h.svc.drawing!.views[0].dims.length === 3 && h.rec.toasts[1].msg === '已标注 3 处孔位尺寸',
    `${h.svc.drawing!.views[0].dims.length} 条`);
}

// ---- applyDrawingDimMeta ----
{
  const h = makeHost();
  check('applyDrawingDimMeta 无子文档：false', h.svc.applyDrawingDimMeta('v1', 'x', {}) === false);
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDimensionMode();
  h.svc.placeDrawingDimension('v1', 0);
  const dimId = h.svc.drawing!.views[0].dims[0].id;
  check('applyDrawingDimMeta 无效 dimId：false 且无新提示',
    h.svc.applyDrawingDimMeta('v1', 'nope', {}) === false && h.rec.toasts.length === 2,
    JSON.stringify(h.rec.toasts));
  check('applyDrawingDimMeta 有效：true + ok 提示 + refresh',
    h.svc.applyDrawingDimMeta('v1', dimId, { prefix: '⌀', tolerance: { upper: 0.1, lower: -0.1 } }) === true &&
    h.rec.toasts[h.rec.toasts.length - 1].msg === '已更新尺寸标注' &&
    h.rec.emits[h.rec.emits.length - 1].join(',') === 'drawing');
  check('applyDrawingDimMeta 元数据落库（prefix + 公差）',
    h.svc.drawing!.views[0].dims[0].prefix === '⌀' &&
    h.svc.drawing!.views[0].dims[0].tolerance?.upper === 0.1);
}

// ---- toggleDrawingBOM ----
{
  const h = makeHost();
  h.svc.toggleDrawingBOM();
  check('toggleDrawingBOM 无子文档：info 守卫', h.rec.toasts[0].msg === '请先生成工程图');
  h.svc.setDrawing(new Drawing()); // 0 视图
  h.svc.toggleDrawingBOM();
  check('toggleDrawingBOM 无视图：info 守卫', h.rec.toasts[1].msg === '请先生成工程图');
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDrawingBOM();
  check('toggleDrawingBOM 无装配/无模型：info「没有可生成明细表的模型」',
    h.rec.toasts[2].msg === '没有可生成明细表的模型' && h.svc.drawing!.bom.length === 0);
}
{
  const h = makeHost({ hasModel: () => true });
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDrawingBOM();
  const bom = h.svc.drawing!.bom;
  check('toggleDrawingBOM 零件兜底：1 行、名含特征数（3）、默认材质',
    bom.length === 1 && bom[0].name === '零件·3 特征' && bom[0].qty === 1 &&
    bom[0].material === '碳钢' && h.rec.toasts[0].msg === '已生成明细表（1 行，数量随装配自动联动）',
    JSON.stringify(bom[0]));
  h.svc.toggleDrawingBOM();
  check('toggleDrawingBOM 再点：清除明细表 + info',
    h.svc.drawing!.bom.length === 0 && h.rec.toasts[1].msg === '已清除明细表' && h.rec.toasts[1].kind === 'info');
}
{
  const asm = {
    components: [{ id: 'c1' }, { id: 'c2' }],
    bomEntries: () => [
      { name: '螺栓', qty: 2 },
      { name: '垫片', qty: 1 },
    ],
  } as unknown as Assembly;
  const h = makeHost({ assembly: () => asm });
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDrawingBOM();
  const bom = h.svc.drawing!.bom;
  check('toggleDrawingBOM 装配来源：2 行 + 数量>1 带 note「共 N 件」',
    bom.length === 2 && bom[0].name === '螺栓' && bom[0].qty === 2 && bom[0].note === '共 2 件' &&
    bom[1].note === undefined && h.rec.toasts[0].msg === '已生成明细表（2 行，数量随装配自动联动）',
    JSON.stringify(bom));
}

// ---- exportDrawingPNG ----
{
  const h = makeHost();
  let err: Error | null = null;
  await h.svc.exportDrawingPNG().catch((e) => { err = e as Error; });
  check('exportDrawingPNG 无工程图：reject(no drawing) + err 提示',
    !!err && err.message === 'no drawing' &&
    h.rec.toasts[0].kind === 'err' && h.rec.toasts[0].msg === '没有工程图' &&
    h.rec.raster.length === 0 && h.rec.downloads.length === 0);
}
{
  const h = makeHost();
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  await h.svc.exportDrawingPNG(2);
  const r = h.rec.raster[0];
  check('exportDrawingPNG：宿主收到 SVG + 图纸尺寸(420×297) + scale',
    h.rec.raster.length === 1 && r.svg.startsWith('<svg') && r.svg.endsWith('</svg>') &&
    r.w === 420 && r.h === 297 && r.scale === 2, `w=${r?.w} h=${r?.h} scale=${r?.scale}`);
  const dl = h.rec.downloads[0];
  check('exportDrawingPNG：download(ArrayBuffer, drawing.png, image/png) + ok 提示',
    !!dl && dl.content instanceof ArrayBuffer && dl.filename === 'drawing.png' && dl.mime === 'image/png' &&
    h.rec.toasts[0].kind === 'ok' && h.rec.toasts[0].msg === 'PNG 已导出');
}

// ---- exportDrawingPNG：光栅化失败 → reject 传播、无 download、无提示 ----
{
  const h = makeHost({ rasterizePNG: async () => { throw new Error('raster fail'); } });
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  let err: Error | null = null;
  await h.svc.exportDrawingPNG().catch((e) => { err = e as Error; });
  check('exportDrawingPNG：rasterizePNG reject → 异常传播、无 download、无提示',
    !!err && err.message === 'raster fail' &&
    h.rec.downloads.length === 0 && h.rec.toasts.length === 0, err?.message ?? 'null');
}

// ---- setDrawing 换文档：清 lastDimRun（Shift 退化为长度标注）----
{
  const h = makeHost();
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDimensionMode();
  h.svc.placeDrawingDimension('v1', 0); // 记 lastDimRun = 'v1:0'
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] })); // 换到另一文档（同样有 v1）
  h.svc.placeDrawingDimension('v1', 0, true); // lastDimRun 已清 → 退化为长度标注
  check('setDrawing 清 lastDimRun：跨文档 Shift 点击退化为长度标注（不拿旧文档的边算距离）',
    h.svc.drawing!.views[0].dims.length === 1 &&
    h.rec.toasts.some((t) => t.msg.startsWith('长度标注')) &&
    !h.rec.toasts.some((t) => t.msg.startsWith('距离标注')),
    JSON.stringify(h.rec.toasts.filter((t) => t.msg.includes('标注'))));
}

// ---- generateDrawing：drawingScale()=0 时不写 fixedScale ----
{
  const h = makeHost({ hasModel: () => true, currentModel: () => modelWith(emptyMesh()) });
  h.svc.generateDrawing(['front']);
  check('generateDrawing：drawingScale()=0 → fixedScale 保持 0（不覆盖）',
    h.svc.drawing!.fixedScale === 0, `fixedScale=${h.svc.drawing!.fixedScale}`);
  h.setScale(2);
  h.svc.generateDrawing(['front']);
  check('generateDrawing：drawingScale()=2 → 覆盖 fixedScale',
    h.svc.drawing!.fixedScale === 2, `fixedScale=${h.svc.drawing!.fixedScale}`);
}

// ---- toggleDrawingBOM：装配存在但 components 为空 → 零件兜底 ----
{
  const asm = { components: [], bomEntries: () => [] } as unknown as Assembly;
  const h = makeHost({ hasModel: () => true, assembly: () => asm });
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.toggleDrawingBOM();
  const bom = h.svc.drawing!.bom;
  check('toggleDrawingBOM：装配 components 为空 → 落零件兜底（1 行）',
    bom.length === 1 && bom[0].name === '零件·3 特征', JSON.stringify(bom));
}

// ---- exitDimensionMode ----
{
  const h = makeHost();
  h.svc.setDrawing(Object.assign(new Drawing(), { views: [mkView()] }));
  h.svc.exitDimensionMode();
  check('exitDimensionMode 未开启：空操作', h.svc.dimMode === false);
  h.svc.toggleDimensionMode();
  h.svc.placeDrawingDimension('v1', 0);
  h.svc.exitDimensionMode();
  check('exitDimensionMode：关 dimMode + 清 lastDimRun（Shift 退化长度标注）',
    h.svc.dimMode === false);
  h.svc.toggleDimensionMode(); // 再开
  h.svc.placeDrawingDimension('v1', 1, true);
  check('exitDimensionMode 后 Shift 退化为长度标注（lastDimRun 已清）',
    h.rec.toasts[h.rec.toasts.length - 1].msg === '长度标注：20.00 mm',
    JSON.stringify(h.rec.toasts[h.rec.toasts.length - 1]));
}

console.log(`\n工程图服务：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail > 0) process.exit(1);
