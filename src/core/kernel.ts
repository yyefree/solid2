/**
 * 几何内核客户端（主线程）。
 *
 * 这是对"方案1：Web Worker 内核卸载"的门面：所有需要 OpenCASCADE 的操作都经此
 * 转发给 `app/kernel.worker.ts`（Worker 属应用级适配器，故置于 `app/`，可引用 `doc/`），
 * 主线程只拿到可序列化的纯数据（MeshResult 等），
 * 因此主线程永不卡顿、内核崩溃也被隔离在 Worker 里。
 *
 * 用法：
 *   import { kernel } from './core/kernel';
 *   await kernel.loadKernel((pct, phase) => { ... });   // 启动即开始，可重复调用
 *   const model = await kernel.rebuild(doc.features);   // ModelResult
 */
import type {
  KernelRequest,
  KernelResponse,
  WorkerOutMsg,
  KernelOp,
  ModelResult,
  ExportResult,
  ImportResult,
  MassResult,
  MeasureResult,
  AssemblyResult,
  InterfereResult,
  GeometryCheckResult,
  RebuildPayload,
  TessellatePayload,
  ExportStepPayload,
  ImportStepPayload,
  MassPropsPayload,
  MeasurePayload,
  AssemblyPayload,
  InterferePayload,
  GeometryCheckPayload,
} from './kernel-types';

type ProgressFn = (pct: number, phase: string) => void;

class KernelClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private readyResolvers: { resolve: () => void; reject: (e: any) => void }[] = [];
  private progressListeners = new Set<ProgressFn>();
  private _ready = false;
  private _initError: string | null = null;
  /** 内核是否已崩溃（worker 已不可恢复）。崩溃后所有新请求立即拒绝，避免永久挂起。 */
  private dead = false;

  constructor() {
    this.worker = new Worker(new URL('../app/kernel.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data as WorkerOutMsg);
    this.worker.onerror = (e) => {
      this.handleFatal(e.message || 'Worker 运行错误');
    };
  }

  /**
   * 内核致命错误（worker 抛出未捕获异常 / 经 wasm 边界崩溃）。
   *
   * 此时在途的所有 rebuild/measure/... 请求都已不可能再收到回复——若不处理，
   * 调用方会永久卡在「正在重建」。这里统一拒绝它们，并标记 dead：
   * 之后任何新请求都立即 reject（提示刷新），不再把请求塞给已死的 worker。
   */
  private handleFatal(msg: string): void {
    this._initError = msg;
    for (const r of this.readyResolvers) r.reject(new Error(msg));
    this.readyResolvers = [];
    for (const { reject } of this.pending.values()) reject(new Error(msg));
    this.pending.clear();
    this.dead = true;
  }

  private onMessage(m: WorkerOutMsg): void {
    if (m.type === 'progress') {
      for (const fn of this.progressListeners) fn(m.pct, m.phase);
      return;
    }
    if (m.type === 'ready') {
      this._ready = true;
      for (const r of this.readyResolvers) r.resolve();
      this.readyResolvers = [];
      return;
    }
    if (m.type === 'initError') {
      this._initError = m.message;
      for (const r of this.readyResolvers) r.reject(new Error(m.message));
      this.readyResolvers = [];
      return;
    }
    // KernelResponse
    const resp = m as KernelResponse;
    const entry = this.pending.get(resp.id);
    if (!entry) return;
    this.pending.delete(resp.id);
    if (resp.ok) entry.resolve(resp.result);
    else entry.reject(new Error(resp.error ?? '内核操作失败'));
  }

  /** 内核是否就绪 */
  get ready(): boolean {
    return this._ready;
  }
  get initError(): string | null {
    return this._initError;
  }

  /** 启动/等待内核。重复调用返回同一个 Promise；进度回调每次都会注册。 */
  loadKernel(onProgress?: ProgressFn): Promise<void> {
    if (onProgress) this.progressListeners.add(onProgress);
    if (this._ready) return Promise.resolve();
    if (this._initError) return Promise.reject(new Error(this._initError));
    return new Promise<void>((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
    });
  }

  private invoke<T = unknown>(op: KernelOp, payload: unknown): Promise<T> {
    if (this.dead) {
      return Promise.reject(new Error(this._initError ?? '几何内核已崩溃，请刷新页面恢复'));
    }
    const id = ++this.seq;
    const req: KernelRequest = { id, op, payload };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(req);
    });
  }

  // ---------------- 高层 API ----------------
  rebuild(features: unknown[], linearDeflection = 0.12, angularDeflection = 0.28): Promise<ModelResult> {
    const p: RebuildPayload = { features, linearDeflection, angularDeflection };
    return this.invoke<ModelResult>('rebuild', p);
  }

  tessellate(features: unknown[], linearDeflection = 0.06, angularDeflection = 0.2): Promise<ModelResult> {
    const p: TessellatePayload = { features, linearDeflection, angularDeflection };
    return this.invoke<ModelResult>('tessellate', p);
  }

  exportStep(features: unknown[]): Promise<ExportResult> {
    const p: ExportStepPayload = { features };
    return this.invoke<ExportResult>('exportStep', p);
  }

  importStep(bytes: ArrayBuffer): Promise<ImportResult> {
    const p: ImportStepPayload = { bytes };
    return this.invoke<ImportResult>('importStep', p);
  }

  massProps(features: unknown[]): Promise<MassResult> {
    const p: MassPropsPayload = { features };
    return this.invoke<MassResult>('massProps', p);
  }

  measure(features: unknown[], kind: MeasurePayload['kind'], a: number, b: number): Promise<MeasureResult> {
    const p: MeasurePayload = { features, kind, a, b };
    return this.invoke<MeasureResult>('measure', p);
  }

  assembly(components: AssemblyPayload['components']): Promise<AssemblyResult> {
    const p: AssemblyPayload = { components };
    return this.invoke<AssemblyResult>('assembly', p);
  }

  interfere(components: InterferePayload['components']): Promise<InterfereResult> {
    const p: InterferePayload = { components };
    return this.invoke<InterfereResult>('interfere', p);
  }

  geometryCheck(features: unknown[]): Promise<GeometryCheckResult> {
    const p: GeometryCheckPayload = { features };
    return this.invoke<GeometryCheckResult>('geometryCheck', p);
  }
}

export const kernel = new KernelClient();
