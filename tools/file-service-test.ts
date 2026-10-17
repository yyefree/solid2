/**
 * 文件服务单测（纯编排，不依赖 DOM / 内核 Worker / OCCT）。
 *
 * 覆盖 `src/app/file-service.ts` 的核心流程：
 *   - 三个导出：无实体守卫 → 内核调用 → 下载（文件名/MIME/内容类型）→ 提示（含 KB / 三角形数）
 *   - 保存：documentJSON → 下载 → 提示
 *   - 打开：选文件 → JSON.parse → loadDocument + syncEntry → 提示；取消/坏 JSON 的路径
 *   - 导入：选文件 → 内核 → setImportedModel（ModelResult 形状）+ showImportedMesh → 提示；
 *     取消/内核报错的路径
 */
import { FileService, type FileHost } from '../src/app/file-service';
import type { BBox, ImportResult, MeshResult, ModelResult } from '../src/core/kernel-types';
import type { Feature } from '../src/doc/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

const emptyBBox: BBox = { min: [0, 0, 0], max: [1, 1, 1] };

/** 1 个三角形的 MeshResult（positions/normals/indices 同步长度） */
function oneTriangleMesh(): MeshResult {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer,
    indices: new Uint32Array([0, 1, 2]).buffer,
    faceRanges: [],
    edgePolylines: [],
    faceMetas: [],
    edgeMetas: [],
  };
}

/** 宿主 mock：全部回调可配置 + 调用记录 */
function makeHost(overrides: Partial<FileHost> = {}) {
  const rec = {
    downloads: [] as { content: string | Uint8Array | ArrayBuffer; filename: string; mime: string }[],
    toasts: [] as { kind: 'ok' | 'err'; msg: string }[],
    loadDocument: [] as unknown[],
    syncEntry: 0,
    imported: [] as ModelResult[],
    shownMeshes: [] as { mesh: MeshResult; bbox: BBox }[],
    exportStepCalls: 0,
    tessellateCalls: 0,
    importStepCalls: 0,
  };
  let model = true;
  const host: FileHost = {
    hasModel: () => model,
    resolvedFeatures: () => [],
    documentJSON: () => '{"version":2,"params":[],"features":[]}',
    loadDocument: (data) => { rec.loadDocument.push(data); },
    syncEntry: () => { rec.syncEntry++; },
    setImportedModel: (m) => { rec.imported.push(m); },
    showImportedMesh: (mesh, bbox) => { rec.shownMeshes.push({ mesh, bbox }); },
    exportStep: async () => { rec.exportStepCalls++; return { bytes: new ArrayBuffer(2048) }; },
    tessellate: async () => {
      rec.tessellateCalls++;
      return { mesh: oneTriangleMesh(), stats: { volume: 1, area: 1, faces: 1, edges: 1, solids: 1 }, bbox: emptyBBox, errors: [], rebuildMs: 0 };
    },
    importStep: async () => {
      rec.importStepCalls++;
      const r: ImportResult = { mesh: oneTriangleMesh(), bbox: emptyBBox, stats: { volume: 1, area: 1, faces: 1, edges: 1, solids: 1 } };
      return r;
    },
    download: (content, filename, mime) => { rec.downloads.push({ content, filename, mime }); },
    pickText: async () => null,
    pickBinary: async () => null,
    toast: (kind, msg) => { rec.toasts.push({ kind, msg }); },
    ...overrides,
  };
  const svc = new FileService(host);
  const setModel = (v: boolean) => { model = v; };
  return { svc, rec, setModel, host };
}

// ---- 导出：无实体守卫 ----
{
  const { svc, rec, setModel } = makeHost();
  setModel(false);
  await svc.exportStep();
  check('exportStep 无实体：err 提示且不调内核/下载',
    rec.toasts.length === 1 && rec.toasts[0].kind === 'err' && rec.toasts[0].msg === '没有可导出的实体' &&
    rec.exportStepCalls === 0 && rec.downloads.length === 0, JSON.stringify(rec.toasts));
}

// ---- exportStep：正常路径 ----
{
  const { svc, rec } = makeHost();
  await svc.exportStep();
  const d = rec.downloads[0];
  check('exportStep：下载 Uint8Array + 正确文件名/MIME',
    d && d.content instanceof Uint8Array && d.filename === 'solid2.step' && d.mime === 'application/step',
    JSON.stringify({ filename: d?.filename, mime: d?.mime, type: d?.content?.constructor?.name }));
  check('exportStep：ok 提示含 KB 数（2048B = 2.0 KB）',
    rec.toasts[0].kind === 'ok' && rec.toasts[0].msg === 'STEP 导出成功（2.0 KB）', rec.toasts[0].msg);
}

// ---- 导出：内核报错路径 ----
{
  const { svc, rec } = makeHost({
    exportStep: async () => { throw new Error('内核炸了'); },
  });
  await svc.exportStep();
  check('exportStep 内核报错：err 提示带原因、不下载',
    rec.toasts.length === 1 && rec.toasts[0].kind === 'err' && rec.toasts[0].msg === 'STEP 导出失败：内核炸了' &&
    rec.downloads.length === 0, JSON.stringify(rec.toasts));
}

// ---- exportStl ----
{
  const { svc, rec } = makeHost();
  await svc.exportStl();
  const d = rec.downloads[0];
  check('exportStl：下载 ArrayBuffer（STL 二进制）+ 文件名/MIME',
    d && d.content instanceof ArrayBuffer && d.filename === 'solid2.stl' && d.mime === 'model/stl',
    JSON.stringify({ filename: d?.filename, mime: d?.mime }));
  check('exportStl：ok 提示含三角形数（1 个三角形）',
    rec.toasts[0].kind === 'ok' && rec.toasts[0].msg === 'STL 导出成功（1 三角形）', rec.toasts[0].msg);
  check('exportStl：走了宿主 tessellate', rec.tessellateCalls === 1);
}

// ---- exportObj ----
{
  const { svc, rec } = makeHost();
  await svc.exportObj();
  const d = rec.downloads[0];
  check('exportObj：下载字符串（OBJ 文本）+ 文件名/MIME',
    d && typeof d.content === 'string' && d.filename === 'solid2.obj' && d.mime === 'model/obj',
    JSON.stringify({ filename: d?.filename, mime: d?.mime }));
  check('exportObj：ok 提示', rec.toasts[0].kind === 'ok' && rec.toasts[0].msg === 'OBJ 导出成功', rec.toasts[0].msg);
}

// ---- saveProject ----
{
  const { svc, rec } = makeHost();
  svc.saveProject();
  const d = rec.downloads[0];
  check('saveProject：下载宿主 JSON + 文件名/MIME',
    d && d.content === '{"version":2,"params":[],"features":[]}' &&
    d.filename === 'solid2-model.json' && d.mime === 'application/json',
    JSON.stringify({ filename: d?.filename, mime: d?.mime }));
  check('saveProject：ok 提示', rec.toasts[0].msg === '项目已保存');
}

// ---- openProject：正常 / 取消 / 坏 JSON ----
{
  const { svc, rec } = makeHost({
    pickText: async () => ({ name: '零件.json', text: '{"version":2}' }),
  });
  await svc.openProject();
  check('openProject：解析后 loadDocument + syncEntry + ok 提示带文件名',
    rec.loadDocument.length === 1 && (rec.loadDocument[0] as { version: number }).version === 2 &&
    rec.syncEntry === 1 && rec.toasts[0].msg === '已打开：零件.json', JSON.stringify(rec.toasts));
}
{
  const { svc, rec } = makeHost({ pickText: async () => null });
  await svc.openProject();
  check('openProject 取消：无任何副作用',
    rec.loadDocument.length === 0 && rec.syncEntry === 0 && rec.toasts.length === 0);
}
{
  const { svc, rec } = makeHost({
    pickText: async () => ({ name: '坏.json', text: '{ 这不是 json' }),
  });
  await svc.openProject();
  check('openProject 坏 JSON：err 提示、不 loadDocument',
    rec.loadDocument.length === 0 && rec.toasts.length === 1 &&
    rec.toasts[0].kind === 'err' && rec.toasts[0].msg.startsWith('打开失败：'), JSON.stringify(rec.toasts));
}

// ---- importStepFile：正常 / 取消 / 内核报错 ----
{
  const { svc, rec } = makeHost({
    pickBinary: async () => ({ name: '模型.step', buffer: new ArrayBuffer(16) }),
  });
  await svc.importStepFile();
  const m = rec.imported[0];
  check('importStepFile：setImportedModel 收到完整 ModelResult（errors 空 / rebuildMs 0）',
    !!m && Array.isArray(m.errors) && m.errors.length === 0 && m.rebuildMs === 0 && !!m.mesh && !!m.bbox && !!m.stats,
    JSON.stringify({ errors: m?.errors.length, rebuildMs: m?.rebuildMs }));
  check('importStepFile：showImportedMesh 收到 mesh + bbox', rec.shownMeshes.length === 1);
  check('importStepFile：ok 提示带文件名', rec.toasts[0].msg === '已导入 模型.step');
}
{
  const { svc, rec } = makeHost({ pickBinary: async () => null });
  await svc.importStepFile();
  check('importStepFile 取消：无任何副作用',
    rec.importStepCalls === 0 && rec.imported.length === 0 && rec.shownMeshes.length === 0 && rec.toasts.length === 0);
}
{
  const { svc, rec } = makeHost({
    pickBinary: async () => ({ name: '模型.step', buffer: new ArrayBuffer(16) }),
    importStep: async () => { throw new Error('STEP 解析失败'); },
  });
  await svc.importStepFile();
  check('importStepFile 内核报错：err 提示带原因、不落模型',
    rec.imported.length === 0 && rec.shownMeshes.length === 0 &&
    rec.toasts[0].kind === 'err' && rec.toasts[0].msg === '导入失败：STEP 解析失败', JSON.stringify(rec.toasts));
}

console.log(`\n文件服务：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail > 0) process.exit(1);
