/**
 * 草图叠加层 —— 把当前激活的草图绘制到 3D 视口里，并负责交互命中测试。
 *
 * 命中测试全部在草图的 2D 局部坐标里做（屏幕像素 → 射线 → 与草图平面求交 →
 * 转成 (u,v)），这样与相机朝向无关，逻辑最简单也最稳定。
 */
import * as THREE from 'three';
import type { SkBSpline, SkEntity, SkHyperbola, SkParabola, Sketch, SketchPlane } from '../sketch/types';
import { planeToWorld, worldToPlane, arcAngles, ellipsePointAt, hyperbolaPointAt, parabolaPointAt } from '../sketch/types';
import { bsplineInterpolate, bsplinePolyline } from '../sketch/curve';
import { COLORS, sketchMaterial } from './materials';
import { disposeGroupChildren } from './dispose';

/**
 * 高级曲线族的 2D 采样（纯数学，主线程可用）。
 *
 * ⚠️ 这里**不能**复用 `sketch/toShape.ts` 的 `sampleEntity` —— 那个文件 import 了
 * OCCT，会破坏"主线程不引用 OCCT"的架构不变量。
 */
export function curveEntityPoints(
  sk: Sketch,
  e: SkEntity,
  n = 96
): [number, number][] | null {
  if (e.kind === 'parabola') {
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
    const data = bsplineInterpolate(e.pts, 3, e.closed);
    return data ? bsplinePolyline(data, n) : [];
  }
  return null;
}

export interface HitPoint {
  pointId: string;
  d: number;
}

export interface HitEntity {
  entityId: string;
  /** 命中点在实体上的参数位置（0~1） */
  t: number;
  d: number;
}

export class SketchOverlay {
  readonly group: THREE.Group;
  private lineGroup: THREE.Group;
  private pointGroup: THREE.Group;
  private dimGroup: THREE.Group;
  private previewGroup: THREE.Group;
  private previewPolys: { pts: [number, number][]; construction: boolean }[] = [];
  private hint: string | null = null;
  private planeMesh: THREE.Mesh;
  private gridLines: THREE.LineSegments;
  private plane: SketchPlane;
  private sketch: Sketch | null = null;
  private displayMode = false;
  /** 显示态下整条草图是否呈现「选中」高亮（SolidWorks: 退出草图后该草图被选中） */
  private displaySelected = false;
  private selectedEntities = new Set<string>();
  private selectedPoints = new Set<string>();
  private hoverEntity: string | null = null;
  private hoverPoint: string | null = null;
  /**
   * 视觉变化回调（宿主接到 `viewport.invalidate()`）。
   *
   * 视口是**按需重绘**（见 Viewport 渲染循环）：没有 invalidate 就一帧都不会再画。
   * 覆盖层只改 three.js 场景图、不碰相机，因此必须在每次视觉变更后主动通知宿主，
   * 否则画面冻结在进入草图那一帧（表现为「鼠标移动没橡皮筋、点了也看不到线」）。
   */
  onChange: (() => void) | null = null;

  private changed(): void {
    this.onChange?.();
  }

  constructor(plane: SketchPlane) {
    this.plane = plane;
    this.group = new THREE.Group();
    this.group.name = 'sketchOverlay';

    // 草图平面底色
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4d9bf5,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.planeMesh = new THREE.Mesh(geo, mat);
    this.planeMesh.name = 'sketchPlaneFill';
    this.planeMesh.userData.isSketchPlane = true;
    this.orient(this.planeMesh);
    this.group.add(this.planeMesh);

    // 平面网格
    this.gridLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x4d9bf5, transparent: true, opacity: 0.16 })
    );
    this.orient(this.gridLines);
    this.group.add(this.gridLines);

    this.lineGroup = new THREE.Group();
    this.pointGroup = new THREE.Group();
    this.dimGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    // 预览要压在实体之上，否则被零件挡住看不见
    this.previewGroup.renderOrder = 12;
    this.group.add(this.lineGroup, this.pointGroup, this.dimGroup, this.previewGroup);

    this.buildGrid();
  }

  private orient(obj: THREE.Object3D): void {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(...this.plane.normal).normalize()
    );
    obj.quaternion.copy(q);
    obj.position.set(...this.plane.origin);
  }

  setPlane(plane: SketchPlane): void {
    this.plane = plane;
    this.orient(this.planeMesh);
    this.orient(this.gridLines);
    this.buildGrid();
    this.refresh();
  }

  private buildGrid(): void {
    // 网格随相机距离动态调整会更好，这里先用固定 200×200 / 10mm
    const half = 100;
    const step = 10;
    const pts: number[] = [];
    for (let x = -half; x <= half; x += step) {
      pts.push(x, -half, 0, x, half, 0);
      pts.push(-half, x, 0, half, x, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.gridLines.geometry.dispose();
    this.gridLines.geometry = geo;

    // 平面尺寸跟随视距，避免出现"无限大"的观感
    this.planeMesh.scale.set(half * 2, half * 2, 1);
  }

  setSketch(sketch: Sketch | null): void {
    this.sketch = sketch;
    this.refresh();
  }

  /**
   * 显示态（SolidWorks: 退出草图后草图仍以暗色显示在模型空间）。
   * 隐藏平面底色/网格/点，线条用 ghost 色，不参与悬停与选择高亮。
   */
  setDisplayMode(on: boolean): void {
    if (this.displayMode === on) return;
    this.displayMode = on;
    this.planeMesh.visible = !on;
    this.gridLines.visible = !on;
    this.pointGroup.visible = !on;
    this.dimGroup.visible = !on;
    this.hoverEntity = null;
    this.hoverPoint = null;
    this.refresh();
  }

  get isDisplayMode(): boolean {
    return this.displayMode;
  }

  /**
   * 显示态下整条草图是否呈现「选中」高亮（SolidWorks: 退出草图后草图处于选中状态，
   * 图形区以高亮色显示，提示可直接据此创建特征）。仅显示态生效，编辑态不受影响。
   */
  setDisplaySelected(on: boolean): void {
    if (this.displaySelected === on) return;
    this.displaySelected = on;
    if (this.displayMode) this.refresh();
  }

  get isDisplaySelected(): boolean {
    return this.displaySelected;
  }

  get currentPlane(): SketchPlane {
    return this.plane;
  }

  setSelection(entities: string[], points: string[]): void {
    this.selectedEntities = new Set(entities);
    this.selectedPoints = new Set(points);
    this.refresh();
  }

  setHover(entityId: string | null, pointId: string | null): void {
    if (this.hoverEntity === entityId && this.hoverPoint === pointId) return;
    this.hoverEntity = entityId;
    this.hoverPoint = pointId;
    this.refresh();
  }

  /** 工具进行中的预览折线（局部坐标） */
  setPreview(polys: { pts: [number, number][]; construction: boolean }[]): void {
    this.previewPolys = polys;
    this.refreshPreview();
  }

  setHint(text: string | null): void {
    this.hint = text;
  }

  get hintText(): string | null {
    return this.hint;
  }

  private refreshPreview(): void {
    if (!this.previewGroup) return;
    this.clearGroup(this.previewGroup);
    for (const p of this.previewPolys) {
      if (p.pts.length < 2) continue;
      const pts = p.pts.map(([x, y]) => new THREE.Vector3(...planeToWorld(this.plane, x, y, 0.03)));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = p.construction
        ? new THREE.LineDashedMaterial({ color: COLORS.sketchConstruction, dashSize: 2.4, gapSize: 1.6 })
        : new THREE.LineBasicMaterial({ color: COLORS.selectEdge });
      const line = new THREE.Line(geo, mat);
      if (p.construction) line.computeLineDistances();
      this.previewGroup.add(line);
    }
    this.changed();
  }

  // ---------------- 绘制 ----------------
  refresh(): void {
    this.clearGroup(this.lineGroup);
    this.clearGroup(this.pointGroup);
    this.clearGroup(this.dimGroup);
    const sk = this.sketch;
    if (!sk) {
      this.changed();
      return;
    }

    const mkPt = (x: number, y: number) => new THREE.Vector3(...planeToWorld(this.plane, x, y, 0.02));

    for (const e of sk.entities) {
      let pts: THREE.Vector3[] = [];
      if (e.kind === 'line') {
        const a = sk.points[e.a];
        const b = sk.points[e.b];
        pts = [mkPt(a.x, a.y), mkPt(b.x, b.y)];
      } else if (e.kind === 'circle') {
        const c = sk.points[e.c];
        for (let i = 0; i <= 96; i++) {
          const t = (i / 96) * Math.PI * 2;
          pts.push(mkPt(c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t)));
        }
      } else if (e.kind === 'ellipse') {
        const c = sk.points[e.c];
        for (let i = 0; i <= 96; i++) {
          const [dx, dy] = ellipsePointAt(e, (i / 96) * Math.PI * 2);
          pts.push(mkPt(c.x + dx, c.y + dy));
        }
      } else if (e.kind === 'point') {
        continue; // 独立草图点由下方的点组统一绘制（带专属标记）
      } else if (e.kind === 'parabola' || e.kind === 'hyperbola' || e.kind === 'bspline') {
        const local = curveEntityPoints(sk, e, 128) ?? [];
        pts = local.map(([x, y]) => mkPt(x, y));
      } else {
        const { a0, a1, r } = arcAngles(sk, e);
        const c = sk.points[e.c];
        const n = Math.max(12, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * 96));
        for (let i = 0; i <= n; i++) {
          const t = a0 + ((a1 - a0) * i) / n;
          pts.push(mkPt(c.x + r * Math.cos(t), c.y + r * Math.sin(t)));
        }
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const selected = this.displayMode
        ? this.displaySelected
        : this.selectedEntities.has(e.id) || this.hoverEntity === e.id;
      const mat = sketchMaterial(selected, !!e.construction, this.displayMode);
      if (e.construction) {
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        this.lineGroup.add(line);
      } else {
        this.lineGroup.add(new THREE.Line(geo, mat));
      }
    }

    // 点（独立草图点画得稍大，便于与端点区分）
    const freePts = new Set<string>();
    for (const e of sk.entities) if (e.kind === 'point') freePts.add(e.p);
    const dotGeo = new THREE.SphereGeometry(1, 8, 6);
    for (const p of Object.values(sk.points)) {
      const sel = this.selectedPoints.has(p.id) || this.hoverPoint === p.id;
      const mat = new THREE.MeshBasicMaterial({
        color: sel ? COLORS.sketchSelected : COLORS.sketchPoint,
        depthTest: false,
      });
      const m = new THREE.Mesh(dotGeo, mat);
      m.position.set(...planeToWorld(this.plane, p.x, p.y, 0.05));
      const s = sel ? 0.9 : freePts.has(p.id) ? 0.92 : 0.62;
      m.scale.set(s, s, s);
      m.renderOrder = 10;
      this.pointGroup.add(m);
    }
    this.changed();
  }

  private clearGroup(g: THREE.Group): void {
    disposeGroupChildren(g);
  }

  // ---------------- 命中测试 ----------------
  /** 世界点 → 草图 (u,v) */
  toLocal(world: THREE.Vector3): [number, number] {
    const [u, v] = worldToPlane(this.plane, [world.x, world.y, world.z]);
    return [u, v];
  }

  /** 射线与草图平面求交 */
  intersectPlane(ray: THREE.Ray): THREE.Vector3 | null {
    const n = new THREE.Vector3(...this.plane.normal).normalize();
    const o = new THREE.Vector3(...this.plane.origin);
    const denom = ray.direction.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / denom;
    if (t < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  }

  hitPoint(local: [number, number], tolWorld: number): HitPoint | null {
    const sk = this.sketch;
    if (!sk) return null;
    let best: HitPoint | null = null;
    for (const p of Object.values(sk.points)) {
      const d = Math.hypot(p.x - local[0], p.y - local[1]);
      if (d <= tolWorld && (!best || d < best.d)) best = { pointId: p.id, d };
    }
    return best;
  }

  hitEntity(local: [number, number], tolWorld: number, includePoints = true): HitEntity | null {
    const sk = this.sketch;
    if (!sk) return null;
    let best: HitEntity | null = null;
    for (const e of sk.entities) {
      if (!includePoints && e.kind === 'point') continue;
      const r = this.distanceToEntity(sk, e, local);
      if (r !== null && r.d <= tolWorld && (!best || r.d < best.d)) {
        best = { entityId: e.id, t: r.t, d: r.d };
      }
    }
    return best;
  }

  private distanceToEntity(sk: Sketch, e: SkEntity, p: [number, number]): { d: number; t: number } | null {
    if (e.kind === 'line') {
      const a = sk.points[e.a];
      const b = sk.points[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy || 1e-12;
      let t = ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + dx * t;
      const cy = a.y + dy * t;
      return { d: Math.hypot(p[0] - cx, p[1] - cy), t };
    }
    if (e.kind === 'circle') {
      const c = sk.points[e.c];
      const d = Math.abs(Math.hypot(p[0] - c.x, p[1] - c.y) - e.r);
      const ang = Math.atan2(p[1] - c.y, p[0] - c.x);
      return { d, t: (ang + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) };
    }
    if (e.kind === 'point') {
      const pt = sk.points[e.p];
      return { d: Math.hypot(p[0] - pt.x, p[1] - pt.y), t: 0 };
    }
    if (e.kind === 'ellipse') {
      // 椭圆的点到曲线距离没有闭式解，采样求最近点即可（命中判定足够用）
      const c = sk.points[e.c];
      let bestD = Infinity;
      let bestT = 0;
      const N = 128;
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2;
        const [dx, dy] = ellipsePointAt(e, t);
        const d = Math.hypot(p[0] - (c.x + dx), p[1] - (c.y + dy));
        if (d < bestD) {
          bestD = d;
          bestT = i / N;
        }
      }
      return { d: bestD, t: bestT };
    }
    if (e.kind === 'parabola' || e.kind === 'hyperbola' || e.kind === 'bspline') {
      // 高级曲线族：采样求最近点（命中判定足够用）
      const pts = curveEntityPoints(sk, e, 160) ?? [];
      let bestD = Infinity;
      let bestT = 0;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]);
        if (d < bestD) {
          bestD = d;
          bestT = pts.length > 1 ? i / (pts.length - 1) : 0;
        }
      }
      return pts.length ? { d: bestD, t: bestT } : null;
    }
    // arc
    const { a0, a1, r } = arcAngles(sk, e);
    const c = sk.points[e.c];
    const ang = Math.atan2(p[1] - c.y, p[0] - c.x);
    const inRange = (a1 >= a0 && ang >= a0 && ang <= a1) || (a1 < a0 && (ang >= a0 || ang <= a1));
    const dRad = Math.abs(Math.hypot(p[0] - c.x, p[1] - c.y) - r);
    if (!inRange) {
      // 端点距离
      const pa = [c.x + r * Math.cos(a0), c.y + r * Math.sin(a0)];
      const pb = [c.x + r * Math.cos(a1), c.y + r * Math.sin(a1)];
      const da = Math.hypot(p[0] - pa[0], p[1] - pa[1]);
      const db = Math.hypot(p[0] - pb[0], p[1] - pb[1]);
      const d = Math.min(da, db);
      return d < 3 ? { d, t: da < db ? 0 : 1 } : null;
    }
    const span = Math.abs(a1 - a0) || 1e-9;
    const t = ((ang - a0 + Math.PI * 2) % (Math.PI * 2)) / span;
    return { d: dRad, t: Math.max(0, Math.min(1, t)) };
  }

  /** 把屏幕坐标映射到草图局部坐标 */
  screenToLocal(ray: THREE.Ray): [number, number] | null {
    const w = this.intersectPlane(ray);
    if (!w) return null;
    return this.toLocal(w);
  }

  dispose(): void {
    this.clearGroup(this.lineGroup);
    this.clearGroup(this.pointGroup);
    this.clearGroup(this.dimGroup);
    this.clearGroup(this.previewGroup);
    this.planeMesh.geometry.dispose();
    (this.planeMesh.material as THREE.Material).dispose();
    this.gridLines.geometry.dispose();
    (this.gridLines.material as THREE.Material).dispose();
    this.group.removeFromParent();
    this.changed();
  }
}
