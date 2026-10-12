/**
 * 底部状态栏。
 */
import { el, clear } from './dom';
import type { App } from '../app/app';

export function buildStatusbar(app: App, host: HTMLElement): void {
  const led = el('span', { class: 'led' });
  const text = el('span', { text: '' });
  const detail = el('span', { class: 'dim', text: '' });

  const render = () => {
    const s = app.status;
    led.className = `led ${s.kind}`;
    text.textContent = s.text;
    detail.textContent = s.detail ?? '';
    clear(host);
    host.appendChild(el('div', { class: `sb ${s.kind}` }, led, text));
    host.appendChild(el('div', { class: 'sb spacer' }));
    if (s.detail) {
      host.appendChild(el('div', { class: 'sb' }, detail));
    }
  };

  render();
  app.on('status', render);
}
