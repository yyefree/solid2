/**
 * 统一测试入口：依次运行所有 TS 测试套件（各自经 Vite SSR 打包后交 Node 运行）。
 *
 * 用法：node tools/test-all.mjs   或   npm test
 *
 * 顺序：纯计算（快）→ 需要 OCCT（慢）。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  { name: '钣金特征', file: 'tools/sheetmetal-test.ts' },
  { name: '拉伸终止条件/薄壁特征', file: 'tools/extrude-test.ts' },
  { name: '薄壁特征（旋转/扫描）', file: 'tools/thin-test.ts' },
  { name: '热键层（解析/覆盖存储）', file: 'tools/hotkeys-test.ts' },
  { name: '草图编辑历史（撤销/重做栈）', file: 'tools/sketch-history-test.ts' },
  { name: '选中态唯一真源（互斥/过滤器/悬空剪除）', file: 'tools/selection-store-test.ts' },
];

let failed = 0;
const results = [];

/**
 * 0. 工具脚本语法门禁。
 *
 * 冒烟 / 巡演脚本把大段「页面侧代码」塞进模板字符串（`evaluate(\`...\`)`）。
 * 一旦这段代码里混入**裸反引号**（哪怕只是注释里的 `` `x` ``），外层模板串会被提前闭合。
 * 有两种后果：
 *   ① 多数情况直接语法错误 —— `node --check` 能抓；
 *   ② 若截断处恰是 `` `...` `` 这种形式，后面紧跟的模板串会被解析成**标签模板调用**
 *      （`expr.hidden\`...\``），**语法完全合法**，运行时才炸 `undefined is not a function`。
 *      `node --check` 抓不到，只能靠下面的结构扫描。
 * 本项目两种情况都真实踩过，故此处两道都查。
 */
function collectScripts(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collectScripts(p, out);
    else if (/\.(mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 扫描「evaluate(`...`)」是否被裸反引号截断。
 *
 * 正常收尾：模板串关闭后下一个非空白字符是 `)` / `,` / `;`。
 * 若为 `.`：允许 `evaluate(...).then(...)`，但若 `.ident` 之后紧跟模板串，
 * 说明发生了「截断 + 标签模板」，判为可疑。
 */
function scanInjectedLiterals(src) {
  const hits = [];
  const re = /evaluate\s*\(\s*`/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let end = -1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (depth === 0 && ch === '`') {
        end = i;
        break;
      }
      if (ch === '$' && src[i + 1] === '{') {
        depth++;
        i += 2;
        continue;
      }
      if (depth > 0) {
        if (ch === '}') {
          depth--;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          const q = ch;
          i++;
          while (i < src.length && src[i] !== q) {
            if (src[i] === '\\') i++;
            i++;
          }
          i++;
          continue;
        }
      }
      i++;
    }
    if (end < 0) continue;
    let j = end + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    const next = src[j];
    let bad;
    if (next === ')' || next === ',' || next === ';') {
      bad = false;
    } else if (next === '.') {
      let k = j + 1;
      while (k < src.length && /[\w$]/.test(src[k])) k++;
      while (k < src.length && /\s/.test(src[k])) k++;
      bad = src[k] === '`';
    } else {
      bad = true;
    }
    if (bad) hits.push(src.slice(0, end).split('\n').length);
  }
  return hits;
}

console.log(`\n${'='.repeat(56)}\n  ▶ 工具脚本语法 + 注入模板串截断\n${'='.repeat(56)}`);
const scripts = [...collectScripts(path.join(root, 'tools')), ...collectScripts(path.join(root, 'desktop'))].sort();
let syntaxBad = 0;
for (const f of scripts) {
  const rel = path.relative(root, f);
  const r = spawnSync(process.execPath, ['--check', f], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    syntaxBad++;
    console.log(`  ✗ ${rel}`);
    console.log(
      (r.stderr ?? '')
        .split('\n')
        .slice(0, 5)
        .map((l) => `      ${l}`)
        .join('\n')
    );
    continue;
  }
  const hits = scanInjectedLiterals(readFileSync(f, 'utf8'));
  if (hits.length) {
    syntaxBad++;
    console.log(`  ✗ ${rel} —— 注入模板串被裸反引号截断（语法合法但语义已错）`);
    for (const line of hits) console.log(`      第 ${line} 行：模板串被提前闭合`);
    console.log('      → 去掉该处反引号（注释里也不行），或改用字符串拼接');
  }
}
console.log(syntaxBad ? `  ✗ ${syntaxBad} / ${scripts.length} 个脚本有问题` : `  ✓ ${scripts.length} 个脚本语法正确、无注入串截断`);
if (syntaxBad) failed++;
results.push({ name: `工具脚本语法 + 注入串截断（${scripts.length} 个）`, ok: syntaxBad === 0 });

for (const s of SUITES) {
  console.log(`\n${'='.repeat(56)}\n  ▶ ${s.name}  (${s.file})\n${'='.repeat(56)}`);
  const r = spawnSync(process.execPath, ['tools/run-ts.mjs', s.file], { cwd: root, stdio: 'inherit' });
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ name: s.name, ok });
}

console.log(`\n${'='.repeat(56)}\n  测试汇总\n${'='.repeat(56)}`);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
console.log(failed ? `\n✗ ${failed} / ${results.length} 个套件失败` : `\n✓ ${results.length} / ${results.length} 个套件全部通过`);
process.exit(failed ? 1 : 0);
