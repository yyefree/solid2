/**
 * 参考三重轴（SolidWorks Reference Triad）—— 图形区左下角。
 * 三个轴向随相机实时投影，颜色沿用 CAD 约定：X 红 / Y 绿 / Z 蓝。
 */
import type { AppApi } from '../app/app-api';
import * as THREE from 'three';

const SIZE = 84;
const LEN = 26;

export function buildTriad(app: AppApi, host: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('class', 'triad-svg');

  const cx = SIZE / 2;
  const cy = SIZE / 2;

  // 背景圆盘（SolidWorks 三重轴底部的浅色圆）
  const disc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  disc.setAttribute('cx', String(cx));
  disc.setAttribute('cy', String(cy));
  disc.setAttribute('r', String(SIZE / 2 - 3));
  disc.setAttribute('fill', 'rgba(255,255,255,0.72)');
  disc.setAttribute('stroke', 'rgba(120,140,160,0.45)');
  svg.appendChild(disc);

  const axes: { key: 'x' | 'y' | 'z'; color: string; dir: THREE.Vector3 }[] = [
    { key: 'x', color: '#d9432f', dir: new THREE.Vector3(1, 0, 0) },
    { key: 'y', color: '#2e9e5b', dir: new THREE.Vector3(0, 1, 0) },
    { key: 'z', color: '#2b7de9', dir: new THREE.Vector3(0, 0, 1) },
  ];

  const parts = axes.map((a) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('stroke', a.color);
    line.setAttribute('stroke-width', '2.2');
    line.setAttribute('stroke-linecap', 'round');
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('fill', a.color);
    label.setAttribute('font-size', '11');
    label.setAttribute('font-weight', '700');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = a.key;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '2.4');
    dot.setAttribute('fill', a.color);
    svg.appendChild(line);
    svg.appendChild(dot);
    svg.appendChild(label);
    return { a, line, label, dot };
  });

  const hub = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hub.setAttribute('cx', String(cx));
  hub.setAttribute('cy', String(cy));
  hub.setAttribute('r', '3');
  hub.setAttribute('fill', '#3a4756');
  svg.appendChild(hub);

  host.appendChild(svg);

  const m3 = new THREE.Matrix3();
  const tmp = new THREE.Vector3();

  const update = () => {
    const cam = app.viewport.camera;
    cam.updateMatrixWorld();
    m3.setFromMatrix4(cam.matrixWorldInverse);

    // 先算三个轴，按视深排序（远的先画，近的盖在上面）
    const projected = parts.map((p) => {
      tmp.copy(p.a.dir).applyMatrix3(m3);
      const sx = tmp.x;
      const sy = -tmp.y;
      const depth = tmp.z; // 越大越靠近观察者
      return { ...p, sx, sy, depth };
    });
    projected.sort((a, b) => a.depth - b.depth);

    for (const p of projected) {
      const ex = cx + p.sx * LEN;
      const ey = cy + p.sy * LEN;
      p.line.setAttribute('x1', String(cx));
      p.line.setAttribute('y1', String(cy));
      p.line.setAttribute('x2', String(ex));
      p.line.setAttribute('y2', String(ey));
      p.dot.setAttribute('cx', String(ex));
      p.dot.setAttribute('cy', String(ey));
      p.label.setAttribute('x', String(cx + p.sx * (LEN + 11)));
      p.label.setAttribute('y', String(cy + p.sy * (LEN + 11)));
      // 朝向观察者的轴加粗，符合 SolidWorks 观感
      p.line.setAttribute('stroke-width', p.depth > 0.35 ? '3' : '2');
    }
  };

  update();
  app.viewport.controls.addEventListener('change', update);
  app.on('view', update);
  app.on('mode', update);
}
