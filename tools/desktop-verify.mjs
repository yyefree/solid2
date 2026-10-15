/**
 * 桌面版（exe）启动验证 —— 零依赖，走 CDP 驱动真实的 Electron 进程。
 *
 * 验证四件事：
 *   1. exe 能起来（PE 资源段被我们改写过，必须证明没改坏）；
 *   2. 内置静态服务器把 62 MB 的 WASM 以 application/wasm 正确吐出来；
 *   3. 几何内核（Worker + WASM）真的编译成功、状态栏显示「几何内核就绪」；
 *   4. 通过 AI 面板真建一个模型，视口信息出现非零的 面/边/实体 数 —— 证明整条链路可用。
 *
 * 用法：
 *   node tools/desktop-verify.mjs [Solid2.exe 路径]
 * 环境变量：
 *   VERIFY_TIMEOUT_MS  等待内核就绪上限（默认 300000）
 *   VERIFY_HEADLESS    1 = 加 --headless（默认不加，Electron 窗口会真的出现）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXE = path.resolve(
  ROOT,
  process.argv[2] ?? 'release/Solid2-win32-x64/Solid2.exe'
);
const PORT = Number(process.env.VERIFY_CDP_PORT ?? 9444);
const TIMEOUT = Number(process.env.VERIFY_TIMEOUT_MS ?? 300000);
const HEADLESS = process.env.VERIFY_HEADLESS === '1';

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

if (!existsSync(EXE)) {
  console.error(`✗ 找不到 exe：${EXE}\n  先跑 node desktop/build-desktop.mjs`);
  process.exit(1);
}
console.log(`目标 exe: ${path.relative(ROOT, EXE)}`);
console.log(`大小:     ${(statSync(EXE).size / 1024 / 1024).toFixed(1)} MB\n`);

// ------------------------------------------------------------------ 启动
//
// 两个环境坑（只影响本验证脚本，应用本体不受影响）：
//   · 当前 shell 设了 ELECTRON_RUN_AS_NODE=1 —— Electron 会退化成纯 Node 跑，
//     于是 "--remote-debugging-port" 被当成非法 Node 参数直接退出（code 9）。
//   · 这台机器的 GPU 进程起不来（0xC0000005），Chromium 会 FATAL 退出；
//     加 --disable-gpu 走软件光栅即可。真实桌面上用户不需要这些参数。
const profile = mkdtempSync(path.join(tmpdir(), 'solid2-desktop-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(EXE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-sandbox',
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--disable-background-networking',
  ...(HEADLESS ? ['--headless'] : []),
], { stdio: 'ignore', detached: false, env });

let exited = null;
child.on('exit', (code) => { exited = code ?? 0; });

function cleanup() {
  try { child.kill(); } catch { /* ignore */ }
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 800);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ------------------------------------------------------------------ CDP
async function getPageTarget() {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`进程已退出（code ${exited}）`);
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
console.log(`▶ 进程已启动，CDP 已连接`);
console.log(`  URL: ${target.url}\n`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }

  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push(
      (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)
    );
  }

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

async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`进程退出（code ${exited}）`);
    try { if (await evaluate(expr, { awaitPromise: false })) return true; } catch (e) { last = e.message; }
    await sleep(500);
  }
  console.log(`  ✗ 等待超时：${label}${last ? `  (${last})` : ''}`);
  return false;
}

// ==================================================================
// 1. 页面骨架
// ==================================================================
console.log('▶ 1. 页面与界面骨架');
const shell = await waitFor('!!document.querySelector(".app")', 30000, '应用骨架出现');
check('应用界面已挂载（.app）', shell);
check('窗口标题正确', (await evaluate('document.title')) !== '' , `title="${await evaluate('document.title')}"`);
const bootGone = await waitFor('!document.getElementById("boot-screen")', 15000, '启动屏淡出移除');
check('启动屏已淡出移除', bootGone);

// ==================================================================
// 3. 几何内核就绪（先等内核，再看它请求了什么资源）
// ==================================================================
console.log('\n▶ 2. 几何内核（Worker + OCCT WASM）');
const ready = await waitFor(
  `(document.querySelector('.statusbar')?.textContent ?? '').includes('内核就绪')`,
  TIMEOUT, '状态栏出现「几何内核就绪」'
);
check('内核编译完成、状态栏显示「几何内核就绪」', ready,
  ready ? '' : `当前状态栏："${await evaluate(`document.querySelector('.statusbar')?.textContent ?? ''`)}"`);

const failures = await evaluate(`(() => {
  const t = document.querySelector('.statusbar')?.textContent ?? '';
  return /失败|错误/.test(t) ? t : '';
})()`);
check('状态栏没有报错', !failures, failures || '');

// ==================================================================
// 3. 内置静态服务器 + WASM MIME
//
// 注意：WASM 是在 **Web Worker** 里 fetch 的，页面自身的 performance 时间线
// 和 Network 事件都看不到它。所以这里直接从产物目录取出真实文件名，
// 再向应用自己的 origin 发一次 HEAD —— 验的是「内置服务器有没有正确吐 wasm」，
// 而「内核真的加载成功了」已经由状态栏的「几何内核就绪」证明了。
// ==================================================================
console.log('\n▶ 3. 内置静态服务器与 62 MB WASM');
const assetsDir = path.join(ROOT, 'dist', 'assets');
const wasmFile = existsSync(assetsDir)
  ? readdirSync(assetsDir).find((f) => f.endsWith('.wasm'))
  : null;
check('产物里存在 .wasm 文件', !!wasmFile, wasmFile ?? '（没找到）');

if (wasmFile) {
  const head = await evaluate(`(async () => {
    const r = await fetch(location.origin + '/assets/${wasmFile}', { method: 'HEAD' });
    return { status: r.status, type: r.headers.get('content-type'), len: r.headers.get('content-length') };
  })()`);
  check('内置服务器返回 200', head?.status === 200, `status=${head?.status}`);
  check('WASM MIME 为 application/wasm', head?.type === 'application/wasm', `content-type=${head?.type}`);
  check('WASM 体积 ≈ 62 MB', Number(head?.len) > 50 * 1024 * 1024,
    `${(Number(head?.len) / 1024 / 1024).toFixed(1)} MB`);

  // 顺带验一下路径穿越防护
  const trav = await evaluate(`(async () => {
    const r = await fetch(location.origin + '/../package.json', { method: 'HEAD' });
    return r.status;
  })()`);
  check('路径穿越被挡住（非 200）', trav !== 200, `status=${trav}`);
}

// ==================================================================
// 4. 真正建一个模型（走 AI 面板 UI）
// ==================================================================
console.log('\n▶ 4. 通过 AI 面板建模（真实 UI 操作）');

const opened = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.rtab')].find(t => t.textContent.trim() === 'AI');
  if (!tab) return 'no-tab';
  tab.click();
  const btn = [...document.querySelectorAll('.rbtn')].find(b => b.textContent.includes('AI 建模'));
  if (!btn) return 'no-btn';
  btn.click();
  return document.querySelector('.ai-input') ? 'ok' : 'no-input';
})()`);
check('AI 建模面板已打开', opened === 'ok', `(${opened})`);

if (opened === 'ok') {
  const PROMPT = '60x40x10 的长方体，中心开半径 8 的通孔，四角倒圆角 R5';
  await evaluate(`(() => {
    const ta = document.querySelector('.ai-input');
    ta.value = ${JSON.stringify(PROMPT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  // 解析是异步的（interpret 返回 Promise），要等预览真的渲染出来
  const previewOk = await waitFor(
    `(() => {
       const t = document.querySelector('.ai-preview')?.textContent ?? '';
       return t.length > 12 && !t.includes('输入描述后这里会显示');
     })()`,
    10000, '解析预览渲染'
  );
  const previewText = await evaluate(`document.querySelector('.ai-preview')?.textContent ?? ''`);
  check('输入指令后实时解析出预览', previewOk,
    previewText.replace(/\s+/g, ' ').trim().slice(0, 70));

  const applied = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.trim() === '应用');
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  check('点击「应用」', applied === 'clicked');

  const built = await waitFor(
    `(() => { const m = (document.querySelector('.vp-info')?.textContent ?? '').match(/(\\d+)F/); return m && Number(m[1]) > 0; })()`,
    120000, '视口出现非零面数'
  );
  const info = await evaluate(`document.querySelector('.vp-info')?.textContent ?? ''`);
  check('模型已生成并渲染', built, info.trim());

  // 体积走真实 UI：评估页签 →「模型统计」对话框（tableModal 的「体积」行）。
  // 不用 window.__solid2——那个调试句柄只在 DEV 模式暴露，生产包里没有。
  const statsOpen = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tab = [...document.querySelectorAll('.rtab')].find((t) => t.textContent.trim() === '评估');
    if (!tab) return 'no-tab';
    tab.click();
    await sleep(80);
    const btn = [...document.querySelectorAll('.rbtn')].find((b) => b.textContent.trim() === '模型统计');
    if (!btn) return 'no-btn';
    btn.click();
    for (let i = 0; i < 40 && !document.querySelector('.modal'); i++) await sleep(50);
    return document.querySelector('.modal') ? 'opened' : 'no-modal';
  })()`);
  check('评估 → 模型统计 对话框已打开', statsOpen === 'opened', statsOpen);

  const summary = await evaluate(`(() => {
    const t = document.querySelector('.statusbar')?.textContent ?? '';
    const nodes = [...document.querySelectorAll('.panel-left .tnode')].map(n => n.querySelector('.label')?.textContent ?? '');
    const modal = document.querySelector('.modal');
    const rows = [];
    if (modal) {
      for (const tr of modal.querySelectorAll('tbody tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) rows.push([tds[0].textContent.trim(), tds[1].textContent.trim()]);
      }
    }
    return { status: t.trim(), nodes, rows: rows };
  })()`);
  check('特征树已出现节点', summary.nodes.length > 0, summary.nodes.join(' → '));
  // 解析解：60×40×10 长方体 24000 − Φ16 通孔 2010.62 − 四角 R5 圆角 214.60 = 21774.78 mm³
  const expect = 24000 - Math.PI * 64 * 10 - 4 * (25 - (Math.PI * 25) / 4) * 10;
  // 模型统计行（Node 侧解析，避免页面内 Number() 的 NaN 被 CDP 序列化成 null）
  const cell = (label) => summary.rows.find((r) => r[0] === label)?.[1] ?? '';
  const num = (label) => {
    const m = /[\d.]+/.exec(cell(label).replace(/,/g, ''));
    return m ? Number(m[0]) : 0;
  };
  const volume = num('体积');
  const faces = num('面数');
  check('体积与解析解吻合', faces > 0 && Math.abs(volume - expect) < 1.0,
    `${volume.toFixed(2)} vs 解析解 ${expect.toFixed(2)} mm³（面数=${faces}，行=${JSON.stringify(summary.rows)}）`);
  console.log(`    状态栏："${summary.status}"`);
}

// ==================================================================
// 5. 截图存档
// ==================================================================
console.log('\n▶ 5. 截图存档');
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const dir = path.join(ROOT, '.shots');
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'desktop-verify.png');
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  check('已保存窗口截图', existsSync(out), path.relative(ROOT, out));
} catch (e) {
  check('已保存窗口截图', false, e.message);
}

check('控制台无 JS 错误', consoleErrors.length === 0,
  consoleErrors.slice(0, 2).join(' | '));

// ------------------------------------------------------------------ 汇总
console.log('\n' + '='.repeat(56));
console.log(`桌面版验证：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(56));
ws.close();
cleanup();
process.exit(fail ? 1 : 0);
