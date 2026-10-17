/**
 * 放大镜（SolidWorks: G 键开关）。
 *
 * 实现方式：不去重渲染一遍场景，而是把主画布当前像素按区域放大贴到一个小圆盘上。
 * CAD 场景绝大多数时间静止（按需重绘），像素级放大既零开销又与画面完全一致。
 */
import { el } from './dom';
import type { AppApi } from '../app/app-api';

let host: HTMLElement | null = null;
let lens: HTMLCanvasElement | null = null;
let moveHandler: ((e: PointerEvent) => void) | null = null;
let raf = 0;

const LENS = 168; // 放大镜直径（CSS 像素）
const ZOOM = 2.2; // 放大倍率

export function magnifierActive(): boolean {
  return !!host;
}

export function toggleMagnifier(app: AppApi): void {
  if (host) {
    closeMagnifier();
    app.setStatus('放大镜：关闭', 'ok');
    return;
  }
  openMagnifier(app);
}

function openMagnifier(app: AppApi): void {
  const canvas = app.viewport.renderer.domElement;
  const wrap = canvas.parentElement;
  if (!wrap) return;

  const cv = el('canvas', { class: 'magnifier-canvas' }) as HTMLCanvasElement;
  cv.width = LENS;
  cv.height = LENS;
  const box = el('div', { class: 'magnifier' }, cv);
  wrap.appendChild(box);
  host = box;
  lens = cv;

  moveHandler = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
    box.style.display = inside ? '' : 'none';
    if (!inside) return;

    // 放大镜跟随光标，但不越出视口
    const wrapRect = wrap.getBoundingClientRect();
    const cx = e.clientX - wrapRect.left;
    const cy = e.clientY - wrapRect.top;
    box.style.left = `${Math.min(Math.max(cx + 18, 4), wrapRect.width - LENS - 4)}px`;
    box.style.top = `${Math.min(Math.max(cy - LENS - 18, 4), wrapRect.height - LENS - 4)}px`;

    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => draw(canvas, cv, x, y, rect));
  };
  window.addEventListener('pointermove', moveHandler, { passive: true });
  app.setStatus('放大镜：移动鼠标查看细节（G 关闭）', 'busy');
}

function draw(src: HTMLCanvasElement, dst: HTMLCanvasElement, x: number, y: number, rect: DOMRect): void {
  const ctx = dst.getContext('2d');
  if (!ctx) return;
  const sw = rect.width / ZOOM;
  const sh = rect.height / ZOOM;
  // 源画布像素尺寸与 CSS 尺寸可能不一致（devicePixelRatio），需要换算
  const kx = src.width / Math.max(rect.width, 1);
  const ky = src.height / Math.max(rect.height, 1);
  const sx = (x - sw / 2) * kx;
  const sy = (y - sh / 2) * ky;

  ctx.fillStyle = '#e9eef4';
  ctx.fillRect(0, 0, dst.width, dst.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(dst.width / 2, dst.height / 2, dst.width / 2 - 3, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(src, sx, sy, sw * kx, sh * ky, 0, 0, dst.width, dst.height);
  // 十字准星
  ctx.strokeStyle = 'rgba(30,90,160,.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(dst.width / 2, 8);
  ctx.lineTo(dst.width / 2, dst.height - 8);
  ctx.moveTo(8, dst.height / 2);
  ctx.lineTo(dst.width - 8, dst.height / 2);
  ctx.stroke();
  ctx.restore();
}

export function closeMagnifier(): void {
  if (moveHandler) window.removeEventListener('pointermove', moveHandler);
  moveHandler = null;
  cancelAnimationFrame(raf);
  host?.remove();
  host = null;
  lens = null;
}
