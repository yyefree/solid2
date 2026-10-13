/**
 * 底部状态栏（SolidWorks 风格）。
 *
 * 左：状态指示灯 + 消息；右：光标坐标（模型空间）、单位、过滤器、重建按钮。
 * 兼容浏览器冒烟测试：消息文本仍写入 `.statusbar` 的 textContent。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import * as THREE from 'three';
import type { App } from '../app/app';

export function buildStatusbar(app: App, host: HTMLElement): void {
  const led = el('span', { class: 'led' });
  const text = el('span', { class: 'sb-msg', text: '' });
  const left = el('div', { class: 'sb-left' }, led, text);

  const coord = el('span', { class: 'sb-coord', title: '光标在模型空间中的坐标', text: 'X 0.000   Y 0.000   Z 0.000' });
  const unit = el('span', { class: 'sb-unit', title: '单位', text: 'mm' });
  const filter = el('span', { class: 'sb-filter', title: '选择过滤器', text: '全部' });
  const rebuild = el('button', { class: 'sb-rebuild', type: 'button', title: '重建模型 (Ctrl+B)' });
  rebuild.innerHTML = icon('rebuild', 14);
  rebuild.addEventListener('click', () => app.rebuildModel());
  const right = el('div', { class: 'sb-right' }, coord, unit, filter, rebuild);

  clear(host);
  host.append(left, el('div', { class: 'sb-spacer' }), right);

  const render = () => {
    const s = app.status;
    led.className = `led ${s.kind}`;
    text.textContent = s.text;
  };
  render();
  app.on('status', render);

  // 光标坐标（投影到过相机目标的平面内）
  const canvas = app.viewport.renderer.domElement;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const hit = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const fmt = (v: number) => (v >= 0 ? ' ' : '') + v.toFixed(3);

  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    const cam = app.viewport.camera;
    cam.updateMatrixWorld();
    ray.setFromCamera(ndc, cam);
    cam.getWorldDirection(camDir);
    plane.setFromNormalAndCoplanarPoint(camDir, app.viewport.controls.target);
    if (ray.ray.intersectPlane(plane, hit)) {
      coord.textContent = `X${fmt(hit.x)}   Y${fmt(hit.y)}   Z${fmt(hit.z)}`;
    }
  };
  canvas.addEventListener('pointermove', onMove);
}
