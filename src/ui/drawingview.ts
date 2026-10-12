/**
 * 工程图视图宿主 —— 把 Drawing 的 SVG 渲染到页面，并处理交互式尺寸标注。
 *
 * 交互：标注模式下点击一条投影边 → 长度标注；Shift+点击另一条边 → 两条边最近端点的距离标注；
 * 左键/右键点击已有标注 → 删除。事件用委托绑定在宿主上，重绘不会丢失。
 */
import { el, clear } from './dom';
import { notify } from './toast';
import type { App } from '../app/app';

export function buildDrawingView(app: App, host: HTMLElement): void {
  const render = () => {
    clear(host);
    const d = app.drawing;
    if (!d || !d.views.length) {
      host.appendChild(el('div', { class: 'hint', text: '没有工程图视图' }));
      host.classList.remove('dim-mode');
      return;
    }
    const svgHtml = d.toSVG();
    const wrap = el('div', { class: 'sheet', style: { width: `${d.sheet.w}mm`, height: `${d.sheet.h}mm` } });
    wrap.innerHTML = svgHtml;
    host.appendChild(wrap);
    host.classList.toggle('dim-mode', app.dimMode);
  };

  // 事件委托：先处理标注删除，再处理边线点击
  host.addEventListener('click', (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const dimEl = target.closest('.d-dim') as HTMLElement | null;
    if (dimEl?.dataset.dim) {
      app.removeDrawingDim(dimEl.dataset.vw!, dimEl.dataset.dim);
      return;
    }
    const runEl = target.closest('.d-run') as HTMLElement | null;
    if (runEl?.dataset.re !== undefined) {
      app.placeDrawingDimension(runEl.dataset.vw!, Number(runEl.dataset.re), (ev as MouseEvent).shiftKey);
    }
  });

  host.addEventListener('contextmenu', (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const gdtEl = target.closest('.d-gdt') as HTMLElement | null;
    if (gdtEl?.dataset.gdt) {
      ev.preventDefault();
      const d = app.drawing;
      if (d) {
        d.removeGdt(gdtEl.dataset.gdt);
        render();
        notify.info('已删除形位公差标注');
      }
      return;
    }
    const dimEl = target.closest('.d-dim') as HTMLElement | null;
    if (dimEl?.dataset.dim) {
      ev.preventDefault();
      app.removeDrawingDim(dimEl.dataset.vw!, dimEl.dataset.dim);
    }
  });

  render();
  app.on('drawing', render);
  app.on('mode', () => {
    if (app.mode === 'drawing') render();
  });
}
