/**
 * 草图 → OCCT 几何。
 *
 * 流程：实体 → 边 → 闭环 → 线框 → 面（含孔）。
 * 所有坐标都从草图 2D 经平面映射到 3D。
 *
 * 已实测确认：
 *   BRepBuilderAPI_MakeEdge_3(P1, P2)           两点直线
 *   BRepBuilderAPI_MakeEdge_9(circ, u1, u2)     圆弧（参数递增方向）
 *   BRepBuilderAPI_MakeEdge_8(circ)             整圆
 *   BRepBuilderAPI_MakeEdge_12(elips)           整椭圆（_8 只吃 gp_Circ，传 gp_Elips 会报错）
 *   BRepBuilderAPI_MakeEdge_24(Handle(Geom_Curve)) 任意 Geom 曲线（抛物线/双曲线/B 样条）
 *   BRepBuilderAPI_MakeWire_1() + Add_1(edge)   串线
 *   BRepBuilderAPI_MakeFace_15(wire, false) + Add(holeWire)
 *   ⚠️ 内环必须反向（Reversed），否则面积会变成"外 + 内"而不是"外 − 内"
 *
 * ⚠️ Handle 陷阱：本绑定下 `MakeEdge_24` / `Geom_TrimmedCurve` 要的是
 * `Handle_Geom_Curve`，而 `Geom_Parabola_2(...)` / `GeomAPI_PointsToBSpline_2(...).Curve()`
 * 返回的是**具体类型的 handle**（`Handle_Geom_Parabola` 等），embind 不会自动向上转型。
 * 必须先用 `.get()` 取出裸对象、再用 `new Handle_Geom_Curve_2(obj)` 重新包一层，
 * 否则报 "Expected null or instance of Handle_Geom_Curve, got an instance of Handle_Geom_XXX"。
 */
import { oc, gp } from '../core/occt';
import type {
  SkArc, SkBSpline, SkEllipse, SkEntity, SkHyperbola, SkLine, SkParabola, Sketch, SketchPlane,
} from './types';
import { arcAngles, ellipsePointAt, hyperbolaPointAt, parabolaPointAt, planeToWorld } from './types';
import { bsplineInterpolate, bsplinePolyline, type BsplineData } from './curve';

export interface Region {
  /** 外轮廓 */
  outer: any; // TopoDS_Wire
  /** 内孔 */
  holes: any[]; // TopoDS_Wire[]
  /** 用于嵌套判定的 2D 多边形 */
  polygon: [number, number][];
  /** 面积（mm²） */
  area: number;
  /** 是否为外实体（未被其他环包含） */
  isOuter: boolean;
}

// ============================================================
// 平面坐标 → 世界坐标
// ============================================================
const W = (pl: SketchPlane, x: number, y: number) => {
  const p = planeToWorld(pl, x, y, 0);
  return gp.Pnt(p[0], p[1], p[2]);
};

/** 构造草图平面的 gp_Ax2（X 方向对齐草图 u 轴，保证角度可直接用） */
export function planeAx2(pl: SketchPlane): any {
  const o = oc();
  const ax2 = new o.gp_Ax2_3(gp.Pnt(...pl.origin), gp.Dir(...pl.normal));
  const setX = (ax2 as any).SetXDirection;
  if (typeof setX === 'function') {
    setX.call(ax2, gp.Dir(...pl.u));
  }
  return ax2;
}

// ============================================================
// 单条实体 → 边
// ============================================================
function edgeForLine(sk: Sketch, e: SkLine, pl: SketchPlane, from?: string): any {
  const o = oc();
  const a = sk.points[from ?? e.a];
  const b = sk.points[from ? (from === e.a ? e.b : e.a) : e.b];
  return new o.BRepBuilderAPI_MakeEdge_3(W(pl, a.x, a.y), W(pl, b.x, b.y)).Edge();
}

/**
 * 圆弧建边。sweep 始终为正，用 start 参数控制；若实际是顺时针，调用方需自行 Reversed。
 * 返回 { edge, ccw }，ccw 表示这条边的参数方向与草图 ccw 是否一致。
 */
function edgeForArc(sk: Sketch, e: SkArc, pl: SketchPlane): { edge: any; fromId: string; toId: string; ccw: boolean } {
  const o = oc();
  const { a0, a1, r } = arcAngles(sk, e);
  // ⚠️ 圆心必须放在弧心，不能放在草图原点
  const c = sk.points[e.c];
  const ax2 = new o.gp_Ax2_3(W(pl, c.x, c.y), gp.Dir(...pl.normal));
  if (typeof (ax2 as any).SetXDirection === 'function') (ax2 as any).SetXDirection(gp.Dir(...pl.u));
  const circ = new o.gp_Circ_2(ax2, r);
  // 始终用递增参数构造，起点取角度较小的一侧
  let start: number;
  let sweep: number;
  if (e.ccw) {
    start = a0;
    sweep = a1 - a0;
  } else {
    start = a1;
    sweep = a0 - a1;
  }
  const edge = new o.BRepBuilderAPI_MakeEdge_9(circ, start, start + sweep).Edge();
  // e.ccw=true 时边方向 a→b；否则 b→a
  return { edge, fromId: e.ccw ? e.a : e.b, toId: e.ccw ? e.b : e.a, ccw: e.ccw };
}

function edgeForCircle(sk: Sketch, e: { c: string; r: number }, pl: SketchPlane): any {
  const o = oc();
  const c = sk.points[e.c];
  const ax2 = new o.gp_Ax2_3(W(pl, c.x, c.y), gp.Dir(...pl.normal));
  if (typeof (ax2 as any).SetXDirection === 'function') (ax2 as any).SetXDirection(gp.Dir(...pl.u));
  return new o.BRepBuilderAPI_MakeEdge_8(new o.gp_Circ_2(ax2, e.r)).Edge();
}

/**
 * 椭圆建边（整椭圆）。
 *
 * ⚠️ 本绑定下 `BRepBuilderAPI_MakeEdge_8` 只接受 `gp_Circ`（传 `gp_Elips` 会报
 * "Expected null or instance of gp_Circ"），而 `Geom_Ellipse` 返回的是裸指针、
 * 无法包成 `Handle_Geom_Curve`（`MakeEdge_24` 用不了）。
 * 实测可用的是 **`MakeEdge_12(gp_Elips)`**（整椭圆）与 **`MakeEdge_13(gp_Elips, u1, u2)`**（椭圆弧）。
 * 椭圆长轴方向通过 `ax2.SetXDirection` 指定为「草图 u 轴绕平面法向旋转 rot」。
 */
function edgeForEllipse(sk: Sketch, e: SkEllipse, pl: SketchPlane): any {
  const o = oc();
  const c = sk.points[e.c];
  const ax2 = new o.gp_Ax2_3(W(pl, c.x, c.y), gp.Dir(...pl.normal));
  if (typeof (ax2 as any).SetXDirection === 'function') {
    const cs = Math.cos(e.rot);
    const sn = Math.sin(e.rot);
    const dir = [
      pl.u[0] * cs + pl.v[0] * sn,
      pl.u[1] * cs + pl.v[1] * sn,
      pl.u[2] * cs + pl.v[2] * sn,
    ];
    (ax2 as any).SetXDirection(gp.Dir(dir[0], dir[1], dir[2]));
  }
  return new o.BRepBuilderAPI_MakeEdge_12(new o.gp_Elips_2(ax2, e.rx, e.ry)).Edge();
}

// ============================================================
// 高级曲线族：抛物线 / 双曲线 / B 样条
// ============================================================
/**
 * 把 Geom 曲线的 handle 重新包成 `Handle_Geom_Curve`。
 *
 * 具体类型的 handle（`Handle_Geom_Parabola` 等）在 embind 里**不会**自动向上转型到
 * `Handle_Geom_Curve`，必须先 `.get()` 取裸对象再重新构造（见文件头注释）。
 */
function handleCurve(c: any): any {
  const o = oc();
  const raw = typeof c?.get === 'function' ? c.get() : c;
  return new o.Handle_Geom_Curve_2(raw);
}

/** 在草图平面上、以 (u,v) 为原点构造 gp_Ax2，X 轴 = 草图 u 轴绕法向旋转 rot */
function ax2At(pl: SketchPlane, u: number, v: number, rot: number): any {
  const o = oc();
  const ax2 = new o.gp_Ax2_3(W(pl, u, v), gp.Dir(...pl.normal));
  if (typeof (ax2 as any).SetXDirection === 'function') {
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const dir = [
      pl.u[0] * cs + pl.v[0] * sn,
      pl.u[1] * cs + pl.v[1] * sn,
      pl.u[2] * cs + pl.v[2] * sn,
    ];
    (ax2 as any).SetXDirection(gp.Dir(dir[0], dir[1], dir[2]));
  }
  return ax2;
}

/**
 * 抛物线建边。参数范围 `t0`/`t1` 与 `parabolaPointAt` 同一套参数化
 * （OCCT `Geom_Parabola::D0(U)` 的 U 即局部 Y 坐标），因此预览与实际完全一致。
 */
function edgeForParabola(sk: Sketch, e: SkParabola, pl: SketchPlane): any {
  const o = oc();
  const c = sk.points[e.c];
  const focal = Math.abs(e.focal) > 1e-9 ? Math.abs(e.focal) : 1e-9;
  const par = new o.Geom_Parabola_2(ax2At(pl, c.x, c.y, e.rot), focal);
  const tc = new o.Geom_TrimmedCurve(handleCurve(par), e.t0, e.t1, true, true);
  return new o.BRepBuilderAPI_MakeEdge_24(handleCurve(tc)).Edge();
}

/** 双曲线建边（取右支，实轴沿 rot 方向） */
function edgeForHyperbola(sk: Sketch, e: SkHyperbola, pl: SketchPlane): any {
  const o = oc();
  const c = sk.points[e.c];
  const a = Math.abs(e.a) > 1e-9 ? Math.abs(e.a) : 1e-9;
  const b = Math.abs(e.b) > 1e-9 ? Math.abs(e.b) : 1e-9;
  const hyp = new o.Geom_Hyperbola_2(ax2At(pl, c.x, c.y, e.rot), a, b);
  const tc = new o.Geom_TrimmedCurve(handleCurve(hyp), e.t0, e.t1, true, true);
  return new o.BRepBuilderAPI_MakeEdge_24(handleCurve(tc)).Edge();
}

/** B 样条数据（通过点 → 控制点）。n 很小，直接算即可，不做缓存。 */
export function bsplineDataFor(e: SkBSpline): BsplineData | null {
  return bsplineInterpolate(e.pts, 3, e.closed);
}

/** B 样条是否构成闭合环（显式 closed，或首尾点重合） */
export function isClosedBSpline(e: SkBSpline): boolean {
  if (e.closed) return true;
  const n = e.pts.length;
  if (n < 3) return false;
  const [x0, y0] = e.pts[0];
  const [x1, y1] = e.pts[n - 1];
  return Math.hypot(x1 - x0, y1 - y0) < 1e-6;
}

/** B 样条建边：自己算控制点 → `Geom_BSplineCurve_1` 精确构造（曲线严格穿过每个通过点） */
function edgeForBSpline(sk: Sketch, e: SkBSpline, pl: SketchPlane): any {
  const o = oc();
  const data = bsplineDataFor(e);
  if (!data) return null;
  const poles = new o.TColgp_Array1OfPnt_2(1, data.poles.length);
  data.poles.forEach((p, i) => {
    const w = planeToWorld(pl, p[0], p[1], 0);
    poles.SetValue(i + 1, gp.Pnt(w[0], w[1], w[2]));
  });
  const knots = new o.TColStd_Array1OfReal_2(1, data.knots.length);
  data.knots.forEach((k, i) => knots.SetValue(i + 1, k));
  const mults = new o.TColStd_Array1OfInteger_2(1, data.mults.length);
  data.mults.forEach((m, i) => mults.SetValue(i + 1, m));
  const bs = new o.Geom_BSplineCurve_1(poles, knots, mults, data.degree, false);
  return new o.BRepBuilderAPI_MakeEdge_24(handleCurve(bs)).Edge();
}

/**
 * 对外：高级曲线族实体（抛物线 / 双曲线 / B 样条）的 OCCT 边。
 *
 * 供测试与外部工具使用 —— 这三个实体是**开放曲线**（B 样条闭合时除外），
 * 不像直线/圆弧那样带 `SkPoint` 端点，因此不参与草图的闭环搜索，
 * 但可以作为「扫描路径」使用（见 `sketch/curve.ts` 的 `sketchPathPolylines`）。
 */
export function advancedCurveEdge(sk: Sketch, e: SkEntity, pl: SketchPlane): any {
  if (e.kind === 'parabola') return edgeForParabola(sk, e, pl);
  if (e.kind === 'hyperbola') return edgeForHyperbola(sk, e, pl);
  if (e.kind === 'bspline') return edgeForBSpline(sk, e, pl);
  return null;
}

// ============================================================
// 采样：用于嵌套判定与面积
// ============================================================
function sampleEntity(sk: Sketch, e: SkEntity, segs = 24): [number, number][] {
  if (e.kind === 'line') {
    const a = sk.points[e.a];
    const b = sk.points[e.b];
    return [
      [a.x, a.y],
      [b.x, b.y],
    ];
  }
  if (e.kind === 'point') {
    const p = sk.points[e.p];
    return [[p.x, p.y]];
  }
  if (e.kind === 'circle') {
    // 圆的采样要密一些：这里的多边形面积/包含关系会被当作区域判据
    const n = Math.max(segs, 128);
    const c = sk.points[e.c];
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      out.push([c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t)]);
    }
    return out;
  }
  if (e.kind === 'ellipse') {
    const n = Math.max(segs * 4, 160);
    const c = sk.points[e.c];
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const [dx, dy] = ellipsePointAt(e, (i / n) * Math.PI * 2);
      out.push([c.x + dx, c.y + dy]);
    }
    return out;
  }
  if (e.kind === 'parabola') {
    const n = Math.max(segs * 3, 96);
    const c = sk.points[e.c];
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = e.t0 + ((e.t1 - e.t0) * i) / n;
      const [dx, dy] = parabolaPointAt(e, t);
      out.push([c.x + dx, c.y + dy]);
    }
    return out;
  }
  if (e.kind === 'hyperbola') {
    const n = Math.max(segs * 3, 96);
    const c = sk.points[e.c];
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = e.t0 + ((e.t1 - e.t0) * i) / n;
      const [dx, dy] = hyperbolaPointAt(e, t);
      out.push([c.x + dx, c.y + dy]);
    }
    return out;
  }
  if (e.kind === 'bspline') {
    const data = bsplineDataFor(e);
    if (!data) return [];
    return bsplinePolyline(data, Math.max(segs * 3, 96));
  }
  const { a0, a1, r } = arcAngles(sk, e);
  const c = sk.points[e.c];
  const n = Math.max(8, Math.ceil((segs * Math.abs(a1 - a0)) / (Math.PI * 2)));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    out.push([c.x + r * Math.cos(t), c.y + r * Math.sin(t)]);
  }
  return out;
}

function polygonArea(poly: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function pointInPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ============================================================
// 闭环搜索
// ============================================================
interface Loop {
  /** 按顺序排列的实体 id 与遍历方向（from → to 的点 id） */
  steps: { entity: SkEntity; from: string; to: string }[];
  closed: boolean;
}

function findLoops(sk: Sketch, entities: SkEntity[]): Loop[] {
  void sk;
  const loops: Loop[] = [];
  const open = entities.filter((e) => e.kind === 'line' || e.kind === 'arc') as (SkLine | SkArc)[];
  const used = new Set<SkLine | SkArc>();

  // 点 → 关联的开放实体
  const atPoint = new Map<string, (SkLine | SkArc)[]>();
  for (const e of open) {
    for (const p of [e.a, e.b]) {
      if (!atPoint.has(p)) atPoint.set(p, []);
      atPoint.get(p)!.push(e);
    }
  }

  for (const start of open) {
    if (used.has(start)) continue;
    const startPt = start.a;
    const chain: Loop['steps'] = [];
    let cur: SkLine | SkArc = start;
    let from = start.a;
    let closed = false;

    for (let guard = 0; guard <= open.length + 2; guard++) {
      used.add(cur);
      const to = from === cur.a ? cur.b : cur.a;
      chain.push({ entity: cur, from, to });
      if (to === startPt) {
        closed = true;
        break;
      }
      const next = (atPoint.get(to) ?? []).find((e) => !used.has(e));
      if (!next) break;
      cur = next;
      from = to;
    }

    if (closed) loops.push({ steps: chain, closed: true });
  }

  // 整圆 / 整椭圆 / 闭合 B 样条自成一环（独立草图点不参与闭环）
  for (const e of entities) {
    if (e.kind === 'circle' || e.kind === 'ellipse') {
      loops.push({ steps: [{ entity: e, from: e.c, to: e.c }], closed: true });
    } else if (e.kind === 'bspline' && isClosedBSpline(e)) {
      loops.push({ steps: [{ entity: e, from: e.id, to: e.id }], closed: true });
    }
  }

  return loops;
}

// ============================================================
// 环 → 线框
// ============================================================
function wireFromLoop(sk: Sketch, loop: Loop, pl: SketchPlane): any {
  const o = oc();
  const mk = new o.BRepBuilderAPI_MakeWire_1();
  for (const st of loop.steps) {
    const e = st.entity;
    if (e.kind === 'circle') {
      mk.Add_1(edgeForCircle(sk, e, pl));
      continue;
    }
    if (e.kind === 'ellipse') {
      mk.Add_1(edgeForEllipse(sk, e, pl));
      continue;
    }
    if (e.kind === 'parabola') {
      mk.Add_1(edgeForParabola(sk, e, pl));
      continue;
    }
    if (e.kind === 'hyperbola') {
      mk.Add_1(edgeForHyperbola(sk, e, pl));
      continue;
    }
    if (e.kind === 'bspline') {
      const ed = edgeForBSpline(sk, e, pl);
      if (ed) mk.Add_1(ed);
      continue;
    }
    if (e.kind === 'point') continue; // 点不参与线框
    if (e.kind === 'line') {
      mk.Add_1(edgeForLine(sk, e, pl, st.from));
      continue;
    }
    // 圆弧：判断遍历方向与几何 ccw 是否一致
    const info = edgeForArc(sk, e, pl);
    const forward = st.from === info.fromId;
    const sameDirectionAsBuilt = forward;
    const edge = sameDirectionAsBuilt ? info.edge : o.TopoDS.Edge_1(info.edge.Reversed());
    mk.Add_1(edge);
  }
  if (!mk.IsDone()) throw new Error('线框构造失败：草图轮廓可能不连续');
  return mk.Wire();
}

// ============================================================
// 对外：草图 → 区域（外轮廓 + 孔）
// ============================================================
export function sketchToRegions(sk: Sketch, pl: SketchPlane): Region[] {
  const solid = sk.entities.filter((e) => !e.construction);
  if (!solid.length) return [];

  const loops = findLoops(sk, solid);
  const polys: { poly: [number, number][]; area: number; loop: Loop }[] = [];
  for (const lp of loops) {
    const poly: [number, number][] = [];
    for (const st of lp.steps) {
      const pts = sampleEntity(sk, st.entity, 32);
      for (const p of pts) poly.push(p);
    }
    if (poly.length < 3) continue;
    const area = polygonArea(poly);
    if (area < 1e-9) continue;
    polys.push({ poly, area, loop: lp });
  }

  // 嵌套判定：某环若被另一个面积更大的环包含，则它是孔
  const regions: Region[] = polys.map((p, i) => {
    let parent = -1;
    for (let j = 0; j < polys.length; j++) {
      if (i === j) continue;
      if (polys[j].area <= p.area) continue;
      if (pointInPolygon(p.poly[0], polys[j].poly)) {
        if (parent === -1 || polys[j].area < polys[parent].area) parent = j;
      }
    }
    return {
      outer: null as any,
      holes: [] as any[],
      polygon: p.poly,
      area: p.area,
      isOuter: parent === -1,
      // 临时字段，稍后清掉
      ...({ _parent: parent, _i: i } as any),
    } as Region & { _parent: number; _i: number };
  });

  // 为每个外环挂上它的直接子环作为孔
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i] as Region & { _parent: number; _i: number };
    if (r._parent === -1) continue;
    const parent = regions[r._parent] as Region;
    (parent as any).__holes = (parent as any).__holes ?? [];
    (parent as any).__holes.push(i);
  }

  const out: Region[] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i] as Region & { _parent: number; _i: number; __holes?: number[] };
    if (!r.isOuter) continue;
    r.outer = wireFromLoop(sk, polys[i].loop, pl);
    r.holes = (r.__holes ?? []).map((k) => {
      const w = wireFromLoop(sk, polys[k].loop, pl);
      // ⚠️ 内环必须反向，否则面积变"外 + 内"
      return oc().TopoDS.Wire_1(w.Reversed());
    });
    delete (r as any)._parent;
    delete (r as any)._i;
    delete (r as any).__holes;
    out.push(r);
  }
  return out;
}

/** 区域 → 面（含孔） */
export function regionToFace(region: Region): any {
  const o = oc();
  const mk = new o.BRepBuilderAPI_MakeFace_15(region.outer, false);
  for (const h of region.holes) mk.Add(h);
  return mk.Face();
}

/** 草图 → 全部面（每个封闭区域一个面） */
export function sketchToFaces(sk: Sketch, pl: SketchPlane): any[] {
  return sketchToRegions(sk, pl).map(regionToFace);
}

/** 草图 → 用于显示的 2D 折线（构造线单独返回） */
export function sketchDisplayPolylines(sk: Sketch): { pts: [number, number][]; construction: boolean; entity: SkEntity }[] {
  return sk.entities.map((e) => ({
    pts: sampleEntity(sk, e, 48),
    construction: !!e.construction,
    entity: e,
  }));
}
