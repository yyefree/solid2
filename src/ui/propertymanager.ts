/**
 * PropertyManager（SolidWorks「属性管理器」的宿主形态）。
 *
 * SolidWorks 编辑特征时，特征参数不弹居中模态框，而是显示在左侧
 * 「属性管理器」选项卡里（非模态、内嵌、底部 ✓/✗ 确认）。
 *
 * 接线方式（对 dialog 代码零侵入）：
 *   - dialogs.ts 等把 `modal({ ..., host: 'pm' })` 即可走本宿主；
 *   - toast.ts 的 `modal()` 通过 `setPropertyManagerOpener` 注入切换，
 *     没有宿主（如单元测试）时自动退化为普通模态框。
 *
 * 布局：左面板「属性管理器」body 内是两个叠放容器——.pp-host（常规属性
 * 面板内容）与 .pm-host（本模块的 PropertyManager 内容），二者互斥显示，
 * 关闭 PropertyManager 后原属性面板内容原样恢复（无需重渲染）。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import { setPropertyManagerOpener, type ModalOptions } from './toast';

let ppHost: HTMLElement | null = null;
let pmHost: HTMLElement | null = null;
let activateTab: (() => void) | null = null;
let closeCurrent: (() => void) | null = null;

/** 绑定宿主（main.ts 初始化时调用一次） */
export function bindPropertyManager(opts: {
  /** 常规属性面板容器 */
  pp: HTMLElement;
  /** PropertyManager 容器（与 pp 同父级叠放） */
  pm: HTMLElement;
  /** 打开时激活「属性管理器」选项卡 */
  activate: () => void;
}): void {
  ppHost = opts.pp;
  pmHost = opts.pm;
  activateTab = opts.activate;
  setPropertyManagerOpener((o: ModalOptions) => openInPropertyManager(o));
}

/** 是否有可用宿主 */
function available(): boolean {
  return !!pmHost;
}

/** 把 opts 渲染进 PropertyManager；返回关闭函数 */
function openInPropertyManager(opts: ModalOptions): (() => void) | null {
  if (!available() || !pmHost || !ppHost) return null;
  closeCurrent?.();

  const box = el('div', { class: 'pm' });
  const head = el(
    'div',
    { class: 'pm-head' },
    el('span', { class: 'pm-title', text: opts.title }),
    el('span', { class: 'pm-kind', text: '属性管理器' })
  );
  const bodyNode = el('div', { class: 'pm-body' });
  if (typeof opts.body === 'string') bodyNode.innerHTML = opts.body;
  else bodyNode.appendChild(opts.body);
  const foot = el('div', { class: 'pm-foot' });

  const close = () => {
    box.remove();
    document.removeEventListener('keydown', esc, true);
    pmHost!.style.display = 'none';
    ppHost!.style.display = '';
    if (closeCurrent === close) closeCurrent = null;
    opts.onClose?.();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const actions = opts.actions ?? [{ label: '关闭', primary: true }];
  for (const a of actions) {
    foot.appendChild(
      el(
        'button',
        {
          class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`.trim(),
          type: 'button',
          text: a.label,
          onClick: () => {
            const r = a.onClick?.();
            if (r !== false) close();
          },
        }
      )
    );
  }

  box.append(head, bodyNode, foot);
  clear(pmHost);
  pmHost.appendChild(box);
  activateTab?.();
  ppHost.style.display = 'none';
  pmHost.style.display = '';
  document.addEventListener('keydown', esc, true);
  closeCurrent = close;
  return close;
}

/** 关闭当前打开的 PropertyManager（切文档 / 退出草图时用） */
export function closePropertyManager(): void {
  closeCurrent?.();
}

/** 当前是否有 PropertyManager 打开 */
export function propertyManagerOpen(): boolean {
  return !!closeCurrent;
}

export const PM_ICON_CHECK = icon('check', 14);
