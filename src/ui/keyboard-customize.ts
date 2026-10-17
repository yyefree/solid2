/**
 * 自定义键盘对话框（SolidWorks：工具 → 自定义 → 键盘）。
 *
 * 左列分组、中列命令、右列「当前快捷键」；点快捷键单元格进入捕获模式，
 * 直接按新组合键即可重映射；冲突（已被别的命令占用）时给出 SW 式提示并拒绝。
 * 覆盖写 localStorage（`src/app/hotkey-keys.ts` 的 hotkeyOverrides），
 * 菜单文本 / 快捷键一览 / 实际分发读同一份数据，改完立即生效。
 */
import { el, clear } from './dom';
import { modal, notify } from './toast';
import type { AppApi } from '../app/app-api';
import { hotkeyList, setHotkeyOverride, resetHotkey, resetAllHotkeys, eventToKeys, hotkeyOverrides } from '../app/hotkeys';

interface Row {
  id: string;
  label: string;
  keys: string;
}

export function openKeyboardCustomize(app: AppApi): void {
  void app;
  const rows: Row[] = hotkeyList().map((h) => ({ id: h.id, label: h.label, keys: h.keys }));
  let filterText = '';

  const body = el('div', { class: 'col kb-custom' });
  const head = el('div', { class: 'kb-head' },
    el('span', { text: '命令' }),
    el('span', { text: '当前快捷键' })
  );
  const list = el('div', { class: 'kb-list' });

  const renderRows = () => {
    clear(list);
    const q = filterText.trim().toLowerCase();
    let lastGroup = '';
    for (const h of hotkeyList()) {
      if (q && !h.label.toLowerCase().includes(q) && !h.keys.toLowerCase().includes(q)) continue;
      if (h.group !== lastGroup) {
        lastGroup = h.group;
        list.appendChild(el('div', { class: 'kb-group', text: h.group }));
      }
      const row = rows.find((r) => r.id === h.id);
      if (!row) continue;
      const keyBtn = el('button', {
        class: 'kb-key',
        type: 'button',
        text: h.keys || '无',
        title: '点击后直接按新的快捷键组合（Esc 取消）',
      });
      let capturing = false;
      let applied: string | null = null;
      const stopCapture = () => {
        capturing = false;
        keyBtn.classList.remove('capturing');
        // 有新绑定就显示新键位；否则回显当前生效键位（避免用渲染时的旧快照）
        keyBtn.textContent = (applied ?? (hotkeyOverrides.get(h.id) ?? h.defaultKeys)) || '无';
        window.removeEventListener('keydown', onCap, true);
      };
      const onCap = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          applied = null;
          stopCapture();
          return;
        }
        const keys = eventToKeys(e);
        if (!keys) return; // 纯修饰键 / 浏览器保留键，继续等
        try {
          setHotkeyOverride(h.id, keys);
          row.keys = keys;
          applied = keys;
          notify.ok(`${h.label} → ${keys}`);
        } catch (err) {
          applied = null;
          notify.err((err as Error).message);
        }
        stopCapture();
      };
      keyBtn.addEventListener('click', () => {
        if (capturing) return;
        capturing = true;
        keyBtn.classList.add('capturing');
        keyBtn.textContent = '请按新快捷键…';
        window.addEventListener('keydown', onCap, true);
      });
      const resetBtn = el('button', {
        class: 'kb-reset',
        type: 'button',
        text: '恢复默认',
        title: h.defaultKeys ? `默认：${h.defaultKeys}` : '该命令默认无快捷键',
      });
      resetBtn.addEventListener('click', () => {
        resetHotkey(h.id);
        row.keys = h.defaultKeys;
        keyBtn.textContent = h.defaultKeys || '无';
        notify.ok(`${h.label} 已恢复默认`);
      });
      list.appendChild(el('div', { class: 'kb-row', dataset: { kb: h.id } },
        el('span', { class: 'kb-label', text: h.label }), keyBtn, resetBtn));
    }
    if (!list.children.length) list.appendChild(el('div', { class: 'kb-empty', text: '没有匹配的命令' }));
  };

  const search = el('input', {
    class: 'kb-search',
    type: 'text',
    placeholder: '搜索命令或快捷键…',
    onInput: (e: Event) => {
      filterText = (e.target as HTMLInputElement).value;
      renderRows();
    },
  });

  body.append(
    el('div', { class: 'hint', text: '点击快捷键单元格，然后直接按新的组合键。快捷键保存在本机，菜单与 dispatcher 即时生效。' }),
    search,
    head,
    list
  );

  modal({
    title: '自定义键盘',
    body,
    width: 560,
    actions: [
      {
        label: '全部恢复默认',
        onClick: () => {
          resetAllHotkeys();
          notify.ok('已恢复 SolidWorks 默认键位');
          renderRows();
          return false; // 不关闭对话框
        },
      },
      { label: '关闭', primary: true },
    ],
  });

  renderRows();
}
