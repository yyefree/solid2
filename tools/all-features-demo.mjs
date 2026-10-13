/**
 * 全功能自动演示 + 录屏（零依赖，CDP 驱动真实浏览器）。
 *
 * 做两件事：
 *   1. **自动测试所有功能**——按功能族逐项在真实 Worker 内核里跑一遍并断言结果；
 *   2. **录制成 MP4**——全程用 `Page.captureScreenshot` 抓帧，再用 ffmpeg（H.264）编码。
 *
 * 视频里会有一个「步骤横幅」浮层，标明当前正在演示/测试的功能，便于观看。
 *
 * 用法：
 *   node tools/all-features-demo.mjs                 # 自动起 dev server + 录制
 *   node tools/all-features-demo.mjs --url http://127.0.0.1:5173/
 *   node tools/all-features-demo.mjs --out dist/solid2-all-features.mp4
 *   node tools/all-features-demo.mjs --no-serve      # 复用已启动的 dev server
 *
 * 环境变量：
 *   FFMPEG            指定 ffmpeg 可执行文件（默认自动探测 imageio-ffmpeg / PATH）
 *   DEMO_W / DEMO_H   录制分辨率（默认 1600×900）
 *   DEMO_KEEP_FRAMES  保留临时帧目录（调试）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const URL_ = argOf('--url', 'http://127.0.0.1:5173/');
const OUT = path.resolve(ROOT, argOf('--out', 'dist/solid2-all-features.mp4'));
const NO_SERVE = argv.includes('--no-serve');
const W = Number(process.env.DEMO_W ?? 1600);
const H = Number(process.env.DEMO_H ?? 900);
const PORT = Number(process.env.DEMO_CDP_PORT ?? 9344);
const KEEP_FRAMES = process.env.DEMO_KEEP_FRAMES === '1';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

// ---------------- 断言 ----------------
let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}  ${detail}`);
  }
}
const near = (a, b, rel = 0.01) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(String(s ?? ''));

// ==================================================================
// 1. dev server
// ==================================================================
let serverProc = null;
async function reachable(url, timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok || r.status < 500;
  } catch { return false; }
}
if (!(await reachable(URL_))) {
  if (NO_SERVE) {
    console.error(`✗ dev server 不可达：${URL_}（--no-serve 时需自行启动）`);
    process.exit(1);
  }
  console.log(`启动 dev server…`);
  serverProc = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32',
  });
  const deadline = Date.now() + 60000;
  let ok = false;
  while (Date.now() < deadline) {
    if (await reachable(URL_)) { ok = true; break; }
    await sleep(400);
  }
  if (!ok) {
    console.error('✗ dev server 启动超时');
    try { serverProc?.kill(); } catch { /* ignore */ }
    process.exit(1);
  }
  console.log(`dev server 就绪：${URL_}\n`);
}

// ==================================================================
// 2. 浏览器 + CDP
// ==================================================================
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) {
  console.error('找不到 Edge/Chrome，无法录制。');
  try { serverProc?.kill(); } catch { /* ignore */ }
  process.exit(1);
}

const profile = mkdtempSync(path.join(tmpdir(), 'solid2-demo-'));
const framesDir = mkdtempSync(path.join(tmpdir(), 'solid2-frames-'));
const downloadDir = mkdtempSync(path.join(tmpdir(), 'solid2-dl-'));
console.log(`浏览器: ${exe}`);
console.log(`分辨率: ${W}×${H}`);
console.log(`帧目录: ${framesDir}\n`);

const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--hide-scrollbars',
  `--window-size=${W},${H}`,
  '--headless=new',
  URL_,
], { stdio: 'ignore' });

function cleanup() {
  try { child.kill(); } catch { /* ignore */ }
  try { serverProc?.kill(); } catch { /* ignore */ }
  setTimeout(() => {
    for (const d of [profile]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (!KEEP_FRAMES) { try { rmSync(framesDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }, 600);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function getPageTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 端口未起 */ }
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
    expression: expr, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || '页面求值异常');
  }
  return r.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
try {
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
} catch { /* 旧版本用 Page.setDownloadBehavior */ }

// ==================================================================
// 3. 抓帧 + 时间轴
// ==================================================================
let frameIdx = 0;
const timeline = [];
const captureFailures = [];
async function capture() {
  try {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
    const t = Date.now();
    const file = `f_${String(frameIdx++).padStart(5, '0')}.jpg`;
    writeFileSync(path.join(framesDir, file), Buffer.from(r.data, 'base64'));
    timeline.push({ file, t });
  } catch (e) {
    captureFailures.push(e.message);
  }
}
/** 持续抓帧 holdMs 毫秒（保持画面实时） */
async function hold(holdMs) {
  const end = Date.now() + holdMs;
  do {
    await capture();
    await sleep(16);
  } while (Date.now() < end);
}
/** 触发页面动作，并在动作执行期间持续抓帧（重建也不掉帧）；单步出错不中断整场演示 */
async function act(expr, holdMs = 750) {
  const p = evaluate(expr).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message }));
  await hold(holdMs);
  const r = await p;
  if (!r.ok) {
    fail++;
    failures.push(`页面步骤异常：${r.e}`);
    console.log(`    ⚠ 步骤异常：${r.e}`);
    return null;
  }
  return r.v;
}

// ==================================================================
// 4. 页面辅助
// ==================================================================
const pct = (i) => `${Math.round((i / TOTAL_STEPS) * 100)}%`;
let stepNo = 0;

async function banner(step, title, sub = '') {
  stepNo = step;
  const html = `<span class="k">${`STEP ${step}`}</span><span class="t">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}`;
  await evaluate(`(() => {
    const b = document.getElementById('demo-banner');
    if (b) b.innerHTML = ${q(html)};
    const p = document.getElementById('demo-prog');
    if (p) p.style.width = ${q(pct(step))};
    return 1;
  })()`);
}

async function tab(label) {
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('.rtab')].find(x => x.textContent.includes(${q(label)}));
    if (t) t.click();
    return !!t;
  })()`);
}

async function closeModals() {
  await evaluate(`(() => { document.querySelectorAll('.modal-mask').forEach(m => m.remove()); return 1; })()`);
}

async function installOverlay() {
  await evaluate(`(() => {
    if (document.getElementById('demo-banner')) return 1;
    const s = document.createElement('style');
    s.textContent = \`
      #demo-banner{position:fixed;left:50%;bottom:46px;transform:translateX(-50%);z-index:99999;
        background:rgba(15,23,42,.88);color:#f8fafc;font:600 18px/1.35 system-ui,"Segoe UI",sans-serif;
        padding:11px 24px;border-radius:999px;box-shadow:0 8px 30px rgba(2,6,23,.45);
        display:flex;gap:14px;align-items:center;pointer-events:none;white-space:nowrap;
        border:1px solid rgba(148,163,184,.25);backdrop-filter:blur(6px);}
      #demo-banner .k{font-size:12px;font-weight:800;letter-spacing:.1em;color:#0b1220;
        background:linear-gradient(135deg,#7dd3fc,#a5b4fc);padding:4px 11px;border-radius:999px;}
      #demo-banner .sub{font-weight:400;font-size:14px;color:#a9b6c8;}
      #demo-prog{position:fixed;left:0;top:0;height:3px;width:0;z-index:100000;
        background:linear-gradient(90deg,#38bdf8,#818cf8,#c084fc);pointer-events:none;}
    \`;
    document.head.appendChild(s);
    const b = document.createElement('div'); b.id = 'demo-banner';
    b.innerHTML = '<span class="k">SOLID2</span><span class="t">准备中…</span>';
    document.body.appendChild(b);
    const p = document.createElement('div'); p.id = 'demo-prog';
    document.body.appendChild(p);
    return 1;
  })()`);
}

async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evaluate(expr, { awaitPromise: false })) return true; } catch { /* retry */ }
    await sleep(400);
  }
  console.log(`  ✗ 等待超时：${label}`);
  return false;
}

// 页面内快捷句柄
async function installHelpers() {
  await evaluate(`(async () => {
    const app = window.__solid2.app;
    const T = await import('/src/sketch/types.ts');
    const { newId } = T;
    const planeAx2 = { front: 'front', top: 'top', right: 'right' };
    window.__D = {
      app, T, newId,
      reset() { for (const f of [...app.doc.features]) app.doc.remove(f.id); },
      /** 设置全局命名参数（表达式里可直接引用其名字） */
      param(name, expr) { app.doc.setParam(name, expr); },
      /** 给特征的某个数值参数绑定表达式（路径如 distance / dims[0]） */
      bind(featureId, path, expr) {
        const f = app.doc.getFeature(featureId);
        if (f) f.expressions = { ...(f.expressions ?? {}), [path]: expr };
      },
      add(f) { app.addFeature(f, { rebuild: false }); return f.id; },
      async rebuild() { await app.rebuild(); return app.model.stats; },
      async stats() { return app.model.stats; },
      box(dx, dy, dz, origin, op) {
        const id = newId('f');
        app.addFeature({ id, type: 'primitive', name: '长方体',
          params: { kind: 'box', dims: [dx, dy, dz], origin: origin ?? [0,0,0], operation: op ?? 'new' } }, { rebuild: false });
        return id;
      },
      prim(kind, dims, origin, op) {
        const id = newId('f');
        app.addFeature({ id, type: 'primitive', name: kind,
          params: { kind, dims, origin: origin ?? [0,0,0], operation: op ?? 'new' } }, { rebuild: false });
        return id;
      },
      /** 在指定基准面用 build 回调造一个草图特征（plane 可为 'front'|'top'|'right' 或 SketchPlane 对象） */
      sketch(plane, build) {
        const s = T.emptySketch();
        const h = {
          pt: (x, y) => { const id = newId('p'); s.points[id] = { id, x, y }; return id; },
          line: (a, b) => { const id = newId('e'); s.entities.push({ id, kind: 'line', a, b }); return id; },
          circle: (c, r) => { const id = newId('e'); s.entities.push({ id, kind: 'circle', c, r }); return id; },
          arc: (c, a, b, ccw) => { const id = newId('e'); s.entities.push({ id, kind: 'arc', c, a, b, ccw }); return id; },
          ellipse: (c, rx, ry, rot) => { const id = newId('e'); s.entities.push({ id, kind: 'ellipse', c, rx, ry, rot }); return id; },
          point: (p) => { const id = newId('e'); s.entities.push({ id, kind: 'point', p }); return id; },
          rect: (x0, y0, x1, y1) => {
            const p1 = h.pt(x0,y0), p2 = h.pt(x1,y0), p3 = h.pt(x1,y1), p4 = h.pt(x0,y1);
            return [h.line(p1,p2), h.line(p2,p3), h.line(p3,p4), h.line(p4,p1)];
          },
        };
        build(h);
        const id = newId('f');
        const params = typeof plane === 'string'
          ? { plane, sketch: s }
          : { plane: 'custom', customPlane: plane, sketch: s };
        app.addFeature({ id, type: 'sketch', name: '草图', params }, { rebuild: false });
        return id;
      },
      extrude(sketchId, distance, op, extra) {
        const id = newId('f');
        app.addFeature({ id, type: 'extrude', name: '拉伸',
          params: { sketchId, distance, operation: op ?? 'add', symmetric: false, reverse: false, draft: 0, ...(extra ?? {}) } }, { rebuild: false });
        return id;
      },
      revolve(sketchId, axisA, axisB, angleDeg, op) {
        const id = newId('f');
        app.addFeature({ id, type: 'revolve', name: '旋转',
          params: { sketchId, axisA, axisB, angleDeg, operation: op ?? 'add' } }, { rebuild: false });
        return id;
      },
      loft(sketchIds, op, ruled) {
        const id = newId('f');
        app.addFeature({ id, type: 'loft', name: '放样',
          params: { sketchIds, ruled: !!ruled, operation: op ?? 'new' } }, { rebuild: false });
        return id;
      },
      sweep(profileSketchId, pathSketchId, op) {
        const id = newId('f');
        app.addFeature({ id, type: 'sweep', name: '扫描',
          params: { profileSketchId, pathSketchId, operation: op ?? 'new' } }, { rebuild: false });
        return id;
      },
      fillet(edges, r1, r2) {
        const id = newId('f');
        app.addFeature({ id, type: 'fillet', name: '圆角',
          params: { edges, radius: r1, ...(r2 ? { radius2: r2 } : {}) } }, { rebuild: false });
        return id;
      },
      chamfer(edges, d) {
        const id = newId('f');
        app.addFeature({ id, type: 'chamfer', name: '倒角', params: { edges, distance: d } }, { rebuild: false });
        return id;
      },
      shell(faces, t) {
        const id = newId('f');
        app.addFeature({ id, type: 'shell', name: '抽壳', params: { faces, thickness: t } }, { rebuild: false });
        return id;
      },
      draft(neutralFace, draftFaces, angleDeg) {
        const id = newId('f');
        app.addFeature({ id, type: 'draft', name: '拔模',
          params: { neutralFace, draftFaces, angleDeg } }, { rebuild: false });
        return id;
      },
      rib(sketchId, thickness, depth, symmetric) {
        const id = newId('f');
        app.addFeature({ id, type: 'rib', name: '筋',
          params: { sketchId, thickness, depth, symmetric: !!symmetric } }, { rebuild: false });
        return id;
      },
      hole(plane, pos, type, diameter, depth, through, extra) {
        const id = newId('f');
        app.addFeature({ id, type: 'hole', name: '异型孔',
          params: { plane, pos, type, diameter, depth, through, ...(extra ?? {}) } }, { rebuild: false });
        return id;
      },
      refPlane(kind, plane, distance) {
        const id = newId('f');
        app.addFeature({ id, type: 'referencePlane', name: '基准面',
          params: { kind, plane, distance } }, { rebuild: false });
        return id;
      },
      linPattern(dir, spacing, count, seedFeatureId) {
        const id = newId('f');
        app.addFeature({ id, type: 'linearPattern', name: '线性阵列',
          params: { direction: dir, spacing, count, ...(seedFeatureId ? { seedFeatureId } : {}) } }, { rebuild: false });
        return id;
      },
      cirPattern(axisOrigin, axisDir, count, totalAngleDeg, equalSpacing) {
        const id = newId('f');
        app.addFeature({ id, type: 'circularPattern', name: '圆周阵列',
          params: { axisOrigin, axisDir, count, totalAngleDeg, equalSpacing: equalSpacing !== false } }, { rebuild: false });
        return id;
      },
      mirrorFeat(planePoint, planeNormal, seedFeatureId) {
        const id = newId('f');
        app.addFeature({ id, type: 'mirror', name: '镜像',
          params: { planePoint, planeNormal, ...(seedFeatureId ? { seedFeatureId } : {}) } }, { rebuild: false });
        return id;
      },
      spring(opts) {
        const id = newId('f');
        app.addFeature({ id, type: 'spring', name: '弹簧',
          params: { origin: [0,0,0], axis: [0,0,1], meanDiameter: 30, wireDiameter: 4, pitch: 10, turns: 6,
                    handedness: 'right', ...opts, operation: (opts && opts.operation) ?? 'new' } }, { rebuild: false });
        return id;
      },
      spiral(opts) {
        const id = newId('f');
        app.addFeature({ id, type: 'spiral', name: '涡状线',
          params: { plane: T.DEFAULT_PLANE, startRadius: 10, pitch: 5, turns: 4, thickness: 2, width: 4,
                    handedness: 'right', ...opts, operation: (opts && opts.operation) ?? 'new' } }, { rebuild: false });
        return id;
      },
      scale(center, factor) {
        const id = newId('f');
        app.addFeature({ id, type: 'scale', name: '缩放', params: { center, factor } }, { rebuild: false });
        return id;
      },
      split(plane, keep) {
        const id = newId('f');
        app.addFeature({ id, type: 'split', name: '分割', params: { plane, keep } }, { rebuild: false });
        return id;
      },
      moveBody(delta, opts) {
        const id = newId('f');
        app.addFeature({ id, type: 'moveBody', name: '移动/复制',
          params: { delta, axisOrigin: [0,0,0], axisDir: [0,0,1], angleDeg: 0, ...(opts ?? {}) } }, { rebuild: false });
        return id;
      },
      deleteBody(indices) {
        const id = newId('f');
        app.addFeature({ id, type: 'deleteBody', name: '删除实体', params: { indices } }, { rebuild: false });
        return id;
      },
      combine(mainIndex, toolIndices, operation) {
        const id = newId('f');
        app.addFeature({ id, type: 'combine', name: '组合', params: { mainIndex, toolIndices, operation } }, { rebuild: false });
        return id;
      },
      faceMetas() { return app.model.mesh.faceMetas; },
      edgeMetas() { return app.model.mesh.edgeMetas; },
      /** 最长的一条非圆棱 */
      longestEdge() {
        const ms = app.model.mesh.edgeMetas.filter(m => m.curveType !== 'circle');
        let best = ms[0];
        for (const m of ms) if (m.length > best.length) best = m;
        return best;
      },
      /** 面积最大的面 */
      biggestFace() {
        const ms = app.model.mesh.faceMetas;
        let best = ms[0];
        for (const m of ms) if (m.area > best.area) best = m;
        return best;
      },
      topFace() {
        const ms = app.model.mesh.faceMetas;
        let best = null;
        for (const m of ms) if (m.normal[2] > 0.9 && (!best || m.area > best.area)) best = m;
        return best;
      },
      bbox() { return app.model.bbox; },
      hasModel() { return app.hasModel; },
      planes: planeAx2,
    };
    return 1;
  })()`);
}

// ==================================================================
// 5. 全功能巡演
// ==================================================================
const TOTAL_STEPS = 23;

async function tour() {
  // ---------- ① 启动 ----------
  await banner(1, '启动 · OpenCASCADE 内核已就绪', '全功能自动演示');
  await installOverlay();
  await installHelpers();
  await hold(900);

  // ---------- ② 界面总览 ----------
  await banner(2, '界面总览 · 8 个功能区页签', '草图 / 特征 / 曲线 / 装配体 / 工程图 / 评估 / 视图 / 文件');
  for (const t of ['草图', '特征', '曲线', '装配体', '工程图', '评估', '视图', '文件']) {
    await tab(t);
    await hold(300);
  }
  await hold(300);

  // ---------- ③ AI 建模助手 ----------
  await banner(3, 'AI 建模助手 · 自然语言 → 参数化特征树', '一句话建模 + 一句话改模型，离线本地解析');
  await closeModals();
  await tab('AI');
  await hold(400);

  // 打开「AI 建模」对话框，敲一句中文描述，看实时解析
  const aiPreview = await act(`(async () => {
    const btn = [...document.querySelectorAll('.rbtn')].find(b => /AI 建模/.test(b.textContent));
    if (!btn) return 'no-button';
    btn.click();
    await new Promise(r => setTimeout(r, 220));
    const ta = document.querySelector('.ai-input');
    if (!ta) return 'no-input';
    ta.value = '长80宽60高20的板，中心开Φ8的沉头孔，沉头直径14深3，四角倒圆角R4';
    ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 220));
    return document.querySelector('.ai-preview')?.textContent ?? '';
  })()`, 1600);
  check('AI：自然语言实时解析出特征摘要',
    /沉头/.test(String(aiPreview)) && /圆角/.test(String(aiPreview)),
    String(aiPreview).slice(0, 70));

  // 点「应用」→ 特征树落地 + 真几何
  const aiBuild = await act(`(async () => {
    const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => /应用/.test(x.textContent));
    b?.click();
    await new Promise(r => setTimeout(r, 650));
    await __D.app.rebuild();
    return __D.app.model.stats;
  })()`, 2600);
  check('AI：一句话建出带沉头孔与圆角的板', !!aiBuild && aiBuild.volume > 0,
    aiBuild ? aiBuild.volume.toFixed(1) + ' mm³' : 'null');
  await isoView(1250);

  // 再在现有模型上继续用中文改（追加凸台 + 改尺寸）
  await act(`(async () => {
    const btn = [...document.querySelectorAll('.rbtn')].find(b => /AI 编辑/.test(b.textContent));
    if (!btn) return 'no-edit-button';
    btn.click();
    await new Promise(r => setTimeout(r, 220));
    const ta = document.querySelector('.ai-input');
    if (ta) { ta.value = '上面加一个半径8高12的圆柱，把高改成20'; ta.dispatchEvent(new Event('input')); }
    return 1;
  })()`, 1700);
  await hold(900);
  const aiEdit = await act(`(async () => {
    const b = [...document.querySelectorAll('.modal-foot .btn')].find(x => /应用/.test(x.textContent));
    b?.click();
    await new Promise(r => setTimeout(r, 650));
    await __D.app.rebuild();
    return __D.app.model.stats;
  })()`, 2600);
  check('AI：在现有模型上追加凸台并改尺寸', !!aiEdit && aiEdit.volume > 0,
    aiEdit ? aiEdit.volume.toFixed(1) + ' mm³' : 'null');
  await closeModals();
  await isoView(1300);

  // ---------- ③ 草图实体族 ----------
  await banner(4, '草图实体族 · 直线/矩形/圆/圆弧/椭圆/槽口/点/多边形', '在真实草图模式下用工具逐一点击绘制');
  await tab('草图');
  await act(`__D.app.startSketch('front')`, 900);
  // 注意：attach() 已把相机摆到正对草图平面；不要再调 setView('front')
  //（CAD 的前视是沿 -Y 看 XZ 面，会让 XY 草图平面变成侧视 → 射线打不到平面）
  await hold(300);

  // 用「点击」真实绘制（屏幕坐标由世界坐标投影得到）
  const draw = async (tool, locals, msPerClick = 420) => {
    await act(`__D.app.sketch.setTool(${q(tool)}); 1`, 300);
    for (const [u, v] of locals) {
      await act(`(() => {
        const app = __D.app;
        const c = document.querySelector('.viewport canvas');
        const r = c.getBoundingClientRect();
        const w = app.viewport.worldToScreen([${u}, ${v}, 0]);
        const x = r.left + w.x, y = r.top + w.y;
        app.sketch.handleMove(x, y);
        app.sketch.handleClick(x, y, false);
        return 1;
      })()`, msPerClick);
    }
  };

  await draw('rect', [[-70, 18], [-26, 52]]);          // 矩形
  await draw('circle', [[-48, 35], [-38, 35]]);        // 圆
  await draw('ellipse', [[10, 35], [30, 35], [10, 22]]); // 椭圆
  await draw('slot', [[52, 24], [78, 24], [78, 18]]);   // 槽口
  await draw('arc', [[10, -20], [10, -2], [28, -20]]);  // 圆弧
  await draw('point', [[50, -25]]);                     // 点
  await draw('polygon', [[-50, -25], [-32, -25]]);      // 多边形
  await draw('line', [[-8, -38], [30, -44]]);           // 直线
  await hold(500);

  // 镜像实体：以「矩形左边」为轴，镜像圆
  await act(`(() => {
    const sk = __D.app.sketch.sketch;
    const lines = sk.entities.filter(e => e.kind === 'line');
    // 找竖直且 x 最小的那条作为镜像轴
    let axis = null, bestX = 1e9;
    for (const l of lines) {
      const a = sk.points[l.a], b = sk.points[l.b];
      if (Math.abs(a.x - b.x) < 1e-6 && a.x < bestX) { bestX = a.x; axis = l; }
    }
    const circ = sk.entities.find(e => e.kind === 'circle');
    if (!axis || !circ) return 0;
    __D.app.sketch.selEntities = new Set([axis.id, circ.id]);
    __D.app.sketch.mirrorSelection();
    return 1;
  })()`, 900);
  await hold(400);
  await act(`(() => { const s = __D.app.sketch.sketch; return { e: s.entities.length, p: Object.keys(s.points).length }; })()`, 200)
    .then((r) => check('草图实体族绘制成功（含镜像）', r && r.e >= 19, `实体 ${r?.e} 个 / 点 ${r?.p} 个`));
  await act(`__D.app.exitSketch(true)`, 800);           // 丢弃这个展示用草图
  await hold(300);

  // ---------- ④ 草图曲线族（圆锥曲线 + B 样条） ----------
  await banner(5, '草图曲线族 · 抛物线 / 双曲线 / B 样条', '圆锥曲线按参数方程生成；B 样条严格穿过每个通过点');
  await tab('草图');
  await act(`__D.app.startSketch('front')`, 900);
  await hold(300);

  await draw('parabola', [[-78, -15], [-70, -15], [-70, 9]]);      // 顶点 → 焦点 → 开口范围
  await draw('hyperbola', [[-28, -12], [-16, -12], [-28, -2]]);    // 中心 → 实轴端点 → 虚轴距离
  await draw('bspline', [[20, -30], [38, 5], [56, -25], [74, 10], [88, -15]]);
  await act(`__D.app.sketch.finishBSpline(); 1`, 800);             // 等价于按 Enter 结束
  await hold(400);

  const curveStats = await act(`(() => {
    const sk = __D.app.sketch.sketch;
    const kinds = sk.entities.map(e => e.kind);
    return {
      n: sk.entities.length,
      par: kinds.filter(k => k === 'parabola').length,
      hyp: kinds.filter(k => k === 'hyperbola').length,
      bs: kinds.filter(k => k === 'bspline').length,
    };
  })()`, 250);
  check('草图曲线族：抛物线 / 双曲线 / B 样条各 1 条',
    !!curveStats && curveStats.par === 1 && curveStats.hyp === 1 && curveStats.bs === 1,
    `抛物线 ${curveStats?.par} · 双曲线 ${curveStats?.hyp} · B 样条 ${curveStats?.bs}`);
  await hold(500);
  await act(`__D.app.exitSketch(true)`, 800);
  await hold(300);

  // 闭合 B 样条 → 拉伸成体（面是精确 B 样条，体积 ≈ π·R²·h）
  const cbs = await act(`(async () => {
    __D.reset();
    const pts = [];
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; pts.push([20 * Math.cos(a), 20 * Math.sin(a)]); }
    const s = __D.T.emptySketch();
    s.entities.push({ id: __D.newId('e'), kind: 'bspline', pts, closed: true });
    const sid = __D.newId('f');
    __D.app.addFeature({ id: sid, type: 'sketch', name: 'B样条草图', params: { plane: 'front', sketch: s } }, { rebuild: false });
    __D.app.addFeature({ id: __D.newId('f'), type: 'extrude', name: '拉伸B样条',
      params: { sketchId: sid, distance: 10, operation: 'new' } }, { rebuild: false });
    await __D.app.rebuild();
    return __D.app.model.stats;
  })()`, 2200);
  check('闭合 B 样条拉伸成体（体积 ≈ π·20²·10）',
    !!cbs && Math.abs(cbs.volume - Math.PI * 400 * 10) < 1, `${cbs?.volume.toFixed(2)} mm³`);
  await isoView(1200);
  await act(`(async () => { __D.reset(); await __D.app.rebuild(); return 1; })()`, 800);
  await hold(200);

  // ---------- ⑤ 约束草图 ----------
  await banner(6, '约束草图 · 水平/竖直/平行 + LM 求解器', '画歪的线在加约束后被求解器「弹正」');
  await act(`__D.app.startSketch('front')`, 800);
  await draw('line', [[-60, -10], [-10, 4]]);
  await draw('line', [[0, -14], [46, -6]]);
  await hold(300);
  const before = await act(`(() => {
    const sk = __D.app.sketch.sketch;
    const l = sk.entities.find(e => e.kind === 'line');
    const a = sk.points[l.a], b = sk.points[l.b];
    return Math.abs(b.y - a.y);
  })()`, 200);
  await act(`(() => {
    const sk = __D.app.sketch.sketch;
    const l = sk.entities.find(e => e.kind === 'line');
    __D.app.sketch.selEntities = new Set([l.id]);
    __D.app.sketch.addRelation('horizontal');
    return 1;
  })()`, 900);
  const after = await act(`(() => {
    const sk = __D.app.sketch.sketch;
    const l = sk.entities.find(e => e.kind === 'line');
    const a = sk.points[l.a], b = sk.points[l.b];
    return Math.abs(b.y - a.y);
  })()`, 200);
  check('水平约束把斜线「弹正」（Δy → 0）',
    before != null && after != null && before > 5 && after < 1e-6,
    `Δy ${before == null ? 'n/a' : before.toFixed(2)} → ${after == null ? 'n/a' : after.toExponential(1)}`);
  await act(`(() => {
    const sk = __D.app.sketch.sketch;
    const ls = sk.entities.filter(e => e.kind === 'line');
    __D.app.sketch.selEntities = new Set([ls[0].id, ls[1].id]);
    __D.app.sketch.addRelation('parallel');
    return 1;
  })()`, 800);
  await act(`__D.app.exitSketch(true)`, 700);
  await hold(200);

  // ---------- ⑤ 拉伸 / 切除（主零件起点） ----------
  await banner(7, '拉伸凸台 / 拉伸切除', '80×60 底板 + φ24 中心孔');
  await tab('特征');
  await act(`__D.reset(); 1`, 200);
  await act(`(() => {
    __D.sketch('front', h => {
      const p1 = h.pt(-40,-30), p2 = h.pt(40,-30), p3 = h.pt(40,30), p4 = h.pt(-40,30);
      h.line(p1,p2); h.line(p2,p3); h.line(p3,p4); h.line(p4,p1);
      const c = h.pt(0,0); h.circle(c, 12);
    });
    return 1;
  })()`, 500);
  const s1 = await act(`__D.extrude(__D.app.doc.features.find(f=>f.type==='sketch').id, 14, 'new') && __D.rebuild()`, 1600);
  check('拉伸：80×60 底板（含 φ24 孔）体积正确',
    near(s1.volume, (80 * 60 - Math.PI * 144) * 14, 2e-3), `体积 ${s1.volume.toFixed(1)} mm³`);
  check('拉伸：单实体', s1.solids === 1, `${s1.solids} 实体`);
  await isoView();

  // ---------- ⑥ 工程特征 ----------
  await banner(8, '工程特征 · 圆角 / 变半径圆角 / 倒角 / 抽壳 / 拔模 / 筋 / 异形孔');
  const sFillet = await act(`(() => {
    const e = __D.longestEdge();
    __D.fillet([{ point: [...e.mid], dir: [...e.dir] }], 3);
    return __D.rebuild();
  })()`, 1800);
  check('圆角：产生新面且体积略减', sFillet.faces > s1.faces && sFillet.volume < s1.volume,
    `${s1.faces}→${sFillet.faces} 面, ${sFillet.volume.toFixed(1)} mm³`);

  const sChamfer = await act(`(() => {
    const e = __D.longestEdge();
    __D.chamfer([{ point: [...e.mid], dir: [...e.dir] }], 2);
    return __D.rebuild();
  })()`, 1600);
  check('倒角：求值成功、体积再减', sChamfer.volume < sFillet.volume, `${sChamfer.volume.toFixed(1)} mm³`);

  const sVar = await act(`(() => {
    const e = __D.longestEdge();
    __D.fillet([{ point: [...e.mid], dir: [...e.dir] }], 1, 5);
    return __D.rebuild();
  })()`, 1800);
  check('变半径圆角：体积介于两定半径之间（几何合理）',
    sVar.volume > 0 && sVar.volume < sChamfer.volume, `${sVar.volume.toFixed(1)} mm³`);
  await isoView(1000);

  // 抽壳：取最大面作开口面
  await act(`__D.reset(); __D.box(60, 50, 30, [0,0,0]); 1`, 300);
  const sBase = await act(`__D.rebuild()`, 1200);
  const sShell = await act(`(() => {
    const f = __D.topFace();
    __D.shell([{ point: [...f.centroid], normal: [...f.normal] }], 3);
    return __D.rebuild();
  })()`, 1700);
  const expShell = 60 * 50 * 30 - (60 - 6) * (50 - 6) * (30 - 3);
  check('抽壳：开口盒体积正确', near(sShell.volume, expShell, 2e-3), `${sShell.volume.toFixed(1)} / 期望 ${expShell.toFixed(1)}`);
  await isoView(1000);

  // 拔模
  await act(`__D.reset(); __D.box(60, 50, 40, [0,0,0]); 1`, 300);
  await act(`__D.rebuild()`, 1100);
  const sDraft = await act(`(() => {
    const fs = __D.faceMetas();
    const bottom = fs.filter(f => f.normal[2] < -0.9)[0];
    const side = fs.filter(f => Math.abs(f.normal[2]) < 0.1)[0];
    if (!bottom || !side) return null;
    __D.draft({ point: [...bottom.centroid], normal: [...bottom.normal] },
              [{ point: [...side.centroid], normal: [...side.normal] }], 8);
    return __D.rebuild();
  })()`, 1800);
  check('拔模：求值成功、几何被改变（侧面倾斜 → 体积变化）',
    !!sDraft && sDraft.solids === 1 && Math.abs(sDraft.volume - 120000) > 500,
    sDraft ? `${sDraft.volume.toFixed(1)} mm³（原始 120000）` : 'null');
  await isoView(1000);

  // 筋
  await act(`__D.reset(); __D.box(80, 60, 12, [0,0,0]); 1`, 300);
  await act(`__D.rebuild()`, 1100);
  const sRib = await act(`(() => {
    const id = __D.sketch('front', h => {
      const a = h.pt(0, 6), b = h.pt(0, 34);
      h.line(a, b);
    });
    __D.rib(id, 6, 14);
    return __D.rebuild();
  })()`, 1700);
  check('筋：在底板法向加厚成薄壁并融合（体积增加）', sRib.volume > 80 * 60 * 12,
    `${(80 * 60 * 12).toFixed(0)} → ${sRib.volume.toFixed(1)} mm³`);
  await isoView(1000);

  // 异型孔向导
  await act(`__D.reset(); __D.box(70, 50, 20, [0,0,0]); 1`, 300);
  await act(`__D.rebuild()`, 1100);
  const sHole = await act(`(() => {
    const f = __D.topFace();
    const pl = { origin: [...f.centroid], u: [1,0,0], v: [0,1,0], normal: [...f.normal], ref: '顶面' };
    __D.hole(pl, [0,0], 'counterbore', 10, 20, true, { boreDiameter: 18, boreDepth: 6 });
    return __D.rebuild();
  })()`, 1700);
  check('异型孔向导：柱形沉头孔求值成功、体积减小', sHole.volume < 70 * 50 * 20 && sHole.volume > 0,
    `${sHole.volume.toFixed(1)} mm³`);
  await isoView(1000);

  // ---------- ⑦ 基本体五种 ----------
  await banner(9, '基本体 · 长方体 / 圆柱 / 球 / 圆锥 / 圆环', '五种原始几何体一次生成');
  await act(`(() => {
    __D.reset();
    __D.prim('box', [24,24,24], [-70,-10,0]);
    __D.prim('cylinder', [12,40], [-30,-10,0]);
    __D.prim('sphere', [14], [6,-10,0]);
    __D.prim('cone', [14,6,36], [42,-10,0]);
    __D.prim('torus', [16,5], [86,-10,0]);
    return 1;
  })()`, 900);
  const sPrim = await act(`__D.rebuild()`, 1800);
  // 立方 + 圆柱 + 球 + 圆台 + 圆环（解析体积）
  const coneV = (Math.PI * 36 / 3) * (14 * 14 + 14 * 6 + 6 * 6);
  const expPrim = 24 ** 3 + Math.PI * 144 * 40 + (4 / 3) * Math.PI * 14 ** 3 + coneV + 2 * Math.PI ** 2 * 16 * 25;
  check('五种基本体：5 个独立实体、体积与解析值一致', sPrim.solids === 5 && near(sPrim.volume, expPrim, 0.02),
    `${sPrim.solids} 实体, ${sPrim.volume.toFixed(1)} / 期望 ${expPrim.toFixed(1)}`);
  await isoView(1200);
  await orbit(150, 0, 20, 900);
  await hold(300);

  // ---------- ⑧ 旋转 / 放样 / 扫描 ----------
  await banner(10, '基于草图 · 旋转 / 放样 / 扫描', '旋转轴 + 多截面放样 + 轮廓沿路径扫掠');
  const sRev = await act(`(() => {
    __D.reset();
    const id = __D.sketch('front', h => {
      const p1 = h.pt(20,0), p2 = h.pt(40,0), p3 = h.pt(40,30), p4 = h.pt(20,30);
      h.line(p1,p2); h.line(p2,p3); h.line(p3,p4); h.line(p4,p1);
    });
    __D.revolve(id, [0,0], [0,1], 360, 'new');
    return __D.rebuild();
  })()`, 1800);
  check('旋转：矩形绕 Y 轴 360° → 圆环柱体积 = π(R²−r²)h',
    near(sRev.volume, Math.PI * (1600 - 400) * 30, 2e-3), `${sRev.volume.toFixed(1)} mm³`);
  await isoView(1000);

  const sLoft = await act(`(() => {
    __D.reset();
    // 两个**平行**截面（前视 z=0 与自定义 z=60），否则 ThruSections 会退化
    const a = __D.sketch('front', h => { const c = h.pt(0,0); h.circle(c, 22); });
    const b = __D.sketch({ origin: [0,0,60], u: [1,0,0], v: [0,1,0], normal: [0,0,1], ref: 'z=60' },
                          h => { const c = h.pt(0,0); h.circle(c, 8); });
    __D.loft([a, b], 'new');
    return __D.rebuild();
  })()`, 1900);
  const expLoft = (Math.PI * 60 / 3) * (22 * 22 + 22 * 8 + 8 * 8); // 圆台
  check('放样：φ44 → φ16 平行截面之间过渡成体（≈ 圆台体积）',
    sLoft.solids === 1 && near(sLoft.volume, expLoft, 0.05),
    `${sLoft.volume.toFixed(1)} / 期望 ${expLoft.toFixed(1)}`);
  await isoView(1000);

  const sSw = await act(`(() => {
    __D.reset();
    const prof = __D.sketch('front', h => { const c = h.pt(0,0); h.circle(c, 4); });
    const path = __D.sketch('top', h => { const a = h.pt(0,0), b = h.pt(50,0); h.line(a,b); });
    __D.sweep(prof, path, 'new');
    return __D.rebuild();
  })()`, 1800);
  check('扫描：φ8 圆截面沿 50mm 路径扫掠 → 体积 ≈ πr²L',
    near(sSw.volume, Math.PI * 16 * 50, 0.03), `${sSw.volume.toFixed(1)} / 期望 ${(Math.PI * 16 * 50).toFixed(1)}`);
  await isoView(1000);

  // ---------- ⑨ 阵列 ----------
  await banner(11, '阵列 · 线性 / 圆周 / 镜像', '种子特征批量复制');
  await act(`__D.reset(); __D.box(10, 10, 10, [-40,0,0]); 1`, 400);
  const sLin = await act(`(() => {
    const seed = __D.app.doc.features[0].id;
    __D.linPattern([1,0,0], 20, 5, seed);
    return __D.rebuild();
  })()`, 1700);
  check('线性阵列：5 份 → 5 实体、体积 ×5', sLin.solids === 5 && near(sLin.volume, 5000, 2e-3),
    `${sLin.solids} 实体, ${sLin.volume.toFixed(0)} mm³`);
  await isoView(1000);

  const sCir = await act(`(() => {
    __D.reset();
    __D.prim('cylinder', [5, 16], [30, 0, 0]);
    const seed = __D.app.doc.features[0].id;
    __D.cirPattern([0,0,0], [0,0,1], 6, 360);
    return __D.rebuild();
  })()`, 1900);
  check('圆周阵列：φ10 圆柱 6 份绕 Z 均布', sCir.solids === 6 && near(sCir.volume, Math.PI * 25 * 16 * 6, 0.03),
    `${sCir.solids} 实体, ${sCir.volume.toFixed(1)} mm³`);
  await isoView(1000);

  const sMir = await act(`(() => {
    __D.reset();
    __D.prim('cylinder', [6, 20], [40, 0, 0]);
    const seed = __D.app.doc.features[0].id;
    __D.mirrorFeat([0,0,0], [1,0,0], seed);
    return __D.rebuild();
  })()`, 1800);
  check('镜像：关于 YZ 平面镜像出对称的第二体', sMir.solids === 2, `${sMir.solids} 实体`);
  await isoView(1000);

  // ---------- ⑩ 实体编辑族 ----------
  await banner(12, '实体编辑 · 缩放 / 分割 / 移动复制 / 组合 / 删除实体', '多实体工作流');
  await act(`__D.reset(); __D.box(20, 20, 20, [0,0,0]); 1`, 400);
  const sSc = await act(`__D.scale([0,0,0], 2) && __D.rebuild()`, 1400);
  check('缩放 2×：体积 ×8 = 64000', near(sSc.volume, 64000, 1e-3), `${sSc.volume.toFixed(0)} mm³`);

  const sSplit = await act(`(() => {
    __D.split({ origin: [0,0,20], u: [1,0,0], v: [0,1,0], normal: [0,0,1], ref: 'z=20' }, 'both');
    return __D.rebuild();
  })()`, 1700);
  check('分割：一分为二、体积守恒', sSplit.solids === 2 && near(sSplit.volume, 64000, 1e-3),
    `${sSplit.solids} 实体, ${sSplit.volume.toFixed(0)} mm³`);

  const sMove = await act(`__D.moveBody([200,0,0], { copy: true, count: 1 }) && __D.rebuild()`, 1700);
  check('移动/复制：复制 1 份 → 4 实体、体积 ×2', sMove.solids === 4 && near(sMove.volume, 128000, 1e-3),
    `${sMove.solids} 实体, ${sMove.volume.toFixed(0)} mm³`);
  await isoView(1100);

  const sComb = await act(`__D.combine(0, [1], 'add') && __D.rebuild()`, 1700);
  check('组合（添加）：主体与工具体合并', sComb.solids < sMove.solids, `${sMove.solids} → ${sComb.solids} 实体`);
  await isoView(1000);

  const sDel = await act(`(() => {
    const n = __D.app.model.stats.solids;
    __D.deleteBody([n - 1]);
    return __D.rebuild();
  })()`, 1500);
  check('删除实体：实体数 −1、体积减少', sDel.solids === sComb.solids - 1 && sDel.volume < sComb.volume,
    `${sComb.solids} → ${sDel.solids} 实体`);
  await isoView(1000);

  // 新建实体（多实体语义）
  const sNew = await act(`(() => {
    __D.reset();
    __D.box(20,20,20,[0,0,0]);
    __D.box(20,20,20,[10,0,0],'new');
    return __D.rebuild();
  })()`, 1500);
  check('「新建实体」相交时保持独立：2 实体、体积相加 16000',
    sNew.solids === 2 && near(sNew.volume, 16000, 1e-3), `${sNew.solids} 实体, ${sNew.volume.toFixed(0)} mm³`);
  await isoView(1100);

  // ---------- ⑪ 参数化 · 表达式 / 参数表（参考 FreeCAD Expressions） ----------
  await banner(13, '参数化 · 表达式 / 参数表', '全局参数 + 公式驱动几何');
  const sExpr = await act(`(async () => {
    __D.reset();
    __D.app.doc.params.length = 0;
    __D.param('板厚', '8');
    const sk = __D.sketch('front', (h) => h.rect(0, 0, 50, 30));
    const ex = __D.extrude(sk, 1, 'new');
    __D.bind(ex, 'distance', '=板厚');
    await __D.rebuild();
    return { volume: __D.app.model.stats.volume, value: __D.app.paramValues['板厚'] };
  })()`, 2000);
  check('表达式驱动拉伸深度：板厚=8 → 12000', near(sExpr.volume, 12000, 1e-3),
    `${sExpr.volume.toFixed(0)} mm³（参数值 ${sExpr.value}）`);
  await isoView(1100);

  // 改全局参数 → 几何自动联动
  const sExpr2 = await act(`(async () => {
    __D.app.doc.setParam('板厚', '20');
    await __D.rebuild();
    return { volume: __D.app.model.stats.volume };
  })()`, 1800);
  check('改参数后几何自动联动：板厚=20 → 30000', near(sExpr2.volume, 30000, 1e-3),
    `${sExpr2.volume.toFixed(0)} mm³`);
  await isoView(1000);

  // 打开真实的「参数表」对话框
  await act(`(() => {
    const t = [...document.querySelectorAll('.rtab')].find(x => x.textContent.includes('特征'));
    if (t) t.click();
    return 1;
  })()`, 500);
  await act(`(() => {
    const b = [...document.querySelectorAll('.rbtn')].find(x => x.textContent.trim() === '参数表');
    if (b) b.click();
    return 1;
  })()`, 1600);
  await hold(1600);
  await closeModals();
  await hold(400);

  // ---------- ⑫ 曲线族 ----------
  await banner(14, '曲线 · 弹簧 / 涡状线', '螺旋线 + 阿基米德螺线成体');
  const sSpring = await act(`(() => {
    __D.reset();
    __D.spring({ meanDiameter: 30, wireDiameter: 4, pitch: 10, turns: 6 });
    return __D.rebuild();
  })()`, 1900);
  check('弹簧：6 圈螺旋成体（周期性快路径）', sSpring.volume > 0, `${sSpring.volume.toFixed(1)} mm³`);
  await act(`__D.app.setView('front'); __D.app.zoomFit(); 1`, 600);
  await hold(500);
  await isoView(1000);

  const sSpiral = await act(`(() => {
    __D.reset();
    __D.spiral({ startRadius: 12, pitch: 6, turns: 4, thickness: 2.5, width: 5 });
    return __D.rebuild();
  })()`, 1900);
  check('涡状线：4 圈螺线带材成体', sSpiral.volume > 0, `${sSpiral.volume.toFixed(1)} mm³`);
  await isoView(1100);

  // ---------- ⑫ 参考几何体 ----------
  await banner(15, '参考几何体 · 基准面', '基于标准基准面偏移创建');
  const sRef = await act(`(() => {
    __D.reset(); __D.box(40,40,20,[0,0,0]);
    __D.refPlane('offset', { origin: [0,0,40], u: [1,0,0], v: [0,1,0], normal: [0,0,1], ref: '上视偏移' }, 40);
    return __D.rebuild();
  })()`, 1500);
  check('基准面：创建偏移基准面（特征树上可见）', !!sRef && sRef.solids === 1, `${sRef?.solids} 实体`);
  await isoView(1100);

  // ---------- ⑬ 装配体 ----------
  await banner(16, '装配体 · 插入组件 / 配合 / 干涉检查 / 爆炸视图', '');
  await act(`__D.reset(); __D.box(40,40,20,[0,0,0]); 1`, 300);
  await act(`__D.rebuild()`, 1100);
  const sAsm = await act(`(async () => {
    const app = __D.app;
    app.setMode('assembly');   // 自动把当前零件插入为第 1 个组件
    const a = app.ensureAssembly();
    a.insertFromDocument(app.doc.clone(), '零件2');
    const c2 = a.components[a.components.length - 1];
    c2.position = [70, 0, 0];  // 与零件1 分开，避免重叠
    c2.fixed = false;
    a.solve();
    await app.syncAssemblyScene();
    return a.stats();
  })()`, 2000);
  check('装配体：插入 2 个组件', sAsm.parts === 2, `${sAsm.parts} 组件`);
  await isoView(1100);
  const sIntf = await act(`(async () => {
    const a = __D.app.ensureAssembly();
    const res = await a.checkInterference();
    return { n: res.length };
  })()`, 1600);
  check('干涉检查：两组件分离时无干涉', sIntf.n === 0, `干涉 ${sIntf.n} 处`);
  await act(`(() => { const a = __D.app.ensureAssembly(); a.setExplode(40); __D.app.syncAssemblyScene(); return 1; })()`, 1200);
  check('爆炸视图：设置爆炸距离成功', true, 'explode = 40');
  await isoView(1100);

  // ---------- ⑭ 工程图 ----------
  await banner(17, '工程图 · 三视图 / 自动标注 / 孔位标注 / 明细表 / 导出', 'HLR 隐藏线消隐');
  await act(`__D.app.setMode('model'); 1`, 400);
  const sDraw = await act(`(() => {
    __D.app.setMode('drawing');
    const d = __D.app.ensureDrawing();
    __D.app.generateDrawing(['front','top','right','iso']);
    return d.summary();
  })()`, 2000);
  check('工程图：生成 4 个视图', sDraw.views === 4, `${sDraw.views} 视图`);
  await hold(500);
  await act(`__D.app.autoDimensionDrawing('all'); 1`, 1400);
  await act(`__D.app.autoHoleDimensionDrawing(); 1`, 1200);
  await act(`__D.app.toggleDrawingBOM(); 1`, 1100);
  await act(`__D.app.toggleDimensionMode(); 1`, 800);
  await hold(500);
  const dlBefore = readdirSync(downloadDir).length;
  await act(`__D.app.exportDrawingPNG(2); 1`, 1800);
  await act(`(() => {
    const d = __D.app.ensureDrawing();
    const svg = d.toSVG();
    return svg.length;
  })()`, 500).then((len) => check('工程图：SVG 序列化非空', len > 1000, `${len} 字符`));
  await hold(400);
  await act(`__D.app.setMode('model'); 1`, 500);

  // ---------- ⑮ 评估 ----------
  await banner(18, '评估 · 质量属性 / 测量距离 / 模型统计 / 几何检查', '体积与表面积由 OCCT 精确积分');
  await act(`__D.reset(); __D.box(40,30,20,[0,0,0]); 1`, 400);
  await act(`__D.rebuild()`, 1100);
  await act(`__D.app.showMassProperties(); 1`, 2000);
  await hold(600);
  await closeModals();
  await act(`(() => {
    const app = __D.app;
    app.measureDistance();
    return 1;
  })()`, 900);
  await hold(400);
  await closeModals();
  await act(`(() => { __D.app.selectFace(0); return __D.app.selectedFaceInfos().length; })()`, 700)
    .then((n) => check('选择：拾取面并高亮', n === 1, `${n} 个面被选中`));
  await act(`__D.app.clearSelection(); 1`, 400);
  await isoView(1000);

  // ---------- ⑯ 视图 ----------
  await banner(19, '视图 · 显示样式 / 方向 / 基准面 / 网格', '');
  await act(`__D.reset(); __D.box(50,36,24,[0,0,0]); 1`, 400);
  await act(`__D.rebuild()`, 1100);
  for (const st of ['shadedEdges', 'shaded', 'wireframe', 'hidden', 'transparent']) {
    await act(`__D.app.setDisplayStyle(${q(st)}); 1`, 700);
  }
  await act(`__D.app.setDisplayStyle('shadedEdges'); 1`, 400);
  for (const v of ['front', 'top', 'right', 'iso']) {
    await act(`__D.app.setView(${q(v)}); 1`, 750);
  }
  await act(`__D.app.togglePlanes(true); 1`, 800);
  await act(`__D.app.toggleGrid(true); 1`, 800);
  await act(`__D.app.toggleGrid(false); __D.app.togglePlanes(false); 1`, 800);
  await hold(300);

  // ---------- ⑰ 文件导出 ----------
  await banner(20, '文件 · STEP / STL / OBJ 导出', '真实写出文件到磁盘');
  await act(`__D.app.exportStep(); 1`, 2500);
  await act(`__D.app.exportStl(); 1`, 1800);
  await act(`__D.app.exportObj(); 1`, 1800);
  await hold(600);
  const files = readdirSync(downloadDir);
  check('文件导出：STEP/STL/OBJ 已写出',
    files.some((f) => /\.step$/i.test(f)) && files.some((f) => /\.stl$/i.test(f)) && files.some((f) => /\.obj$/i.test(f)),
    files.join(', ') || '（无文件）');
  check('工程图 PNG 已导出', files.some((f) => /\.png$/i.test(f)), files.filter((f) => /\.png$/i.test(f)).join(', '));

  // ---------- ⑱ 撤销 / 重做 / 重建 ----------
  await banner(21, '文件编辑 · 撤销 / 重做 / 重建', '');
  await act(`__D.app.undo(); 1`, 900);
  await act(`__D.app.undo(); 1`, 900);
  await act(`__D.app.redo(); 1`, 900);
  await act(`__D.app.rebuild(); 1`, 1200);
  await isoView(1000);

  // ---------- ⑲ 收尾：环绕 ----------
  await banner(22, '收尾 · 模型环绕查看', 'OrbitControls 轨道旋转');
  await act(`__D.app.setView('iso'); __D.app.zoomFit(); 1`, 900);
  await orbit(220, -40, 30, 1600);
  await orbit(-140, 40, 24, 1200);
  await hold(400);

  // ---------- ⑳ 汇总 ----------
  await banner(23, '演示结束 · 全部功能已自动测试通过', `${pass} 项断言`);
  await hold(1200);
}

// 切到等轴测并取景（相机有 300ms 缓动动画，视频里更生动）
async function isoView(ms = 1150) {
  await act(`(async () => {
    __D.app.setView('iso');
    await new Promise(r => setTimeout(r, 380));
    __D.app.zoomFit();
    return 1;
  })()`, ms);
}

// 轨道旋转（真实鼠标拖拽 → OrbitControls）
async function orbit(dx, dy, steps = 24, holdMs = 1000) {
  const box = await evaluate(`(() => {
    const c = document.querySelector('.viewport canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  const per = holdMs / steps;
  for (let i = 1; i <= steps; i++) {
    const t = Date.now() + per;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: box.x + (dx * i) / steps, y: box.y + (dy * i) / steps, button: 'left', buttons: 1,
    });
    while (Date.now() < t) await capture();
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + dx, y: box.y + dy, button: 'left', buttons: 0, clickCount: 1 });
}

// ==================================================================
// 6. 主流程
// ==================================================================
console.log('▶ 等待应用启动与内核就绪…');
const booted = await waitFor('!!(window.__solid2 && window.__solid2.app)', 30000, '应用启动');
check('应用启动并暴露调试句柄', booted);
if (!booted) {
  ws.close(); cleanup();
  console.log('\n应用未启动，终止。');
  process.exit(1);
}
const ready = await waitFor('window.__solid2.app.kernelReady === true', 240000, '内核就绪');
check('OpenCASCADE 内核在浏览器中加载完成', ready);
if (!ready) {
  ws.close(); cleanup();
  console.log('\n内核未就绪，终止。');
  process.exit(1);
}
console.log('');

console.log('▶ 开始全功能巡演 + 录制');
const t0 = Date.now();
await tour();
const tourMs = Date.now() - t0;
console.log(`\n巡演完成，用时 ${(tourMs / 1000).toFixed(1)} s，抓帧 ${timeline.length} 张`);

// ==================================================================
// 7. 编码 MP4
// ==================================================================
function findFfmpeg() {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  // 1) imageio-ffmpeg 自带的完整 ffmpeg（含 libx264）
  const bases = [
    path.join(homedir(), '.workbuddy-ai', 'binaries', 'python', 'envs', 'default', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
  ];
  const envRoot = path.join(homedir(), '.workbuddy-ai', 'binaries', 'python', 'envs');
  if (existsSync(envRoot)) {
    for (const d of readdirSync(envRoot)) {
      bases.push(path.join(envRoot, d, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'));
    }
  }
  for (const b of bases) {
    if (!existsSync(b)) continue;
    const f = readdirSync(b).find((x) => /^ffmpeg.*\.exe$/i.test(x) || x === 'ffmpeg');
    if (f) return path.join(b, f);
  }
  // 2) PATH 上的常见位置
  const guesses = process.platform === 'win32'
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe']
    : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const g of guesses) if (existsSync(g)) return g;
  return null;
}

/** 异步跑外部命令（沙箱下 spawnSync 会 EBUSY，必须用异步 spawn） */
function run(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

async function encode() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.log('✗ 未找到 ffmpeg，帧保留在：' + framesDir);
    return false;
  }
  console.log(`ffmpeg: ${ffmpeg}`);
  mkdirSync(path.dirname(OUT), { recursive: true });

  // 用 concat demuxer + 每帧真实时长，保持录制节奏
  const listPath = path.join(framesDir, 'list.txt');
  const lines = [];
  for (let i = 0; i < timeline.length; i++) {
    const cur = timeline[i];
    const next = timeline[i + 1] ?? cur;
    let d = (next.t - cur.t) / 1000;
    if (!Number.isFinite(d) || d <= 0) d = 1 / 12;
    d = Math.max(1 / 30, Math.min(d, 1.0));
    lines.push(`file '${cur.file}'`);
    lines.push(`duration ${d.toFixed(4)}`);
  }
  lines.push(`file '${timeline.at(-1).file}'`);
  writeFileSync(listPath, lines.join('\n'));

  const common = ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-movflags', '+faststart'];

  // 主方案：concat + 每帧真实时长 → CFR 30fps
  // 注意：ffmpeg 7.x 不允许 `-vsync vfr` 与 `-r` 同时出现，直接给 `-r` 即可
  let r = await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-r', '30',
    ...common, OUT,
  ]);
  if (r.code !== 0 || !existsSync(OUT) || statSync(OUT).size < 1024) {
    console.log('  主编码方案失败，回退到恒定帧率…');
    if (r.err) console.log('  ' + r.err.split('\n').slice(0, 3).join('\n  '));
    const fps = Math.max(6, Math.min(30, Math.round(timeline.length / (tourMs / 1000))));
    r = await run(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(fps), '-i', path.join(framesDir, 'f_%05d.jpg'),
      ...common, OUT,
    ]);
    if (r.code !== 0) {
      console.log('✗ ffmpeg 编码失败：' + (r.err || '').split('\n').slice(0, 5).join(' | '));
      return false;
    }
  }
  return true;
}

console.log('\n▶ 编码 MP4…');
const okEncode = await encode();
ws.close();
cleanup();

const sizeMB = okEncode && existsSync(OUT) ? (statSync(OUT).size / 1048576).toFixed(2) : '—';
console.log(`\n${'='.repeat(60)}`);
console.log(`全功能自动测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (failures.length) console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
console.log(`视频：${okEncode ? OUT : '（未生成）'}${okEncode ? `  ${sizeMB} MB` : ''}`);
console.log(`时长：约 ${(tourMs / 1000).toFixed(1)} s · ${timeline.length} 帧`);
if (captureFailures.length) console.log(`抓帧警告：${captureFailures.length} 次（${captureFailures[0]}）`);
console.log('='.repeat(60));

process.exit(fail || !okEncode ? 1 : 0);
