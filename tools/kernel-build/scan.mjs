/**
 * OCCT 符号扫描器 —— "内核精简构建"的第一步。
 *
 * 扫描 `src/` 中所有对几何内核（opencascade.js / OCCT）的 API 调用，
 * 提取用到的 C++ 类 / 枚举 / 函数名，按 OCCT 头文件命名约定
 * （`Foo_Bar` → `Foo/Foo_Bar.hxx`）推导出需要编入的最小头文件集合。
 *
 * 输出：
 *   - tools/kernel-build/generated-includes.txt  （每行一个 OCCT 头文件相对路径）
 *   - tools/kernel-build/generated-includes.py.txt（可直接粘贴进 opencascade.js 的 make.py）
 *   - 控制台报告：符号数、头文件数、与当前全量构建的对比提示
 *
 * 用法： node tools/kernel-build/scan.mjs
 *
 * 说明：真正的"精简构建"需要在装有 Docker 的环境里，用本清单替换
 *       opencascade.js/make.py 里的 `INCLUDES`，再 `docker build && docker run`。
 *       详见 tools/kernel-build/README.md。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const srcDir = path.join(root, 'src');

/** 递归收集 .ts 文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// 不含下划线但确实是 OCCT 顶层命名空间的符号（白名单）
const NAMESPACES = new Set([
  'gp', 'TopAbs', 'TopoDS', 'Standard', 'Geom', 'Poly', 'BRep', 'Bnd', 'GC', 'GProp',
  'TopTools', 'TColStd', 'TColgp', 'BRepGProp', 'BRepBndLib', 'StlAPI', 'IGESControl', 'XSControl',
]);

// 非 OCCT：emscripten / 我们自己的辅助对象
const DENY = new Set(['FS', 'Module', 'HEAP8', 'HEAPU8']);

/** `gp_Pnt_3` → `gp_Pnt`（去掉 embind 重载后缀 `_<digits>`） */
function stripOverload(sym) {
  return sym.replace(/_\d+$/, '');
}

function isOcctSymbol(sym) {
  if (DENY.has(sym)) return false;
  if (NAMESPACES.has(sym)) return true;
  // 形如 Foo_Bar（含下划线），排除明显的方法名（首字母小写）
  if (!/^[A-Z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/.test(sym)) return false;
  // 排除枚举成员：任一下划线分段为全大写（如 TopAbs_FACE）——它们是枚举值而非头文件
  const parts = sym.split('_');
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].length >= 2 && parts[i] === parts[i].toUpperCase()) return false;
  }
  return true;
}

function headerFor(sym) {
  const name = stripOverload(sym);
  const folder = name.includes('_') ? name.split('_')[0] : name;
  return `${folder}/${name}.hxx`;
}

// 匹配 `new o.Xxx` / `o.Xxx` / `oc().Xxx` / `oc.Xxx`；忽略第二个点后的成员
const RE = /\b(?:new\s+)?(?:oc\(\)|oc|o)\.([A-Za-z][A-Za-z0-9_]+)/g;
// 匹配字符串字面量里的 OCCT 符号（如 booleanOp('BRepAlgoAPI_Fuse_3', ...)）
const RE_STR = /['"]([A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)['"]/g;

const files = walk(srcDir);
const symbols = new Set();
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
function collect(re, text) {
  let m;
  while ((m = re.exec(text))) {
    if (isOcctSymbol(m[1])) symbols.add(stripOverload(m[1]));
  }
}
for (const f of files) {
  const text = stripComments(readFileSync(f, 'utf8'));
  collect(RE, text);
  collect(RE_STR, text);
}

// TopoDS 的具体类型（通过 `o.TopoDS.Face_1(...)` 之类使用，第二层成员抓不到）
const TOPO_SUBTYPES = [
  'TopoDS_Face', 'TopoDS_Edge', 'TopoDS_Wire', 'TopoDS_Vertex', 'TopoDS_Solid',
  'TopoDS_Shell', 'TopoDS_Compound', 'TopoDS_CompSolid',
];
for (const t of TOPO_SUBTYPES) symbols.add(t);
symbols.add('TopAbs_ShapeEnum');
symbols.add('TopAbs_Orientation');

// 基础/基类头（opencascade.js 的 make.py 里已有的、作为容器/接口存在的头文件）
const BASE_HEADERS = [
  'Standard/Standard.hxx',
  'TopAbs/TopAbs.hxx',
  'TopoDS/TopoDS.hxx',
  'TopoDS/TopoDS_Shape.hxx',
  'TopoDS/TopoDS_Wire.hxx',
  'gp/gp.hxx',
  'Geom/Geom_Curve.hxx',
  'GProp/GProp_GProps.hxx',
];

const headers = new Set(BASE_HEADERS);
for (const s of symbols) headers.add(headerFor(s));
const list = [...headers].sort();

mkdirSync(here, { recursive: true });
writeFileSync(path.join(here, 'generated-includes.txt'), list.join('\n') + '\n', 'utf8');

const py = [
  '# 由 tools/kernel-build/scan.mjs 生成 —— 粘贴进 opencascade.js/make.py 的 INCLUDES 列表',
  'INCLUDES = [',
  ...list.map((h) => `  os.path.join('.', 'occt', 'src', ${h.split('/').map((s) => `'${s}'`).join(', ')}),`),
  ']',
  '',
].join('\n');
writeFileSync(path.join(here, 'generated-includes.py.txt'), py, 'utf8');

console.log(`扫描 ${files.length} 个源文件`);
console.log(`OCCT 符号 ${symbols.size} 个 → 头文件 ${list.length} 个`);
console.log(`已写出: tools/kernel-build/generated-includes.txt`);
console.log(`        tools/kernel-build/generated-includes.py.txt`);
console.log('');
console.log('符号清单（节选）:');
console.log('  ' + [...symbols].sort().slice(0, 40).join(', '));
