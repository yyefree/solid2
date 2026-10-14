/**
 * 文档数据模型 —— 特征树的定义。
 *
 * 参考基准（边/面）采用"几何命名"方案：记录特征创建时该边/面的代表点与法向，
 * 重建时在最新拓扑里找最接近的一个。这是应对拓扑命名问题的实用做法——
 * 参数小幅变化时引用稳定，且实现简单、不会出现"引用丢失"的崩溃。
 */
import type { Sketch, SketchPlane } from '../sketch/types';

export type FeatureId = string;

/** 基准面标识 */
export type PlaneRef = 'front' | 'top' | 'right' | 'custom';

export interface EdgeRef {
  /** 边中点（世界坐标） */
  point: [number, number, number];
  /** 边方向（单位向量），用于区分共点的多条边 */
  dir?: [number, number, number];
}

export interface FaceRef {
  /** 面质心（世界坐标） */
  point: [number, number, number];
  /** 面法向 */
  normal?: [number, number, number];
}

export type BooleanOp = 'new' | 'add' | 'cut' | 'intersect';

export interface FeatureBase {
  id: FeatureId;
  type: string;
  name: string;
  suppressed?: boolean;
  /** 求值失败时的错误信息（由引擎写入，不参与序列化比较） */
  error?: string;
  /**
   * 参数表达式（参考 FreeCAD 的 Expressions）。
   * 键 = 参数的**路径**（如 `distance` / `dims[0]`），值 = 表达式文本（可带 `=` 前缀）。
   * 重建前由 `resolveExpressions` 求值并覆盖 `params` 中对应字段，
   * 因此下游几何代码始终只看到具体数值。
   */
  expressions?: Record<string, string>;
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  params: {
    plane: PlaneRef;
    /** 自定义平面的几何（plane === 'custom' 时使用） */
    customPlane?: SketchPlane;
    sketch: Sketch;
  };
}

/** 拉伸起始条件（SW「从」下拉） */
export type ExtrudeStartCondition = 'sketchPlane' | 'offset';
/** 拉伸终止条件（SW「方向 1」下拉） */
export type ExtrudeEndCondition = 'blind' | 'upToVertex' | 'upToSurface' | 'throughAll' | 'midPlane';
/** 拉伸方向 2 终止条件（简版） */
export type ExtrudeEnd2Condition = 'none' | 'blind' | 'throughAll';

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  params: {
    sketchId: FeatureId;
    distance: number;
    /** 对称拉伸（等价于 endCondition='midPlane'） */
    symmetric?: boolean;
    /** 反向 */
    reverse?: boolean;
    /** 拔模角（度），0 表示无 */
    draft?: number;
    operation: BooleanOp;
    // ---- SW 式拉伸条件（第十三轮）----
    /** 起始条件（SW「从」下拉）：草图基准面（默认）/ 等距 */
    start?: ExtrudeStartCondition;
    /** start='offset'：沿草图法向的偏移距离 */
    startOffset?: number;
    /** start='offset'：偏移反向 */
    startReverse?: boolean;
    /** 终止条件（方向 1，SW「方向 1」下拉），默认 'blind' 给定深度 */
    endCondition?: ExtrudeEndCondition;
    /** endCondition='upToVertex'：目标顶点（世界坐标） */
    vertex?: [number, number, number];
    /** endCondition='upToSurface'：目标面引用 */
    targetFace?: FaceRef;
    /** 方向 2 终止条件（SW「方向 2」下拉），默认 'none' 不向反向拉伸 */
    end2?: ExtrudeEnd2Condition;
    /** 方向 2 深度（end2='blind'） */
    distance2?: number;
  };
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  params: {
    sketchId: FeatureId;
    /** 旋转轴（草图局部坐标下的两点） */
    axisA: [number, number];
    axisB: [number, number];
    angleDeg: number;
    reverse?: boolean;
    operation: BooleanOp;
  };
}

export interface LoftFeature extends FeatureBase {
  type: 'loft';
  params: {
    /** 多个草图轮廓 */
    sketchIds: FeatureId[];
    ruled?: boolean;
    operation: BooleanOp;
  };
}

export interface SweepFeature extends FeatureBase {
  type: 'sweep';
  params: {
    profileSketchId: FeatureId;
    pathSketchId: FeatureId;
    operation: BooleanOp;
  };
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  params: {
    edges: EdgeRef[];
    radius: number;
    /** 变半径圆角：给值且与 `radius` 不同时，半径沿边从 radius 过渡到 radius2 */
    radius2?: number;
  };
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  params: {
    edges: EdgeRef[];
    distance: number;
  };
}

export interface ShellFeature extends FeatureBase {
  type: 'shell';
  params: {
    faces: FaceRef[];
    thickness: number;
  };
}

export interface PrimitiveFeature extends FeatureBase {
  type: 'primitive';
  params: {
    kind: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';
    /** box: [dx,dy,dz] / cylinder: [r,h] / sphere: [r] / cone: [r1,r2,h] / torus: [r1,r2] */
    dims: number[];
    /** 放置原点 */
    origin?: [number, number, number];
    operation?: BooleanOp;
  };
}

export interface LinearPatternFeature extends FeatureBase {
  type: 'linearPattern';
  params: {
    /** 被阵列的特征（若为空则阵列"上一特征"） */
    seedFeatureId?: FeatureId;
    direction: [number, number, number];
    spacing: number;
    count: number;
  };
}

export interface CircularPatternFeature extends FeatureBase {
  type: 'circularPattern';
  params: {
    seedFeatureId?: FeatureId;
    axisOrigin: [number, number, number];
    axisDir: [number, number, number];
    count: number;
    totalAngleDeg: number;
    /** 等间距（否则按总角度均分） */
    equalSpacing?: boolean;
  };
}

export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  params: {
    seedFeatureId?: FeatureId;
    planePoint: [number, number, number];
    planeNormal: [number, number, number];
  };
}

export type ReferencePlaneKind = 'offset' | 'parallel' | 'perpendicular' | 'angle';

export interface ReferencePlaneFeature extends FeatureBase {
  type: 'referencePlane';
  params: {
    kind: ReferencePlaneKind;
    /** 生成的基准面（创建时计算并存为数据，引擎透传、供草图复用） */
    plane: SketchPlane;
    /** 偏移/角度参数（仅用于树上显示） */
    distance?: number;
    angleDeg?: number;
    axis?: [number, number, number];
    /** 基准来源面（用于树上显示） */
    baseRef?: FaceRef;
  };
}

export type HoleType = 'simple' | 'counterbore' | 'countersink' | 'threaded';

export interface HoleFeature extends FeatureBase {
  type: 'hole';
  params: {
    /** 放置面（重建时用于解析；实际平面由 plane 给出） */
    face?: FaceRef;
    /** 放置平面（创建时从选中面计算） */
    plane: SketchPlane;
    /** 孔内位置（平面局部坐标 u,v；默认 0,0 = 面质心） */
    pos: [number, number];
    type: HoleType;
    diameter: number;
    /** 盲孔深度；通孔时忽略 */
    depth: number;
    through: boolean;
    /** 沉头：沉头直径 / 沉头深度 */
    boreDiameter?: number;
    boreDepth?: number;
    /** 埋头：埋头直径 / 埋头深度 */
    sinkDiameter?: number;
    sinkDepth?: number;
  };
}

export interface DraftFeature extends FeatureBase {
  type: 'draft';
  params: {
    neutralFace: FaceRef;
    draftFaces: FaceRef[];
    angleDeg: number;
    /** 反向（向内/向外互换） */
    reverse?: boolean;
  };
}

export interface RibFeature extends FeatureBase {
  type: 'rib';
  params: {
    sketchId: FeatureId;
    thickness: number;
    /** 沿草图法向的拉伸深度 */
    depth?: number;
    /** 对称（沿草图法向两侧各半） */
    symmetric?: boolean;
  };
}

/** 螺旋旋向 */
export type CoilHandedness = 'right' | 'left';

/**
 * 弹簧：圆截面沿螺旋线放样成实体。
 * 用「逐站圆截面 + 放样」实现——实测比 OCCT 的 MakePipe/MakePipeShell 在
 * 本绑定下可靠得多（体积与解析值吻合到 0.1% 以内）。
 */
export interface SpringFeature extends FeatureBase {
  type: 'spring';
  params: {
    /** 螺旋轴起点（轴线上一点） */
    origin: [number, number, number];
    /** 螺旋轴方向 */
    axis: [number, number, number];
    /** 中径 = 外径 − 线径 */
    meanDiameter: number;
    /** 线径 */
    wireDiameter: number;
    /** 螺距（每圈轴向进给） */
    pitch: number;
    /** 有效圈数 */
    turns: number;
    handedness: CoilHandedness;
    /** 锥度（度）：半径沿轴向线性变化，0 = 圆柱弹簧 */
    taperDeg?: number;
    /** 每圈采样段数（越大越光滑，默认 24） */
    segmentsPerTurn?: number;
    operation: BooleanOp;
  };
}

/**
 * 涡状线带材（涡卷弹簧 / 发条）：平面阿基米德螺线加厚成闭合轮廓，再沿法向拉伸。
 */
export interface SpiralFeature extends FeatureBase {
  type: 'spiral';
  params: {
    /** 所在平面（默认前视基准面） */
    plane: SketchPlane;
    /** 起始半径（带材中线） */
    startRadius: number;
    /** 每圈径向增量 */
    pitch: number;
    turns: number;
    /** 带材径向厚度 */
    thickness: number;
    /** 带材宽度（沿平面法向） */
    width: number;
    handedness: CoilHandedness;
    /** 沿法向两侧对称拉伸 */
    symmetric?: boolean;
    operation: BooleanOp;
  };
}

/** 缩放（SolidWorks「缩放比例」）：以 center 为中心，各轴分别乘系数 */
export interface ScaleFeature extends FeatureBase {
  type: 'scale';
  params: {
    /** 缩放中心（不动点） */
    center: [number, number, number];
    /** 统一缩放系数 */
    factor: number;
    /** 是否启用非均匀缩放（启用时用 factors，忽略 factor） */
    nonUniform?: boolean;
    /** 非均匀时各轴系数 [x, y, z] */
    factors?: [number, number, number];
  };
}

export type SplitKeep = 'both' | 'positive' | 'negative';

/** 分割（SolidWorks「分割」）：用一个平面把实体切成多块 */
export interface SplitFeature extends FeatureBase {
  type: 'split';
  params: {
    /** 切割平面 */
    plane: SketchPlane;
    /** 保留哪一侧：两侧 / 法向正侧 / 法向负侧 */
    keep: SplitKeep;
  };
}

/**
 * 移动/复制实体（SolidWorks「移动/复制实体」）。
 * 先绕 `axisOrigin`+`axisDir` 定义的轴旋转 `angleDeg`，再平移 `delta`。
 * `copy` 为真时保留原件并生成 `count` 份副本（第 i 份施加 i 倍变换）。
 */
export interface MoveBodyFeature extends FeatureBase {
  type: 'moveBody';
  params: {
    /** 平移量 [x, y, z] */
    delta: [number, number, number];
    /** 旋转轴起点 */
    axisOrigin: [number, number, number];
    /** 旋转轴方向 */
    axisDir: [number, number, number];
    /** 旋转角度（度） */
    angleDeg: number;
    /** 是否复制（否则原地移动） */
    copy?: boolean;
    /** 复制份数（含原件共 count 份；copy 为假时忽略） */
    count?: number;
    /** 作用在哪些实体上（下标 0 起）；省略或为空表示全部实体 */
    indices?: number[];
  };
}

/** 删除实体（SolidWorks「删除实体」）：从多实体中移除指定的实体 */
export interface DeleteBodyFeature extends FeatureBase {
  type: 'deleteBody';
  params: {
    /** 要删除的实体下标（0 起，顺序同 bodiesOf 的展开顺序） */
    indices: number[];
  };
}

export type CombineOp = 'add' | 'subtract' | 'common';

/** 组合（SolidWorks「组合」）：把多个实体按布尔操作合成一个 */
export interface CombineFeature extends FeatureBase {
  type: 'combine';
  params: {
    /** 主体（目标实体）下标 */
    mainIndex: number;
    /** 工具体下标列表 */
    toolIndices: number[];
    /** 添加（并集）/ 减除（差集）/ 共同（交集） */
    operation: CombineOp;
  };
}

// ============================================================
// 曲面特征（SolidWorks「曲面」页签）—— 生成**曲面实体**（壳），不参与实体布尔
// ============================================================
/** 拉伸曲面：草图轮廓沿法向拉伸成曲面 */
export interface SurfaceExtrudeFeature extends FeatureBase {
  type: 'surfaceExtrude';
  params: {
    sketchId: FeatureId;
    distance: number;
    /** 对称（两侧各半） */
    symmetric?: boolean;
    /** 反向 */
    reverse?: boolean;
  };
}

/** 旋转曲面：草图轮廓绕轴旋转成曲面 */
export interface SurfaceRevolveFeature extends FeatureBase {
  type: 'surfaceRevolve';
  params: {
    sketchId: FeatureId;
    /** 旋转轴（草图局部坐标下的两点） */
    axisA: [number, number];
    axisB: [number, number];
    angleDeg: number;
    reverse?: boolean;
  };
}

/** 平面区域：把闭合草图轮廓填成一个平面曲面 */
export interface SurfacePlanarFeature extends FeatureBase {
  type: 'surfacePlanar';
  params: {
    sketchId: FeatureId;
  };
}

/** 放样曲面：多个草图截面蒙皮成曲面（不封顶、不成实体） */
export interface SurfaceLoftFeature extends FeatureBase {
  type: 'surfaceLoft';
  params: {
    /** 参与放样的截面草图（按顺序） */
    sketchIds: FeatureId[];
    /** 直纹面（截面间线性过渡），默认平滑 */
    ruled?: boolean;
  };
}

/** 扫描曲面：轮廓草图沿路径草图扫成曲面（不封顶、不成实体） */
export interface SurfaceSweepFeature extends FeatureBase {
  type: 'surfaceSweep';
  params: {
    profileSketchId: FeatureId;
    pathSketchId: FeatureId;
  };
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | LoftFeature
  | SweepFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | PrimitiveFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature
  | ReferencePlaneFeature
  | HoleFeature
  | DraftFeature
  | RibFeature
  | SpringFeature
  | SpiralFeature
  | ScaleFeature
  | SplitFeature
  | MoveBodyFeature
  | DeleteBodyFeature
  | CombineFeature
  | SurfaceExtrudeFeature
  | SurfaceRevolveFeature
  | SurfacePlanarFeature
  | SurfaceLoftFeature
  | SurfaceSweepFeature;

export const FEATURE_LABEL: Record<string, string> = {
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
};

export const FEATURE_ICON: Record<string, string> = {
  sketch: 'sketch',
  extrude: 'extrude',
  revolve: 'revolve',
  loft: 'loft',
  sweep: 'sweep',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  primitive: 'box',
  linearPattern: 'linearPattern',
  circularPattern: 'circularPattern',
  mirror: 'mirror',
  referencePlane: 'plane',
  hole: 'hole',
  draft: 'draft',
  rib: 'rib',
  spring: 'spring',
  spiral: 'spiral',
  scale: 'scale',
  split: 'split',
  moveBody: 'moveBody',
  deleteBody: 'deleteBody',
  combine: 'combine',
  surfaceExtrude: 'surface',
  surfaceRevolve: 'surface',
  surfacePlanar: 'surface',
  surfaceLoft: 'surface',
  surfaceSweep: 'surface',
};

export function isSketch(f: Feature): f is SketchFeature {
  return f.type === 'sketch';
}
