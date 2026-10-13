/**
 * Solid2 桌面版 —— Electron 主进程。
 *
 * 为什么要自带一个静态服务器？
 *   Solid2 是「ES module + Web Worker + 62 MB WASM」的纯前端应用，用 `file://` 直接打开会踩三个坑：
 *   ① ES module 的 `import` 在 file:// 下被 CORS 拦；② Worker 无法从 file:// 加载；
 *   ③ `fetch()` 读 wasm 会被判跨源。所以在主进程里起一个**只监听 127.0.0.1 随机端口**的
 *   静态服务器，窗口 loadURL 到它 —— 完全等价于 `npm run preview`，但用户看不到任何服务器。
 *
 * 安全基线：contextIsolation 开、nodeIntegration 关、sandbox 开，渲染进程拿不到任何 Node 能力；
 * 外部链接一律交给系统浏览器，不在应用内开新窗口。
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 前端产物目录。打包后是 `resources/app/dist`；开发态直接 `npm run desktop` 时
 * 退回项目根的 `dist/` —— 同一个 main.cjs 两种场景都能跑。
 */
function resolveRoot() {
  const packed = path.join(__dirname, 'dist');
  if (fs.existsSync(path.join(packed, 'index.html'))) return packed;
  const dev = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(path.join(dev, 'index.html'))) return dev;
  return packed;
}

const ROOT = resolveRoot();
const INDEX = path.join(ROOT, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 起一个只服务 `dist/` 的极简静态服务器，端口交给系统分配（0 = 随机空闲端口），
 * 这样不会和用户机器上别的程序抢端口。
 */
function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel;
      try {
        rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
      } catch {
        res.writeHead(400).end('Bad request');
        return;
      }
      if (rel === '/' || rel === '') rel = '/index.html';
      // 归一化后必须仍在 root 内，挡掉 ../ 穿越
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
          return;
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': st.size,
          // 62 MB 的 wasm 靠它避免重复读盘；文件名带 hash，可以长缓存
          'Cache-Control': 'public, max-age=3600',
        });
        const stream = fs.createReadStream(file);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function buildMenu(win) {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开导出目录',
          click: () => shell.openPath(app.getPath('downloads')),
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Solid2',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 Solid2',
              message: 'Solid2 — 参数化三维 CAD',
              detail:
                '浏览器端参数化 CAD，几何内核为 OpenCASCADE（OCCT）编译的 WebAssembly，\n' +
                '内核跑在独立 Web Worker 里，主线程只消费可序列化网格数据。\n\n' +
                `版本 ${app.getVersion()}\n` +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
              buttons: ['知道了'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
  if (!fs.existsSync(INDEX)) {
    dialog.showErrorBox(
      'Solid2 启动失败',
      `找不到前端产物：\n${INDEX}\n\n请在项目根目录执行 npm run build 后重新打包。`
    );
    app.quit();
    return;
  }

  const server = await startStaticServer(ROOT);
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b1220',
    title: 'Solid2 — 参数化三维 CAD',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 内核初始化 + 62 MB wasm 编译需要点时间，先显示窗口再等首帧，避免"白屏后突然出现"
  win.once('ready-to-show', () => win.show());

  // 外部链接交给系统浏览器；应用内不开新窗口
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      if (/^https?:/i.test(target)) shell.openExternal(target);
    }
  });

  win.loadURL(url);

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => server.close());
}

app.whenReady().then(() => {
  buildMenu(null);
  main().catch((e) => {
    dialog.showErrorBox('Solid2 启动失败', String((e && e.stack) || e));
    app.quit();
  });
});
