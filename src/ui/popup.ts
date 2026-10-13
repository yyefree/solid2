/**
 * 通用弹出菜单 —— 菜单栏、上下文菜单、工具栏下拉共用一套渲染。
 * 支持：图标、快捷键文本、勾选、单选、禁用、分隔线、二级子菜单。
 */
import { el } from './dom';
import { icon } from './icons';

export interface PopupItem {
  label?: string;
  icon?: string;
  /** 快捷键显示文本 */
  sc?: string;
  /** 勾选标记（复选） */
  checked?: boolean;
  /** 单选标记 */
  radio?: boolean;
  disabled?: boolean;
  /** 分隔线（忽略其它字段） */
  sep?: boolean;
  /** 右侧显示 ▸ 的子菜单 */
  submenu?: PopupItem[];
  run?: () => void;
  /** 自定义标题（title 属性） */
  tip?: string;
}

export interface PopupOptions {
  /** 附加类名（如 'ctx-menu'） */
  cls?: string;
  minWidth?: number;
  /** 关闭时回调 */
  onClose?: () => void;
}

let openCount = 0;

/** 打开一个弹出菜单，返回关闭函数 */export function openPopup(items: PopupItem[], x: number, y: number, opts: PopupOptions = {}): () => void {
  const box = el('div', { class: `dropdown ${opts.cls ?? ''}`.trim() });
  if (opts.minWidth) box.style.minWidth = `${opts.minWidth}px`;
  renderInto(box, items, () => close());

  document.body.appendChild(box);
  openCount++;

  // 位置修正：不越出窗口
  const r = box.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 6);
  const top = Math.min(y, window.innerHeight - r.height - 6);
  box.style.left = `${Math.max(4, left)}px`;
  box.style.top = `${Math.max(4, top)}px`;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    box.remove();
    document.removeEventListener('mousedown', away, true);
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const away = (e: MouseEvent) => {
    if (box.contains(e.target as Node)) return;
    // 点在自己的子菜单上不算离开
    const t = e.target as HTMLElement;
    if (t.closest?.('.dropdown')) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  return close;
}

export function popupOpen(): boolean {
  return !!document.querySelector('.dropdown');
}

export function closeAllPopups(): void {
  document.querySelectorAll('.dropdown').forEach((d) => d.remove());
}

/** 把菜单项渲染进给定容器（上下文菜单要自己在顶部插一条快捷方式栏时用） */
export function renderPopupItems(box: HTMLElement, items: PopupItem[], closeSelf: () => void): void {
  renderInto(box, items, closeSelf);
}

/** 打开一个「带顶部快捷方式栏」的上下文菜单 */
export function openContextMenu(
  quick: { icon: string; label: string; run: () => void }[],
  items: PopupItem[],
  x: number,
  y: number
): () => void {
  const box = el('div', { class: 'dropdown ctx-menu' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    box.remove();
    document.removeEventListener('mousedown', away, true);
    document.removeEventListener('keydown', onKey, true);
  };

  if (quick.length) {
    const bar = el('div', { class: 'ctx-quick' });
    for (const q of quick) {
      bar.appendChild(
        el(
          'button',
          {
            class: 'ctx-quick-btn',
            type: 'button',
            title: q.label,
            onClick: () => {
              close();
              q.run();
            },
          },
          el('span', { class: 'ic', html: icon(q.icon, 20) })
        )
      );
    }
    box.appendChild(bar);
  }
  const list = el('div', { class: 'ctx-list' });
  box.appendChild(list);
  renderInto(list, items, close);

  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  box.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;

  const away = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (box.contains(t) || t.closest?.('.dropdown')) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

function renderInto(box: HTMLElement, items: PopupItem[], closeSelf: () => void): void {  for (const it of items) {
    if (it.sep) {
      box.appendChild(el('div', { class: 'dd-sep' }));
      continue;
    }
    const hasSub = !!it.submenu?.length;
    const btn = el('button', {
      class: `dd-item ${it.disabled ? 'disabled' : ''} ${it.checked || it.radio ? 'checked' : ''}`.trim(),
      type: 'button',
      title: it.tip ?? it.label ?? '',
    });
    btn.appendChild(
      el(
        'span',
        { class: `dd-check ${it.checked ? 'on' : ''}` },
        it.checked ? '✓' : it.radio && it.checked ? '●' : ''
      )
    );
    btn.appendChild(el('span', { class: 'dd-icon', html: it.icon ? icon(it.icon, 16) : '' }));
    btn.appendChild(el('span', { class: 'dd-label', text: it.label ?? '' }));
    if (it.sc) btn.appendChild(el('span', { class: 'sc', text: it.sc }));
    if (hasSub) btn.appendChild(el('span', { class: 'dd-arrow', text: '▸' }));

    if (hasSub) {
      let sub: HTMLElement | null = null;
      const openSub = () => {
        if (sub) return;
        sub = el('div', { class: 'dropdown dd-sub' });
        renderInto(sub, it.submenu!, closeSelf);
        document.body.appendChild(sub);
        const r = btn.getBoundingClientRect();
        const sr = sub.getBoundingClientRect();
        sub.style.left = `${Math.min(r.right - 4, window.innerWidth - sr.width - 6)}px`;
        sub.style.top = `${Math.min(r.top - 4, window.innerHeight - sr.height - 6)}px`;
      };
      const closeSub = () => {
        sub?.remove();
        sub = null;
      };
      btn.addEventListener('mouseenter', openSub);
      btn.addEventListener('mouseleave', (e) => {
        const to = e.relatedTarget as HTMLElement | null;
        if (to && sub?.contains(to)) return;
        closeSub();
      });
    } else if (it.run) {
      btn.addEventListener('click', () => {
        closeSelf();
        it.run!();
      });
    }
    if (it.disabled) btn.addEventListener('click', (e) => e.stopPropagation());
    box.appendChild(btn);
  }
}
