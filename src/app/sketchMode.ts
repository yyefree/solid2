/**
 * 草图交互控制器。
 *
 * 负责：工具的点击序列、捕捉、自动约束、选择、拖拽求解、预览。
 * 全部命中测试在草图 2D 局部坐标里完成（见 SketchOverlay）。
 */
import * as THREE from 'three';
import type { App } from './app';
import type { SketchFeature } from '../doc/types';
import { SketchOverlay, type HitEntity, type HitPoint } from '../view/sketchview';
import { solveSketch } from '../sketch/solver';
import {
  emptySketch,
  newId,
  slotTemplate,
  mirrorEntitiesInPlace,
  parabolaPointAt,
  hyperbolaPointAt,
  type SkConstraint,
  type SkEntity,
  type SkLine,
  type Sketch,
} from '../sketch/types';
import { bsplineInterpolate, bsplinePolyline } from '../sketch/curve';
import { notify, promptNumber } from '../ui/toast';
import { COLORS } from '../view/materials';

export type SketchTool =
  | 'select'
  | 'line'
  | 'rect'
  | 'circle'
  | 'arc'
  | 'polygon'
  | 'ellipse'
  | 'slot'
  | 'point'
  | 'parabola'
  | 'hyperbola'
  | 'bspline';

export class SketchController {
  private app: App;
  private overlay: SketchOverlay | null = null;
  /** 模型态下正在显示的草图特征（退出草图后仍可见） */
  private displayFeature: SketchFeature | null = null;
  tool: SketchTool = 'select';
  /** 已选中的实体 / 点 */
  selEntities = new Set<string>();
  selPoints = new Set<string>();

  /** 工具进行中的点 */
  private staged: [number, number][] = [];
  /** 圆弧的圆心（第 3 次点击需要） */
  private previewLocal: [number, number][] = [];

  /** 拖拽 */
  private dragging: { pointId: string; offset: [number, number] } | null = null;
  private hoverPoint: string | null = null;
  private hoverEntity: string | null = null;
  /** 捕捉提示 */
  private snapHint: string | null = null;
  private polygonSides = 6;

  constructor(app: App) {
    this.app = app;
  }

  // ------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------
  attach(): void {
    const f = this.app.editingSketch;
    if (!f) return;
    const plane = this.app.sketchPlane;
    if (!this.overlay) {
      this.overlay = new SketchOverlay(plane);
      this.app.viewport.scene.add(this.overlay.group);
    } else {
      this.overlay.setPlane(plane);
    }
    // 从模型态显示态切回编辑态：恢复平面底色/网格/点
    this.overlay.setDisplayMode(false);
    this.displayFeature = null;
    if (!f.params.sketch.entities.length && !f.params.sketch.constraints.length) {
      f.params.sketch = emptySketch();
    }
    this.overlay.setSketch(f.params.sketch);
    this.overlay.setSelection([], []);
    this.selEntities.clear();
    this.selPoints.clear();
    this.staged = [];
    this.tool = 'select';

    // 相机摆到正对草图平面
    const pl = plane;
    const camDir: [number, number, number] = [-pl.normal[0], -pl.normal[1], -pl.normal[2]];
    const cam = this.app.viewport.camera;
    const target = new THREE.Vector3(...pl.origin);
    const dist = 260;
    const pos = target.clone().addScaledVector(new THREE.Vector3(...camDir), dist);
    const up = new THREE.Vector3(...pl.v);
    cam.up.copy(up);
    cam.position.copy(pos);
    this.app.viewport.controls.target.copy(target);
    this.app.viewport.controls.update();
    this.app.viewport.invalidate();
  }

  detach(): void {
    if (this.overlay) {
      this.overlay.dispose();
      this.overlay = null;
    }
    this.displayFeature = null;
    this.staged = [];
    this.previewLocal = [];
    this.dragging = null;
  }

  /**
   * 模型态显示某个草图（SolidWorks: 退出草图后草图保留可见）。
   * 不移动相机、不接管输入；isActive 仍为 false，交互由模型态逻辑处理。
   */
  showDisplay(f: SketchFeature): void {
    if (this.app.editingSketch) return;
    const plane = this.app.planeOfSketch(f);
    if (!this.overlay) {
      this.overlay = new SketchOverlay(plane);
      this.app.viewport.scene.add(this.overlay.group);
    } else {
      this.overlay.setPlane(plane);
    }
    this.displayFeature = f;
    if (!f.params.sketch.entities.length && !f.params.sketch.constraints.length) {
      f.params.sketch = emptySketch();
    }
    this.overlay.setSketch(f.params.sketch);
    this.overlay.setSelection([], []);
    this.overlay.setPreview([]);
    this.overlay.setDisplayMode(true);
  }

  /** 模型态下射线命中显示态草图时返回该草图特征（图形区选中草图），不含独立点 */
  pickDisplay(ray: THREE.Ray, tolWorld: number): SketchFeature | null {
    if (!this.overlay || !this.displayFeature || this.app.editingSketch) return null;
    if (!this.overlay.isDisplayMode) return null;
    const w = this.overlay.intersectPlane(ray);
    if (!w) return null;
    const local = this.overlay.toLocal(w);
    return this.overlay.hitEntity(local, tolWorld, false) ? this.displayFeature : null;
  }

  /** 当前显示态草图的平面（用于计算拾取容差），无则 null */
  get displayPlane(): { normal: [number, number, number]; origin: [number, number, number] } | null {
    if (!this.overlay || !this.overlay.isDisplayMode) return null;
    return this.overlay.currentPlane;
  }

  get displaySketch(): SketchFeature | null {
    return this.displayFeature;
  }

  /** 非模型态（装配/工程图）隐藏草图显示层 */
  setDisplayVisible(v: boolean): void {
    if (this.overlay && !this.app.editingSketch) this.overlay.group.visible = v;
  }

  get isActive(): boolean {
    return !!this.overlay && !!this.app.editingSketch;
  }

  private get sketch(): Sketch | null {
    return this.app.editingSketch?.params.sketch ?? null;
  }

  refresh(): void {
    this.overlay?.setSketch(this.sketch);
    this.overlay?.setSelection([...this.selEntities], [...this.selPoints]);
    this.overlay?.setPreview(this.previewPolylines());
  }

  setTool(t: SketchTool): void {
    this.tool = t;
    this.staged = [];
    this.previewLocal = [];
    this.snapHint = null;
    this.overlay?.setHint(this.hintText());
    this.refresh();
    this.app.emit('props', 'change');
  }

  hintText(): string {
    switch (this.tool) {
      case 'line':
        return '点击确定起点，再点击确定终点（可连续绘制，Esc 结束）';
      case 'rect':
        return '点击确定对角点';
      case 'circle':
        return '点击确定圆心，再点击确定半径';
      case 'arc':
        return '依次点击：圆心 → 起点 → 终点';
      case 'polygon':
        return `点击确定中心（当前 ${this.polygonSides} 边多边形）`;
      case 'ellipse':
        return '依次点击：中心 → 长轴端点 → 短轴距离';
      case 'slot':
        return '依次点击：起点圆心 → 终点圆心 → 槽宽';
      case 'point':
        return '点击放置一个参考点（可被异型孔向导当作孔心）';
      case 'parabola':
        return '依次点击：顶点 → 焦点 → 开口范围';
      case 'hyperbola':
        return '依次点击：中心 → 实轴端点 → 虚轴距离';
      case 'bspline':
        return `连续点击放置通过点（当前 ${this.staged.length} 个），按 Enter 或双击结束（回到起点附近可闭合）`;
      default:
        return '选择：点击实体/点；拖拽点可拖动求解';
    }
  }

  // ------------------------------------------------------------
  // 指针交互
  // ------------------------------------------------------------
  handleClick(x: number, y: number, additive: boolean): boolean {
    if (!this.isActive) return false;
    const ray = this.app.viewport.rayFromScreen(x, y).ray;
    const local = this.overlay!.screenToLocal(ray);
    if (!local) return true;
    const tol = this.tolWorld(local);

    if (this.tool === 'select') {
      const p = this.overlay!.hitPoint(local, tol * 0.9);
      if (p) {
        if (!additive) {
          this.selPoints.clear();
          this.selEntities.clear();
        }
        if (this.selPoints.has(p.pointId)) this.selPoints.delete(p.pointId);
        else this.selPoints.add(p.pointId);
        this.refresh();
        this.app.emit('props');
        return true;
      }
      const e = this.overlay!.hitEntity(local, tol * 0.9);
      if (e) {
        if (!additive) {
          this.selPoints.clear();
          this.selEntities.clear();
        }
        if (this.selEntities.has(e.entityId)) this.selEntities.delete(e.entityId);
        else this.selEntities.add(e.entityId);
        this.refresh();
        this.app.emit('props');
        return true;
      }
      if (!additive) {
        this.selPoints.clear();
        this.selEntities.clear();
        this.refresh();
        this.app.emit('props');
      }
      return true;
    }

    // 绘制工具
    const snapped = this.snap(local, tol);
    this.staged.push(snapped.pt);
    this.stagedSnaps.push(snapped.snapPointId);
    this.commitIfReady();
    this.refresh();
    return true;
  }

  private stagedSnaps: (string | null)[] = [];

  private commitIfReady(): void {
    const sk = this.sketch;
    if (!sk) return;
    switch (this.tool) {
      case 'line': {
        if (this.staged.length === 2) {
          const n0 = sk.entities.length;
          this.addLine(sk, this.staged[0], this.staged[1], this.stagedSnaps[0], this.stagedSnaps[1]);
          // 连续绘制：让下一条线段**复用上一条的终点**（共享点 id）。
          // ⚠️ 不能用 stagedSnaps[1]——那是端点「点击瞬间」的捕捉结果，而此刻该点还不存在，
          //    几乎总是 null；于是每段都新建一个点，链式草图的相邻端点 id 不同，
          //    首尾点即使坐标重合也不连通 → 轮廓判成「未封闭」，拉伸失败。
          //    复用终点 id 后，相邻段首尾相接（等效 SW 的自动「重合」约束），首尾即可闭合。
          const ent = sk.entities[n0] ?? sk.entities[sk.entities.length - 1];
          const lastSnap = ent && ent.kind === 'line' ? ent.b : this.stagedSnaps[1];
          const last = this.staged[1];
          this.staged = [last];
          this.stagedSnaps = [lastSnap];
        }
        break;
      }
      case 'rect': {
        if (this.staged.length === 2) {
          this.addRect(sk, this.staged[0], this.staged[1]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'circle': {
        if (this.staged.length === 2) {
          this.addCircle(sk, this.staged[0], this.staged[1]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'arc': {
        if (this.staged.length === 3) {
          this.addArc(sk, this.staged[0], this.staged[1], this.staged[2]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'polygon': {
        if (this.staged.length === 2) {
          this.addPolygon(sk, this.staged[0], this.staged[1]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'ellipse': {
        if (this.staged.length === 3) {
          this.addEllipse(sk, this.staged[0], this.staged[1], this.staged[2]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'slot': {
        if (this.staged.length === 3) {
          this.addSlot(sk, this.staged[0], this.staged[1], this.staged[2]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'point': {
        if (this.staged.length === 1) {
          this.addPoint(sk, this.staged[0]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'parabola': {
        if (this.staged.length === 3) {
          this.addParabola(sk, this.staged[0], this.staged[1], this.staged[2]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'hyperbola': {
        if (this.staged.length === 3) {
          this.addHyperbola(sk, this.staged[0], this.staged[1], this.staged[2]);
          this.staged = [];
          this.stagedSnaps = [];
        }
        break;
      }
      case 'bspline': {
        // B 样条是"连续点击 + Enter 结束"，不在这里自动提交；
        // 只是更新提示文案（显示已放置的点数）
        this.overlay?.setHint(this.hintText());
        break;
      }
      default:
        break;
    }
    this.solve();
  }

  // ------------------------------------------------------------
  // 捕捉
  // ------------------------------------------------------------
  private tolWorld(local: [number, number]): number {
    return this.app.viewport.pixelSizeAt([...this.app.sketchPlane.origin]) * 8;
  }

  private snap(local: [number, number], tol: number): { pt: [number, number]; snapPointId: string | null } {
    const sk = this.sketch!;
    // 1) 端点捕捉
    let best: { id: string; d: number; x: number; y: number } | null = null;
    for (const p of Object.values(sk.points)) {
      const d = Math.hypot(p.x - local[0], p.y - local[1]);
      if (d < tol * 1.4 && (!best || d < best.d)) best = { id: p.id, d, x: p.x, y: p.y };
    }
    if (best) {
      this.snapHint = '端点';
      return { pt: [best.x, best.y], snapPointId: best.id };
    }

    // 2) 与已有点水平/竖直对齐
    for (const p of Object.values(sk.points)) {
      if (Math.abs(p.y - local[1]) < tol) {
        this.snapHint = '水平对齐';
        return { pt: [local[0], p.y], snapPointId: null };
      }
      if (Math.abs(p.x - local[0]) < tol) {
        this.snapHint = '竖直对齐';
        return { pt: [p.x, local[1]], snapPointId: null };
      }
    }

    // 3) 网格捕捉（1mm）
    this.snapHint = null;
    return { pt: [Math.round(local[0]), Math.round(local[1])], snapPointId: null };
  }

  // ------------------------------------------------------------
  // 图元创建
  // ------------------------------------------------------------
  private mkPoint(sk: Sketch, x: number, y: number, reuseId: string | null): string {
    if (reuseId && sk.points[reuseId]) return reuseId;
    const id = newId('p');
    sk.points[id] = { id, x, y };
    return id;
  }

  private addLine(sk: Sketch, a: [number, number], b: [number, number], snapA: string | null, snapB: string | null): void {
    const pa = this.mkPoint(sk, a[0], a[1], snapA);
    const pb = this.mkPoint(sk, b[0], b[1], snapB);
    const id = newId('e');
    sk.entities.push({ id, kind: 'line', a: pa, b: pb });
    // 自动约束：近水平/竖直
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    const tolAuto = Math.max(dx, dy) * 0.06;
    if (dy < tolAuto && dx > 1e-6) {
      sk.constraints.push({ id: newId('c'), type: 'horizontal', e1: id });
    } else if (dx < tolAuto && dy > 1e-6) {
      sk.constraints.push({ id: newId('c'), type: 'vertical', e1: id });
    }
  }

  private addRect(sk: Sketch, a: [number, number], b: [number, number]): void {
    const x0 = Math.min(a[0], b[0]);
    const x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]);
    const y1 = Math.max(a[1], b[1]);
    const p1 = this.mkPoint(sk, x0, y0, null);
    const p2 = this.mkPoint(sk, x1, y0, null);
    const p3 = this.mkPoint(sk, x1, y1, null);
    const p4 = this.mkPoint(sk, x0, y1, null);
    const ids = [
      [p1, p2],
      [p2, p3],
      [p3, p4],
      [p4, p1],
    ];
    const lines: string[] = [];
    for (const [pa, pb] of ids) {
      const id = newId('e');
      sk.entities.push({ id, kind: 'line', a: pa, b: pb });
      lines.push(id);
    }
    sk.constraints.push({ id: newId('c'), type: 'horizontal', e1: lines[0] });
    sk.constraints.push({ id: newId('c'), type: 'horizontal', e1: lines[2] });
    sk.constraints.push({ id: newId('c'), type: 'vertical', e1: lines[1] });
    sk.constraints.push({ id: newId('c'), type: 'vertical', e1: lines[3] });
  }

  private addCircle(sk: Sketch, c: [number, number], edge: [number, number]): void {
    const r = Math.hypot(edge[0] - c[0], edge[1] - c[1]);
    if (r < 1e-6) return;
    const pc = this.mkPoint(sk, c[0], c[1], null);
    sk.entities.push({ id: newId('e'), kind: 'circle', c: pc, r });
  }

  private addArc(sk: Sketch, center: [number, number], start: [number, number], end: [number, number]): void {
    const r = Math.hypot(start[0] - center[0], start[1] - center[1]);
    if (r < 1e-6) return;
    const pc = this.mkPoint(sk, center[0], center[1], null);
    // 把终点投到圆上
    const ang = Math.atan2(end[1] - center[1], end[0] - center[0]);
    const pe = this.mkPoint(sk, center[0] + r * Math.cos(ang), center[1] + r * Math.sin(ang), null);
    const pa = this.mkPoint(sk, start[0], start[1], null);
    const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
    const a1 = Math.atan2(pe ? Math.sin(ang) : 0, Math.cos(ang));
    let ccw = true;
    let d = a1 - a0;
    while (d < 0) d += Math.PI * 2;
    ccw = d <= Math.PI;
    const id = newId('e');
    sk.entities.push({ id, kind: 'arc', c: pc, a: pa, b: pe, ccw });
    // 半径相等约束
    sk.constraints.push({ id: newId('c'), type: 'equal', e1: id, e2: id });
  }

  private addPolygon(sk: Sketch, center: [number, number], edge: [number, number]): void {
    const r = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
    if (r < 1e-6) return;
    const n = this.polygonSides;
    const a0 = Math.atan2(edge[1] - center[1], edge[0] - center[0]);
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = a0 + (i / n) * Math.PI * 2;
      pts.push(this.mkPoint(sk, center[0] + r * Math.cos(t), center[1] + r * Math.sin(t), null));
    }
    for (let i = 0; i < n; i++) {
      sk.entities.push({ id: newId('e'), kind: 'line', a: pts[i], b: pts[(i + 1) % n] });
    }
  }

  /**
   * 椭圆：3 次点击（中心 → 长轴端点 → 短轴距离）。
   * `rx` 始终取长半轴、`ry` 取短半轴；若用户画的"长轴"其实更短，则交换并让 rot 转 90°。
   */
  private addEllipse(sk: Sketch, center: [number, number], majorEnd: [number, number], minorPt: [number, number]): void {
    const dx = majorEnd[0] - center[0];
    const dy = majorEnd[1] - center[1];
    const a = Math.hypot(dx, dy);
    if (a < 1e-6) return;
    const rot = Math.atan2(dy, dx);
    const nx = -Math.sin(rot);
    const ny = Math.cos(rot);
    const b = Math.abs((minorPt[0] - center[0]) * nx + (minorPt[1] - center[1]) * ny);
    if (b < 1e-6) return;
    const rx = Math.max(a, b);
    const ry = Math.min(a, b);
    const rotFinal = a >= b ? rot : rot + Math.PI / 2;
    const pc = this.mkPoint(sk, center[0], center[1], null);
    sk.entities.push({ id: newId('e'), kind: 'ellipse', c: pc, rx, ry, rot: rotFinal });
  }

  /**
   * 直槽口：3 次点击（起点圆心 → 终点圆心 → 槽宽）。
   * 几何构造在 `slotTemplate`（纯函数，工具与测试共用），这里只负责落点与建实体。
   */
  private addSlot(sk: Sketch, c1: [number, number], c2: [number, number], w: [number, number]): void {
    const dx = c2[0] - c1[0];
    const dy = c2[1] - c1[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const r = Math.abs((w[0] - c1[0]) * (-dy / L) + (w[1] - c1[1]) * (dx / L));
    const tpl = slotTemplate(c1, c2, r);
    if (!tpl) return;
    const ids = tpl.points.map(([x, y]) => this.mkPoint(sk, x, y, null));
    for (const t of tpl.entities) {
      if (t.kind === 'line') {
        sk.entities.push({ id: newId('e'), kind: 'line', a: ids[t.a], b: ids[t.b] });
      } else {
        sk.entities.push({ id: newId('e'), kind: 'arc', c: ids[t.c], a: ids[t.a], b: ids[t.b], ccw: t.ccw });
      }
    }
  }

  /** 独立草图点 */
  private addPoint(sk: Sketch, p: [number, number]): void {
    const pid = this.mkPoint(sk, p[0], p[1], null);
    sk.entities.push({ id: newId('e'), kind: 'point', p: pid });
  }

  /**
   * 抛物线：3 次点击（顶点 → 焦点 → 开口范围）。
   *
   * 焦点与顶点的距离就是焦距 `focal`，两点连线方向就是对称轴 `rot`。
   * 第 3 点决定参数范围：参数 `t` 恰好是**局部 Y 坐标**（见 `parabolaPointAt`），
   * 所以直接取该点在局部系里的 Y 分量，再取对称区间 `[−t1, t1]`。
   */
  private addParabola(sk: Sketch, vertex: [number, number], focus: [number, number], rangePt: [number, number]): void {
    const dx = focus[0] - vertex[0];
    const dy = focus[1] - vertex[1];
    const focal = Math.hypot(dx, dy);
    if (focal < 1e-6) return;
    const rot = Math.atan2(dy, dx);
    const [, ly] = toLocalRot(rangePt, vertex, rot);
    const t1 = Math.max(Math.abs(ly), 2 * Math.sqrt(focal));
    const pc = this.mkPoint(sk, vertex[0], vertex[1], null);
    sk.entities.push({ id: newId('e'), kind: 'parabola', c: pc, focal, rot, t0: -t1, t1 });
  }

  /**
   * 双曲线：3 次点击（中心 → 实轴端点 → 虚轴距离）。
   *
   * 中心到实轴端点的距离是实半轴 `a`，连线方向是实轴 `rot`；
   * 第 3 点到实轴的垂直距离是虚半轴 `b`。参数范围取固定的 `[−1.6, 1.6]`
   * （`cosh(1.6) ≈ 2.58`，即曲线延伸到约 2.6a 处）。
   */
  private addHyperbola(sk: Sketch, center: [number, number], vertex: [number, number], bPt: [number, number]): void {
    const dx = vertex[0] - center[0];
    const dy = vertex[1] - center[1];
    const a = Math.hypot(dx, dy);
    if (a < 1e-6) return;
    const rot = Math.atan2(dy, dx);
    const [, ly] = toLocalRot(bPt, center, rot);
    const b = Math.abs(ly);
    if (b < 1e-6) return;
    const pc = this.mkPoint(sk, center[0], center[1], null);
    const T = 1.6;
    sk.entities.push({ id: newId('e'), kind: 'hyperbola', c: pc, a, b, rot, t0: -T, t1: T });
  }

  /**
   * B 样条：把已放置的通过点交给 `bsplineInterpolate` 求控制点。
   *
   * 末点若落在起点附近（3 像素容差）则自动视为**闭合**，去掉重合的末点。
   */
  private addBSpline(sk: Sketch, pts: [number, number][]): void {
    if (pts.length < 2) return;
    let list = pts.map((p) => [p[0], p[1]] as [number, number]);
    let closed = false;
    if (list.length >= 3) {
      const tol = this.tolWorld(list[0]) * 3;
      const [x0, y0] = list[0];
      const [xn, yn] = list[list.length - 1];
      if (Math.hypot(xn - x0, yn - y0) <= tol) {
        closed = true;
        list = list.slice(0, -1);
      }
    }
    if (list.length < 2) return;
    sk.entities.push({ id: newId('e'), kind: 'bspline', pts: list, closed });
  }

  /** 结束 B 样条绘制（Enter / 双击触发）。点数不足时提示并不提交。 */
  finishBSpline(): void {
    const sk = this.sketch;
    if (!sk || this.tool !== 'bspline') return;
    if (this.staged.length < 2) {
      notify.info('B 样条至少需要 2 个通过点');
      return;
    }
    this.addBSpline(sk, this.staged);
    const n = this.staged.length;
    this.staged = [];
    this.stagedSnaps = [];
    this.solve();
    this.refresh();
    this.overlay?.setHint(this.hintText());
    this.app.emit('props', 'change');
    notify.info(`已创建 B 样条（${n} 个通过点）`);
  }

  /**
   * 镜像实体（SolidWorks「镜像实体」）。
   *
   * 要求：选中**恰好一条直线**作为镜像轴，外加至少一个待镜像实体。
   * 镜像会翻转手性 —— 圆弧的 `ccw` 取反、椭圆的 `rot` 关于轴方向取反。
   */
  mirrorSelection(): void {
    const sk = this.sketch;
    if (!sk) return;
    const axisId = [...this.selEntities].find((id) => sk.entities.find((x) => x.id === id)?.kind === 'line');
    if (!axisId) {
      notify.info('请先选中一条直线作为镜像轴');
      return;
    }
    const targets = [...this.selEntities].filter((id) => id !== axisId);
    if (!targets.length) {
      notify.info('请再选中要镜像的实体（可与镜像轴一起框选）');
      return;
    }
    const n = mirrorEntitiesInPlace(sk, axisId, targets);
    this.selEntities.clear();
    this.solve();
    this.refresh();
    this.app.emit('props', 'change');
    notify.info(`已镜像 ${n} 个实体`);
  }

  // ------------------------------------------------------------
  // 预览
  // ------------------------------------------------------------
  private previewPolylines(): { pts: [number, number][]; construction: boolean }[] {
    if (!this.staged.length) return [];
    const cur = this.cursorLocal;
    const out: { pts: [number, number][]; construction: boolean }[] = [];
    switch (this.tool) {
      case 'line':
        if (cur) out.push({ pts: [this.staged[0], cur], construction: false });
        break;
      case 'rect':
        if (cur) {
          out.push({
            pts: [
              [this.staged[0][0], this.staged[0][1]],
              [cur[0], this.staged[0][1]],
              [cur[0], cur[1]],
              [this.staged[0][0], cur[1]],
              [this.staged[0][0], this.staged[0][1]],
            ],
            construction: false,
          });
        }
        break;
      case 'circle':
        if (cur) {
          const r = Math.hypot(cur[0] - this.staged[0][0], cur[1] - this.staged[0][1]);
          const pts: [number, number][] = [];
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            pts.push([this.staged[0][0] + r * Math.cos(t), this.staged[0][1] + r * Math.sin(t)]);
          }
          out.push({ pts, construction: false });
        }
        break;
      case 'arc':
        if (this.staged.length === 1 && cur) {
          out.push({ pts: [this.staged[0], cur], construction: true });
        } else if (this.staged.length === 2 && cur) {
          const c = this.staged[0];
          const r = Math.hypot(this.staged[1][0] - c[0], this.staged[1][1] - c[1]);
          const a0 = Math.atan2(this.staged[1][1] - c[1], this.staged[1][0] - c[0]);
          let a1 = Math.atan2(cur[1] - c[1], cur[0] - c[0]);
          while (a1 <= a0) a1 += Math.PI * 2;
          const pts: [number, number][] = [];
          const n = 40;
          for (let i = 0; i <= n; i++) {
            const t = a0 + ((a1 - a0) * i) / n;
            pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
          }
          out.push({ pts, construction: false });
          out.push({ pts: [c, this.staged[1]], construction: true });
        }
        break;
      case 'polygon':
        if (cur) {
          const r = Math.hypot(cur[0] - this.staged[0][0], cur[1] - this.staged[0][1]);
          const a0 = Math.atan2(cur[1] - this.staged[0][1], cur[0] - this.staged[0][0]);
          const pts: [number, number][] = [];
          for (let i = 0; i <= this.polygonSides; i++) {
            const t = a0 + (i / this.polygonSides) * Math.PI * 2;
            pts.push([this.staged[0][0] + r * Math.cos(t), this.staged[0][1] + r * Math.sin(t)]);
          }
          out.push({ pts, construction: false });
        }
        break;
      case 'ellipse': {
        const c = this.staged[0];
        if (!c || !cur) break;
        if (this.staged.length === 1) {
          const rx = Math.hypot(cur[0] - c[0], cur[1] - c[1]);
          if (rx < 1e-9) break;
          const rot = Math.atan2(cur[1] - c[1], cur[0] - c[0]);
          const cs = Math.cos(rot);
          const sn = Math.sin(rot);
          const pts: [number, number][] = [];
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            pts.push([c[0] + rx * Math.cos(t) * cs, c[1] + rx * Math.cos(t) * sn]);
          }
          out.push({ pts, construction: false });
          out.push({ pts: [c, cur], construction: true });
        } else {
          const m = this.staged[1];
          const dx = m[0] - c[0];
          const dy = m[1] - c[1];
          const a = Math.hypot(dx, dy);
          if (a < 1e-9) break;
          const rot0 = Math.atan2(dy, dx);
          const nx = -Math.sin(rot0);
          const ny = Math.cos(rot0);
          const b = Math.abs((cur[0] - c[0]) * nx + (cur[1] - c[1]) * ny);
          const rx = Math.max(a, b);
          const ry = Math.min(a, b);
          const rot = a >= b ? rot0 : rot0 + Math.PI / 2;
          const cs = Math.cos(rot);
          const sn = Math.sin(rot);
          const pts: [number, number][] = [];
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            const x = rx * Math.cos(t);
            const y = ry * Math.sin(t);
            pts.push([c[0] + x * cs - y * sn, c[1] + x * sn + y * cs]);
          }
          out.push({ pts, construction: false });
        }
        break;
      }
      case 'slot': {
        const c1 = this.staged[0];
        if (!c1) break;
        const c2 = this.staged.length >= 2 ? this.staged[1] : cur;
        if (!c2) break;
        const L = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
        if (L < 1e-9) break;
        const ux = (c2[0] - c1[0]) / L;
        const uy = (c2[1] - c1[1]) / L;
        const nx = -uy;
        const ny = ux;
        const r = this.staged.length >= 2 && cur ? Math.abs((cur[0] - c1[0]) * nx + (cur[1] - c1[1]) * ny) : L * 0.35;
        if (r < 1e-9) break;
        const pts: [number, number][] = [];
        const p1: [number, number] = [c1[0] + nx * r, c1[1] + ny * r];
        const p2: [number, number] = [c2[0] + nx * r, c2[1] + ny * r];
        const p3: [number, number] = [c2[0] - nx * r, c2[1] - ny * r];
        const p4: [number, number] = [c1[0] - nx * r, c1[1] - ny * r];
        pts.push(p1, p2);
        const a2 = Math.atan2(p2[1] - c2[1], p2[0] - c2[0]);
        // 右端帽：从 p2 起**角度递减**（顺时针），经 +u·r 向外鼓出到 p3
        for (let i = 1; i <= 24; i++) {
          const t = a2 - (Math.PI * i) / 24;
          pts.push([c2[0] + r * Math.cos(t), c2[1] + r * Math.sin(t)]);
        }
        pts.push(p4);
        const a1 = Math.atan2(p4[1] - c1[1], p4[0] - c1[0]);
        // 左端帽：从 p4 起角度递减，经 −u·r 向外鼓出到 p1
        for (let i = 1; i <= 24; i++) {
          const t = a1 - (Math.PI * i) / 24;
          pts.push([c1[0] + r * Math.cos(t), c1[1] + r * Math.sin(t)]);
        }
        pts.push(p1);
        out.push({ pts, construction: false });
        break;
      }
      case 'point': {
        if (cur) {
          const s = this.tolWorld(cur) * 1.5;
          out.push({ pts: [[cur[0] - s, cur[1]], [cur[0] + s, cur[1]]], construction: false });
          out.push({ pts: [[cur[0], cur[1] - s], [cur[0], cur[1] + s]], construction: false });
        }
        break;
      }
      case 'parabola': {
        const vertex = this.staged[0];
        if (!vertex || !cur) break;
        const focus = this.staged.length >= 2 ? this.staged[1] : cur;
        const dx = focus[0] - vertex[0];
        const dy = focus[1] - vertex[1];
        const focal = Math.hypot(dx, dy);
        if (focal < 1e-6) break;
        const rot = Math.atan2(dy, dx);
        let t1: number;
        if (this.staged.length >= 2) {
          const [, ly] = toLocalRot(cur, vertex, rot);
          t1 = Math.max(Math.abs(ly), 2 * Math.sqrt(focal));
        } else {
          t1 = 2 * Math.sqrt(focal) * 3;
        }
        const pts: [number, number][] = [];
        for (let i = 0; i <= 64; i++) {
          const t = -t1 + (2 * t1 * i) / 64;
          const [px, py] = parabolaPointAt({ focal, rot }, t);
          pts.push([vertex[0] + px, vertex[1] + py]);
        }
        out.push({ pts, construction: false });
        out.push({ pts: [vertex, focus], construction: true });
        break;
      }
      case 'hyperbola': {
        const center = this.staged[0];
        if (!center || !cur) break;
        const vertex = this.staged.length >= 2 ? this.staged[1] : cur;
        const dx = vertex[0] - center[0];
        const dy = vertex[1] - center[1];
        const a = Math.hypot(dx, dy);
        if (a < 1e-6) break;
        const rot = Math.atan2(dy, dx);
        let b: number;
        if (this.staged.length >= 2) {
          const [, ly] = toLocalRot(cur, center, rot);
          b = Math.max(Math.abs(ly), 1e-6);
        } else {
          b = a * 0.6;
        }
        const T = 1.6;
        const pts: [number, number][] = [];
        for (let i = 0; i <= 64; i++) {
          const t = -T + (2 * T * i) / 64;
          const [px, py] = hyperbolaPointAt({ a, b, rot }, t);
          pts.push([center[0] + px, center[1] + py]);
        }
        out.push({ pts, construction: false });
        out.push({ pts: [center, vertex], construction: true });
        break;
      }
      case 'bspline': {
        const list: [number, number][] = [...this.staged];
        if (cur) list.push(cur);
        if (list.length < 2) break;
        const data = bsplineInterpolate(list, 3, false);
        if (data) out.push({ pts: bsplinePolyline(data, 96), construction: false });
        break;
      }
      default:
        break;
    }
    return out;
  }

  cursorLocal: [number, number] | null = null;

  handleMove(x: number, y: number): void {
    if (!this.isActive) return;
    const ray = this.app.viewport.rayFromScreen(x, y).ray;

    if (this.dragging) {
      const local = this.overlay!.screenToLocal(ray);
      if (local) {
        const sk = this.sketch!;
        const p = sk.points[this.dragging.pointId];
        if (p) {
          const before = { ...p };
          p.x = local[0] + this.dragging.offset[0];
          p.y = local[1] + this.dragging.offset[1];
          const wasFixed = p.fixed;
          p.fixed = true;
          const st = solveSketch(sk);
          p.fixed = wasFixed;
          if (st.state === 'failed') {
            p.x = before.x;
            p.y = before.y;
            solveSketch(sk);
          }
          this.refresh();
        }
      }
      return;
    }

    const local = this.overlay!.screenToLocal(ray);
    this.cursorLocal = local;
    if (local && this.tool === 'select') {
      const tol = this.tolWorld(local);
      const hp = this.overlay!.hitPoint(local, tol * 0.9);
      const he = hp ? null : this.overlay!.hitEntity(local, tol * 0.9);
      this.overlay!.setHover(he?.entityId ?? null, hp?.pointId ?? null);
      this.hoverPoint = hp?.pointId ?? null;
      this.hoverEntity = he?.entityId ?? null;
      this.app.viewport.renderer.domElement.style.cursor =
        hp || he ? 'pointer' : 'default';
    } else if (this.tool !== 'select') {
      this.refresh();
      this.app.viewport.renderer.domElement.style.cursor = 'crosshair';
    }
  }

  handleDown(x: number, y: number): boolean {
    if (!this.isActive || this.tool !== 'select') return false;
    const ray = this.app.viewport.rayFromScreen(x, y).ray;
    const local = this.overlay!.screenToLocal(ray);
    if (!local) return false;
    const tol = this.tolWorld(local);
    const hp = this.overlay!.hitPoint(local, tol * 0.9);
    if (hp) {
      const p = this.sketch!.points[hp.pointId];
      this.dragging = { pointId: hp.pointId, offset: [p.x - local[0], p.y - local[1]] };
      this.app.viewport.controls.enabled = false;
      return true;
    }
    return false;
  }

  handleUp(): void {
    if (this.dragging) {
      this.dragging = null;
      this.app.viewport.controls.enabled = true;
      void this.app.rebuild();
      this.solve();
      this.app.emit('props', 'change');
    }
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.isActive) return false;
    if (e.key === 'Escape') {
      if (this.staged.length) {
        this.staged = [];
        this.stagedSnaps = [];
        this.refresh();
        return true;
      }
      if (this.tool !== 'select') {
        this.setTool('select');
        return true;
      }
      this.app.exitSketch(false);
      return true;
    }
    if (e.key === 'Enter') {
      if (this.tool === 'bspline' && this.staged.length) {
        this.finishBSpline();
        return true;
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    // 单字母草图工具键（L 直线 / C 圆 / A 圆弧 / T 剪裁 …）由 ../app/hotkeys 统一分发，
    // 以保证与 SolidWorks 的全局键位表一致（S 必须是快捷方式栏，不能是「选择」）。
    return false;
  }

  // ------------------------------------------------------------
  // 求解与编辑
  // ------------------------------------------------------------
  solve(): void {
    const sk = this.sketch;
    if (!sk) return;
    const st = solveSketch(sk);
    this.app.setStatus(
      st.message,
      st.state === 'failed' ? 'err' : st.state === 'well' ? 'ok' : 'busy',
      `自由度 ${st.dof} · 残差 ${st.residual.toExponential(1)} · ${st.iterations} 次迭代`
    );
    this.refresh();
  }

  addRelation(type: SkConstraint['type'], value?: number): void {
    const sk = this.sketch;
    if (!sk) return;
    const ents = [...this.selEntities];
    const pts = [...this.selPoints];
    const need2: SkConstraint['type'][] = ['parallel', 'perpendicular', 'equal', 'concentric', 'tangent', 'angle', 'distance'];
    const c: SkConstraint = { id: newId('c'), type };
    if (type === 'coincident') {
      if (pts.length !== 2) {
        notify.info('请选中两个点');
        return;
      }
      c.p1 = pts[0];
      c.p2 = pts[1];
    } else if (type === 'horizontal' || type === 'vertical') {
      if (ents.length !== 1) {
        notify.info('请选中一条直线');
        return;
      }
      c.e1 = ents[0];
    } else if (type === 'midpoint' || type === 'pointOnLine') {
      if (ents.length !== 1 || pts.length !== 1) {
        notify.info('请选中一条直线和一个点');
        return;
      }
      c.e1 = ents[0];
      c.p1 = pts[0];
    } else if (need2.includes(type)) {
      if (ents.length !== 2) {
        notify.info('请选中两个图元');
        return;
      }
      c.e1 = ents[0];
      c.e2 = ents[1];
      if (type === 'angle') c.value = value ?? Math.PI / 2;
      if (type === 'distance') c.value = value ?? 10;
    } else {
      notify.info('该约束暂不支持当前选择');
      return;
    }
    sk.constraints.push(c);
    this.solve();
    this.app.emit('props');
  }

  smartDimension(): void {
    const sk = this.sketch;
    if (!sk) return;
    const ents = [...this.selEntities];
    const pts = [...this.selPoints];

    if (ents.length === 1) {
      const e = sk.entities.find((x) => x.id === ents[0]);
      if (!e) return;
      if (e.kind === 'line') {
        const a = sk.points[e.a];
        const b = sk.points[e.b];
        const cur = Math.hypot(b.x - a.x, b.y - a.y);
        promptNumber('智能尺寸', '长度', round(cur), (v) => {
          sk.constraints.push({ id: newId('c'), type: 'length', e1: e.id, value: v, driving: true });
          this.solve();
          this.app.emit('props');
        });
        return;
      }
      if (e.kind === 'circle') {
        promptNumber('智能尺寸', '直径', round(e.r * 2), (v) => {
          sk.constraints.push({ id: newId('c'), type: 'diameter', e1: e.id, value: v, driving: true });
          this.solve();
          this.app.emit('props');
        });
        return;
      }
      if (e.kind === 'arc') {
        const a = sk.points[e.a];
        const c = sk.points[e.c];
        const r = Math.hypot(a.x - c.x, a.y - c.y);
        promptNumber('智能尺寸', '半径', round(r), (v) => {
          sk.constraints.push({ id: newId('c'), type: 'radius', e1: e.id, value: v, driving: true });
          this.solve();
          this.app.emit('props');
        });
        return;
      }
      if (e.kind === 'ellipse') {
        // 椭圆有两个半轴，依次标注（对应 radius / minorRadius 两类约束）
        promptNumber('椭圆尺寸', '长半轴', round(e.rx), (v) => {
          if (v > 0) sk.constraints.push({ id: newId('c'), type: 'radius', e1: e.id, value: v, driving: true });
          this.solve();
          this.app.emit('props');
          promptNumber('椭圆尺寸', '短半轴', round(e.ry), (v2) => {
            if (v2 > 0) sk.constraints.push({ id: newId('c'), type: 'minorRadius', e1: e.id, value: v2, driving: true });
            this.solve();
            this.app.emit('props');
          });
        });
        return;
      }
    }
    if (pts.length === 2) {
      const a = sk.points[pts[0]];
      const b = sk.points[pts[1]];
      const cur = Math.hypot(b.x - a.x, b.y - a.y);
      promptNumber('智能尺寸', '两点距离', round(cur), (v) => {
        sk.constraints.push({ id: newId('c'), type: 'distance', p1: pts[0], p2: pts[1], value: v, driving: true });
        this.solve();
        this.app.emit('props');
      });
      return;
    }
    notify.info('请选中一条直线/圆/圆弧，或两个点');
  }

  toggleConstruction(): void {
    const sk = this.sketch;
    if (!sk) return;
    if (!this.selEntities.size) {
      notify.info('请先选中图元');
      return;
    }
    for (const id of this.selEntities) {
      const e = sk.entities.find((x) => x.id === id);
      if (e) e.construction = !e.construction;
    }
    this.solve();
    this.app.emit('props');
  }

  deleteSelection(): void {
    const sk = this.sketch;
    if (!sk) return;
    if (!this.selEntities.size && !this.selPoints.size) {
      notify.info('请先选中要删除的对象');
      return;
    }
    const entIds = new Set(this.selEntities);
    const ptIds = new Set(this.selPoints);

    // 删除实体
    sk.entities = sk.entities.filter((e) => !entIds.has(e.id));
    // 删除只被这些实体使用的点
    const used = new Set<string>();
    for (const e of sk.entities) {
      if (e.kind === 'line') {
        used.add(e.a);
        used.add(e.b);
      } else if (e.kind === 'circle' || e.kind === 'ellipse' || e.kind === 'parabola' || e.kind === 'hyperbola') used.add(e.c);
      else if (e.kind === 'point') used.add(e.p);
      else if (e.kind === 'bspline') continue; // 通过点直接存坐标，不引用 SkPoint
      else {
        used.add(e.a);
        used.add(e.b);
        used.add(e.c);
      }
    }
    for (const id of Object.keys(sk.points)) {
      if (ptIds.has(id) || !used.has(id)) delete sk.points[id];
    }
    // 清理失效约束
    sk.constraints = sk.constraints.filter((c) => {
      if (entIds.has(c.e1 ?? '') || entIds.has(c.e2 ?? '')) return false;
      if (ptIds.has(c.p1 ?? '') || ptIds.has(c.p2 ?? '')) return false;
      if (c.e1 && !sk.entities.some((e) => e.id === c.e1)) return false;
      if (c.e2 && !sk.entities.some((e) => e.id === c.e2)) return false;
      if (c.p1 && !sk.points[c.p1]) return false;
      if (c.p2 && !sk.points[c.p2]) return false;
      return true;
    });

    this.selEntities.clear();
    this.selPoints.clear();
    this.solve();
    this.app.emit('props');
  }

  /** 选中全部 */
  selectAll(): void {
    const sk = this.sketch;
    if (!sk) return;
    this.selEntities = new Set(sk.entities.map((e) => e.id));
    this.selPoints = new Set(Object.keys(sk.points));
    this.refresh();
    this.app.emit('props');
  }

  /** 添加一个尺寸标注（用于属性面板展示） */
  constraintList(): SkConstraint[] {
    return this.sketch?.constraints ?? [];
  }

  removeConstraint(id: string): void {
    const sk = this.sketch;
    if (!sk) return;
    sk.constraints = sk.constraints.filter((c) => c.id !== id);
    this.solve();
    this.app.emit('props');
  }

  setPolygonSides(n: number): void {
    this.polygonSides = Math.max(3, Math.min(64, n));
    this.overlay?.setHint(this.hintText());
    this.app.emit('props');
  }

  get polygonSideCount(): number {
    return this.polygonSides;
  }

  snapHintText(): string | null {
    return this.snapHint;
  }

  get entities(): SkEntity[] {
    return this.sketch?.entities ?? [];
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 把点 p 相对 origin 转到「绕 origin 旋转 rot 后的局部坐标」 */
function toLocalRot(p: [number, number], origin: [number, number], rot: number): [number, number] {
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  return [dx * cs + dy * sn, -dx * sn + dy * cs];
}
