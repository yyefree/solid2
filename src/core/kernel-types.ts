/**
 * 主线程 ↔ 内核 Worker 的序列化协议。
 *
 * 设计原则：Worker 独占 OpenCASCADE（TopoDS_Shape 等不透明句柄只活在 Worker 里），
 * 主线程只拿到"可结构化克隆 / 可转移"的纯数据。所有几何以
 *   positions/normals/indices（ArrayBuffer，配合 transferable 零拷贝）
 *   + faceRanges / edgePolylines / faceMetas / edgeMetas（普通数组）
 * 的形式回传，主线程用 three.js 直接渲染，绝不反向持有任何 OCCT 对象。
 *
 * 本文件刻意不 import `oc` / `solid` / `three`，以便主线程与 Worker 共用而互不污染。
 */

export type Vec3 = [number, number, number];

// ============================================================
// 可序列化的网格结果（替代 TopoDS_Shape 在主线程的用途）
// ============================================================
/** 面所属的解析曲面类型（用于拾取/配合时判断平面 vs 圆柱面等） */
export type FaceSurfaceType = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';

/** 曲线类型（用于判断棱边是直线还是圆） */
export type EdgeCurveType = 'line' | 'circle' | 'other';

/** 轴/轴线：一点 + 单位方向（圆柱面的轴、圆的轴/中心、直线的走向） */
export interface AxisRef {
  point: Vec3;
  dir: Vec3;
}

export interface FaceMeta {
  /** 与 mesh.faceRanges 下标一一对应 */
  id: number;
  area: number;
  centroid: Vec3;
  normal: Vec3;
  /** 所属实体下标（多实体模型；顺序同 bodiesOf 展开顺序；旧数据可能缺失） */
  bodyIndex?: number;
  /** 解析曲面类型（可选；旧数据可能缺失） */
  surfaceType?: FaceSurfaceType;
  /** 圆柱/圆锥/圆环面的轴线 */
  axis?: AxisRef;
  /** 圆柱/球面半径 */
  radius?: number;
}

export interface EdgeMeta {
  /** 与 mesh.edgePolylines 下标一一对应 */
  id: number;
  length: number;
  mid: Vec3;
  dir: Vec3;
  /** 直线 / 圆 / 其他 */
  curveType?: EdgeCurveType;
  /** 圆的轴线（中心 + 法向）；直线时等于 {point:mid, dir} */
  axis?: AxisRef;
  /** 圆的半径 */
  radius?: number;
  /** 直线段两端点 */
  endpoints?: [Vec3, Vec3];
}

export interface MeshResult {
  /** Float32 顶点，[x0,y0,z0, x1,y1,z1, ...] */
  positions: ArrayBuffer;
  /** Float32 法向，与 positions 同长 */
  normals: ArrayBuffer;
  /** Uint32 三角形索引 */
  indices: ArrayBuffer;
  /** 每个面在索引缓冲中的区段（顺序与 faceMetas 一致） */
  faceRanges: { start: number; count: number }[];
  /** 每条特征边：扁平点序列 [x,y,z, x,y,z, ...]（已离散化） */
  edgePolylines: number[][];
  /** 面元数据（顺序与 faceRanges 一致） */
  faceMetas: FaceMeta[];
  /** 边元数据（顺序与 edgePolylines 一致） */
  edgeMetas: EdgeMeta[];
}

// ============================================================
// 各类操作结果
// ============================================================
export interface ModelStats {
  volume: number;
  area: number;
  faces: number;
  edges: number;
  solids: number;
}

export interface BBox {
  min: Vec3;
  max: Vec3;
}

export interface ModelResult {
  mesh: MeshResult;
  stats: ModelStats;
  bbox: BBox;
  /** 求值出错的特征（id → 信息），供 UI 标红 */
  errors: { id: string; message: string }[];
  rebuildMs: number;
}

export interface ExportResult {
  bytes: ArrayBuffer;
}

export interface ImportResult {
  mesh: MeshResult;
  bbox: BBox;
  stats: ModelStats;
}

export interface MassResult {
  volume: number;
  area: number;
  centroid: Vec3;
}

/** 测量：两拓扑元素的最小距离 */
export interface MeasureResult {
  distance: number;
}

export interface AssemblyComponent {
  id: string;
  /** 该组件的纯特征数据（JSON 可克隆） */
  features: unknown[];
  /** 世界变换：3×4 行主序 12 个数 */
  transform: number[];
  color?: number;
}

export interface AssemblyPart {
  id: string;
  mesh: MeshResult;
  bbox: BBox;
  volume: number;
}

export interface AssemblyResult {
  parts: AssemblyPart[];
}

export interface InterfereResult {
  pairs: { a: string; b: string; volume: number }[];
}

export interface GeometryCheckResult {
  issues: { id: string; message: string }[];
}

// ============================================================
// RPC 消息
// ============================================================
export type KernelOp =
  | 'rebuild'
  | 'tessellate'
  | 'exportStep'
  | 'importStep'
  | 'massProps'
  | 'measure'
  | 'assembly'
  | 'interfere'
  | 'geometryCheck';

export interface KernelRequest {
  id: number;
  op: KernelOp;
  payload: unknown;
}

export interface KernelResponse {
  type: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Worker → 主线程：内核加载进度 */
export interface ProgressMsg {
  type: 'progress';
  pct: number;
  phase: string;
}

/** Worker → 主线程：内核就绪 */
export interface ReadyMsg {
  type: 'ready';
}

/** Worker → 主线程：初始化失败 */
export interface InitErrorMsg {
  type: 'initError';
  message: string;
}

export type WorkerOutMsg = ProgressMsg | ReadyMsg | InitErrorMsg | KernelResponse;

// ============================================================
// 各操作 payload 形状
// ============================================================
export interface RebuildPayload {
  features: unknown[];
  /** 显示网格偏差 */
  linearDeflection?: number;
  angularDeflection?: number;
}

export interface TessellatePayload {
  features: unknown[];
  linearDeflection?: number;
  angularDeflection?: number;
}

export interface ExportStepPayload {
  features: unknown[];
}

export interface ImportStepPayload {
  /** STEP 文件字节 */
  bytes: ArrayBuffer;
}

export interface MassPropsPayload {
  features: unknown[];
}

export interface MeasurePayload {
  features: unknown[];
  kind: 'faceFace' | 'edgeEdge' | 'faceEdge';
  /** 选择索引（对应 faceMetas / edgeMetas） */
  a: number;
  b: number;
}

export interface AssemblyPayload {
  components: AssemblyComponent[];
  linearDeflection?: number;
  angularDeflection?: number;
}

export interface InterferePayload {
  components: AssemblyComponent[];
}

export interface GeometryCheckPayload {
  features: unknown[];
}

/** 把 ArrayBuffer 还原成 TypedArray 视图（主线程侧） */
export function viewsOfMesh(m: MeshResult): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
} {
  return {
    positions: new Float32Array(m.positions),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.indices),
  };
}
