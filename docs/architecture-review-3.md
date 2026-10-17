# 第三轮架构审查（只读，未改代码）

时间：2026-10-17（基线 `39c3a2b`，即第二轮审查 + 前 4 项修复已落地之后）。
方法：纯静态量化（文件/行数、`app.ts` 成员、层级依赖、UI 直改领域模型、模块级可变状态、死代码、
封装泄漏、竞态）。本轮与第二轮（`docs/architecture-review-2.md`）逐项对照，重点看"前 4 项修复"落下
了什么、哪些是老问题复发、有没有新引入的缺陷。

---

## 0. 规模（对比第二轮）

| 指标 | 第二轮 | 本轮 | 变化 |
|---|---|---|---|
| TS 文件数 | 66 | 66 | 0 |
| 总行数 | 28,267 | 28,287 | +20（4 项修复净增，几乎持平） |
| `app.ts` 行数 | 2,312 | 2,343 | +31 |
| `ui/` 行数 | 8,172 | 8,161 | −11 |
| `app/` 行数 | 5,750 | 5,781 | +31 |

结论：**代码体量稳定在 28.3k 行**。前 4 项修复以"小幅重构 + 删死代码"为主，未显著膨胀，方向正确。

---

## 1. 层级依赖违例（与第二轮完全一致，未动）

文件级循环依赖：**0 对**（一直做得好）。
层级违例（下层 import 上层 / 同层跨目录）：

| 违例 | 次数 | 位置 |
|---|---|---|
| `app → ui` | 10 | `app.ts` 引 `ui/toast`、`ui/propertymanager`、`ui/sectionprops-dialog`（3 处）；`app/hotkeys.ts` 引 6 个 ui；`app/sketchMode.ts` 引 `ui/toast`（1） |
| `core → doc` | 2 | `core/kernel.worker.ts` 引 `doc/topo`、`doc/engine`（`worker` 实为应用级适配器，目录命名不符实） |
| `view → ui` | 1 | `view/viewport.ts` 引 `ui/dom`（`el`/`clear` 工具函数） |

`doc/` 与 `sketch/` 零越界。这三类违例自第一轮以来**纹丝不动**——它们属"命名/工具函数"级，
改动成本低（内联 `el`、把 worker 的适配器逻辑归到 `app/core` 或改名 `app/kernel`），但一直没排期。

---

## 2. 上帝对象 `App`（持续恶化，本轮无缓解）

`app.ts` 2,343 行。成员数因解析口径不同略有出入，但趋势明确：第二轮 ~205 成员（139 方法 + 66 字段），
本轮 **成员总数仍 ≥ 200**（且因新增 `mutate` / `closeActiveDocument` / 若干 getter/setter 委托而净增）。
`App` 仍混合 8+ 个领域：文档、撤销、选择、草图编辑、视图、外观、装配、工程图、异步/内核、参数表达式、
事件、预览。

21/27 个 ui 文件直接 `import` 具体 `App` 类，**无端口/接口抽象**——这是"UI 直改领域模型"的根因（见 §5）。

**本轮未做拆分**，属预期（第二轮建议的第 ⑥ 项是大工程，用户仅要求前 4 项）。仅记录：上帝对象仍在长大。

---

## 3. `evaluateFeature` 巨型单函数（老问题，几乎未动）

`doc/engine.ts:485–1014`，**529 行 / 32 个 `case`**（第二轮 543 行 / 32 case，本轮仅 trim 14 行注释/空白）。
一个 `switch` 涵盖全部特征类型求值，是"特征类型 → 求值逻辑"的天然注册表形态，却写成线性巨函数。

风险：每次新增特征类型都要改这一个函数（冲突面大、回归面大）；32 个 case 共享一个 `ctx`/`current`
可变状态，易串味。建议改成 `Map<FeatureType, Handler>` 注册表（handler 各自纯函数），与
`SelectionStore` 的"纯模块边界"风格一致。本轮未动。

---

## 4. UI 直改领域模型（有改善，但仍偏高）

| 指标 | 第二轮 | 本轮 | 变化 |
|---|---|---|---|
| `app.doc` 在 ui 出现 | 76 | 75 | −1 |
| `app.addFeature` | 31 | 31 | 0 |
| `app.viewport` | 18 | 19 | +1 |
| **`app.(doc\|assembly\|drawing) =` 直接赋值** | 有（dialogs 死代码） | **0** | ✅ 已清零 |

**改善点**：前 4 项修复删除了 `dialogs.ts` 的 `newProject(app)`（它直接 `app.doc = new CadDocument()`
且不调 `sel.reset()`），使得 ui 层**再无任何对文档根对象的直接赋值**。这是实质性的封装加固——
"选中态悬空"类 bug 的一条通道被堵死。

**仍偏高**：`app.doc` 读引用 75 处、`app.addFeature` 31 处——UI 大量直接读领域状态、直接调写入口。
`mutate` 收口了"压栈"动作，但 UI 仍在 `mutate` 之外直接 `app.addFeature(...)`（addFeature 内部已走
mutate，所以压栈是对的，但调用点散落 31 处，未来若 addFeature 语义变就要逐处查）。属已知技术债，非紧急。

---

## 5. 模块级可变单例（微改善）

全 `src` 模块级 `let`（可变单例：magnifier / popup / propertymanager / ribbon / shortcutbar /
toast / occt `_oc` / types `uid` 等）：第二轮 23 → 本轮 **22**。微改善（前 4 项修复顺手去掉了 dialogs
里的 `newProject` 闭包态？实际是计数波动）。UI 状态散落在模块作用域，仍会制造"测试顺序敏感 /
并发窗口"隐患，但无新增危机。

---

## 6. 第二轮 P2 项遗留（仍未处理）

- **封装泄漏：`selection` getter 返回内部引用**（`app.ts:161` `return this.sel.geometry;`）。
  `SelectionStore.geometry` 是内部可变对象，`setGeometry` 复制入参 → 读出口可被
  `app.selection.faces.push(...)` 绕过互斥不变量。当前无调用方这么写（已 grep 验证），但接口在"撒谎"。
  修复成本极低：返回浅副本或只读视图即可。
- **竞态隐患：`undo()` / `redo()`（`app.ts:554` / `578`）** 中 `suppressUndo = true` → 调 **async**
  `rebuild()` **未 await** → 立即复位 `suppressUndo = false`。当前 rebuild 内部不压栈故未爆，
  但"全局标志位 + 未 await 异步"是脆弱写法。建议 `await this.rebuild()` 或把标志改成基于
  `rebuildToken` 的令牌判定（与已有的并发保护同构）。

---

## 7. ⚠️ 本轮新发现：死代码 `App.newProject()`

前 4 项修复把 `ui/menubar.ts`、`ribbon.ts`、`stdtoolbar.ts` 的「新建」从 `newProject()` 改接
`newDocument('model')`，并删除了 `dialogs.ts` 的 `newProject(app)`。**但 `app.ts` 里仍保留着
`App.newProject()` 方法（`:1980`）**——仓库范围 grep 其调用点：

```
grep -rnE "newProject\s*\(" src tools main.ts  →  仅定义行 + 一处注释，0 个调用点
```

即 `App.newProject()` **现在没有任何调用方**（UI 不再接、内部也不调）。它成了"保留了但永不触达"的
死代码，与第二轮"删除 dialogs 死代码"的精神相悖。

`newProject()` 的语义是"清空当前文档内容"（不是新开标签）。既然没有合法入口需要它，建议：
- **要么删掉**（最干净，与"删死代码"原则一致）；
- **要么显式接一个内部调用**（例如 `closeActiveDocument` 在"最后一个文档被关"时的兜底——
  但目前 `closeActiveDocument` 有"至少保留一个"保护，不需要清空），或保留并补 `// 仅内部 X 用`。

> 注：记忆里写的是"`newProject()` 保留但仅用于清空当前文档内容，UI 入口勿再接它"——
> 实际现在连内部都不接，应改为"已无调用方，待删"或真接上。

---

## 8. `any` 渗透（轻微恶化）

`any` 出现次数：第二轮 171 → 本轮 **190（+19）**。集中在 OCCT embind 边界（几何对象句柄、拓扑遍历），
此类可接受；但 +19 提示有少量新 `any` 渗入非边界代码（如 `updateFeatureParams` 的
`patch: Record<string, any>`）。建议：OCCT 边界维持 `any`，但领域层新增类型尽量收紧，避免 `any`
从边界向纯逻辑蔓延。非紧急。

---

## 9. 做得好（维持，值得肯定）

- **0 个空 `catch`、0 个真实 TODO/FIXME**（唯一匹配是 `toShape.ts` 里解释 OCCT 报错的一句话注释，
  非待办）。错误处理没有"静默吞异常"。
- **内核隔离由 build 强制校验**：本轮 build 仍 `✓ 主包未引用内核`、`✓ Worker 包正常引用内核`，
  主线程零 `import opencascade` 的红线守得住。
- **纯模块边界清晰**：`doc/model`、`doc/expr`、`sketch/types`、`sketch/solver`、`core/kernel-types`、
  `core/sectionprops`、`app/hotkey-keys`、`sketch/history`、`app/selection-store` 均可 Node 单测。
- **测试资产厚**：23 套件 + 228 冒烟 + 93 手册 + 15 探针。前 4 项修复靠这套网兜住了"无回归"。
- **`mutate` 收口撤销栈**：`pushUndo` 转 private 后，ui 层 0 个直调（grep 证实），撤销正确性不再
  依赖 12 个散落调用点 + UI 自觉——这是本轮最值钱的加固。

---

## 10. 建议优先级（供后续演进）

| 优先级 | 项 | 成本 | 说明 |
|---|---|---|---|
| **P1（新）** | 删 `App.newProject()` 死代码，或显式接内部调用 | 低 | §7，与第二轮"删死代码"精神一致 |
| **P2** | `selection` getter 返回只读视图/浅副本 | 极低 | §6，接口撒谎，1 行级修复 |
| **P2** | `undo/redo` 的 `suppressUndo` + 未 await 异步 rebuild → 改令牌判定 | 低 | §6，脆弱写法 |
| **P2** | 内联 `ui/dom` 的 `el/clear`，消 `view→ui` 违例 | 低 | §1 |
| **P3** | `evaluateFeature` 32 case → `Map<type, Handler>` 注册表 | 中 | §3，降低新增特征的冲突/回归面 |
| **P3** | 收紧 `any`：领域层新增类型不靠 `any` 兜底 | 中 | §8 |
| **P3（大）** | `App` 按领域拆服务（文档/选择/草图/视图/外观…） | 大 | §2，长期目标，勿一次性大重构 |
| **P3** | worker 适配器从 `core/` 归到 `app/` 或改名，消 `core→doc` 违例 | 低 | §1 |

**一句话总结**：前 4 项修复方向对、收口了撤销栈并堵死 UI 直赋文档根对象，但留下了
"死代码 `App.newProject()` 未清"这一新尾巴；老问题（上帝对象、evaluateFeature 巨函数、层级违例、
封装泄漏、竞态隐患）依旧，建议下一轮优先清死代码 + 做两个极低成本的 P2 加固（selection 只读视图、
undo/redo 令牌化），再视情况动 evaluateFeature 注册表与 App 拆分。
