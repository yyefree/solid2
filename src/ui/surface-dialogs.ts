/**
 * 曲面特征对话框（SolidWorks「曲面」页签）：
 *   拉伸曲面 / 旋转曲面 / 平面区域。
 *
 * 生成的**曲面实体（壳）**不参与实体布尔，在设计树「曲面实体」文件夹中列出；
 * 几何由 `engine.ts` 的 surfaceExtrude / surfaceRevolve / surfacePlanar 求值。
 * 与其它特征一致，渲染进 PropertyManager（host:'pm'，非模态）。
 */
import { el, numberField, selectField, checkField } from './dom';
import { modal, notify } from './toast';
import { newId } from '../sketch/types';
import type { App } from '../app/app';
import type {
  SurfaceExtrudeFeature,
  SurfaceRevolveFeature,
  SurfacePlanarFeature,
} from '../doc/types';

/** 草图下拉选项 */
function sketchOptions(app: App): { value: string; label: string }[] {
  return app.doc.sketchFeatures().map((s, i) => ({ value: s.id, label: `${s.name}（草图 ${i + 1}）` }));
}

/** 默认草图：正在编辑的草图，否则最后一个草图 */
function defaultSketchId(app: App): string {
  const sketches = app.doc.sketchFeatures();
  return app.editingSketch?.id ?? sketches[sketches.length - 1]?.id ?? '';
}

function openSurfaceExtrude(app: App): void {
  const sketches = app.doc.sketchFeatures();
  if (!sketches.length) { notify.err('没有可用草图'); return; }
  const body = el('div', { class: 'col' });
  const skRow = selectField('轮廓草图', defaultSketchId(app), sketchOptions(app), () => {});
  const distRow = numberField('拉伸距离', 20, () => {}, { min: 0.01, step: 1, unit: 'mm' });
  const symRow = checkField('对称（两侧各半）', false, () => {});
  const revRow = checkField('反向', false, () => {});
  body.append(
    skRow.row, distRow.row, symRow.row, revRow.row,
    el('div', { class: 'hint' }, '把草图轮廓沿其法向拉伸成曲面（不封顶）：闭合轮廓生成四周侧壁，开放轮廓生成单侧曲面。')
  );
  modal({
    host: 'pm',
    title: '拉伸曲面',
    body,
    actions: [
      { label: '取消' },
      {
        label: '确定', primary: true, onClick: () => {
          const dist = parseFloat(distRow.input.value);
          if (!Number.isFinite(dist) || dist <= 0) { notify.err('距离必须为正数'); return false; }
          const f: SurfaceExtrudeFeature = {
            id: newId('f'), type: 'surfaceExtrude', name: app.doc.nextName('surfaceExtrude'),
            params: {
              sketchId: skRow.select.value,
              distance: dist,
              symmetric: symRow.input.checked,
              reverse: revRow.input.checked,
            },
          };
          app.addFeature(f);
          notify.ok('已添加拉伸曲面');
          return true;
        },
      },
    ],
  });
}

function openSurfaceRevolve(app: App): void {
  const sketches = app.doc.sketchFeatures();
  if (!sketches.length) { notify.err('没有可用草图'); return; }
  const body = el('div', { class: 'col' });
  const skRow = selectField('轮廓草图', defaultSketchId(app), sketchOptions(app), () => {});
  const angRow = numberField('旋转角度', 360, () => {}, { min: -360, max: 360, step: 5, unit: '°' });
  const axRow = numberField('轴起点 X', 0, () => {}, { step: 1 });
  const ayRow = numberField('轴起点 Y', 0, () => {}, { step: 1 });
  const bxRow = numberField('轴终点 X', 0, () => {}, { step: 1 });
  const byRow = numberField('轴终点 Y', 10, () => {}, { step: 1 });
  const revRow = checkField('反向', false, () => {});
  body.append(
    skRow.row, angRow.row, axRow.row, ayRow.row, bxRow.row, byRow.row, revRow.row,
    el('div', { class: 'hint' }, '把草图轮廓绕「轴起点 → 轴终点」旋转成曲面（不封顶）。轴在草图平面内用局部 X/Y 坐标。')
  );
  modal({
    host: 'pm',
    title: '旋转曲面',
    body,
    actions: [
      { label: '取消' },
      {
        label: '确定', primary: true, onClick: () => {
          const ang = parseFloat(angRow.input.value);
          if (!Number.isFinite(ang) || Math.abs(ang) < 1e-6) { notify.err('角度不能为 0'); return false; }
          const a: [number, number] = [parseFloat(axRow.input.value) || 0, parseFloat(ayRow.input.value) || 0];
          const b: [number, number] = [parseFloat(bxRow.input.value) || 0, parseFloat(byRow.input.value) || 0];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) { notify.err('轴的两点不能重合'); return false; }
          const f: SurfaceRevolveFeature = {
            id: newId('f'), type: 'surfaceRevolve', name: app.doc.nextName('surfaceRevolve'),
            params: {
              sketchId: skRow.select.value,
              axisA: a,
              axisB: b,
              angleDeg: ang,
              reverse: revRow.input.checked,
            },
          };
          app.addFeature(f);
          notify.ok('已添加旋转曲面');
          return true;
        },
      },
    ],
  });
}

function openSurfacePlanar(app: App): void {
  const sketches = app.doc.sketchFeatures();
  if (!sketches.length) { notify.err('没有可用草图'); return; }
  const body = el('div', { class: 'col' });
  const skRow = selectField('轮廓草图', defaultSketchId(app), sketchOptions(app), () => {});
  body.append(
    skRow.row,
    el('div', { class: 'hint' }, '把闭合草图轮廓填成一个平面曲面（SolidWorks「平面区域」）。')
  );
  modal({
    host: 'pm',
    title: '平面区域',
    body,
    actions: [
      { label: '取消' },
      {
        label: '确定', primary: true, onClick: () => {
          const f: SurfacePlanarFeature = {
            id: newId('f'), type: 'surfacePlanar', name: app.doc.nextName('surfacePlanar'),
            params: { sketchId: skRow.select.value },
          };
          app.addFeature(f);
          notify.ok('已添加平面区域');
          return true;
        },
      },
    ],
  });
}

export const surfaceDialogs = {
  extrude: openSurfaceExtrude,
  revolve: openSurfaceRevolve,
  planar: openSurfacePlanar,
};
