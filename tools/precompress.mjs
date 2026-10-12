/**
 * 构建产物预压缩 —— 把 dist/ 里的静态资源压成 .br（brotli）与 .gz（gzip），
 * 让服务器可直接以 `Content-Encoding` 返回，免去每次请求的实时压缩开销。
 *
 * 对 63MB 的 opencascade.wasm 收益最大：brotli 传输 ≈ 10MB（原 65.9MB，约 1/6）。
 *
 * Nginx 配置示例：
 *   gzip_static on;
 *   brotli_static on;   # 需 ngx_brotli 模块
 *
 * 用法： node tools/precompress.mjs   （在 npm run build 之后自动执行）
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const distDir = path.join(root, 'dist');

if (!existsSync(distDir)) {
  console.error('✗ 未找到 dist/，请先运行 npm run build');
  process.exit(1);
}

// 体积 / 类型超过阈值才值得压缩；已压缩格式（.br/.gz/.png/.jpg/.wasm 除外）跳过
const COMPRESSIBLE = /\.(wasm|js|mjs|css|html|svg|json|txt|map)$/i;
const MIN_BYTES = 4 * 1024; // 小于 4KB 不压，收益不及开销

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push({ path: p, size: st.size });
  }
  return out;
}

function fmtMB(n) {
  return `${(n / 1048576).toFixed(2)} MB`;
}

const files = walk(distDir).filter((f) => COMPRESSIBLE.test(f.path) && f.size >= MIN_BYTES);
let rawTotal = 0;
let brTotal = 0;
let gzTotal = 0;
let count = 0;
let biggest = { path: '', raw: 0, br: 0 };

for (const f of files) {
  const buf = readFileSync(f.path);
  const br = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  const gz = zlib.gzipSync(buf, { level: 9 });

  // 只在压缩确实变小时才写文件
  if (br.length < buf.length) writeFileSync(f.path + '.br', br);
  if (gz.length < buf.length) writeFileSync(f.path + '.gz', gz);

  rawTotal += buf.length;
  brTotal += br.length;
  gzTotal += gz.length;
  count += 1;
  if (buf.length > biggest.raw) biggest = { path: path.relative(distDir, f.path), raw: buf.length, br: br.length };
}

console.log('预压缩完成');
console.log(`  文件        ${count} 个`);
console.log(`  原始        ${fmtMB(rawTotal)}`);
console.log(`  brotli      ${fmtMB(brTotal)}  (${((brTotal / rawTotal) * 100).toFixed(1)}%)`);
console.log(`  gzip        ${fmtMB(gzTotal)}  (${((gzTotal / rawTotal) * 100).toFixed(1)}%)`);
if (biggest.raw) {
  console.log(`  最大文件    ${biggest.path}  ${fmtMB(biggest.raw)} → ${fmtMB(biggest.br)} (br)`);
}
