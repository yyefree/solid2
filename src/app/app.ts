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
import type { Feature, FeatureId, FeatureParamsPatch, PlaneRef, SketchFeature } from '../doc/types';
import { FEATURE_LABEL } from '../doc/types';
import { type ExprIssue } from '../doc/expr';
import { download, pickFile, readFileAsArrayBuffer } from '../core/meshexport';
import { kernel } from '../core/kernel';
import type { ModelResult, FaceMeta, EdgeMeta } from '../core/kernel-types';
import { Viewport, type ViewDir, LAYOUT_DEFS, type LayoutName } from '../view/viewport';
import { ShapeView, type DisplayStyle } from '../view/shapeview';
import { COLORS } from '../view/materials';
import { disposeGroupChildren } from '../view/dispose';
import { notify, tableModal } from '../ui/toast';
import { DEFAULT_UNIT, isUnitSystem, formatLength, formatArea, formatVolume, UNIT_BY_ID, type UnitSystem } from '../core/units';
import { closePropertyManager } from '../ui/propertymanager';
import { closeAllPopups } from '../ui/popup';
import { DEFAULT_PLANE, RIGHT_PLANE, TOP_PLANE, type SketchPlane } from '../sketch/types';
import { SketchController, type SketchTool } from './sketchMode';
import { SelectionStore, type GeomKind, type SelectionFilter } from './selection-store';
import { UndoManager, type MutateOpts } from './undo-manager';
import { ParamService } from './param-service';
import { FileService } from './file-service';
import { PickService } from './pick-service';
import { Assembly, mateRefLabel, type MateRef } from './assembly';
import { Drawing, type ViewKind, type GdtSymbol, type SheetSpec } from './drawing';
import { DrawingService } from './drawing-service';
import { openSectionProperties } from '../ui/sectionprops-dialog';
import type { AppApi } from './app-api';

export type AppMode = 'model' | 'sketch' | 'assembly' | 'drawing';

/** 多文档条目（SolidWorks 图形区底部文档标签栏）。
 *  条目持有 CadDocument 实例与自己的 undo/redo 栈——切换文档只是换引用，
 *  不序列化、不重建，切回时几何/参数/计数器全部原样恢复。 */
export interface DocumentEntry {
  id: string;
  /** 文档名，如「零件1」/「装配体2」 */
  name: string;
  /** 文档类型（= 非草图模式的 mode） */
  kind: 'model' | 'assembly' | 'drawing';
  doc: CadDocument;
  model: ModelResult | null;
  /** STEP 导入模型（同文档内有效） */
  imported: ModelResult | null;
  assembly: Assembly | null;
  drawing: Drawing | null;
  undo: unknown[];
  redo: unknown[];
  /** 视口相机快照（切回时恢复不丢视角） */
  view: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; zoom: number } | null;
}

export interface Selection {
  /** 面索引（对应 model.faceMetas） */
  faces: number[];
  /** 边索引（对应 model.edgeMetas） */
  edges: number[];
  /** 顶点索引（对应网格顶点缓冲区下标；仅选择过滤器为「顶点」时使用） */
  vertices: number[];
  /** 实体索引（对应 bodiesOf 展开顺序；仅选择过滤器为「实体」时使用） */
  bodies: number[];
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
  | 'feature'
  /** 文档列表变化（新建 / 关闭 / 切换文档）—— 供文档标签栏刷新 */
  | 'docs'
  /** 单位制变化（MMGS/CGS/IPS）—— 供状态栏、测量、工程图等只读读出值刷新 */
  | 'units';

export interface StatusInfo {
  text: string;
  kind: 'ok' | 'busy' | 'err';
  detail?: string;
}

export class App implements AppApi {
  readonly viewport: Viewport;
  doc = new CadDocument();
  shapeView: ShapeView | null = null;
  mode: AppMode = 'model';
  /**
   * 选中态唯一真源。此前 `selectedFeatureId` / `activeSketchFeature` /
   * `editingSketch` / `selection` 是 4 个独立字段、靠手工同步，同一根因反复出 bug；
   * 现全部收进 `SelectionStore`，互斥不变量（特征选择 ⇄ 几何选择）由它保证。
   * 对外 API 名字不变（下面的 getter/setter 委托），调用方无需改动。
   */
  private readonly sel = new SelectionStore();
  /** 单位制（SolidWorks 工具 > 选项 > 文档属性 > 单位）。内部几何恒为 mm，仅显示换算。 */
  unitSystem: UnitSystem = (() => {
    try {
      const v = localStorage.getItem('solid2.units');
      if (isUnitSystem(v)) return v;
    } catch { /* SSR / 隐私模式忽略 */ }
    return DEFAULT_UNIT;
  })();
  /** 零件外观色（十六进制，Heads-up「外观」下拉设置；默认 materials.ts 的 COLORS.body） */
  appearanceHex: number = COLORS.body;
  /** 当前光源预设名（Heads-up「光源」下拉） */
  lightPreset: string = '默认';
  /** RealView 图形（Heads-up「RealView」按钮）—— 实体材质带环境反射 */
  realView = false;
  /** 设计树中当前选中的特征 id（供属性管理器显示）—— SolidWorks「属性管理器」接管选中的特征 */
  get selectedFeatureId(): string | null {
    return this.sel.featureId;
  }
  set selectedFeatureId(id: string | null) {
    this.applyFeatureSelection(id);
  }

  // ---- 草图 ----
  /** 当前草图（后续特征对话框的默认绑定目标）。以 id 存储 → 撤销/重做后不会悬空。 */
  get activeSketchFeature(): SketchFeature | null {
    return this.sketchFeatureById(this.sel.activeSketchId);
  }
  set activeSketchFeature(f: SketchFeature | null) {
    this.sel.setActiveSketch(f ? f.id : null);
  }
  /** 正在编辑的草图；非空即表示处于草图编辑态。 */
  get editingSketch(): SketchFeature | null {
    return this.sketchFeatureById(this.sel.editingSketchId);
  }
  set editingSketch(f: SketchFeature | null) {
    this.sel.setEditingSketch(f ? f.id : null);
  }
  sketchTool: string | null = null;
  pendingPoints: [number, number][] = [];
  readonly sketch: SketchController;

  /** 按 id 取草图特征（不存在或类型不符返回 null） */
  private sketchFeatureById(id: string | null): SketchFeature | null {
    if (!id) return null;
    const f = this.doc.getFeature(id);
    return f && f.type === 'sketch' ? (f as SketchFeature) : null;
  }

  /**
   * 几何选择（面/边/点/实体的 mesh 下标）。只读语义：写请走 selectFace/selectEdge/…。
   *
   * ⚠️ 返回**拷贝**而非 `SelectionStore` 的内部对象引用——否则调用方
   * `app.selection.faces.push(...)` 会绕过互斥不变量直接污染选中态真源。
   * 所有现有调用点均为读（`.length` / `.map` / `.forEach`），拷贝无误。
   */
  get selection(): Selection {
    const g = this.sel.geometry;
    return {
      faces: [...g.faces],
      edges: [...g.edges],
      vertices: [...g.vertices],
      bodies: [...g.bodies],
    };
  }
  /** 选择过滤器（SolidWorks 状态栏 / 快捷键 F5）—— 'all' 不过滤（默认，行为不变） */
  get selectionFilter(): SelectionFilter {
    return this.sel.selectionFilter;
  }
  set selectionFilter(f: SelectionFilter) {
    this.sel.setSelectionFilter(f);
  }

  // ---- 显示 ----
  displayStyle: DisplayStyle = 'shadedEdges';
  showPlanes = true;
  showGrid = true;
  showOrigin = true;
  private originGroup: THREE.Group | null = null;

  // ---- 装配 / 工程图 ----
  assembly: Assembly | null = null;
  /**
   * 当前文档的工程图子文档（多文档各存一份）。
   * 存储在 `DrawingService`（src/app/drawing-service.ts）——App 只做 getter/setter
   * 委托；切文档（activateEntry）/ 打开文档（loadDocument）经 setter 换引用。
   */
  get drawing(): Drawing | null {
    return this.drawSvc.drawing;
  }
  set drawing(d: Drawing | null) {
    this.drawSvc.setDrawing(d);
  }
  drawingHost: HTMLElement | null = null;
  drawingScale = 0;
  /** 尺寸标注模式：点击工程图边线即添加标注（委托 DrawingService） */
  get dimMode(): boolean {
    return this.drawSvc.dimMode;
  }

  // ---- 工程图（命令与标注会话在 src/app/drawing-service.ts）----
  private readonly drawSvc: DrawingService;

  /**
   * 装配体可视化拾取：已选中的配合参考（最多 2 个，用于创建配合）。
   * 存储在 `PickService`（src/app/pick-service.ts）——App 只做 getter/setter 委托。
   * ⚠️ 写入经 setter 走 `assignPicks`（置空/置一，**不带 emit**）；要广播
   * change/props 的「清空」路径是 `clearAssemblyPicks()` 方法，两者语义不同。
   */
  get assemblyPicks(): MateRef[] {
    return this.pickSvc.picks;
  }
  set assemblyPicks(refs: MateRef[]) {
    this.pickSvc.assignPicks(refs);
  }

  // ---- 拾取交互（实现在 src/app/pick-service.ts）----
  private readonly pickSvc: PickService;

  // ---- 撤销（按当前文档隔离，实现在 src/app/undo-manager.ts）----
  private readonly undoMgr: UndoManager;
  /**
   * 重建代号：用于丢弃**过期**的异步重建结果。
   * `rebuild()` 等待几何内核（worker）期间，用户可能再次触发重建，或切换文档
   * （`activateEntry` 也会重建）。若不加代号，先发起但后返回的旧结果会覆盖新状态——
   * 典型症状是「切到文档 B 却显示文档 A 的模型」。
   */
  private rebuildToken = 0;
  /**
   * 合并重建：同一动画帧内来自 `mutate` 的多次重建请求只向 Worker 实际发一次
   * （参数滑杆连拖会高频触发，否则 Worker 被数十次全量重放占满，主线程也随之反复重绘）。
   * 走 requestAnimationFrame 做 last-wins：保留最后一次的 fit 标志。撤销/文档切换等关键路径
   * 仍直接调 `rebuild()`（即时、带 await），不经过此合并。
   */
  private rebuildRafScheduled = false;
  private rebuildPendingFit = false;
  /** 待触发的合并重建句柄（用于被显式 rebuild() 取消，见 rebuild 开头） */
  private rebuildRafHandle = 0;
  private requestRebuild(opts: { fit?: boolean } = {}): void {
    this.rebuildPendingFit = this.rebuildPendingFit || !!opts.fit;
    if (this.rebuildRafScheduled) return;
    this.rebuildRafScheduled = true;
    const run = () => {
      this.rebuildRafScheduled = false;
      this.rebuildRafHandle = 0;
      const fit = this.rebuildPendingFit;
      this.rebuildPendingFit = false;
      void this.rebuild({ fit });
    };
    if (typeof requestAnimationFrame === 'function') this.rebuildRafHandle = requestAnimationFrame(run);
    else run();
  }

  // ---- 多文档（SolidWorks 文档标签栏）----
  /** 已打开的文档（第一个是初始零件） */
  documents: DocumentEntry[] = [];
  /** 当前文档 id */
  activeDocId = '';
  private docSeq = 0;

  status: StatusInfo = { text: '就绪', kind: 'ok' };

  // ---- 参数化（表达式，参考 FreeCAD Expressions；实现在 src/app/param-service.ts）----
  private readonly paramSvc: ParamService;

  // ---- 文件（导出/保存/打开/导入；实现在 src/app/file-service.ts）----
  private readonly fileSvc: FileService;

  // ---- 内核（Web Worker，主线程只持有可序列化结果） ----
  /** 参数化模型的可序列化结果（来自 Worker） */
  model: ModelResult | null = null;
  /** 导入 STEP 的可序列化结果（来自 Worker） */
  importedModel: ModelResult | null = null;
  /** 几何内核是否就绪 */
  kernelReady = false;

  private listeners = new Map<AppEvent, Set<() => void>>();

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

    // 拾取交互服务：视口射线/画布矩形、草图编辑态回调、选择落地（SelectionStore
    // 互斥不变量 + 高亮/显示层/事件副作用）等宿主能力全部经闭包注入
    this.pickSvc = new PickService({
      shapeView: () => this.shapeView,
      rayFromScreen: (x, y) => this.viewport.rayFromScreen(x, y),
      worldToScreen: (p) => this.viewport.worldToScreen(p),
      canvasRect: () => {
        const d = this.viewport.renderer.domElement;
        const r = d.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, clientHeight: d.clientHeight };
      },
      camera: () => this.viewport.camera,
      sceneRoot: () => this.viewport.root,
      invalidate: () => this.viewport.invalidate(),
      assembly: () => this.assembly,
      mode: () => this.mode,
      selectionFilter: () => this.selectionFilter,
      faceBodyIndex: (fi) => {
        const m = this.currentModel();
        return m?.mesh.faceMetas[fi]?.bodyIndex ?? -1;
      },
      mateRefLabel: (ref) => mateRefLabel(ref),
      applyGeomSelection: (kind, index, additive) => this.applyGeomSelection(kind, index, additive),
      clearSelection: () => this.clearSelection(),
      selectFeature: (id) => this.selectFeature(id),
      setStatus: (text, kind, detail) => this.setStatus(text, kind, detail),
      emit: (...evts) => this.emit(...evts),
      sketchDisplayPlane: () => this.sketch.displayPlane,
      sketchPickDisplay: (ray, tol) => this.sketch.pickDisplay(ray, tol),
      sketchHandleDown: (x, y) => this.sketch.handleDown(x, y),
      sketchHandleMove: (x, y) => this.sketch.handleMove(x, y),
      sketchHandleUp: () => this.sketch.handleUp(),
      sketchFinishBSpline: () => this.sketch.finishBSpline(),
      isSketchMode: () => this.mode === 'sketch',
      onCanvasClickHook: (x, y, additive) => this.onCanvasClick?.(x, y, additive) ?? false,
    });

    // 工程图服务：子文档随条目切换（setDrawing），标注会话状态（dimMode/lastDimRun）
    // 收在服务内；SVG→PNG 光栅化与下载是 DOM 能力，经宿主闭包注入
    this.drawSvc = new DrawingService({
      currentModel: () => this.currentModel(),
      unitSystem: () => this.unitSystem,
      drawingScale: () => this.drawingScale,
      hasModel: () => this.hasModel,
      assembly: () => this.assembly,
      featureCount: () => this.doc.features.length,
      emit: (...evts) => this.emit(...evts),
      // 工程图的写操作也要压撤销栈：不接这条通路，标注/视图生成全绕过 undo，
      // Ctrl+Z 会转而回退零件文档（用户看不到变化，模型却被改了）。
      mutate: (fn, opts) => this.mutate(fn, opts),
      setStatus: (text, kind, detail) => this.setStatus(text, kind, detail),
      toast: (kind, msg) => (kind === 'ok' ? notify.ok(msg) : kind === 'err' ? notify.err(msg) : notify.info(msg)),
      rasterizePNG: (svg, w, h, scale) =>
        new Promise<ArrayBuffer>((resolve, reject) => {
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
                b.arrayBuffer().then((buf) => resolve(buf));
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
        }),
      download: (content, filename, mime) => download(content, filename, mime),
    });

    // 撤销管理器：宿主回调均为闭包（构造时 this.doc 等字段已初始化）
    this.undoMgr = new UndoManager({
      // 快照 = 零件文档 + 装配体 + 工程图。三者都是独立子对象，只存 doc 会让
      // 「插入组件 / 添加配合 / 标注尺寸」完全不可撤销，且 Ctrl+Z 会静默回退零件文档
      // （用户看不到变化，模型却被改了）。三者都是纯数据，视图/网格是缓存，恢复后重建。
      snapshot: () => ({
        doc: this.doc.toJSON(),
        asm: this.assembly ? this.assembly.toJSON() : null,
        dwg: this.drawing ? this.drawing.toJSON() : null,
      }),
      restore: (data) => {
        // 兼容「只有 doc」的旧形态快照（同一次会话内不会混用，防御性处理）
        const rec = (data ?? null) as { doc?: unknown; asm?: unknown; dwg?: unknown } | null;
        const docJSON = rec && typeof rec === 'object' && 'doc' in rec ? rec.doc : data;
        this.doc = CadDocument.fromJSON(docJSON);
        this.activeDoc().doc = this.doc;
        const asmJSON = rec && typeof rec === 'object' && 'asm' in rec ? rec.asm : null;
        // 换实例前先丢弃旧实例的视图：否则旧 ShapeView 留在场景里且再无引用可 dispose（泄漏）
        this.assembly?.disposeViews();
        this.assembly = asmJSON ? Assembly.fromJSON(asmJSON) : null;
        this.activeDoc().assembly = this.assembly;
        const dwgJSON = rec && typeof rec === 'object' && 'dwg' in rec ? rec.dwg : null;
        // 工程图走 setter → DrawingService.setDrawing，顺带清掉 lastDimRun（旧边引用对新图无意义）
        this.drawing = dwgJSON ? Drawing.fromJSON(dwgJSON) : null;
        this.activeDoc().drawing = this.drawing;
      },
      afterRestore: async () => {
        this.pruneFeatureUiState();
        await this.rebuild();
        // 装配体：撤销后视图与网格全部失效（fromJSON 的 view 为 null）→ 重新向内核要。
        // 快照里 asm 为 null 时（该步操作发生在装配体创建之前）需按当前模式补建，
        // 否则装配模式下 `this.assembly` 变 null、树/视口无处取值。
        if (this.mode === 'assembly') {
          this.ensureModeObjects();
          this.applyModeVisibility();
          if (this.assembly) await this.syncAssemblyScene();
        }
        // 工程图是纯 SVG 重绘（不重建几何），但 `rebuild` 只广播 change/tree/props/params
        // → 不补这一条，撤销工程图操作后数据已复原而画面停在旧图（数据断言全绿也看不出来）。
        // 无条件发：撤销也可能把 drawing 从有变无，宿主需要重绘成「没有工程图视图」。
        this.emit('drawing');
      },
      rebuild: (opts) => this.requestRebuild(opts),
      emit: (...evts) => this.emit(...evts),
      info: (msg) => notify.info(msg),
    });

    // 表达式/参数服务：文档每次现取（切文档/撤销后引用会变）
    this.paramSvc = new ParamService({
      getDoc: () => this.doc,
      mutate: (fn, opts) => this.mutate(fn, opts),
    });

    // 文件服务：内核 Worker 与 DOM 能力（下载/选文件）经宿主闭包注入
    this.fileSvc = new FileService({
      hasModel: () => this.hasModel,
      resolvedFeatures: () => this.resolvedFeatures(),
      // 项目文件 = 信封 {format, version, doc, assembly, drawing}。
      // 只存 doc 会让「装配体 / 工程图保存后再打开就没了」（组件、配合、视图、
      // 全部尺寸标注、明细表全丢）——真实数据丢失。
      projectJSON: () =>
        JSON.stringify(
          {
            format: 'solid2-project',
            version: 4,
            doc: this.doc.toJSON(),
            assembly: this.assembly ? this.assembly.toJSON() : null,
            drawing: this.drawing ? this.drawing.toJSON() : null,
          },
          null,
          2
        ),
      loadDocument: (data) => {
        // 兼容两种输入：项目信封 与 早期的裸文档 JSON
        const rec = (data ?? null) as { format?: string; doc?: unknown; assembly?: unknown; drawing?: unknown } | null;
        const isProject = !!rec && rec.format === 'solid2-project' && !!rec.doc;
        const docJSON = isProject ? rec!.doc : data;
        const asmJSON = isProject ? rec!.assembly : null;
        const dwgJSON = isProject ? rec!.drawing : null;
        // 裸 JSON 必须是文档形态：`fromJSON` 对垃圾输入会**静默返回空文档**，
        // 不加这道校验，「打开」一个随便的 JSON 会把当前模型清空（只有撤销能救）。
        if (!isProject) {
          const bare = docJSON as { features?: unknown } | null;
          if (!bare || !Array.isArray(bare.features)) throw new Error('不是 Solid2 项目文件');
        }
        this.mutate(() => {
          this.doc = CadDocument.fromJSON(docJSON);
          this.assembly?.disposeViews(); // 旧装配体视图随文档一起丢弃（防泄漏）
          this.assembly = asmJSON ? Assembly.fromJSON(asmJSON) : null;
          // 工程图随项目一起恢复（此前恒为 null → 保存再打开，视图/标注/明细表全丢）
          this.drawing = dwgJSON ? Drawing.fromJSON(dwgJSON) : null;
          // 子文档对象全部换新引用，必须同步回条目，否则切文档回来还是旧值
          this.activeDoc().doc = this.doc;
          this.activeDoc().assembly = this.assembly;
          this.activeDoc().drawing = this.drawing;
          // 整体换文档：旧文档的选中特征/草图 id 在新文档不存在，剪除悬空引用
          // （与 loadFeatures/removeFeature 的清理路径一致）
          this.pruneFeatureUiState();
          // 表达式求值缓存属于旧文档，必须丢弃（同 activateEntry）
          this.paramSvc.reset();
        }, { fit: true });
        // 打开后按当前模式补齐子对象；装配体视图是缓存，必须重新向内核要网格
        this.ensureModeObjects();
        this.applyModeVisibility();
        if (this.mode === 'assembly' && this.assembly) void this.syncAssemblyScene();
        this.emit('tree', 'props', 'docs', 'drawing');
      },
      syncEntry: () => this.syncActiveEntry(),
      setImportedModel: (model) => {
        this.importedModel = model;
        this.model = null; // 导入体优先于参数化模型
        this.syncActiveEntry();
      },
      showImportedMesh: (mesh, bbox) => {
        const sv = new ShapeView(mesh, { style: this.displayStyle, bodyColor: this.appearanceHex });
        if (this.shapeView) {
          this.shapeView.group.removeFromParent();
          this.shapeView.dispose();
        }
        this.shapeView = sv;
        this.viewport.root.add(sv.group);
        this.viewport.zoomFit(bbox);
        this.applyModeVisibility();
        this.viewport.invalidate();
      },
      exportStep: (features) => kernel.exportStep(features),
      tessellate: (features) => kernel.tessellate(features, 0.06, 0.2),
      importStep: (bytes) => kernel.importStep(bytes),
      download: (content, filename, mime) => download(content, filename, mime),
      pickText: async (accept) => {
        const f = await pickFile(accept);
        return f ? { name: f.name, text: await f.text() } : null;
      },
      pickBinary: async (accept) => {
        const f = await pickFile(accept);
        return f ? { name: f.name, buffer: await readFileAsArrayBuffer(f) } : null;
      },
      toast: (kind, msg) => (kind === 'ok' ? notify.ok(msg) : notify.err(msg)),
    });

    this.viewport.start();
    // 指针事件绑定在 PickService（宿主回调注入；见构造函数 pickSvc）
    this.pickSvc.bindPointer(this.viewport.renderer.domElement);
    // 键盘热键由 ../app/hotkeys 统一注册（SolidWorks 键位表）

    // 初始文档（零件1）
    const first: DocumentEntry = {
      id: this.nextDocId(),
      name: '零件1',
      kind: 'model',
      doc: this.doc,
      model: null,
      imported: null,
      assembly: null,
      drawing: null,
      undo: [],
      redo: [],
      view: null,
    };
    this.documents.push(first);
    this.activeDocId = first.id;
    // 初始条目与撤销管理器共享同一对栈（切文档时按引用交换）
    this.undoMgr.useStacks(first.undo, first.redo);
  }

  private nextDocId(): string {
    return `doc${++this.docSeq}`;
  }

  private kindName(kind: DocumentEntry['kind']): string {
    return kind === 'assembly' ? '装配体' : kind === 'drawing' ? '工程图' : '零件';
  }

  /** 当前文档条目 */
  activeDoc(): DocumentEntry {
    return this.documents.find((d) => d.id === this.activeDocId) ?? this.documents[0];
  }

  /**
   * 新建文档（SolidWorks Ctrl+N / 标签栏「+」）：
   * 保存当前条目状态，压入新条目并切换过去。
   */
  newDocument(kind: DocumentEntry['kind'] = 'model'): void {
    this.syncActiveEntry();
    if (this.mode === 'sketch') this.exitSketch(false);
    const entry: DocumentEntry = {
      id: this.nextDocId(),
      name: `${this.kindName(kind)}${this.documents.length + 1}`,
      kind,
      doc: new CadDocument(),
      model: null,
      imported: null,
      assembly: null,
      drawing: null,
      undo: [],
      redo: [],
      view: null,
    };
    this.documents.push(entry);
    this.activateEntry(entry);
    notify.ok(`已新建「${entry.name}」`);
  }

  /** 切换到指定文档 */
  activateDocument(id: string): void {
    const entry = this.documents.find((d) => d.id === id);
    if (!entry || entry.id === this.activeDocId) return;
    this.syncActiveEntry();
    if (this.mode === 'sketch') this.exitSketch(false);
    this.activateEntry(entry);
  }

  /** 关闭文档（右键标签）；最后一个文档不允许关闭 */
  closeDocument(id: string): void {
    if (this.documents.length <= 1) {
      notify.info('至少保留一个文档');
      return;
    }
    const idx = this.documents.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const closing = this.documents[idx];
    if (closing.id === this.activeDocId) {
      const next = this.documents[idx + 1] ?? this.documents[idx - 1];
      this.documents.splice(idx, 1);
      this.activateEntry(next);
    } else {
      this.documents.splice(idx, 1);
      this.emit('docs');
    }
  }

  /**
   * 关闭**当前**文档（窗口 > 关闭文档）。
   *
   * 此前该菜单项曾误接「清空当前文档」语义（多标签下会丢数据）；
   * 关闭文档与清空文档是两回事，这里委托给 `closeDocument`（含「至少保留一个」保护）。
   */
  closeActiveDocument(): void {
    this.closeDocument(this.activeDocId);
  }

  /** 把当前 doc/model/undo 栈写回当前条目（切换前调用） */
  private syncActiveEntry(): void {
    const e = this.activeDoc();
    e.doc = this.doc;
    e.model = this.model;
    e.imported = this.importedModel;
    e.assembly = this.assembly;
    e.drawing = this.drawing;
    const stacks = this.undoMgr.stacks;
    e.undo = stacks.undo;
    e.redo = stacks.redo;
    e.view = this.viewport.cameraSnapshot();
  }

  /** 激活条目：换引用 + 刷新一切依赖文档的 UI */
  private activateEntry(entry: DocumentEntry): void {
    closePropertyManager(); // PM 引用旧文档上下文，先关
    closeAllPopups(); // 弹出菜单同样是旧文档上下文（如「显示样式」勾选态）
    this.doc = entry.doc;
    this.model = entry.model;
    this.importedModel = entry.imported;
    this.assembly = entry.assembly;
    this.drawing = entry.drawing; // setter → drawSvc.setDrawing（同步清标注会话 lastDimRun）
    this.undoMgr.useStacks(entry.undo, entry.redo);
    // 表达式求值缓存属于上一份文档（`paramRows()` 命中 `lastResolve` 就直接复用）：
    // 不 reset 会拿旧文档的参数值配新文档的参数名，参数表显示错值。
    this.paramSvc.reset();
    this.activeDocId = entry.id;
    this.sel.reset(); // 切文档：选中态整体重置（含特征/几何/草图），避免跨文档残留
    this.clearSelection();
    // 同 kind 直切（装配→装配、工程图→工程图）时 setMode 会早退，
    // 其内部的服务状态清理（标注会话/装配拾取）与 ensure 路径必须手工补齐，
    // 否则会读到旧文档的组件 id 残留、新条目的 assembly/drawing 还是 null。
    if (this.mode !== entry.kind) {
      this.setMode(entry.kind);
    } else {
      this.drawSvc.exitDimensionMode();
      this.pickSvc.assignPicks([]);
      this.pickSvc.syncAssemblyPickMarkers();
      this.ensureModeObjects();
    }
    this.viewport.restoreCamera(entry.view);
    this.rebuildModel();
    this.emit('docs', 'change', 'tree', 'props', 'selection');
  }

  /** 当前用于显示的可序列化模型（参数化优先，其次导入） */
  currentModel(): ModelResult | null {
    return this.model ?? this.importedModel;
  }

  get hasModel(): boolean {
    return !!this.currentModel();
  }

  get canUndo(): boolean {
    // 草图编辑态：可撤销性由草图内部历史决定（见 SketchController.canUndo）
    if (this.mode === 'sketch' && this.editingSketch) return this.sketch.canUndo;
    return this.undoMgr.canUndo;
  }

  get canRedo(): boolean {
    if (this.mode === 'sketch' && this.editingSketch) return this.sketch.canRedo;
    return this.undoMgr.canRedo;
  }

  /** 当前文档撤销栈深度（诊断/测试用；UI 可用性判断请用 canUndo） */
  get undoDepth(): number {
    return this.undoMgr.stacks.undo.length;
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
    this.applyFeatureSelection(id);
    // SolidWorks: 模型态点选草图即选中该草图，后续特征默认绑定它
    if (id && !this.sel.isEditingSketch) {
      const f = this.doc.getFeature(id);
      if (f && f.type === 'sketch') this.sel.setActiveSketch(f.id);
    }
    this.emit('feature', 'props');
  }

  /**
   * 设置「当前选中特征」并同步图形区显示态草图的高亮。
   *
   * SolidWorks：特征选择与几何（面/边/点）选择互斥——选中特征即取消几何选择，反之亦然。
   * 退出草图后该草图即为当前选中特征（高亮显示）；此后点选面/边或点空白处都应取消它。
   * 互斥不变量本身由 `SelectionStore.selectFeature` 保证，这里只负责**副作用**：
   * 把选中态同步到草图显示层。
   */
  private applyFeatureSelection(id: string | null): void {
    this.sel.selectFeature(id);
    this.syncSketchDisplaySelection();
  }

  /** 把「特征选中」同步到图形区显示态草图的选中高亮（编辑态由覆盖层自行管理） */
  private syncSketchDisplaySelection(): void {
    if (this.sel.isEditingSketch) return;
    const id = this.sel.featureId;
    this.sketch.setDisplaySelected(!!id && id === this.sketch.displaySketch?.id);
  }

  /** 设置选择过滤器（SolidWorks 状态栏 Filter） */
  setSelectionFilter(f: SelectionFilter): void {
    this.sel.setSelectionFilter(f);
    this.emit('selection', 'props');
  }

  /** 设置单位制（SolidWorks 工具 > 选项 > 文档属性 > 单位） */
  setUnitSystem(sys: UnitSystem): void {
    if (!isUnitSystem(sys) || sys === this.unitSystem) return;
    this.unitSystem = sys;
    try {
      localStorage.setItem('solid2.units', sys);
    } catch { /* 忽略 */ }
    this.emit('units', 'view', 'drawing');
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

  /** RealView 图形（Heads-up 按钮，SolidWorks 同名显示效果） */
  setRealView(on: boolean): void {
    this.realView = on;
    this.viewport.setRealView(on);
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
  modelSummary(): { faces: number; edges: number; solids: number; surfaces: number } {
    const s = this.currentModel()?.stats;
    return s
      ? { faces: s.faces, edges: s.edges, solids: s.solids, surfaces: s.surfaces ?? 0 }
      : { faces: 0, edges: 0, solids: 0, surfaces: 0 };
  }

  // ============================================================
  // 文档与视图
  // ============================================================
  /**
   * 统一的「写文档」入口（委托 `undo-manager.ts` 的 UndoManager）：
   * 压撤销栈 → 执行改动 → 重建 →（可选）广播事件。
   *
   * 把所有会改文档的操作收敛到这里，「压栈」不再依赖调用点自觉：
   * `mutate(() => this.doc.setParam(...), { emit: ['params'] })`
   *
   * @param fn         具体的文档改动（在压栈之后、重建之前执行）
   * @param opts.fit   重建后是否适配视图
   * @param opts.emit  重建后广播的事件（重建本身已广播 change/tree/props/params）
   * @param opts.rebuild 传 `false` 跳过重建（调用方自行处理后续）
   */
  mutate(fn: () => void, opts: MutateOpts = {}): void {
    this.undoMgr.mutate(fn, opts);
  }

  /**
   * 清理指向「已不存在特征」的 UI 状态（悬空引用）。
   *
   * 撤销 / 重做 / 整体替换特征列表后必须调用：`selectedFeatureId` 或
   * `activeSketchFeature` 若指向已被删除的特征，会让设计树高亮、属性面板、
   * 以及后续特征对话框的默认草图与文档不一致。与 `removeFeature` 同一类问题
   * ——设了状态就要想清楚何时清除。
   */
  private pruneFeatureUiState(): void {
    const exists = (id: string): boolean => !!this.doc.getFeature(id);
    if (this.sel.prune(exists)) this.syncSketchDisplaySelection();
  }

  async undo(): Promise<void> {
    // 草图编辑态：撤销的是**草图内部**操作（SolidWorks 语义），不能走文档级撤销——
    // 文档级撤销会整体替换 doc，而 editingSketch 仍指向旧 doc 的特征对象，导致
    // 草图编辑器与文档脱节（画线后 Ctrl+Z 毫无反应，模型却回退了）。
    if (this.mode === 'sketch' && this.editingSketch) {
      if (this.sketch.undo()) this.setStatus('已撤销草图操作', 'ok');
      else notify.info('没有可撤销的草图操作');
      return;
    }
    await this.undoMgr.undo();
  }

  async redo(): Promise<void> {
    if (this.mode === 'sketch' && this.editingSketch) {
      if (this.sketch.redo()) this.setStatus('已重做草图操作', 'ok');
      else notify.info('没有可重做的草图操作');
      return;
    }
    await this.undoMgr.redo();
  }

  // ============================================================
  // 参数化：表达式解析（委托 src/app/param-service.ts 的 ParamService）
  // ============================================================
  /** 参数名 → 数值（最近一次表达式解析；表达式对话框 / 冒烟测试读） */
  get paramValues(): Record<string, number> {
    return this.paramSvc.values;
  }

  /** 表达式问题列表（状态栏计数 / 冒烟测试读） */
  get expressionIssues(): ExprIssue[] {
    return this.paramSvc.issues;
  }

  /**
   * 求值全部表达式，返回**已把数值替换为具体值**的特征副本。
   * 所有发给内核的操作都必须用它——内核只认具体数值，不认表达式。
   */
  resolvedFeatures(): Feature[] {
    return this.paramSvc.resolvedFeatures();
  }

  /** 全局参数行（供参数表 UI） */
  paramRows(): { name: string; expr: string; comment?: string; value?: number; error?: string }[] {
    return this.paramSvc.paramRows();
  }

  setParam(name: string, expr: string, comment?: string): void {
    this.paramSvc.setParam(name, expr, comment);
  }

  removeParam(name: string): void {
    this.paramSvc.removeParam(name);
  }

  /** 列出某个特征的数值参数（供表达式对话框选择） */
  featureNumericParams(id: FeatureId): { path: string; label: string; value: number }[] {
    return this.paramSvc.featureNumericParams(id);
  }

  /** 某个特征已绑定的表达式（含计算值与错误） */
  featureExpressionRows(id: FeatureId): { path: string; label: string; expr: string; value?: number; error?: string }[] {
    return this.paramSvc.featureExpressionRows(id);
  }

  /** 给某个特征的某个参数绑定表达式 */
  setFeatureExpression(id: FeatureId, path: string, expr: string): void {
    this.paramSvc.setFeatureExpression(id, path, expr);
  }

  removeFeatureExpression(id: FeatureId, path: string): void {
    this.paramSvc.removeFeatureExpression(id, path);
  }

  /** 预览一条表达式（不改动文档） */
  previewExpr(src: string): { ok: boolean; value?: number; message?: string } {
    return this.paramSvc.previewExpr(src);
  }

  /** 供对话框拼引用用的「特征名.属性」候选 */
  referenceCandidates(): { ref: string; label: string }[] {
    return this.paramSvc.referenceCandidates();
  }

  // ============================================================
  // 重建（内核 Worker）
  // ============================================================
  /** 重建模型并刷新视图（异步，几何在内核 Worker 里算） */
  async rebuild(options: { fit?: boolean } = {}): Promise<void> {
    // 显式重建（可 await）优先：取消任何尚未触发的「合并重建」rAF。
    // 否则 mutate → requestRebuild 排队的 rAF 会在本次重建 await 期间触发，发起一个
    // **代号更新**的重建，使本次结果被判过期丢弃——调用方 await 后读到的仍是旧模型
    // （典型症状：loadFeatures/setFeatures + await app.rebuild() 后体积是上一次的值）。
    if (this.rebuildRafScheduled) {
      if (typeof cancelAnimationFrame === 'function' && this.rebuildRafHandle) cancelAnimationFrame(this.rebuildRafHandle);
      this.rebuildRafScheduled = false;
      this.rebuildRafHandle = 0;
      this.rebuildPendingFit = false;
    }
    // 并发保护：捕获发起时的代号与所属文档条目，返回后若已过期则丢弃（见 rebuildToken 注释）
    const token = ++this.rebuildToken;
    const entry = this.activeDoc();
    const doc = this.doc;
    this.setStatus('正在重建…', 'busy');
    try {
      const model = await kernel.rebuild(this.resolvedFeatures());
      // 期间又发起了重建（连续操作 / 切换了文档）→ 本次结果已过期，丢弃
      if (token !== this.rebuildToken) return;
      this.model = model;
      this.importedModel = null; // 参数化模型优先于导入体
      entry.model = model; // 多文档：重建结果跟随**发起时**的条目（切回无需再算）
      doc.rebuildCount++;
      // 把内核侧的错误回写到特征（供 UI 标红）
      const errMap = new Map(model.errors.map((e) => [e.id, e.message]));
      // 表达式错误优先展示（更贴近用户输入）
      for (const fi of this.paramSvc.featureIssues) errMap.set(fi.id, fi.message);
      for (const f of doc.features) f.error = errMap.get(f.id);
      this.syncView(options.fit ?? false);
      const errs = model.errors;
      if (errs.length) {
        this.setStatus(`${errs.length} 个特征有错误`, 'err', errs[0].message);
      } else {
        const st = model.stats;
        const ex = this.paramSvc.issues.length;
        this.setStatus(
          `重建完成 ${model.rebuildMs.toFixed(0)}ms`,
          ex ? 'err' : 'ok',
          `${st.faces} 面 · ${st.edges} 边 · 体积 ${st.volume.toFixed(2)} mm³${ex ? ` · ${ex} 处表达式问题` : ''}`
        );
      }
      this.emit('change', 'tree', 'props', 'params');
    } catch (e) {
      if (token !== this.rebuildToken) return; // 过期失败同样忽略（避免误报旧文档的错误）
      this.setStatus(`重建失败：${(e as Error).message}`, 'err');
      notify.err(`重建失败：${(e as Error).message}`);
    }
  }

  /** 把当前可序列化模型同步到三维场景 */
  syncView(fit = false): void {
    const old = this.shapeView;
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
    this.sel.clearGeometry();
    this.refreshHighlight();
    if (fit) {
      this.viewport.zoomFit(m?.bbox ?? null);
    }
    this.applyModeVisibility();
    this.refreshSketchDisplay();
    this.viewport.invalidate();
    this.emit('selection');
  }

  /**
   * 模型态下保持最后草图可见（SolidWorks: 退出草图后草图仍显示，可据此创建特征）。
   * 编辑态由 `SketchController.attach()` 全权管理，这里不插手。
   */
  refreshSketchDisplay(): void {
    const ctl = this.sketch;
    if (this.editingSketch) return;
    const sk = this.doc.sketchFeatures();
    const last = sk.length ? sk[sk.length - 1] : null;
    if (!last) {
      ctl.detach();
      return;
    }
    ctl.showDisplay(last);
    // 该草图是「当前选中」的特征时，图形区以选中高亮显示（SolidWorks: 退出后草图被选中）
    this.syncSketchDisplaySelection();
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
    this.sel.clearGeometry();
    this.applyFeatureSelection(null); // 取消特征选中（含退出草图后残留的草图高亮）
    this.refreshHighlight();
    this.emit('selection', 'props');
  }

  /** 选中一个面（委托 PickService；落地路径见 applyGeomSelection） */
  selectFace(index: number, additive = false): void {
    this.pickSvc.selectFace(index, additive);
  }

  /** 选中一条边 */
  selectEdge(index: number, additive = false): void {
    this.pickSvc.selectEdge(index, additive);
  }

  /** 选中一个网格顶点（选择过滤器为「顶点」时专用） */
  selectVertex(index: number, additive = false): void {
    this.pickSvc.selectVertex(index, additive);
  }

  /**
   * 几何选择的唯一落地路径（selectXxx 经 PickService 回调到这里）。
   *
   * 过滤器拒绝时 `SelectionStore.selectGeom` 返回 `false`，此处直接返回、不做任何改动。
   * 接受时互斥不变量已由 store 保证（清空特征选择），这里只补副作用：
   * 草图显示态高亮同步 + 重绘高亮 + 广播。
   */
  private applyGeomSelection(kind: GeomKind, index: number, additive: boolean): void {
    if (!this.sel.selectGeom(kind, index, additive)) return;
    this.syncSketchDisplaySelection();
    this.refreshHighlight();
    this.emit('selection', 'props');
  }

  /** 顶点拾取（屏幕空间就近原则，8px 内；委托 PickService） */
  pickVertex(x: number, y: number): number | null {
    return this.pickSvc.pickVertex(x, y);
  }

  refreshHighlight(): void {
    disposeGroupChildren(this.highlightGroup);
    const sv = this.shapeView;
    if (!sv) {
      // 清空高亮本身也是视觉变化，按需重绘下必须 invalidate（否则残留旧高亮）
      this.viewport.invalidate();
      return;
    }

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
    // 实体高亮：该实体的所有面用选中面同款半透明材质（选择过滤器为「实体」）
    if (this.selection.bodies.length) {
      const metas = this.currentModel()?.mesh.faceMetas ?? [];
      for (const bi of this.selection.bodies) {
        for (let fi = 0; fi < metas.length; fi++) {
          if ((metas[fi].bodyIndex ?? -1) !== bi) continue;
          const geo = sv.faceGeometry(fi);
          if (geo) this.highlightGroup.add(new THREE.Mesh(geo, faceMat));
        }
      }
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

  /** 选中顶点的世界坐标（供「成形到顶点」等需要点的特征使用） */
  selectedVertexPoints(): [number, number, number][] {
    const m = this.currentModel();
    if (!m) return [];
    const pos = new Float32Array(m.mesh.positions);
    const n = pos.length / 3;
    return this.selection.vertices.map((vi) => {
      const i = Math.min(Math.max(vi, 0), n - 1);
      return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as [number, number, number];
    });
  }

  // ============================================================
  // 指针交互（事件绑定 / 点击分发 / 拾取全部在 src/app/pick-service.ts）
  // ============================================================
  /** 外部画布点击钩子：草图态消费点击（返回 true 已处理）。由 PickService 经宿主回调读取。 */
  onCanvasClick: ((x: number, y: number, additive: boolean) => boolean) | null = null;

  // ============================================================
  // 装配体可视化拾取（配合参考拾取 + 3D 标记在 src/app/pick-service.ts）
  // ============================================================
  /** 清空装配拾取（对话框调用；会广播 change/props） */
  clearAssemblyPicks(): void {
    this.pickSvc.clearAssemblyPicks();
  }

  /** 选中一个实体（选择过滤器为「实体」时专用；经命中的面反查 bodyIndex） */
  selectBody(index: number, additive = false): void {
    this.pickSvc.selectBody(index, additive);
  }

  /** 命中的面所属实体下标（无归属信息时 -1） */
  bodyIndexOfFace(fi: number): number {
    return this.pickSvc.bodyIndexOfFace(fi);
  }

  /**
   * 枚举某个屏幕位置上「射线穿过」的所有候选面（按距离从近到远、去重）。
   * 供右键菜单「选择其他…」使用（SolidWorks 同名功能）。
   */
  pickCandidateFaces(sx: number, sy: number): number[] {
    return this.pickSvc.pickCandidateFaces(sx, sy);
  }

  // ============================================================
  // 模式切换
  // ============================================================
  setMode(mode: AppMode): void {
    if (this.mode === mode) return;
    // 切模式时先收起所有弹出菜单：菜单内容是按旧模式上下文生成的，
    // 留着会在新模式里变成点不动的「幽灵菜单」（且它挡住画布点击）。
    closeAllPopups();
    if (mode !== 'sketch' && this.editingSketch) this.exitSketch(false);
    this.mode = mode;
    // 离开工程图模式 → 取消标注会话（dimMode + lastDimRun 由 DrawingService 收口）
    if (mode !== 'drawing') this.drawSvc.exitDimensionMode();
    if (mode !== 'assembly') {
      this.assemblyPicks = [];
      this.pickSvc.syncAssemblyPickMarkers();
    }
    this.ensureModeObjects();
    this.applyModeVisibility();
    this.emit('mode', 'change', 'tree', 'props');
  }

  /** 进入/激活装配或工程图模式时确保其子对象就绪（setMode 与 activateEntry 共用） */
  private ensureModeObjects(): void {
    if (this.mode === 'assembly') {
      const a = this.ensureAssembly();
      if (!a.components.length && this.hasModel) {
        a.insertFromDocument(this.doc.clone(), '零件1');
      }
    }
    if (this.mode === 'drawing') {
      this.ensureDrawing();
      if (this.drawing && !this.drawing.views.length && this.hasModel) {
        // record:false —— 切模式触发的自动生成不是用户操作，不能压撤销栈
        this.generateDrawing(['front', 'top', 'right', 'iso'], { record: false });
      }
    }
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
    this.pickSvc.setPickGroupVisible(mode === 'assembly');
    const canvas = this.viewport.renderer.domElement;
    canvas.style.visibility = mode === 'drawing' ? 'hidden' : '';
    if (this.drawingHost) this.drawingHost.classList.toggle('hidden', mode !== 'drawing');
    this.viewport.setPlanesVisible(this.showPlanes && showModel);
    this.viewport.setGridVisible(this.showGrid && mode !== 'drawing');
    this.sketch.setDisplayVisible(mode === 'model');
    this.viewport.invalidate();
  }

  // ============================================================
  // 装配
  // ============================================================
  ensureAssembly(): Assembly {
    if (!this.assembly) this.assembly = new Assembly();
    return this.assembly;
  }

  /**
   * 装配体编辑的**唯一写入口**（与 `mutate` 之于零件文档同构）。
   *
   * 为什么必须收口：装配体是独立子对象，UI 里直接 `a.mates.push(...)` / `c.fixed = ...`
   * 再 `syncAssemblyScene()` 不压撤销栈 —— 「插入组件 / 删除组件 / 添加配合 / 固定 / 爆炸」
   * 全都不可撤销，而 Ctrl+Z 会转而回退**零件文档**（用户看不到任何变化，却悄悄改了模型）。
   *
   * 不重建零件模型（`rebuild: false`）：装配编辑只影响装配体，零件网格由
   * `syncAssemblyScene()` 按需向内核要。
   */
  editAssembly(fn: (a: Assembly) => void): void {
    const a = this.ensureAssembly();
    this.mutate(() => fn(a), { rebuild: false, emit: ['tree', 'props'] });
    void this.syncAssemblyScene();
  }

  async syncAssemblyScene(): Promise<void> {
    const a = this.assembly;
    if (!a) return;
    await a.syncScene(this.viewport.root, this.displayStyle);
    this.viewport.invalidate();
    this.emit('tree', 'props', 'change');
  }

  // ============================================================
  // 工程图（视图生成 / 标注会话 / BOM / PNG 导出在 src/app/drawing-service.ts）
  // ============================================================
  ensureDrawing(): Drawing {
    return this.drawSvc.ensureDrawing();
  }

  /** 生成标准三视图 + 等轴测（会先清空既有视图） */
  generateDrawing(
    kinds: ViewKind[] = ['front', 'top', 'right', 'iso'],
    opts: { record?: boolean } = {}
  ): void {
    this.drawSvc.generateDrawing(kinds, opts);
  }

  /** 追加单个视图并重排版 */
  addDrawingView(kind: ViewKind): void {
    this.drawSvc.addDrawingView(kind);
  }

  /** 切换隐藏线显示；返回切换后的值（无工程图为 null） */
  toggleDrawingHiddenLines(): boolean | null {
    return this.drawSvc.toggleHiddenLines();
  }

  /** 添加形位公差标注；视图不存在返回 false */
  addDrawingGdt(
    viewId: string,
    symbol: GdtSymbol,
    tol: number,
    opts: { datum?: string; diameter?: boolean; anchor?: [number, number] } = {}
  ): boolean {
    return this.drawSvc.addGdt(viewId, symbol, tol, opts);
  }

  /** 删除形位公差标注 */
  removeDrawingGdt(id: string): void {
    this.drawSvc.removeGdt(id);
  }

  /** 更新图纸属性（名称 / 图号 / 材料） */
  updateDrawingSheet(patch: Partial<SheetSpec>): void {
    this.drawSvc.updateSheet(patch);
  }

  /** 切换尺寸标注模式（点击工程图边线即标注） */
  toggleDimensionMode(): void {
    this.drawSvc.toggleDimensionMode();
  }

  /** 工程图边线被点击 → 添加尺寸标注 */
  placeDrawingDimension(viewId: string, runIdx: number, shift = false): void {
    this.drawSvc.placeDrawingDimension(viewId, runIdx, shift);
  }

  /** 删除某个尺寸标注（右键工程图标注） */
  removeDrawingDim(viewId: string, dimId: string): void {
    this.drawSvc.removeDrawingDim(viewId, dimId);
  }

  clearDrawingDims(): void {
    this.drawSvc.clearDrawingDims();
  }

  /** 自动标注：overall 标总宽/高，all 再标直线边 */
  autoDimensionDrawing(mode: 'overall' | 'all' = 'overall'): void {
    this.drawSvc.autoDimensionDrawing(mode);
  }

  /** 孔位自动标注：中心定位尺寸 + 正视圆的直径 */
  autoHoleDimensionDrawing(): void {
    this.drawSvc.autoHoleDimensionDrawing();
  }

  /** 应用标注元数据（公差 / φ 前缀） */
  applyDrawingDimMeta(
    viewId: string,
    dimId: string,
    meta: { tolerance?: { upper: number; lower: number }; prefix?: string }
  ): boolean {
    return this.drawSvc.applyDrawingDimMeta(viewId, dimId, meta);
  }

  /** 切换明细表：从装配体（按特征序列分组计数，数量联动）或当前零件生成 */
  toggleDrawingBOM(): void {
    this.drawSvc.toggleDrawingBOM();
  }

  /** 导出当前工程图为 PNG（宿主 canvas 光栅化 + 下载） */
  exportDrawingPNG(scale = 4): Promise<void> {
    return this.drawSvc.exportDrawingPNG(scale);
  }

  // ============================================================
  // 草图
  // ============================================================
  startSketch(plane: PlaneRef | SketchPlane): void {
    // 这里保持手写压栈（不走 mutate）：`doc.nextName` 会**递增名称计数器**，
    // 必须发生在压栈之后，否则撤销后计数器不回退。顺序敏感，故不套用 mutate。
    this.undoMgr.push();
    const f = newSketchFeature(typeof plane === 'string' ? plane : 'custom');
    if (typeof plane !== 'string') f.params.customPlane = plane;
    f.name = this.doc.nextName('sketch');
    this.doc.add(f);
    this.rebuild();
    this.enterSketch(f);
  }

  enterSketch(f: SketchFeature): void {
    closeAllPopups(); // 进入草图：收起模型态的弹出菜单
    this.sel.setEditingSketch(f.id); // 同时把它设为「当前草图」（后续特征默认绑定它）
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
    closePropertyManager(); // 草图 PropertyManager 随退出关闭
    const f = this.editingSketch;
    this.sel.setEditingSketch(null); // 退出草图编辑（只清编辑态，activeSketch 稍后按 kept 决定）
    this.sketchTool = null;
    this.pendingPoints = [];
    let kept = true;
    if (revert) {
      const sk = f.params.sketch;
      if (!sk.entities.length && !sk.constraints.length) {
        this.doc.remove(f.id);
        kept = false;
      }
    }
    this.mode = 'model';
    // SolidWorks: 退出后该草图处于「选中」状态——树高亮 + 图形区高亮 + 属性管理器显示，
    // 可直接继续创建拉伸等特征。空草图被丢弃时不选中任何特征。
    this.sel.setActiveSketch(kept ? f.id : null);
    this.applyFeatureSelection(kept ? f.id : null);
    this.rebuild();
    this.applyModeVisibility();
    this.emit('mode', 'change', 'props', 'feature');
    this.setStatus(
      '已退出草图，草图已保留',
      'ok',
      this.activeSketchFeature ? `已选中「${this.activeSketchFeature.name}」，可继续创建拉伸等特征` : undefined
    );
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

  /** 草图特征对应的基准面 */
  planeOfSketch(f: SketchFeature): SketchPlane {
    if (f.params.plane === 'custom' && f.params.customPlane) return f.params.customPlane;
    return { front: DEFAULT_PLANE, top: TOP_PLANE, right: RIGHT_PLANE }[f.params.plane as 'front' | 'top' | 'right'] ?? DEFAULT_PLANE;
  }

  get sketchPlane(): SketchPlane {
    const f = this.editingSketch;
    if (!f) return DEFAULT_PLANE;
    return this.planeOfSketch(f);
  }

  // ============================================================
  // 文件（委托 src/app/file-service.ts 的 FileService）
  // ============================================================
  async exportStep(): Promise<void> {
    await this.fileSvc.exportStep();
  }

  async exportStl(): Promise<void> {
    await this.fileSvc.exportStl();
  }

  async exportObj(): Promise<void> {
    await this.fileSvc.exportObj();
  }

  saveProject(): void {
    this.fileSvc.saveProject();
  }

  async openProject(): Promise<void> {
    await this.fileSvc.openProject();
  }

  async importStepFile(): Promise<void> {
    await this.fileSvc.importStepFile();
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
      const sys = this.unitSystem;
      tableModal(
        '质量属性',
        ['项目', '数值'],
        [
          ['体积', formatVolume(mp.volume, sys)],
          ['表面积', formatArea(mp.area, sys)],
          ['质心 X', formatLength(mp.centroid[0], sys)],
          ['质心 Y', formatLength(mp.centroid[1], sys)],
          ['质心 Z', formatLength(mp.centroid[2], sys)],
          ['包围盒 X', formatLength(bb.max[0] - bb.min[0], sys)],
          ['包围盒 Y', formatLength(bb.max[1] - bb.min[1], sys)],
          ['包围盒 Z', formatLength(bb.max[2] - bb.min[2], sys)],
          ['面数', String(st.faces)],
          ['边数', String(st.edges)],
        ],
        '体积与表面积由 OpenCASCADE 精确积分得到（非网格近似）。'
      );
    } catch (e) {
      notify.err(`计算失败：${(e as Error).message}`);
    }
  }

  /** 截面属性（SolidWorks 评估 → 截面属性，PropertyManager 实时重算） */
  showSectionProperties(): void {
    if (!this.hasModel) {
      notify.err('没有实体');
      return;
    }
    openSectionProperties(this);
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

  /** 当前视口布局（SolidWorks：视图 → 显示 → 视口） */
  get viewportLayout(): LayoutName {
    return this.viewport.layoutName;
  }

  /** 视口布局数量（1 = 单视图） */
  get viewportCount(): number {
    return this.viewport.cellCount;
  }

  /** 各视口格的视图名（前视/俯视/右视/等轴测） */
  viewportLabels(): string[] {
    return this.viewport.cellLabels();
  }

  /** 切换视口布局：单视图 / 水平双视图 / 垂直双视图 / 四视图 */
  setViewportLayout(name: LayoutName): void {
    this.viewport.setLayout(name);
    const def = LAYOUT_DEFS.find((d) => d.id === this.viewportLayout) ?? LAYOUT_DEFS[0];
    this.setStatus(`视口布局：${def.label}`, 'ok');
    this.emit('view');
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

  /**
   * Esc / Enter：退出当前命令 / 清除选择 / 退出草图。
   * `kind='confirm'` 对应确认角 ✓ 的 Enter 提示 —— 直接退出草图（不等第二次按键）。
   */
  escape(kind: 'esc' | 'confirm' = 'esc'): void {
    if (this.mode === 'sketch') {
      this.sketch.handleKey(new KeyboardEvent('keydown', { key: kind === 'confirm' ? 'Enter' : 'Escape' }));
      return;
    }
    // 活动命令优先于选中态：SolidWorks 里 Esc 先取消正在执行的命令（如工程图标注），
    // 命令取消完再按才清选中。此前顺序反了，选中着视图时 Esc 退不出标注命令。
    if (this.dimMode) {
      this.toggleDimensionMode();
      return;
    }
    // 选中态包含「几何选择」与「设计树特征选中」两种：只判 faces/edges 会让
    // 「在设计树选中一个特征后按 Esc」变成无反应（SolidWorks 里 Esc 一律清选中）。
    if (this.selection.faces.length || this.selection.edges.length || this.selectedFeatureId) {
      this.clearSelection();
      return;
    }
  }

  /** 重建并刷新视图（SolidWorks: Ctrl+B） */
  rebuildModel(): void {
    this.rebuild();
    this.emit('view');
  }

  /** 强制重建（SolidWorks: Ctrl+Q）—— 丢弃表达式缓存重新求值 */
  forceRebuild(): void {
    this.paramSvc.reset();
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

  addFeature(f: Feature, opts: { rebuild?: boolean } = {}): void {
    this.mutate(() => {
      this.doc.add(f);
      // SolidWorks: 新建的特征成为当前选中特征（据此创建时，被消耗的草图不再保持高亮）
      if (f.type !== 'sketch') this.applyFeatureSelection(f.id);
    }, { rebuild: opts.rebuild !== false, emit: opts.rebuild === false ? ['tree'] : undefined });
  }

  /**
   * 用一组特征替换（或追加到）当前文档 —— AI 建模助手的落地入口。
   * 与逐条 addFeature 的区别：只压一次撤销栈，且默认重建后自动适配视图。
   */
  loadFeatures(features: Feature[], opts: { replace?: boolean; fit?: boolean } = {}): void {
    if (!features.length) return;
    this.mutate(() => {
      if (opts.replace !== false) this.doc = new CadDocument();
      for (const f of features) this.doc.add(f);
      this.pruneFeatureUiState();
    }, { fit: opts.fit ?? true });
    this.syncActiveEntry();
    this.emit('tree', 'props');
  }

  /**
   * 用一组特征**整体替换**当前文档的特征列表 —— AI 编辑现有模型的落地入口。
   * 与 `loadFeatures` 的区别：原地改 `doc.features`，因此**保留全局参数与名称计数器**
   * （AI 编辑不该把用户定义好的参数表达式冲掉）。
   */
  setFeatures(features: Feature[], opts: { fit?: boolean } = {}): void {
    this.mutate(() => {
      const keep = this.doc.features;
      keep.length = 0;
      for (const f of features) keep.push(f);
      this.pruneFeatureUiState();
    }, { fit: opts.fit ?? true, emit: ['tree', 'props', 'params'] });
  }

  /** 当前模型的可序列化包围盒（AI 编辑追加特征时的落位基准） */
  currentBBox(): { min: [number, number, number]; max: [number, number, number] } | null {
    return this.currentModel()?.bbox ?? null;
  }

  removeFeature(id: FeatureId): void {
    this.mutate(() => {
      this.doc.remove(id);
      // 删除后统一剪除指向已删特征的 UI 状态（特征选中 / 当前草图），
      // 否则会留悬空引用：activeSketchFeature 悬空 → 后续特征对话框默认草图指向已删草图；
      // selectedFeatureId 悬空 → 设计树高亮 / 属性面板与文档不一致。
      // 不变量由 SelectionStore.prune 保证，无需在此逐字段判断。
      this.pruneFeatureUiState();
    });
  }

  /**
   * 压缩 / 解除压缩特征（设计树右键）。
   * 必须走 mutate：直接改 `f.suppressed` + rebuild 不进撤销栈，
   * 之后的 Ctrl+Z 会去弹更早的一次无关操作，视觉上像是「撤销没生效」。
   */
  toggleSuppress(id: FeatureId): void {
    const f = this.doc.getFeature(id);
    if (!f) return;
    this.mutate(() => {
      f.suppressed = !f.suppressed;
    });
  }

  /** 特征上移 / 下移（delta = -1 / +1），同样入撤销栈 */
  moveFeature(id: FeatureId, delta: number): void {
    if (!this.doc.getFeature(id)) return;
    this.mutate(() => this.doc.move(id, delta));
  }

  /** 重命名特征（入撤销栈；空名/同名直接忽略） */
  renameFeature(id: FeatureId, name: string): void {
    const f = this.doc.getFeature(id);
    const next = name.trim();
    if (!f || !next || next === f.name) return;
    this.mutate(() => {
      f.name = next;
    }, { rebuild: false, emit: ['tree', 'props'] });
  }

  updateFeatureParams(id: FeatureId, patch: FeatureParamsPatch): void {
    const f = this.doc.getFeature(id);
    if (!f) return;
    // 与 setParam / setFeatureExpression 一致：编辑特征参数必须入撤销栈。
    // 否则「改尺寸 → Ctrl+Z」不会回到旧值，而是弹掉更早的一次无关操作
    // （属性面板的 numberField 只在 change/blur 提交，不会逐键触发，故安全）。
    this.mutate(() => Object.assign(f.params as Record<string, unknown>, patch));
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
    this.sel.setGeometry({
      faces: m.mesh.faceMetas.map((_, i) => i),
      bodies: [],
      edges: [],
      vertices: [],
    });
    this.syncSketchDisplaySelection();
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
      ['单位系统', UNIT_BY_ID[this.unitSystem].label === 'MMGS' ? 'MMGS（毫米、克、秒）' : `${UNIT_BY_ID[this.unitSystem].label}（${UNIT_BY_ID[this.unitSystem].lenUnit}）`],
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
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
