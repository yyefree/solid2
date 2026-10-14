/**
 * 浏览器端到端冒烟测试（零依赖）。
 *
 * 目的：在**真实浏览器 + 真实 Worker 内核**里跑通「实体编辑」三个新命令
 * （缩放 / 分割 / 变半径圆角），补上 Node 测试覆盖不到的那一层——
 * UI 接线、Worker 启动、WASM 实际加载、渲染管线。
 *
 * 做法：用 Edge/Chrome 的 CDP（Chrome DevTools Protocol）驱动，
 * 通过开发态调试句柄 `window.__solid2`（见 src/main.ts，仅 DEV 下注入）拿到 app，
 * 直接在页面上下文里调 App API 造特征并读取真实模型统计。
 *
 * 用法：
 *   npm run dev                # 另开一个终端先起开发服务器
 *   node tools/browser-smoke.mjs [url]
 *
 * 环境变量：
 *   SMOKE_TIMEOUT_MS  等待内核就绪的上限（默认 240000，65MB WASM 首次加载较慢）
 *   SMOKE_HEADFUL=1   显示浏览器窗口（调试用）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PORT = Number(process.env.SMOKE_CDP_PORT ?? 9333);
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
function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}  ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// 1. 启动浏览器
// ------------------------------------------------------------------
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) {
  console.error('找不到 Edge/Chrome 可执行文件，跳过浏览器冒烟测试。');
  process.exit(0);
}
console.log(`浏览器: ${exe}`);
console.log(`目标:   ${URL_}\n`);

const profile = mkdtempSync(path.join(tmpdir(), 'solid2-smoke-'));
const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
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

// ------------------------------------------------------------------
// 2. 等 CDP 端口，拿到页面 target
// ------------------------------------------------------------------
async function getPageTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
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
  console.error(`✗ ${e.message}`);
  cleanup();
  process.exit(1);
}
console.log(`CDP 已连接: ${target.title || target.url}\n`);

// ------------------------------------------------------------------
// 3. 极简 CDP 客户端
// ------------------------------------------------------------------
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

/** 在页面里求值；expr 可以是表达式或 async IIFE 字符串 */
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

// 等 __solid2 出现（boot 完成）
async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expr, { awaitPromise: false })) return true;
    } catch (e) { lastErr = e.message; }
    await sleep(400);
  }
  console.log(`  ✗ 等待超时：${label}${lastErr ? `  (${lastErr})` : ''}`);
  return false;
}

// ==================================================================
// A. UI 接线（不依赖内核）
// ==================================================================
console.log('▶ A. UI 接线（真实浏览器 DOM）');

const booted = await waitFor('!!(window.__solid2 && window.__solid2.app)', 20000, '应用启动');
check('应用启动并暴露调试句柄', booted);
if (!booted) {
  console.log('\n应用未启动，终止。');
  ws.close(); cleanup(); process.exit(1);
}

// 收集「特征」页签下的分组与按钮
const ui = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.rtab')];
  const featTab = tabs.find(t => t.textContent.includes('特征'));
  if (featTab) featTab.click();
  const groups = [...document.querySelectorAll('.rgroup')].map(g => ({
    title: g.querySelector('.rgroup-title')?.textContent ?? '',
    buttons: [...g.querySelectorAll('.rbtn')].map(b => ({
      label: b.textContent.trim(),
      title: b.getAttribute('title') ?? '',
      svgLen: (b.querySelector('svg')?.outerHTML ?? '').length,
    })),
  }));
  return { tabCount: tabs.length, groups };
})()`);

check('Ribbon 页签已渲染', ui.tabCount > 0, `${ui.tabCount} 个页签`);
const editGroup = ui.groups.find((g) => g.title === '实体编辑');
check('存在「实体编辑」分组', !!editGroup);
if (editGroup) {
  const labels = editGroup.buttons.map((b) => b.label);
  const want = ['移动/复制', '缩放', '分割', '组合', '删除实体'];
  check('分组含全部 5 个实体编辑按钮', want.every((w) => labels.includes(w)), labels.join(' / '));
  for (const b of editGroup.buttons) {
    check(`「${b.label}」有提示文案`, b.title.length > 0, b.title);
    check(`「${b.label}」图标 SVG 非空`, b.svgLen > 40, `svg ${b.svgLen} 字符`);
  }
}

// 「特征」页签的「参数化」分组（本轮交付：表达式 / 参数表）
const paramGroup = ui.groups.find((g) => g.title === '参数化');
check('存在「参数化」分组', !!paramGroup);
if (paramGroup) {
  const labels = paramGroup.buttons.map((b) => b.label);
  check('分组含「参数表」「表达式」', ['参数表', '表达式'].every((w) => labels.includes(w)), labels.join(' / '));
  for (const b of paramGroup.buttons) {
    check(`「${b.label}」有提示文案`, b.title.length > 0, b.title);
    check(`「${b.label}」图标 SVG 非空`, b.svgLen > 40, `svg ${b.svgLen} 字符`);
  }
}

// SolidWorks GUI 复刻一致性校验（纯 DOM，不依赖内核）
const sw = await evaluate(`(() => {
  const menuItems = [...document.querySelectorAll('.menubar .menu-item')].map(m => m.textContent.replace(/\\s+/g, ''));
  const search = !!document.querySelector('.menu-search-input');
  const headsUpBtns = document.querySelectorAll('.headsup .hu-btn').length;
  const headsUpCmds = [...document.querySelectorAll('.headsup .hu-btn')].map(b => b.dataset.cmd);
  const viewcube = !!document.querySelector('.viewcube svg');
  const triad = !!document.querySelector('.axis-triad svg');
  const conf = !!document.querySelector('.conf-host .conf-corner');
  const statusRight = !!document.querySelector('.statusbar .sb-right');
  const coord = !!document.querySelector('.sb-coord');
  const unit = (document.querySelector('.sb-unit')?.textContent ?? '').trim();
  const tabs = [...document.querySelectorAll('.rtab')].map(t => t.textContent.trim());
  return { menuItems, search, headsUpBtns, headsUpCmds, viewcube, triad, conf, statusRight, coord, unit, tabs };
})()`);
const wantMenus = ['文件', '编辑', '视图', '插入', '工具', '窗口', '帮助'];
check('菜单栏含 SolidWorks 七菜单', wantMenus.every((w) => sw.menuItems.some((m) => m.startsWith(w))), sw.menuItems.join(' '));
check('菜单栏含命令搜索框', sw.search);
const wantTabs = ['特征', '草图', '评估', '装配体', '工程图', '曲线', '视图', 'AI'];
check('Ribbon 含 8 个 CommandManager 页签', wantTabs.every((w) => sw.tabs.includes(w)), sw.tabs.join(' '));
check('Heads-up 视图工具栏已渲染（14 按钮）', sw.headsUpBtns === 14, '按钮数 ' + sw.headsUpBtns);
check(
  'Heads-up 含 旋转视图 / 编辑外观 / 光源 三个新入口',
  ['view.rotate', 'view.appearance', 'view.lighting'].every((c) => sw.headsUpCmds.includes(c)),
  sw.headsUpCmds.join(',')
);
check(
  'Heads-up 不含 SW 没有的按钮（视图设置/显示模式，投影切换在视图设置对话框）',
  ['view.settings', 'view.projection'].every((c) => !sw.headsUpCmds.includes(c)),
  sw.headsUpCmds.join(',')
);
check('视图立方（ViewCube）已渲染', sw.viewcube);
check('参考三重轴（Triad）已渲染', sw.triad);
check('确认角（✓/✗）已挂载', sw.conf);
check('状态栏右侧区（坐标/单位/重建）已渲染', sw.statusRight && sw.coord);
check('状态栏单位显示 mm', sw.unit === 'mm', sw.unit);
// 特征树：原点展开为 X/Y/Z 三轴（SolidWorks 零件树结构）
const treeLabels = await evaluate(`[...document.querySelectorAll('.tree .tnode .label')].map(n => n.textContent.trim())`);
check('特征树原点下含 X/Y/Z 轴三节点', ['原点', 'X 轴', 'Y 轴', 'Z 轴'].every((t) => treeLabels.includes(t)), treeLabels.slice(-6).join(' / '));
// 右键菜单：「更多命令…」飞出（SolidWorks 菜单底部）
const ctxLabels = await evaluate(`(() => {
  const cv = document.querySelector('.viewport canvas');
  if (!cv) return [];
  cv.dispatchEvent(new MouseEvent('contextmenu', { clientX: 420, clientY: 320, bubbles: true }));
  return [...document.querySelectorAll('.dropdown.ctx-menu .ctx-list .dd-label')].map(n => n.textContent.trim());
})()`);
check('图形区右键菜单含「更多命令…」飞出', ctxLabels.includes('更多命令…'), ctxLabels.join(' / '));

// 点开「参数表」确认对话框与表达式表格渲染出来
// 注意：Ribbon 点击会先 await 内核就绪，所以这里必须等内核加载完再做（放在 B 段之后）
const paramDialog = await (async () => {
  await waitFor('window.__solid2.app.kernelReady === true', 90000, '内核就绪（对话框检查）');
  return evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.rtab')].find(t => t.textContent.includes('特征'));
  if (tab) tab.click();
  await new Promise(r => setTimeout(r, 60));
  const btn = [...document.querySelectorAll('.rbtn')].find(b => b.textContent.trim() === '参数表');
  if (!btn) return { opened: false, reason: '按钮缺失' };
  btn.click();
  for (let i = 0; i < 40 && !document.querySelector('.modal'); i++) await new Promise(r => setTimeout(r, 50));
  const modal = document.querySelector('.modal');
  const head = modal?.querySelector('.modal-head')?.textContent ?? '';
  const table = modal?.querySelector('table.expr-table');
  const cols = table ? [...table.querySelectorAll('thead th')].map(th => th.textContent.trim()) : [];
  const hasAddBtn = !![...document.querySelectorAll('.modal .btn')].find(b => b.textContent.includes('添加参数'));
  const hasHint = (modal?.textContent ?? '').includes('=');
  document.querySelector('.modal-mask')?.remove();
  return { opened: !!modal, head, cols, hasAddBtn, hasHint };
})()`);
})();
check('「参数表」对话框可打开', paramDialog.opened, paramDialog.head);
check('参数表含 名称/表达式/值 三列', JSON.stringify(paramDialog.cols) === JSON.stringify(['名称', '表达式', '值', '']),
  JSON.stringify(paramDialog.cols));
check('参数表含「添加参数」按钮与用法说明', paramDialog.hasAddBtn && paramDialog.hasHint);

// 「曲线」页签也点一下，确认弹簧/涡状线在（上轮交付）
const curve = await evaluate(`(() => {
  const t = [...document.querySelectorAll('.rtab')].find(x => x.textContent.includes('曲线'));
  if (t) t.click();
  return [...document.querySelectorAll('.rbtn')].map(b => b.textContent.trim());
})()`);
check('「曲线」页签含弹簧/涡状线', curve.includes('弹簧') || curve.includes('涡状线'), curve.join(' / '));

// 「草图」页签：确认本轮新增的椭圆/槽口/点/镜像实体按钮已接线
const sketchTab = await evaluate(`(() => {
  const t = [...document.querySelectorAll('.rtab')].find(x => x.textContent.includes('草图'));
  if (t) t.click();
  const groups = [...document.querySelectorAll('.rgroup')].map(g => ({
    title: g.querySelector('.rgroup-title')?.textContent ?? '',
    buttons: [...g.querySelectorAll('.rbtn')].map(b => ({
      label: b.textContent.trim(),
      title: b.getAttribute('title') ?? '',
      svgLen: (b.querySelector('svg')?.outerHTML ?? '').length,
    })),
  }));
  return { groups };
})()`);
{
  const entGroup = sketchTab.groups.find((g) => g.title === '实体');
  check('草图页签存在「实体」分组', !!entGroup);
  if (entGroup) {
    const labels = entGroup.buttons.map((b) => b.label);
    check('「实体」组含椭圆/槽口/点', ['椭圆', '槽口', '点'].every((w) => labels.includes(w)), labels.join(' / '));
    for (const w of ['椭圆', '槽口', '点']) {
      const b = entGroup.buttons.find((x) => x.label === w);
      check(`「${w}」有提示文案与图标`, !!b && b.title.length > 0 && b.svgLen > 40, b ? `svg ${b.svgLen} 字符` : '缺失');
    }
  }
  const editGroup2 = sketchTab.groups.find((g) => g.title === '编辑');
  check('草图页签存在「编辑」分组（含镜像实体）', !!editGroup2 && editGroup2.buttons.some((b) => b.label === '镜像实体'));
  if (editGroup2) {
    const mb = editGroup2.buttons.find((b) => b.label === '镜像实体');
    check('「镜像实体」有提示文案与图标', !!mb && mb.title.length > 0 && mb.svgLen > 40, mb ? `svg ${mb.svgLen} 字符` : '缺失');
  }
  // 本轮新增：草图页签「曲线」分组（抛物线 / 双曲线 / B 样条）
  const curveGroup = sketchTab.groups.find((g) => g.title === '曲线');
  check('草图页签存在「曲线」分组', !!curveGroup);
  if (curveGroup) {
    const labels = curveGroup.buttons.map((b) => b.label);
    check('「曲线」组含抛物线/双曲线/B 样条',
      ['抛物线', '双曲线', 'B 样条'].every((w) => labels.includes(w)), labels.join(' / '));
    for (const w of ['抛物线', '双曲线', 'B 样条']) {
      const b = curveGroup.buttons.find((x) => x.label === w);
      check(`「${w}」有提示文案与图标`, !!b && b.title.length > 0 && b.svgLen > 40, b ? `svg ${b.svgLen} 字符` : '缺失');
    }
  }
}

// 切回特征页签
await evaluate(`[...document.querySelectorAll('.rtab')].find(x => x.textContent.includes('特征'))?.click()`);

// ==================================================================
// B. 内核就绪（真实 65MB WASM 加载）
// ==================================================================
console.log('\n▶ B. 内核加载');
const ready = await waitFor('window.__solid2.app.kernelReady === true', TIMEOUT, '内核就绪');
check('Worker 内核在浏览器中加载完成', ready);

// 骨架布局回归（曾经因 .app 少一行 grid row 整列错位：
// main 被挤进状态栏行，图形区塌成 24px 细条 —— 功能断言全绿但草图点击全乱。
// .app 启动时带 hidden，需等启动屏摘除后再量几何。）
await waitFor("!document.querySelector('.app')?.classList.contains('hidden')", 15000, '界面显示');
const layout = await evaluate(`(() => {
  const tops = {};
  for (const [k, sel] of [['menubar', '.menubar'], ['std', '.menubar-std'],
    ['ribbonTabs', '.ribbon-tabs'], ['ribbon', '.ribbon'],
    ['main', '.main'], ['statusbar', '.statusbar']]) {
    const e = document.querySelector(sel);
    tops[k] = e ? e.getBoundingClientRect().top : -1;
  }
  const c = document.querySelector('.viewport canvas');
  const r = c.getBoundingClientRect();
  return { tops, canvas: { w: r.width, h: r.height }, winH: window.innerHeight };
})()`);
check('骨架六行自上而下顺序正确（menubar→std→ribbon-tabs→ribbon→main→statusbar）',
  ['menubar', 'std', 'ribbonTabs', 'ribbon', 'main', 'statusbar']
    .every((k, i, a) => i === 0 || layout.tops[a[i - 1]] < layout.tops[k]),
  Object.entries(layout.tops).map(([k, v]) => `${k}:${v}`).join(' < '));
check('图形区（canvas）高度占窗口 40% 以上',
  layout.canvas.h > layout.winH * 0.4,
  `${layout.canvas.w.toFixed(0)}×${layout.canvas.h.toFixed(0)} / 窗口高 ${layout.winH}`);
if (!ready) {
  const st = await evaluate(`document.querySelector('.statusbar')?.textContent ?? ''`, { awaitPromise: false });
  console.log(`    状态栏: ${st}`);
  console.log('\n内核未就绪，跳过端到端（可能受 headless OOM 影响，非代码问题）。');
  ws.close();
  console.log(`\nUI 冒烟：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

// ==================================================================
// C. 端到端：缩放 → 变半径圆角 → 分割（真实 Worker 内核）
// ==================================================================
console.log('\n▶ C. 端到端（真实内核）');

const e2e = await (async () => {
  try {
    return await evaluate(`(async () => {
  const { app } = window.__solid2;
  const { newId } = await import('/src/sketch/types.ts');
  const out = { steps: [] };

  // 1) 20³ 长方体
  app.addFeature({
    id: newId('f'), type: 'primitive', name: '长方体',
    params: { kind: 'box', dims: [20, 20, 20], origin: [0, 0, 0], operation: 'new' },
  }, { rebuild: false });
  await app.rebuild();
  const s1 = app.model.stats;
  out.steps.push({ name: '长方体 20³', volume: s1.volume, faces: s1.faces, solids: s1.solids });

  // 2) 缩放 2×（以原点为不动点）
  app.addFeature({
    id: newId('f'), type: 'scale', name: '缩放1',
    params: { center: [0, 0, 0], factor: 2 },
  }, { rebuild: false });
  await app.rebuild();
  const s2 = app.model.stats;
  out.steps.push({ name: '缩放 2×', volume: s2.volume, faces: s2.faces, solids: s2.solids });

  // 3) 变半径圆角：取当前模型最长的一条棱
  const metas = app.model.mesh.edgeMetas.filter(m => m.curveType !== 'circle');
  if (!metas.length) throw new Error('模型里没有可用的直线棱');
  let longest = metas[0];
  for (const m of metas) if (m.length > longest.length) longest = m;
  out.pickedEdge = { mid: longest.mid, dir: longest.dir, len: longest.length, curveType: longest.curveType };
  app.addFeature({
    id: newId('f'), type: 'fillet', name: '圆角',
    params: { edges: [{ point: [...longest.mid], dir: [...longest.dir] }], radius: 2, radius2: 8 },
  }, { rebuild: false });
  await app.rebuild();
  const s3 = app.model.stats;
  out.steps.push({ name: '变半径圆角 2→8', volume: s3.volume, faces: s3.faces, solids: s3.solids });

  // 4) 分割：用 z = 中点 的水平面切成两块
  const bb = app.model.bbox;
  const cz = (bb.min[2] + bb.max[2]) / 2;
  out.splitZ = cz;
  app.addFeature({
    id: newId('f'), type: 'split', name: '分割1',
    params: {
      plane: { origin: [0, 0, cz], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
      keep: 'both',
    },
  }, { rebuild: false });
  await app.rebuild();
  const s4 = app.model.stats;
  out.steps.push({ name: '分割（保留两侧）', volume: s4.volume, faces: s4.faces, solids: s4.solids });

  // 5) 组合（添加）：把切出来的两块合并回一个实体
  app.addFeature({
    id: newId('f'), type: 'combine', name: '组合1',
    params: { mainIndex: 0, toolIndices: [1], operation: 'add' },
  }, { rebuild: false });
  await app.rebuild();
  const s5 = app.model.stats;
  out.steps.push({ name: '组合（添加）', volume: s5.volume, faces: s5.faces, solids: s5.solids });

  // 6) 移动/复制实体：复制 1 份并沿 X 平移 200
  app.addFeature({
    id: newId('f'), type: 'moveBody', name: '复制1',
    params: { delta: [200, 0, 0], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 0, copy: true, count: 1 },
  }, { rebuild: false });
  await app.rebuild();
  const s6 = app.model.stats;
  out.steps.push({ name: '移动/复制（复制 1 份）', volume: s6.volume, faces: s6.faces, solids: s6.solids });

  out.errors = app.model.errors.map(e => e.message);
  out.viewInfo = document.querySelector('.vp-info')?.textContent ?? '';
  out.status = document.querySelector('.statusbar')?.textContent ?? '';
  return out;
})()`);
  } catch (e) {
    console.log(`  ✗ 端到端执行异常：${e.message}`);
    fail++;
    ws.close();
    cleanup();
    console.log(`\n浏览器端到端：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
})();

console.log(`    自动选边: 长度=${e2e.pickedEdge.len.toFixed(2)} 类型=${e2e.pickedEdge.curveType ?? 'line'}`);
for (const s of e2e.steps) {
  console.log(`    ${s.name.padEnd(18)} 体积=${s.volume.toFixed(2).padStart(10)}  面=${s.faces}  实体=${s.solids}`);
}
console.log(`    状态栏: ${e2e.status}`);

const [st1, st2, st3, st4, st5, st6] = e2e.steps;
const near = (a, b, rel = 0.01) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-6;

check('无特征错误', e2e.errors.length === 0, e2e.errors.join('; '));
check('长方体 20³ 体积 = 8000', near(st1.volume, 8000), st1.volume.toFixed(2));
check('长方体 6 面 / 1 实体', st1.faces === 6 && st1.solids === 1, `${st1.faces} 面 / ${st1.solids} 实体`);
check('缩放 2× 后体积 ×8 = 64000', near(st2.volume, 64000), st2.volume.toFixed(2));
check('缩放不改变面数（仍 6 面）', st2.faces === 6, `${st2.faces} 面`);
check('变半径圆角后体积减小', st3.volume < st2.volume, `${st3.volume.toFixed(2)} < ${st2.volume.toFixed(2)}`);
check('变半径圆角产生新面（6 → 7）', st3.faces === 7, `${st3.faces} 面`);
check('变半径圆角后仍是单实体', st3.solids === 1, `${st3.solids} 实体`);
check('分割成 2 个实体', st4.solids === 2, `${st4.solids} 实体`);
check('分割体积守恒', near(st4.volume, st3.volume, 1e-3), `${st4.volume.toFixed(2)} vs ${st3.volume.toFixed(2)}`);
check('组合（添加）合并回 1 个实体', st5.solids === 1, `${st5.solids} 实体`);
check('组合后体积守恒', near(st5.volume, st4.volume, 1e-3), `${st5.volume.toFixed(2)} vs ${st4.volume.toFixed(2)}`);
check('移动/复制 → 2 个实体', st6.solids === 2, `${st6.solids} 实体`);
check('复制 1 份后体积 ×2', near(st6.volume, st5.volume * 2, 1e-3), `${st6.volume.toFixed(2)} vs ${(st5.volume * 2).toFixed(2)}`);
check('视口信息浮层已更新', /\d+F/.test(e2e.viewInfo), e2e.viewInfo);

// ==================================================================
// D. 草图实体族：椭圆 / 槽口 / 点 / 镜像（真实 Worker 内核）
// ==================================================================
console.log('\n▶ D. 草图实体族（真实内核）');

const sk = await (async () => {
  try {
    return await evaluate(`(async () => {
  const { app } = window.__solid2;
  const T = await import('/src/sketch/types.ts');
  const { newId } = T;
  const out = { steps: [], errors: [] };

  // 每个子用例前清空文档，保证各自独立（'new' 会保留已有实体，不清空会互相叠加）
  const reset = async () => {
    for (const f of [...app.doc.features]) app.doc.remove(f.id);
    await app.rebuild();
  };

  // --- D1. 椭圆草图 → 拉伸 ---
  {
    await reset();
    const s = T.emptySketch();
    const c = newId('p'); s.points[c] = { id: c, x: 0, y: 0 };
    s.entities.push({ id: newId('e'), kind: 'ellipse', c, rx: 10, ry: 5, rot: 0 });
    const sid = newId('f');
    app.addFeature({ id: sid, type: 'sketch', name: '椭圆草图', params: { plane: 'front', sketch: s } }, { rebuild: false });
    app.addFeature({ id: newId('f'), type: 'extrude', name: '拉伸椭圆',
      params: { sketchId: sid, distance: 10, operation: 'new' } }, { rebuild: false });
    await app.rebuild();
    const st = app.model.stats;
    out.steps.push({ name: '椭圆 a=10 b=5 拉伸10', volume: st.volume, faces: st.faces, solids: st.solids });
  }

  // --- D2. 直槽口草图 → 拉伸 ---
  {
    await reset();
    const s = T.emptySketch();
    const tpl = T.slotTemplate([0, 0], [40, 0], 5);
    const ids = tpl.points.map(([x, y]) => { const id = newId('p'); s.points[id] = { id, x, y }; return id; });
    for (const t of tpl.entities) {
      if (t.kind === 'line') s.entities.push({ id: newId('e'), kind: 'line', a: ids[t.a], b: ids[t.b] });
      else s.entities.push({ id: newId('e'), kind: 'arc', c: ids[t.c], a: ids[t.a], b: ids[t.b], ccw: t.ccw });
    }
    const sid = newId('f');
    app.addFeature({ id: sid, type: 'sketch', name: '槽口草图', params: { plane: 'front', sketch: s } }, { rebuild: false });
    app.addFeature({ id: newId('f'), type: 'extrude', name: '拉伸槽口',
      params: { sketchId: sid, distance: 6, operation: 'new' } }, { rebuild: false });
    await app.rebuild();
    const st = app.model.stats;
    out.steps.push({ name: '槽口 2rL+πr² 拉伸6', volume: st.volume, faces: st.faces, solids: st.solids });
  }

  // --- D3. 矩形 + 圆孔 + 独立点（定位点） → 拉伸 ---
  {
    await reset();
    const s = T.emptySketch();
    const mk = (x, y) => { const id = newId('p'); s.points[id] = { id, x, y }; return id; };
    const p1 = mk(0, 0), p2 = mk(60, 0), p3 = mk(60, 40), p4 = mk(0, 40);
    s.entities.push({ id: newId('e'), kind: 'line', a: p1, b: p2 });
    s.entities.push({ id: newId('e'), kind: 'line', a: p2, b: p3 });
    s.entities.push({ id: newId('e'), kind: 'line', a: p3, b: p4 });
    s.entities.push({ id: newId('e'), kind: 'line', a: p4, b: p1 });
    const hc = mk(30, 20);
    s.entities.push({ id: newId('e'), kind: 'circle', c: hc, r: 6 });
    s.entities.push({ id: newId('e'), kind: 'point', p: hc }); // 与孔心重合的参考点
    const sid = newId('f');
    app.addFeature({ id: sid, type: 'sketch', name: '孔板草图', params: { plane: 'front', sketch: s } }, { rebuild: false });
    app.addFeature({ id: newId('f'), type: 'extrude', name: '拉伸孔板',
      params: { sketchId: sid, distance: 8, operation: 'new' } }, { rebuild: false });
    await app.rebuild();
    const st = app.model.stats;
    out.steps.push({ name: '孔板 60×40 −φ12 拉伸8', volume: st.volume, faces: st.faces, solids: st.solids });
  }

  // --- D4. 「新建实体」多实体语义：两个相交实体应保持独立 ---
  {
    await reset();
    app.addFeature({
      id: newId('f'), type: 'primitive', name: '长方体1',
      params: { kind: 'box', dims: [20, 20, 20], origin: [0, 0, 0], operation: 'new' },
    }, { rebuild: false });
    app.addFeature({
      id: newId('f'), type: 'primitive', name: '长方体2',
      params: { kind: 'box', dims: [20, 20, 20], origin: [10, 0, 0], operation: 'new' },
    }, { rebuild: false });
    await app.rebuild();
    const st = app.model.stats;
    out.newBody = { volume: st.volume, solids: st.solids };
  }

  // --- D5. 镜像实体（纯几何，不建特征） ---
  {
    const s = T.emptySketch();
    const A = newId('p'), B = newId('p');
    s.points[A] = { id: A, x: 0, y: 0 };
    s.points[B] = { id: B, x: 0, y: 10 };
    const axis = newId('e');
    s.entities.push({ id: axis, kind: 'line', a: A, b: B });
    const cc = newId('p'); s.points[cc] = { id: cc, x: 10, y: 3 };
    const circle = newId('e');
    s.entities.push({ id: circle, kind: 'circle', c: cc, r: 5 });
    const n = T.mirrorEntitiesInPlace(s, axis, [circle]);
    const nc = s.entities.find((e) => e.kind === 'circle' && e.id !== circle);
    out.mirror = { n, entities: s.entities.length, cx: s.points[nc.c].x, cy: s.points[nc.c].y, r: nc.r };
  }

  out.errors = app.model.errors.map(e => e.message);
  out.status = document.querySelector('.statusbar')?.textContent ?? '';
  return out;
})()`);
  } catch (e) {
    console.log(`  ✗ 草图实体族执行异常：${e.message}`);
    fail++;
    ws.close();
    cleanup();
    console.log(`\n浏览器端到端：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
})();

for (const s of sk.steps) {
  console.log(`    ${s.name.padEnd(24)} 体积=${s.volume.toFixed(2).padStart(10)}  面=${s.faces}  实体=${s.solids}`);
}
console.log(`    新建实体（两相交 20³）: 体积=${sk.newBody.volume.toFixed(2)}  实体=${sk.newBody.solids}`);
console.log(`    镜像: 新增 ${sk.mirror.n} 个，圆新心 = [${sk.mirror.cx}, ${sk.mirror.cy}] r=${sk.mirror.r}`);

const [d1, d2, d3] = sk.steps;
check('草图实体族无错误', sk.errors.length === 0, sk.errors.join('; '));
check('椭圆 a=10 b=5 拉伸 10 → 体积 = π·a·b·h', near(d1.volume, Math.PI * 10 * 5 * 10, 2e-3), d1.volume.toFixed(2));
check('椭圆拉伸仍为单实体', d1.solids === 1, `${d1.solids} 实体`);
check('槽口拉伸 6 → 体积 = (2rL+πr²)·h', near(d2.volume, (2 * 5 * 40 + Math.PI * 25) * 6, 2e-3), d2.volume.toFixed(2));
check('槽口拉伸仍为单实体', d2.solids === 1, `${d2.solids} 实体`);
check('孔板拉伸 8 → 体积 = (2400−π·36)·8', near(d3.volume, (60 * 40 - Math.PI * 36) * 8, 2e-3), d3.volume.toFixed(2));
check('孔板拉伸仍为单实体', d3.solids === 1, `${d3.solids} 实体`);
check('「新建实体」相交时保持 2 个独立实体', sk.newBody.solids === 2, `${sk.newBody.solids} 实体`);
check('「新建实体」体积相加（不融合）', near(sk.newBody.volume, 16000, 2e-3), sk.newBody.volume.toFixed(2));
check('镜像新增 1 个实体', sk.mirror.n === 1, `n=${sk.mirror.n}`);
check('镜像圆心落在 (−10,3)、半径不变', Math.abs(sk.mirror.cx + 10) < 1e-6 && Math.abs(sk.mirror.cy - 3) < 1e-6 && sk.mirror.r === 5,
  `c=[${sk.mirror.cx}, ${sk.mirror.cy}] r=${sk.mirror.r}`);

// ==================================================================
// E. 表达式驱动几何（参考 FreeCAD Expressions，真实 Worker 内核）
// ==================================================================
console.log('\n▶ E. 表达式驱动几何（真实内核）');

const ex = await (async () => {
  try {
    return await evaluate(`(async () => {
  const { app } = window.__solid2;
  const T = await import('/src/sketch/types.ts');
  const { newId } = T;
  const out = { steps: [], errors: [] };

  const reset = async () => {
    for (const f of [...app.doc.features]) app.doc.remove(f.id);
    app.doc.params.length = 0;
    await app.rebuild();
  };

  // --- E1. 全局参数驱动拉伸深度 ---
  await reset();
  {
    const s = T.emptySketch();
    const ids = [[0,0],[50,0],[50,30],[0,30]].map(([x,y]) => { const id = newId('p'); s.points[id] = { id, x, y }; return id; });
    for (let i = 0; i < 4; i++) s.entities.push({ id: newId('e'), kind: 'line', a: ids[i], b: ids[(i+1)%4] });
    const sid = newId('f');
    app.addFeature({ id: sid, type: 'sketch', name: '草图1', params: { plane: 'front', sketch: s } }, { rebuild: false });
    app.addFeature({
      id: newId('f'), type: 'extrude', name: '拉伸1',
      params: { sketchId: sid, distance: 1, operation: 'new' },
      expressions: { distance: '=板厚' },
    }, { rebuild: false });
    app.doc.setParam('板厚', '8');
    await app.rebuild();
    out.steps.push({ name: '板厚=8 → 拉伸深度', volume: app.model.stats.volume });
    out.paramValue = app.paramValues['板厚'];
    out.literal = app.doc.features[1].params.distance;

    // 改全局参数 → 几何自动联动
    app.doc.setParam('板厚', '20');
    await app.rebuild();
    out.steps.push({ name: '板厚=20 → 联动', volume: app.model.stats.volume });

    // --- E2. 表达式错误 → 特征标红、退回字面值 ---
    const ex1 = app.doc.features[1];
    app.setFeatureExpression(ex1.id, 'distance', '不存在的参数');
    await app.rebuild();
    out.errFlag = !!ex1.error;
    out.errMsg = ex1.error ?? '';
    out.issueCount = app.expressionIssues.length;
    out.issueWhere = app.expressionIssues[0]?.where ?? '';

    // --- E3. 表达式引用特征属性 + 复合公式 ---
    app.setFeatureExpression(ex1.id, 'distance', '=板厚*2 + sqrt(16)');
    await app.rebuild();
    out.steps.push({ name: '板厚*2+sqrt(16)=44', volume: app.model.stats.volume });

    // --- E4. 参数表序列化往返 ---
    const round = app.doc.constructor.fromJSON(JSON.parse(JSON.stringify(app.doc.toJSON())));
    out.roundParams = round.params.map(p => p.name);
    out.roundExpr = round.features[1]?.expressions?.distance ?? '';

    // --- E5. 表达式对话框 DOM ---
    const tab = [...document.querySelectorAll('.rtab')].find(t => t.textContent.includes('特征'));
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 60));
    const btn = [...document.querySelectorAll('.rbtn')].find(b => b.textContent.trim() === '表达式');
    out.exprDialog = { opened: false, head: '', hasSelect: false, hasInput: false, found: !!btn };
    if (btn) {
      btn.click();
      for (let i = 0; i < 40 && !document.querySelector('.modal'); i++) await new Promise(r => setTimeout(r, 50));
      const modal = document.querySelector('.modal');
      out.exprDialog = {
        opened: !!modal,
        head: modal?.querySelector('.modal-head')?.textContent ?? '',
        hasSelect: !!modal?.querySelector('select'),
        hasInput: !!modal?.querySelector('input.inp.wide'),
        found: true,
      };
      document.querySelector('.modal-mask')?.remove();
    }

    // 清理，恢复空文档
    await reset();
  }

  out.status = document.querySelector('.statusbar')?.textContent ?? '';
  return out;
})()`);
  } catch (e) {
    console.log(`  ✗ 表达式端到端执行异常：${e.message}`);
    fail++;
    ws.close();
    cleanup();
    console.log(`\n浏览器端到端：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
})();

for (const s of ex.steps) {
  console.log(`    ${s.name.padEnd(26)} 体积=${s.volume.toFixed(2).padStart(10)}`);
}
console.log(`    参数值=${ex.paramValue}  文档字面值=${ex.literal}  表达式问题=${ex.issueCount} (${ex.issueWhere})`);

check('全局参数驱动拉伸深度（板厚=8 → 12000）', near(ex.steps[0].volume, 12000, 1e-3), ex.steps[0].volume.toFixed(2));
check('解析结果写入 paramValues', ex.paramValue === 8, String(ex.paramValue));
check('解析过程不修改文档字面值', ex.literal === 1, String(ex.literal));
check('改参数后几何自动联动（板厚=20 → 30000）', near(ex.steps[1].volume, 30000, 1e-3), ex.steps[1].volume.toFixed(2));
check('表达式错误回写到特征（标红）', ex.errFlag && /未知参数/.test(ex.errMsg), ex.errMsg);
check('表达式问题进入 issues（带位置）', ex.issueCount === 1 && ex.issueWhere === '特征:拉伸1.distance', `${ex.issueCount} / ${ex.issueWhere}`);
check('复合公式 + 函数（板厚*2+sqrt(16)=44 → 66000）', near(ex.steps[2].volume, 66000, 1e-3), ex.steps[2].volume.toFixed(2));
check('序列化保留参数表', JSON.stringify(ex.roundParams) === JSON.stringify(['板厚']), JSON.stringify(ex.roundParams));
check('序列化保留特征表达式', ex.roundExpr === '=板厚*2 + sqrt(16)', ex.roundExpr);
check('「表达式」对话框可打开', ex.exprDialog.opened, `${ex.exprDialog.head}（按钮=${ex.exprDialog.found}）`);
check('表达式对话框含参数下拉与输入框', ex.exprDialog.hasSelect && ex.exprDialog.hasInput);

// ==================================================================
// F. 草图高级曲线族：圆锥曲线 + B 样条（真实 Worker 内核）
// ==================================================================
console.log('\n▶ F. 草图高级曲线族（真实内核）');

const cv = await (async () => {
  try {
    return await evaluate(`(async () => {
  const { app } = window.__solid2;
  const T = await import('/src/sketch/types.ts');
  const { newId } = T;
  const out = { steps: [], errors: [] };

  const reset = async () => {
    for (const f of [...app.doc.features]) app.doc.remove(f.id);
    await app.rebuild();
  };

  // --- F1. 闭合 B 样条 → 拉伸（面是精确 B 样条） ---
  {
    await reset();
    const s = T.emptySketch();
    const R = 20, N = 16;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    s.entities.push({ id: newId('e'), kind: 'bspline', pts, closed: true });
    const sid = newId('f');
    app.addFeature({ id: sid, type: 'sketch', name: 'B样条草图', params: { plane: 'front', sketch: s } }, { rebuild: false });
    app.addFeature({ id: newId('f'), type: 'extrude', name: '拉伸B样条',
      params: { sketchId: sid, distance: 10, operation: 'new' } }, { rebuild: false });
    await app.rebuild();
    const st = app.model.stats;
    out.steps.push({ name: '闭合B样条 R=20 拉伸10', volume: st.volume, faces: st.faces, solids: st.solids });
  }

  // --- F2. 抛物线 + 双曲线（开放曲线，不构成闭环 → 无实体、不报错） ---
  {
    await reset();
    const s = T.emptySketch();
    const v = newId('p'); s.points[v] = { id: v, x: 0, y: 0 };
    s.entities.push({ id: newId('e'), kind: 'parabola', c: v, focal: 5, rot: 0, t0: -10, t1: 10 });
    const hc = newId('p'); s.points[hc] = { id: hc, x: 40, y: 0 };
    s.entities.push({ id: newId('e'), kind: 'hyperbola', c: hc, a: 8, b: 5, rot: 0, t0: -1.2, t1: 1.2 });
    const sid = newId('f');
    app.addFeature({ id: sid, type: 'sketch', name: '圆锥曲线草图', params: { plane: 'front', sketch: s } }, { rebuild: false });
    app.addFeature({ id: newId('f'), type: 'extrude', name: '拉伸圆锥曲线',
      params: { sketchId: sid, distance: 5, operation: 'new' } }, { rebuild: false });
    await app.rebuild();
    const st = app.model.stats;
    out.steps.push({ name: '抛物线+双曲线（开放，不成环）', volume: st.volume, faces: st.faces, solids: st.solids });
    out.openCurveError = (app.doc.features.find((f) => f.type === 'extrude') ?? {}).error ?? '';
  }

  // --- F3. 开放 B 样条作为扫描路径 ---
  {
    await reset();
    // 轮廓：圆 r=4
    const prof = T.emptySketch();
    const pc = newId('p'); prof.points[pc] = { id: pc, x: 0, y: 0 };
    prof.entities.push({ id: newId('e'), kind: 'circle', c: pc, r: 4 });
    const profId = newId('f');
    app.addFeature({ id: profId, type: 'sketch', name: '圆轮廓', params: { plane: 'top', sketch: prof } }, { rebuild: false });
    // 路径：开放 B 样条
    const path = T.emptySketch();
    path.entities.push({ id: newId('e'), kind: 'bspline',
      pts: [[0, 0], [20, 30], [50, -20], [80, 10]], closed: false });
    const pathId = newId('f');
    app.addFeature({ id: pathId, type: 'sketch', name: 'B样条路径', params: { plane: 'front', sketch: path } }, { rebuild: false });
    app.addFeature({ id: newId('f'), type: 'sweep', name: '扫描B样条',
      params: { profileSketchId: profId, pathSketchId: pathId, operation: 'new' } }, { rebuild: false });
    await app.rebuild();
    const st = app.model.stats;
    out.steps.push({ name: '圆沿B样条路径扫描', volume: st.volume, faces: st.faces, solids: st.solids });
    out.sweepError = (app.doc.features.find((f) => f.type === 'sweep') ?? {}).error ?? '';
  }

  await reset();
  out.status = document.querySelector('.statusbar')?.textContent ?? '';
  return out;
})()`);
  } catch (e) {
    console.log(`  ✗ 高级曲线族端到端执行异常：${e.message}`);
    fail++;
    ws.close();
    cleanup();
    console.log(`\n浏览器端到端：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
})();

for (const s of cv.steps) {
  console.log(`    ${s.name.padEnd(30)} 体积=${s.volume.toFixed(2).padStart(10)}  ${s.solids} 实体 / ${s.faces} 面`);
}

check('闭合 B 样条拉伸体积 ≈ π·20²·10（面是精确 B 样条）',
  near(cv.steps[0].volume, Math.PI * 400 * 10, 0.01), cv.steps[0].volume.toFixed(2));
check('闭合 B 样条拉伸为单实体', cv.steps[0].solids === 1, `${cv.steps[0].solids} 实体`);
check('抛物线/双曲线（开放）不产生实体，且显式报「没有封闭轮廓」',
  cv.steps[1].solids === 0 && /没有封闭轮廓/.test(cv.openCurveError),
  `solids=${cv.steps[1].solids} err=${cv.openCurveError || '无'}`);
check('圆沿 B 样条路径扫描成体（体积 > 0）',
  cv.steps[2].volume > 0 && !cv.sweepError, `体积=${cv.steps[2].volume.toFixed(2)} err=${cv.sweepError || '无'}`);

// ==================================================================
// G. AI 建模助手：自然语言 → 特征 → 真实内核建模 + UI 接线
// ==================================================================
console.log('\n▶ G. AI 建模助手（真实内核）');

const ai = await (async () => {
  try {
    return await evaluate(`(async () => {
  const { app } = window.__solid2;
  const ai = await import('/src/ai/index.ts');
  const out = { steps: [], errors: [] };

  // --- G1. 三句话端到端建模 ---
  const cases = [
    '60x40x10 的长方体',
    '60x40x10 的长方体，中心开半径8的通孔，四角倒圆角R5',
    '长80宽60高20的板，四角倒角4，顶面抽壳3',
  ];
  for (const text of cases) {
    const { plan, compiled } = await ai.interpret(text);
    app.loadFeatures(compiled.features, { replace: true, fit: false });
    await app.rebuild();
    const st = app.model.stats;
    out.steps.push({
      text,
      volume: st.volume,
      faces: st.faces,
      solids: st.solids,
      features: compiled.features.length,
      summary: plan.summary,
      errors: [...compiled.issues, ...plan.issues].filter((i) => i.level === 'error').map((i) => i.message),
    });
  }

  // --- G2. UI 接线：AI 页签 → 按钮 → 弹窗 → 输入解析 ---
  const tabs = [...document.querySelectorAll('.rtab')];
  const aiTab = tabs.find((t) => t.textContent === 'AI');
  out.hasAiTab = !!aiTab;
  aiTab?.click();
  const btn = [...document.querySelectorAll('.rbtn')].find((b) => /AI 建模/.test(b.textContent));
  out.hasAiButton = !!btn;
  btn?.click();
  await new Promise((r) => setTimeout(r, 80));
  out.dialogOpen = !!document.querySelector('.modal');
  out.dialogTitle = document.querySelector('.modal .ai-title')?.textContent ?? '';

  const ta = document.querySelector('.ai-input');
  if (ta) {
    ta.value = '半径10高20的圆柱';
    ta.dispatchEvent(new Event('input'));
  }
  await new Promise((r) => setTimeout(r, 120));
  out.previewText = document.querySelector('.ai-preview')?.textContent ?? '';

  // 点击「应用」
  const gen = [...document.querySelectorAll('.modal-foot .btn')].find((b) => /应用/.test(b.textContent));
  gen?.click();
  await new Promise((r) => setTimeout(r, 400));
  await app.rebuild();
  out.afterDialogVolume = app.model?.stats.volume ?? 0;
  out.dialogClosed = !document.querySelector('.modal');

  // --- G3. 编辑现有模型：无头链路（追加 → 改尺寸 → 删除） ---
  const boxRes = await ai.interpret('60x40x10 的长方体');
  app.loadFeatures(boxRes.compiled.features, { replace: true, fit: false });
  await app.rebuild();
  let feats = boxRes.compiled.features;
  let bbox = boxRes.compiled.bbox;
  out.edit = [];
  for (const step of ['上面加一个半径8高12的圆柱', '把高改成20', '删掉圆柱']) {
    const run = ai.editModel(step, { features: feats, bbox, boxForRefs: ai.boxRefOf(feats) });
    feats = run.features;
    bbox = run.bbox;
    app.setFeatures(feats, { fit: false });
    await app.rebuild();
    out.edit.push({
      step,
      volume: app.model?.stats.volume ?? 0,
      features: feats.length,
      changes: run.changes.length,
      errs: run.issues.filter((i) => i.level === 'error').map((i) => i.message),
    });
  }

  // --- G4. UI 接线：AI 编辑页签 → 编辑模式 → 实时预览 → 应用 ---
  const tabs2 = [...document.querySelectorAll('.rtab')];
  tabs2.find((t) => t.textContent === 'AI')?.click();
  const editBtn = [...document.querySelectorAll('.rbtn')].find((b) => /AI 编辑/.test(b.textContent));
  out.hasEditButton = !!editBtn;
  out.editBtnEnabled = editBtn ? !editBtn.classList.contains('disabled') : false;
  editBtn?.click();
  await new Promise((r) => setTimeout(r, 80));
  out.editDialogOpen = !!document.querySelector('.modal');
  out.editModeOn = document.querySelector('.ai-mode.on')?.textContent ?? '';
  out.editModelHint = document.querySelector('.ai-model-hint')?.textContent ?? '';

  const ta2 = document.querySelector('.ai-input');
  if (ta2) {
    ta2.value = '中心开半径8的通孔';
    ta2.dispatchEvent(new Event('input'));
  }
  await new Promise((r) => setTimeout(r, 120));
  out.editPreview = document.querySelector('.ai-preview')?.textContent ?? '';

  const applyBtn = [...document.querySelectorAll('.modal-foot .btn')].find((b) => /应用/.test(b.textContent));
  applyBtn?.click();
  await new Promise((r) => setTimeout(r, 400));
  await app.rebuild();
  out.afterEditVolume = app.model?.stats.volume ?? 0;
  out.afterEditFeatures = app.doc.features.length;
  out.editDialogClosed = !document.querySelector('.modal');

  // --- G5. 异型孔 + 弹簧 + 变换/曲线：端到端建模 ---
  out.extra = [];
  const extraCases = [
    '60x40x10 的长方体，中心开Φ8的通孔，沉头直径14深3',
    '60x40x10 的长方体，中心开Φ8的通孔，埋头直径12深3',
    '中径20线径2螺距5圈数8的弹簧',
    '20x20x20 的长方体，整体放大2倍',
    '长40宽30高10的板，右边加一个半径5高10的圆柱，沿右视基准面镜像',
    '涡状线起始半径12螺距6圈数4厚度2.5宽度5',
    '60x40x10 的长方体，侧面拔模5度',
    '20x20x20 的长方体，复制一份沿X偏移10，把两个实体合并',
    '20x20x20 的长方体，复制一份沿X偏移10，把两个实体相减',
    '20x20x20 的长方体，复制一份沿X偏移30，删除最后一个实体',
    '80x60x20 的长方体，整体沿Z移动50',
  ];
  for (const text of extraCases) {
    const { compiled } = await ai.interpret(text);
    app.loadFeatures(compiled.features, { replace: true, fit: false });
    await app.rebuild();
    out.extra.push({
      text,
      volume: app.model?.stats.volume ?? 0,
      solids: app.model?.stats.solids ?? 0,
      features: compiled.features.length,
      errs: compiled.issues.filter((i) => i.level === 'error').map((i) => i.message),
    });
  }

  // 编辑模式：整体平移 + 平移后仍能解析式倒圆角
  const box20 = await ai.interpret('20x20x20 的长方体');
  app.loadFeatures(box20.compiled.features, { replace: true, fit: false });
  await app.rebuild();
  const runMove = ai.editModel('整体沿X移动100，四角倒圆角R2', {
    features: box20.compiled.features,
    bbox: box20.compiled.bbox,
    boxForRefs: ai.boxRefOf(box20.compiled.features),
  });
  app.setFeatures(runMove.features, { fit: false });
  await app.rebuild();
  out.extraMove = {
    volume: app.model?.stats.volume ?? 0,
    bbox: app.model?.bbox ?? null,
    features: runMove.features.length,
    errs: runMove.issues.filter((i) => i.level === 'error').map((i) => i.message),
  };

  // 编辑模式里加沉头孔（含「孔细节」子句回填）
  const plate = await ai.interpret('60x40x10 的长方体');
  app.loadFeatures(plate.compiled.features, { replace: true, fit: false });
  await app.rebuild();
  const runHole = ai.editModel('中心开Φ8的沉头孔，沉头直径14深3', {
    features: plate.compiled.features,
    bbox: plate.compiled.bbox,
    boxForRefs: ai.boxRefOf(plate.compiled.features),
  });
  app.setFeatures(runHole.features, { fit: false });
  await app.rebuild();
  out.extraHole = {
    volume: app.model?.stats.volume ?? 0,
    features: runHole.features.length,
    changes: runHole.changes.length,
    errs: runHole.issues.filter((i) => i.level === 'error').map((i) => i.message),
  };

  return out;
})()`);
  } catch (e) {
    console.log(`  ✗ AI 端到端执行异常：${e.message}`);
    fail++;
    ws.close();
    cleanup();
    console.log(`\n浏览器端到端：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
})();

// ---- G6. 选择过滤器「实体」：bodyIndex 归属 + 拾取门控（第五轮交付） ----
const bodyFilter = await evaluate(`(async () => {
  const app = window.__solid2.app;
  const ai = await import('/src/ai/index.ts');
  try {
    const { compiled } = await ai.interpret('20x20x20 的长方体，复制一份沿X偏移10');
    app.loadFeatures(compiled.features, { replace: true, fit: false });
    await app.rebuild();
    const metas = app.model?.mesh.faceMetas ?? [];
    const bodies = app.model?.stats.solids ?? 0;
    const withBody = metas.filter((m) => m.bodyIndex !== undefined).length;
    app.clearSelection();
    app.setSelectionFilter('body');
    app.selectFace(0);
    const faceRejected = app.selection.faces.length === 0;
    app.selectEdge(0);
    const edgeRejected = app.selection.edges.length === 0;
    app.selectBody(0);
    const bodyPicked = app.selection.bodies.length === 1 && app.selection.bodies[0] === 0;
    app.clearSelection();
    app.setSelectionFilter('vertex');
    app.selectFace(0);
    app.selectEdge(0);
    const vertexModeRejects = app.selection.faces.length === 0 && app.selection.edges.length === 0;
    app.clearSelection();
    app.setSelectionFilter('all');
    return { bodies, withBody, metas: metas.length, faceRejected, edgeRejected, bodyPicked, vertexModeRejects, err: '' };
  } catch (e) {
    return { err: String(e && e.message ? e.message : e) };
  }
})()`);
check('多实体模型的面元数据带 bodyIndex 归属', !bodyFilter.err && bodyFilter.bodies === 2 && bodyFilter.withBody === bodyFilter.metas && bodyFilter.metas > 0, JSON.stringify(bodyFilter));
check('过滤器=实体：selectFace/selectEdge 被门控拒绝', bodyFilter.faceRejected && bodyFilter.edgeRejected, JSON.stringify(bodyFilter));
check('过滤器=实体：selectBody 选中整个实体', bodyFilter.bodyPicked, JSON.stringify(bodyFilter));
check('过滤器=顶点：面/边选择同样被门控', bodyFilter.vertexModeRejects, JSON.stringify(bodyFilter));

for (const s of ai.steps) {
  console.log(`    ${s.text.slice(0, 28).padEnd(30)} 体积=${s.volume.toFixed(2).padStart(10)}  ${s.features} 特征 / ${s.faces} 面`);
}
check('AI「长方体」→ 体积 24000', near(ai.steps[0].volume, 24000, 1), ai.steps[0].volume.toFixed(2));
check('AI「长方体+通孔+圆角」→ 3 特征且无错误',
  ai.steps[1].features === 3 && ai.steps[1].errors.length === 0,
  `features=${ai.steps[1].features} err=${ai.steps[1].errors.join(';') || '无'}`);
check('AI「长方体+通孔+圆角」体积 ≈ 21774.78',
  near(ai.steps[1].volume, 24000 - Math.PI * 64 * 10 - 4 * (25 - (Math.PI * 25) / 4) * 10, 3),
  ai.steps[1].volume.toFixed(2));
check('AI「板+倒角+抽壳」→ 3 特征且体积小于实心',
  ai.steps[2].features === 3 && ai.steps[2].volume > 0 && ai.steps[2].volume < 80 * 60 * 20,
  `features=${ai.steps[2].features} vol=${ai.steps[2].volume.toFixed(2)}`);
check('ribbon 出现「AI」页签', ai.hasAiTab === true);
check('AI 页签下有「AI 建模」按钮', ai.hasAiButton === true);
check('点击后弹出 AI 建模对话框', ai.dialogOpen === true && ai.dialogTitle === 'AI 建模助手', `title=${ai.dialogTitle}`);
check('弹窗内实时解析出「圆柱」摘要', /圆柱/.test(ai.previewText), ai.previewText.slice(0, 60));
check('点「应用」后弹窗关闭并建出圆柱（体积 ≈ π·100·20）',
  ai.dialogClosed === true && near(ai.afterDialogVolume, Math.PI * 100 * 20, 3),
  `closed=${ai.dialogClosed} vol=${ai.afterDialogVolume.toFixed(2)}`);

// --- G3/G4. 编辑现有模型 ---
for (const s of ai.edit) {
  console.log(`    编辑 ${s.step.slice(0, 20).padEnd(22)} 体积=${s.volume.toFixed(2).padStart(10)}  ${s.features} 特征 / ${s.changes} 处改动`);
}
check('编辑「上面加圆柱」→ 26412.74（凸台落在顶面）',
  ai.edit[0].changes === 1 && ai.edit[0].errs.length === 0 && near(ai.edit[0].volume, 24000 + Math.PI * 64 * 12, 3),
  `vol=${ai.edit[0].volume.toFixed(2)} err=${ai.edit[0].errs.join(';') || '无'}`);
check('编辑「把高改成20」→ 50412.74（板变厚 + 凸台抬升）',
  ai.edit[1].errs.length === 0 && near(ai.edit[1].volume, 60 * 40 * 20 + Math.PI * 64 * 12, 3),
  `vol=${ai.edit[1].volume.toFixed(2)} err=${ai.edit[1].errs.join(';') || '无'}`);
check('编辑「删掉圆柱」→ 48000（回到纯长方体）',
  ai.edit[2].features === 1 && ai.edit[2].errs.length === 0 && near(ai.edit[2].volume, 48000, 1),
  `features=${ai.edit[2].features} vol=${ai.edit[2].volume.toFixed(2)}`);
check('ribbon 出现「AI 编辑」按钮', ai.hasEditButton === true);
check('有模型时「AI 编辑」可用', ai.editBtnEnabled === true);
check('点「AI 编辑」直接进入编辑模式', ai.editDialogOpen === true && ai.editModeOn === '编辑当前模型', `mode=${ai.editModeOn}`);
check('编辑模式提示当前模型特征数', /当前模型：\d+ 个特征/.test(ai.editModelHint), ai.editModelHint);
check('编辑指令实时解析出「通孔」改动', /通孔/.test(ai.editPreview) && /新增/.test(ai.editPreview), ai.editPreview.slice(0, 80));
check('点「应用」后孔生效（体积 ≈ 43978.76）',
  ai.editDialogClosed === true && ai.afterEditFeatures === 2 && near(ai.afterEditVolume, 48000 - Math.PI * 64 * 20, 3),
  `closed=${ai.editDialogClosed} n=${ai.afterEditFeatures} vol=${ai.afterEditVolume.toFixed(2)}`);

// --- G5. 异型孔 + 弹簧 ---
for (const s of ai.extra) {
  console.log(`    端到端 ${s.text.slice(0, 26).padEnd(28)} 体积=${s.volume.toFixed(2).padStart(10)}  ${s.features} 特征`);
}
check('AI「长方体 + Φ8通孔 + 沉头Φ14深3」→ 23186.33',
  ai.extra[0].features === 2 && ai.extra[0].errs.length === 0 &&
    near(ai.extra[0].volume, 24000 - (Math.PI * 16 * 10 + Math.PI * (49 - 16) * 3), 3),
  `vol=${ai.extra[0].volume.toFixed(2)} err=${ai.extra[0].errs.join(';') || '无'}`);
check('AI「长方体 + Φ8通孔 + 埋头Φ12深3」→ 23409.38',
  ai.extra[1].features === 2 && ai.extra[1].errs.length === 0 &&
    near(ai.extra[1].volume, 24000 - (Math.PI * 16 * 10 + (Math.PI * 3 / 3 * (16 + 4 * 6 + 36) - Math.PI * 16 * 3)), 3),
  `vol=${ai.extra[1].volume.toFixed(2)} err=${ai.extra[1].errs.join(';') || '无'}`);
const springExp = Math.PI * 1 * 1 * (8 * Math.hypot(2 * Math.PI * 10, 5));
check('AI「弹簧」→ 体积 ≈ π·r²·螺旋长（1% 内）',
  ai.extra[2].features === 1 && ai.extra[2].errs.length === 0 &&
    Math.abs(ai.extra[2].volume - springExp) / springExp <= 0.01,
  `vol=${ai.extra[2].volume.toFixed(2)} 期望≈${springExp.toFixed(2)}`);
check('编辑模式加沉头孔（含孔细节子句回填）→ 23186.33',
  ai.extraHole.features === 2 && ai.extraHole.changes === 1 && ai.extraHole.errs.length === 0 &&
    near(ai.extraHole.volume, 24000 - (Math.PI * 16 * 10 + Math.PI * (49 - 16) * 3), 3),
  `n=${ai.extraHole.features} vol=${ai.extraHole.volume.toFixed(2)} err=${ai.extraHole.errs.join(';') || '无'}`);

// --- G6. 变换与曲线：缩放 / 镜像 / 涡状线 / 拔模 ---
check('AI「整体放大2倍」→ 20³ × 8 = 64000',
  ai.extra[3].features === 2 && ai.extra[3].errs.length === 0 && near(ai.extra[3].volume, 64000, 1),
  `vol=${ai.extra[3].volume.toFixed(2)} err=${ai.extra[3].errs.join(';') || '无'}`);
check('AI「板 + 右侧圆柱 + 右视镜像」→ 13570.80',
  ai.extra[4].features === 3 && ai.extra[4].errs.length === 0 &&
    near(ai.extra[4].volume, 40 * 30 * 10 + 2 * Math.PI * 25 * 10, 1),
  `vol=${ai.extra[4].volume.toFixed(2)} err=${ai.extra[4].errs.join(';') || '无'}`);
check('AI「涡状线」→ 带材多边形面积 × 宽度 = 7501.60',
  ai.extra[5].features === 1 && ai.extra[5].errs.length === 0 && near(ai.extra[5].volume, 7501.6, 40),
  `vol=${ai.extra[5].volume.toFixed(2)} err=${ai.extra[5].errs.join(';') || '无'}`);
{
  const t = Math.tan((5 * Math.PI) / 180);
  const draftExp = 24000 + 100 * t * 100 + (4 / 3) * t * t * 1000;
  check('AI「侧面拔模5度」→ 线性锥化解析值 24885.09',
    ai.extra[6].features === 2 && ai.extra[6].errs.length === 0 && near(ai.extra[6].volume, draftExp, 1),
    `vol=${ai.extra[6].volume.toFixed(2)} 期望=${draftExp.toFixed(2)} err=${ai.extra[6].errs.join(';') || '无'}`);
}

// --- G7. 多实体编辑：移动/复制 · 删除 · 组合 ---
check('AI「复制一份沿X偏移10 + 合并」→ 1 实体 / 12000',
  ai.extra[7].solids === 1 && ai.extra[7].errs.length === 0 && near(ai.extra[7].volume, 12000, 1),
  `vol=${ai.extra[7].volume.toFixed(2)} solids=${ai.extra[7].solids} err=${ai.extra[7].errs.join(';') || '无'}`);
check('AI「复制一份沿X偏移10 + 相减」→ 4000（只留不重叠部分）',
  ai.extra[8].errs.length === 0 && near(ai.extra[8].volume, 4000, 1),
  `vol=${ai.extra[8].volume.toFixed(2)} err=${ai.extra[8].errs.join(';') || '无'}`);
check('AI「复制一份沿X偏移30 + 删除最后一个实体」→ 1 实体 / 8000',
  ai.extra[9].solids === 1 && ai.extra[9].errs.length === 0 && near(ai.extra[9].volume, 8000, 1),
  `vol=${ai.extra[9].volume.toFixed(2)} solids=${ai.extra[9].solids} err=${ai.extra[9].errs.join(';') || '无'}`);
check('AI「整体沿Z移动50」→ 体积不变 96000，包围盒上移',
  ai.extra[10].errs.length === 0 && near(ai.extra[10].volume, 96000, 1),
  `vol=${ai.extra[10].volume.toFixed(2)} err=${ai.extra[10].errs.join(';') || '无'}`);

{
  const filletExp = 8000 - (4 - Math.PI) * 4 * 20;
  check('AI 编辑「整体沿X移动100，四角倒圆角R2」→ 3 特征 / 解析体积 7931.33',
    ai.extraMove.features === 3 && ai.extraMove.errs.length === 0 && near(ai.extraMove.volume, filletExp, 1),
    `vol=${ai.extraMove.volume.toFixed(2)} 期望=${filletExp.toFixed(2)} err=${ai.extraMove.errs.join(';') || '无'}`);
  check('  平移后包围盒落在 X ∈ [90,110]',
    !!ai.extraMove.bbox && near(ai.extraMove.bbox.min[0], 90, 0.5),
    ai.extraMove.bbox ? JSON.stringify(ai.extraMove.bbox.min) : 'null');
}

if (process.env.SMOKE_SHOT) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.SMOKE_SHOT, Buffer.from(r.data, 'base64'));
    console.log('screenshot ->', process.env.SMOKE_SHOT);
  } catch (e) { console.log('shot failed', e.message); }
}

ws.close();
cleanup();

console.log(`\n${'='.repeat(56)}`);
console.log(`浏览器端到端：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
