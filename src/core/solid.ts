/**
 * 实体建模操作层 —— 把 OCCT 的算子封装成 CAD 语义。
 * 所有函数接收/返回 TopoDS_Shape 裸对象。
 */
import { oc, gp, topAbsEnum, shapeKind, trsfFromMatrix, dedupShapes, normalize, type ShapeKind } from './occt';

export type Shape = any;
export type Edge = any;
export type Face = any;
export type Wire = any;

/**
 * 包裹一次 OCCT 调用，把「C++ 异常穿透 wasm 边界」产生的 emscripten 内部噪声
 * （典型：`___cxa_is_pointer_type is not defined`）翻译成可读的中文错误。
 *
 * 背景：OCCT 的某些算子（实测最典型的是 `BRepFilletAPI_MakeFillet::Build`）在参数
 * 几何上不可行时会直接抛 C++ 异常，而本 wasm 绑定没有链接异常解栈符号，于是 JS 侧
 * 只能看到一句毫无意义的 `___cxa_is_pointer_type is not defined`。
 *
 * 实测这种异常**不会破坏 wasm 运行时状态**（抛错后同实例内新建文档求值、原文档改参数
 * 重算全部正常），所以只需翻译信息，无需熔断或重建内核。
 */
function guardOc<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/___cxa_is_pointer_type|__cxa_|is not defined/.test(msg)) {
      throw new Error(`${what}：几何条件不满足（尺寸/半径过大，或与相邻面冲突）`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

// ============================================================
// 拓扑遍历
// ============================================================
export function explode(shape: Shape, kind: 'FACE' | 'EDGE' | 'WIRE' | 'VERTEX' | 'SOLID' | 'SHELL'): Shape[] {
  const o = oc();
  const out: Shape[] = [];
  if (!shape || shape.IsNull()) return out;
  const ex = new o.TopExp_Explorer_2(shape, topAbsEnum(kind), topAbsEnum('SHAPE'));
  const conv: Record<string, (s: any) => any> = {
    FACE: (s) => o.TopoDS.Face_1(s),
    EDGE: (s) => o.TopoDS.Edge_1(s),
    WIRE: (s) => o.TopoDS.Wire_1(s),
    VERTEX: (s) => o.TopoDS.Vertex_1(s),
    SOLID: (s) => o.TopoDS.Solid_1(s),
    SHELL: (s) => o.TopoDS.Shell_1(s),
  };
  while (ex.More()) {
    out.push(conv[kind](ex.Current()));
    ex.Next();
  }
  // 共享子形状会被 explorer 重复访问，必须去重
  return dedupShapes(out);
}

export const faces = (s: Shape) => explode(s, 'FACE');
export const edges = (s: Shape) => explode(s, 'EDGE');
export const wires = (s: Shape) => explode(s, 'WIRE');
export const vertices = (s: Shape) => explode(s, 'VERTEX');
export const solids = (s: Shape) => explode(s, 'SOLID');

/** 统计拓扑数量 */
export function topologyCount(shape: Shape) {
  return {
    solids: explode(shape, 'SOLID').length,
    faces: explode(shape, 'FACE').length,
    edges: explode(shape, 'EDGE').length,
    vertices: explode(shape, 'VERTEX').length,
  };
}

// ============================================================
// 基本体
// ============================================================
export const primitives = {
  box(dx: number, dy: number, dz: number, centered = false): Shape {
    const o = oc();
    if (!centered) return new o.BRepPrimAPI_MakeBox_1(dx, dy, dz).Shape();
    return new o.BRepPrimAPI_MakeBox_3(
      gp.Pnt(-dx / 2, -dy / 2, -dz / 2),
      gp.Pnt(dx / 2, dy / 2, dz / 2)
    ).Shape();
  },

  cylinder(radius: number, height: number, centered = false): Shape {
    const o = oc();
    if (!centered) return new o.BRepPrimAPI_MakeCylinder_1(radius, height).Shape();
    const ax2 = gp.Ax2(gp.Pnt(0, 0, -height / 2), gp.Dir(0, 0, 1));
    return new o.BRepPrimAPI_MakeCylinder_3(ax2, radius, height).Shape();
  },

  cylinderOn(origin: [number, number, number], dir: [number, number, number], radius: number, height: number): Shape {
    const o = oc();
    const ax2 = gp.Ax2(gp.Pnt(...origin), gp.Dir(...dir));
    return new o.BRepPrimAPI_MakeCylinder_3(ax2, radius, height).Shape();
  },

  sphere(radius: number): Shape {
    return new (oc().BRepPrimAPI_MakeSphere_1)(radius).Shape();
  },

  cone(r1: number, r2: number, height: number): Shape {
    return new (oc().BRepPrimAPI_MakeCone_1)(r1, r2, height).Shape();
  },

  torus(r1: number, r2: number): Shape {
    return new (oc().BRepPrimAPI_MakeTorus_1)(r1, r2).Shape();
  },
};

// ============================================================
// 线框 / 面
// ============================================================
export function wireFromPoints(pts: [number, number, number][], close = true): Wire {
  const o = oc();
  const poly = new o.BRepBuilderAPI_MakePolygon_1();
  for (const p of pts) poly.Add_1(gp.Pnt(p[0], p[1], p[2]));
  if (close) poly.Close();
  return poly.Wire();
}

/**
 * 圆截面 wire。
 *
 * `xDir` 可选：显式指定圆的**缝合点方向**（`gp_Ax2` 的 X 轴）。
 *
 * ⚠️ 这一点对「圆截面链放样」是决定性的。`gp_Ax2(P, N)` 的 X 轴是按法向自动推导的，
 * 相邻截面的法向略有差异时自动推导出的 X 轴会跳变，于是各截面的缝彼此错位。
 * `BRepOffsetAPI_ThruSections` 为了迁就错位的缝，会把本来一整片的侧面**切成多片**
 * （实测单圈 24 截面：12 面 / 30 边），三角化与质量属性都要多花数倍时间。
 * 由调用方沿路径用平行移动标架搬一个 X 方向进来，缝就全程连续，侧面回到 1 片
 * （实测同参数：3 面 / 3 边，网格 2.6×、质量属性 15× 提速，体积精度不变）。
 */
export function circleWire(
  origin: [number, number, number],
  normal: [number, number, number],
  radius: number,
  xDir?: [number, number, number]
): Wire {
  const o = oc();
  const ax2 = gp.Ax2(gp.Pnt(...origin), gp.Dir(...normal));
  if (xDir) {
    try {
      ax2.SetXDirection(gp.Dir(...xDir));
    } catch {
      /* 绑定缺该方法时退回自动缝（正确性不受影响，只是面数偏多） */
    }
  }
  const edge = new o.BRepBuilderAPI_MakeEdge_8(gp.Circ(ax2, radius)).Edge();
  const w = new o.BRepBuilderAPI_MakeWire_1();
  w.Add_1(edge);
  return w.Wire();
}

export function edgeFromPoints(a: [number, number, number], b: [number, number, number]): Edge {
  const o = oc();
  return new o.BRepBuilderAPI_MakeEdge_8
    ? new o.BRepBuilderAPI_MakeEdge_8(gp.Pnt(...a), gp.Pnt(...b)).Edge()
    : null;
}

export function faceFromWire(wire: Wire): Face {
  const o = oc();
  return new o.BRepBuilderAPI_MakeFace_15(wire, false).Face();
}

export function faceFromPoints(pts: [number, number, number][]): Face {
  return faceFromWire(wireFromPoints(pts, true));
}

/** 由多条 wire 合成一个面（外轮廓 + 内孔） */
export function faceWithHoles(outer: Wire, holes: Wire[] = []): Face {
  const o = oc();
  const mk = new o.BRepBuilderAPI_MakeFace_15(outer, false);
  for (const h of holes) mk.Add(h);
  return mk.Face();
}

// ============================================================
// 成型特征
// ============================================================
export function extrude(profile: Face | Wire, dir: [number, number, number], distance: number, symmetric = false): Shape {
  const o = oc();
  const face = shapeKind(profile) === 'FACE' ? profile : faceFromWire(profile);
  // 对称拉伸：总长 = distance，沿法向两侧各 distance/2（z∈[-d/2, +d/2]）。
  // 先按全长拉出，再沿 -dir 平移 distance/2 使其居中。
  const off = symmetric ? -distance / 2 : 0;
  const vec = gp.Vec(dir[0] * distance, dir[1] * distance, dir[2] * distance);
  const prism = new o.BRepPrimAPI_MakePrism_1(face, vec, true, true).Shape();
  if (symmetric) return translate(prism, dir[0] * off, dir[1] * off, dir[2] * off);
  return prism;
}

export function revolve(profile: Face | Wire, origin: [number, number, number], axis: [number, number, number], angleRad: number): Shape {
  const o = oc();
  const face = shapeKind(profile) === 'FACE' ? profile : faceFromWire(profile);
  const ax1 = gp.Ax1(gp.Pnt(...origin), gp.Dir(...axis));
  return new o.BRepPrimAPI_MakeRevol_1(face, ax1, angleRad, true).Shape();
}

// ============================================================
// 曲面特征（SolidWorks「曲面」页签）：轮廓扫成**壳**而非实体
// ============================================================
/**
 * 展开一个形状里的所有壳（曲面体）。
 * 与 `bodiesOf`（实体）对应，供「曲面实体」计数与归属使用。
 */
export function surfacesOf(shape: Shape): Shape[] {
  if (!shape || shape.IsNull()) return [];
  return explode(shape, 'SHELL');
}

/**
 * 缝合多个曲面（面/壳）为一个壳（SolidWorks「缝合曲面」）。
 * 用 `ShapeUpgrade_ShellSewing` 把相邻面缝合成一个壳——相邻面会共享公共边，
 * 自由边清零；不相邻的输入面则原样保留（调用方需自行容错地包成壳）。
 * ⚠️ 另两个缝合 API 在本绑定里不可用：`BRepBuilderAPI_Sewing.Perform()` 需要
 * `Handle_Message_ProgressIndicator`（无免费构造器）、`FastSewing` 签名不匹配，故走 ShellSewing。
 */
export function sewShapes(shapes: Shape[], tolerance = 1e-4): Shape {
  const o = oc();
  const shell = new o.TopoDS_Shell();
  const builder = new o.BRep_Builder();
  builder.MakeShell(shell);
  for (const s of shapes) {
    for (const fc of faces(s)) builder.Add(shell, fc);
  }
  return new o.ShapeUpgrade_ShellSewing().ApplySewing(shell, tolerance);
}

/**
 * 拉伸曲面：把线框（或面）沿 dir 拉伸成壳。
 *
 * 与 `extrude` 的区别：**不把 wire 转成 face**、也不封顶——直接对 wire 做
 * `BRepPrimAPI_MakePrism`，得到开放曲面（壳）。开放折线 → 单侧曲面；
 * 闭合 wire → 四周侧壁（无上下盖）。
 */
export function surfaceExtrude(profile: Wire | Face, dir: [number, number, number], distance: number, symmetric = false): Shape {
  const o = oc();
  const off = symmetric ? -distance / 2 : 0;
  const vec = gp.Vec(dir[0] * distance, dir[1] * distance, dir[2] * distance);
  const prism = new o.BRepPrimAPI_MakePrism_1(profile, vec, true, true).Shape();
  if (symmetric) return translate(prism, dir[0] * off, dir[1] * off, dir[2] * off);
  return prism;
}

/**
 * 旋转曲面：把线框（或面）绕轴旋转成壳（不封顶、不成实体）。
 */
export function surfaceRevolve(profile: Wire | Face, origin: [number, number, number], axis: [number, number, number], angleRad: number): Shape {
  const o = oc();
  const ax1 = gp.Ax1(gp.Pnt(...origin), gp.Dir(...axis));
  return new o.BRepPrimAPI_MakeRevol_1(profile, ax1, angleRad, true).Shape();
}

/** 表面积（实体 / 曲面壳都适用，GProp SurfaceProperties） */
export function surfaceArea(shape: Shape): number {
  const o = oc();
  const props = new o.GProp_GProps_1();
  o.BRepGProp.SurfaceProperties_1(shape, props, false, false);
  return props.Mass();
}

/** 仅实体贡献的体积（曲面壳不计入体积；无实体时返回 0） */
export function solidVolume(shape: Shape): number {
  const bodies = bodiesOf(shape);
  if (!bodies.length) return 0;
  return massProperties(bodies.length === 1 ? bodies[0] : compoundOf(bodies)).volume;
}

export function loft(profiles: (Face | Wire)[], isSolid = true, ruled = false): Shape {
  const o = oc();
  const ts = new o.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6);
  for (const p of profiles) {
    const w = shapeKind(p) === 'WIRE' ? p : wires(p)[0];
    ts.AddWire(w);
  }
  ts.Build();
  if (!ts.IsDone()) throw new Error('放样失败：截面不兼容');
  return ts.Shape();
}

/** 放样（稳健版）：自动在平滑/直纹/抽稀之间降级重试 */
export function loftRobust(profiles: (Face | Wire)[], isSolid = true, ruled = false): Shape {
  if (ruled) return loft(profiles, isSolid, true);
  const ws = profiles.map((p) => (shapeKind(p) === 'WIRE' ? p : wires(p)[0]));
  return loftWires(ws, isSolid);
}

/**
 * ThruSections 的稳健封装。
 *
 * ⚠️ 实测：本 opencascade.js 绑定里 `BRepOffsetAPI_ThruSections.Build()` 对**某些截面数量**
 * 会偶发抛异常（例如圆截面链 14/16/24/30 段每圈必失败，而 10/12/20/36 段正常），
 * 看起来是 wasm 侧的数值/内存不稳定，与几何本身无关。
 * 这里按「平滑 → 直纹 → 逐级抽稀」降级重试，保证调用方拿到的结果可用。
 */
function buildThruSections(wires: Wire[], isSolid: boolean, ruled: boolean): Shape {
  const o = oc();
  const ts = new o.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6);
  for (const w of wires) ts.AddWire(w);
  ts.Build();
  if (!ts.IsDone()) throw new Error('放样失败：截面不兼容');
  const s = ts.Shape();
  if (!s || s.IsNull()) throw new Error('放样失败：结果为空');
  return s;
}

function decimate<T>(arr: T[], step: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (arr.length > 1 && out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

export function loftWires(wires: Wire[], isSolid = true): Shape {
  if (wires.length < 2) throw new Error('放样：至少需要两个截面');
  // 顺序很重要：先用同样截面数换「直纹」重试（几何仍然精确穿过每个截面），
  // 只有在直纹也失败时才抽稀——抽稀会损失几何精度（弯道会被"切角"）。
  const attempts: (() => Shape)[] = [() => buildThruSections(wires, isSolid, false)];
  if (wires.length <= 60) attempts.push(() => buildThruSections(wires, isSolid, true));
  for (const step of [2, 3]) {
    const dec = decimate(wires, step);
    if (dec.length >= 2 && dec.length < wires.length) {
      attempts.push(() => buildThruSections(dec, isSolid, false));
    }
  }
  attempts.push(() => buildThruSections(decimate(wires, 2), isSolid, true));
  let lastErr: unknown = null;
  for (const a of attempts) {
    try {
      return a();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('放样失败');
}

/**
 * ⚠️ 已实测：`BRepOffsetAPI_MakePipe` / `MakePipeShell` 在本 opencascade.js 绑定里
 * 对**多段/弯曲**路径会算出退化结果（直线折线尚可，圆弧折线体积直接变 0；
 * 换 trihedron 模式、换 wire/face 截面都一样）。
 * 因此扫掠一律走 `loftSections`（沿路径逐站放样），结果精确且稳定。
 * 这里保留 MakePipe 仅供单段直线路径的快速路径使用。
 */
export function sweep(spine: Wire, profile: Face | Wire): Shape {
  const o = oc();
  const face = shapeKind(profile) === 'FACE' ? profile : faceFromWire(profile);
  const spineWire = shapeKind(spine) === 'WIRE' ? spine : wires(spine)[0];
  const tri = o.GeomFill_Trihedron?.GeomFill_IsCorrectedFrenet ?? 0;
  const pipe = new o.BRepOffsetAPI_MakePipe_2(spineWire, face, tri, false);
  pipe.Build();
  if (!pipe.IsDone()) throw new Error('扫掠失败：轮廓与路径不兼容');
  return pipe.Shape();
}

/**
 * 沿路径放样：把已经算好的各站截面（每站一组 3D 点，构成闭合环）蒙皮成实体。
 * 这是本项目「扫掠」的可靠实现——截面由 `sketch/curve.ts` 的平行移动标架放置。
 */
export function loftSections(
  sections: [number, number, number][][],
  isSolid = true,
  _ruled = false
): Shape {
  if (sections.length < 2) throw new Error('放样：至少需要两个截面');
  const wires: Wire[] = [];
  for (const s of sections) {
    if (s.length < 3) throw new Error('放样：截面退化');
    wires.push(wireFromPoints(s, true));
  }
  return loftWires(wires, isSolid);
}

/**
 * 圆截面沿一条中心线放样（弹簧、盘管、螺纹坯料）。
 * 用真实圆弧 wire（每站 1 条边）而不是多边形近似，精度高、面数少。
 * `normals` 缺省时用相邻中心点的差分当作截面法向。
 */
export function loftCircleChain(
  centers: [number, number, number][],
  radius: number,
  normals?: [number, number, number][],
  seamDirs?: [number, number, number][]
): Shape {
  if (centers.length < 2) throw new Error('放样：至少需要两个截面');
  const wires: Wire[] = [];
  for (let i = 0; i < centers.length; i++) {
    let nrm = normals?.[i];
    if (!nrm) {
      const a = centers[Math.max(0, i - 1)];
      const b = centers[Math.min(centers.length - 1, i + 1)];
      nrm = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    }
    const len = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
    const n: [number, number, number] = [nrm[0] / len, nrm[1] / len, nrm[2] / len];
    const seam = seamDirs?.[i];
    wires.push(circleWire(centers[i], n, radius, seam ? [seam[0], seam[1], seam[2]] : undefined));
  }
  return loftWires(wires, true);
}

// ============================================================
// 布尔运算
// ============================================================
function booleanOp(cls: string, a: Shape, b: Shape, opName: string): Shape {
  const o = oc();
  const op = new o[cls](a, b);
  op.Build();
  if (op.IsDone && !op.IsDone()) throw new Error(`${opName}运算失败`);
  const r = op.Shape();
  if (!r || r.IsNull()) throw new Error(`${opName}运算结果为空`);
  return r;
}

export const fuse = (a: Shape, b: Shape) => booleanOp('BRepAlgoAPI_Fuse_3', a, b, '并集');
export const cut = (a: Shape, b: Shape) => booleanOp('BRepAlgoAPI_Cut_3', a, b, '差集');
export const common = (a: Shape, b: Shape) => booleanOp('BRepAlgoAPI_Common_3', a, b, '交集');

export function fuseAll(shapes: Shape[]): Shape {
  if (!shapes.length) throw new Error('并集：无输入');
  return shapes.slice(1).reduce((acc, s) => fuse(acc, s), shapes[0]);
}

export function cutAll(base: Shape, tools: Shape[]): Shape {
  return tools.reduce((acc, t) => cut(acc, t), base);
}

/**
 * 把若干**互不相交**的实体合成一个复合体（不融合）。
 *
 * 用途：周期性结构（螺旋弹簧、环形阵列等）——复制出来的各段在相邻截面处严格重合，
 * 用 `fuse` 融合会因为"共面端盖"这种退化相交而极慢（实测 8 段要 35~82s），
 * 而复合体零成本，且实测体积/三角化/布尔/特征链续算全部正常。
 *
 * ⚠️ 仅当各实体内部互不重叠时才等价于并集；重叠输入会得到非流形结果。
 */
export function compoundOf(shapes: Shape[]): Shape {
  if (!shapes.length) throw new Error('复合体：无输入');
  if (shapes.length === 1) return shapes[0];
  const o = oc();
  const comp = new o.TopoDS_Compound();
  const b = new o.BRep_Builder();
  b.MakeCompound(comp);
  for (const s of shapes) b.Add(comp, s);
  return comp;
}

// ============================================================
// 圆角 / 倒角 / 抽壳
// ============================================================
/**
 * 圆角。
 *
 * 给了 `radius2` 且与 `radius` 不同时走**变半径圆角**（SolidWorks 的「变量大小圆角」）：
 * 半径沿边从 `radius`（起点）线性过渡到 `radius2`（终点）。
 * ⚠️ 重载序号实测：`Add_2(r, edge)` 定半径；`Add_3(r1, r2, edge)` 变半径。
 */
export function fillet(shape: Shape, targetEdges: Edge[], radius: number, radius2?: number): Shape {
  const o = oc();
  const mk = new o.BRepFilletAPI_MakeFillet(shape, o.ChFi3d_FilletShape.ChFi3d_Rational);
  const variable = radius2 !== undefined && Math.abs(radius2 - radius) > 1e-9;
  for (const e of targetEdges) {
    if (variable) mk.Add_3(radius, radius2 as number, e);
    else mk.Add_2(radius, e);
  }
  guardOc(variable ? '变半径圆角失败' : '圆角失败', () => mk.Build());
  if (!mk.IsDone()) {
    throw new Error(
      variable ? `变半径圆角失败：半径 ${radius}→${radius2} 对所选边不适用` : `圆角失败：半径 ${radius} 对所选边不适用`
    );
  }
  return mk.Shape();
}

export function chamfer(shape: Shape, targetEdges: Edge[], distance: number): Shape {
  const o = oc();
  const mk = new o.BRepFilletAPI_MakeChamfer(shape);
  for (const e of targetEdges) mk.Add_2(distance, e);
  guardOc('倒角失败', () => mk.Build());
  if (!mk.IsDone()) throw new Error(`倒角失败：距离 ${distance} 对所选边不适用`);
  return mk.Shape();
}

export function shell(shape: Shape, removeFaces: Face[], thickness: number): Shape {
  const o = oc();
  const list = new o.TopTools_ListOfShape_1();
  for (const f of removeFaces) list.Append_1(f);
  const mode = o.BRepOffset_Mode?.BRepOffset_Skin ?? 0;
  const join = o.GeomAbs_JoinType?.GeomAbs_Arc ?? 0;
  const mk = new o.BRepOffsetAPI_MakeThickSolid_2(shape, list, -Math.abs(thickness), 1e-3, mode, false, false, join, false);
  guardOc('抽壳失败', () => mk.Build());
  if (!mk.IsDone()) throw new Error(`抽壳失败：壁厚 ${thickness} 过大或移除面不合法`);
  return mk.Shape();
}

// ============================================================
// 实体编辑（缩放 / 分割）
// ============================================================
/**
 * 缩放（支持非均匀）。以 `center` 为中心，各轴分别乘 `factors`。
 *
 * 用 `BRepBuilderAPI_GTransform`（通用仿射变换）而不是 `BRepBuilderAPI_Transform`——
 * 后者只接受 `gp_Trsf`，而 `gp_Trsf` 在 OCCT 里**只允许等比缩放**，非均匀缩放会抛异常。
 * `gp_GTrsf` 的线性部分可以直接填对角阵，平移列（第 4 列）取 `center − S·center`，
 * 使 `center` 成为不动点。
 *
 * ⚠️ 重载序号实测：`GTransform_2(shape, gtrsf, copy)` 可用；`GTransform_1` 只吃 1 个参数。
 */
export function scale(shape: Shape, center: [number, number, number], factors: [number, number, number]): Shape {
  const o = oc();
  const gt = new o.gp_GTrsf_1();
  for (let i = 1; i <= 3; i++) {
    for (let j = 1; j <= 3; j++) gt.SetValue(i, j, i === j ? factors[i - 1] : 0);
  }
  for (let i = 1; i <= 3; i++) gt.SetValue(i, 4, center[i - 1] * (1 - factors[i - 1]));
  const r = guardOc('缩放失败', () => new o.BRepBuilderAPI_GTransform_2(shape, gt, true).Shape());
  if (!r || r.IsNull()) throw new Error('缩放失败');
  return r;
}

/** 实体包围盒（用 BRepBndLib，不做三角化，比走网格快得多） */
export function shapeBBox(shape: Shape): { min: [number, number, number]; max: [number, number, number] } {
  const o = oc();
  const box = new o.Bnd_Box_1();
  // 实测：本绑定下 Add 是 3 参（shape, box, useTriangulation）
  o.BRepBndLib.Add(shape, box, false);
  const pmin = box.CornerMin();
  const pmax = box.CornerMax();
  return { min: [pmin.X(), pmin.Y(), pmin.Z()], max: [pmax.X(), pmax.Y(), pmax.Z()] };
}

export type SplitKeep = 'both' | 'positive' | 'negative';

/**
 * 用平面分割实体（SolidWorks 的「分割」）。
 *
 * OCCT 的 `BRepAlgoAPI_Splitter` 需要一张**有限的面**做工具，所以先按实体包围盒
 * 生成一张足够大的矩形面（外扩 20% + 10 单位，保证完整穿透）。
 *
 * `keep`：`both` 保留两侧（结果可能是复合体）；`positive`/`negative` 只保留法向
 * 正侧/负侧——按各子实体的**质心**在法向上的投影符号筛选。
 */
export function splitByPlane(
  shape: Shape,
  pl: PlacementPlane,
  keep: SplitKeep = 'both',
  extent = 0
): Shape {
  const o = oc();
  const bb = shapeBBox(shape);
  let span = extent;
  if (span <= 0) {
    let maxSpan = 0;
    for (let i = 0; i < 3; i++) maxSpan = Math.max(maxSpan, bb.max[i] - bb.min[i]);
    const dist = Math.abs(
      (bb.min[0] + bb.max[0]) / 2 * pl.normal[0] +
        (bb.min[1] + bb.max[1]) / 2 * pl.normal[1] +
        (bb.min[2] + bb.max[2]) / 2 * pl.normal[2]
    );
    span = (maxSpan + dist) * 1.2 + 10;
  }

  const corner = (su: number, sv: number): [number, number, number] => [
    pl.origin[0] + pl.u[0] * su * span + pl.v[0] * sv * span,
    pl.origin[1] + pl.u[1] * su * span + pl.v[1] * sv * span,
    pl.origin[2] + pl.u[2] * su * span + pl.v[2] * sv * span,
  ];
  const tool = faceFromPoints([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);

  const sp = new o.BRepAlgoAPI_Splitter_1();
  const args = new o.TopTools_ListOfShape_1();
  args.Append_1(shape);
  const tools = new o.TopTools_ListOfShape_1();
  tools.Append_1(tool);
  sp.SetArguments(args);
  sp.SetTools(tools);
  guardOc('分割失败', () => sp.Build());
  if (!sp.IsDone()) throw new Error('分割失败：切割平面与实体不相交');
  const out = sp.Shape();
  if (!out || out.IsNull()) throw new Error('分割失败：结果为空');

  const parts = explode(out, 'SOLID');
  if (!parts.length) throw new Error('分割失败：没有产生实体');
  if (keep === 'both') {
    // 平面没真正切到实体时 Splitter 会原样返回，这里显式报错，避免"静默成功"
    if (parts.length < 2) throw new Error('分割失败：切割平面没有把实体分成两块');
    return out;
  }

  const sign = keep === 'positive' ? 1 : -1;
  const kept = parts.filter((p) => {
    const c = massProperties(p).centroid;
    const d = (c[0] - pl.origin[0]) * pl.normal[0] + (c[1] - pl.origin[1]) * pl.normal[1] + (c[2] - pl.origin[2]) * pl.normal[2];
    return d * sign >= 0;
  });
  if (!kept.length) throw new Error(`分割失败：法向${keep === 'positive' ? '正' : '负'}侧没有实体`);
  return kept.length === 1 ? kept[0] : compoundOf(kept);
}

// ============================================================
// 多实体操作（移动/复制、删除、组合）
// ============================================================
/**
 * 把一个「可能是复合体的形状」拆成实体列表。
 *
 * 单实体也返回 `[该实体]`（而不是原 shape），这样上层可以统一按「实体集合」处理。
 * 复合体（如分割/弹簧的产物）会展开成多个实体。
 */
export function bodiesOf(shape: Shape): Shape[] {
  if (!shape || shape.IsNull()) return [];
  return explode(shape, 'SOLID');
}

/**
 * 刚体搬运：先绕 `axis`（过 `origin`）旋转 `angleRad`，再平移 `delta`。
 *
 * 顺序固定为「先转后移」，与 SolidWorks「移动/复制实体」的直觉一致：
 * 旋转是绕给定轴自转，平移是把结果整体搬走。
 */
export function moveBody(
  shape: Shape,
  origin: [number, number, number],
  axis: [number, number, number],
  angleRad: number,
  delta: [number, number, number]
): Shape {
  let s = shape;
  if (Math.abs(angleRad) > 1e-12) {
    s = guardOc('移动失败', () => rotateAxis(s, origin, axis, angleRad));
  }
  if (delta[0] || delta[1] || delta[2]) {
    s = guardOc('移动失败', () => translate(s, delta[0], delta[1], delta[2]));
  }
  return s;
}

export type CombineOp = 'add' | 'subtract' | 'common';

/**
 * 组合（SolidWorks 的「组合」）：把若干实体按布尔操作合并成一个。
 *
 * `base` 是主体，`tools` 依次作用其上：`add` 求并、`subtract` 求差、`common` 求交。
 * 与特征链里的布尔不同，这里**每个实体都被单独取出**再运算，
 * 因此可以用来「合并两个原本独立生成的实体」。
 */
export function combineBodies(base: Shape, tools: Shape[], op: CombineOp): Shape {
  if (!tools.length) throw new Error('组合失败：没有选择工具体');
  let acc = base;
  for (const t of tools) {
    acc = guardOc('组合失败', () =>
      op === 'add' ? fuse(acc, t) : op === 'subtract' ? cut(acc, t) : common(acc, t)
    );
    if (!acc || acc.IsNull()) throw new Error('组合失败：布尔运算结果为空');
    // 差集/交集可能把主体整体吃掉——OCCT 此时返回的是空复合体（IsNull 为 false），
    // 必须显式检查实体数，否则会静默产出一个"空模型"。
    if (op !== 'add' && bodiesOf(acc).length === 0) {
      throw new Error(op === 'subtract' ? '组合失败：主体被工具体完全切除' : '组合失败：主体与工具体没有公共体积');
    }
  }
  return acc;
}

// ============================================================
// 变换
// ============================================================
/**
 * 应用变换。第二个参数可以是 3×4 行主序矩阵（12 个数），
 * 也可以是 trsfEuler/trsfTranslate/trsfRotate 等返回的 gp_Trsf 对象。
 */
export function transform(shape: Shape, matrixOrTrsf: number[] | any): Shape {
  const o = oc();
  const t = Array.isArray(matrixOrTrsf) ? trsfFromMatrix(matrixOrTrsf) : matrixOrTrsf;
  return new o.BRepBuilderAPI_Transform_2(shape, t, true).Shape();
}

export function translate(shape: Shape, x: number, y: number, z: number): Shape {
  return transform(shape, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
}

export function rotateAxis(shape: Shape, origin: [number, number, number], axis: [number, number, number], angleRad: number): Shape {
  const o = oc();
  const t = gp.Trsf();
  t.SetRotation_1(gp.Ax1(gp.Pnt(...origin), gp.Dir(...axis)), angleRad);
  return new o.BRepBuilderAPI_Transform_2(shape, t, true).Shape();
}

export function copy(shape: Shape): Shape {
  const o = oc();
  return new o.BRepBuilderAPI_Copy_2(shape, true, false).Shape();
}

// ============================================================
// 平面放置与孔工具（异型孔向导）
// ============================================================
/** 放置平面：原点 + 局部坐标轴（局部 +Z = 平面外法向） */
export interface PlacementPlane {
  origin: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  normal: [number, number, number];
}

/** 平面 → 3×4 行主序变换矩阵（局部 x→u, y→v, z→normal） */
export function planeMatrix(pl: PlacementPlane): number[] {
  const { origin: o, u, v, normal: n } = pl;
  return [u[0], v[0], n[0], o[0], u[1], v[1], n[1], o[1], u[2], v[2], n[2], o[2]];
}

/** 把在局部坐标里构造的形状放到平面上（可选局部偏移） */
export function placeOnPlane(shape: Shape, pl: PlacementPlane, off: [number, number, number] = [0, 0, 0]): Shape {
  const moved = off[0] || off[1] || off[2] ? translate(shape, off[0], off[1], off[2]) : shape;
  return transform(moved, planeMatrix(pl));
}

export interface HoleSpec {
  plane: PlacementPlane;
  /** 孔在平面局部坐标 (u,v) 内的位置 */
  pos: [number, number];
  type: 'simple' | 'counterbore' | 'countersink' | 'threaded';
  diameter: number;
  depth: number;
  through: boolean;
  boreDiameter?: number;
  boreDepth?: number;
  sinkDiameter?: number;
  sinkDepth?: number;
}

/** 通孔加工长度：足够穿透常见零件；布尔裁剪后不影响结果 */
const THROUGH_LEN = 400;

/**
 * 构造孔加工工具（一个实体，沿平面 -Z 方向钻入）。
 * 本地坐标系：+Z = 平面外法向，材料在 z<0 一侧，孔从表面 z=0 起钻。
 * 沉头/锥沉用基本体布尔并集构造——比用旋转截面更稳，且天然支持阵列复用。
 */
export function holeTool(spec: HoleSpec): Shape {
  const { plane, pos, type, diameter, through } = spec;
  const r = Math.max(diameter, 0.01) / 2;
  const len = through ? THROUGH_LEN : Math.max(spec.depth, 0.01);
  const eps = Math.max(0.5, r * 0.2); // 抬出表面一点，保证布尔稳定

  const parts: Shape[] = [];
  // 主孔圆柱：z ∈ [-len, eps]
  parts.push(translate(primitives.cylinder(r, len + eps), 0, 0, -len));

  if (type === 'counterbore') {
    const br = Math.max(spec.boreDiameter ?? diameter * 1.8, r * 1.05) / 2;
    const bd = Math.max(spec.boreDepth ?? 3, 0.01);
    parts.push(translate(primitives.cylinder(br, bd + eps), 0, 0, -bd));
  } else if (type === 'countersink') {
    const sr = Math.max(spec.sinkDiameter ?? diameter * 2, r * 1.05) / 2;
    const sd = Math.max(spec.sinkDepth ?? sr - r, 0.01);
    // 圆台：底 r（z=-sd）→ 顶 sr（z=0）；抬 2e-3 保证与表面相交而不共面
    parts.push(translate(primitives.cone(r, sr, sd), 0, 0, -sd + 2e-3));
  }
  // threaded / simple：主孔即代表（螺纹为修饰，几何按标称直径）

  const tool = parts.length === 1 ? parts[0] : fuseAll(parts);
  return placeOnPlane(tool, plane, [pos[0], pos[1], 0]);
}

/**
 * 拔模（Draft）。
 * - draftFaces：要拔模的面
 * - neutralPoint/neutralNormal：中性面（拔模角为 0 的面）
 * - angleDeg：角度（取绝对值）；reverse=true 反向（向内/向外互换）
 *
 * ⚠️ opencascade.js 只导出 `BRepOffsetAPI_DraftAngle_2`，其 Add 需 5 参：
 *    Add(face, dir, angle, gp_Pln, flag)。实测中性面用 gp_Pln 表示（点 + 法向）。
 */
export function draft(
  shape: Shape,
  draftFaces: Face[],
  neutralPoint: [number, number, number],
  neutralNormal: [number, number, number],
  angleDeg: number,
  reverse = false
): Shape {
  const o = oc();
  const nrm = normalize(neutralNormal);
  const s = reverse ? -1 : 1;
  const pl = gp.Pln(neutralPoint, neutralNormal);
  const dir = gp.Dir(nrm[0] * s, nrm[1] * s, nrm[2] * s);
  const ang = (Math.abs(angleDeg) * Math.PI) / 180;
  const mk = new o.BRepOffsetAPI_DraftAngle_2(shape);
  for (const f of draftFaces) mk.Add(f, dir, ang, pl, true);
  guardOc('拔模失败', () => mk.Build());
  if (!mk.IsDone()) throw new Error('拔模失败：角度或所选面不适用');
  return mk.Shape();
}

/** 关于平面镜像 */
export function mirrorPlane(shape: Shape, point: [number, number, number], normal: [number, number, number]): Shape {
  const o = oc();
  const n = normal;
  const [nx, ny, nz] = n;
  const d = nx * point[0] + ny * point[1] + nz * point[2];
  const t = trsfFromMatrix([
    1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz, 2 * d * nx,
    -2 * ny * nx, 1 - 2 * ny * ny, -2 * ny * nz, 2 * d * ny,
    -2 * nz * nx, -2 * nz * ny, 1 - 2 * nz * nz, 2 * d * nz,
  ]);
  return new o.BRepBuilderAPI_Transform_2(shape, t, true).Shape();
}

// ============================================================
// 阵列
// ============================================================
export function linearPattern(
  shape: Shape,
  dir: [number, number, number],
  spacing: number,
  count: number,
  merge = true
): Shape {
  const instances: Shape[] = [];
  for (let i = 0; i < count; i++) {
    instances.push(translate(shape, dir[0] * spacing * i, dir[1] * spacing * i, dir[2] * spacing * i));
  }
  // merge=true 求并为一个实体；merge=false 不融合，返回含全部实例的复合体（不能只返回
  // instances[0]，否则除原始实例外其余 count-1 个实例全部丢失）。
  return merge ? fuseAll(instances) : compoundOf(instances);
}

export function circularPattern(
  shape: Shape,
  origin: [number, number, number],
  axis: [number, number, number],
  count: number,
  totalAngleRad = Math.PI * 2,
  merge = true
): Shape {
  const instances: Shape[] = [];
  const step = totalAngleRad / (count > 1 && totalAngleRad >= Math.PI * 2 - 1e-6 ? count : Math.max(count - 1, 1));
  for (let i = 0; i < count; i++) {
    instances.push(rotateAxis(shape, origin, axis, step * i));
  }
  // 见 linearPattern：merge=false 必须返回含全部实例的复合体，不能只返回 instances[0]。
  return merge ? fuseAll(instances) : compoundOf(instances);
}

/** 返回阵列产生的全部实例（不合并） */
export function linearPatternInstances(shape: Shape, dir: [number, number, number], spacing: number, count: number): Shape[] {
  return Array.from({ length: count }, (_, i) =>
    translate(shape, dir[0] * spacing * i, dir[1] * spacing * i, dir[2] * spacing * i)
  );
}

export function circularPatternInstances(
  shape: Shape,
  origin: [number, number, number],
  axis: [number, number, number],
  count: number,
  totalAngleRad = Math.PI * 2
): Shape[] {
  const step = totalAngleRad >= Math.PI * 2 - 1e-6 ? (Math.PI * 2) / count : totalAngleRad / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, i) => rotateAxis(shape, origin, axis, step * i));
}

// ============================================================
// 度量
// ============================================================
export interface MassProps {
  volume: number;
  surfaceArea: number;
  centroid: [number, number, number];
}

export function massProperties(shape: Shape): MassProps {
  const o = oc();
  const g = new o.GProp_GProps_1();
  o.BRepGProp.VolumeProperties_1(shape, g, false, false, false);
  const c = g.CentreOfMass();
  const gs = new o.GProp_GProps_1();
  o.BRepGProp.SurfaceProperties_1(shape, gs, false, false);
  return {
    volume: Math.abs(g.Mass()),
    surfaceArea: gs.Mass(),
    centroid: [c.X(), c.Y(), c.Z()],
  };
}

export function volume(shape: Shape): number {
  const o = oc();
  const g = new o.GProp_GProps_1();
  o.BRepGProp.VolumeProperties_1(shape, g, false, false, false);
  return Math.abs(g.Mass());
}

/** 由网格顶点计算包围盒（Bnd_Box.Get 在 ocjs 里不可用） */
export function boundingBox(mesh: { positions: Float32Array | number[] }): { min: [number, number, number]; max: [number, number, number] } {
  const p = mesh.positions;
  if (!p.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** 判断两个形状是否干涉（体积交集 > 容差） */
export function interfere(a: Shape, b: Shape, tol = 1e-6): { interfered: boolean; volume: number } {
  try {
    const c = common(a, b);
    const v = volume(c);
    return { interfered: v > tol, volume: v };
  } catch {
    return { interfered: false, volume: 0 };
  }
}

/** 最小距离 */
export function minDistance(a: Shape, b: Shape): number {
  const o = oc();
  try {
    const d = new o.BRepExtrema_DistShapeShape_1(a, b);
    d.Perform();
    return d.IsDone() ? d.Value() : NaN;
  } catch {
    return NaN;
  }
}
