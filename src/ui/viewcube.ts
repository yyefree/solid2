/**
 * 视图立方体（SolidWorks View Orientation Cube）—— 右上角。
 *
 * 与 SolidWorks 一致：
 *   - 立方体随当前相机实时旋转，三个朝向观察者的面可见；
 *   - 点击可见面 → 标准正交视图（前/后/左/右/上/下）；
 *   - 点击棱 / 角 → 等轴测视图；
 *   - 下方「主页」按钮 → 回到等轴测默认视图。
 */
import type { App } from '../app/app';
import * as THREE from 'three';

const SIZE = 116; // svg 边长
const CX = SIZE / 2;
const CY = SIZE / 2 + 4;
const SCALE = 30; // 立方体半边长在屏幕上的像素

// 立方体 8 个角（单位立方体，居中于原点）
const C: [number, number, number][] = [
  [-1, -1, -1], // 0
  [1, -1, -1], // 1
  [1, 1, -1], // 2
  [-1, 1, -1], // 3
  [-1, -1, 1], // 4
  [1, -1, 1], // 5
  [1, 1, 1], // 6
  [-1, 1, 1], // 7
];

interface FaceDef {
  idx: number[];
  normal: [number, number, number];
  dir: string;
  label: string;
}
// 六面：外法向 + 对应标准视图方向 + 屏幕标注
const FACES: FaceDef[] = [
  { idx: [0, 1, 2, 3], normal: [0, 0, -1], dir: 'front', label: '前' },
  { idx: [4, 5, 6, 7], normal: [0, 0, 1], dir: 'back', label: '后' },
  { idx: [1, 5, 6, 2], normal: [1, 0, 0], dir: 'right', label: '右' },
  { idx: [0, 4, 7, 3], normal: [-1, 0, 0], dir: 'left', label: '左' },
  { idx: [3, 2, 6, 7], normal: [0, 1, 0], dir: 'top', label: '上' },
  { idx: [0, 1, 5, 4], normal: [0, -1, 0], dir: 'bottom', label: '下' },
];
const FACE_LABEL_EN: Record<string, string> = {
  front: 'FRONT', back: 'BACK', right: 'RIGHT', left: 'LEFT', top: 'TOP', bottom: 'BOTTOM',
};

// 12 条棱（用于点击触发等轴测）
const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export function buildViewcube(app: App, host: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('class', 'vc-svg');

  const rot = new THREE.Matrix3();
  const fwd = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const tmpP = new THREE.Vector3();

  // 每条棱一个透明粗描边，作为点击热区（等轴测）
  const edgeHits = EDGES.map(() => {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('stroke', 'transparent');
    l.setAttribute('stroke-width', '9');
    l.style.cursor = 'pointer';
    svg.appendChild(l);
    return l;
  });

  // 六个面：多边形 + 背景 + 文字
  const faceEls = FACES.map((f) => {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('stroke', '#9fb0c3');
    poly.setAttribute('stroke-width', '1');
    poly.style.cursor = 'pointer';
    svg.appendChild(poly);
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('dominant-baseline', 'middle');
    txt.setAttribute('font-size', '9');
    txt.setAttribute('font-weight', '700');
    txt.setAttribute('fill', '#2b3a4a');
    txt.setAttribute('pointer-events', 'none');
    svg.appendChild(txt);
    return { f, poly, txt };
  });

  // 8 个角点热区（等轴测）
  const cornerHits = C.map(() => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '6');
    c.setAttribute('fill', 'transparent');
    c.style.cursor = 'pointer';
    svg.appendChild(c);
    return c;
  });

  // 主页按钮（回到等轴测）
  const home = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  home.style.cursor = 'pointer';
  const homeRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  homeRect.setAttribute('x', String(CX - 16));
  homeRect.setAttribute('y', String(SIZE - 16));
  homeRect.setAttribute('width', '32');
  homeRect.setAttribute('height', '13');
  homeRect.setAttribute('rx', '3');
  homeRect.setAttribute('fill', '#eef2f7');
  homeRect.setAttribute('stroke', '#9fb0c3');
  const homeTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  homeTxt.setAttribute('x', String(CX));
  homeTxt.setAttribute('y', String(SIZE - 9));
  homeTxt.setAttribute('text-anchor', 'middle');
  homeTxt.setAttribute('dominant-baseline', 'middle');
  homeTxt.setAttribute('font-size', '8');
  homeTxt.setAttribute('font-weight', '700');
  homeTxt.setAttribute('fill', '#2b3a4a');
  homeTxt.textContent = '主页';
  home.append(homeRect, homeTxt);
  svg.appendChild(home);

  host.appendChild(svg);

  const proj = (i: number): { x: number; y: number } => {
    tmpP.set(C[i][0], C[i][1], C[i][2]).applyMatrix3(rot);
    return { x: CX + tmpP.x * SCALE, y: CY - tmpP.y * SCALE };
  };

  const update = () => {
    const cam = app.viewport.camera;
    cam.updateMatrixWorld();
    rot.setFromMatrix4(cam.matrixWorldInverse);
    cam.getWorldDirection(fwd); // 相机观察方向（世界）

    // 面可见性：外法向与观察方向反向（朝向相机）才可见
    const faceInfo = faceEls.map(({ f }) => {
      tmpN.set(f.normal[0], f.normal[1], f.normal[2]);
      const dot = tmpN.dot(fwd); // <0 表示朝向相机
      return { f, dot };
    });

    // 远面先画、近面后画
    faceInfo.sort((a, b) => b.dot - a.dot);

    for (const { f, dot } of faceInfo) {
      const elInfo = faceEls.find((e) => e.f === f)!;
      const pts = f.idx.map((i) => proj(i));
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const visible = dot < 0.001;
      elInfo.poly.setAttribute('points', pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
      elInfo.poly.setAttribute('fill', visible ? '#dfe7f1' : '#f4f7fb');
      elInfo.poly.setAttribute('fill-opacity', visible ? '1' : '0.55');
      elInfo.txt.setAttribute('x', String(cx));
      elInfo.txt.setAttribute('y', String(cy));
      elInfo.txt.textContent = visible ? FACE_LABEL_EN[f.dir] : '';
      elInfo.poly.onclick = () => app.setView(f.dir as never);
    }

    // 棱热区
    EDGES.forEach((e, k) => {
      const a = proj(e[0]);
      const b = proj(e[1]);
      edgeHits[k].setAttribute('x1', String(a.x));
      edgeHits[k].setAttribute('y1', String(a.y));
      edgeHits[k].setAttribute('x2', String(b.x));
      edgeHits[k].setAttribute('y2', String(b.y));
      edgeHits[k].onclick = () => app.setView('iso');
    });

    // 角热区
    C.forEach((_, i) => {
      const p = proj(i);
      cornerHits[i].setAttribute('cx', String(p.x));
      cornerHits[i].setAttribute('cy', String(p.y));
      cornerHits[i].onclick = () => app.setView('iso');
    });
  };

  home.onclick = () => app.setView('iso');

  update();
  app.viewport.controls.addEventListener('change', update);
  app.on('view', update);
  app.on('mode', update);
}
