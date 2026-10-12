/**
 * 轻量提示（toast）与模态框。
 */
import { el, clear, on } from './dom';

let wrap: HTMLElement | null = null;

function ensureWrap(): HTMLElement {
  if (!wrap) {
    wrap = el('div', { class: 'toast-wrap' });
    document.body.appendChild(wrap);
  }
  return wrap;
}

export function toast(message: string, kind: 'info' | 'ok' | 'err' = 'info', ms = 2600): void {
  const node = el('div', { class: `toast ${kind === 'info' ? '' : kind}`.trim(), text: message });
  ensureWrap().appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(12px)';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

export const notify = {
  info: (m: string) => toast(m, 'info'),
  ok: (m: string) => toast(m, 'ok'),
  err: (m: string) => toast(m, 'err', 4200),
};

export interface ModalOptions {
  title: string;
  body: HTMLElement | string;
  /** 底部按钮，返回 true 表示关闭 */
  actions?: { label: string; primary?: boolean; danger?: boolean; onClick?: () => boolean | void }[];
  width?: number;
  onClose?: () => void;
}

export function modal(opts: ModalOptions): () => void {
  const mask = el('div', { class: 'modal-mask' });
  const box = el('div', { class: 'modal' });
  if (opts.width) box.style.minWidth = `${opts.width}px`;

  const bodyNode = el('div', { class: 'modal-body' });
  if (typeof opts.body === 'string') bodyNode.innerHTML = opts.body;
  else bodyNode.appendChild(opts.body);

  const foot = el('div', { class: 'modal-foot' });
  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', esc);
    opts.onClose?.();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  const actions = opts.actions ?? [{ label: '关闭', primary: true }];
  for (const a of actions) {
    foot.appendChild(
      el('button', {
        class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`.trim(),
        type: 'button',
        text: a.label,
        onClick: () => {
          const r = a.onClick?.();
          if (r !== false) close();
        },
      })
    );
  }

  box.append(el('div', { class: 'modal-head' }, el('span', { text: opts.title })), bodyNode, foot);
  mask.appendChild(box);
  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', esc);
  document.body.appendChild(mask);
  return close;
}

/** 单值输入对话框 */
export function promptNumber(
  title: string,
  label: string,
  value: number,
  onOk: (v: number) => void,
  unit = 'mm'
): void {
  const input = el('input', { class: 'inp', type: 'number', value: String(value), step: '0.5' }) as HTMLInputElement;
  input.style.width = '120px';
  input.style.textAlign = 'right';
  const body = el(
    'div',
    { class: 'field' },
    el('label', { text: label }),
    el('div', { class: 'val' }, input, el('span', { class: 'dim', text: unit }))
  );
  const close = modal({
    title,
    body,
    actions: [
      { label: '取消' },
      {
        label: '确定',
        primary: true,
        onClick: () => {
          const v = parseFloat(input.value);
          if (Number.isFinite(v)) onOk(v);
        },
      },
    ],
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 30);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) onOk(v);
      close();
    }
  });
}

/** 确认对话框 */
export function confirmDialog(title: string, message: string, onYes: () => void): void {
  modal({
    title,
    body: el('div', { text: message }),
    actions: [
      { label: '取消' },
      { label: '确定', primary: true, onClick: onYes },
    ],
  });
}

export function tableModal(title: string, headers: string[], rows: (string | number)[][], note?: string): void {
  const table = el('table');
  table.appendChild(
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h }))))
  );
  const tbody = el('tbody');
  for (const r of rows) {
    tbody.appendChild(el('tr', {}, ...r.map((c) => el('td', { text: String(c) }))));
  }
  table.appendChild(tbody);
  const body = el('div', { class: 'col' }, table, note ? el('div', { class: 'hint', text: note }) : null);
  modal({ title, body, actions: [{ label: '关闭', primary: true }], width: 520 });
}

export { on, clear };
