/**
 * 应用核心控制器。
 *
 * 持有：文档、视口、当前显示状态、选择集、模式、撤销栈。
 * 所有会用到 OpenCASCADE 的操作（重建、导出 STEP、导入 STEP、质量属性、测量、
 * 装配网格、干涉、工程图网格）都经 `../core/kernel` 转发给内核 Worker——
 * 主线程只持有可序列化的 MeshResult，绝不 import opencascade，因此永不卡顿、
 * 内核崩溃也被隔离在 Worker 里。
 */
import * as THREE from 'three';
import { CadDocument, newSketchFeature } from '../doc/model';
import type { Feature, FeatureId, PlaneRef, SketchFeature } from '../doc/types';
import { FEATURE_LABEL } from '../doc/types';
import {
  resolveExpressions,
  previewExpression,
  listNumericParams,
  getParamPath,
  type ExprIssue,
  type ParamDef,
  type ResolveResult,
} from '../doc/expr';
import { download, pickFile, readFileAsArrayBuffer, exportOBJ, exportSTLBinary } from '../core/meshexport';
import { kernel } from '../core/kernel';
import type { ModelResult, MeshResult, FaceMeta, EdgeMeta, BBox } from '../core/kernel-types';
import { viewsOfMesh } from '../core/kernel-types';
import { Viewport, type ViewDir } from '../view/viewport';
import { ShapeView, type DisplayStyle } from '../view/shapeview';
import { COLORS, previewMaterial } from '../view/materials';
import { notify, tableModal } from '../ui/toast';
import { DEFAULT_PLANE, RIGHT_PLANE, TOP_PLANE, type SketchPlane } from '../sketch/types';
import { SketchController, type SketchTool } from './sketchMode';
import { Assembly, mateRefLabel, type MateRef, type Component } from './assembly';
import { Drawing, generateStandardViews, type ViewKind } from './drawing';

export type AppMode = 'model' | 'sketch' | 'assembly' | 'drawing';

export interface Selection {
  /** 面索引（对应 model.faceMetas） */
  faces: number[];
  /** 边索引（对应 model.edgeMetas） */
  edges: number[];
  /** 顶点索引（对应网格顶点缓冲区下标；仅选择过滤器为「顶点」时使用） */
  vertices: number[];
}

export type AppEvent =
  | 'change'
  | 'selection'
  | 'mode'
  | 'status'
  | 'tree'
  | 'props'
  | 'drawing'
  | 'params'
  /** 视图状态变化（投影模式 / 布景 / 剖面 / 显示样式）—— 供参考三重轴与工具栏刷新 */
  | 'view'
  /** 命令激活状态变化 —— 供确认角刷新 */
  | 'command'
  /** 设计树中选中了某个特征（供属性管理器接管显示并切换左面板选项卡） */
  | 'feature';

export interface StatusInfo {
  text: string;
  kind: 'ok' | 'busy' | 'err';
  detail?: string;
}

export class App {
  readonly viewport: Viewport;
  doc = new CadDocument();
  shapeView: ShapeView | null = null;
  mode: AppMode = 'model';
  selection: Selection = { faces: [], edges: [], vertices: [] };
  /** 选择过滤器（SolidWorks 状态栏 / 快捷键 F5）—— 'all' 不过滤（默认，行为不变） */
  selectionFilter: 'all' | 'face' | 'edge' | 'vertex' = 'all';
  /** 零件外观色（十六进制，Heads-up「外观」下拉设置；默认 materials.ts 的 COLORS.body） */
  appearanceHex: number = COLORS.body;
  /** 当前光源预设名（Heads-up「光源」下拉） */
  lightPreset: string = '默认';
  /** 设计树中当前选中的特征 id（供属性管理器显示）—— SolidWorks「属性管理器」接管选中的特征 */
  selectedFeatureId: string | null = null;

  // ---- 草图 ----
  activeSketchFeature: SketchFeature | null = null;
  editingSketch: SketchFeature | null = null;
  sketchTool: string | null = null;
  pendingPoints: [number, number][] = [];
  readonly sketch: SketchController;

  // ---- 显示 ----
  displayStyle: DisplayStyle = 'shadedEdges';
  showPlanes = true;
  showGrid = true;
  showOrigin = true;
  private originGroup: THREE.Group | null = null;

  // ---- 装配 / 工程图 ----
  assembly: Assembly | null = null;
  drawing: Drawing | null = null;
  drawingHost: HTMLElement | null = null;
  drawingScale = 0;
  /** 尺寸标注模式：点击工程图边线即添加标注 */
  dimMode = false;
  /** 上一次标注的边（`viewId:runIdx`），用于 Shift+点击标注两条边间距 */
  private lastDimRun: string | null = null;

  /** 装配体可视化拾取：已选中的配合参考（最多 2 个，用于创建配合） */
  assemblyPicks: MateRef[] = [];
  /** 拾取参考的 3D 标记（球 + 轴向线段），加在视口根节点 */
  private assemblyPickGroup: THREE.Group | null = null;

  // ---- 撤销 ----
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private maxUndo = 60;
  private suppressUndo = false;

  status: StatusInfo = { text: '就绪', kind: 'ok' };

  // ---- 参数化（表达式，参考 FreeCAD Expressions） ----
  /** 最近一次表达式解析结果（含参数值、问题列表） */
  lastResolve: ResolveResult | null = null;
  /** 参数名 → 数值 */
  paramValues: Record<string, number> = {};
  /** 表达式问题列表 */
  expressionIssues: ExprIssue[] = [];

  // ---- 内核（Web Worker，主线程只持有可序列化结果） ----
  /** 参数化模型的可序列化结果（来自 Worker） */
  model: ModelResult | null = null;
  /** 导入 STEP 的可序列化结果（来自 Worker） */
  importedModel: ModelResult | null = null;
  /** 几何内核是否就绪 */
  kernelReady = false;

  private listeners = new Map<AppEvent, Set<() => void>>();

  private previewObject: THREE.Object3D | null = null;
  private highlightGroup: THREE.Group;

  constructor(container: HTMLElement) {
    this.viewport = new Viewport(container);
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.name = 'highlight';
    this.viewport.scene.add(this.highlightGroup);
    this.viewport.setPlanesVisible(this.showPlanes);
    this.viewport.setGridVisible(this.showGrid);

    this.originGroup = buildOriginMarker();
    this.originGroup.visible = this.showOrigin;
    this.viewport.helpers.add(this.originGroup);

    this.sketch = new SketchController(this);
    this.onCanvasClick = (x, y, additive) => this.sketch.handleClick(x, y, additive);

    this.viewport.start();
    this.bindPointer();
    // 键盘热键由 ../app/hotkeys 统一注册（SolidWorks 键位表）
  }

  /** 当前用于显示的可序列化模型（参数化优先，其次导入） */
  currentModel(): ModelResult | null {
    return this.model ?? this.importedModel;
  }

  get hasModel(): boolean {
    return !!this.currentModel();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ============================================================
  // 事件
  // ============================================================
  on(evt: AppEvent, cb: () => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(cb);
    return () => this.listeners.get(evt)!.delete(cb);
  }

  emit(...evts: AppEvent[]): void {
    for (const e of evts) for (const cb of this.listeners.get(e) ?? []) cb();
  }

  /** 在设计树中选中一个特征（SolidWorks：单击特征即在其「属性管理器」中显示参数） */
  selectFeature(id: string | null): void {
    this.selectedFeatureId = id;
    this.emit('feature', 'props');
  }

  /** 设置选择过滤器（SolidWorks 状态栏 Filter） */
  setSelectionFilter(f: 'all' | 'face' | 'edge' | 'vertex'): void {
    this.selectionFilter = f;
    this.emit('selection', 'props');
  }

  /** 设置零件外观色（Heads-up「外观」）；已显示的形状立即换色 */
  setAppearance(hex: number): void {
    this.appearanceHex = hex;
    this.shapeView?.setBodyColor(hex);
    this.emit('view');
  }

  /** 设置视口光源预设（Heads-up「光源」） */
  setLightPreset(name: string): void {
    this.lightPreset = name;
    this.viewport.setLightPreset(name);
    this.emit('view');
  }

  /** 第一个有错误的特征 id（供状态栏「What's Wrong」定位），无则 null */
  firstErrorFeatureId(): string | null {
    return this.doc.features.find((f) => f.error)?.id ?? null;
  }

  setStatus(text: string, kind: StatusInfo['kind'] = 'ok', detail?: string): void {
    this.status = { text, kind, detail };
    this.emit('status');
  }

  /** 等待几何内核就绪（触发懒加载，重复调用返回同一 Promise） */
  requireKernel(): Promise<void> {
    return kernel.loadKernel();
  }

  /** 简短的模型统计（供状态栏/信息浮层使用） */
  modelSummary(): { faces: number; edges: number; solids: number } {
    const s = this.currentModel()?.stats;
    return s ? { faces: s.faces, edges: s.edges, solids: s.solids } : { faces: 0, edges: 0, solids: 0 };
  }

  // ============================================================
  // 文档与视图
  // ============================================================
  pushUndo(): void {
    if (this.suppressUndo) return;
    this.undoStack.push(JSON.stringify(this.doc.toJSON()));
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      notify.info('没有可撤销的操作');
      return;
    }
    this.redoStack.push(JSON.stringify(this.doc.toJSON()));
    this.suppressUndo = true;
    this.doc = CadDocument.fromJSON(JSON.parse(prev));
    this.rebuild();
    this.suppressUndo = false;
    notify.info('已撤销');
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) {
      notify.info('没有可重做的操作');
      return;
    }
    this.undoStack.push(JSON.stringify(this.doc.toJSON()));
    this.suppressUndo = true;
    this.doc = CadDocument.fromJSON(JSON.parse(next));
    this.rebuild();
    this.suppressUndo = false;
    notify.info('已重做');
  }

  // ============================================================
  // 参数化：表达式解析（主线程，纯计算）
  // ============================================================
  /**
   * 求值全部表达式，返回**已把数值替换为具体值**的特征副本。
   * 所有发给内核的操作都必须用它——内核只认具体数值，不认表达式。
   */
  resolvedFeatures(): Feature[] {
    const r = resolveExpressions(this.doc);
    this.lastResolve = r;
    this.paramValues = r.paramValues;
    this.expressionIssues = r.issues;
    return r.features;
  }

  /** 全局参数行（供参数表 UI） */
  paramRows(): { name: string; expr: string; comment?: string; value?: number; error?: string }[] {
    const r = this.lastResolve ?? resolveExpressions(this.doc);
    this.lastResolve = r;
    this.paramValues = r.paramValues;
    this.expressionIssues = r.issues;
    return this.doc.params.map((p) => {
      const issue = r.issues.find((i) => i.where === `参数:${p.name}`);
      return {
        name: p.name,
        expr: p.expr,
        comment: p.comment,
        value: r.paramValues[p.name],
        error: issue?.message,
      };
    });
  }

  setParam(name: string, expr: string, comment?: string): void {
    this.pushUndo();
    this.doc.setParam(name.trim(), expr, comment);
    this.rebuild();
    this.emit('params');
  }

  removeParam(name: string): void {
    this.pushUndo();
    this.doc.removeParam(name);
    this.rebuild();
    this.emit('params');
  }

  /** 列出某个特征的数值参数（供表达式对话框选择） */
  featureNumericParams(id: FeatureId): { path: string; label: string; value: number }[] {
    const f = this.doc.getFeature(id);
    return f ? listNumericParams(f.params) : [];
  }

  /** 某个特征已绑定的表达式（含计算值与错误） */
  featureExpressionRows(id: FeatureId): { path: string; label: string; expr: string; value?: number; error?: string }[] {
    const f = this.doc.getFeature(id);
    if (!f?.expressions) return [];
    const params = listNumericParams(f.params);
    const r = resolveExpressions(this.doc);
    return Object.keys(f.expressions).map((path) => {
      const issue = r.issues.find((i) => i.where.startsWith(`特征:${f.name}.${path}`));
      return {
        path,
        label: params.find((p) => p.path === path)?.label ?? path,
        expr: f.expressions![path],
        value: issue ? undefined : getPathFromResolved(r.features, f.id, path),
        error: issue?.message,
      };
    });
  }

  /** 给某个特征的某个参数绑定表达式 */
  setFeatureExpression(id: FeatureId, path: string, expr: string): void {
    const f = this.doc.getFeature(id);
    if (!f) return;
    const text = expr.trim();
    if (!text) {
      this.removeFeatureExpression(id, path);
      return;
    }
    this.pushUndo();
    f.expressions = { ...(f.expressions ?? {}), [path]: text };
    this.rebuild();
    this.emit('params', 'props');
  }

  removeFeatureExpression(id: FeatureId, path: string): void {
    const f = this.doc.getFeature(id);
    if (!f?.expressions) return;
    this.pushUndo();
    delete f.expressions[path];
    if (!Object.keys(f.expressions).length) delete f.expressions;
    this.rebuild();
    this.emit('params', 'props');
  }

  /** 预览一条表达式（不改动文档） */
  previewExpr(src: string): { ok: boolean; value?: number; message?: string } {
    const r = previewExpression(src, this.doc);
    return r.ok ? { ok: true, value: r.value } : { ok: false, message: r.message };
  }

  /** 供对话框拼引用用的「特征名.属性」候选 */
  referenceCandidates(): { ref: string; label: string }[] {
    const out: { ref: string; label: string }[] = [];
    for (const f of this.doc.features) {
      for (const p of listNumericParams(f.params)) {
        out.push({ ref: `${f.name}.${p.path}`, label: `${f.name} · ${p.label} = ${round2(p.value)}` });
      }
    }
    return out;
  }

  // ============================================================
  // 重建（内核 Worker）
  // ============================================================
  /** 重建模型并刷新视图（异步，几何在内核 Worker 里算） */
  async rebuild(options: { fit?: boolean; keepSelection?: boolean } = {}): Promise<void> {
    this.setStatus('正在重建…', 'busy');
    try {
      const model = await kernel.rebuild(this.resolvedFeatures());
      this.model = model;
      this.importedModel = null; // 参数化模型优先于导入体
      this.doc.rebuildCount++;
      // 把内核侧的错误回写到特征（供 UI 标红）
      const errMap = new Map(model.errors.map((e) => [e.id, e.message]));
      // 表达式错误优先展示（更贴近用户输入）
      for (const fi of this.lastResolve?.featureIssues ?? []) errMap.set(fi.id, fi.message);
      for (const f of this.doc.features) f.error = errMap.get(f.id);
      this.syncView(options.fit ?? false);
      const errs = model.errors;
      if (errs.length) {
        this.setStatus(`${errs.length} 个特征有错误`, 'err', errs[0].message);
      } else {
        const st = model.stats;
        const ex = this.expressionIssues.length;
        this.setStatus(
          `重建完成 ${model.rebuildMs.toFixed(0)}ms`,
          ex ? 'err' : 'ok',
          `${st.faces} 面 · ${st.edges} 边 · 体积 ${st.volume.toFixed(2)} mm³${ex ? ` · ${ex} 处表达式问题` : ''}`
        );
      }
      this.emit('change', 'tree', 'props', 'params');
    } catch (e) {
      this.setStatus(`重建失败：${(e as Error).message}`, 'err');
      notify.err(`重建失败：${(e as Error).message}`);
    }
  }

  /** 把当前可序列化模型同步到三维场景 */
  syncView(fit = false): void {
    const old = this.shapeView;
    if (this.previewObject) {
      this.previewObject.removeFromParent();
      this.previewObject = null;
    }
    if (old) {
      old.group.removeFromParent();
      old.dispose();
      this.shapeView = null;
    }
    const m = this.currentModel();
    if (m) {
      const sv = new ShapeView(m.mesh, { style: this.displayStyle, bodyColor: this.appearanceHex });
      sv.setGhost(!!this.editingSketch);
      this.viewport.root.add(sv.group);
      this.shapeView = sv;
    }
    this.selection = { faces: [], edges: [], vertices: [] };
    this.refreshHighlight();
    if (fit) {
      this.viewport.zoomFit(m?.bbox ?? null);
    }
    this.applyModeVisibility();
    this.viewport.invalidate();
    this.emit('selection');
  }

  setDisplayStyle(style: DisplayStyle): void {
    this.displayStyle = style;
    this.shapeView?.applyStyle(style);
    this.viewport.invalidate();
    this.emit('change', 'view');
  }

  // ============================================================
  // 选择
  // ============================================================
  clearSelection(): void {
    this.selection = { faces: [], edges: [], vertices: [] };
    this.refreshHighlight();
    this.emit('selection', 'props');
  }

  selectFace(index: number, additive = false): void {
    if (this.selectionFilter === 'edge' || this.selectionFilter === 'vertex') return;
    if (!additive) this.selection.edges = [];
    if (additive) {
      const i = this.selection.faces.indexOf(index);
      if (i >= 0) this.selection.faces.splice(i, 1);
      else this.selection.faces.push(index);
    } else {
      this.selection.faces = [index];
    }
    this.refreshHighlight();
    this.emit('selection', 'props');
  }

  selectEdge(index: number, additive = false): void {
    if (this.selectionFilter === 'face' || this.selectionFilter === 'vertex') return;
    if (!additive) this.selection.faces = [];
    if (additive) {
      const i = this.selection.edges.indexOf(index);
      if (i >= 0) this.selection.edges.splice(i, 1);
      else this.selection.edges.push(index);
    } else {
      this.selection.edges = [index];
    }
    this.refreshHighlight();
    this.emit('selection', 'props');
  }

  /** 选中一个网格顶点（选择过滤器为「顶点」时专用） */
  selectVertex(index: number, additive = false): void {
    if (this.selectionFilter !== 'vertex' && this.selectionFilter !== 'all') return;
    if (!additive) {
      this.selection.faces = [];
      this.selection.edges = [];
    }
    if (additive) {
      const i = this.selection.vertices.indexOf(index);
      if (i >= 0) this.selection.vertices.splice(i, 1);
      else this.selection.vertices.push(index);
    } else {
      this.selection.vertices = [index];
    }
    this.refreshHighlight();
    this.emit('selection', 'props');
  }

  /**
   * 顶点拾取：屏幕空间就近原则。
   * 把网格每个顶点投影到 NDC 再换算成像素，取与点击位置距离最近且在 8px 内的顶点。
   * 顶点数一般数千，全遍历在点击这种低频事件上可接受。
   */
  pickVertex(x: number, y: number): number | null {
    const sv = this.shapeView;
    if (!sv) return null;
    const pos = sv.mesh.geometry.getAttribute('position');
    if (!pos) return null;
    const rect = this.viewport.renderer.domElement.getBoundingClientRect();
    const cam = this.viewport.camera;
    cam.updateMatrixWorld();
    const v = new THREE.Vector3();
    let best = -1;
    let bestD = 8 * 8;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i).project(cam);
      if (v.z < -1 || v.z > 1) continue;
      const sx = ((v.x + 1) / 2) * rect.width;
      const sy = ((1 - v.y) / 2) * rect.height;
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

  refreshHighlight(): void {
    while (this.highlightGroup.children.length) {
      const c = this.highlightGroup.children.pop() as THREE.Object3D;
      const any = c as any;
      any.geometry?.dispose?.();
      any.material?.dispose?.();
    }
    const sv = this.shapeView;
    if (!sv) return;

    const faceMat = new THREE.MeshBasicMaterial({
      color: COLORS.selectFace,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    for (const fi of this.selection.faces) {
      const geo = sv.faceGeometry(fi);
      if (geo) this.highlightGroup.add(new THREE.Mesh(geo, faceMat));
    }

    const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.selectEdge });
    for (const ei of this.selection.edges) {
      const geo = sv.edgeGeometry(ei);
      if (geo) this.highlightGroup.add(new THREE.LineSegments(geo, edgeMat));
    }

    // 顶点高亮：只为选中顶点构造点集（像素尺寸，不随缩放放大）
    if (this.selection.vertices.length) {
      const attr = sv.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = new Float32Array(this.selection.vertices.length * 3);
      this.selection.vertices.forEach((vi, k) => {
        const i = Math.min(Math.max(vi, 0), attr.count - 1);
        arr[k * 3] = attr.getX(i);
        arr[k * 3 + 1] = attr.getY(i);
        arr[k * 3 + 2] = attr.getZ(i);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      this.highlightGroup.add(
        new THREE.Points(geo, new THREE.PointsMaterial({ color: COLORS.selectEdge, size: 8, sizeAttenuation: false }))
      );
    }
    this.viewport.invalidate();
  }

  /** 当前选中的面元数据（来自 Worker，无 OCCT 句柄） */
  selectedFaceInfos(): FaceMeta[] {
    const m = this.currentModel();
    if (!m) return [];
    return this.selection.faces.map((i) => m.mesh.faceMetas[i]).filter(Boolean);
  }

  selectedEdgeInfos(): EdgeMeta[] {
    const m = this.currentModel();
    if (!m) return [];
    return this.selection.edges.map((i) => m.mesh.edgeMetas[i]).filter(Boolean);
  }

  // ============================================================
  // 指针交互
  // ============================================================
  private pointerDownAt: { x: number; y: number; button: number } | null = null;
  private sketchDragging = false;

  private bindPointer(): void {
    const dom = this.viewport.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this.pointerDownAt = { x: e.clientX, y: e.clientY, button: e.button };
      if (e.button === 0) this.sketchDragging = this.sketch.handleDown(e.clientX, e.clientY);
    });
    dom.addEventListener('pointermove', (e) => {
      this.sketch.handleMove(e.clientX, e.clientY);
    });
    dom.addEventListener('pointerup', (e) => {
      if (this.sketchDragging) {
        this.sketchDragging = false;
        this.sketch.handleUp();
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
      this.sketch.handleMove(-1e6, -1e6);
    });
    // 双击结束「连续点击」类工具（B 样条）
    dom.addEventListener('dblclick', () => {
      if (this.mode === 'sketch') this.sketch.finishBSpline();
    });
  }

  onCanvasClick: ((x: number, y: number, additive: boolean) => boolean) | null = null;

  private handleClick(x: number, y: number, additive: boolean): void {
    if (this.onCanvasClick && this.onCanvasClick(x, y, additive)) return;
    if (this.mode === 'assembly') {
      this.pickAssembly(x, y, additive);
      return;
    }
    if (this.mode !== 'model') return;

    const rc = this.viewport.rayFromScreen(x, y);
    const sv = this.shapeView;
    if (!sv) {
      this.clearSelection();
      return;
    }

    // 过滤为「顶点」时只拾取顶点（就近原则，8px 内）
    if (this.selectionFilter === 'vertex') {
      const vi = this.pickVertex(x, y);
      if (vi !== null) {
        this.selectVertex(vi, additive);
        this.setStatus('已选择顶点', 'ok');
      } else {
        this.clearSelection();
      }
      return;
    }

    const edgeHit = this.pickEdge(rc, x, y);
    if (edgeHit !== null) {
      this.selectEdge(edgeHit, additive);
      const meta = sv.edgeMetas[edgeHit];
      this.setStatus('已选择边', 'ok', meta ? `长度 ${meta.length.toFixed(2)} mm` : undefined);
      return;
    }

    const hits = rc.intersectObject(sv.mesh, false);
    if (hits.length && hits[0].faceIndex !== undefined) {
      const fi = sv.faceIndexFromTriangle(hits[0].faceIndex);
      if (fi >= 0) {
        this.selectFace(fi, additive);
        const meta = sv.faceMetas[fi];
        this.setStatus('已选择面', 'ok', meta ? `面积 ${meta.area.toFixed(2)} mm²` : undefined);
        return;
      }
    }
    this.clearSelection();
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
    const a = this.assembly;
    if (!a) return;
    const rc = this.viewport.rayFromScreen(x, y);

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
    if (!additive || this.assemblyPicks.length >= 2) this.assemblyPicks = [];
    this.assemblyPicks.push(ref);
    this.syncAssemblyPickMarkers();
    const names = this.assemblyPicks
      .map((p) => `${a.getComponent(p.comp)?.name ?? '?'}·${mateRefLabel(p)}`)
      .join(' → ');
    this.setStatus('装配拾取', 'ok', `${label}（${this.assemblyPicks.length}/2）：${names}`);
    this.emit('change', 'props');
    this.viewport.invalidate();
  }

  clearAssemblyPicks(): void {
    this.assemblyPicks = [];
    this.syncAssemblyPickMarkers();
    this.emit('change', 'props');
  }

  /** 依据当前拾取重建 3D 标记：橙=第 1 个参考，蓝=第 2 个，球 + 轴向线段 */
  private syncAssemblyPickMarkers(): void {
    const a = this.assembly;
    if (!this.assemblyPickGroup) {
      this.assemblyPickGroup = new THREE.Group();
      this.assemblyPickGroup.userData.pickMarker = true;
      this.viewport.root.add(this.assemblyPickGroup);
    }
    const g = this.assemblyPickGroup;
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { (o.geometry as THREE.BufferGeometry)?.dispose(); (o.material as THREE.Material)?.dispose(); } });
    }
    if (!a) return;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const colors = [0xff8c00, 0x2b8cff];
    this.assemblyPicks.forEach((ref, i) => {
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
    g.visible = this.mode === 'assembly';
  }

  /** 屏幕空间边拾取（针对指定视图） */
  private pickEdgeIn(sv: ShapeView, sx: number, sy: number, threshold = 8): number | null {
    const rect = this.viewport.renderer.domElement.getBoundingClientRect();
    const mx = sx - rect.left;
    const my = sy - rect.top;
    let best = -1;
    let bestD = threshold;

    const tmp = new THREE.Vector3();
    for (let i = 0; i < sv.edgeMetas.length; i++) {
      const flat = sv.meshResult.edgePolylines[i];
      if (!flat || flat.length < 6) continue;
      let prev: THREE.Vector3 | null = null;
      for (let k = 0; k < flat.length; k += 3) {
        tmp.set(flat[k], flat[k + 1], flat[k + 2]);
        const cur = tmp.clone();
        if (prev) {
          const a = this.viewport.worldToScreen([prev.x, prev.y, prev.z]);
          const b = this.viewport.worldToScreen([cur.x, cur.y, cur.z]);
          const d = distToSegment(mx, my, a.x, a.y, b.x, b.y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        prev = cur;
      }
    }
    return best >= 0 ? best : null;
  }

  /** 屏幕空间边拾取（模型模式） */
  private pickEdge(rc: THREE.Raycaster, sx: number, sy: number): number | null {
    const sv = this.shapeView;
    if (!sv) return null;
    void rc;
    return this.pickEdgeIn(sv, sx, sy);
  }

  // ============================================================
  // 模式切换
  // ============================================================
  setMode(mode: AppMode): void {
    if (this.mode === mode) return;
    if (mode !== 'sketch' && this.editingSketch) this.exitSketch(false);
    this.mode = mode;
    if (mode !== 'drawing' && this.dimMode) {
      this.dimMode = false;
      this.lastDimRun = null;
    }
    if (mode !== 'assembly') {
      this.assemblyPicks = [];
      this.syncAssemblyPickMarkers();
    }
    if (mode === 'assembly') {
      const a = this.ensureAssembly();
      if (!a.components.length && this.hasModel) {
        a.insertFromDocument(this.doc.clone(), this.doc.features.length ? '零件1' : '零件1');
      }
    }
    if (mode === 'drawing') {
      this.ensureDrawing();
      if (this.drawing && !this.drawing.views.length && this.hasModel) {
        this.generateDrawing(['front', 'top', 'right', 'iso']);
      }
    }
    this.applyModeVisibility();
    this.emit('mode', 'change', 'tree', 'props');
  }

  applyModeVisibility(): void {
    const mode = this.mode;
    const showModel = mode === 'model' || mode === 'sketch';
    if (this.shapeView) this.shapeView.group.visible = showModel;
    if (mode === 'assembly' && this.assembly) {
      this.assembly.syncScene(this.viewport.root, this.displayStyle);
    } else {
      for (const child of [...this.viewport.root.children]) {
        if (child.userData?.compId) child.visible = false;
      }
    }
    if (this.assemblyPickGroup) this.assemblyPickGroup.visible = mode === 'assembly';
    const canvas = this.viewport.renderer.domElement;
    canvas.style.visibility = mode === 'drawing' ? 'hidden' : '';
    if (this.drawingHost) this.drawingHost.classList.toggle('hidden', mode !== 'drawing');
    this.viewport.setPlanesVisible(this.showPlanes && showModel);
    this.viewport.setGridVisible(this.showGrid && mode !== 'drawing');
    this.viewport.invalidate();
  }

  // ============================================================
  // 装配
  // ============================================================
  ensureAssembly(): Assembly {
    if (!this.assembly) this.assembly = new Assembly();
    return this.assembly;
  }

  async syncAssemblyScene(): Promise<void> {
    const a = this.assembly;
    if (!a) return;
    await a.syncScene(this.viewport.root, this.displayStyle);
    this.viewport.invalidate();
    this.emit('tree', 'props', 'change');
  }

  // ============================================================
  // 工程图
  // ============================================================
  ensureDrawing(): Drawing {
    if (!this.drawing) this.drawing = new Drawing();
    return this.drawing;
  }

  generateDrawing(kinds: ViewKind[] = ['front', 'top', 'right', 'iso']): void {
    const m = this.currentModel();
    if (!m) {
      notify.err('没有可生成工程图的实体');
      return;
    }
    const d = this.ensureDrawing();
    generateStandardViews(d, m.mesh, kinds);
    this.drawingScale && (d.fixedScale = this.drawingScale);
    this.emit('drawing', 'tree');
  }

  addDrawingView(kind: ViewKind): void {
    const m = this.currentModel();
    if (!m) {
      notify.err('没有可生成工程图的实体');
      return;
    }
    const d = this.ensureDrawing();
    d.addView(kind, m.mesh, this.drawingScale);
    d.layout();
    this.emit('drawing', 'tree');
  }

  refreshDrawing(): void {
    this.emit('drawing');
  }

  /** 切换尺寸标注模式（点击工程图边线即标注） */
  toggleDimensionMode(): void {
    if (!this.drawing || !this.drawing.views.length) {
      notify.info('请先生成工程图视图');
      return;
    }
    this.dimMode = !this.dimMode;
    this.lastDimRun = null;
    this.setStatus(this.dimMode ? '尺寸标注：点击边线添加标注' : '就绪', this.dimMode ? 'busy' : 'ok');
    notify.info(
      this.dimMode
        ? '尺寸标注：点击边线添加长度标注（Shift+点击另一条边 → 标注两条边间距；右键标注可删除）'
        : '已退出尺寸标注模式'
    );
    this.refreshDrawing();
  }

  /** 工程图边线被点击 → 添加尺寸标注 */
  placeDrawingDimension(viewId: string, runIdx: number, shift = false): void {
    const d = this.drawing;
    const v = d?.views.find((x) => x.id === viewId);
    if (!d || !v || !this.dimMode) return;
    const key = `${viewId}:${runIdx}`;
    const prevPrefix = `${viewId}:`;
    if (shift && this.lastDimRun && this.lastDimRun.startsWith(prevPrefix)) {
      const prev = Number(this.lastDimRun.slice(prevPrefix.length));
      const dim = d.dimensionBetweenRuns(viewId, prev, runIdx);
      if (dim) notify.ok(`距离标注：${d.dimensionValue(v, dim).toFixed(2)} mm`);
    } else {
      const dim = d.dimensionRun(viewId, runIdx);
      if (dim) notify.ok(`长度标注：${d.dimensionValue(v, dim).toFixed(2)} mm`);
    }
    this.lastDimRun = key;
    this.emit('drawing');
  }

  /** 删除某个尺寸标注（右键工程图标注） */
  removeDrawingDim(viewId: string, dimId: string): void {
    const d = this.drawing;
    if (!d) return;
    d.removeDim(viewId, dimId);
    this.refreshDrawing();
  }

  clearDrawingDims(): void {
    const d = this.drawing;
    if (!d) return;
    d.clearDims();
    this.lastDimRun = null;
    this.refreshDrawing();
    notify.info('已清除全部标注');
  }

  /** 自动标注：overall 标总宽/高，all 再标直线边 */
  autoDimensionDrawing(mode: 'overall' | 'all' = 'overall'): void {
    const d = this.drawing;
    if (!d || !d.views.length) {
      notify.info('请先生成工程图视图');
      return;
    }
    const n = d.autoDimension(mode);
    this.refreshDrawing();
    notify.ok(`已自动标注 ${n} 处尺寸`);
  }

  /** 孔位自动标注：中心定位尺寸 + 正视圆的直径 */
  autoHoleDimensionDrawing(): void {
    const d = this.drawing;
    if (!d || !d.views.length) {
      notify.info('请先生成工程图视图');
      return;
    }
    const n = d.autoDimensionHoles();
    this.refreshDrawing();
    notify.ok(`已标注 ${n} 处孔位尺寸`);
  }

  /** 应用标注元数据（公差 / φ 前缀） */
  applyDrawingDimMeta(
    viewId: string,
    dimId: string,
    meta: { tolerance?: { upper: number; lower: number }; prefix?: string }
  ): boolean {
    const d = this.drawing;
    if (!d || !d.setDimMeta(viewId, dimId, meta)) return false;
    this.refreshDrawing();
    notify.ok('已更新尺寸标注');
    return true;
  }

  /** 切换明细表：从装配体（按特征序列分组计数，数量联动）或当前零件生成 */
  toggleDrawingBOM(): void {
    const d = this.drawing;
    if (!d || !d.views.length) {
      notify.info('请先生成工程图');
      return;
    }
    if (d.bom.length) {
      d.clearBom();
      this.refreshDrawing();
      notify.info('已清除明细表');
      return;
    }
    const a = this.assembly;
    const material = d.sheet.material;
    let rows: { name: string; qty: number; material?: string; note?: string }[];
    if (a && a.components.length) {
      rows = a.bomEntries().map((e) => ({
        name: e.name,
        qty: e.qty,
        material,
        note: e.qty > 1 ? `共 ${e.qty} 件` : undefined,
      }));
    } else if (this.hasModel) {
      const m = this.currentModel();
      rows = [{ name: m ? `零件·${this.doc.features.length} 特征` : '零件1', qty: 1, material }];
    } else {
      notify.info('没有可生成明细表的模型');
      return;
    }
    d.setBom(rows);
    this.refreshDrawing();
    notify.ok(`已生成明细表（${rows.length} 行，数量随装配自动联动）`);
  }

  /** 导出当前工程图为 PNG（把 SVG 光栅化到 canvas）*/
  exportDrawingPNG(scale = 4): Promise<void> {
    const d = this.drawing;
    if (!d) {
      notify.err('没有工程图');
      return Promise.reject(new Error('no drawing'));
    }
    const { w, h } = d.sheet;
    const svg = d.toSVG();
    return new Promise<void>((resolve, reject) => {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          canvas.toBlob((b) => {
            if (!b) {
              reject(new Error('toBlob 失败'));
              return;
            }
            b.arrayBuffer().then((buf) => {
              download(buf, 'drawing.png', 'image/png');
              notify.ok('PNG 已导出');
              resolve();
            });
          }, 'image/png');
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e as Error);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('SVG 光栅化失败'));
      };
      img.src = url;
    });
  }

  // ============================================================
  // 草图
  // ============================================================
  startSketch(plane: PlaneRef | SketchPlane): void {
    this.pushUndo();
    const f = newSketchFeature(typeof plane === 'string' ? plane : 'custom');
    if (typeof plane !== 'string') f.params.customPlane = plane;
    f.name = this.doc.nextName('sketch');
    this.doc.add(f);
    this.rebuild();
    this.enterSketch(f);
  }

  enterSketch(f: SketchFeature): void {
    this.activeSketchFeature = f;
    this.editingSketch = f;
    this.mode = 'sketch';
    this.sketchTool = null;
    this.pendingPoints = [];
    this.syncView();
    this.sketch.attach();
    this.applyModeVisibility();
    this.emit('mode', 'change', 'props');
  }

  exitSketch(revert = false): void {
    if (!this.editingSketch) return;
    const f = this.editingSketch;
    this.editingSketch = null;
    this.activeSketchFeature = null;
    this.sketchTool = null;
    this.pendingPoints = [];
    this.sketch.detach();
    if (revert) {
      const sk = f.params.sketch;
      if (!sk.entities.length && !sk.constraints.length) {
        this.doc.remove(f.id);
      }
    }
    this.mode = 'model';
    this.rebuild();
    this.applyModeVisibility();
    this.emit('mode', 'change', 'props');
  }

  setSketchTool(t: SketchTool | null): void {
    this.sketchTool = t;
    if (t) this.sketch.setTool(t);
    this.emit('props', 'change');
  }

  toggleOrigin(v: boolean): void {
    this.showOrigin = v;
    if (this.originGroup) this.originGroup.visible = v;
    this.viewport.invalidate();
    this.emit('change', 'view');
  }

  get sketchPlane(): SketchPlane {
    const f = this.editingSketch;
    if (!f) return DEFAULT_PLANE;
    if (f.params.plane === 'custom' && f.params.customPlane) return f.params.customPlane;
    return { front: DEFAULT_PLANE, top: TOP_PLANE, right: RIGHT_PLANE }[f.params.plane as 'front' | 'top' | 'right'] ?? DEFAULT_PLANE;
  }

  // ============================================================
  // 文件
  // ============================================================
  async exportStep(): Promise<void> {
    if (!this.hasModel) {
      notify.err('没有可导出的实体');
      return;
    }
    try {
      const r = await kernel.exportStep(this.resolvedFeatures());
      download(new Uint8Array(r.bytes), 'solid2.step', 'application/step');
      notify.ok(`STEP 导出成功（${((r.bytes.byteLength) / 1024).toFixed(1)} KB）`);
    } catch (e) {
      notify.err(`STEP 导出失败：${(e as Error).message}`);
    }
  }

  async exportStl(): Promise<void> {
    if (!this.hasModel) {
      notify.err('没有可导出的实体');
      return;
    }
    try {
      const m = await kernel.tessellate(this.resolvedFeatures(), 0.06, 0.2);
      const mesh = viewsOfMesh(m.mesh);
      const buf = exportSTLBinary(mesh);
      download(buf, 'solid2.stl', 'model/stl');
      notify.ok(`STL 导出成功（${mesh.indices.length / 3} 三角形）`);
    } catch (e) {
      notify.err(`STL 导出失败：${(e as Error).message}`);
    }
  }

  async exportObj(): Promise<void> {
    if (!this.hasModel) {
      notify.err('没有可导出的实体');
      return;
    }
    try {
      const m = await kernel.tessellate(this.resolvedFeatures(), 0.06, 0.2);
      const mesh = viewsOfMesh(m.mesh);
      download(exportOBJ(mesh), 'solid2.obj', 'model/obj');
      notify.ok('OBJ 导出成功');
    } catch (e) {
      notify.err(`OBJ 导出失败：${(e as Error).message}`);
    }
  }

  saveProject(): void {
    const json = JSON.stringify(this.doc.toJSON(), null, 2);
    download(json, 'solid2-model.json', 'application/json');
    notify.ok('项目已保存');
  }

  async openProject(): Promise<void> {
    const file = await pickFile('.json,.solid2');
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      this.pushUndo();
      this.doc = CadDocument.fromJSON(data);
      this.rebuild({ fit: true });
      notify.ok(`已打开：${file.name}`);
    } catch (e) {
      notify.err(`打开失败：${(e as Error).message}`);
    }
  }

  async importStepFile(): Promise<void> {
    const file = await pickFile('.step,.stp');
    if (!file) return;
    try {
      const buf = await readFileAsArrayBuffer(file);
      const r = await kernel.importStep(buf);
      this.importedModel = { mesh: r.mesh, bbox: r.bbox, stats: r.stats, errors: [], rebuildMs: 0 };
      this.model = null;
      const sv = new ShapeView(r.mesh, { style: this.displayStyle, bodyColor: this.appearanceHex });
      if (this.shapeView) {
        this.shapeView.group.removeFromParent();
        this.shapeView.dispose();
      }
      this.shapeView = sv;
      this.viewport.root.add(sv.group);
      this.viewport.zoomFit(r.bbox);
      this.applyModeVisibility();
      this.viewport.invalidate();
      notify.ok(`已导入 ${file.name}`);
    } catch (e) {
      notify.err(`导入失败：${(e as Error).message}`);
    }
  }

  // ============================================================
  // 评估
  // ============================================================
  async showMassProperties(): Promise<void> {
    if (!this.hasModel) {
      notify.err('没有实体');
      return;
    }
    try {
      const mp = await kernel.massProps(this.resolvedFeatures());
      const bb = this.currentModel()!.bbox;
      const st = this.currentModel()!.stats;
      tableModal(
        '质量属性',
        ['项目', '数值'],
        [
          ['体积', `${mp.volume.toFixed(3)} mm³`],
          ['表面积', `${mp.area.toFixed(3)} mm²`],
          ['质心 X', `${mp.centroid[0].toFixed(3)} mm`],
          ['质心 Y', `${mp.centroid[1].toFixed(3)} mm`],
          ['质心 Z', `${mp.centroid[2].toFixed(3)} mm`],
          ['包围盒 X', `${(bb.max[0] - bb.min[0]).toFixed(2)} mm`],
          ['包围盒 Y', `${(bb.max[1] - bb.min[1]).toFixed(2)} mm`],
          ['包围盒 Z', `${(bb.max[2] - bb.min[2]).toFixed(2)} mm`],
          ['面数', String(st.faces)],
          ['边数', String(st.edges)],
        ],
        '体积与表面积由 OpenCASCADE 精确积分得到（非网格近似）。'
      );
    } catch (e) {
      notify.err(`计算失败：${(e as Error).message}`);
    }
  }

  measureDistance(): void {
    const faces = this.selection.faces;
    const edges = this.selection.edges;
    if (faces.length === 2) {
      kernel.measure(this.resolvedFeatures(), 'faceFace', faces[0], faces[1])
        .then((r) => notify.info(`两面最小距离：${r.distance.toFixed(4)} mm`))
        .catch((e) => notify.err(`测量失败：${(e as Error).message}`));
      return;
    }
    if (edges.length === 2) {
      kernel.measure(this.resolvedFeatures(), 'edgeEdge', edges[0], edges[1])
        .then((r) => notify.info(`两边最小距离：${r.distance.toFixed(4)} mm`))
        .catch((e) => notify.err(`测量失败：${(e as Error).message}`));
      return;
    }
    notify.info('请先选中两个面或两条边');
  }

  setView(dir: ViewDir): void {
    this.viewport.setView(dir);
    this.emit('view');
  }

  zoomFit(): void {
    this.viewport.zoomFit(this.currentModel()?.bbox ?? null);
    this.emit('view');
  }

  /** 缩小视图（SolidWorks: Z） */
  zoomOut(): void {
    this.viewport.zoomBy(1 / 1.25);
    this.emit('view');
  }

  /** 放大视图（SolidWorks: Shift+Z） */
  zoomIn(): void {
    this.viewport.zoomBy(1.25);
    this.emit('view');
  }

  /** 上一视图（SolidWorks 视图工具栏） */
  prevView(): void {
    if (!this.viewport.prevView()) notify.info('没有更早的视图');
    this.emit('view');
  }

  /** 缩放至区域（SolidWorks 视图工具栏） */
  zoomArea(rect: { x: number; y: number; w: number; h: number }): void {
    this.viewport.zoomArea(rect);
    this.emit('view');
  }

  /** 绕视点旋转视图（SolidWorks: 方向键 15°，Shift+方向键 90°） */
  rotateView(yawDeg: number, pitchDeg = 0): void {
    this.viewport.rotateView(yawDeg, pitchDeg);
    this.emit('view');
  }

  /** 平移视图（SolidWorks: Ctrl+方向键） */
  panView(dx: number, dy: number): void {
    this.viewport.panView(dx, dy);
    this.emit('view');
  }

  /** 正视于选中面（SolidWorks: Ctrl+8） */
  normalToSelection(): void {
    const faces = this.selectedFaceInfos();
    if (faces.length === 1) {
      const f = faces[0];
      this.viewport.normalTo(f.normal as [number, number, number], f.centroid as [number, number, number]);
    } else {
      this.viewport.setView('front');
    }
    this.emit('view');
  }

  get projection(): 'perspective' | 'orthographic' {
    return this.viewport.projection;
  }

  /** 透视 / 正投影（SolidWorks「显示模式」） */
  setProjection(mode: 'perspective' | 'orthographic'): void {
    this.viewport.setProjection(mode);
    this.setStatus(mode === 'perspective' ? '显示模式：透视' : '显示模式：正投影', 'ok');
    this.emit('view');
  }

  toggleProjection(): void {
    this.setProjection(this.projection === 'perspective' ? 'orthographic' : 'perspective');
  }

  get sceneName(): string {
    return this._sceneName;
  }

  /** 应用布景（SolidWorks 视图工具栏） */
  setScene(name: '默认' | '单色灰' | '深色' | '白色'): void {
    this._sceneName = name;
    this.viewport.setScene(name);
    this.setStatus(`布景：${name}`, 'ok');
    this.emit('view');
  }

  /** 剖面视图（SolidWorks 视图工具栏） */
  setSection(axis: 'none' | 'x' | 'y' | 'z'): void {
    this._sectionAxis = axis;
    this.viewport.setSection(axis, 0, this.currentModel()?.bbox ?? null);
    this.setStatus(axis === 'none' ? '剖面视图：关闭' : `剖面视图：沿 ${axis.toUpperCase()} 轴`, 'ok');
    this.emit('view');
  }

  toggleSection(axis: 'x' | 'y' | 'z'): void {
    this.setSection(this._sectionAxis === axis ? 'none' : axis);
  }

  get sectionAxis(): 'none' | 'x' | 'y' | 'z' {
    return this._sectionAxis;
  }

  private _sceneName: '默认' | '单色灰' | '深色' | '白色' = '默认';
  private _sectionAxis: 'none' | 'x' | 'y' | 'z' = 'none';

  /** 删除当前选择（SolidWorks: Delete） */
  deleteSelection(): void {
    if (this.mode === 'sketch') {
      this.sketch.deleteSelection();
      return;
    }
    if (this.selection.faces.length || this.selection.edges.length) {
      const n = this.selection.faces.length + this.selection.edges.length;
      this.clearSelection();
      notify.info(`已清除 ${n} 项选择（删除几何请用「删除面/删除实体」命令）`);
      return;
    }
    notify.info('没有可删除的对象');
  }

  /** Esc：退出当前命令 / 清除选择 / 退出草图 */
  escape(): void {
    if (this.mode === 'sketch') {
      this.sketch.handleKey(new KeyboardEvent('keydown', { key: 'Escape' }));
      return;
    }
    if (this.selection.faces.length || this.selection.edges.length) {
      this.clearSelection();
      return;
    }
    if (this.dimMode) {
      this.toggleDimensionMode();
    }
  }

  /** 新建文档（SolidWorks: Ctrl+N） */
  newProject(): void {
    this.pushUndo();
    this.doc = new CadDocument();
    this.model = null;
    this.importedModel = null;
    this.assembly = null;
    this.drawing = null;
    this.mode = 'model';
    this.editingSketch = null;
    this.activeSketchFeature = null;
    this.rebuild({ fit: true });
    this.emit('tree', 'props', 'params', 'mode');
    notify.ok('已新建零件');
  }

  /** 重建并刷新视图（SolidWorks: Ctrl+B） */
  rebuildModel(): void {
    this.rebuild();
    this.emit('view');
  }

  /** 强制重建（SolidWorks: Ctrl+Q）—— 丢弃表达式缓存重新求值 */
  forceRebuild(): void {
    this.lastResolve = null;
    this.paramValues = {};
    this.rebuild();
    this.emit('view');
    notify.ok('已强制重建');
  }

  /** 重绘屏幕（SolidWorks: Ctrl+R） */
  redraw(): void {
    this.viewport.invalidate();
    this.emit('view');
  }

  togglePlanes(v: boolean): void {
    this.showPlanes = v;
    this.viewport.setPlanesVisible(v);
    this.viewport.invalidate();
    this.emit('change', 'view');
  }

  toggleGrid(v: boolean): void {
    this.showGrid = v;
    this.viewport.setGridVisible(v);
    this.viewport.invalidate();
    this.emit('change', 'view');
  }

  /** 实时预览（传入内核回传的网格结果，无 OCCT） */
  showPreviewMesh(mesh: MeshResult, valid = true): void {
    this.clearPreview();
    try {
      const positions = new Float32Array(mesh.positions);
      const normals = new Float32Array(mesh.normals);
      const indices = new Uint32Array(mesh.indices);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, previewMaterial(valid));
      this.previewObject = m;
      this.viewport.root.add(m);
      this.viewport.invalidate();
    } catch {
      /* 预览失败不影响主流程 */
    }
  }

  clearPreview(): void {
    if (this.previewObject) {
      this.previewObject.removeFromParent();
      const any = this.previewObject as any;
      any.geometry?.dispose?.();
      any.material?.dispose?.();
      this.previewObject = null;
      this.viewport.invalidate();
    }
  }

  addFeature(f: Feature, opts: { rebuild?: boolean } = {}): void {
    this.pushUndo();
    this.doc.add(f);
    if (opts.rebuild !== false) this.rebuild();
    else this.emit('tree');
  }

  /**
   * 用一组特征替换（或追加到）当前文档 —— AI 建模助手的落地入口。
   * 与逐条 addFeature 的区别：只压一次撤销栈，且默认重建后自动适配视图。
   */
  loadFeatures(features: Feature[], opts: { replace?: boolean; fit?: boolean } = {}): void {
    if (!features.length) return;
    this.pushUndo();
    if (opts.replace !== false) this.doc = new CadDocument();
    for (const f of features) this.doc.add(f);
    this.rebuild({ fit: opts.fit ?? true });
    this.emit('tree', 'props');
  }

  /**
   * 用一组特征**整体替换**当前文档的特征列表 —— AI 编辑现有模型的落地入口。
   * 与 `loadFeatures` 的区别：原地改 `doc.features`，因此**保留全局参数与名称计数器**
   * （AI 编辑不该把用户定义好的参数表达式冲掉）。
   */
  setFeatures(features: Feature[], opts: { fit?: boolean } = {}): void {
    this.pushUndo();
    const keep = this.doc.features;
    keep.length = 0;
    for (const f of features) keep.push(f);
    this.rebuild({ fit: opts.fit ?? true });
    this.emit('tree', 'props', 'params');
  }

  /** 当前模型的可序列化包围盒（AI 编辑追加特征时的落位基准） */
  currentBBox(): { min: [number, number, number]; max: [number, number, number] } | null {
    return this.currentModel()?.bbox ?? null;
  }

  removeFeature(id: FeatureId): void {
    this.pushUndo();
    this.doc.remove(id);
    this.rebuild();
  }

  updateFeatureParams(id: FeatureId, patch: Record<string, any>): void {
    const f = this.doc.getFeature(id);
    if (!f) return;
    Object.assign(f.params as any, patch);
    this.rebuild();
  }

  // ============================================================
  // 剪贴板 / 全选 / 属性 / 打印（SolidWorks 编辑菜单）
  // ============================================================
  /** 全选：草图选全部实体，模型选全部面，装配体选全部组件 */
  selectAll(): void {
    if (this.mode === 'sketch') {
      this.sketch.selectAll();
      return;
    }
    if (this.mode === 'assembly') {
      const a = this.assembly;
      if (!a) return;
      const c = a.components[0];
      if (c) {
        this.assemblyPicks = [{ comp: c.id, localPoint: [0, 0, 0], localDir: [0, 0, 1], kind: 'planar' }];
        this.emit('selection');
      }
      return;
    }
    const m = this.currentModel();
    if (!m) {
      notify.info('没有可选择的几何');
      return;
    }
    this.selection = {
      faces: m.mesh.faceMetas.map((_, i) => i),
      edges: [],
      vertices: [],
    };
    this.refreshHighlight();
    this.emit('selection', 'props');
    this.setStatus(`已全选 ${this.selection.faces.length} 个面`, 'ok');
  }

  /** 复制：有选择时复制选择摘要，无选择时复制整份特征定义（JSON） */
  private clipboardText(): string {
    const n = this.selection.faces.length + this.selection.edges.length;
    if (n) {
      const faces = this.selectedFaceInfos().map((f) => ({
        surfaceType: f.surfaceType,
        area: round2(f.area),
        centroid: f.centroid.map(round2),
      }));
      const edges = this.selectedEdgeInfos().map((e) => ({
        curveType: e.curveType,
        length: round2(e.length),
        mid: e.mid.map(round2),
      }));
      return JSON.stringify({ kind: 'solid2.selection', faces, edges }, null, 2);
    }
    return JSON.stringify({ kind: 'solid2.features', features: this.doc.toJSON().features }, null, 2);
  }

  async copySelection(): Promise<void> {
    const text = this.clipboardText();
    try {
      await navigator.clipboard.writeText(text);
      const n = this.selection.faces.length + this.selection.edges.length;
      notify.ok(n ? `已复制 ${n} 项选择信息` : '已复制零件特征定义');
    } catch {
      notify.err('剪贴板不可用（浏览器未授权）');
    }
  }

  async cutSelection(): Promise<void> {
    await this.copySelection();
    if (this.selection.faces.length || this.selection.edges.length) this.clearSelection();
  }

  async pasteFromClipboard(): Promise<void> {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      notify.err('剪贴板不可用（浏览器未授权）');
      return;
    }
    try {
      const data = JSON.parse(text);
      const feats = data?.features ?? data?.doc?.features;
      if (!Array.isArray(feats) || !feats.length) {
        notify.info('剪贴板内容不是可识别的特征定义');
        return;
      }
      this.loadFeatures(feats as Feature[], { replace: false, fit: true });
      notify.ok(`已粘贴 ${feats.length} 个特征`);
    } catch {
      notify.info('剪贴板内容不是可识别的特征定义');
    }
  }

  /** 属性（SolidWorks: Alt+Enter） */
  showProperties(): void {
    const s = this.modelSummary();
    const rows: (string | number)[][] = [
      ['文档类型', { model: '零件', sketch: '零件（编辑草图）', assembly: '装配体', drawing: '工程图' }[this.mode]],
      ['特征数', this.doc.features.length],
      ['重建次数', this.doc.rebuildCount],
      ['面 / 边 / 实体', `${s.faces} / ${s.edges} / ${s.solids}`],
      ['全局参数', this.doc.params.length],
      ['单位系统', 'MMGS（毫米、克、秒）'],
      ['投影模式', this.projection === 'perspective' ? '透视' : '正投影'],
      ['布景', this._sceneName],
    ];
    const last = this.doc.features[this.doc.features.length - 1];
    if (last) {
      rows.push(['最后特征', last.name]);
      rows.push(['最后特征类型', FEATURE_LABEL[last.type] ?? last.type]);
    }
    tableModal('属性', ['项目', '值'], rows, '按 Alt+Enter 随时查看当前文档属性。');
  }

  /** 打印当前视图（SolidWorks: Ctrl+P）—— 用离屏 iframe 只打印图形区截图 */
  printView(): void {
    const dataUrl = this.viewport.snapshot();
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) {
      frame.remove();
      notify.err('打印不可用');
      return;
    }
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Solid2 打印</title>` +
        `<style>@page{margin:12mm}html,body{margin:0}img{width:100%;display:block}</style></head>` +
        `<body><img src="${dataUrl}"></body></html>`
    );
    doc.close();
    const go = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        notify.ok('已生成打印预览');
      } catch (e) {
        notify.err(`打印失败：${(e as Error).message}`);
      }
      setTimeout(() => frame.remove(), 8000);
    };
    const img = doc.querySelector('img');
    if (img && !img.complete) img.addEventListener('load', go, { once: true });
    else setTimeout(go, 120);
  }

  /** 切换文档类型（SolidWorks: Ctrl+Tab 的等价物：零件 → 装配体 → 工程图） */
  cycleDocument(): void {
    const order: AppMode[] = ['model', 'assembly', 'drawing'];
    const i = order.indexOf(this.mode);
    const next = order[(i + 1) % order.length];
    this.setMode(next);
    notify.info(`已切换到${next === 'model' ? '零件' : next === 'assembly' ? '装配体' : '工程图'}`);
  }

  /** 隐藏 / 显示（SolidWorks: Tab）—— 装配体下切换已拾取组件的可见性 */
  toggleTabVisibility(): void {
    if (this.mode !== 'assembly') {
      notify.info('隐藏 / 显示（Tab）用于装配体中切换组件可见性');
      return;
    }
    const a = this.assembly;
    const ids = [...new Set(this.assemblyPicks.map((p) => p.comp))];
    if (!a || !ids.length) {
      notify.info('请先在图形区点选要隐藏 / 显示的组件');
      return;
    }
    for (const id of ids) {
      const c = a.getComponent(id);
      if (c) c.visible = !c.visible;
    }
    this.assemblyPicks = [];
    void this.syncAssemblyScene();
    notify.ok('已切换组件显示状态');
  }
}

/** 从解析后的特征里取某个参数路径的具体值 */
function getPathFromResolved(features: Feature[], id: FeatureId, path: string): number | undefined {
  const f = features.find((x) => x.id === id);
  return f ? getParamPath(f.params, path) : undefined;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {  const dx = x2 - x1;
  const dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 坐标轴原点标记 */
function buildOriginMarker(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'origin';
  const L = 14;
  const mk = (dir: [number, number, number], color: number) => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(dir[0] * L, dir[1] * L, dir[2] * L),
    ]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  };
  g.add(mk([1, 0, 0], 0xd9432f));
  g.add(mk([0, 1, 0], 0x2e9e5b));
  g.add(mk([0, 0, 1], 0x2b7de9));
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0x1f2733 })
  );
  g.add(dot);
  return g;
}
