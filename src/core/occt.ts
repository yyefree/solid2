/**
 * OCCT 内核接入层。
 *
 * ⚠️ 重要：opencascade.js 用 `_1/_2/...` 后缀区分重载，且没有文档、没有类型提示，
 * 序号与 OCCT 头文件里的声明顺序并不直观对应。下面所有工厂/调用形式都是在 Node 侧
 * 用 tools/probe*.mjs（共 10 轮）实测确认过的。**不要凭直觉改写重载序号**，
 * 写错会静默绑定到另一个重载，或者抛出难以定位的 embind 错误。
 *
 * 已实测确认（括号内为验证过的体积结果）：
 *   gp_Pnt_3(x,y,z) / gp_Vec_4 / gp_Dir_4 / gp_Ax1_2(pnt,dir) / gp_Ax2_3(pnt,dir)
 *   gp_Trsf_1 + SetValues(12) / SetTranslation_1(vec) / SetRotation_1(ax1,ang) / Invert()
 *   BRepPrimAPI_MakeBox_1(dx,dy,dz) / _3(pnt,pnt)
 *   BRepPrimAPI_MakeCylinder_1(R,H) / _2(R,H,ang) / _3(ax2,R,H)
 *   BRepPrimAPI_MakeSphere_1(R) / _2(R,ang)
 *   BRepPrimAPI_MakeCone_1(R1,R2,H)          [体积 544.54 精确]
 *   BRepPrimAPI_MakeTorus_1(R1,R2)           [体积 789.57 精确]
 *   BRepPrimAPI_MakePrism_1(face, vec, true, true)
 *   BRepPrimAPI_MakeRevol_1(face, ax1, ang, true)   [体积 1005.31 精确]
 *   BRepBuilderAPI_MakeFace_15(wire, false)   ← 注意是 _15，不是 _4
 *   BRepAlgoAPI_{Cut,Fuse,Common}_3(a, b) + .Build()（Build 不接受参数）
 *   BRepFilletAPI_MakeFillet(shape, ChFi3d_FilletShape) + .Add_2(r, edge)
 *   BRepFilletAPI_MakeChamfer(shape) + .Add_2(d, edge)
 *   BRepOffsetAPI_MakeThickSolid_2(shape, faceList, offset, tol, mode, false, false, join, false)
 *   BRepOffsetAPI_ThruSections(isSolid, ruled, tol) + .AddWire() + .Build()
 *   BRepOffsetAPI_MakePipe_2(spineWire, profileFace, trihedron, bool)
 *   BRepMesh_IncrementalMesh_2(shape, linDefl, isRelative, angDefl, isParallel)
 *   BRep_Tool.Triangulation(face, loc) → Handle，必须 .get() 才拿到 Poly_Triangulation
 *   Poly_Triangle.Value(1|2|3) → 节点索引（1-based）
 *   BRepAdaptor_Curve_2(edge) + FirstParameter/LastParameter/D0(t, pnt)
 *   BRepGProp.VolumeProperties_1(shape, props, false,false,false) / SurfaceProperties_1(shape, props, false,false)
 *   STEPControl_Writer_1().Transfer(shape, mode, true).Write('/x.step') → oc.FS.readFile('/x.step')
 *   STEPControl_Reader_1().ReadFile('/x.step').TransferRoots().OneShape()
 *
 * 已知缺失：HLRBRep_Algo / HLRBRep_HLRToShape 未导出 → 工程图隐藏线要自己算（见 edges.ts）。
 */

export type Occt = any;

let _oc: Occt | null = null;

export function setOcct(oc: Occt): void {
  _oc = oc;
}
export function oc(): Occt {
  if (!_oc) throw new Error('OCCT 内核尚未初始化');
  return _oc;
}
export function isReady(): boolean {
  return _oc !== null;
}

// ============================================================
// 枚举
// ============================================================
export const ShapeEnum = {
  COMPOUND: 'TopAbs_COMPOUND',
  COMPSOLID: 'TopAbs_COMPSOLID',
  SOLID: 'TopAbs_SOLID',
  SHELL: 'TopAbs_SHELL',
  FACE: 'TopAbs_FACE',
  WIRE: 'TopAbs_WIRE',
  EDGE: 'TopAbs_EDGE',
  VERTEX: 'TopAbs_VERTEX',
  SHAPE: 'TopAbs_SHAPE',
} as const;

export type ShapeKind = 'COMPOUND' | 'SOLID' | 'SHELL' | 'FACE' | 'WIRE' | 'EDGE' | 'VERTEX' | 'SHAPE';

const SHAPE_TYPE_NAMES: Record<number, ShapeKind> = {
  0: 'COMPOUND',
  1: 'SOLID', // COMPSOLID 极少用，归入 SOLID 处理
  2: 'SOLID',
  3: 'SHELL',
  4: 'FACE',
  5: 'WIRE',
  6: 'EDGE',
  7: 'VERTEX',
  8: 'SHAPE',
};

/**
 * embind 的枚举返回值不是数字，而是带 `.value` 的包装对象（如 ShapeType() → {value:4}）。
 * 统一用这个函数取出底层整数，避免 `SHAPE_TYPE_NAMES[obj]` 静默失效。
 */
export function enumValue(e: any): number {
  if (typeof e === 'number') return e;
  if (e && typeof e.value === 'number') return e.value;
  return NaN;
}

export function shapeKind(shape: any): ShapeKind {
  if (!shape || shape.IsNull()) return 'SHAPE';
  return SHAPE_TYPE_NAMES[enumValue(shape.ShapeType())] ?? 'SHAPE';
}

export function topAbsEnum(kind: keyof typeof ShapeEnum) {
  return oc().TopAbs_ShapeEnum[ShapeEnum[kind]];
}

/**
 * 按 IsSame 去重。
 *
 * ⚠️ OCCT 的 TopExp_Explorer 是按"出现次数"遍历的：一条被两个面共享的边会被访问两次
 * （长方体 12 条棱会返回 24 条、8 个顶点会返回 48 个）。凡是拿拓扑子形状做数量统计、
 * 遍历显示或作为算子输入的地方，都必须先去重，否则圆角会对同一条边加两次。
 */
export function dedupShapes(shapes: any[]): any[] {
  const out: any[] = [];
  for (const s of shapes) {
    if (!out.some((o) => o.IsSame(s))) out.push(s);
  }
  return out;
}

// ============================================================
// 基础几何量
// ============================================================
export const gp = {
  Pnt: (x = 0, y = 0, z = 0) => new (oc().gp_Pnt_3)(x, y, z),
  Pnt0: () => new (oc().gp_Pnt_1)(),
  Vec: (x = 0, y = 0, z = 0) => new (oc().gp_Vec_4)(x, y, z),
  Dir: (x = 0, y = 0, z = 1) => new (oc().gp_Dir_4)(x, y, z),
  Ax1: (p: any, d: any) => new (oc().gp_Ax1_2)(p, d),
  Ax2: (p: any, d: any) => new (oc().gp_Ax2_3)(p, d),
  Circ: (ax2: any, r: number) => new (oc().gp_Circ_2)(ax2, r),
  Pln: (point: [number, number, number], dir: [number, number, number]) =>
    new (oc().gp_Pln_3)(new (oc().gp_Pnt_3)(point[0], point[1], point[2]), new (oc().gp_Dir_4)(dir[0], dir[1], dir[2])),
  Trsf: () => new (oc().gp_Trsf_1)(),
};

/** 由 3×4 仿射矩阵（行主序 12 个数）构造 gp_Trsf */
export function trsfFromMatrix(m: number[]): any {
  const t = gp.Trsf();
  t.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]);
  return t;
}

/** 平移变换 */
export function trsfTranslate(x: number, y: number, z: number): any {
  const t = gp.Trsf();
  t.SetTranslation_1(gp.Vec(x, y, z));
  return t;
}

/** 绕任意轴旋转 */
export function trsfRotate(origin: [number, number, number], dir: [number, number, number], angle: number): any {
  const t = gp.Trsf();
  t.SetRotation_1(gp.Ax1(gp.Pnt(...origin), gp.Dir(...dir)), angle);
  return t;
}

/** 关于平面（点 + 法向）镜像。反射矩阵行列式为 -1，gp_Trsf 支持。 */
export function trsfMirrorPlane(point: [number, number, number], normal: [number, number, number]): any {
  const n = normalize(normal);
  const [nx, ny, nz] = n;
  const [px, py, pz] = point;
  const d = nx * px + ny * py + nz * pz;
  // R = I - 2nnᵀ ; t = 2·d·n
  return trsfFromMatrix([
    1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz, 2 * d * nx,
    -2 * ny * nx, 1 - 2 * ny * ny, -2 * ny * nz, 2 * d * ny,
    -2 * nz * nx, -2 * nz * ny, 1 - 2 * nz * nz, 2 * d * nz,
  ]);
}

/** 欧拉角（弧度）+ 平移 → gp_Trsf。旋转顺序 Rz·Ry·Rx。 */
export function trsfEuler(rx: number, ry: number, rz: number, pos: [number, number, number] = [0, 0, 0]): any {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Rz * Ry * Rx
  const r = [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
  return trsfFromMatrix([
    r[0], r[1], r[2], pos[0],
    r[3], r[4], r[5], pos[1],
    r[6], r[7], r[8], pos[2],
  ]);
}

/** gp_Trsf → 3×4 行主序数组 */
export function trsfToMatrix(t: any): number[] {
  const out: number[] = [];
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 4; j++) out.push(t.Value(i, j));
  return out;
}

export function trsfIsIdentity(t: any): boolean {
  return enumValue(t.Form()) === 0;
}

// ============================================================
// 小工具
// ============================================================
export function normalize(v: [number, number, number]): [number, number, number] {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

export function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}
export function rad2deg(r: number): number {
  return (r * 180) / Math.PI;
}
