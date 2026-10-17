/**
 * 选中态唯一真源（SelectionStore）。
 *
 * ## 为什么需要它
 *
 * 此前「选中」被拆成 4 个各自独立、靠手工同步的字段散落在 `App` 上：
 *   - `selectedFeatureId`   特征选中（设计树高亮 + 属性管理器 + 图形区草图高亮）
 *   - `activeSketchFeature` 当前草图（后续特征对话框的默认草图）
 *   - `editingSketch`       正在编辑的草图（草图模式）
 *   - `selection`           几何选中（面/边/点/实体的 mesh 下标）
 *
 * 它们之间有一条不变量：**特征选择与几何选择互斥**（SolidWorks 语义）。
 * 但这条不变量此前是靠 4 个方法里各写一句 `applyFeatureSelection(null)` 来维持的，
 * 于是同一个根因反复制造 bug：选中态粘住、removeFeature 悬空引用、
 * undo/redo 悬空引用、退出草图后未选中、selectAll 不清特征选中……
 *
 * 现在把这些状态收进本类，让不变量由**类型系统 + 单一入口**保证：
 *   - 选中特征  → 自动清空几何选择
 *   - 选中几何  → 自动清空特征选择
 *   - 特征一律以 **id** 存储，绝不持有 `Feature` 对象引用 → 撤销/重做替换整个
 *     `CadDocument` 后不可能出现悬空对象（旧的 `activeSketchFeature: SketchFeature`
 *     正是在这里出问题的）。
 *
 * ## 边界
 *
 * 纯状态机：不 import DOM / THREE / 事件总线。副作用（重绘高亮、emit 事件、
 * 同步草图显示层）由 `App` 在调用后自行处理，因此本类可在 Node 里直接单测。
 */

/** 几何选择：各类元素的 mesh 下标数组 */
export interface GeomSelection {
  faces: number[];
  edges: number[];
  vertices: number[];
  bodies: number[];
}

/** 几何选择的类别 */
export type GeomKind = 'face' | 'edge' | 'vertex' | 'body';

/**
 * 选择过滤器（SolidWorks 状态栏 Filter / F5）。
 * `'all'` 不过滤（默认，行为与未引入过滤器时一致）。
 */
export type SelectionFilter = 'all' | GeomKind;

const GEOM_KEY: Record<GeomKind, keyof GeomSelection> = {
  face: 'faces',
  edge: 'edges',
  vertex: 'vertices',
  body: 'bodies',
};

/** 过滤器 → 允许选择的类别 */
const FILTER_ALLOWS: Record<SelectionFilter, readonly GeomKind[]> = {
  all: ['face', 'edge', 'vertex', 'body'],
  face: ['face'],
  edge: ['edge'],
  vertex: ['vertex'],
  body: ['body'],
};

export function emptyGeomSelection(): GeomSelection {
  return { faces: [], edges: [], vertices: [], bodies: [] };
}

export class SelectionStore {
  /** 当前选中特征（设计树高亮 / 属性管理器 / 图形区草图高亮） */
  private feature: string | null = null;
  /** 当前草图：后续特征对话框的默认绑定目标 */
  private activeSketch: string | null = null;
  /** 正在编辑的草图（草图模式；非空即表示处于草图编辑态） */
  private editingSketch: string | null = null;
  private geom: GeomSelection = emptyGeomSelection();
  private filter: SelectionFilter = 'all';

  // ============================================================
  // 特征选择
  // ============================================================

  get featureId(): string | null {
    return this.feature;
  }

  /**
   * 选中特征。传 `null` 表示「只取消特征选中」（不清几何选择）——
   * 这是几何选择路径与清空路径共用的写法；传具体 id 时按 SW 语义
   * **同时清空几何选择**（二者互斥）。
   */
  selectFeature(id: string | null): void {
    this.feature = id;
    if (id !== null) this.geom = emptyGeomSelection();
  }

  // ============================================================
  // 草图（活动 / 编辑中）
  // ============================================================

  get activeSketchId(): string | null {
    return this.activeSketch;
  }

  setActiveSketch(id: string | null): void {
    this.activeSketch = id;
  }

  get editingSketchId(): string | null {
    return this.editingSketch;
  }

  /** 进入/退出草图编辑。进入时同时把它设为「当前草图」（后续特征默认绑定它）。 */
  setEditingSketch(id: string | null): void {
    this.editingSketch = id;
    if (id !== null) this.activeSketch = id;
  }

  get isEditingSketch(): boolean {
    return this.editingSketch !== null;
  }

  // ============================================================
  // 几何选择
  // ============================================================

  /** 几何选择的实时对象（调用方可直接读字段；**不要**直接写，写请走 selectGeom/setGeometry） */
  get geometry(): GeomSelection {
    return this.geom;
  }

  get hasGeometry(): boolean {
    const g = this.geom;
    return g.faces.length + g.edges.length + g.vertices.length + g.bodies.length > 0;
  }

  /** 几何选择元素总数 */
  get count(): number {
    const g = this.geom;
    return g.faces.length + g.edges.length + g.vertices.length + g.bodies.length;
  }

  get selectionFilter(): SelectionFilter {
    return this.filter;
  }

  setSelectionFilter(f: SelectionFilter): void {
    this.filter = f;
  }

  /** 当前过滤器是否允许选择某类几何 */
  allows(kind: GeomKind): boolean {
    return FILTER_ALLOWS[this.filter].includes(kind);
  }

  /**
   * 选中一个几何元素。
   *
   * - 被过滤器拒绝时**不做任何改动**并返回 `false`（调用方据此提前返回）；
   * - `additive=false` 时清空其它所有类别（统一语义：非叠加选择只保留本次点击）；
   * - `additive=true` 时在同类别内切换（已选则取消）；
   * - 任一成功的选择都会清空特征选择（互斥不变量）。
   *
   * @returns 是否被接受（`false` = 过滤器拒绝）
   */
  selectGeom(kind: GeomKind, index: number, additive: boolean): boolean {
    if (!this.allows(kind)) return false;
    this.feature = null;
    const key = GEOM_KEY[kind];
    if (!additive) {
      this.geom = emptyGeomSelection();
      this.geom[key] = [index];
      return true;
    }
    const arr = this.geom[key];
    const i = arr.indexOf(index);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(index);
    return true;
  }

  /** 整体替换几何选择（「全选」等批量入口）。按互斥不变量清空特征选择。 */
  setGeometry(geom: GeomSelection): void {
    this.feature = null;
    this.geom = {
      faces: [...geom.faces],
      edges: [...geom.edges],
      vertices: [...geom.vertices],
      bodies: [...geom.bodies],
    };
  }

  clearGeometry(): void {
    this.geom = emptyGeomSelection();
  }

  // ============================================================
  // 一致性维护
  // ============================================================

  /**
   * 剪除指向「已不存在的特征」的引用。
   *
   * 撤销 / 重做 / 删除特征 / 整体替换特征列表后必须调用——否则设计树高亮、
   * 属性面板、后续特征对话框的默认草图都会与文档不一致。
   *
   * @param exists 判定特征是否仍存在（由 App 用 `doc.getFeature` 提供）
   * @returns 是否有引用被清除（调用方据此决定要不要同步 UI 高亮）
   */
  prune(exists: (id: string) => boolean): boolean {
    let changed = false;
    if (this.feature !== null && !exists(this.feature)) {
      this.feature = null;
      changed = true;
    }
    if (this.activeSketch !== null && !exists(this.activeSketch)) {
      this.activeSketch = null;
      changed = true;
    }
    // editingSketch 理论上不该悬空（草图编辑态不会发生文档级撤销），
    // 但切换文档等路径可能留下，一并清理以防万一。
    if (this.editingSketch !== null && !exists(this.editingSketch)) {
      this.editingSketch = null;
      changed = true;
    }
    return changed;
  }

  /**
   * 重置全部选中态（切换文档 / 新建工程时调用）。
   *
   * 注意**不重置选择过滤器**——过滤器是工具设置（同显示样式），
   * 跨文档保留，不属于「选中态」。
   */
  reset(): void {
    this.feature = null;
    this.activeSketch = null;
    this.editingSketch = null;
    this.geom = emptyGeomSelection();
  }
}
