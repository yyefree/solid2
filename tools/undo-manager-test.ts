/**
 * 撤销 / 重做管理器单测（纯计算，不依赖 DOM / THREE / 内核）。
 *
 * 覆盖 `src/app/undo-manager.ts` 的核心不变量：
 *   - mutate = 压栈 → 执行 → 重建 →（可选）广播；rebuild:false 跳过重建
 *   - push 节流（max 60 丢弃最旧）与清空 redo
 *   - undo/redo 对称：弹出对方栈、把当前现场压入对方栈、restore + afterRestore
 *   - suppress 全程（含 afterRestore 内的压栈）为空操作——撤销自身不入栈
 *   - useStacks 按文档换栈（条目持有数组引用，切回原样恢复）
 */
import { UndoManager, type UndoHost, type MutateOpts } from '../src/app/undo-manager';

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

/** 测试用宿主：文档 = 一个可变的字符串，快照/恢复直接读写它 */
function makeHost() {
  const calls: string[] = [];
  const state: { doc: string; emits: string[]; infos: string[] } = { doc: 'v0', emits: [], infos: [] };
  const host: UndoHost = {
    snapshot: () => state.doc,
    restore: (json) => { state.doc = json; calls.push(`restore:${json}`); },
    afterRestore: async () => { calls.push('afterRestore'); },
    rebuild: async (opts) => { calls.push(`rebuild:${opts.fit ? 'fit' : 'nofit'}`); },
    emit: (...evts) => { state.emits.push(...evts); },
    info: (msg) => { state.infos.push(msg); },
  };
  return { host, calls, state };
}

// ---- mutate：压栈 → 执行 → 重建 → 广播 ----
{
  const { host, calls, state } = makeHost();
  const m = new UndoManager(host);
  m.mutate(() => { state.doc = 'v1'; });
  check('mutate 顺序：rebuild 在执行之后、emit 之前',
    calls[0] === 'rebuild:nofit' && calls.length === 1, calls.join(','));
  check('mutate 后 canUndo（快照 v0 已入栈）', m.canUndo && !m.canRedo);

  const { host: h2, calls: c2, state: s2 } = makeHost();
  const m2 = new UndoManager(h2);
  m2.mutate(() => { s2.doc = 'v1'; }, { fit: true, emit: ['params', 'change'] });
  check('mutate fit 透传给重建', c2[0] === 'rebuild:fit', c2.join(','));
  check('mutate emit 广播（多个事件）', s2.emits.join(',') === 'params,change', s2.emits.join(','));

  const { host: h3, calls: c3 } = makeHost();
  const m3 = new UndoManager(h3);
  m3.mutate(() => {}, { rebuild: false, emit: [] });
  check('rebuild:false 跳过重建', c3.length === 0, c3.join(','));
}

// ---- push：节流 + 清 redo ----
{
  const { host, state } = makeHost();
  const m = new UndoManager(host);
  for (let i = 1; i <= 65; i++) {
    state.doc = `v${i}`;
    m.push();
  }
  const stacks = m.stacks;
  check('压栈节流 max=60（丢弃最旧）', stacks.undo.length === 60, `len=${stacks.undo.length}`);
  check('节流后保留的是较新的快照（v6..v65）',
    stacks.undo[0] === 'v6' && stacks.undo[59] === 'v65',
    `${stacks.undo[0]}..${stacks.undo[59]}`);

  const { host: h2 } = makeHost();
  const m2 = new UndoManager(h2);
  m2.push();
  m2.stacks.redo.push('old-redo');
  m2.push();
  check('push 清空 redo 栈', m2.stacks.redo.length === 0);
}

// ---- undo：对称恢复 ----
{
  const { host, calls, state } = makeHost();
  const m = new UndoManager(host);
  state.doc = 'v0';
  m.mutate(() => { state.doc = 'v1'; });
  state.doc = 'v1';
  await m.undo();
  check('undo 后文档回到 v0', state.doc === 'v0');
  check('undo 调用了 restore 与 afterRestore',
    calls.includes('restore:v0') && calls.includes('afterRestore'), calls.join(','));
  check('undo 后可 redo（当前现场 v1 已入 redo 栈）', !m.canUndo && m.canRedo);
  check('undo 提示已撤销', state.infos.join(',') === '已撤销', state.infos.join(','));

  // 空栈
  const { host: h2, state: s2 } = makeHost();
  const m2 = new UndoManager(h2);
  await m2.undo();
  check('空 undo 栈：提示且不改文档', s2.doc === 'v0' && s2.infos[0] === '没有可撤销的操作');
}

// ---- redo：对称恢复 ----
{
  const { host, state } = makeHost();
  const m = new UndoManager(host);
  state.doc = 'v0';
  m.mutate(() => { state.doc = 'v1'; });
  await m.undo();
  await m.redo();
  check('redo 后文档回到 v1', state.doc === 'v1');
  check('redo 后可再次 undo（当前现场 v0 已入 undo 栈）', m.canUndo && !m.canRedo);
  check('redo 提示已重做', state.infos.join(',') === '已撤销,已重做', state.infos.join(','));

  const { host: h2, state: s2 } = makeHost();
  const m2 = new UndoManager(h2);
  await m2.redo();
  check('空 redo 栈：提示且不改文档', s2.doc === 'v0' && s2.infos[0] === '没有可重做的操作');
}

// ---- suppress：撤销/重做全程不入栈（afterRestore 内的 push 也是空操作）----
{
  const { host, state } = makeHost();
  const m = new UndoManager(host);
  let pushedDuringRestore = false;
  const wrapped: UndoHost = {
    ...host,
    afterRestore: async () => {
      m.push(); // 撤销流程内部若再压栈（错误行为），suppress 必须拦截
      pushedDuringRestore = true;
    },
  };
  const m2 = new UndoManager(wrapped);
  state.doc = 'v0';
  m2.mutate(() => { state.doc = 'v1'; });
  await m2.undo();
  check('suppress 期间 push 为空操作（撤销自身不入栈）',
    pushedDuringRestore && m2.stacks.undo.length === 0,
    `undoLen=${m2.stacks.undo.length}`);
  await m2.redo();
  check('redo 流程结束后 suppress 复位（新压栈生效）',
    m2.stacks.redo.length === 0 && m2.canUndo);
}

// ---- useStacks：按文档换栈 ----
{
  const { host, state } = makeHost();
  const m = new UndoManager(host);
  const docA = { undo: ['a1'], redo: [] as string[] };
  const docB = { undo: ['b1', 'b2'], redo: ['b3'] };
  m.useStacks(docA.undo, docA.redo);
  check('useStacks 后 canUndo/canRedo 跟随文档 A',
    m.canUndo && !m.canRedo && m.stacks.undo[0] === 'a1');
  m.useStacks(docB.undo, docB.redo);
  check('useStacks 切换后跟随文档 B', m.canUndo && m.canRedo && m.stacks.redo[0] === 'b3');
  m.mutate(() => { state.doc = 'x'; });
  check('压栈写进当前文档 B 的数组（引用共享）',
    docB.undo.length === 3 && docA.undo.length === 1);
  m.useStacks(docA.undo, docA.redo);
  check('切回文档 A：栈原样恢复', m.stacks.undo.length === 1 && m.stacks.undo[0] === 'a1');
}

console.log(`\n撤销管理器：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail > 0) process.exit(1);
