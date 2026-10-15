/**
 * SolidWorks 键位表 + 全局热键分发器。
 *
 * 设计要点：
 *   1. 键位与 SolidWorks 默认设置保持一致（文件 Ctrl+N/O/S/P、编辑 Ctrl+Z/Y/X/C/V/A、
 *      重建 Ctrl+B、强制重建 Ctrl+Q、重绘 Ctrl+R、整屏显示 F、缩放 Z / Shift+Z、
 *      放大镜 G、快捷方式栏 S、视图定向 Space、视图方向 Ctrl+1..8、
 *      方向键旋转视图（15°）/ Shift+方向键 90° / Ctrl+方向键 平移、
 *      草图模式 L 直线 C 圆 A 圆弧 R 矩形 T 剪裁 …）。
 *   2. 单一来源：菜单里的快捷键文本、帮助>快捷键一览、实际分发，全部读同一张表，
 *      不会出现「菜单写着 Ctrl+B 但按了没反应」。
 *   3. 输入框内不拦截；模态框打开时只放行 Esc（交给模态框自己关闭）。
 */
import type { App } from './app';
import { notify } from '../ui/toast';
import { openShortcutBar } from '../ui/shortcutbar';
import { openViewOrientation, setRotateMode } from '../ui/headsup';
import { toggleMagnifier } from '../ui/magnifier';
import { featureDialogs } from '../ui/dialogs';
import { ribbonController } from '../ui/ribbon';
import { hotkeyOverrides, keysMatchEvent, eventToKeys, isValidKeys, type OverrideStore } from './hotkey-keys';

export type HotkeyScope = 'global' | 'sketch' | 'model' | 'assembly' | 'drawing';

export interface HotkeyDef {
  /** 唯一 id，菜单用 `sc('view.rebuild')` 取显示文本 */
  id: string;
  /** 中文名称 */
  label: string;
  /** 显示用快捷键文本，如 'Ctrl+B' / 'Shift+Z' / '方向键' */
  keys: string;
  /** 分组（帮助>快捷键一览 用） */
  group: string;
  scope?: HotkeyScope;
  run: (app: App) => void;
  /** 额外的可用性判断 */
  when?: (app: App) => boolean;
  /** 自定义匹配（方向键这种带修饰的族） */
  match?: (e: KeyboardEvent) => boolean;
}

const ROT = 15;

export { hotkeyOverrides };
export type { OverrideStore };
export { eventToKeys, isValidKeys } from './hotkey-keys';

/** 某命令的「当前生效键位」= 自定义覆盖 ?? 默认键位 */
export function effectiveKeys(h: HotkeyDef): string {
  return hotkeyOverrides.get(h.id) ?? h.keys;
}

/** 覆盖变化监听（菜单栏/快捷键一览 重绘用） */
const changeListeners = new Set<() => void>();
export function onHotkeysChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function emitChanged(): void {
  for (const fn of changeListeners) fn();
}

/** 自定义键盘：给某命令设新键位；非法/空键位视为移除覆盖 */
export function setHotkeyOverride(id: string, keys: string): void {
  const h = byId.get(id);
  if (!h) throw new Error(`未找到命令：${id}`);
  if (!keys) {
    hotkeyOverrides.set(id, '');
    emitChanged();
    return;
  }
  if (!isValidKeys(keys)) throw new Error(`无效键位：${keys}`);
  const conflict = findConflict(id, keys);
  if (conflict) throw new Error(`「${keys}」已分配给「${conflict.label}」`);
  hotkeyOverrides.set(id, keys);
  emitChanged();
}

/** 恢复某命令默认键位 */
export function resetHotkey(id: string): void {
  hotkeyOverrides.set(id, '');
  emitChanged();
}

/** 全部恢复默认 */
export function resetAllHotkeys(): void {
  hotkeyOverrides.reset();
  emitChanged();
}

/** 找出占用同一键位的其它命令（自定义冲突检测） */
export function findConflict(id: string, keys: string): HotkeyDef | null {
  for (const h of HOTKEYS) {
    if (h.id === id) continue;
    if (effectiveKeys(h) === keys) return h;
  }
  return null;
}

/** 自定义键盘对话框用的数据 */
export function hotkeyList(): { id: string; label: string; group: string; defaultKeys: string; keys: string }[] {
  return HOTKEYS.map((h) => ({
    id: h.id,
    label: h.label,
    group: h.group,
    defaultKeys: h.keys,
    keys: effectiveKeys(h),
  }));
}

export const HOTKEYS: HotkeyDef[] = [
  // ============================================================
  // 文件
  // ============================================================
  { id: 'file.new', label: '新建', keys: 'Ctrl+N', group: '文件', run: (a) => a.newDocument('model') },
  { id: 'file.open', label: '打开', keys: 'Ctrl+O', group: '文件', run: (a) => a.openProject() },
  { id: 'file.save', label: '保存', keys: 'Ctrl+S', group: '文件', run: (a) => a.saveProject() },
  { id: 'file.print', label: '打印', keys: 'Ctrl+P', group: '文件', run: (a) => a.printView() },

  // ============================================================
  // 编辑
  // ============================================================
  { id: 'edit.undo', label: '撤销', keys: 'Ctrl+Z', group: '编辑', run: (a) => a.undo() },
  { id: 'edit.redo', label: '重做', keys: 'Ctrl+Y', group: '编辑', run: (a) => a.redo() },
  { id: 'edit.redoAlt', label: '重做', keys: 'Ctrl+Shift+Z', group: '编辑', run: (a) => a.redo() },
  { id: 'edit.cut', label: '剪切', keys: 'Ctrl+X', group: '编辑', run: (a) => a.cutSelection() },
  { id: 'edit.copy', label: '复制', keys: 'Ctrl+C', group: '编辑', run: (a) => a.copySelection() },
  { id: 'edit.paste', label: '粘贴', keys: 'Ctrl+V', group: '编辑', run: (a) => a.pasteFromClipboard() },
  { id: 'edit.selectAll', label: '全选', keys: 'Ctrl+A', group: '编辑', run: (a) => a.selectAll() },
  {
    id: 'edit.repeat',
    label: '重复上一命令',
    keys: 'Enter',
    group: '编辑',
    scope: 'model',
    // PropertyManager 打开时 Enter 归对话框自己（确认/聚焦转移），不抢
    when: () => !document.querySelector('.pm') && !document.querySelector('.modal-mask'),
    run: () => {
      const c = ribbonController();
      if (!c) return;
      if (!c.hasLastCommand()) {
        notify.info('还没有执行过命令，无法重复');
        return;
      }
      c.rerunLast();
    },
  },
  { id: 'edit.delete', label: '删除', keys: 'Delete', group: '编辑', run: (a) => a.deleteSelection() },
  { id: 'edit.properties', label: '属性', keys: 'Alt+Enter', group: '编辑', run: (a) => a.showProperties() },

  // ============================================================
  // 视图
  // ============================================================
  { id: 'view.rebuild', label: '重建模型', keys: 'Ctrl+B', group: '视图', run: (a) => a.rebuildModel() },
  { id: 'view.forceRebuild', label: '强制重建', keys: 'Ctrl+Q', group: '视图', run: (a) => a.forceRebuild() },
  { id: 'view.redraw', label: '重绘屏幕', keys: 'Ctrl+R', group: '视图', run: (a) => a.redraw() },
  { id: 'view.fit', label: '整屏显示', keys: 'F', group: '视图', run: (a) => a.zoomFit() },
  { id: 'view.zoomOut', label: '缩小', keys: 'Z', group: '视图', run: (a) => a.zoomOut() },
  { id: 'view.zoomIn', label: '放大', keys: 'Shift+Z', group: '视图', run: (a) => a.zoomIn() },
  { id: 'view.magnifier', label: '放大镜', keys: 'G', group: '视图', run: (a) => toggleMagnifier(a) },
  { id: 'view.orientation', label: '视图定向', keys: 'Space', group: '视图', run: (a) => openViewOrientation(a) },
  { id: 'view.shortcutBar', label: '快捷方式栏', keys: 'S', group: '视图', run: (a) => openShortcutBar(a) },
  { id: 'view.prevView', label: '上一视图', keys: 'Ctrl+Shift+V', group: '视图', run: (a) => a.prevView() },
  { id: 'view.rotate', label: '旋转视图', keys: '—', group: '视图', run: (a) => setRotateMode(a, true) },
  { id: 'view.realview', label: 'RealView 图形', keys: '—', group: '视图', run: (a) => a.setRealView(!a.realView) },

  { id: 'view.front', label: '前视', keys: 'Ctrl+1', group: '视图方向', run: (a) => a.setView('front') },
  { id: 'view.back', label: '后视', keys: 'Ctrl+2', group: '视图方向', run: (a) => a.setView('back') },
  { id: 'view.left', label: '左视', keys: 'Ctrl+3', group: '视图方向', run: (a) => a.setView('left') },
  { id: 'view.right', label: '右视', keys: 'Ctrl+4', group: '视图方向', run: (a) => a.setView('right') },
  { id: 'view.top', label: '俯视', keys: 'Ctrl+5', group: '视图方向', run: (a) => a.setView('top') },
  { id: 'view.bottom', label: '仰视', keys: 'Ctrl+6', group: '视图方向', run: (a) => a.setView('bottom') },
  { id: 'view.iso', label: '等轴测', keys: 'Ctrl+7', group: '视图方向', run: (a) => a.setView('iso') },
  { id: 'view.normalTo', label: '正视于', keys: 'Ctrl+8', group: '视图方向', run: (a) => a.normalToSelection() },

  // 方向键族（旋转 / 平移）
  {
    id: 'view.rotLeft', label: '视图左转 15°', keys: '方向键 ←', group: '视图旋转',
    match: (e) => e.key === 'ArrowLeft' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey,
    run: (a) => a.rotateView(-ROT, 0),
  },
  {
    id: 'view.rotRight', label: '视图右转 15°', keys: '方向键 →', group: '视图旋转',
    match: (e) => e.key === 'ArrowRight' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey,
    run: (a) => a.rotateView(ROT, 0),
  },
  {
    id: 'view.rotUp', label: '视图上转 15°', keys: '方向键 ↑', group: '视图旋转',
    match: (e) => e.key === 'ArrowUp' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey,
    run: (a) => a.rotateView(0, ROT),
  },
  {
    id: 'view.rotDown', label: '视图下转 15°', keys: '方向键 ↓', group: '视图旋转',
    match: (e) => e.key === 'ArrowDown' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey,
    run: (a) => a.rotateView(0, -ROT),
  },
  {
    id: 'view.rotLeft90', label: '视图左转 90°', keys: 'Shift+←', group: '视图旋转',
    match: (e) => e.key === 'ArrowLeft' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey,
    run: (a) => a.rotateView(-90, 0),
  },
  {
    id: 'view.rotRight90', label: '视图右转 90°', keys: 'Shift+→', group: '视图旋转',
    match: (e) => e.key === 'ArrowRight' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey,
    run: (a) => a.rotateView(90, 0),
  },
  {
    id: 'view.rotUp90', label: '视图上转 90°', keys: 'Shift+↑', group: '视图旋转',
    match: (e) => e.key === 'ArrowUp' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey,
    run: (a) => a.rotateView(0, 90),
  },
  {
    id: 'view.rotDown90', label: '视图下转 90°', keys: 'Shift+↓', group: '视图旋转',
    match: (e) => e.key === 'ArrowDown' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey,
    run: (a) => a.rotateView(0, -90),
  },
  {
    id: 'view.panLeft', label: '向左平移视图', keys: 'Ctrl+←', group: '视图旋转',
    match: (e) => e.key === 'ArrowLeft' && e.ctrlKey,
    run: (a) => a.panView(-0.1, 0),
  },
  {
    id: 'view.panRight', label: '向右平移视图', keys: 'Ctrl+→', group: '视图旋转',
    match: (e) => e.key === 'ArrowRight' && e.ctrlKey,
    run: (a) => a.panView(0.1, 0),
  },
  {
    id: 'view.panUp', label: '向上平移视图', keys: 'Ctrl+↑', group: '视图旋转',
    match: (e) => e.key === 'ArrowUp' && e.ctrlKey,
    run: (a) => a.panView(0, 0.1),
  },
  {
    id: 'view.panDown', label: '向下平移视图', keys: 'Ctrl+↓', group: '视图旋转',
    match: (e) => e.key === 'ArrowDown' && e.ctrlKey,
    run: (a) => a.panView(0, -0.1),
  },

  // ============================================================
  // 窗口 / 文档
  // ============================================================
  { id: 'window.cycle', label: '切换文档（零件 / 装配体 / 工程图）', keys: 'Ctrl+Tab', group: '窗口', run: (a) => a.cycleDocument() },
  { id: 'window.hideShow', label: '隐藏 / 显示', keys: 'Tab', group: '窗口', scope: 'assembly', run: (a) => a.toggleTabVisibility() },

  // ============================================================
  // 草图（仅草图模式生效）
  // ============================================================
  { id: 'sk.line', label: '直线', keys: 'L', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('line') },
  { id: 'sk.circle', label: '圆', keys: 'C', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('circle') },
  { id: 'sk.arc', label: '圆弧', keys: 'A', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('arc') },
  { id: 'sk.rect', label: '矩形', keys: 'R', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('rect') },
  { id: 'sk.ellipse', label: '椭圆', keys: 'E', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('ellipse') },
  { id: 'sk.point', label: '点', keys: 'P', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('point') },
  { id: 'sk.polygon', label: '多边形', keys: 'N', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('polygon') },
  { id: 'sk.slot', label: '槽口', keys: 'O', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('slot') },
  { id: 'sk.spline', label: 'B 样条', keys: 'B', group: '草图', scope: 'sketch', run: (a) => a.setSketchTool('bspline') },
  { id: 'sk.trim', label: '剪裁实体（删除选中）', keys: 'T', group: '草图', scope: 'sketch', run: (a) => featureDialogs.deleteSketchSelection(a) },
  { id: 'sk.dim', label: '智能尺寸', keys: 'D', group: '草图', scope: 'sketch', run: (a) => featureDialogs.smartDimension(a) },
  {
    id: 'sk.exit',
    label: '退出草图',
    keys: 'Esc',
    group: '草图',
    scope: 'sketch',
    // 草图属性管理器（智能尺寸等）打开时按键归对话框，避免误退草图
    when: () => !document.querySelector('.pm') && !document.querySelector('.modal-mask'),
    run: (a) => a.escape(),
  },
  {
    id: 'sk.confirm',
    label: '确认并退出草图',
    keys: 'Enter',
    group: '草图',
    scope: 'sketch',
    when: () => !document.querySelector('.pm') && !document.querySelector('.modal-mask'),
    run: (a) => a.escape('confirm'),
  },
];

const byId = new Map(HOTKEYS.map((h) => [h.id, h]));

/** 菜单里显示快捷键文本（自定义覆盖优先；找不到就返回空串） */
export function sc(id: string): string {
  const h = byId.get(id);
  return h ? effectiveKeys(h) : '';
}

/** 帮助 > 快捷键一览 用的分组数据 */
export function hotkeyGroups(): { group: string; items: { label: string; keys: string }[] }[] {
  const order: string[] = [];
  const map = new Map<string, { label: string; keys: string }[]>();
  for (const h of HOTKEYS) {
    if (h.id === 'edit.redoAlt') continue; // 别名不重复展示
    if (!map.has(h.group)) {
      map.set(h.group, []);
      order.push(h.group);
    }
    map.get(h.group)!.push({ label: h.label, keys: effectiveKeys(h) });
  }
  return order.map((g) => ({ group: g, items: map.get(g)! }));
}

// ============================================================
// 匹配（解析/归一化在 ./hotkey-keys 纯模块，Node 可单测）
// ============================================================
function matches(h: HotkeyDef, e: KeyboardEvent): boolean {
  if (h.match) return h.match(e);
  return keysMatchEvent(effectiveKeys(h), e);
}

/** 供 UI 查询：某个键位是否有定义（用于提示） */
export function isBound(key: string): boolean {
  return HOTKEYS.some((h) => !h.match && effectiveKeys(h) === key);
}

// ============================================================
// 分发
// ============================================================
function inEditable(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable;
}

export function installHotkeys(app: App): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (inEditable(e.target)) return;

    // 模态框打开时只放行 Esc（模态框自己处理关闭），避免误触全局命令
    if (document.querySelector('.modal-mask')) {
      if (e.key === 'Escape') return;
      return;
    }

    for (const h of HOTKEYS) {
      if (!matches(h, e)) continue;
      // 作用域过滤
      if (h.scope === 'sketch' && app.mode !== 'sketch') continue;
      if (h.scope === 'assembly' && app.mode !== 'assembly') continue;
      if (h.scope === 'model' && app.mode !== 'model') continue;
      if (h.scope === 'drawing' && app.mode !== 'drawing') continue;
      if (h.when && !h.when(app)) continue;

      e.preventDefault();
      e.stopPropagation();
      try {
        h.run(app);
      } catch (err) {
        notify.err(`${h.label} 失败：${(err as Error).message}`);
      }
      return;
    }
  };

  window.addEventListener('keydown', onKey, { capture: true });
  return () => window.removeEventListener('keydown', onKey, { capture: true });
}
