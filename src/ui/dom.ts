/**
 * 极简 DOM 工具。不引入框架 —— 这个应用的 UI 更新都是"局部重绘"，
 * 手写足够，且没有构建体积与响应式系统的额外开销。
 */

type Attrs = Record<string, any>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') node.className = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(node.dataset, v);
      } else if (k in node) {
        (node as any)[k] = v;
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function svgEl(tag: string, attrs?: Attrs, ...children: (Node | string)[]): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function qs<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const n = root.querySelector(sel);
  if (!n) throw new Error(`找不到元素：${sel}`);
  return n as T;
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement | Window | Document,
  type: K | string,
  handler: (e: any) => void,
  opts?: AddEventListenerOptions
): () => void {
  node.addEventListener(type as any, handler, opts);
  return () => node.removeEventListener(type as any, handler, opts);
}

/** 数值输入框（带上下微调），返回元素与取值函数 */
export function numberField(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; unit?: string; disabled?: boolean } = {}
): { row: HTMLElement; input: HTMLInputElement; set: (v: number) => void } {
  const input = el('input', {
    class: 'inp',
    type: 'number',
    value: String(round(value)),
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 0.5,
    disabled: opts.disabled,
  }) as HTMLInputElement;

  const commit = () => {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) {
      v = value;
    }
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = String(round(v));
    onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      commit();
      input.blur();
    }
  });
  input.addEventListener('wheel', (e) => {
    if (document.activeElement !== input) return;
    e.preventDefault();
    const step = opts.step ?? 0.5;
    const v = (parseFloat(input.value) || 0) + ((e as WheelEvent).deltaY < 0 ? step : -step);
    input.value = String(round(v));
    commit();
  });

  const spin = el(
    'div',
    { class: 'spin' },
    el('button', { type: 'button', onClick: () => bump(1) }, '▲'),
    el('button', { type: 'button', onClick: () => bump(-1) }, '▼')
  );
  function bump(dir: number) {
    const step = opts.step ?? 0.5;
    let v = (parseFloat(input.value) || 0) + dir * step;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = String(round(v));
    commit();
  }

  const row = el(
    'div',
    { class: 'field' },
    el('label', { text: label }),
    el('div', { class: 'val' }, input, opts.unit ? el('span', { class: 'dim', text: opts.unit }) : null, spin)
  );

  return {
    row,
    input,
    set: (v: number) => {
      input.value = String(round(v));
    },
  };
}

export function selectField(
  label: string,
  value: string,
  options: { value: string; label: string }[],
  onChange: (v: string) => void
): { row: HTMLElement; select: HTMLSelectElement } {
  const select = el(
    'select',
    { class: 'inp' },
    ...options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === value }))
  ) as HTMLSelectElement;
  select.addEventListener('change', () => onChange(select.value));
  const row = el('div', { class: 'field' }, el('label', { text: label }), el('div', { class: 'val' }, select));
  return { row, select };
}

export function checkField(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void
): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.checked));
  const row = el('label', { class: 'chk' }, input, el('span', { text: label }));
  return { row, input };
}

export function textField(
  label: string,
  value: string,
  onChange: (v: string) => void
): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { class: 'inp wide', type: 'text', value }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.value));
  const row = el('div', { class: 'field' }, el('label', { text: label }), el('div', { class: 'val' }, input));
  return { row, input };
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  return el('button', { class: cls, type: 'button', onClick, text: label }) as HTMLButtonElement;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 可折叠区块 */
export function section(title: string, body: HTMLElement, open = true): HTMLElement {
  const wrap = el('div', { class: 'pm-section' });
  const chev = el('span', { class: 'chev', text: open ? '▼' : '▶' });
  const head = el('div', { class: 'pm-title' }, chev, el('span', { text: title }));
  const content = el('div', { class: 'pm-body' }, body);
  content.style.display = open ? '' : 'none';
  head.addEventListener('click', () => {
    const vis = content.style.display !== 'none';
    content.style.display = vis ? 'none' : '';
    chev.textContent = vis ? '▶' : '▼';
  });
  wrap.append(head, content);
  return wrap;
}
