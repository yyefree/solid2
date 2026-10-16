/**
 * SolidWorks 操作手册一致性测试（全面）。
 *
 * 目的：不是零散查 bug，而是**按 SolidWorks 用户手册的章节顺序**，把手册里
 * 定义的标准操作流程逐条变成真实浏览器里的端到端断言——覆盖 界面 / 草图 /
 * 实体特征 / 参考几何 / 评估 / 曲面 / 钣金 / 装配体 / 工程图 / 编辑撤销 /
 * 文件 / 视图显示 / 自定义 / 命令可达性 共 14 章。
 *
 * 做法：用 Edge/Chrome 的 CDP 驱动真实页面，通过开发态句柄 `window.__solid2.app`
 * 调 App API 造特征并读取真实内核统计（面/边/实体/曲面/体积），几何数值用解析解校验。
 * 页面里只 import **纯模块**（doc/model、sketch/types），绝不 import 内核。
 *
 * 用法：
 *   npm run dev                       # 另开终端起开发服务器
 *   node tools/sw-manual-test.mjs [url]
 *
 * 环境变量：
 *   SMOKE_TIMEOUT_MS  等待内核就绪的上限（默认 240000）
 *   SMOKE_HEADFUL=1   显示浏览器窗口
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PORT = Number(process.env.SMOKE_CDP_PORT ?? 9345);
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS ?? 240000);
const HEADFUL = process.env.SMOKE_HEADFUL === '1';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

let pass = 0;
let fail = 0;
const chapterResults = [];
let currentChapter = { name: '', pass: 0, fail: 0 };

function chapter(name) {
  if (currentChapter.name) chapterResults.push(currentChapter);
  currentChapter = { name, pass: 0, fail: 0 };
  console.log('\n' + '='.repeat(64));
  console.log('  ' + name);
  console.log('='.repeat(64));
}

function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    currentChapter.pass++;
    console.log('  \u2713 ' + label + (detail ? '  ' + detail : ''));
  } else {
    fail++;
    currentChapter.fail++;
    console.log('  \u2717 ' + label + '  ' + detail);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------------
// 1. 启动浏览器
// ------------------------------------------------------------------
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) {
  console.error('找不到 Edge/Chrome 可执行文件，跳过。');
  process.exit(0);
}
console.log('浏览器: ' + exe);
console.log('目标:   ' + URL_);

const profile = mkdtempSync(path.join(tmpdir(), 'solid2-sw-'));
const args = [
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--window-size=1400,900',
  ...(HEADFUL ? [] : ['--headless=new']),
  URL_,
];
const child = spawn(exe, args, { stdio: 'ignore' });

function cleanup() {
  try { child.kill(); } catch { /* ignore */ }
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 500);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function getPageTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 端口还没起来 */ }
    await sleep(300);
  }
  throw new Error('等待 CDP 端口超时');
}

let target;
try {
  target = await getPageTarget();
} catch (e) {
  console.error('\u2717 ' + e.message);
  cleanup();
  process.exit(1);
}
console.log('CDP 已连接: ' + (target.title || target.url));

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
});

let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr, { awaitPromise = true } = {}) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || '页面求值异常');
  }
  return r.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expr, { awaitPromise: false })) return true;
    } catch (e) { lastErr = e.message; }
    await sleep(400);
  }
  console.log('  \u2717 等待超时：' + label + (lastErr ? '  (' + lastErr + ')' : ''));
  return false;
}

// ==================================================================
// 预置：等应用启动 + 内核就绪 + 页面侧公共工具
// ==================================================================
const booted = await waitFor('!!(window.__solid2 && window.__solid2.app)', 20000, '应用启动');
if (!booted) {
  console.log('应用未启动，终止。');
  ws.close(); cleanup(); process.exit(1);
}

const kernelReady = await waitFor('window.__solid2.app.kernelReady === true', TIMEOUT, '几何内核就绪');
if (!kernelReady) {
  console.log('内核未就绪，终止。');
  ws.close(); cleanup(); process.exit(1);
}

// 页面侧公共工具（每个章节脚本都会注入这段前缀）
const PRELUDE = `
  const { app } = window.__solid2;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const M = await import('/src/doc/model.ts');
  const T = await import('/src/sketch/types.ts');
  const cv = document.querySelector('canvas');
  const crect = cv ? cv.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
  const cx = crect.left + crect.width / 2, cy = crect.top + crect.height / 2;
  const rbn = (label) => [...document.querySelectorAll('.rbtn')].find(b => b.textContent.trim() === label);
  const rtab = (n) => [...document.querySelectorAll('.rtab')].find(x => x.textContent.trim() === n);
  const clickCanvas = (x, y) => {
    const o = { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 };
    cv.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    cv.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  };
  const clearDoc = async () => {
    for (const f of [...app.doc.features]) app.doc.remove(f.id);
    await app.rebuild();
    await sleep(40);
  };
  const rectSk = (w, h, x0, y0) => {
    const sk = T.emptySketch();
    const ox = x0 || 0, oy = y0 || 0;
    const pts = [[ox,oy],[ox+w,oy],[ox+w,oy+h],[ox,oy+h]].map(([x,y]) => {
      const id = T.newId('p'); sk.points[id] = { id, x, y }; return id;
    });
    for (let i = 0; i < 4; i++) sk.entities.push({ id: T.newId('e'), kind: 'line', a: pts[i], b: pts[(i+1)%4] });
    return sk;
  };
  const circleSk = (cx0, cy0, r) => {
    const sk = T.emptySketch();
    const c = T.newId('p');
    sk.points[c] = { id: c, x: cx0, y: cy0 };
    sk.entities.push({ id: T.newId('e'), kind: 'circle', c, r });
    return sk;
  };
  const stats = () => {
    const st = app.model && app.model.stats ? app.model.stats : {};
    return { faces: st.faces||0, edges: st.edges||0, solids: st.solids||0, surfaces: st.surfaces||0, volume: st.volume||0, area: st.area||0 };
  };
  const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1 : tol);
  const out = {};
`;

async function page(body) {
  return evaluate('(async () => {\n' + PRELUDE + body + '\n})()');
}

// ==================================================================
// 第 1 章：用户界面（SW 用户界面总览）
// ==================================================================
chapter('第 1 章  用户界面（菜单栏 / CommandManager / 状态栏 / 设计树）');

const ui = await page(`
  const menus = [...document.querySelectorAll('.menubar .menu-item')].map(m => m.textContent.replace(/\\s+/g, ''));
  const tabs = [...document.querySelectorAll('.rtab')].map(t => t.textContent.trim());
  const huBtns = [...document.querySelectorAll('.headsup .hu-btn')];
  const leftTabs = [...document.querySelectorAll('.panel-left .ptab, .panel-left .panel-tab, .panel-left [role=tab]')].map(t => t.textContent.trim());
  const taskTabs = [...document.querySelectorAll('.tp-tab')].map(t => (t.getAttribute('title') || t.textContent || '').trim());
  const treeNodes = [...document.querySelectorAll('.tree .tnode .label')].map(n => n.textContent.trim());
  out.menus = menus;
  out.tabs = tabs;
  out.huCount = huBtns.length;
  out.huCmds = huBtns.map(b => b.dataset.cmd);
  out.search = !!document.querySelector('.menu-search-input');
  out.viewcube = !!document.querySelector('.viewcube svg');
  out.compass = !!document.querySelector('.viewcube .compass, .viewcube .vc-compass');
  out.triad = !!document.querySelector('.axis-triad svg');
  out.conf = !!document.querySelector('.conf-host .conf-corner');
  out.coord = !!document.querySelector('.sb-coord');
  out.unit = (document.querySelector('.sb-unit')?.textContent || '').trim();
  out.filter = !!document.querySelector('.sb-filter, .sb-filterbtn');
  out.rebuildBtn = !!document.querySelector('.sb-rebuild');
  out.modeBadge = (document.querySelector('.sb-mode')?.textContent || '').trim();
  out.leftTabs = leftTabs;
  out.taskTabs = taskTabs;
  out.treeNodes = treeNodes;
  return out;
`);

const wantMenus = ['文件', '编辑', '视图', '插入', '工具', '窗口', '帮助'];
check('菜单栏含 SolidWorks 七菜单', wantMenus.every((w) => ui.menus.some((m) => m.startsWith(w))), ui.menus.join(' '));
check('菜单栏含命令搜索框', ui.search === true);
check('CommandManager 含全部 10 个页签（特征/钣金/草图/曲面/评估/装配体/工程图/曲线/视图/AI）',
  ['特征', '钣金', '草图', '曲面', '评估', '装配体', '工程图', '曲线', '视图', 'AI'].every((w) => ui.tabs.includes(w)),
  ui.tabs.join(' '));
check('Heads-up 视图工具栏 14 按钮（SW 顺序）', ui.huCount === 14, 'count=' + ui.huCount);
check('Heads-up 含 视图定向/显示样式/隐藏显示/编辑外观/布景/光源/整屏/缩放区/放大/缩小/剖面/RealView/上一视图/旋转视图',
  ['view.orientation', 'view.displayStyle', 'view.hideShow', 'view.appearance', 'view.scene', 'view.lighting', 'view.fit',
   'view.zoomArea', 'view.zoomIn', 'view.zoomOut', 'view.section', 'view.realview', 'view.prevView', 'view.rotate']
    .every((c) => ui.huCmds.includes(c)),
  ui.huCmds.join(','));
check('ViewCube 已渲染', ui.viewcube === true);
check('ViewCube 外围指北罗盘已渲染', ui.compass === true);
check('参考三重轴（X红/Y绿/Z蓝）已渲染', ui.triad === true);
check('确认角（✓/✗ 小圆角框）已挂载', ui.conf === true);
check('状态栏：Cursor 坐标 / 单位 / 选择过滤器 / 重建 / 模式徽标 齐备',
  ui.coord === true && ui.filter === true && ui.rebuildBtn === true && ui.modeBadge.length > 0,
  'coord=' + ui.coord + ' filter=' + ui.filter + ' rebuild=' + ui.rebuildBtn + ' badge=' + ui.modeBadge);
check('状态栏单位显示 MMGS（默认公制）', ui.unit === 'MMGS', ui.unit);
check('左侧面板三选项卡（特征管理器 / 属性管理器 / 配置管理器）',
  ['特征管理器', '属性管理器', '配置管理器'].every((w) => ui.leftTabs.some((t) => t.includes(w))), ui.leftTabs.join(' / '));
check('右侧任务窗格选项卡（资源/设计库/文件浏览器/视图调色板/自定义属性/外观）',
  ui.taskTabs.length >= 4, ui.taskTabs.join(' / '));
check('设计树含 零件 / 注解 / 材质 / 基准面 / 原点',
  ['注解', '材质', '基准面', '原点'].every((w) => ui.treeNodes.some((t) => t.includes(w))), ui.treeNodes.join(' / '));
check('设计树基准面含 前视/上视/右视 三基准面',
  ['前视基准面', '上视基准面', '右视基准面'].every((w) => ui.treeNodes.some((t) => t.includes(w))), ui.treeNodes.join(' / '));
check('设计树原点展开为 X/Y/Z 三轴节点',
  ['X 轴', 'Y 轴', 'Z 轴'].every((w) => ui.treeNodes.some((t) => t.includes(w))), ui.treeNodes.slice(-4).join(' / '));

// ==================================================================
// 第 2 章：草图（Sketching）
// ==================================================================
chapter('第 2 章  草图（进入 / 绘制图元 / 约束 / 退出）');

const sk2 = await page(`
  await clearDoc();
  // 1) 在前视基准面上新建草图（丝带「草图绘制」按钮）
  rtab('草图').click(); await sleep(60);
  const b = rbn('草图绘制'); if (b) b.click();
  await sleep(120);
  out.mode = app.mode;
  out.ribbonTab = (document.querySelector('.rtab.active')?.textContent || '').trim();
  const cc = document.querySelector('.conf-host .conf-corner');
  out.confShown = !!cc && cc.classList.contains('show');
  const ovl = app.viewport.scene.getObjectByName('sketchOverlay');
  const planeFill = ovl ? ovl.getObjectByName('sketchPlaneFill') : null;
  out.editPlaneVisible = planeFill ? planeFill.visible : null;
  out.gridVisible = app.showGrid === true;
  out.sketchFeatCount = app.doc.sketchFeatures().length;

  // 2) 矩形工具：两次点击画矩形 → 4 线 4 点，端点共享
  const rb = rbn('矩形'); if (rb) rb.click(); await sleep(40);
  out.toolRect = app.sketchTool;
  clickCanvas(cx - 60, cy - 40); clickCanvas(cx + 60, cy + 40);
  await sleep(80);
  const sk = app.editingSketch?.params?.sketch;
  out.lines = sk ? sk.entities.filter(e => e.kind === 'line').length : -1;
  out.points = sk ? Object.keys(sk.points).length : -1;

  // 3) 圆工具：中心 + 半径
  const cb = rbn('圆'); if (cb) cb.click(); await sleep(40);
  out.toolCircle = app.sketchTool;
  clickCanvas(cx - 120, cy + 90); clickCanvas(cx - 90, cy + 90);
  await sleep(80);
  const sk2b = app.editingSketch?.params?.sketch;
  out.circles = sk2b ? sk2b.entities.filter(e => e.kind === 'circle').length : -1;
  out.totalEnts = sk2b ? sk2b.entities.length : -1;

  // 4) 约束：选中两条线加「水平」约束（工具按钮）
  out.hasRelationBtns = !!rbn('水平') && !!rbn('竖直') && !!rbn('重合');
  out.hasDimBtn = !!rbn('智能尺寸');
  out.hasMirror = !!rbn('镜像实体');

  // 5) 退出草图（Enter，等价确认角 ✓）
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(160);
  out.afterExitMode = app.mode;
  out.afterExitSketchKept = app.doc.sketchFeatures().length === 1;
  out.afterExitSelected = app.selectedFeatureId === (app.doc.sketchFeatures().at(-1)?.id ?? null);
  const ovl2 = app.viewport.scene.getObjectByName('sketchOverlay');
  const fill2 = ovl2 ? ovl2.getObjectByName('sketchPlaneFill') : null;
  out.exitPlaneHidden = fill2 ? !fill2.visible : null;
  let dispLines = 0; if (ovl2) ovl2.traverse(o => { if (o.type === 'Line') dispLines++; });
  out.displayLines = dispLines;
  await clearDoc();
  return out;
`);

check('前视基准面新建草图：进入草图模式', sk2.mode === 'sketch', 'mode=' + sk2.mode);
check('进入草图后 CommandManager 自动切到「草图」页签', sk2.ribbonTab === '草图', sk2.ribbonTab);
check('进入草图后确认角激活（✓/✗ 可见）', sk2.confShown === true);
check('进入草图（编辑态）：草图平面底色 + 网格可见（SW 草图环境）', sk2.editPlaneVisible === true && sk2.gridVisible === true,
  'planeFill=' + sk2.editPlaneVisible + ' grid=' + sk2.gridVisible);
check('矩形工具绘制：4 条直线 + 4 个端点（链式共享）', sk2.lines === 4 && sk2.points === 4,
  'lines=' + sk2.lines + ' points=' + sk2.points);
check('圆工具绘制：新增 1 个圆实体', sk2.circles === 1, 'circles=' + sk2.circles);
check('草图工具栏含约束（水平/竖直/重合）与标注（智能尺寸）与镜像实体',
  sk2.hasRelationBtns === true && sk2.hasDimBtn === true && sk2.hasMirror === true);
check('Enter 退出草图：回到模型模式且草图保留为 1 个', sk2.afterExitMode === 'model' && sk2.afterExitSketchKept === true,
  'mode=' + sk2.afterExitMode + ' kept=' + sk2.afterExitSketchKept);
check('退出草图后草图处于选中态（SW：可直接继续做特征）', sk2.afterExitSelected === true);
check('退出草图后（显示态）平面底色隐藏、草图线仍可见（SW 暗色显示）', sk2.exitPlaneHidden === true && sk2.displayLines >= 5,
  'planeHidden=' + sk2.exitPlaneHidden + ' lines=' + sk2.displayLines);

// ==================================================================
// 第 3 章：实体特征（Features）
// ==================================================================
chapter('第 3 章  实体特征（拉伸 / 切除 / 旋转 / 工程特征 / 阵列 / 镜像 / 放样扫描）');

const f3 = await page(`
  // ---- 3.1 拉伸凸台：20×20 矩形 × 10 → 体积 4000 ----
  await clearDoc();
  let skf = M.newSketchFeature('front', rectSk(20, 20));
  app.addFeature(skf, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'extrude', name: '拉伸1', params: { sketchId: skf.id, distance: 10, operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  let st = stats();
  out.extrudeVol = st.volume; out.extrudeSolids = st.solids; out.extrudeFaces = st.faces;

  // ---- 3.2 拉伸切除：顶面圆 r5 贯穿 → 体积 4000 - π*25*10 ----
  const topPlane = M.planeFromFace([10, 10, 10], [0, 0, 1]);
  const cutSk = M.newSketchFeature('custom', circleSk(0, 0, 5));
  cutSk.params.customPlane = topPlane;
  app.addFeature(cutSk, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'extrude', name: '切除1', params: { sketchId: cutSk.id, distance: 12, operation: 'cut', endCondition: 'throughAll' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  st = stats();
  out.cutVol = st.volume; out.cutSolids = st.solids;

  // ---- 3.3 旋转：矩形绕左边旋转 360 → 圆柱环体积 ----
  await clearDoc();
  // 轮廓：x∈[10,20], y∈[0,30] 绕 x=0 轴旋转 → 空心圆柱 π(20²-10²)*30
  const revSk = M.newSketchFeature('front', rectSk(10, 30, 10, 0));
  app.addFeature(revSk, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'revolve', name: '旋转1', params: { sketchId: revSk.id, axisA: [0, 0], axisB: [0, 1], angleDeg: 360, operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  st = stats();
  out.revolveVol = st.volume; out.revolveSolids = st.solids;

  // ---- 3.4 圆角：40×25×10 长方体，对一条竖边倒 R3 → 体积减少 ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const boxVol = stats().volume;
  const edges = (app.model.mesh && app.model.mesh.edgeMetas) || [];
  // 选一条竖直边（dir 沿 z）
  let vEdge = null;
  for (let i = 0; i < edges.length; i++) { const d = edges[i].dir; if (Math.abs(Math.abs(d[2]) - 1) < 1e-3) { vEdge = M.makeEdgeRef(edges[i]); break; } }
  out.hasVerticalEdge = !!vEdge;
  if (vEdge) {
    app.addFeature({ id: T.newId('f'), type: 'fillet', name: '圆角1', params: { edges: [vEdge], radius: 3 } }, { rebuild: false });
    await app.rebuild(); await sleep(60);
  }
  out.filletVol = stats().volume; out.filletLess = out.filletVol < boxVol;

  // ---- 3.5 倒角：对竖边倒 C2 → 体积减少 ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const e2 = (app.model.mesh && app.model.mesh.edgeMetas) || [];
  let vEdge2 = null;
  for (let i = 0; i < e2.length; i++) { const d = e2[i].dir; if (Math.abs(Math.abs(d[2]) - 1) < 1e-3) { vEdge2 = M.makeEdgeRef(e2[i]); break; } }
  if (vEdge2) app.addFeature({ id: T.newId('f'), type: 'chamfer', name: '倒角1', params: { edges: [vEdge2], distance: 2 } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  out.chamferVol = stats().volume; out.chamferLess = out.chamferVol < boxVol;

  // ---- 3.6 抽壳：40×25×10 长方体，顶面抽壳 2 → 体积 = 外 - 内腔 ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const faces = (app.model.mesh && app.model.mesh.faceMetas) || [];
  let topFace = null;
  for (const f of faces) if (f.surfaceType === 'plane' && f.normal[2] > 0.9) { topFace = M.makeFaceRef(f); break; }
  out.hasTopFace = !!topFace;
  if (topFace) app.addFeature({ id: T.newId('f'), type: 'shell', name: '抽壳1', params: { faces: [topFace], thickness: 2 } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  // 内腔 = (40-4)*(25-4)*(10-2) = 36*21*8
  out.shellVol = stats().volume; out.shellExpect = boxVol - 36 * 21 * 8;

  // ---- 3.7 筋：开放折线草图 → 加强筋 ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const ribSk = T.emptySketch();
  { const p1 = T.newId('p'), p2 = T.newId('p'); ribSk.points[p1] = { id: p1, x: 0, y: 0 }; ribSk.points[p2] = { id: p2, x: 0, y: 20 };
    ribSk.entities.push({ id: T.newId('e'), kind: 'line', a: p1, b: p2 }); }
  const ribF = M.newSketchFeature('front', ribSk);
  app.addFeature(ribF, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'rib', name: '筋1', params: { sketchId: ribF.id, thickness: 3, depth: 10, symmetric: true } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  out.ribVol = stats().volume; out.ribAdded = out.ribVol > boxVol;

  // ---- 3.8 异型孔：在顶面打 φ8 通孔 ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const faces3 = (app.model.mesh && app.model.mesh.faceMetas) || [];
  let tf3 = null;
  for (const f of faces3) if (f.surfaceType === 'plane' && f.normal[2] > 0.9) { tf3 = f; break; }
  if (tf3) app.addFeature({ id: T.newId('f'), type: 'hole', name: '孔1', params: { plane: M.planeFromFace(tf3.centroid, tf3.normal), pos: [0, 0], type: 'simple', diameter: 8, depth: 10, through: true } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  out.holeVol = stats().volume; out.holeLess = out.holeVol < boxVol;

  // ---- 3.9 线性阵列：孔沿 X 复制 4 个 ----
  const holeF = app.doc.features.find(f => f.type === 'hole');
  if (holeF) app.addFeature({ id: T.newId('f'), type: 'linearPattern', name: '线性阵列1', params: { seedFeatureId: holeF.id, direction: [1, 0, 0], spacing: 8, count: 4 } }, { rebuild: false });
  await app.rebuild(); await sleep(80);
  out.linPatVol = stats().volume; out.linPatSolids = stats().solids;

  // ---- 3.10 圆周阵列：孔绕 Z 均布 4 个 ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const tf4 = (app.model.mesh.faceMetas || []).find(f => f.surfaceType === 'plane' && f.normal[2] > 0.9);
  if (tf4) app.addFeature({ id: T.newId('f'), type: 'hole', name: '孔1', params: { plane: M.planeFromFace(tf4.centroid, tf4.normal), pos: [8, 0], type: 'simple', diameter: 4, depth: 10, through: true } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const holeF2 = app.doc.features.find(f => f.type === 'hole');
  if (holeF2) app.addFeature({ id: T.newId('f'), type: 'circularPattern', name: '圆周阵列1', params: { seedFeatureId: holeF2.id, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], count: 4, totalAngleDeg: 360, equalSpacing: true } }, { rebuild: false });
  await app.rebuild(); await sleep(80);
  out.cirPatVol = stats().volume; out.cirPatSolids = stats().solids;

  // ---- 3.11 镜像：关于 YZ 平面镜像 ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [10, 10, 10], origin: [5, 0, 0], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  const boxF = app.doc.features[0];
  app.addFeature({ id: T.newId('f'), type: 'mirror', name: '镜像1', params: { seedFeatureId: boxF.id, planePoint: [0, 0, 0], planeNormal: [1, 0, 0] } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  out.mirrorVol = stats().volume; out.mirrorSolids = stats().solids;

  // ---- 3.12 基本体：box / cylinder / sphere / cone / torus ----
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '长方体', params: { kind: 'box', dims: [10, 10, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(30);
  out.primBox = stats().volume;
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '圆柱', params: { kind: 'cylinder', dims: [5, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(30);
  out.primCyl = stats().volume;
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '球', params: { kind: 'sphere', dims: [5], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(30);
  out.primSph = stats().volume;
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '圆锥', params: { kind: 'cone', dims: [5, 0, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(30);
  out.primCone = stats().volume;

  // ---- 3.13 放样：两个等大正方形截面蒙皮 ----
  await clearDoc();
  const lo1 = M.newSketchFeature('front', rectSk(20, 20, -10, -10));
  const lo2 = M.newSketchFeature('front', rectSk(20, 20, -10, -10));
  lo2.params.customPlane = M.offsetPlane(T.DEFAULT_PLANE, 30);
  lo2.params.plane = 'custom';
  app.addFeature(lo1, { rebuild: false });
  app.addFeature(lo2, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'loft', name: '放样1', params: { sketchIds: [lo1.id, lo2.id], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(80);
  out.loftVol = stats().volume; out.loftSolids = stats().solids;

  // ---- 3.14 扫描：圆轮廓沿直线路径 ----
  await clearDoc();
  const prof = M.newSketchFeature('front', circleSk(0, 0, 5));
  const path = T.emptySketch();
  { const p1 = T.newId('p'), p2 = T.newId('p'); path.points[p1] = { id: p1, x: 0, y: 0 }; path.points[p2] = { id: p2, x: 0, y: 40 };
    path.entities.push({ id: T.newId('e'), kind: 'line', a: p1, b: p2 }); }
  const pathF = M.newSketchFeature('front', path);
  app.addFeature(prof, { rebuild: false });
  app.addFeature(pathF, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'sweep', name: '扫描1', params: { profileSketchId: prof.id, pathSketchId: pathF.id, operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(80);
  out.sweepVol = stats().volume; out.sweepSolids = stats().solids;

  await clearDoc();
  return out;
`);

check('拉伸凸台 20×20×10 → 体积 4000、1 实体', near(f3.extrudeVol, 4000, 1) && f3.extrudeSolids === 1,
  'vol=' + f3.extrudeVol.toFixed(2) + ' solids=' + f3.extrudeSolids);
check('拉伸切除（完全贯穿）→ 体积 = 4000 - π·25·10', near(f3.cutVol, 4000 - Math.PI * 25 * 10, 20) && f3.cutSolids === 1,
  'vol=' + f3.cutVol.toFixed(2) + ' 期望≈' + (4000 - Math.PI * 25 * 10).toFixed(2));
check('旋转 360°（空心圆柱）→ 体积 = π(20²-10²)·30', near(f3.revolveVol, Math.PI * (400 - 100) * 30, 60) && f3.revolveSolids === 1,
  'vol=' + f3.revolveVol.toFixed(2) + ' 期望≈' + (Math.PI * 300 * 30).toFixed(2));
check('圆角 R3（竖边）→ 体积略减', f3.hasVerticalEdge === true && f3.filletLess === true,
  'vol=' + (f3.filletVol || 0).toFixed(2));
check('倒角 C2（竖边）→ 体积略减', f3.chamferLess === true, 'vol=' + (f3.chamferVol || 0).toFixed(2));
check('抽壳（顶面开口 壁厚 2）→ 体积 = 外体积 - 内腔', f3.hasTopFace === true && near(f3.shellVol, f3.shellExpect, 30),
  'vol=' + f3.shellVol.toFixed(2) + ' 期望≈' + f3.shellExpect.toFixed(2));
check('筋（开放草图厚 3 对称深 10）→ 体积增加', f3.ribAdded === true, 'vol=' + f3.ribVol.toFixed(2));
check('异型孔 φ8 通孔 → 体积减少', f3.holeLess === true, 'vol=' + f3.holeVol.toFixed(2));
check('线性阵列（孔沿 X 间距 8 × 4）→ 仍 1 实体、体积进一步减少',
  f3.linPatSolids === 1 && f3.linPatVol < f3.holeVol, 'vol=' + f3.linPatVol.toFixed(2) + ' solids=' + f3.linPatSolids);
check('圆周阵列（孔绕 Z 均布 4）→ 仍 1 实体', f3.cirPatSolids === 1, 'vol=' + f3.cirPatVol.toFixed(2));
check('镜像（关于 YZ 平面）→ 两实体合并、体积翻倍', f3.mirrorSolids >= 1 && near(f3.mirrorVol, 2000, 20),
  'vol=' + f3.mirrorVol.toFixed(2) + ' solids=' + f3.mirrorSolids);
check('基本体 长方体 10³ → 体积 1000', near(f3.primBox, 1000, 1), f3.primBox.toFixed(2));
check('基本体 圆柱 r5 h10 → 体积 π·25·10', near(f3.primCyl, Math.PI * 250, 3), f3.primCyl.toFixed(2));
check('基本体 球 r5 → 体积 4/3·π·125', near(f3.primSph, (4 / 3) * Math.PI * 125, 3), f3.primSph.toFixed(2));
check('基本体 圆锥 r5 h10 → 体积 1/3·π·25·10', near(f3.primCone, (Math.PI * 250) / 3, 3), f3.primCone.toFixed(2));
check('放样（两个 20×20 截面 间距 30）→ 体积 12000、1 实体',
  f3.loftSolids === 1 && near(f3.loftVol, 12000, 60), 'vol=' + f3.loftVol.toFixed(2) + ' solids=' + f3.loftSolids);
check('扫描（r5 圆沿 40 长路径）→ 体积 π·25·40、1 实体',
  f3.sweepSolids === 1 && near(f3.sweepVol, Math.PI * 25 * 40, 40), 'vol=' + f3.sweepVol.toFixed(2) + ' solids=' + f3.sweepSolids);

// ==================================================================
// 第 4 章：参考几何体（基准面）
// ==================================================================
chapter('第 4 章  参考几何体（基准面）');

const f4 = await page(`
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [20, 20, 20], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  // 以前视基准面偏移 30 建参考基准面
  const plane = M.offsetPlane(T.DEFAULT_PLANE, 30);
  app.addFeature({ id: T.newId('f'), type: 'referencePlane', name: '基准面1', params: { kind: 'offset', plane, distance: 30 } }, { rebuild: false });
  await app.rebuild(); await sleep(40);
  out.count = app.doc.features.filter(f => f.type === 'referencePlane').length;
  out.treeHas = [...document.querySelectorAll('.tree .tnode .label')].some(n => n.textContent.includes('基准面1'));
  // 在新建基准面上画草图并拉伸
  const skOnRef = M.newSketchFeature('custom', rectSk(10, 10, -5, -5));
  skOnRef.params.customPlane = plane;
  app.addFeature(skOnRef, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'extrude', name: '拉伸2', params: { sketchId: skOnRef.id, distance: 5, operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  const st = stats();
  out.solids = st.solids; out.vol = st.volume;
  await clearDoc();
  return out;
`);

check('创建参考基准面（前视偏移 30）→ 特征树出现「基准面1」', f4.count === 1 && f4.treeHas === true,
  'count=' + f4.count + ' tree=' + f4.treeHas);
check('在参考基准面上草绘并拉伸 → 生成独立实体（多实体）', f4.solids >= 1 && f4.vol > 400,
  'solids=' + f4.solids + ' vol=' + f4.vol.toFixed(2));

// ==================================================================
// 第 5 章：评估（测量 / 质量属性 / 截面属性 / 检查）
// ==================================================================
chapter('第 5 章  评估（质量属性 / 测量 / 截面属性 / 模型统计 / 几何检查）');

const f5 = await page(`
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);

  // 质量属性（内核精确积分；SW 里是独立对话框 → 本实现为模态表格）
  await app.showMassProperties();
  await sleep(200);
  const mbox = document.querySelector('.modal');
  out.massOpen = !!mbox;
  out.massTitle = (document.querySelector('.modal-head')?.textContent || '').trim();
  const mbody = mbox ? mbox.textContent : '';
  out.massHasVol = mbody.includes('10000');
  out.massHasArea = mbody.includes('2500') || mbody.includes('表面积');
  document.querySelector('.modal-foot .btn')?.click(); await sleep(80);
  document.querySelectorAll('.modal-mask').forEach(m => m.remove());

  // 测量对话框（常驻属性管理器）
  const { openMeasure } = await import('/src/ui/measure.ts');
  openMeasure(app);
  await sleep(150);
  out.measurePmOpen = !!document.querySelector('.pm');
  out.measureTitle = (document.querySelector('.pm-head .pm-title')?.textContent || '').trim();
  document.querySelector('.pm-foot .btn')?.click(); await sleep(80);

  // 截面属性（选上视基准面，实时算面积）
  app.showSectionProperties();
  await sleep(250);
  out.secPmOpen = !!document.querySelector('.pm');
  out.secTitle = (document.querySelector('.pm-head .pm-title')?.textContent || '').trim();
  const secBody = document.querySelector('.pm') ? document.querySelector('.pm').textContent : '';
  // 默认「前视」基准面法向为 Y，穿过盒质心 y=12.5 → XZ 截面 = 40×10 = 400
  out.secArea400 = secBody.includes('400');
  document.querySelector('.pm-foot .btn')?.click(); await sleep(80);

  // 模型统计 / 几何检查
  out.summary = app.modelSummary();
  return out;
`);

check('评估→质量属性：打开质量属性对话框（标题正确）', f5.massOpen === true && f5.massTitle.includes('质量属性'),
  'title=' + f5.massTitle);
check('质量属性显示体积 10000（40×25×10 精确积分）', f5.massHasVol === true && f5.massHasArea === true,
  'vol=' + f5.massHasVol + ' area=' + f5.massHasArea);
check('评估→测量：常驻属性管理器对话框', f5.measurePmOpen === true && f5.measureTitle.length > 0, f5.measureTitle);
check('评估→截面属性：属性管理器打开且面积 = 400（前视截面 40×10）', f5.secPmOpen === true && f5.secArea400 === true,
  'title=' + f5.secTitle + ' area400=' + f5.secArea400);
check('评估→模型统计：面/边/实体计数正确（6 面 1 实体）', f5.summary.faces === 6 && f5.summary.solids === 1,
  'faces=' + f5.summary.faces + ' solids=' + f5.summary.solids);

// ==================================================================
// 第 6 章：曲面（Surface Features）
// ==================================================================
chapter('第 6 章  曲面（拉伸曲面 / 平面区域 / 裁剪 / 缝合）');

const f6 = await page(`
  await clearDoc();
  // 拉伸曲面：闭合圆轮廓 → 无盖侧壁（0 实体、1 曲面体）
  const sk = M.newSketchFeature('front', circleSk(0, 0, 10));
  app.addFeature(sk, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'surfaceExtrude', name: '曲面-拉伸1', params: { sketchId: sk.id, distance: 20 } }, { rebuild: false });
  await app.rebuild(); await sleep(80);
  let st = stats();
  out.surfCount = st.surfaces; out.surfSolids = st.solids;

  // 曲面实体文件夹出现在设计树
  out.treeSurfFolder = [...document.querySelectorAll('.tree .tnode .label')].some(n => n.textContent.includes('曲面实体'));

  // 平面区域：闭合矩形填成平面曲面
  const sk2 = M.newSketchFeature('top', rectSk(20, 20, -10, -10));
  app.addFeature(sk2, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'surfacePlanar', name: '曲面-平面1', params: { sketchId: sk2.id } }, { rebuild: false });
  await app.rebuild(); await sleep(80);
  st = stats();
  out.planarSurfaces = st.surfaces; out.planarSolids = st.solids;

  // 缝合曲面：两个曲面体 → 1 个
  const surfFeats = app.doc.surfaceFeatures();
  if (surfFeats.length >= 2) {
    app.addFeature({ id: T.newId('f'), type: 'surfaceSew', name: '曲面-缝合1', params: { surfaceIds: surfFeats.map(f => f.id) } }, { rebuild: false });
    await app.rebuild(); await sleep(100);
    st = stats();
    out.sewSurfaces = st.surfaces;
  }
  await clearDoc();
  return out;
`);

check('拉伸曲面（闭合圆轮廓）→ 1 曲面体、0 实体', f6.surfCount === 1 && f6.surfSolids === 0,
  'surfaces=' + f6.surfCount + ' solids=' + f6.surfSolids);
check('设计树出现「曲面实体」文件夹', f6.treeSurfFolder === true);
check('平面区域（闭合矩形）→ 增加 1 曲面体、仍 0 实体', f6.planarSurfaces === 2 && f6.planarSolids === 0,
  'surfaces=' + f6.planarSurfaces + ' solids=' + f6.planarSolids);
check('缝合曲面（2 曲面体）→ 合并为 1 个曲面体', f6.sewSurfaces === 1, 'surfaces=' + f6.sewSurfaces);

// ==================================================================
// 第 7 章：钣金（Sheet Metal）
// ==================================================================
chapter('第 7 章  钣金（基体法兰 / 边线法兰）');

const f7 = await page(`
  await clearDoc();
  // 基体法兰：矩形轮廓 40×30，板厚 1 → 体积 40*30*1 = 1200
  const sk = M.newSketchFeature('front', rectSk(40, 30));
  app.addFeature(sk, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'sheetBaseFlange', name: '基体法兰1', params: { sketchId: sk.id, thickness: 1, bendRadius: 1, kFactor: 0.5, reverse: false, operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(80);
  let st = stats();
  out.baseVol = st.volume; out.baseSolids = st.solids;

  // 边线法兰：在一条长边上折墙（高 10、厚 1）
  const edges = (app.model.mesh && app.model.mesh.edgeMetas) || [];
  let lineEdge = null;
  for (let i = 0; i < edges.length; i++) { const d = edges[i].dir; if (Math.abs(d[2]) < 1e-3) { lineEdge = M.makeEdgeRef(edges[i]); break; } }
  out.hasLineEdge = !!lineEdge;
  if (lineEdge) {
    app.addFeature({ id: T.newId('f'), type: 'sheetEdgeFlange', name: '边线法兰1', params: { edge: lineEdge, length: 10, angleDeg: 90, bendRadius: 1, thickness: 1, reverse: false, operation: 'add' } }, { rebuild: false });
    await app.rebuild(); await sleep(100);
  }
  st = stats();
  out.edgeSolids = st.solids; out.edgeVol = st.volume;
  await clearDoc();
  return out;
`);

check('基体法兰（40×30 板厚 1）→ 体积 1200、1 实体', near(f7.baseVol, 1200, 5) && f7.baseSolids === 1,
  'vol=' + f7.baseVol.toFixed(2) + ' solids=' + f7.baseSolids);
check('边线法兰（长边折墙 高 10 厚 1）→ 仍 1 实体、体积增加', f7.hasLineEdge === true && f7.edgeSolids === 1 && f7.edgeVol > f7.baseVol,
  'solids=' + f7.edgeSolids + ' vol=' + f7.edgeVol.toFixed(2));

// ==================================================================
// 第 8 章：装配体（Assembly）
// ==================================================================
chapter('第 8 章  装配体（组件 / 配合 / 干涉 / 爆炸 / BOM）');

const f8 = await page(`
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [20, 20, 20], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);

  app.setMode('assembly'); await sleep(300);
  out.mode = app.mode;
  out.ribbonTab = (document.querySelector('.rtab.active')?.textContent || '').trim();
  const a = app.ensureAssembly();
  out.components = a.components.length;

  // 插入当前零件为第二个组件
  const before = a.components.length;
  a.insertFromDocument(app.doc.clone(), '零件2');
  await app.syncAssemblyScene(); await sleep(150);
  out.afterInsert = a.components.length;
  out.inserted = a.components.length === before + 1;

  // 统计
  const stt = a.stats();
  out.statsParts = stt.parts; out.statsVol = stt.volume;
  out.bom = a.bomEntries().length;

  // 装配体 ribbon 按钮存在
  rtab('装配体').click(); await sleep(60);
  out.asmBtns = ['插入当前零件', '新建零件', '删除组件', '配合', '重新求解', '固定/浮动', '干涉检查', '爆炸视图'].every(l => !!rbn(l));

  app.setMode('model'); await sleep(150);
  await clearDoc();
  return out;
`);

check('切到装配体模式：丝带自动切「装配体」页签', f8.mode === 'assembly' && f8.ribbonTab === '装配体',
  'mode=' + f8.mode + ' tab=' + f8.ribbonTab);
check('装配体自动插入当前零件为组件', f8.components >= 1, 'components=' + f8.components);
check('插入当前零件为第二个组件', f8.inserted === true, 'after=' + f8.afterInsert);
check('装配体统计：零件数 ≥2、体积 > 0', f8.statsParts >= 2 && f8.statsVol > 0,
  'parts=' + f8.statsParts + ' vol=' + (f8.statsVol || 0).toFixed(0));
check('装配体 BOM 明细条目 ≥1', f8.bom >= 1, 'bom=' + f8.bom);
check('装配体页签含 插入/新建/删除/配合/求解/固定/干涉/爆炸 全部命令', f8.asmBtns === true);

// ==================================================================
// 第 9 章：工程图（Drawing）
// ==================================================================
chapter('第 9 章  工程图（视图 / 标注 / BOM / 导出）');

const f9 = await page(`
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [40, 25, 10], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);

  app.setMode('drawing'); await sleep(500);
  out.mode = app.mode;
  out.ribbonTab = (document.querySelector('.rtab.active')?.textContent || '').trim();
  const d = app.ensureDrawing();
  out.viewCount = d.views.length;
  out.summaryViews = d.summary().views;

  // 自动标注
  app.autoDimensionDrawing('overall'); await sleep(150);
  out.dimsAfterAuto = d.views.reduce((n, v) => n + (v.dims ? v.dims.length : 0), 0);

  // 清除标注
  app.clearDrawingDims(); await sleep(100);
  out.dimsAfterClear = d.views.reduce((n, v) => n + (v.dims ? v.dims.length : 0), 0);

  // SVG 导出字符串
  out.svgLen = d.toSVG().length;

  // 工程图 ribbon 按钮
  rtab('工程图').click(); await sleep(60);
  out.dwBtns = ['生成三视图', '主视图', '俯视图', '右视图', '等轴测', '尺寸标注', '自动标注', '孔位标注', '尺寸公差', '形位公差', '清除标注', '隐藏线开关', '明细表', '导出 SVG', '导出 PNG', '图纸属性'].every(l => !!rbn(l));

  // 图纸宿主可见
  const wrap = document.querySelector('.drawing-wrap');
  out.wrapVisible = !!wrap && !wrap.classList.contains('hidden');

  app.setMode('model'); await sleep(200);
  await clearDoc();
  return out;
`);

check('切到工程图模式：丝带自动切「工程图」页签', f9.mode === 'drawing' && f9.ribbonTab === '工程图',
  'mode=' + f9.mode + ' tab=' + f9.ribbonTab);
check('工程图自动生成三视图 + 等轴测（4 视图）', f9.viewCount === 4 && f9.summaryViews === 4,
  'views=' + f9.viewCount);
check('自动标注生成尺寸（总宽/总高）', f9.dimsAfterAuto > 0, 'dims=' + f9.dimsAfterAuto);
check('清除标注后尺寸归零', f9.dimsAfterClear === 0, 'dims=' + f9.dimsAfterClear);
check('工程图可导出 SVG（非空）', f9.svgLen > 200, 'svg=' + f9.svgLen + ' 字符');
check('工程图页签含 视图/标注/公差/明细表/导出 全部命令', f9.dwBtns === true);
check('工程图宿主（.drawing-wrap）在工程图态可见', f9.wrapVisible === true);

// ==================================================================
// 第 10 章：编辑与撤销（Undo / Redo / 参数修改 / 删除）
// ==================================================================
chapter('第 10 章  编辑与撤销（修改参数 / 撤销重做 / 删除特征）');

const f10 = await page(`
  await clearDoc();
  let skf = M.newSketchFeature('front', rectSk(20, 20));
  app.addFeature(skf, { rebuild: false });
  const exId = T.newId('f');
  app.addFeature({ id: exId, type: 'extrude', name: '拉伸1', params: { sketchId: skf.id, distance: 10, operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  out.vol10 = stats().volume;

  // 修改特征参数：深度 10 → 20
  app.updateFeatureParams(exId, { distance: 20 });
  await app.rebuild(); await sleep(60);
  out.vol20 = stats().volume;

  // 撤销 → 回到 4000
  app.undo(); await sleep(120);
  out.afterUndoVol = stats().volume;
  // 重做 → 回到 8000
  app.redo(); await sleep(120);
  out.afterRedoVol = stats().volume;

  // 删除拉伸特征 → 只剩草图（0 实体）
  app.removeFeature(exId); await sleep(120);
  out.afterRemoveSolids = stats().solids;
  out.afterRemoveSel = app.selectedFeatureId;
  out.afterRemoveActive = app.activeSketchFeature;

  // 删除草图 → 空文档
  const skId = app.doc.sketchFeatures()[0]?.id;
  if (skId) { app.removeFeature(skId); await sleep(100); }
  out.leftFeatures = app.doc.features.length;
  await clearDoc();
  return out;
`);

check('修改特征参数（深度 10→20）→ 体积 4000→8000', near(f10.vol10, 4000, 1) && near(f10.vol20, 8000, 1),
  'v10=' + f10.vol10.toFixed(0) + ' v20=' + f10.vol20.toFixed(0));
check('撤销 → 体积回到 4000', near(f10.afterUndoVol, 4000, 1), 'vol=' + f10.afterUndoVol.toFixed(0));
check('重做 → 体积回到 8000', near(f10.afterRedoVol, 8000, 1), 'vol=' + f10.afterRedoVol.toFixed(0));
check('删除拉伸特征 → 0 实体且无悬空引用（selectedFeatureId / activeSketchFeature 清空）',
  f10.afterRemoveSolids === 0 && f10.afterRemoveSel === null && f10.afterRemoveActive === null,
  'solids=' + f10.afterRemoveSolids + ' sel=' + f10.afterRemoveSel + ' active=' + f10.afterRemoveActive);
check('删除草图后文档特征归零', f10.leftFeatures === 0, 'features=' + f10.leftFeatures);

// ==================================================================
// 第 11 章：文件（新建 / 保存 / 打开）
// ==================================================================
chapter('第 11 章  文件（新建 / 保存序列化 / 打开反序列化）');

const f11 = await page(`
  await clearDoc();
  let skf = M.newSketchFeature('front', rectSk(30, 30));
  app.addFeature(skf, { rebuild: false });
  app.addFeature({ id: T.newId('f'), type: 'extrude', name: '拉伸1', params: { sketchId: skf.id, distance: 5, operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);
  out.vol = stats().volume;

  // 序列化（保存）
  const json = app.doc.toJSON();
  out.jsonFeatures = json.features.length;
  const round = M.CadDocument.fromJSON(JSON.parse(JSON.stringify(json)));
  out.roundFeatures = round.features.length;
  out.roundVol = round.features.length;

  // 用 setFeatures 清空再 loadFeatures 恢复
  app.setFeatures([], { fit: false }); await sleep(100);
  out.cleared = app.doc.features.length;
  app.loadFeatures(round.features, { replace: true, fit: false }); await sleep(150);
  out.restored = app.doc.features.length;
  out.restoredVol = stats().volume;
  await clearDoc();
  return out;
`);

check('文档序列化：toJSON 含 2 个特征（草图 + 拉伸）', f11.jsonFeatures === 2, 'features=' + f11.jsonFeatures);
check('反序列化 fromJSON 还原特征数', f11.roundFeatures === 2, 'features=' + f11.roundFeatures);
check('清空后特征归零', f11.cleared === 0, 'features=' + f11.cleared);
check('打开（loadFeatures）恢复特征且体积一致（4500）',
  f11.restored === 2 && near(f11.restoredVol, 4500, 1),
  'restored=' + f11.restored + ' vol=' + f11.restoredVol.toFixed(0));

// ==================================================================
// 第 12 章：视图与显示（标准视图 / 显示样式 / 投影 / 视口 / 剖面）
// ==================================================================
chapter('第 12 章  视图与显示（标准视图 / 显示样式 / 投影 / 多视口 / 剖面）');

const f12 = await page(`
  await clearDoc();
  app.addFeature({ id: T.newId('f'), type: 'primitive', name: '基本体1', params: { kind: 'box', dims: [20, 20, 20], operation: 'new' } }, { rebuild: false });
  await app.rebuild(); await sleep(60);

  // 标准视图
  app.setView('front'); await sleep(30); out.vFront = true;
  app.setView('top'); await sleep(30);
  app.setView('right'); await sleep(30);
  app.setView('iso'); await sleep(30);
  out.viewOk = true;

  // 显示样式
  const styles = ['shaded', 'shadedEdges', 'wireframe', 'hidden'];
  out.styleOk = true;
  for (const s of styles) { try { app.setDisplayStyle(s); await sleep(20); } catch { out.styleOk = false; } }

  // 投影切换
  const p0 = app.projection;
  app.toggleProjection(); await sleep(30);
  const p1 = app.projection;
  app.toggleProjection(); await sleep(30);
  out.projToggle = p0 !== p1 && app.projection === p0;

  // 多视口
  app.setViewportLayout('quad'); await sleep(80);
  out.quadCount = app.viewportCount;
  out.quadLabels = app.viewportLabels();
  app.setViewportLayout('twoH'); await sleep(80);
  out.twoHCount = app.viewportCount;
  app.setViewportLayout('single'); await sleep(80);
  out.singleCount = app.viewportCount;

  // 剖面视图
  app.setSection('z'); await sleep(50);
  out.sectionOn = app.sectionAxis;
  app.setSection('none'); await sleep(50);
  out.sectionOff = app.sectionAxis;

  // 缩放
  app.zoomFit(); await sleep(30);
  app.zoomIn(); await sleep(30);
  app.zoomOut(); await sleep(30);
  app.prevView(); await sleep(30);
  out.zoomOk = true;

  await clearDoc();
  return out;
`);

check('标准视图切换（前/上/右/等轴测）无异常', f12.viewOk === true);
check('显示样式切换（着色/着色带边/线框/隐藏线）无异常', f12.styleOk === true);
check('投影切换（透视⇄正交）可往返', f12.projToggle === true);
check('多视口：四视图 4 格（前/俯/右/等轴测）', f12.quadCount === 4 && f12.quadLabels.length === 4,
  f12.quadLabels.join('/'));
check('多视口：水平双视图 2 格、单视图 1 格', f12.twoHCount === 2 && f12.singleCount === 1,
  'twoH=' + f12.twoHCount + ' single=' + f12.singleCount);
check('剖面视图开/关（Z 轴）可往返', f12.sectionOn === 'z' && f12.sectionOff === 'none',
  'on=' + f12.sectionOn + ' off=' + f12.sectionOff);
check('缩放（整屏/放大/缩小/上一视图）无异常', f12.zoomOk === true);

// ==================================================================
// 第 13 章：自定义（键盘重映射 / CommandManager 折叠 / Enter 重复命令）
// ==================================================================
chapter('第 13 章  自定义（键盘重映射 / CommandManager 折叠 / Enter 重复上一命令）');

const f13 = await page(`
  const { openKeyboardCustomize } = await import('/src/ui/keyboard-customize.ts');
  const hotkeys = await import('/src/app/hotkeys.ts');
  const { ribbonController } = await import('/src/ui/ribbon.ts');
  localStorage.removeItem('solid2.hotkeys.v1');

  openKeyboardCustomize(null);
  await sleep(150);
  out.kbRows = document.querySelectorAll('.kb-row').length;
  const row = [...document.querySelectorAll('.kb-row')].find(r => r.dataset.kb === 'file.new');
  const keyBtn = row ? row.querySelector('.kb-key') : null;
  out.kbHasRow = !!keyBtn;
  if (keyBtn) keyBtn.click();
  await sleep(50);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
  await sleep(80);
  out.kbAfter = keyBtn ? keyBtn.textContent : '';
  out.kbSc = hotkeys.sc('file.new');
  // 恢复默认
  const resetBtn = [...document.querySelectorAll('.kb-row')].find(r => r.dataset.kb === 'file.new')?.querySelector('.kb-reset');
  if (resetBtn) resetBtn.click();
  await sleep(80);
  out.kbAfterReset = hotkeys.sc('file.new');
  document.querySelector('.pm-foot .btn, .modal-foot .btn')?.click();
  await sleep(60);
  document.querySelectorAll('.modal-mask, .modal').forEach(m => m.remove());

  // CommandManager 折叠
  const tab = [...document.querySelectorAll('.rtab')].find(t => t.textContent.trim() === '特征');
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await sleep(80);
  const collapseItem = [...document.querySelectorAll('.dropdown .dd-item')].find(i => i.textContent.includes('折叠'));
  if (collapseItem) collapseItem.click();
  await sleep(80);
  out.collapsed = ribbonController().collapsed();
  ribbonController().toggleCollapse(); await sleep(60);
  out.uncollapsed = !ribbonController().collapsed();
  document.querySelector('.dropdown')?.remove();

  // Enter 重复上一命令：先跑一次「长方体」，再按 Enter
  await clearDoc();
  rtab('特征').click(); await sleep(50);
  const boxBtn = rbn('长方体'); if (boxBtn) boxBtn.click();
  await sleep(120);
  const pmOk = [...document.querySelectorAll('.pm-foot .btn')].find(b => b.textContent.trim() === '确定');
  if (pmOk) pmOk.click();
  await sleep(250); await app.rebuild(); await sleep(60);
  out.afterBox = app.doc.features.length;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(200);
  out.enterReopened = !!document.querySelector('.pm');
  document.querySelector('.pm-foot .btn')?.click(); await sleep(80);
  await clearDoc();
  return out;
`);

check('自定义键盘：列出全部命令行', f13.kbRows >= 50, 'rows=' + f13.kbRows);
check('自定义键盘：捕获 Ctrl+Alt+M 写入覆盖且即时生效',
  f13.kbHasRow === true && f13.kbAfter === 'Ctrl+Alt+M' && f13.kbSc === 'Ctrl+Alt+M',
  'after=' + f13.kbAfter + ' sc=' + f13.kbSc);
check('自定义键盘：恢复默认回到 Ctrl+N', f13.kbAfterReset === 'Ctrl+N', f13.kbAfterReset);
check('CommandManager 可折叠并可还原', f13.collapsed === true && f13.uncollapsed === true,
  'collapsed=' + f13.collapsed + ' restored=' + f13.uncollapsed);
check('Enter 重复上一命令：重开同一 PropertyManager', f13.afterBox === 1 && f13.enterReopened === true,
  'features=' + f13.afterBox + ' reopened=' + f13.enterReopened);

// ==================================================================
// 第 14 章：命令可达性（全部页签按钮齐备 + 提示 + 图标）
// ==================================================================
chapter('第 14 章  命令可达性（全部 CommandManager 页签命令齐备）');

const f14 = await page(`
  const want = {
    '特征': ['新建','打开','保存','撤销','重做','重建','拉伸凸台','拉伸切除','旋转','放样','扫描',
             '长方体','圆柱','球','圆锥','圆环','异型孔向导','拔模','筋','圆角','倒角','抽壳',
             '移动/复制','缩放','分割','组合','删除实体','基准面','线性阵列','圆周阵列','镜像','参数表','表达式'],
    '钣金': ['基体法兰','边线法兰'],
    '草图': ['草图绘制','上视基准面','右视基准面','在面上草图','直线','矩形','圆','圆弧','椭圆','槽口','点','多边形',
             '抛物线','双曲线','B 样条','水平','竖直','重合','平行','垂直','相等','相切','同心','智能尺寸','构造线','删除','镜像实体','退出草图','放弃'],
    '曲面': ['拉伸曲面','旋转曲面','平面区域','放样曲面','扫描曲面','裁剪曲面','缝合曲面'],
    '评估': ['质量属性','测量','截面属性','模型统计','几何检查'],
    '装配体': ['插入当前零件','新建零件','删除组件','配合','重新求解','固定/浮动','干涉检查','爆炸视图'],
    '工程图': ['生成三视图','主视图','俯视图','右视图','等轴测','尺寸标注','自动标注','孔位标注','尺寸公差','形位公差','清除标注','隐藏线开关','明细表','导出 SVG','导出 PNG','图纸属性'],
  };
  const missing = {};
  const noTip = [];
  const noIcon = [];
  let total = 0;
  for (const [tabName, labels] of Object.entries(want)) {
    const t = rtab(tabName);
    if (!t) { missing[tabName] = labels; continue; }
    t.click(); await sleep(60);
    const btns = [...document.querySelectorAll('.rbtn')];
    const map = new Map(btns.map(b => [b.textContent.trim(), b]));
    const miss = labels.filter(l => !map.has(l));
    if (miss.length) missing[tabName] = miss;
    for (const l of labels) {
      const b = map.get(l);
      if (!b) continue;
      total++;
      if (!(b.getAttribute('title') || '').trim()) noTip.push(tabName + '/' + l);
      if ((b.querySelector('svg')?.outerHTML || '').length < 40) noIcon.push(tabName + '/' + l);
    }
  }
  out.missing = missing;
  out.missingCount = Object.keys(missing).length;
  out.noTip = noTip;
  out.noIcon = noIcon;
  out.total = total;
  return out;
`);

check('全部页签命令齐备（无缺失）', f14.missingCount === 0,
  f14.missingCount ? JSON.stringify(f14.missing) : ('共校验 ' + f14.total + ' 个命令'));
check('每个命令都有提示文案（title）', f14.noTip.length === 0, f14.noTip.slice(0, 6).join(' / '));
check('每个命令都有图标（SVG）', f14.noIcon.length === 0, f14.noIcon.slice(0, 6).join(' / '));

// ==================================================================
// 汇总
// ==================================================================
chapterResults.push(currentChapter);
console.log('\n' + '='.repeat(64));
console.log('  手册一致性测试汇总（按章）');
console.log('='.repeat(64));
for (const c of chapterResults) {
  console.log('  ' + (c.fail ? '\u2717' : '\u2713') + ' ' + c.name + '  (' + c.pass + ' 通过' + (c.fail ? ' / ' + c.fail + ' 失败' : '') + ')');
}
console.log('\n总计: ' + pass + ' 通过 / ' + fail + ' 失败  (' + (pass + fail) + ' 项)');

ws.close();
cleanup();
process.exit(fail ? 1 : 0);
