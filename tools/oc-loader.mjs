/**
 * Node 环境下的 OCCT 加载器。
 *
 * opencascade.js 的胶水层是 CJS/ESM 混合体（既有 require() 又有 export default），
 * Node 22 的模块格式自动探测会直接报 ERR_AMBIGUOUS_MODULE_SYNTAX。
 * 这里把它重写成纯 ESM 后加载，仅用于 Node 侧冒烟测试；
 * 浏览器端（Vite）走的是标准 import，不需要这个补丁。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 从当前文件位置向上找，定位到含 node_modules/opencascade.js 的项目根。
 * 之所以不能直接 path.join(here, '..')：这个 loader 会被 Vite 内联进
 * tools/.ktest/index.mjs，import.meta.url 的基准会偏移，硬编码相对层级必错。
 */
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'opencascade.js', 'dist'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`无法从 ${start} 向上定位 opencascade.js`);
}

const ROOT = findRoot(here);
const DIST = path.join(ROOT, 'node_modules', 'opencascade.js', 'dist');
const WASM = path.join(DIST, 'opencascade.wasm.wasm');
const PATCHED = path.join(ROOT, 'tools', '.ocjs.esm.mjs');

let cached = null;

export async function initOcctNode() {
  if (cached) return cached;

  if (!fs.existsSync(PATCHED)) {
    let src = fs.readFileSync(path.join(DIST, 'opencascade.wasm.js'), 'utf8');
    // 消掉所有 require( 标记，避免模块格式歧义
    src = src.replace(/\brequire\(/g, '__ocRequire(');
    const header =
      `import { createRequire as __createRequire } from 'node:module';\n` +
      `import { fileURLToPath as __fileURLToPath } from 'node:url';\n` +
      `import { dirname as __dirnameOf } from 'node:path';\n` +
      `const __ocRequire = __createRequire(import.meta.url);\n` +
      `const __filename = __fileURLToPath(import.meta.url);\n` +
      `const __dirname = __dirnameOf(__filename);\n`;
    fs.writeFileSync(PATCHED, header + src, 'utf8');
  }

  const mod = await import(pathToFileURL(PATCHED).href);
  // 直接把 wasm 二进制交给 emscripten，绕开它在 Node 下的 fetch 逻辑
  const wasmBinary = fs.readFileSync(WASM);
  cached = await mod.default({
    wasmBinary,
    locateFile: (p) => (p.endsWith('.wasm') ? WASM : p),
  });
  return cached;
}
