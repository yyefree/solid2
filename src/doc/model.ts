/**
 * 文档数据模型（纯数据，不依赖几何内核）。
 *
 * 这一层只负责"特征树的增删改查 + 序列化"，以及几何命名里两个
 * **纯数据** 的辅助函数（makeEdgeRef / makeFaceRef 只是把数字字段复制成引用对象）。
 * 真正的 OCCT 求值（evaluateFeature / resolveEdges / resolveFaces / rebuildFeatures）
 * 在 `engine.ts` 里，由 Worker 独占调用——这样主线程永远不会 import opencascade。
 *
 * ⚠️ 本文件不能出现任何 `oc` / `solid` / `mesh` / `topo` 的 import。
 */
import {
  DEFAULT_PLANE,
  RIGHT_PLANE,
  TOP_PLANE,
  newId,
  type Sketch,
  type SketchPlane,
} from '../sketch/types';
import type { Feature, FeatureId, PlaneRef, SketchFeature } from './types';
import type { ParamDef } from './expr';
import type { EdgeMeta, FaceMeta } from '../core/kernel-types';

export const PLANES: Record<Exclude<PlaneRef, 'custom'>, SketchPlane> = {
  front: DEFAULT_PLANE,
  top: TOP_PLANE,
  right: RIGHT_PLANE,
};

export function planeOf(f: SketchFeature): SketchPlane {
  if (f.params.plane === 'custom' && f.params.customPlane) return f.params.customPlane;
  return PLANES[f.params.plane as Exclude<PlaneRef, 'custom'>] ?? DEFAULT_PLANE;
}

export interface EvalOut {
  shape: any;
  tool?: any;
  added?: any;
}

export function worldFromSketch(pl: SketchPlane, x: number, y: number): [number, number, number] {
  return [
    pl.origin[0] + pl.u[0] * x + pl.v[0] * y,
    pl.origin[1] + pl.u[1] * x + pl.v[1] * y,
    pl.origin[2] + pl.u[2] * x + pl.v[2] * y,
  ];
}

// ---------- 基准面辅助（纯数据，供 UI 计算 / 测试） ----------
type Vec3 = [number, number, number];

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 由面（质心 + 法向）构造一个正交草图平面，局部 +Z = 面外法向 */
export function planeFromFace(centroid: Vec3, normal: Vec3): SketchPlane {
  const n = norm3(normal);
  const ref: Vec3 = Math.abs(n[2]) > 0.98 ? [0, 1, 0] : [0, 0, 1];
  const u = norm3(cross3(ref, n));
  const v = norm3(cross3(n, u));
  return { origin: [...centroid] as Vec3, u, v, normal: n, ref: 'custom' };
}

/** 沿法向偏移一个平面（正方向 = 外法向） */
export function offsetPlane(base: SketchPlane, distance: number): SketchPlane {
  const n = base.normal;
  return {
    ...base,
    origin: [
      base.origin[0] + n[0] * distance,
      base.origin[1] + n[1] * distance,
      base.origin[2] + n[2] * distance,
    ],
  };
}

/** 绕单位轴 k 旋转向量 v（Rodrigues 公式），纯 3D 数学 */
export function rotateAbout(v: Vec3, k: Vec3, angRad: number): Vec3 {
  const kk = norm3(k);
  const c = Math.cos(angRad);
  const s = Math.sin(angRad);
  const kv = cross3(kk, v);
  const kd = kk[0] * v[0] + kk[1] * v[1] + kk[2] * v[2];
  return [
    v[0] * c + kv[0] * s + kk[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + kk[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + kk[2] * kd * (1 - c),
  ];
}

/**
 * 平行面：与基准面同法向、过给定世界点（SolidWorks 的"平行平面"）。
 * 局部基沿用基准面，仅平移原点。
 */
export function parallelPlane(base: SketchPlane, through: Vec3): SketchPlane {
  return { ...base, origin: [...through] as Vec3 };
}

/**
 * 成角度面：绕基准面内轴（u 或 v）旋转基准法向 angleDeg 度。
 * 旋转轴保持在平面内，故作为新平面的局部 U 轴（右手系 u×v=n）。
 */
export function angledPlane(base: SketchPlane, angleDeg: number, axis: 'u' | 'v' = 'u'): SketchPlane {
  const k = norm3(axis === 'u' ? base.u : base.v);
  const n = norm3(rotateAbout(base.normal, k, (angleDeg * Math.PI) / 180));
  const v = norm3(cross3(n, k));
  return { origin: [...base.origin] as Vec3, u: k, v, normal: n, ref: 'custom' };
}

/** 垂直面：绕基准面内轴旋转 90°（成角度面的特例） */
export function perpendicularPlane(base: SketchPlane, axis: 'u' | 'v' = 'u'): SketchPlane {
  return angledPlane(base, 90, axis);
}

export class CadDocument {
  features: Feature[] = [];
  /**
   * 全局命名参数（参考 FreeCAD 的 Spreadsheet 别名）。
   * 表达式中直接用参数名引用；参数本身也可以写成引用其他参数的表达式。
   */
  params: ParamDef[] = [];
  /** 每个特征求值后的实体（仅 Worker 重放时填充；主线程一般留空） */
  evalCache = new Map<FeatureId, EvalOut>();
  /** 全局重建计数 */
  rebuildCount = 0;
  /** 命名计数器 */
  private counters: Record<string, number> = {};

  getFeature(id: FeatureId): Feature | undefined {
    return this.features.find((f) => f.id === id);
  }

  /** 按名称找特征（表达式引用用；重名取第一个） */
  getFeatureByName(name: string): Feature | undefined {
    return this.features.find((f) => f.name === name);
  }

  getParam(name: string): ParamDef | undefined {
    return this.params.find((p) => p.name === name);
  }

  /** 新增/更新一个全局参数 */
  setParam(name: string, expr: string, comment?: string): ParamDef {
    const exist = this.getParam(name);
    if (exist) {
      exist.expr = expr;
      if (comment !== undefined) exist.comment = comment;
      return exist;
    }
    const def: ParamDef = { name, expr };
    if (comment !== undefined) def.comment = comment;
    this.params.push(def);
    return def;
  }

  removeParam(name: string): boolean {
    const i = this.params.findIndex((p) => p.name === name);
    if (i < 0) return false;
    this.params.splice(i, 1);
    return true;
  }

  indexOf(id: FeatureId): number {
    return this.features.findIndex((f) => f.id === id);
  }

  nextName(type: string): string {
    const n = (this.counters[type] ?? 0) + 1;
    this.counters[type] = n;
    const labels: Record<string, string> = {
      sketch: '草图',
      extrude: '拉伸',
      revolve: '旋转',
      loft: '放样',
      sweep: '扫描',
      fillet: '圆角',
      chamfer: '倒角',
      shell: '抽壳',
      primitive: '基本体',
      linearPattern: '线性阵列',
      circularPattern: '圆周阵列',
      mirror: '镜像',
      referencePlane: '基准面',
      hole: '孔',
      draft: '拔模',
      rib: '筋',
      spring: '弹簧',
      spiral: '涡状线',
      scale: '缩放',
      split: '分割',
      moveBody: '移动/复制实体',
      deleteBody: '删除实体',
      combine: '组合',
      surfaceExtrude: '拉伸曲面',
      surfaceRevolve: '旋转曲面',
      surfacePlanar: '平面区域',
      surfaceLoft: '放样曲面',
      surfaceSweep: '扫描曲面',
      surfaceTrim: '裁剪曲面',
      surfaceSew: '缝合曲面',
    };
    return `${labels[type] ?? type}${n}`;
  }

  add(f: Feature, at?: number): Feature {
    if (at === undefined || at >= this.features.length) this.features.push(f);
    else this.features.splice(Math.max(0, at), 0, f);
    return f;
  }

  remove(id: FeatureId): void {
    const i = this.indexOf(id);
    if (i >= 0) this.features.splice(i, 1);
  }

  move(id: FeatureId, delta: number): void {
    const i = this.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.features.length) return;
    const [f] = this.features.splice(i, 1);
    this.features.splice(j, 0, f);
  }

  before(id: FeatureId): Feature[] {
    const i = this.indexOf(id);
    return i < 0 ? this.features.slice() : this.features.slice(0, i);
  }

  shapeAfter(id: FeatureId): any {
    return this.evalCache.get(id)?.shape ?? null;
  }

  shapeBefore(id: FeatureId): any {
    const i = this.indexOf(id);
    if (i <= 0) return null;
    return this.evalCache.get(this.features[i - 1].id)?.shape ?? null;
  }

  sketchFeatures(): SketchFeature[] {
    return this.features.filter((f): f is SketchFeature => f.type === 'sketch');
  }

  /** 产出曲面实体（壳）的特征，供「裁剪曲面 / 缝合曲面」列出可选曲面体 */
  surfaceFeatures(): Feature[] {
    return this.features.filter(
      (f) => f.type === 'surfaceExtrude' || f.type === 'surfaceRevolve' ||
        f.type === 'surfacePlanar' || f.type === 'surfaceLoft' || f.type === 'surfaceSweep' ||
        f.type === 'surfaceTrim' || f.type === 'surfaceSew',
    );
  }

  toJSON(): any {
    return {
      version: 2,
      params: this.params.map((p) => ({ ...p })),
      features: this.features.map((f) => ({ ...f, error: undefined })),
    };
  }

  static fromJSON(data: any): CadDocument {
    const d = new CadDocument();
    if (Array.isArray(data?.params)) {
      d.params = data.params
        .filter((p: any) => p && typeof p.name === 'string' && typeof p.expr === 'string')
        .map((p: any) => ({ name: p.name, expr: p.expr, ...(p.comment ? { comment: p.comment } : {}) }));
    }
    if (data?.features?.length) {
      d.features = data.features as Feature[];
      for (const f of d.features) {
        const m = /(\d+)$/.exec(f.name ?? '');
        const n = m ? parseInt(m[1], 10) : 0;
        d.counters[f.type] = Math.max(d.counters[f.type] ?? 0, n);
      }
    }
    return d;
  }

  clone(): CadDocument {
    return CadDocument.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
  }
}

/** 由当前面元数据生成一个面引用（用于 UI 拾取后记录） */
export function makeFaceRef(info: FaceMeta): { point: [number, number, number]; normal: [number, number, number] } {
  return { point: [...info.centroid], normal: [...info.normal] };
}

/** 由当前边元数据生成一个边引用 */
export function makeEdgeRef(info: EdgeMeta): { point: [number, number, number]; dir: [number, number, number] } {
  return { point: [...info.mid], dir: [...info.dir] };
}

export function newSketchFeature(plane: PlaneRef, sketch?: Sketch): SketchFeature {
  return {
    id: newId('f'),
    type: 'sketch',
    name: '草图',
    params: { plane, sketch: sketch ?? { entities: [], points: {}, constraints: [] } },
  };
}
