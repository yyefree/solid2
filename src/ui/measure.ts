/**
 * 「测量」（SolidWorks → 评估 → 测量，Measure）。
 *
 * SW 行为：打开常驻对话框，**随图形区选择实时重算**；支持顶点/边/面/圆/实体的
 * 多种组合，输出 距离/分量/夹角/长度/面积/半径。这里渲染进 PropertyManager
 * （`host:'pm'`，非模态），订阅 app 的 selection / change 事件实时刷新。
 *
 * 算法分层：
 *   - 面↔面 / 边↔边 / 面↔边 的最小距离：走内核 BRepExtrema（精确）；
 *   - 顶点↔面 / 顶点↔边：主线程三角网格/折线扫描（平面与直线情形为精确值）；
 *   - 面积/长度/半径/夹角/分量：直接取自 MeshResult 元数据，零内核调用。
 * 纯几何见 `measure-math.ts`（不依赖 DOM/内核，供单测复用）。
 */
import { el, clear, section } from './dom';
import { modal } from './toast';
import { kernel } from '../core/kernel';
import type { App } from '../app/app';
import type { EdgeMeta, FaceMeta, Vec3 } from '../core/kernel-types';
import { angleBetweenDeg, pointEdgeDistance, pointFaceDistance, vecDist } from './measure-math';
import { formatLength, formatArea, formatVolume, fmtCoord, UNIT_BY_ID } from '../core/units';

// ============================================================
// 测量计算
// ============================================================

export interface MeasureRow {
  label: string;
  value: string;
}

function num(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—';
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}

function vertexPos(positions: ArrayBuffer, i: number): Vec3 {
  const pos = new Float32Array(positions);
  return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
}

function selLabel(kind: string, n: number): string {
  return `${n} 个${kind}`;
}

/**
 * 按当前选择计算测量行。返回空数组表示该组合暂不支持（调用方给提示）。
 * 含内核调用的分支是异步的（面/边间距）。
 */
export async function measureSelection(app: App): Promise<MeasureRow[]> {
  const model = app.currentModel();
  if (!model) return [];
  const mesh = model.mesh;
  const sel = app.selection;
  const faces = sel.faces.map((i) => mesh.faceMetas[i]).filter(Boolean) as FaceMeta[];
  const edges = sel.edges.map((i) => mesh.edgeMetas[i]).filter(Boolean) as EdgeMeta[];
  const verts = sel.vertices.map((i) => vertexPos(mesh.positions, i));
  const rows: MeasureRow[] = [];

  // --- 两个顶点：距离 + 分量 ---
  if (verts.length === 2 && !faces.length && !edges.length) {
    const d = vecDist(verts[0], verts[1]);
    const sys = app.unitSystem;
    rows.push({ label: '距离', value: formatLength(d, sys) });
    rows.push({ label: 'ΔX', value: formatLength(Math.abs(verts[1][0] - verts[0][0]), sys) });
    rows.push({ label: 'ΔY', value: formatLength(Math.abs(verts[1][1] - verts[0][1]), sys) });
    rows.push({ label: 'ΔZ', value: formatLength(Math.abs(verts[1][2] - verts[0][2]), sys) });
    return rows;
  }
  // --- 顶点 ↔ 面 / 顶点 ↔ 边 ---
  if (verts.length === 1 && faces.length === 1 && !edges.length) {
    const d = pointFaceDistance(verts[0], sel.faces[0], mesh);
    rows.push({ label: '距离（顶点→面）', value: formatLength(d, app.unitSystem) });
    return rows;
  }
  if (verts.length === 1 && edges.length === 1 && !faces.length) {
    const d = pointEdgeDistance(verts[0], sel.edges[0], mesh);
    rows.push({ label: '距离（顶点→边）', value: formatLength(d, app.unitSystem) });
    return rows;
  }
  // --- 单个面：面积 / 曲面半径 ---
  if (faces.length === 1 && !edges.length && !verts.length) {
    const sys = app.unitSystem;
    rows.push({ label: '面积', value: formatArea(faces[0].area, sys) });
    const r = faces[0].radius;
    if (r && (faces[0].surfaceType === 'cylinder' || faces[0].surfaceType === 'sphere' || faces[0].surfaceType === 'torus')) {
      rows.push({ label: '半径', value: formatLength(r, sys) });
      rows.push({ label: '直径', value: formatLength(r * 2, sys) });
    }
    return rows;
  }
  // --- 单个边：长度 / 圆的半径直径圆心 ---
  if (edges.length === 1 && !faces.length && !verts.length) {
    const sys = app.unitSystem;
    rows.push({ label: '长度', value: formatLength(edges[0].length, sys) });
    if (edges[0].curveType === 'circle' && edges[0].radius) {
      rows.push({ label: '半径', value: formatLength(edges[0].radius, sys) });
      rows.push({ label: '直径', value: formatLength(edges[0].radius * 2, sys) });
      const c = edges[0].axis?.point;
      if (c) rows.push({ label: '圆心', value: `(${fmtCoord(c[0], sys)}, ${fmtCoord(c[1], sys)}, ${fmtCoord(c[2], sys)}) ${UNIT_BY_ID[sys].lenUnit}` });
    }
    return rows;
  }
  // --- 实体 ---
  if (sel.bodies.length && !faces.length && !edges.length && !verts.length) {
    const areas = new Map<number, number>();
    for (const fm of mesh.faceMetas) {
      const bi = fm.bodyIndex ?? 0;
      areas.set(bi, (areas.get(bi) ?? 0) + fm.area);
    }
    let area = 0;
    for (const b of sel.bodies) area += areas.get(b) ?? 0;
    const sys = app.unitSystem;
    rows.push({ label: '表面积', value: formatArea(area, sys) });
    if (sel.bodies.length === 1 && model.stats.solids === 1) {
      rows.push({ label: '体积', value: formatVolume(model.stats.volume, sys) });
    }
    return rows;
  }
  // --- 需要内核精确距离的组合 ---
  try {
    const sys = app.unitSystem;
    if (faces.length === 2 && !edges.length && !verts.length) {
      const r = await kernel.measure(app.resolvedFeatures(), 'faceFace', sel.faces[0], sel.faces[1]);
      rows.push({ label: '最小距离', value: formatLength(r.distance, sys) });
      rows.push({ label: '夹角', value: `${num(angleBetweenDeg(faces[0].normal, faces[1].normal), 2)}°` });
      return rows;
    }
    if (edges.length === 2 && !faces.length && !verts.length) {
      const r = await kernel.measure(app.resolvedFeatures(), 'edgeEdge', sel.edges[0], sel.edges[1]);
      rows.push({ label: '最小距离', value: formatLength(r.distance, sys) });
      rows.push({ label: '夹角', value: `${num(angleBetweenDeg(edges[0].dir, edges[1].dir), 2)}°` });
      return rows;
    }
    if (faces.length === 1 && edges.length === 1 && !verts.length) {
      const r = await kernel.measure(app.resolvedFeatures(), 'faceEdge', sel.faces[0], sel.edges[0]);
      rows.push({ label: '最小距离', value: formatLength(r.distance, sys) });
      return rows;
    }
  } catch {
    // 内核失败时落到提示行
  }
  return rows;
}

// ============================================================
// 对话框（PropertyManager 宿主）
// ============================================================

const GUIDE = [
  '两个顶点 → 距离 + ΔX/ΔY/ΔZ',
  '单个面 → 面积（圆/圆柱/球面附半径/直径）',
  '单个边 → 长度（圆附半径/直径/圆心）',
  '两个面 / 两条边 / 面+边 → 最小距离（+夹角）',
  '顶点 + 面 / 顶点 + 边 → 距离',
  '实体 → 表面积（单实体模型附体积）',
];

/** 打开「测量」对话框（SolidWorks 评估 → 测量） */
export function openMeasure(app: App): void {
  const host = el('div', { class: 'col' });
  const selInfo = el('div', { class: 'hint' });
  const table = el('div', { class: 'col' });
  const historyBox = el('div', { class: 'list' });
  let history: string[] = [];
  let run = 0;

  host.append(
    section('当前选择', selInfo, false),
    table,
    section('测量历史', historyBox, false),
    section('用法', el('div', { class: 'hint', text: GUIDE.join(' · ') }), false),
  );

  const renderHistory = () => {
    clear(historyBox);
    if (!history.length) {
      historyBox.appendChild(el('div', { class: 'hint', text: '还没有历史记录（测量结果自动累积，选择变化即重算）。' }));
      return;
    }
    for (const h of history) {
      historyBox.appendChild(el('div', { class: 'list-item' }, el('span', { class: 'mono', text: h })));
    }
  };

  const refresh = async () => {
    const my = ++run;
    const sel = app.selection;
    const parts: string[] = [];
    if (sel.vertices.length) parts.push(selLabel('顶点', sel.vertices.length));
    if (sel.faces.length) parts.push(selLabel('面', sel.faces.length));
    if (sel.edges.length) parts.push(selLabel('边', sel.edges.length));
    if (sel.bodies.length) parts.push(selLabel('实体', sel.bodies.length));
    selInfo.textContent = parts.length
      ? `当前选择：${parts.join(' · ')}（在图形区继续点选可组合测量）`
      : '当前选择：空（先选择顶点/边/面/实体）';

    const rows = await measureSelection(app);
    if (my !== run) return; // 已有更新的渲染，丢弃过期结果
    clear(table);
    if (rows.length) {
      for (const r of rows) {
        table.appendChild(
          el('div', { class: 'field' },
            el('label', { text: r.label }),
            el('div', { class: 'val mono', text: r.value }))
        );
      }
      const first = rows[0];
      const entry = `${parts.join('+') || '空'} → ${first.label} = ${first.value}`;
      if (history[history.length - 1] !== entry) {
        history = [...history, entry].slice(-8);
        renderHistory();
      }
    } else if (parts.length) {
      table.appendChild(el('div', { class: 'hint', text: '该组合暂不支持，换一种选择试试（见下方用法）。' }));
    }
  };

  const offSel = app.on('selection', () => void refresh());
  const offChg = app.on('change', () => void refresh());
  const offUnits = app.on('units', () => void refresh());
  renderHistory();
  modal({
    host: 'pm',
    title: '测量',
    body: host,
    actions: [
      { label: '清除历史', onClick: () => { history = []; renderHistory(); return false; } },
      { label: '关闭', primary: true },
    ],
    onClose: () => {
      offSel();
      offChg();
      offUnits();
    },
  });
  void refresh();
}
