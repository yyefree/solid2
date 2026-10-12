/**
 * 用 Vite 的 SSR 构建把 TS 测试打成 ESM，再交给 Node 运行。
 * 用法: node tools/run-kernel-test.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '.ktest');

await build({
  configFile: false,
  root: path.join(here, '..'),
  logLevel: 'warn',
  build: {
    ssr: path.join(here, 'kernel-test.ts'),
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
