/**
 * 草图编辑历史单测（纯计算）。
 *
 * 覆盖 `src/sketch/history.ts`：快照序列化稳定性、撤销/重做栈、空操作跳过、
 * 重做分支清空、深度上限。
 *
 * 与 `SketchController`（依赖 DOM / App）分离——本测试只测纯逻辑部分。
 */
import { SketchHistory, snapshotSketch } from '../src/sketch/history';
import type { Sketch, SkEntity, SkPoint } from '../src/sketch/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

/** 构造一个含 n 条独立线段的草图（每条线两个点） */
function mkSketch(n: number): Sketch {
  const points: Record<string, SkPoint> = {};
  const entities: SkEntity[] = [];
  for (let i = 0; i < n; i++) {
    const a = `p${i}a`;
    const b = `p${i}b`;
    points[a] = { id: a, x: i, y: 0 };
    points[b] = { id: b, x: i + 1, y: 1 };
    entities.push({ id: `e${i}`, kind: 'line', a, b } as SkEntity);
  }
  return { entities, points, constraints: [] };
}

// ---- 快照序列化 ----
{
  const a = mkSketch(2);
  const b = mkSketch(2);
  check('相同内容 → 相同快照', snapshotSketch(a) === snapshotSketch(b));

  // 打乱 points 的 key 插入顺序，内容不变 → 快照仍应相同
  const c: Sketch = {
    entities: a.entities,
    points: Object.fromEntries(Object.entries(a.points).reverse()),
    constraints: [],
  };
  check('points key 顺序不同 → 快照仍相同（稳定序列化）', snapshotSketch(a) === snapshotSketch(c));

  check('内容不同 → 快照不同', snapshotSketch(mkSketch(1)) !== snapshotSketch(mkSketch(2)));
}

// ---- 撤销 / 重做 ----
{
  const h = new SketchHistory();
  const s0 = snapshotSketch(mkSketch(0));
  const s1 = snapshotSketch(mkSketch(1));
  const s2 = snapshotSketch(mkSketch(2));

  h.reset(s0);
  check('初始：无可撤销', !h.canUndo && !h.canRedo);
  check('初始 undo → null', h.undo() === null);
  check('初始 redo → null', h.redo() === null);

  h.commit(s1);
  h.commit(s2);
  check('两次提交后可撤销', h.canUndo);

  check('undo → 回到 s1', h.undo() === s1);
  check('undo 后可重做', h.canRedo);
  check('再 undo → 回到 s0（下界）', h.undo() === s0);
  check('到底后不可撤销', !h.canUndo);
  check('到底后 undo → null', h.undo() === null);

  check('redo → s1', h.redo() === s1);
  check('再 redo → s2', h.redo() === s2);
  check('redo 到顶后 → null', h.redo() === null);
}

// ---- 空操作不占历史 ----
{
  const h = new SketchHistory();
  const s0 = snapshotSketch(mkSketch(0));
  h.reset(s0);
  h.commit(s0); // 与下界相同 → 忽略
  h.commit(s0);
  check('提交与当前相同的快照 → 不产生历史', !h.canUndo);
}

// ---- 撤销后新提交 → 清空重做分支 ----
{
  const h = new SketchHistory();
  const s0 = snapshotSketch(mkSketch(0));
  const s1 = snapshotSketch(mkSketch(1));
  const s2 = snapshotSketch(mkSketch(2));
  const s3 = snapshotSketch(mkSketch(3));

  h.reset(s0);
  h.commit(s1);
  h.commit(s2);
  h.undo(); // 回到 s1，future=[s2]
  check('撤销后有重做分支', h.canRedo);
  h.commit(s3); // 新分支
  check('撤销后新提交 → 重做分支被清空', !h.canRedo);
  check('新分支可撤销', h.canUndo);
}

// ---- reset / clear ----
{
  const h = new SketchHistory();
  h.reset(snapshotSketch(mkSketch(0)));
  h.commit(snapshotSketch(mkSketch(1)));
  h.reset(snapshotSketch(mkSketch(5)));
  check('reset 后回到无历史状态', !h.canUndo && !h.canRedo);

  h.commit(snapshotSketch(mkSketch(6)));
  h.clear();
  check('clear 后无历史', !h.canUndo && !h.canRedo && h.depth === 0);
}

// ---- 深度上限 ----
{
  const h = new SketchHistory(3);
  h.reset(snapshotSketch(mkSketch(0)));
  for (let i = 1; i <= 10; i++) h.commit(snapshotSketch(mkSketch(i)));
  check('超过上限后深度被裁剪到 max', h.depth === 3, `depth=${h.depth}`);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
