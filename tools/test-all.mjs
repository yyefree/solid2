/**
 * 统一测试入口：依次运行所有 TS 测试套件（各自经 Vite SSR 打包后交 Node 运行）。
 *
 * 用法：node tools/test-all.mjs   或   npm test
 *
 * 顺序：纯计算（快）→ 需要 OCCT（慢）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const SUITES = [
  { name: '草图求解器', file: 'tools/sketch-test.ts' },
  { name: '表达式引擎/参数化', file: 'tools/expr-test.ts' },
  { name: '测量几何', file: 'tools/measure-test.ts' },
  { name: 'AI 建模助手（解析/编译）', file: 'tools/ai-test.ts' },
  { name: '工程图/尺寸标注', file: 'tools/drawing-test.ts' },
  { name: '装配体配合', file: 'tools/assembly-test.ts' },
  { name: '文档/特征引擎', file: 'tools/doc-test.ts' },
  { name: '异型孔/基准面', file: 'tools/features-test.ts' },
  { name: '曲线/弹簧/涡状线', file: 'tools/curve-test.ts' },
  { name: '实体编辑/缩放/分割/圆角/移动/删除/组合/新建实体', file: 'tools/edit-test.ts' },
  { name: '草图→实体', file: 'tools/sketch-shape-test.ts' },
  { name: 'AI 建模助手（几何）', file: 'tools/ai-shape-test.ts' },
  { name: '几何内核', file: 'tools/kernel-test.ts' },
  { name: '单位制换算', file: 'tools/units-test.ts' },
  { name: '截面属性', file: 'tools/sectionprops-test.ts' },
  { name: '曲面特征', file: 'tools/surface-test.ts' },
  { name: '拉伸终止条件/薄壁特征', file: 'tools/extrude-test.ts' },
  { name: '薄壁特征（旋转/扫描）', file: 'tools/thin-test.ts' },
  { name: '热键层（解析/覆盖存储）', file: 'tools/hotkeys-test.ts' },
];

let failed = 0;
const results = [];

for (const s of SUITES) {
  console.log(`\n${'='.repeat(56)}\n  ▶ ${s.name}  (${s.file})\n${'='.repeat(56)}`);
  const r = spawnSync(process.execPath, ['tools/run-ts.mjs', s.file], { cwd: root, stdio: 'inherit' });
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ name: s.name, ok });
}

console.log(`\n${'='.repeat(56)}\n  测试汇总\n${'='.repeat(56)}`);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
console.log(failed ? `\n✗ ${failed} / ${SUITES.length} 个套件失败` : `\n✓ ${SUITES.length} / ${SUITES.length} 个套件全部通过`);
process.exit(failed ? 1 : 0);
