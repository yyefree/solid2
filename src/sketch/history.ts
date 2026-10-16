/**
 * 草图编辑历史（快照栈）——纯逻辑，Node 可单测。
 *
 * SolidWorks 语义：草图编辑态的撤销/重做只作用于**草图内部**（画线 / 约束 / 删除 /
 * 拖拽），与文档级撤销（特征增删）互不干扰。此前草图态没有自己的历史，Ctrl+Z 会落到
 * 文档级撤销上，整体替换 doc 而 `editingSketch` 仍指向旧对象 → 编辑器与文档脱节。
 *
 * 用法：进入草图 `reset(初始快照)`；每次变更后 `commit(当前快照)`；
 * `undo()` / `redo()` 返回应恢复到的快照字符串（null 表示无可撤销 / 重做）。
 */
import type { Sketch } from './types';

/**
 * 把草图序列化为可比较的快照字符串。
 * `points` 是 Record，其 key 顺序取决于插入 / 删除历史——排序后再序列化，
 * 避免「内容相同但 key 顺序不同」被误判为一次变化。
 */
export function snapshotSketch(sk: Sketch): string {
  const pts = Object.keys(sk.points)
    .sort()
    .map((k) => [k, sk.points[k]] as const);
  return JSON.stringify({ e: sk.entities, p: pts, c: sk.constraints });
}

export class SketchHistory {
  private past: string[] = [];
  private future: string[] = [];

  constructor(private readonly max = 200) {}

  /** 重置并以 snap 为下界（进入草图时调用） */
  reset(snap: string): void {
    this.past = [snap];
    this.future = [];
  }

  /** 清空历史（退出草图时调用） */
  clear(): void {
    this.past = [];
    this.future = [];
  }

  /** 提交一个新状态；与当前状态相同则忽略（空操作不占历史） */
  commit(snap: string): void {
    if (this.past[this.past.length - 1] === snap) return;
    this.past.push(snap);
    if (this.past.length > this.max) this.past.shift();
    this.future = [];
  }

  /** 撤销一步，返回应恢复到的快照；无可撤销返回 null */
  undo(): string | null {
    if (this.past.length <= 1) return null;
    this.future.push(this.past.pop()!);
    return this.past[this.past.length - 1];
  }

  /** 重做一步，返回应恢复到的快照；无可重做返回 null */
  redo(): string | null {
    const snap = this.future.pop();
    if (snap === undefined) return null;
    this.past.push(snap);
    return snap;
  }

  get canUndo(): boolean {
    return this.past.length > 1;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 当前历史深度（含下界快照） */
  get depth(): number {
    return this.past.length;
  }
}
