/**
 * 视图立方 —— 点击快速切换视角。
 */
import type { App } from '../app/app';
import type { ViewDir } from '../view/viewport';

export function buildViewcube(app: App, host: HTMLElement): void {
  const dirs: { dir: ViewDir; label: string; x: number; y: number }[] = [
    { dir: 'front', label: '前', x: 46, y: 62 },
    { dir: 'back', label: '后', x: 46, y: 18 },
    { dir: 'top', label: '上', x: 46, y: 40 },
    { dir: 'bottom', label: '下', x: 46, y: 86 },
    { dir: 'left', label: '左', x: 24, y: 62 },
    { dir: 'right', label: '右', x: 68, y: 62 },
    { dir: 'iso', label: 'ISO', x: 74, y: 26 },
  ];

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '92');
  svg.setAttribute('height', '92');
  svg.setAttribute('viewBox', '0 0 92 92');

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', '92');
  bg.setAttribute('height', '92');
  bg.setAttribute('rx', '4');
  bg.setAttribute('fill', 'rgba(255,255,255,0.92)');
  bg.setAttribute('stroke', '#b9c3ce');
  svg.appendChild(bg);

  for (const d of dirs) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.style.cursor = 'pointer';
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(d.x - 10));
    rect.setAttribute('y', String(d.y - 8));
    rect.setAttribute('width', '20');
    rect.setAttribute('height', '16');
    rect.setAttribute('rx', '2');
    rect.setAttribute('fill', 'transparent');
    g.appendChild(rect);
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', String(d.x));
    txt.setAttribute('y', String(d.y + 3));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('font-size', '10');
    txt.setAttribute('fill', '#4a5568');
    txt.textContent = d.label;
    g.appendChild(txt);
    g.addEventListener('click', () => app.setView(d.dir));
    g.addEventListener('mouseenter', () => rect.setAttribute('fill', '#e8eef7'));
    g.addEventListener('mouseleave', () => rect.setAttribute('fill', 'transparent'));
    svg.appendChild(g);
  }

  host.appendChild(svg);
}
