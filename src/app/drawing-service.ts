/**
 * 工程图领域服务（从 `App` 抽出的第 6 个领域服务）。
 *
 * ## 职责
 *
 * 工程图模式的全部命令与标注会话状态：
 *   - 视图生成（标准三视图 / 追加视图 / 布局）；
 *   - 交互式尺寸标注模式（dimMode 切换、单边长度 / Shift 双边距离、元数据、
 *     自动标注 / 孔位标注 / 清除）；
 *   - 明细表（BOM：装配体 bomEntries → 行，或零件兜底；切换生成/清除）；
 *   - PNG 导出（SVG 光栅化 + 下载）。
 *
 * ## 边界（与其它服务同构）
 *
 * 纯逻辑 + 宿主回调：本类**不 import DOM / 视口 / 内核**。SVG→PNG 的
 * canvas + Image 光栅化、文件下载、轻提示全部经宿主闭包注入
 * → 可在 Node 下单测（见 tools/drawing-service-test.ts；drawing.ts 本身
 * 无 DOM 依赖，测试里用真 `Drawing` + 手搭视图）。
 *
 * ⚠️ `Drawing` 子文档对象由本服务持有（多 DocumentEntry 各存一份，切换文档
 * 经 `setDrawing` 换引用），App 只做 `get/set drawing` 与 `get dimMode` 委托。
 */

import { Drawing, generateStandardViews, type ViewKind, type BomRow } from './drawing';
import type { AppEvent, StatusInfo } from './app';
import type { ModelResult } from '../core/kernel-types';
import type { UnitSystem } from '../core/units';
import type { Assembly } from './assembly';

/** 工程图命令需要的宿主能力（由 App 提供） */
export interface DrawingHost {
  /** 当前可序列化模型（生成视图用 mesh；无模型为 null） */
  currentModel(): ModelResult | null;
  /** 单位制（同步到 Drawing.unitSystem） */
  unitSystem(): UnitSystem;
  /** 固定比例（0 = 自动） */
  drawingScale(): number;
  /** 是否有模型（BOM 零件兜底守卫） */
  hasModel(): boolean;
  /** 当前装配体（BOM 来源之一） */
  assembly(): Assembly | null;
  /** 当前文档特征数（零件 BOM 命名） */
  featureCount(): number;
  /** 广播事件 */
  emit(...evts: AppEvent[]): void;
  /** 状态栏 */
  setStatus(text: string, kind: StatusInfo['kind'], detail?: string): void;
  /** 轻提示（info/ok/err 三态） */
  toast(kind: 'info' | 'ok' | 'err', msg: string): void;
  /** SVG → PNG 光栅化（宿主实现 DOM：blob URL + Image + canvas + toBlob） */
  rasterizePNG(svg: string, w: number, h: number, scale: number): Promise<ArrayBuffer>;
  /** 下载文件 */
  download(content: ArrayBuffer, filename: string, mime: string): void;
}

export class DrawingService {
  /** 当前文档的工程图子文档（多文档随条目切换；App.drawing 委托到这里） */
  private _drawing: Drawing | null = null;
  /** 尺寸标注模式：开启后点击工程图边线即标注 */
  private _dimMode = false;
  /** 上一次标注的边（`viewId:runIdx`），Shift+点击同视图另一条边 → 距离标注 */
  private lastDimRun: string | null = null;

  constructor(private readonly host: DrawingHost) {}

  // ---- 子文档与模式状态（App getter/setter 委托）----
  get drawing(): Drawing | null {
    return this._drawing;
  }
  setDrawing(d: Drawing | null): void {
    this._drawing = d;
    // 换文档（打开/切条目）：旧文档的「上次标注边」引用对新工程图无意义，必须清
    this.lastDimRun = null;
  }
  get dimMode(): boolean {
    return this._dimMode;
  }

  /** 取出（不存在则惰性创建）当前工程图 */
  ensureDrawing(): Drawing {
    if (!this._drawing) this._drawing = new Drawing();
    return this._drawing;
  }

  /**
   * 离开工程图模式时取消标注会话（setMode 调用）。
   * ⚠️ 与旧 App 行为一致：仅在开启中才动（含清 lastDimRun），未开启时空操作。
   */
  exitDimensionMode(): void {
    if (this._dimMode) {
      this._dimMode = false;
      this.lastDimRun = null;
    }
  }

  /** 生成标准三视图 + 等轴测（会先清空既有视图） */
  generateDrawing(kinds: ViewKind[] = ['front', 'top', 'right', 'iso']): void {
    const m = this.host.currentModel();
    if (!m) {
      this.host.toast('err', '没有可生成工程图的实体');
      return;
    }
    const d = this.ensureDrawing();
    d.unitSystem = this.host.unitSystem();
    generateStandardViews(d, m.mesh, kinds);
    // 视图整体重建（viewId 重新编号）：旧的「上次标注边」不再可解释，清
    this.lastDimRun = null;
    const scale = this.host.drawingScale();
    if (scale) d.fixedScale = scale;
    this.host.emit('drawing', 'tree');
  }

  /** 追加单个视图并重排版 */
  addDrawingView(kind: ViewKind): void {
    const m = this.host.currentModel();
    if (!m) {
      this.host.toast('err', '没有可生成工程图的实体');
      return;
    }
    const d = this.ensureDrawing();
    d.unitSystem = this.host.unitSystem();
    d.addView(kind, m.mesh, this.host.drawingScale());
    d.layout();
    this.host.emit('drawing', 'tree');
  }

  /** 刷新工程图显示（仅广播，不重算几何） */
  refreshDrawing(): void {
    this.host.emit('drawing');
  }

  /** 切换尺寸标注模式（点击工程图边线即标注） */
  toggleDimensionMode(): void {
    const d = this._drawing;
    if (!d || !d.views.length) {
      this.host.toast('info', '请先生成工程图视图');
      return;
    }
    this._dimMode = !this._dimMode;
    this.lastDimRun = null;
    this.host.setStatus(this._dimMode ? '尺寸标注：点击边线添加标注' : '就绪', this._dimMode ? 'busy' : 'ok');
    this.host.toast(
      'info',
      this._dimMode
        ? '尺寸标注：点击边线添加长度标注（Shift+点击另一条边 → 标注两条边间距；右键标注可删除）'
        : '已退出尺寸标注模式'
    );
    this.refreshDrawing();
  }

  /**
   * 工程图边线被点击 → 添加尺寸标注。
   * Shift + 同一视图的上一次标注边 → 两边距离标注，否则单边长度标注。
   */
  placeDrawingDimension(viewId: string, runIdx: number, shift = false): void {
    const d = this._drawing;
    const v = d?.views.find((x) => x.id === viewId);
    if (!d || !v || !this._dimMode) return;
    const key = `${viewId}:${runIdx}`;
    const prevPrefix = `${viewId}:`;
    if (shift && this.lastDimRun && this.lastDimRun.startsWith(prevPrefix)) {
      const prev = Number(this.lastDimRun.slice(prevPrefix.length));
      const dim = d.dimensionBetweenRuns(viewId, prev, runIdx);
      if (dim) this.host.toast('ok', `距离标注：${d.dimensionValue(v, dim).toFixed(2)} mm`);
    } else {
      const dim = d.dimensionRun(viewId, runIdx);
      if (dim) this.host.toast('ok', `长度标注：${d.dimensionValue(v, dim).toFixed(2)} mm`);
    }
    this.lastDimRun = key;
    this.host.emit('drawing');
  }

  /** 删除某个尺寸标注（右键工程图标注） */
  removeDrawingDim(viewId: string, dimId: string): void {
    const d = this._drawing;
    if (!d) return;
    d.removeDim(viewId, dimId);
    this.refreshDrawing();
  }

  clearDrawingDims(): void {
    const d = this._drawing;
    if (!d) return;
    d.clearDims();
    this.lastDimRun = null;
    this.refreshDrawing();
    this.host.toast('info', '已清除全部标注');
  }

  /** 自动标注：overall 标总宽/高，all 再标直线边 */
  autoDimensionDrawing(mode: 'overall' | 'all' = 'overall'): void {
    const d = this._drawing;
    if (!d || !d.views.length) {
      this.host.toast('info', '请先生成工程图视图');
      return;
    }
    const n = d.autoDimension(mode);
    this.refreshDrawing();
    this.host.toast('ok', `已自动标注 ${n} 处尺寸`);
  }

  /** 孔位自动标注：中心定位尺寸 + 正视圆的直径 */
  autoHoleDimensionDrawing(): void {
    const d = this._drawing;
    if (!d || !d.views.length) {
      this.host.toast('info', '请先生成工程图视图');
      return;
    }
    const n = d.autoDimensionHoles();
    this.refreshDrawing();
    this.host.toast('ok', `已标注 ${n} 处孔位尺寸`);
  }

  /** 应用标注元数据（公差 / φ 前缀）；视图或标注不存在返回 false */
  applyDrawingDimMeta(
    viewId: string,
    dimId: string,
    meta: { tolerance?: { upper: number; lower: number }; prefix?: string }
  ): boolean {
    const d = this._drawing;
    if (!d || !d.setDimMeta(viewId, dimId, meta)) return false;
    this.refreshDrawing();
    this.host.toast('ok', '已更新尺寸标注');
    return true;
  }

  /** 切换明细表：从装配体（按特征序列分组计数，数量联动）或当前零件生成 */
  toggleDrawingBOM(): void {
    const d = this._drawing;
    if (!d || !d.views.length) {
      this.host.toast('info', '请先生成工程图');
      return;
    }
    if (d.bom.length) {
      d.clearBom();
      this.refreshDrawing();
      this.host.toast('info', '已清除明细表');
      return;
    }
    const a = this.host.assembly();
    const material = d.sheet.material;
    let rows: Omit<BomRow, 'no'>[];
    if (a && a.components.length) {
      rows = a.bomEntries().map((e) => ({
        name: e.name,
        qty: e.qty,
        material,
        note: e.qty > 1 ? `共 ${e.qty} 件` : undefined,
      }));
    } else if (this.host.hasModel()) {
      rows = [{ name: `零件·${this.host.featureCount()} 特征`, qty: 1, material }];
    } else {
      this.host.toast('info', '没有可生成明细表的模型');
      return;
    }
    d.setBom(rows);
    this.refreshDrawing();
    this.host.toast('ok', `已生成明细表（${rows.length} 行，数量随装配自动联动）`);
  }

  /** 导出当前工程图为 PNG（宿主光栅化 + 下载） */
  async exportDrawingPNG(scale = 4): Promise<void> {
    const d = this._drawing;
    if (!d) {
      this.host.toast('err', '没有工程图');
      throw new Error('no drawing');
    }
    const { w, h } = d.sheet;
    const buf = await this.host.rasterizePNG(d.toSVG(), w, h, scale);
    this.host.download(buf, 'drawing.png', 'image/png');
    this.host.toast('ok', 'PNG 已导出');
  }
}
