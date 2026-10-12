/**
 * 构建产物校验 —— 确认"内核隔离"架构不变量：
 *   - 主线程包（index-*.js）绝不能引用 opencascade 的代码或 wasm 资源；
 *   - 内核 Worker 包（kernel.worker-*.js）才允许引用。
 *
 * 用法： node tools/verify-bundle.mjs
 * 在 `npm run build` 之后运行；失败以非零码退出，可用于 CI。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

if (!existsSync(distDir)) {
  console.error('✗ 未找到 dist/，请先运行 npm run build');
  process.exit(1);
}

const assetsDir = path.join(distDir, 'assets');
const files = readdirSync(assetsDir);

// 判定"真正的 OCCT 泄漏"：引用 wasm 资源或 OCCT 绑定代码，而非中文提示里的 "OpenCASCADE" 一词
const LEAK_PATTERNS = ['opencascade.wasm', 'opencascade.js', 'gp_Pnt', 'BRepPrimAPI', 'BRepBuilderAPI'];

function find(dir, re) {
  return readdirSync(dir).filter((n) => re.test(n));
}

const main = find(assetsDir, /^index-.*\.js$/);
const worker = find(assetsDir, /^kernel\.worker-.*\.js$/);

let ok = true;
if (!main.length) {
  console.error('✗ 未找到主包 index-*.js');
  ok = false;
}
for (const f of main) {
  const text = readFileSync(path.join(assetsDir, f), 'utf8');
  const leaked = LEAK_PATTERNS.filter((p) => text.includes(p));
  if (leaked.length) {
    console.error(`✗ 主包 ${f} 泄漏 OCCT 引用：${leaked.join(', ')}`);
    ok = false;
  } else {
    console.log(`✓ 主包 ${f} 未引用内核（隔离良好）`);
  }
}

if (!worker.length) {
  console.error('✗ 未找到内核 Worker 包 kernel.worker-*.js');
  ok = false;
} else {
  for (const f of worker) {
    const text = readFileSync(path.join(assetsDir, f), 'utf8');
    if (!text.includes('opencascade')) {
      console.error(`✗ Worker 包 ${f} 未引用 opencascade（异常）`);
      ok = false;
    } else {
      console.log(`✓ Worker 包 ${f} 正常引用内核`);
    }
  }
}

// wasm 资源存在性
const wasm = find(assetsDir, /opencascade\.wasm.*\.wasm$/);
if (!wasm.length) {
  console.error('✗ 未找到 opencascade.wasm 资源');
  ok = false;
} else {
  const size = statSync(path.join(assetsDir, wasm[0])).size;
  console.log(`✓ 内核资源 ${wasm[0]}  ${(size / 1048576).toFixed(1)} MB`);
}

process.exit(ok ? 0 : 1);
