/**
 * 截面属性（SolidWorks → 评估 → 截面属性，Section Properties）。
 *
 * 交互：选一个基准面（前视/上视/右视）+ 沿法向偏移，随模型实时重算并列出
 * 截面面积、形心、形心轴惯性矩 Ixx/Iyy/Ixy、极惯性矩 Izz、主惯性矩/方向、
 * 回转半径。渲染进 PropertyManager（host:'pm'，与测量一致）。
 *
 * 几何全部走 src/core/sectionprops.ts（三角网格切片 + Green 定理），主线程零内核调用。
 */
import { el, clear, section } from './dom';
import { modal } from './toast';
import type { AppApi } from '../app/app-api';
import type { StandardPlaneId } from '../core/sectionprops';
import { computeSectionProps, planeThrough, sliceMeshPlane } from '../core/sectionprops';
import {
  formatArea, formatLength, formatInertia, fmtCoord, UNIT_BY_ID,
} from '../core/units';
import { viewsOfMesh } from '../core/kernel-types';

const PLANES: { id: StandardPlaneId; label: string }[] = [
  { id: 'front', label: '前视基准面' },
  { id: 'top', label: '上视基准面' },
  { id: 'right', label: '右视基准面' },
];

/** 由 faceMetas 估算网格质心（面积加权），用于让默认截面穿过零件 */
function meshCentroid(app: AppApi): [number, number, number] {
  const m = app.currentModel()?.mesh;
  if (!m) return [0, 0, 0];
  let ax = 0, ay = 0, az = 0, a = 0;
  for (const f of m.faceMetas) {
    ax += f.centroid[0] * f.area;
    ay += f.centroid[1] * f.area;
    az += f.centroid[2] * f.area;
    a += f.area;
  }
  if (a < 1e-9) return [0, 0, 0];
  return [ax / a, ay / a, az / a];
}

/** 打开「截面属性」对话框 */
export function openSectionProperties(app: AppApi): void {
  const host = el('div', { class: 'col' });

  // 基准面选择
  const sel = el('select', { class: 'inp' }) as HTMLSelectElement;
  for (const p of PLANES) sel.appendChild(el('option', { value: p.id, text: p.label }));
  const offsetInput = el('input', { class: 'inp', type: 'number', step: '0.1', value: '0' }) as HTMLInputElement;

  const controls = el('div', { class: 'row' },
    el('label', { text: '基准面', class: 'lbl' }),
    sel,
  );
  const offsetRow = el('div', { class: 'row' },
    el('label', { text: '沿法向偏移', class: 'lbl' }),
    offsetInput,
  );

  const resultBox = el('div', { class: 'col' });
  const hint = el('div', { class: 'hint' });

  host.append(
    section('剖切平面', el('div', { class: 'col' }, controls, offsetRow), false),
    section('截面属性', resultBox, false),
    section('说明', el('div', { class: 'hint', text: '面积/惯性矩按当前单位制换算；基准面相对世界原点，偏移默认使截面穿过零件质心。' }), false),
  );

  let planeId: StandardPlaneId = 'front';
  let deltaMm = 0;

  const recompute = () => {
    const model = app.currentModel();
    if (!model) {
      clear(resultBox);
      resultBox.appendChild(el('div', { class: 'hint', text: '没有实体' }));
      return;
    }
    const { positions, indices } = viewsOfMesh(model.mesh);
    const sys = app.unitSystem;
    const dig = UNIT_BY_ID[sys].digits.len;
    // 默认偏移 = 质心在该基准面法向上的投影（使截面穿过零件）
    const c = meshCentroid(app);
    const { n } = planeThrough(planeId, 0);
    const base = c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
    const plane = planeThrough(planeId, base + deltaMm);
    const loops = sliceMeshPlane(positions, indices, plane);
    const props = computeSectionProps(loops);

    clear(resultBox);
    if (!props) {
      resultBox.appendChild(el('div', { class: 'hint', text: '平面未与实体相交，调整偏移或基准面。' }));
      return;
    }
    const rows: [string, string][] = [
      ['面积', formatArea(props.area, sys)],
      ['形心 X', formatLength(props.cx, sys)],
      ['形心 Y', formatLength(props.cy, sys)],
      ['惯性矩 Ixx', formatInertia(props.Ixx, sys)],
      ['惯性矩 Iyy', formatInertia(props.Iyy, sys)],
      ['惯性矩 Ixy', formatInertia(props.Ixy, sys)],
      ['极惯性矩 Izz', formatInertia(props.Izz, sys)],
      ['主惯性矩 Ix1', formatInertia(props.Ix1, sys)],
      ['主惯性矩 Iy1', formatInertia(props.Iy1, sys)],
      ['主方向', `${fmtCoord((props.theta * 180) / Math.PI, sys)}°`],
      ['回转半径 Rx', formatLength(props.Rx, sys)],
      ['回转半径 Ry', formatLength(props.Ry, sys)],
    ];
    const table = el('table', { class: 'expr-table' });
    for (const [k, val] of rows) {
      table.appendChild(el('tr', {}, el('td', { text: k }), el('td', { class: 'mono', text: val })));
    }
    resultBox.appendChild(table);
  };

  sel.addEventListener('change', () => {
    planeId = sel.value as StandardPlaneId;
    recompute();
  });
  offsetInput.addEventListener('input', () => {
    const v = parseFloat(offsetInput.value);
    deltaMm = Number.isFinite(v) ? v / UNIT_BY_ID[app.unitSystem].length : 0;
    recompute();
  });

  const offChg = app.on('change', recompute);
  const offUnits = app.on('units', () => {
    // 偏移输入框以 mm 存储，按新单位重新显示
    offsetInput.value = fmtCoord(deltaMm, app.unitSystem);
    recompute();
  });

  modal({
    host: 'pm',
    title: '截面属性',
    body: host,
    actions: [{ label: '关闭', primary: true }],
    onClose: () => { offChg(); offUnits(); },
  });
  recompute();
}
