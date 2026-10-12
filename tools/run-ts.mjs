/**
 * 通用 TS 测试运行器：用 Vite 的 SSR 构建把任意 TS 入口打成 ESM，再交给 Node 跑。
 * 用法: node tools/run-ts.mjs tools/kernel-test.ts
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const entry = process.argv[2] || 'tools/kernel-test.ts';
const tag = path.basename(entry).replace(/\.ts$/, '');
const outDir = path.join(here, '.ktest', tag);

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    ssr: path.join(root, entry),
    outDir,
    emptyOutDir: true,
    minify: false,
    target: 'node20',
    rollupOptions: {
      output: { entryFileNames: 'index.mjs', format: 'es' },
    },
  },
});

await import(pathToFileURL(path.join(outDir, 'index.mjs')).href);
