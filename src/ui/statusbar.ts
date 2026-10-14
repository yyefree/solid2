/**
 * 底部状态栏（SolidWorks 风格）。
 *
 * 左：状态指示灯 + 消息；右：[What's Wrong(有错误时显示)] · 光标坐标 · 单位 · 选择过滤器 ▾ · 重建按钮。
 * 兼容浏览器冒烟测试：消息文本仍写入 `.statusbar` 的 textContent。
 */
import { el, clear } from './dom';
import { icon } from './icons';
import * as THREE from 'three';
import type { App } from '../app/app';
import { openPopup, type PopupItem } from './popup';
import { notify } from './toast';

const FILTER_LABEL: Record<App['selectionFilter'], string> = {
  all: '全部',
  face: '仅面',
  edge: '仅边',
  vertex: '顶点',
};

export function buildStatusbar(app: App, host: HTMLElement): void {
  const led = el('span', { class: 'led' });
  const text = el('span', { class: 'sb-msg', text: '' });
  const left = el('div', { class: 'sb-left' }, led, text);

  // What's Wrong（有特征错误时出现，点击定位到第一个出错的特性）
  const wwrong = el('button', { class: 'sb-wwrong', type: 'button', title: '' });
  wwrong.style.display = 'none';
  wwrong.addEventListener('click', () => {
    const id = app.firstErrorFeatureId();
    if (!id) return;
    const f = app.doc.getFeature(id);
    app.selectFeature(id);
    notify.err(f?.error ? `${f.name}：${f.error}` : '模型存在错误');
  });

  const coord = el('span', { class: 'sb-coord', title: '光标在模型空间中的坐标', text: 'X 0.000   Y 0.000   Z 0.000' });
  const unit = el('span', { class: 'sb-unit', title: '单位', text: 'mm' });

  // 选择过滤器（SolidWorks 状态栏 Filter / 快捷键 F5）
  const filterLabel = el('span', { text: FILTER_LABEL[app.selectionFilter] });
  const filterCaret = el('span', { class: 'caret', html: icon('caretDown', 10) });
  const filter = el('button', { class: 'sb-filter', type: 'button', title: '选择过滤器', dataset: { cmd: 'view.filter' } }, filterLabel, filterCaret);
  filter.addEventListener('click', () => {
    const r = filter.getBoundingClientRect();
    const mk = (label: App['selectionFilter'], tip: string): PopupItem => ({
      label: FILTER_LABEL[label],
      tip,
      checked: app.selectionFilter === label,
      run: () => {
        app.setSelectionFilter(label);
        filterLabel.textContent = FILTER_LABEL[label];
      },
    });
    openPopup(
      [
        mk('all', '不过滤（默认）'),
        mk('face', '只能拾取面'),
        mk('edge', '只能拾取边'),
        mk('vertex', '只能拾取顶点（就近 8px）'),
      ],
      r.left,
      Math.max(4, r.top - 130),
      { minWidth: 130 }
    );
  });

  const rebuild = el('button', { class: 'sb-rebuild', type: 'button', title: '重建模型 (Ctrl+B)' });
  rebuild.innerHTML = icon('rebuild', 14);
  rebuild.addEventListener('click', () => app.rebuildModel());
  const right = el('div', { class: 'sb-right' }, wwrong, coord, unit, filter, rebuild);

  clear(host);
  host.append(left, el('div', { class: 'sb-spacer' }), right);

  const render = () => {
    const s = app.status;
    led.className = `led ${s.kind}`;
    text.textContent = s.text;
  };
  render();
  app.on('status', render);

  // What's Wrong：随特征错误刷新
  const renderWw = () => {
    const errs = app.doc.features.filter((f) => f.error);
    const n = errs.length;
    wwrong.style.display = n ? '' : 'none';
    wwrong.textContent = String(n);
    wwrong.title = n ? `${n} 个特征有错误——点击定位到「${errs[0].name}」` : '';
  };
  renderWw();
  app.on('props', renderWw);
  app.on('change', renderWw);
  app.on('tree', renderWw);

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
      coord.textContent = `Cursor: X${fmt(hit.x)}   Y${fmt(hit.y)}   Z${fmt(hit.z)}`;
    }
  };
  canvas.addEventListener('pointermove', onMove);
}
