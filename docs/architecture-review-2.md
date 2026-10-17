# Solid2 架构审查（第二轮）

> 日期：2026-10-17 · 基线提交：`6403607`（收口选中态）· 性质：**只读审查，未修改任何代码**

上一轮审查后落地了第 1 优先级建议「选中态收口为 SelectionStore」。本轮基于**当前实际代码**重新量化，
并对比上一轮结论，给出增量意见。所有结论均可通过文中的 `文件:行号` 复核。

---

## 1. 规模与依赖（对比上一轮）

| 指标 | 上一轮 | 本轮 | 变化 |
|---|---|---|---|
| 文件数 / 行数 | 60+ / 28,023 | **66 / 28,267** | +6 文件（新增 `selection-store.ts` 等） |
| app / ui / ai | 5.5k / 8.2k / 3.7k | **5,750 / 8,172 / 3,707** | 基本持平 |
| doc / core / sketch / view | 3.1k / 2.8k / 2.4k / 1.9k | **3,141 / 2,793 / 2,429 / 1,935** | 持平 |
| `app → ui` 违例 | 10 | **10** | 未动 |
| `core → doc` 违例 | 2 | **2** | 未动 |
| `view → ui` 违例 | 1 | **1** | 未动 |
| 文件级循环依赖 | 0 | **0** | 保持 |

层级违例明细：`app.ts` 引 `ui/toast`、`ui/propertymanager`、`ui/sectionprops-dialog`（3 处）；
`app/hotkeys.ts` 引 6 个 ui 模块；`app/sketchMode.ts` 引 `ui/toast`（1 处）；
`core/kernel.worker.ts` 引 `doc/topo`、`doc/engine`（2 处）；`view/viewport.ts` 引 `ui/dom`（1 处）。
`doc`、`sketch` 两个领域层**零越界**。

最大文件：`app/app.ts` 2,312 · `ui/dialogs.ts` 1,838 · `app/sketchMode.ts` 1,336 ·
`ai/parse.ts` 1,325 · `doc/engine.ts` 1,281 · `view/viewport.ts` 1,126。

---

## 2. 上一轮 5 个核心问题的现状

| # | 上一轮问题 | 本轮实测 | 判定 |
|---|---|---|---|
| 1 | App 上帝对象（~180 成员） | **205 成员**（139 方法 + 66 字段），2,312 行 | ⬆ **恶化**（收口新增 10 个 getter/setter 委托） |
| 2 | 4 个重叠的选中态字段 | 已收口为 `SelectionStore`（`src/app/selection-store.ts`） | ✅ **已解决** |
| 3 | `evaluateFeature` 544 行 / 35 case | **543 行 / 32 case**（`doc/engine.ts:485-1027`） | ⏸ 未动 |
| 4 | UI 直接改领域模型 | **122 处 / 13 个 ui 文件** | ≈ 持平 |
| 5 | 30+ 模块级可变单例 | **23 处模块级 `let`** + 若干 `const` 单例 | ≈ 持平 |

结论：**结构性债务没有变化**；唯一实质进展是选中态收口（本轮唯一动过的核心问题）。

---

## 3. 本轮新发现

### P1 — 命令映射错误（真实行为缺陷，各 1~2 行即可修）

**3.1 「新建」菜单点击与 Ctrl+N 行为不一致**

- `ui/menubar.ts:167`：`{ label: '新建', sc: sc('file.new'), run: () => app.newProject() }`
  → 显示快捷键提示 **Ctrl+N**，但执行的是 `App.newProject()`（**清空当前文档**）。
- 而 `app/hotkeys.ts:115`：`{ id: 'file.new', keys: 'Ctrl+N', run: (a) => a.newDocument('model') }`
  → 键盘 Ctrl+N 实际执行 `newDocument('model')`（**新开一个标签页**）。
- 同一 `menubar.ts` 第 48 行的另一处「新建」用的却是 `newDocument('model')`。

**影响**：用户看到菜单提示「新建 Ctrl+N」，用键盘和用鼠标会得到两种完全不同的结果——一个是新标签页，
一个是清空当前文档。这是同一功能的两套实现，属于「同一根因」在命令层的再现。

**3.2 「关闭文档」实际是「清空当前文档」**

- `ui/menubar.ts:512`：`{ label: '关闭文档', icon: 'closeDoc', run: () => app.newProject() }`
- 而 App 有专用的 `closeDocument(id)`（`app/app.ts:322`），且 `main.ts:215` 标签栏的关闭按钮用的正是它。

**影响**：多标签场景下点「窗口 > 关闭文档」会**清空当前文档内容**而不是关闭标签页。

### P1 — 死代码绕过封装（潜在缺陷）

`ui/dialogs.ts:1494` 的 `newProject(app)` **没有任何调用者**（已全仓 grep 确认）。它的问题：

```ts
newProject(app: App): void {
  confirmDialog('新建项目', '…', () => {
    app.pushUndo();
    app.doc = new CadDocument();   // ← 绕过 App 封装直接替换文档
    app.assembly = null;
    app.drawing = null;
    app.rebuild({ fit: true });    // ← 不调 sel.reset() / pruneFeatureUiState()
  });
}
```

对比 `App.newProject()`（`app/app.ts:1945`）——它有 `this.sel.reset()`。这份重复实现**漏了选中态清理**，
一旦将来有人接上它（比如把菜单指向它），就会**精确复现**「选中态悬空」这个刚修好的根因。
它还迫使 `ui/dialogs.ts` 导入 `CadDocument`（第 15 行）。

### P1 — 撤销栈责任分散

`App.pushUndo()` 是**公开方法**（`app/app.ts:499`），且 `ui/dialogs.ts:1496` 直接调用它。
压栈的正确性因此依赖约 12 个 App 内部调用点 + UI 层**自觉**——这正是记忆里
「新增/编辑类入口一律要压撤销栈，这是第 N 次同类问题了」的根因：**撤销语义没有被集中到一处**。

### P2 — `keepSelection` 是死参数（接口撒谎）

`app/app.ts:681`：`async rebuild(options: { fit?: boolean; keepSelection?: boolean } = {})`。
`keepSelection` **在全文仅出现这一次**，从未被读取；`syncView()`（第 740 行）无条件
`this.sel.clearGeometry()`。签名承诺了「保留选择」的能力，实现里并不存在。

### P2 — `selection` getter 泄漏可变内部引用

`App.selection`（`app/app.ts:161`）返回 `this.sel.geometry` 的**内部对象本身**（非副本），
而 `SelectionStore.setGeometry()` 会复制入参。写入口做了封装、读出口没有 → 调用方
`app.selection.faces.push(3)` 可绕过互斥不变量（当前全仓 grep 未发现这种写法，属**未触发的隐患**）。

### P2 — `undo/redo` 的 `suppressUndo` 是「全局标志 + 未 await 的异步」

`undo()`（519）与 `redo()`（543）：

```ts
this.suppressUndo = true;
this.doc = CadDocument.fromJSON(JSON.parse(prev));
this.activeDoc().doc = this.doc;
this.pruneFeatureUiState();
this.rebuild();          // ← async，返回的 Promise 被丢弃
this.suppressUndo = false;  // ← 在 rebuild 完成前就复位了
```

`rebuild()` 内部目前不压栈，所以尚未爆雷；但「用全局可变标志保护一个未 await 的异步调用」
是脆弱组合，一旦 `rebuild` 的异步链路里出现压栈路径（如自动保存、表达式回写）就会失效。

---

## 4. 做得好的地方（维持）

- **`rebuild` 的并发保护**：`rebuildToken` + 发起时条目快照，过期结果直接丢弃（`app.ts:683-690`），
  多文档切换 / 连续操作下不会用旧模型覆盖新状态。异步竞态处理是正确的。
- **内核隔离**：主线程不 import opencascade，由 `npm run build` 的 `verify-bundle.mjs` 强制校验。
- **`ui` 层依赖方式**：21 个 ui 文件统一用 `import type { App }`（类型注入，非单例直引），
  为将来抽接口留了余地。
- **纯模块边界**：`doc/model`、`doc/expr`、`sketch/types`、`sketch/solver`、`core/kernel-types`、
  `core/sectionprops`、`app/hotkey-keys`、`sketch/history`、`app/selection-store` 均可 Node 直测。
- **文件级循环依赖为 0**，`doc` / `sketch` 领域层零越界。

---

## 5. 建议优先级

| 优先级 | 动作 | 规模 |
|---|---|---|
| **1** | 修 `menubar.ts:167`（改 `newDocument('model')`）与 `:512`（改 `closeDocument(当前 id)`） | 2 行 |
| **2** | 删除 `ui/dialogs.ts:1494 newProject` 死代码，或改为委托 `app.newProject()` | ~10 行 |
| **3** | 收口撤销：`pushUndo` 转私有，或引入 `App.mutate(fn)` 统一「压栈 + 执行 + 重建」 | 中 |
| **4** | 删除 `keepSelection` 死参数（或真正实现它） | 1 行 |
| **5** | `App.selection` 返回只读视图（`Readonly<GeomSelection>`） | 小 |
| **6** | `App` 按领域拆服务（文档 / 撤销 / 选择 / 草图 / 视图…），ui 依赖抽象接口 | 大（长期） |

前 4 项都是**低风险、可独立验证**的小改动，且都能被现有测试栈覆盖（`test:browser` / `test:manual`）。
第 6 项是唯一的大工程，建议在债务不再增长后再启动。
