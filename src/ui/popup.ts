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
  /** 左侧色块（CSS 颜色串，如 '#d9432f'）—— 用于外观色板 */
  color?: string;
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

/**
 * 当前所有打开中的弹出菜单的关闭函数（`openCount` 的替代，同时能真正清理监听器）。
 * ⚠️ 关闭**必须**走各自的 close()——它负责摘掉 document 上的 away/onKey 捕获监听器。
 * 直接 `box.remove()` 会留下悬空监听器（状态泄漏）。
 */
const openClosers = new Set<() => void>();

/** 打开一个弹出菜单，返回关闭函数 */
export function openPopup(items: PopupItem[], x: number, y: number, opts: PopupOptions = {}): () => void {
  const box = el('div', { class: `dropdown ${opts.cls ?? ''}`.trim() });
  if (opts.minWidth) box.style.minWidth = `${opts.minWidth}px`;
  // 子菜单挂在 document.body（renderInto 内），关闭时必须一并摘除，否则残留成「幽灵菜单」
  const subs: HTMLElement[] = [];
  renderInto(box, items, () => close(), subs);

  document.body.appendChild(box);

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
    openClosers.delete(close);
    box.remove();
    for (const s of subs) s.remove();
    document.removeEventListener('mousedown', away, true);
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const away = (e: MouseEvent) => {
    const t = e.target as Node;
    // 点在自己（含自己的子菜单）上不算离开；点别的下拉/面板则关闭
    if (box.contains(t) || subs.some((s) => s.contains(t))) return;
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

  openClosers.add(close);
  return close;
}

export function popupOpen(): boolean {
  return openClosers.size > 0;
}

/** 关闭所有弹出菜单（走各自的 close，避免监听器泄漏） */
export function closeAllPopups(): void {
  for (const close of [...openClosers]) close();
}

/** 打开一个「带顶部快捷方式栏」的上下文菜单 */
export function openContextMenu(
  quick: { icon: string; label: string; run: () => void }[],
  items: PopupItem[],
  x: number,
  y: number
): () => void {
  const box = el('div', { class: 'dropdown ctx-menu' });
  // 子菜单挂在 document.body（renderInto 内），关闭时必须一并摘除，否则残留成「幽灵菜单」
  const subs: HTMLElement[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openClosers.delete(close);
    box.remove();
    for (const s of subs) s.remove();
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
  renderInto(list, items, close, subs);

  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  box.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;

  const away = (e: MouseEvent) => {
    const t = e.target as Node;
    // 点在自己（含自己的子菜单）上不算离开；点别的下拉/面板则关闭
    if (box.contains(t) || subs.some((s) => s.contains(t))) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // 与 openPopup 一致：Esc 只归菜单，不再向下传播触发工具取消等命令
      e.stopPropagation();
      close();
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  openClosers.add(close);
  return close;
}

function renderInto(box: HTMLElement, items: PopupItem[], closeSelf: () => void, subs?: HTMLElement[]): void {
  for (const it of items) {
    if (it.sep) {
      box.appendChild(el('div', { class: 'dd-sep' }));
      continue;
    }
    const hasSub = !!it.submenu?.length;
    const btn = el('button', {
      class: `dd-item ${it.disabled ? 'disabled' : ''} ${it.checked ? 'checked' : ''}`.trim(),
      type: 'button',
      title: it.tip ?? it.label ?? '',
    });
    btn.appendChild(
      el(
        'span',
        { class: `dd-check ${it.checked ? 'on' : ''}` },
        // 单选项用实心圆、复选项用对勾（此前分支写反顺序，导致 radio 永远显示 ✓）
        it.checked ? (it.radio ? '●' : '✓') : ''
      )
    );
    if (it.color) {
      btn.appendChild(el('span', { class: 'dd-swatch', style: `background:${it.color}` }));
    } else {
      btn.appendChild(el('span', { class: 'dd-icon', html: it.icon ? icon(it.icon, 16) : '' }));
    }
    btn.appendChild(el('span', { class: 'dd-label', text: it.label ?? '' }));
    if (it.sc) btn.appendChild(el('span', { class: 'sc', text: it.sc }));
    if (hasSub) btn.appendChild(el('span', { class: 'dd-arrow', text: '▸' }));

    if (hasSub && !it.disabled) {
      let sub: HTMLElement | null = null;
      const closeSub = () => {
        if (!sub) return;
        sub.remove();
        if (subs) {
          const i = subs.indexOf(sub);
          if (i >= 0) subs.splice(i, 1);
        }
        sub = null;
      };
      const openSub = () => {
        if (sub) return;
        const box2 = el('div', { class: 'dropdown dd-sub' });
        sub = box2;
        // 本次渲染期间新建的子菜单（递归 push 进同一个数组）→ 用于判定「指针进了下级」
        const before = subs ? subs.length : 0;
        renderInto(box2, it.submenu!, closeSelf, subs);
        subs?.push(box2);
        document.body.appendChild(box2);
        const r = btn.getBoundingClientRect();
        const sr = box2.getBoundingClientRect();
        box2.style.left = `${Math.min(r.right - 4, window.innerWidth - sr.width - 6)}px`;
        box2.style.top = `${Math.min(r.top - 4, window.innerHeight - sr.height - 6)}px`;
        // 指针直接从子菜单移走（不经过父项）时也要收起，否则子菜单会幽灵残留。
        // 下级子菜单挂在 body 上、不是 box2 的 DOM 后代，所以要按「本次之后新建的 sub」判归属。
        box2.addEventListener('mouseleave', (e) => {
          const to = e.relatedTarget as HTMLElement | null;
          if (to && (btn.contains(to) || box2.contains(to))) return;
          if (to && subs && subs.slice(before).some((s) => s.contains(to))) return;
          closeSub();
        });
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
