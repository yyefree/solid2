/**
 * 几何内核 Worker。
 *
 * 这是方案1的核心：OpenCASCADE 的初始化与所有 `oc.*` 调用都发生在这里，
 * 主线程永远不 import opencascade，也不持有任何 TopoDS 句柄。
 *
 * 启动即开始在后台加载 WASM（63MB），通过 `progress` / `ready` 消息上报进度；
 * 之后主线程通过 KernelRequest 调各种操作，Worker 返回可序列化的结果
 * （MeshResult 等），其中的 ArrayBuffer 用 transferable 零拷贝回传。
 *
 * ⚠️ 本文件 import 了 opencascade 的全部耦合（solid / mesh / topo / io / engine）。
 */
/// <reference lib="webworker" />
import { loadKernel } from './oc-loader';
import * as S from './solid';
import { exportSTEP, importSTEP } from './io';
import { faceInfos, featureEdgeInfos } from '../doc/topo';
import { rebuildFeatures, buildMeshResult } from '../doc/engine';
import type {
  KernelRequest,
  KernelResponse,
  WorkerOutMsg,
  ModelResult,
  MeshResult,
  AssemblyResult,
  InterfereResult,
  MassResult,
  MeasureResult,
  ExportResult,
  ImportResult,
  GeometryCheckResult,
  AssemblyComponent,
} from './kernel-types';
import { viewsOfMesh } from './kernel-types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let readyPromise: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = loadKernel((pct, phase) => {
      const m: WorkerOutMsg = { type: 'progress', pct, phase };
      ctx.postMessage(m);
    })
      .then(() => {
        const m: WorkerOutMsg = { type: 'ready' };
        ctx.postMessage(m);
      })
      .catch((e) => {
        const m: WorkerOutMsg = { type: 'initError', message: e instanceof Error ? e.message : String(e) };
        ctx.postMessage(m);
        throw e;
      });
  }
  return readyPromise;
}

// 启动即加载
ensureReady();

// ---------- 收集可转移 buffer ----------
function gatherBuffers(obj: any, out: ArrayBuffer[]): void {
  if (!obj) return;
  if (obj instanceof ArrayBuffer) {
    out.push(obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) gatherBuffers(v, out);
    return;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) gatherBuffers(obj[k], out);
  }
}

// ============================================================
// 各操作实现
// ============================================================
async function opRebuild(features: any[]): Promise<ModelResult> {
  await ensureReady();
  const { shape, errors, ms, surfaces } = rebuildFeatures(features);
  if (!shape || shape.IsNull()) {
    // 没有实体（比如只有草图）：返回空网格 + 错误
    const empty: MeshResult = {
      positions: new Float32Array(0).buffer,
      normals: new Float32Array(0).buffer,
      indices: new Uint32Array(0).buffer,
      faceRanges: [],
      edgePolylines: [],
      faceMetas: [],
      edgeMetas: [],
    };
    return { mesh: empty, stats: { volume: 0, area: 0, faces: 0, edges: 0, solids: 0, surfaces: 0 }, bbox: { min: [-50, -50, -50], max: [50, 50, 50] }, errors, rebuildMs: ms };
  }
  const mesh = buildMeshResult(shape, 0.12, 0.28);
  // 体积只由实体贡献（曲面壳不产生体积）；面积取全体（含曲面）。
  const tc = S.topologyCount(shape);
  const bb = S.boundingBox(viewsOfMesh(mesh));
  return {
    mesh,
    stats: { volume: S.solidVolume(shape), area: S.surfaceArea(shape), faces: tc.faces, edges: tc.edges, solids: tc.solids, surfaces },
    bbox: { min: bb.min, max: bb.max },
    errors,
    rebuildMs: ms,
  };
}

async function opTessellate(features: any[], linear: number, angular: number): Promise<ModelResult> {
  await ensureReady();
  const { shape, errors, surfaces } = rebuildFeatures(features);
  if (!shape || shape.IsNull()) throw new Error('没有可网格化的实体');
  const mesh = buildMeshResult(shape, linear, angular);
  const tc = S.topologyCount(shape);
  const bb = S.boundingBox(viewsOfMesh(mesh));
  return {
    mesh,
    stats: { volume: S.solidVolume(shape), area: S.surfaceArea(shape), faces: tc.faces, edges: tc.edges, solids: tc.solids, surfaces },
    bbox: { min: bb.min, max: bb.max },
    errors,
    rebuildMs: 0,
  };
}

async function opExportStep(features: any[]): Promise<ExportResult> {
  await ensureReady();
  const { shape } = rebuildFeatures(features);
  if (!shape || shape.IsNull()) throw new Error('没有可导出的实体');
  const bytes = exportSTEP(shape).buffer as ArrayBuffer;
  return { bytes };
}

async function opImportStep(bytes: ArrayBuffer): Promise<ImportResult> {
  await ensureReady();
  const shape = importSTEP(bytes);
  const mesh = buildMeshResult(shape, 0.12, 0.28);
  const bb = S.boundingBox(viewsOfMesh(mesh));
  const tc = S.topologyCount(shape);
  return { mesh, bbox: { min: bb.min, max: bb.max }, stats: { volume: S.solidVolume(shape), area: S.surfaceArea(shape), faces: tc.faces, edges: tc.edges, solids: tc.solids, surfaces: S.surfacesOf(shape).length } };
}

async function opMassProps(features: any[]): Promise<MassResult> {
  await ensureReady();
  const { shape } = rebuildFeatures(features);
  if (!shape || shape.IsNull()) throw new Error('没有实体');
  // 体积/质心只由实体贡献（曲面壳不产生体积）；面积取全体。
  const bodies = S.bodiesOf(shape);
  if (!bodies.length) throw new Error('没有实体（仅含曲面）');
  const mp = S.massProperties(bodies.length === 1 ? bodies[0] : S.compoundOf(bodies));
  return { volume: mp.volume, area: S.surfaceArea(shape), centroid: mp.centroid };
}

async function opMeasure(features: any[], kind: string, a: number, b: number): Promise<MeasureResult> {
  await ensureReady();
  const { shape } = rebuildFeatures(features);
  if (!shape || shape.IsNull()) throw new Error('没有实体');
  let ea: any, eb: any;
  if (kind === 'edgeEdge') {
    ea = featureEdgeInfos(shape)[a]?.edge;
    eb = featureEdgeInfos(shape)[b]?.edge;
  } else if (kind === 'faceEdge') {
    ea = faceInfos(shape)[a]?.face;
    eb = featureEdgeInfos(shape)[b]?.edge;
  } else {
    ea = faceInfos(shape)[a]?.face;
    eb = faceInfos(shape)[b]?.face;
  }
  if (!ea || !eb) throw new Error('选择无效');
  const d = S.minDistance(ea, eb);
  return { distance: d };
}

async function opAssembly(components: AssemblyComponent[]): Promise<AssemblyResult> {
  await ensureReady();
  const parts = components.map((c) => {
    try {
      const { shape } = rebuildFeatures(c.features as any[]);
      if (!shape || shape.IsNull()) return { id: c.id, mesh: emptyMesh(), bbox: { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, volume: 0 };
      const mesh = buildMeshResult(shape, 0.15, 0.3);
      const bb = S.boundingBox(viewsOfMesh(mesh));
      let volume = 0;
      try {
        volume = S.massProperties(shape).volume;
      } catch {
        volume = 0;
      }
      return { id: c.id, mesh, bbox: { min: bb.min, max: bb.max }, volume };
    } catch {
      return { id: c.id, mesh: emptyMesh(), bbox: { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, volume: 0 };
    }
  });
  return { parts };
}

async function opInterfere(components: AssemblyComponent[]): Promise<InterfereResult> {
  await ensureReady();
  const shapes = components.map((c) => {
    const { shape } = rebuildFeatures(c.features as any[]);
    if (!shape || shape.IsNull()) return null;
    return S.transform(shape, c.transform);
  });
  const pairs: { a: string; b: string; volume: number }[] = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (!shapes[i] || !shapes[j]) continue;
      const r = S.interfere(shapes[i]!, shapes[j]!, 1e-3);
      if (r.interfered) pairs.push({ a: components[i].id, b: components[j].id, volume: r.volume });
    }
  }
  return { pairs };
}

async function opGeometryCheck(features: any[]): Promise<GeometryCheckResult> {
  const { errors } = rebuildFeatures(features);
  return { issues: errors };
}

function emptyMesh(): MeshResult {
  return {
    positions: new Float32Array(0).buffer,
    normals: new Float32Array(0).buffer,
    indices: new Uint32Array(0).buffer,
    faceRanges: [],
    edgePolylines: [],
    faceMetas: [],
    edgeMetas: [],
  };
}

async function handleOp(req: KernelRequest): Promise<unknown> {
  const p = req.payload as any;
  switch (req.op) {
    case 'rebuild':
      return opRebuild(p.features);
    case 'tessellate':
      return opTessellate(p.features, p.linearDeflection ?? 0.06, p.angularDeflection ?? 0.2);
    case 'exportStep':
      return opExportStep(p.features);
    case 'importStep':
      return opImportStep(p.bytes);
    case 'massProps':
      return opMassProps(p.features);
    case 'measure':
      return opMeasure(p.features, p.kind, p.a, p.b);
    case 'assembly':
      return opAssembly(p.components);
    case 'interfere':
      return opInterfere(p.components);
    case 'geometryCheck':
      return opGeometryCheck(p.features);
    default:
      throw new Error(`未知操作：${(req as any).op}`);
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const req = e.data as KernelRequest;
  if (!req || typeof req.id !== 'number') return;
  handleOp(req)
    .then((result) => {
      const transfer: ArrayBuffer[] = [];
      gatherBuffers(result, transfer);
      const resp: KernelResponse = { type: 'response', id: req.id, ok: true, result };
      ctx.postMessage(resp, transfer);
    })
    .catch((err) => {
      const resp: KernelResponse = { type: 'response', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
      ctx.postMessage(resp);
    });
};
