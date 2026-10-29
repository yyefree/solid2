/**
 * 拾取交互服务（从 `App` 抽出的第 5 个领域服务）。
 *
 * ## 职责
 *
 * 图形区的全部「点下去之后发生什么」：
 *   - 指针事件绑定（pointerdown/move/up/leave/dblclick → 拖拽与点击分流）；
 *   - 点击分发（onCanvasClick 钩子 → 装配体拾取 → 模型态顶点/实体/边/面/草图显示层）；
 *   - 屏幕空间几何拾取（顶点就近原则、棱边折线距离、射线穿面、配合参考）；
 *   - 装配体配合拾取（棱边/圆柱轴/平面三级优先）与 3D 标记同步；
 *   - 几何选择的对外入口（selectFace/Edge/Vertex/Body）。
 *
 * ## 边界（与其它服务同构）
 *
 * 纯逻辑 + 宿主回调：本类**不 import DOM / 视口 / 草图控制器 / 内核**。
 * 视口射线、画布矩形、草图编辑态回调、选择落地（SelectionStore 互斥不变量 +
 * 高亮/显示层/事件副作用）全部经构造器闭包注入 → 可在 Node 下单测
 * （见 tools/pick-service-test.ts）。
 *
 * ⚠️ 装配拾取状态（`picks`）由本服务持有，App 的 `assemblyPicks` getter/setter
 * 委托到它。**写入必须经 `assignPicks` / `clearAssemblyPicks`**——`setMode` /
 * `selectAll` / `toggleTabVisibility` 的「置空/置一」路径不带 emit，
 * 而 `clearAssemblyPicks`（对话框调）要广播 change/props，两者语义不同。
 */

import * as THREE from 'three';
import type { AppEvent, AppMode, StatusInfo } from './app';
import type { ShapeView } from '../view/shapeview';
import type { SelectionFilter, GeomKind } from './selection-store';
import type { Assembly, MateRef, Component } from './assembly';
import type { SketchFeature } from '../doc/types';

/** 拾取交互需要的宿主能力（由 App 提供） */
export interface PickHost {
  // ---- 视口 ----
  /** 当前模型的三维视图（无模型时为 null） */
  shapeView(): ShapeView | null;
  /** 屏幕（客户区）坐标 → 世界射线（多视口布局换算在视口内部） */
  rayFromScreen(x: number, y: number): THREE.Raycaster;
  /** 世界坐标 → 画布像素 */
  worldToScreen(p: [number, number, number]): { x: number; y: number };
  /** 画布矩形 + 客户区高度（px 容差折算需要） */
  canvasRect(): { left: number; top: number; width: number; height: number; clientHeight: number };
  /** 当前相机（透视折算用） */
  camera(): THREE.Camera;
  /** 视口根节点（装配拾取标记挂载点） */
  sceneRoot(): THREE.Object3D;
  /** 请求重绘 */
  invalidate(): void;

  // ---- 装配 / 模式 / 过滤器 ----
  /** 当前装配体（无装配时为 null） */
  assembly(): Assembly | null;
  /** 当前模式 */
  mode(): AppMode;
  /** 当前选择过滤器 */
  selectionFilter(): SelectionFilter;
  /** 面 → 所属实体下标（无归属信息时 -1） */
  faceBodyIndex(faceIndex: number): number;
  /** 配合参考的可读描述（状态栏/对话框共用；宿主持有，本服务不 import 装配模块） */
  mateRefLabel(ref: MateRef): string;

  // ---- 选择应用（互斥不变量 + 副作用留在宿主）----
  /** 落地几何选择（过滤器拒绝时宿主自行 no-op；高亮/草图显示层同步也由宿主负责） */
  applyGeomSelection(kind: GeomKind, index: number, additive: boolean): void;
  /** 清空全部选中（几何 + 特征） */
  clearSelection(): void;
  /** 选中特征（模型态点选显示中的草图用） */
  selectFeature(id: string | null): void;

  // ---- 状态 / 事件 ----
  setStatus(text: string, kind: StatusInfo['kind'], detail?: string): void;
  emit(...evts: AppEvent[]): void;

  // ---- 草图显示层拾取 ----
  /** 显示态草图的平面（无显示草图为 null） */
  sketchDisplayPlane(): { origin: [number, number, number] } | null;
  /** 显示态草图拾取（世界空间容差；命中草图特征） */
  sketchPickDisplay(ray: THREE.Ray, tolWorld: number): SketchFeature | null;

  // ---- 草图编辑态回调（bindPointer 用）----
  sketchHandleDown(x: number, y: number): boolean;
  sketchHandleMove(x: number, y: number): void;
  sketchHandleUp(): void;
  sketchFinishBSpline(): void;
  /** 是否处于草图编辑模式（dblclick 结束 B 样条） */
  isSketchMode(): boolean;
  /** 外部画布点击钩子（草图态消费点击；返回 true 表示已处理、不再往下分发） */
  onCanvasClickHook(x: number, y: number, additive: boolean): boolean;
}

/** 点到线段的最短距离（屏幕空间；线段退化为点时取点到点距离） */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export class PickService {
  /** 装配体拾取：已选中的配合参考（最多 2 个，用于创建配合） */
  private _picks: MateRef[] = [];
  /** 拾取参考的 3D 标记（球 + 轴向线段），加在视口根节点 */
  private pickGroup: THREE.Group | null = null;

  /** 指针按下位置（区分「点击」与「拖拽旋转」） */
  private pointerDownAt: { x: number; y: number; button: number } | null = null;
  /** 草图拖拽进行中（pointerup 交给草图控制器收尾，不走点击分发） */
  private sketchDragging = false;

  constructor(private readonly host: PickHost) {}

  // ============================================================
  // 装配拾取状态（App.assemblyPicks 委托到本服务）
  // ============================================================
  get picks(): MateRef[] {
    return this._picks;
  }

  /**
   * 整体替换拾取集（`setMode` 置空 / `selectAll` 置一 / `toggleTabVisibility` 消费后置空）。
   * ⚠️ **不带 emit**——与旧 App 字段直写行为一致；要广播请用 `clearAssemblyPicks`。
   */
  assignPicks(refs: MateRef[]): void {
    this._picks = refs;
  }

  /** 3D 标记显隐（模式切换；无标记组时 no-op） */
  setPickGroupVisible(visible: boolean): void {
    if (this.pickGroup) this.pickGroup.visible = visible;
  }

  // ============================================================
  // 几何选择入口（4 个 selectXxx 共用 host.applyGeomSelection）
  // ============================================================
  selectFace(index: number, additive = false): void {
    this.host.applyGeomSelection('face', index, additive);
  }

  selectEdge(index: number, additive = false): void {
    this.host.applyGeomSelection('edge', index, additive);
  }

  /** 选中一个网格顶点（选择过滤器为「顶点」时专用） */
  selectVertex(index: number, additive = false): void {
    this.host.applyGeomSelection('vertex', index, additive);
  }

  /** 选中一个实体（选择过滤器为「实体」时专用；经命中的面反查 bodyIndex） */
  selectBody(index: number, additive = false): void {
    this.host.applyGeomSelection('body', index, additive);
  }

  // ============================================================
  // 指针交互
  // ============================================================
  /**
   * 绑定画布指针事件。
   *
   * 点击 vs 拖拽的分流：pointerdown 记位；pointerup 时位移 ≤ 4px 且左键
   * 才算点击（否则视为视图旋转/平移，与 SolidWorks 一致）。草图拖拽中
   * （handleDown 返回 true）pointerup 交给草图收尾、不走点击分发。
   */
  bindPointer(dom: HTMLElement): void {
    dom.addEventListener('pointerdown', (e) => {
      this.pointerDownAt = { x: e.clientX, y: e.clientY, button: e.button };
      if (e.button === 0) this.sketchDragging = this.host.sketchHandleDown(e.clientX, e.clientY);
    });
    dom.addEventListener('pointermove', (e) => {
      this.host.sketchHandleMove(e.clientX, e.clientY);
    });
    dom.addEventListener('pointerup', (e) => {
      if (this.sketchDragging) {
        this.sketchDragging = false;
        this.host.sketchHandleUp();
        this.pointerDownAt = null;
        return;
      }
      if (!this.pointerDownAt) return;
      const moved = Math.hypot(e.clientX - this.pointerDownAt.x, e.clientY - this.pointerDownAt.y);
      const btn = this.pointerDownAt.button;
      this.pointerDownAt = null;
      if (moved > 4) return;
      if (btn !== 0) return;
      this.handleClick(e.clientX, e.clientY, e.shiftKey || e.ctrlKey);
    });
    dom.addEventListener('pointerleave', () => {
      this.host.sketchHandleMove(-1e6, -1e6);
    });
    // 双击结束「连续点击」类工具（B 样条）
    dom.addEventListener('dblclick', () => {
      if (this.host.isSketchMode()) this.host.sketchFinishBSpline();
    });
  }

  /**
   * 点击分发（模型态/装配态的主路径）：
   *   1. 外部钩子（草图态 handleClick）先消费；
   *   2. 装配态 → 配合拾取；
   *   3. 模型态：过滤器为「顶点」只拾顶点、「实体」经面反查实体，
   *      否则棱边（屏幕空间近处）优先 → 射线穿面 → 显示中的草图兜底。
   */
  handleClick(x: number, y: number, additive: boolean): void {
    if (this.host.onCanvasClickHook(x, y, additive)) return;
    if (this.host.mode() === 'assembly') {
      this.pickAssembly(x, y, additive);
      return;
    }
    if (this.host.mode() !== 'model') return;

    const rc = this.host.rayFromScreen(x, y);
    const sv = this.host.shapeView();
    if (!sv) {
      this.selectSketchAt(rc);
      return;
    }

    // 过滤为「顶点」时只拾取顶点（就近原则，8px 内）
    if (this.host.selectionFilter() === 'vertex') {
      const vi = this.pickVertex(x, y);
      if (vi !== null) {
        this.selectVertex(vi, additive);
        this.host.setStatus('已选择顶点', 'ok');
      } else {
        this.host.clearSelection();
      }
      return;
    }

    // 过滤为「实体」时：命中的面反查 bodyIndex，选中整个实体（装配体语义）
    if (this.host.selectionFilter() === 'body') {
      const hits = rc.intersectObject(sv.mesh, false);
      let picked = -1;
      if (hits.length && hits[0].faceIndex !== undefined) {
        const fi = sv.faceIndexFromTriangle(hits[0].faceIndex);
        if (fi >= 0) picked = this.host.faceBodyIndex(fi);
      }
      if (picked >= 0) {
        this.selectBody(picked, additive);
        this.host.setStatus('已选择实体', 'ok', `实体 ${picked + 1}`);
      } else {
        this.host.clearSelection();
      }
      return;
    }

    const edgeHit = this.pickEdge(rc, x, y);
    if (edgeHit !== null) {
      this.selectEdge(edgeHit, additive);
      const meta = sv.edgeMetas[edgeHit];
      this.host.setStatus('已选择边', 'ok', meta ? `长度 ${meta.length.toFixed(2)} mm` : undefined);
      return;
    }

    const hits = rc.intersectObject(sv.mesh, false);
    if (hits.length && hits[0].faceIndex !== undefined) {
      const fi = sv.faceIndexFromTriangle(hits[0].faceIndex);
      if (fi >= 0) {
        this.selectFace(fi, additive);
        const meta = sv.faceMetas[fi];
        this.host.setStatus('已选择面', 'ok', meta ? `面积 ${meta.area.toFixed(2)} mm²` : undefined);
        return;
      }
    }
    // SolidWorks: 模型态点击显示中的草图可以选中它（实体优先，草图兜底）
    this.selectSketchAt(rc);
  }

  /** 模型态下点选显示中的草图：选中该草图特征，后续特征默认绑定它 */
  private selectSketchAt(rc: THREE.Raycaster): void {
    const plane = this.host.sketchDisplayPlane();
    const hit = plane ? this.host.sketchPickDisplay(rc.ray, this.sketchPickTol(plane.origin)) : null;
    if (hit) {
      this.host.selectFeature(hit.id);
      this.host.setStatus('已选择草图', 'ok', hit.name);
      return;
    }
    this.host.clearSelection();
  }

  /** 屏幕 6px 折算到草图平面处的世界容差 */
  private sketchPickTol(origin: [number, number, number]): number {
    const cam = this.host.camera() as THREE.PerspectiveCamera;
    const dist = cam.position.distanceTo(new THREE.Vector3(...origin));
    const h = this.host.canvasRect().clientHeight || 800;
    const worldPerPx = (2 * dist * Math.tan(((cam.fov * Math.PI) / 180) / 2)) / h;
    return Math.max(worldPerPx * 6, 0.4);
  }

  /**
   * 顶点拾取：屏幕空间就近原则。
   * 把网格每个顶点投影到 NDC 再换算成像素，取与点击位置距离最近且在 8px 内的顶点。
   * 顶点数一般数千，全遍历在点击这种低频事件上可接受。
   */
  pickVertex(x: number, y: number): number | null {
    const sv = this.host.shapeView();
    if (!sv) return null;
    const pos = sv.mesh.geometry.getAttribute('position');
    if (!pos) return null;
    const rect = this.host.canvasRect();
    const cam = this.host.camera();
    cam.updateMatrixWorld();
    const v = new THREE.Vector3();
    let best = -1;
    let bestD = 8 * 8;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i).project(cam);
      if (v.z < -1 || v.z > 1) continue;
      // ⚠️ 入参 x/y 是客户区坐标，必须换成画布相对坐标再比——
      // 漏减 rect.left/top 时画布只要有偏移（左侧面板即可达 200+px），
      // 8px 容差内的顶点永远命不中（过滤器=顶点时整个拾取失效）。
      const sx = rect.left + ((v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v.y) / 2) * rect.height;
      const dx = sx - x;
      const dy = sy - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }

  // ============================================================
  // 装配体可视化拾取
  // ============================================================
  /**
   * 装配模式拾取配合参考。优先级：
   *   1. 屏幕空间近处有棱边 → 棱边参考（直线=方向轴，圆=轴线/中心）；
   *   2. 命中面为圆柱/圆锥 → 轴线参考（配合时作同心）；
   *   3. 命中面为平面 → 平面参考（质心 + 法向）。
   * 局部几何存于组件自身坐标系，求解时用组件世界矩阵变换出去即可。
   */
  private pickAssembly(x: number, y: number, additive: boolean): void {
    const a = this.host.assembly();
    if (!a) return;
    const rc = this.host.rayFromScreen(x, y);

    // 命中最近的组件
    let best: { compId: string; faceIndex: number; comp: Component } | null = null;
    let bestDist = Infinity;
    for (const c of a.components) {
      if (!c.visible || !c.view) continue;
      const hits = rc.intersectObject(c.view.mesh, false);
      if (hits.length && hits[0].faceIndex !== undefined && hits[0].distance < bestDist) {
        const fi = c.view.faceIndexFromTriangle(hits[0].faceIndex);
        if (fi >= 0) {
          best = { compId: c.id, faceIndex: fi, comp: c };
          bestDist = hits[0].distance;
        }
      }
    }
    if (!best || !best.comp.view) {
      if (!additive) this.clearAssemblyPicks();
      return;
    }

    const view = best.comp.view;
    let ref: MateRef;
    let label: string;

    // 1) 棱边优先（屏幕空间阈值内）
    const edgeIdx = this.pickEdgeIn(view, x, y, 7);
    if (edgeIdx !== null) {
      const em = view.edgeMetas[edgeIdx];
      if (em) {
        if (em.curveType === 'circle' && em.axis) {
          ref = {
            comp: best.comp.id,
            localPoint: [...em.axis.point],
            localDir: [...em.axis.dir],
            kind: 'cylindrical',
            isAxis: true,
            radius: em.radius,
          };
          label = '圆边（轴）';
        } else {
          ref = {
            comp: best.comp.id,
            localPoint: [...em.mid],
            localDir: [...em.dir],
            kind: 'edge',
            isAxis: true,
          };
          label = '棱边';
        }
        this.pushAssemblyPick(a, ref, label, additive);
        return;
      }
    }

    // 2) 面
    const meta = view.faceMetas[best.faceIndex];
    if (!meta) return;
    if ((meta.surfaceType === 'cylinder' || meta.surfaceType === 'cone') && meta.axis) {
      ref = {
        comp: best.comp.id,
        localPoint: [...meta.axis.point],
        localDir: [...meta.axis.dir],
        kind: 'cylindrical',
        isAxis: true,
        radius: meta.radius,
      };
      label = meta.surfaceType === 'cylinder' ? '圆柱面（轴）' : '圆锥面（轴）';
    } else {
      ref = {
        comp: best.comp.id,
        localPoint: [...meta.centroid],
        localDir: [...meta.normal],
        kind: 'planar',
      };
      label = meta.surfaceType === 'plane' || meta.surfaceType === undefined ? '平面' : '曲面';
    }
    this.pushAssemblyPick(a, ref, label, additive);
  }

  private pushAssemblyPick(a: Assembly, ref: MateRef, label: string, additive: boolean): void {
    if (!additive || this._picks.length >= 2) this._picks = [];
    this._picks.push(ref);
    this.syncAssemblyPickMarkers();
    const names = this._picks
      .map((p) => `${a.getComponent(p.comp)?.name ?? '?'}·${this.host.mateRefLabel(p)}`)
      .join(' → ');
    this.host.setStatus('装配拾取', 'ok', `${label}（${this._picks.length}/2）：${names}`);
    this.host.emit('change', 'props');
    // 重绘由 `syncAssemblyPickMarkers()` 统一请求（它改了场景图），此处不再重复 invalidate
  }

  clearAssemblyPicks(): void {
    this._picks = [];
    this.syncAssemblyPickMarkers();
    this.host.emit('change', 'props');
  }

  /** 依据当前拾取重建 3D 标记：橙=第 1 个参考，蓝=第 2 个，球 + 轴向线段。
   *  `setMode` 的「置空拾取」路径也会显式调用它（与旧 App 行为一致）。 */
  syncAssemblyPickMarkers(): void {
    const a = this.host.assembly();
    if (!this.pickGroup) {
      this.pickGroup = new THREE.Group();
      this.pickGroup.userData.pickMarker = true;
      this.host.sceneRoot().add(this.pickGroup);
    }
    const g = this.pickGroup;
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { (o.geometry as THREE.BufferGeometry)?.dispose(); (o.material as THREE.Material)?.dispose(); } });
    }
    if (!a) return;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const colors = [0xff8c00, 0x2b8cff];
    this._picks.forEach((ref, i) => {
      const c = a.getComponent(ref.comp);
      if (!c) return;
      const m = a.displayMatrix(c);
      m.decompose(pos, quat, scl);
      const wp = new THREE.Vector3(...ref.localPoint).applyMatrix4(m);
      const wd = new THREE.Vector3(...ref.localDir).applyQuaternion(quat).normalize();
      const node = new THREE.Group();
      node.position.copy(wp);
      const color = colors[i % colors.length];
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(1.3, 12, 8),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
      );
      dot.renderOrder = 999;
      node.add(dot);
      const half = 9;
      const seg = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3().copy(wd).multiplyScalar(-half),
        new THREE.Vector3().copy(wd).multiplyScalar(half),
      ]);
      const line = new THREE.Line(seg, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
      line.renderOrder = 999;
      node.add(line);
      g.add(node);
    });
    g.visible = this.host.mode() === 'assembly';
    // ⚠️ 这里改了场景图（增删标记）→ 必须请求重绘。视口是按需重绘的（needsRender），
    // 相机不动时不会自己渲染：`clearAssemblyPicks()`（加完配合就调它）此前没有
    // invalidate，橙/蓝拾取标记会一直挂在屏幕上，直到用户碰一下相机才消失。
    this.host.invalidate();
  }

  /**
   * 屏幕空间边拾取（针对指定视图）。
   *
   * 性能：原先在内层逐段对两个端点各调一次 worldToScreen（且每段 `tmp.clone()`），
   * 500 棱 × 40 点 ≈ 4 万次投影 + 4 万对象分配 / 点击。改为**每条棱边的折线顶点
   * 预先一次性投影到屏幕空间**（缓存进 `screen`），随后只做线段距离计算——
   * 每个顶点投影恰好一次，不再 clone。
   *
   * 坐标约定（与原实现一致）：`worldToScreen` 返回**画布相对**坐标（基于 activeRect，
   * 不含页面偏移）；点击的客户区坐标 `sx/sy` 在入口处减 `rect.left/top` 换算成
   * 同一画布相对系后再比较，投影点本身不再二次减偏移。
   */
  private pickEdgeIn(sv: ShapeView, sx: number, sy: number, threshold = 8): number | null {
    const rect = this.host.canvasRect();
    const mx = sx - rect.left;
    const my = sy - rect.top;
    let best = -1;
    let bestD = threshold;

    const screen = sv.meshResult.edgePolylines.map((flat) => {
      const out: number[] = [];
      for (let k = 0; k < flat.length; k += 3) {
        const sp = this.host.worldToScreen([flat[k], flat[k + 1], flat[k + 2]]);
        out.push(sp.x, sp.y);
      }
      return out;
    });

    for (let i = 0; i < sv.edgeMetas.length; i++) {
      const pts = screen[i];
      if (!pts || pts.length < 4) continue;
      for (let k = 2; k < pts.length; k += 2) {
        const d = distToSegment(mx, my, pts[k - 2], pts[k - 1], pts[k], pts[k + 1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best >= 0 ? best : null;
  }

  /** 屏幕空间边拾取（模型模式） */
  private pickEdge(rc: THREE.Raycaster, sx: number, sy: number): number | null {
    const sv = this.host.shapeView();
    if (!sv) return null;
    void rc;
    return this.pickEdgeIn(sv, sx, sy);
  }

  /** 命中的面所属实体下标（无归属信息时 -1） */
  bodyIndexOfFace(fi: number): number {
    return this.host.faceBodyIndex(fi);
  }

  /**
   * 枚举某个屏幕位置上「射线穿过」的所有候选面（按距离从近到远、去重）。
   * 供右键菜单「选择其他…」使用（SolidWorks 同名功能）。
   */
  pickCandidateFaces(sx: number, sy: number): number[] {
    const sv = this.host.shapeView();
    if (!sv) return [];
    const rc = this.host.rayFromScreen(sx, sy);
    const hits = rc.intersectObject(sv.mesh, false);
    const out: number[] = [];
    for (const h of hits) {
      if (h.faceIndex === undefined) continue;
      const fi = sv.faceIndexFromTriangle(h.faceIndex);
      if (fi >= 0 && !out.includes(fi)) out.push(fi);
    }
    return out;
  }
}
