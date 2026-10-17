/**
 * 撤销 / 重做管理器（写路径主干）。
 *
 * 从 `App` 抽出的第一个领域服务（与 `selection-store.ts` 同构）：
 * App 只提供「快照 / 恢复 / 重建 / 广播」等宿主回调，栈操作、压栈节流
 * （max 60）、`suppress` 守卫与 undo/redo 的流程编排全部收在本类，
 * 不依赖 DOM / THREE / 内核 → 可在 Node 下单测（见 tools/undo-manager-test.ts）。
 *
 * ⚠️ 撤销栈**按文档隔离**：每个 DocumentEntry 持有自己的 undo/redo 数组，
 * 切换文档只是换引用（`useStacks`），不序列化、不重建，切回时原样恢复。
 */

import type { AppEvent } from './app';

/** undo/redo 流程需要的宿主能力（由 App 提供） */
export interface UndoHost {
  /** 当前文档的 JSON 快照（压栈 / 重做前保存现场） */
  snapshot(): string;
  /** 用快照整体替换文档（撤销 / 重做执行） */
  restore(json: string): void;
  /** 恢复后的收尾：剪除悬空 UI 状态 + 异步重建 */
  afterRestore(): Promise<void>;
  /** 异步重建（mutate 的 rebuild 步骤；fire-and-forget，与旧行为一致） */
  rebuild(opts: { fit?: boolean }): Promise<void>;
  /** 广播事件 */
  emit(...evts: AppEvent[]): void;
  /** 轻提示（没有可撤销 / 重做时） */
  info(message: string): void;
}

/** `mutate` 的可选项 */
export interface MutateOpts {
  /** 重建后是否适配视图 */
  fit?: boolean;
  /** 重建后广播的事件（重建本身已广播 change/tree/props/params） */
  emit?: AppEvent[];
  /** 传 `false` 跳过重建（调用方自行处理后续） */
  rebuild?: boolean;
}

export class UndoManager {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** 撤销栈上限（与旧 App.maxUndo 一致） */
  private readonly max = 60;
  /** suppress 期间压栈为空操作——供「文档整体替换 + 异步重建」全程使用 */
  private suppress = false;

  constructor(private readonly host: UndoHost) {}

  /**
   * 切换文档：换成目标条目自己的 undo/redo 栈。
   * 条目持有数组引用（DocumentEntry.undo/redo），切回时几何/参数/计数器全部原样恢复。
   */
  useStacks(undo: string[], redo: string[]): void {
    this.undoStack = undo;
    this.redoStack = redo;
  }

  /** 当前栈引用（切文档前写回条目用——与条目共享同一数组） */
  get stacks(): { undo: string[]; redo: string[] } {
    return { undo: this.undoStack, redo: this.redoStack };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * 压撤销栈。
   *
   * ⚠️ **外部（尤其 UI 层）不得直接调用**——此前 `ui/dialogs.ts` 就调过它，导致压栈责任
   * 分散在十几个入口 + UI 层，漏掉一处就会出现「改尺寸 → Ctrl+Z 弹掉更早的无关操作」。
   * 外部修改文档一律走 `mutate()`。仅 App 内部复杂编排可用
   * （如 `startSketch`：`doc.nextName` 递增计数器须压栈后执行）。
   */
  push(): void {
    if (this.suppress) return;
    this.undoStack.push(this.host.snapshot());
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * 统一的「写文档」入口：压撤销栈 → 执行改动 → 重建 →（可选）广播事件。
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
    this.push();
    fn();
    if (opts.rebuild !== false) void this.host.rebuild({ fit: opts.fit });
    if (opts.emit?.length) this.host.emit(...opts.emit);
  }

  /**
   * 文档级撤销（草图编辑态的撤销由 App 分支到 SketchController，绝不回落这里——
   * 文档级撤销会整体替换 doc，而 editingSketch 仍指向旧 doc 的特征对象，
   * 导致草图编辑器与文档脱节）。
   */
  async undo(): Promise<void> {
    const prev = this.undoStack.pop();
    if (!prev) {
      this.host.info('没有可撤销的操作');
      return;
    }
    this.redoStack.push(this.host.snapshot());
    // suppress 在「文档替换 + 异步重建」全程保持 true，用 try/finally 保证复位，
    // 避免全局布尔在 await 异步 rebuild 之前被提前清零（此前为脆弱写法）。
    this.suppress = true;
    try {
      this.host.restore(prev);
      await this.host.afterRestore();
    } finally {
      this.suppress = false;
    }
    this.host.info('已撤销');
  }

  /** 文档级重做（同 undo：草图态由 App 分支处理） */
  async redo(): Promise<void> {
    const next = this.redoStack.pop();
    if (!next) {
      this.host.info('没有可重做的操作');
      return;
    }
    this.undoStack.push(this.host.snapshot());
    this.suppress = true;
    try {
      this.host.restore(next);
      await this.host.afterRestore();
    } finally {
      this.suppress = false;
    }
    this.host.info('已重做');
  }
}
