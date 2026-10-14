/**
 * Solid2 图标库
 * 全部为 16x16 视口的线性 SVG，使用 currentColor，随主题变色。
 */

const S = (inner: string, size = 16) =>
  `<svg class="ic" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" ` +
  `stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// ---- 曲线族图标（按数学公式生成路径，保证形状与引擎一致） ----

/** 阿基米德螺线：r = r0 + (r1 - r0)·t，t 从 0 到 1 */
function spiralPath(cx: number, cy: number, turns: number, r0: number, r1: number, steps = 80): string {
  const seg: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = turns * Math.PI * 2 * t - Math.PI / 2;
    const r = r0 + (r1 - r0) * t;
    seg.push(`${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return seg.join(' ');
}

/** 螺旋弹簧侧视轮廓：余弦扫掠线（左端起始，右端收尾） */
function coilPath(cx: number, top: number, bottom: number, amp: number, turns: number, steps = 120): string {
  const seg: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = cx + amp * Math.cos(turns * Math.PI * 2 * t);
    const y = top + (bottom - top) * t;
    seg.push(`${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return seg.join(' ');
}

// ---- 基础几何 ----
const box = `<path d="M8 1.6 14 4.8v6.4L8 14.4 2 11.2V4.8z"/><path d="M2 4.8 8 8l6-3.2M8 8v6.4"/>`;
const cylinder = `<ellipse cx="8" cy="3.6" rx="5" ry="2.1"/><path d="M3 3.6v8.8M13 3.6v8.8"/><path d="M3 12.4a5 2.1 0 0 0 10 0"/>`;
const sphere = `<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="6" ry="2.4"/><path d="M8 2a9 6 0 0 1 0 12 9 6 0 0 1 0-12"/>`;

// ---- 圆锥曲线图标（同样按参数方程生成，形状与引擎一致） ----

/** 抛物线 y = h·(1 − u²)：顶点在下、开口向上 */
function parabolaIconPath(cx: number, cy: number, halfW: number, h: number, steps = 36): string {
  const seg: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = -1 + (2 * i) / steps;
    seg.push(`${i ? 'L' : 'M'}${(cx + halfW * u).toFixed(2)} ${(cy - h * u * u).toFixed(2)}`);
  }
  return seg.join(' ');
}

/** 双曲线右支：x = a·cosh t，y = b·sinh t（与实现一致，只画右支） */
function hyperbolaIconPath(cx: number, cy: number, a: number, b: number, tMax: number, steps = 30): string {
  const seg: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = -tMax + (2 * tMax * i) / steps;
    seg.push(`${i ? 'L' : 'M'}${(cx + a * Math.cosh(t)).toFixed(2)} ${(cy - b * Math.sinh(t)).toFixed(2)}`);
  }
  return seg.join(' ');
}

export const ICONS: Record<string, string> = {
  // ============ 标准 ============
  new: S(`<path d="M3.5 1.5h6L13 5v9.5h-9.5z"/><path d="M9.5 1.5V5H13"/>`),
  open: S(`<path d="M1.5 12.5V3.5h4l1.5 2h7.5v7z"/><path d="M1.5 12.5 4 7.5h11l-2 5z"/>`),
  save: S(`<path d="M2.5 2.5h9L14 5v8.5h-11.5z"/><path d="M5 2.5v4h5v-4M5 13.5v-4h6v4"/>`),
  saveAs: S(`<path d="M2.5 2.5h7L12 5v4"/><path d="M2.5 2.5v11h5"/><circle cx="11.5" cy="11.5" r="3"/><path d="M11.5 10v3M10 11.5h3"/>`),
  undo: S(`<path d="M3 7h7a3.5 3.5 0 0 1 0 7H6"/><path d="M5.5 4.5 3 7l2.5 2.5"/>`),
  redo: S(`<path d="M13 7H6a3.5 3.5 0 0 0 0 7h4"/><path d="M10.5 4.5 13 7l-2.5 2.5"/>`),
  rebuild: S(`<path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.5 2v3.2h-3.2"/>`),
  settings: S(`<circle cx="8" cy="8" r="2.2"/><path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"/>`),
  help: S(`<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.5 1.8c-.5.2-.7.6-.7 1.1v.4"/><circle cx="8" cy="11.8" r=".7" fill="currentColor" stroke="none"/>`),
  export: S(`<path d="M8 10.5V1.8"/><path d="M5 4.8 8 1.8l3 3"/><path d="M2.5 9.5v4.5h11V9.5"/>`),
  importIcon: S(`<path d="M8 1.8v8.7"/><path d="M5 7.5l3 3 3-3"/><path d="M2.5 9.5v4.5h11V9.5"/>`),

  // ============ 特征 ============
  extrude: S(`<path d="M3 10.5V6l5-2.6 5 2.6v4.5L8 13.1z"/><path d="M3 6l5 2.6L13 6M8 8.6v4.5"/><path d="M8 1v2.2M6.8 2.2 8 1l1.2 1.2"/>`),
  extrudeCut: S(`<path d="M2.5 9.5V5l5-2.4 5 2.4v4.5L7.5 12z"/><path d="M7.5 12v3M6.3 13.8l1.2 1.2 1.2-1.2"/>`),
  revolve: S(`<path d="M8 1.6v12.8"/><path d="M8 3.2c3 0 5 2 5 4.8s-2 4.8-5 4.8"/><path d="M8 3.2c-3 0-5 2-5 4.8s2 4.8 5 4.8"/><path d="M5.5 6.5 8 4l2.5 2.5"/>`),
  sweep: S(`<path d="M2 12.5c3-1 4-8 7-9"/><circle cx="2.2" cy="12.6" r="1.6"/><circle cx="13" cy="2.6" r="1.6"/><path d="M9.6 3.6 11.4 1.8"/>`),
  loft: S(`<ellipse cx="8" cy="3" rx="4.4" ry="1.6"/><ellipse cx="8" cy="13" rx="2.6" ry="1.2"/><path d="M3.6 3 5.4 13M12.4 3 10.6 13"/>`),
  spring: S(`<path d="M2.4 2.3h11.2M2.4 13.7h11.2"/><path d="${coilPath(8, 3.3, 12.7, 5.1, 2.5)}"/>`),
  spiral: S(`<path d="${spiralPath(8, 8, 2.3, 1.2, 6.2)}"/>`),
  fillet: S(`<path d="M2.5 13.5V6A3.5 3.5 0 0 1 6 2.5h7.5"/><path d="M2.5 13.5h11V6"/><path d="M6 6h1.2a.8.8 0 0 1 .8.8V8"/>`),
  chamfer: S(`<path d="M2.5 13.5V6.5L6.5 2.5h7.5"/><path d="M2.5 13.5h11V6.5"/>`),
  shell: S(`<path d="M2.5 12V4.5L8 2l5.5 2.5V12L8 14.5z"/><path d="M5 11V5.8L8 4.4l3 1.4V11L8 12.4z"/>`),
  hole: S(`<ellipse cx="8" cy="4.2" rx="5" ry="2"/><path d="M3 4.2v3.4c0 1.1 2.2 2 5 2s5-.9 5-2V4.2"/><ellipse cx="8" cy="11" rx="1.6" ry="1.6"/><path d="M8 12.6V15"/>`),
  linearPattern: S(`<rect x="1.5" y="2" width="4" height="4" rx=".6"/><rect x="10.5" y="2" width="4" height="4" rx=".6"/><rect x="1.5" y="10" width="4" height="4" rx=".6"/><rect x="10.5" y="10" width="4" height="4" rx=".6"/><path d="M6.5 4h3M4 7v2.5M11 7v2.5"/>`),
  circularPattern: S(`<circle cx="8" cy="8" r="6"/><circle cx="8" cy="2" r="1.5" fill="currentColor" stroke="none"/><circle cx="13.2" cy="11" r="1.5" fill="currentColor" stroke="none"/><circle cx="2.8" cy="11" r="1.5" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2"/>`),
  mirror: S(`<path d="M8 1v14" stroke-dasharray="2 1.6"/><path d="M6.2 3.4 1.8 8l4.4 4.6z"/><path d="M9.8 3.4 14.2 8l-4.4 4.6z"/>`),
  booleanAdd: S(`<path d="M2.5 2.5h7v7h-7z"/><circle cx="10" cy="10" r="4.2"/><path d="M6 9.5h4M9.5 6v4" opacity=".5"/>`),
  booleanCut: S(`<path d="M2.5 2.5h7v7h-7z"/><circle cx="10" cy="10" r="4.2" stroke-dasharray="2 1.6"/><path d="M6.5 6.5h4M10 10l3-3"/>`),
  booleanCommon: S(`<path d="M2.5 2.5h7v7h-7z"/><circle cx="10" cy="10" r="4.2"/><path d="M8.6 8.6 6.4 6.4"/>`),
  rib: S(`<path d="M2 13.5h12"/><path d="M2 13.5V9l6-6.5 2 2-6.5 6.5H2z" fill="currentColor" opacity=".18"/><path d="M2 13.5V9l6-6.5 2 2-6.5 6.5H2z"/>`),
  draft: S(`<path d="M2 13.5h12"/><path d="M4.5 13.5 6.5 3h3l2 10.5"/>`),
  wrap: S(`<path d="M3.5 4.5h9v9h-9z"/><path d="M5.5 4.5c0-1.6 5-1.6 5 0"/><path d="M5.5 7.5h5M5.5 10h5"/>`),
  dome: S(`<path d="M1.5 12.5h13"/><path d="M3.5 12.5a4.5 4.5 0 0 1 9 0"/>`),
  combine: S(`<path d="M2 6h7v7H2z"/><path d="M7 3h7v7"/>`),
  scale: S(`<path d="M2.5 6.5v-4h4"/><path d="M13.5 9.5v4h-4"/><path d="M2.5 2.5 7 7M13.5 13.5 9 9"/>`),
  split: S(`<path d="M6.8 2.5 2 5.2 6.8 7.9z"/><path d="M2 5.2 6.8 7.9v5.3L2 10.5z"/><path d="M9.2 2.5 14 5.2 9.2 7.9z"/><path d="M9.2 7.9 14 5.2v5.3l-4.8 2.7z"/><path d="M8 1.6v12.8" stroke-dasharray="1.6 1.4"/>`),
  moveFace: S(`<path d="M3 11V5l5-2.5L13 5v6l-5 2.5z"/><path d="M8 8v4M6.8 10.8 8 12l1.2-1.2"/>`),
  deleteFace: S(`<path d="M3 11V5l5-2.5L13 5v6l-5 2.5z"/><path d="M6 6.5 10 10M10 6.5 6 10"/>`),
  moveBody: S(`<path d="M2.5 10.2V5.6L6 3.8l3.5 1.8v4.6L6 12z"/><path d="M11 8h3.2"/><path d="M12.6 6.4 14.2 8l-1.6 1.6"/>`),
  deleteBody: S(`<path d="M2.5 10.2V5.6L6 3.8l3.5 1.8v4.6L6 12z"/><path d="M11 6.6 14 9.6M14 6.6 11 9.6"/>`),
  /** 曲面（曲面特征页签）：一张弯折的曲面片 */
  surface: S(`<path d="M2 11.5c2.4-3 5-4 7.2-3.2s3.4 2.2 4.8 1.2"/><path d="M2 11.5V6.8c2.4-3 5-4 7.2-3.2s3.4 2.2 4.8 1.2v4.7"/><path d="M2 6.8c2.4-3 5-4 7.2-3.2s3.4 2.2 4.8 1.2" stroke-dasharray="1.4 1.2" opacity=".5"/>`),

  // ============ 草图 ============
  sketch: S(`<path d="M2.5 13.5h11"/><path d="M2.5 2.5v11"/><path d="M4.5 10.5 8 5l3.5 5.5z"/><path d="M2.5 2.5h2M13.5 13.5v-2"/>`),
  line: S(`<path d="M2.5 13.5 13.5 2.5"/><circle cx="2.5" cy="13.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="13.5" cy="2.5" r="1.3" fill="currentColor" stroke="none"/>`),
  rectangle: S(`<rect x="2.5" y="3.5" width="11" height="9" rx=".5"/><circle cx="2.5" cy="3.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="13.5" cy="12.5" r="1.1" fill="currentColor" stroke="none"/>`),
  circle: S(`<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/>`),
  ellipse: S(`<ellipse cx="8" cy="8" rx="6.2" ry="4"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/>`),
  arc: S(`<path d="M2.5 12a6 6 0 0 1 11 0"/><circle cx="2.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="13.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>`),
  spline: S(`<path d="M1.8 12.5c3 0 2.5-9 6.2-9s3.2 9 6.2 9"/>`),
  parabola: S(
    `<path d="${parabolaIconPath(8, 13.2, 6, 9.2)}"/>` +
      `<circle cx="8" cy="13.2" r="1.05" fill="currentColor" stroke="none"/>` +
      `<path d="M8 13.2v-3.4" stroke-dasharray="1.6 1.3"/>` +
      `<circle cx="8" cy="9.8" r=".85" fill="currentColor" stroke="none"/>`
  ),
  hyperbola: S(
    `<path d="${hyperbolaIconPath(0.9, 8, 2.7, 2.3, 1.52)}"/>` +
      `<circle cx="3.6" cy="8" r="1.05" fill="currentColor" stroke="none"/>` +
      `<path d="M3.6 8 1.2 8M3.6 8l3.9 5.2M3.6 8l3.9-5.2" stroke-dasharray="1.6 1.3" opacity=".65"/>`
  ),
  bspline: S(
    `<path d="M2 12.4C4.6 12.4 4.2 3.8 8 3.8s3.4 8.6 6 8.6"/>` +
      `<circle cx="2" cy="12.4" r="1.05" fill="currentColor" stroke="none"/>` +
      `<circle cx="8" cy="3.8" r="1.05" fill="currentColor" stroke="none"/>` +
      `<circle cx="14" cy="12.4" r="1.05" fill="currentColor" stroke="none"/>`
  ),
  polygon: S(`<path d="M8 2 14 6.2 11.7 13H4.3L2 6.2z"/>`),
  slot: S(`<path d="M5.5 5.5h5a2.5 2.5 0 0 1 0 5h-5a2.5 2.5 0 0 1 0-5z"/><path d="M2 8h1.5M12.5 8H14"/>`),
  pointIcon: S(`<circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>`),
  textIcon: S(`<path d="M3 3.5h10M8 3.5v9M6 12.5h4"/>`),
  trim: S(`<path d="M2.5 13.5 9 6.5M6.5 2.5 13.5 9"/><circle cx="10.6" cy="4.6" r="1.4"/><circle cx="4.4" cy="11.4" r="1.4"/>`),
  offset: S(`<path d="M2 5.5h6a3 3 0 0 1 0 6H2"/><path d="M2 9.5h6a1 1 0 0 0 0-2H2" stroke-dasharray="1.6 1.4"/>`),
  convertEntities: S(`<path d="M3 3.5h7v7H3z" stroke-dasharray="2 1.4"/><path d="M6 6.5h7v7H6z"/>`),
  mirrorEntities: S(`<path d="M8 1.5v13" stroke-dasharray="2 1.6"/><path d="M6 4.5 2.5 8 6 11.5zM10 4.5 13.5 8 10 11.5z"/>`),
  dimension: S(`<path d="M2.5 4.5v7M13.5 4.5v7"/><path d="M2.5 8h11"/><path d="M4.5 6 2.5 8l2 2M11.5 6l2 2-2 2"/>`),
  eraseDim: S(`<path d="M2.5 5.5h11"/><path d="M2.5 5.5 5 2.5h5l2.5 3"/><path d="M4.5 5.5 4 13.5h8l-.5-8"/><path d="M6.5 8v3.5M9.5 8v3.5"/>`),
  smartDim: S(`<path d="M2 13 8 7l6 6" opacity=".35"/><path d="M2.5 4.5v7M13.5 4.5v7M2.5 8h11"/><path d="M4.5 6 2.5 8l2 2"/>`),
  relation: S(`<path d="M6.5 9.5 4.8 11.2a2.6 2.6 0 0 1-3.7-3.7l1.7-1.7"/><path d="M9.5 6.5l1.7-1.7a2.6 2.6 0 0 1 3.7 3.7l-1.7 1.7"/><path d="M6 10 10 6"/>`),
  addRelation: S(`<circle cx="5" cy="11" r="2.4"/><circle cx="11" cy="5" r="2.4"/><path d="M8 8 8 8"/>`),
  construction: S(`<path d="M2.5 13.5 13.5 2.5" stroke-dasharray="2.4 1.6"/>`),
  exitSketch: S(`<path d="M3 3.5h10v9H3z"/><path d="M8 6.5v4M6.4 8.9 8 10.5l1.6-1.6"/><path d="M8 10.5V13"/>`),

  // ============ 装配 ============
  assembly: S(`<path d="M1.5 9.5 6 7l4.5 2.5v4L6 16l-4.5-2.5z" transform="translate(0,-3.5)"/><path d="M8.5 5.5 13 3l2.5 1.4v3.2L13 9l-4.5-2.5z"/>`),
  insertComponent: S(`<path d="M6.5 8.5 11 6l4 2.2v4.4L11 15l-4.5-2.4z"/><path d="M1.5 1.5h6v6h-6z"/><path d="M7.5 4.5h2.5M10 4.5 8.5 3M10 4.5 8.5 6"/>`),
  mate: S(`<path d="M2 5.5h5v5H2z"/><path d="M9 5.5h5v5H9z"/><path d="M7 8h2"/><circle cx="8" cy="8" r="1"/>`),
  moveComponent: S(`<path d="M8 1.5v13M1.5 8h13" opacity=".3"/><path d="M8 2 6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2"/>`),
  rotateComponent: S(`<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.5 2v3h-3"/>`),
  explode: S(`<path d="M8 8 3 3M8 8l5-5M8 8l-5 5M8 8l5 5" stroke-dasharray="2 1.4"/><circle cx="8" cy="8" r="1.6"/>`),
  explodeLine: S(`<path d="M2 8h12" stroke-dasharray="2.4 1.6"/><path d="M2 8 4 6M2 8l2 2M14 8l-2-2M14 8l-2 2"/>`),
  interference: S(`<circle cx="6.5" cy="8" r="4.5"/><circle cx="9.5" cy="8" r="4.5"/><path d="M8 6.6v2.8M8 11.4v.2"/>`),
  smartMate: S(`<path d="M2 11.5V5l4-2 4 2v6.5L6 13.5z"/><path d="M11 6.5l2.5 1.3v3L11 12"/><path d="M8.5 8.5h1.5"/>`),
  newPart: S(`<path d="M8 1.6 14 4.8v6.4L8 14.4 2 11.2V4.8z"/><path d="M8 1.6v6.4M8 8l6-3.2M8 8 2 4.8"/>`),
  fixComponent: S(`<path d="M8 2v6"/><path d="M4.5 8h7l-1.2 5.5H5.7z"/><path d="M6 2h4"/>`),
  floatComponent: S(`<path d="M8 3v5.5"/><path d="M5 8.5h6l-1 5H6z"/>`),
  hideComponent: S(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5 13.5 13.5"/>`),
  showComponent: S(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>`),

  // ============ 工程图 ============
  drawing: S(`<path d="M2 2.5h12v11H2z"/><path d="M2 10.5h12M2 6.5h12M8 2.5v11" stroke-dasharray="1.6 1.4"/><path d="M9.5 12.5h4v1.5h-4z" fill="currentColor" stroke="none"/>`),
  modelView: S(`<path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3z"/><path d="M2.5 5.5 8 8.5l5.5-3M8 8.5v5"/>`),
  projectedView: S(`<path d="M2 2.5h5v4H2z"/><path d="M9 2.5h5v4H9z" stroke-dasharray="1.8 1.4"/><path d="M2 8.5h5v4H2z" stroke-dasharray="1.8 1.4"/><path d="M9 8.5h5v4H9z" stroke-dasharray="1.8 1.4"/>`),
  sectionView: S(`<path d="M2 2.5h12v11H2z"/><path d="M2 8h12"/><path d="M4 3.5 6 8l-2 4.5M12 3.5 10 8l2 4.5"/><path d="M2 8h12" stroke-dasharray="1.6 1.4"/>`),
  detailView: S(`<circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5 14 14"/><circle cx="6.5" cy="6.5" r="1.4"/>`),
  annotation: S(`<path d="M2 3.5h12v7H8l-3 3v-3H2z"/><path d="M5 6h6M5 8h4"/>`),
  bom: S(`<path d="M2 2.5h12v11H2z"/><path d="M2 5.5h12M2 8.5h12M6 2.5v11M10 2.5v11" stroke-dasharray="0"/>`),
  sheetFormat: S(`<path d="M2 2.5h12v11H2z"/><path d="M2 2.5h12v11H2z" stroke-width="2.2" opacity=".35"/><path d="M9 10.5h5v3H9z"/>`),
  alignView: S(`<path d="M8 1.5v13M1.5 8h13" stroke-dasharray="2 1.6"/><path d="M4 4.5h3v3H4zM9 8.5h3v3H9z"/>`),

  // ============ 评估 ============
  measure: S(`<path d="M2.5 13.5 13.5 2.5"/><path d="M2.5 9.5v4h4M13.5 6.5v-4h-4"/><path d="M5 8h3M8 5v3"/>`),
  massProps: S(`<circle cx="8" cy="8" r="6"/><path d="M8 4.5v3.5l2.5 1.5"/><path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2"/>`),
  sectionPlane: S(`<path d="M2.5 11.5 8 2.5l5.5 9z" fill="currentColor" opacity=".14"/><path d="M2.5 11.5 8 2.5l5.5 9z"/><path d="M1 13.5h14" stroke-dasharray="2 1.6"/>`),
  check: S(`<circle cx="8" cy="8" r="6"/><path d="M5.2 8.2 7.2 10.2 11 6.2"/>`),
  simulation: S(`<path d="M2 11.5h12"/><path d="M3.5 11.5c0-3 2-5.5 4.5-5.5s4.5 2.5 4.5 5.5" stroke-dasharray="2 1.4"/><path d="M8 3v3"/><circle cx="8" cy="2.6" r="1"/>`),

  // ============ 视图 ============
  zoomFit: S(`<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/><path d="M4.5 7h5M7 4.5v5"/>`),
  zoomArea: S(`<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/><path d="M4.8 4.8h2M4.8 4.8v2M9.2 9.2h-2M9.2 9.2v-2"/>`),
  zoomIn: S(`<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/><path d="M4.8 7h4.4M7 4.8v4.4"/>`),
  zoomOut: S(`<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/><path d="M4.8 7h4.4"/>`),
  viewOrient: S(`<path d="M8 1.6 14 4.8v6.4L8 14.4 2 11.2V4.8z"/><path d="M2 4.8 8 8l6-3.2"/><path d="M11.5 1.5v3M10 3h3" opacity=".5"/>`),
  displayStyle: S(`<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" opacity=".35"/>`),
  shaded: S(`<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none"/>`),
  wireframe: S(`<circle cx="8" cy="8" r="6"/><path d="M8 2v12M2 8h12M3.8 3.8 12.2 12.2M12.2 3.8 3.8 12.2" opacity=".55"/>`),
  hiddenLines: S(`<circle cx="8" cy="8" r="6"/><path d="M8 2v12" stroke-dasharray="1.8 1.4"/><path d="M2 8h12" stroke-dasharray="1.8 1.4"/>`),
  grid: S(`<path d="M2 2.5h12v11H2z"/><path d="M6 2.5v11M10 2.5v11M2 6.5h12M2 10.5h12"/>`),
  plane: S(`<path d="M1.5 10.5 6 4.5h8.5L10 10.5z"/><path d="M1.5 10.5h8.5l4.5-6"/>`),
  axis: S(`<path d="M8 13.5V3M8 3 6 5M8 3l2 2"/><path d="M2.5 13.5h11"/>`),
  origin: S(`<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>`),
  isometric: S(`<path d="M8 1.8 14 5v6L8 14.2 2 11V5z"/><path d="M2 5l6 3.2L14 5M8 8.2V14.2"/>`),
  front: S(`<path d="M3 3.5h10v9H3z" fill="currentColor" opacity=".14"/><path d="M3 3.5h10v9H3z"/>`),
  top: S(`<path d="M2.5 5 8 2.5 13.5 5 8 7.5z" fill="currentColor" opacity=".2"/><path d="M2.5 5 8 2.5 13.5 5 8 7.5z"/>`),
  right: S(`<path d="M8 2.5 13.5 5v6L8 13.5z" fill="currentColor" opacity=".2"/><path d="M8 2.5 13.5 5v6L8 13.5z"/>`),
  section: S(`<path d="M8 1.6 14 4.8v6.4L8 14.4 2 11.2V4.8z"/><path d="M8 1.6v6.4M8 8l6-3.2M8 8 2 4.8" opacity=".5"/><path d="M2 8.8 8 12l6-3.2" stroke-dasharray="1.8 1.4"/>`),
  transparency: S(`<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3.2" stroke-dasharray="1.8 1.4"/>`),
  realview: S(`<circle cx="8" cy="8" r="6"/><path d="M5 6.2a3 3 0 0 1 5.6-.8" /><circle cx="6.5" cy="9.5" r="1.2" fill="currentColor" stroke="none" opacity=".4"/>`),
  rotateView: S(`<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.6 2v3.4h-3.4"/>`),
  appearance: S(`<path d="M8 2.2s4.1 4.6 4.1 7.3a4.1 4.1 0 0 1-8.2 0C3.9 6.8 8 2.2 8 2.2z"/><circle cx="6.3" cy="9.2" r="1.1" fill="#ffffff" stroke="none" opacity=".6"/>`),
  lighting: S(`<path d="M8 1.8a4.6 4.6 0 0 0-2.7 8.3c.5.4.8 1 .8 1.6v.3h3.8v-.3c0-.6.3-1.2.8-1.6A4.6 4.6 0 0 0 8 1.8z"/><path d="M6.3 14h3.4M7.1 15.4h1.8"/>`),

  // ============ 其他 ============
  folder: S(`<path d="M1.5 12.5v-9h4l1.4 1.8h7.6v7.2z"/>`),
  part: S(`<path d="M8 1.6 14 4.8v6.4L8 14.4 2 11.2V4.8z"/><path d="M2 4.8 8 8l6-3.2M8 8v6.4"/>`),
  originPlane: S(`<path d="M2 11.5 8 2.5l6 9z"/>`),
  chevronRight: `<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`,
  chevronDown: `<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6 8 10.5 12.5 6"/></svg>`,
  x: `<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  plus: `<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>`,
  eye: S(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>`),
  eyeOff: S(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5 13.5 13.5"/>`),
  warning: S(`<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6v3.5"/><circle cx="8" cy="11.6" r=".75" fill="currentColor" stroke="none"/>`),
  info: S(`<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".75" fill="currentColor" stroke="none"/>`),

  // ============ SolidWorks 界面：菜单 / 工具栏 / 状态栏 ============
  /** 打印 */
  print: S(`<path d="M4.5 6V2.5h7V6"/><path d="M2.5 6h11v5h-2.5v3h-6v-3H2.5z"/><path d="M11 8.4h.8"/>`),
  /** 剪切 */
  cut: S(`<path d="M4.4 2.2 11.6 11.4M11.6 2.2 4.4 11.4"/><circle cx="4.2" cy="13" r="1.8"/><circle cx="11.8" cy="13" r="1.8"/>`),
  /** 复制 */
  copy: S(`<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5V3a.5.5 0 0 0-.5-.5H3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h2.5"/>`),
  /** 粘贴 */
  paste: S(`<path d="M5.5 3H3.5v11h9V3h-2"/><rect x="5.5" y="1.6" width="5" height="2.6" rx=".7"/><path d="M5.5 8.5h5M5.5 11h3.5"/>`),
  /** 删除（垃圾桶） */
  trash: S(`<path d="M2.5 4.2h11"/><path d="M4 4.2 4.8 13.5h6.4L12 4.2"/><path d="M6 4.2V2.5h4v1.7"/><path d="M6.6 7v4M9.4 7v4"/>`),
  /** 选项 / 齿轮（带滑块） */
  options: S(`<path d="M2 4.5h12M2 11.5h12"/><circle cx="5.5" cy="4.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="10.5" cy="11.5" r="1.6" fill="currentColor" stroke="none"/>`),
  /** 宏 / 脚本 */
  macro: S(`<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.2"/><path d="M1.8 5.6h12.4"/><path d="M4.6 8.4 6.4 10.2l-1.8 1.8M8 12h3.4"/>`),
  /** 窗口 */
  window: S(`<rect x="1.6" y="3" width="12.8" height="10" rx="1.2"/><path d="M1.6 6h12.8"/><path d="M4 1.6h10.4v9" opacity=".5"/>`),
  /** 关于 / 信息圆圈 */
  about: S(`<circle cx="8" cy="8" r="6.2"/><path d="M8 7.4v4"/><circle cx="8" cy="4.9" r=".75" fill="currentColor" stroke="none"/>`),
  /** 教程 / 书本 */
  book: S(`<path d="M2.4 3.2c2-.9 3.6-.9 5.6 0v9.6c-2-.9-3.6-.9-5.6 0z"/><path d="M13.6 3.2c-2-.9-3.6-.9-5.6 0v9.6c2-.9 3.6-.9 5.6 0z"/>`),
  /** 搜索 / 查找 */
  search: S(`<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14"/>`),
  /** 放大镜（SolidWorks 视图工具） */
  magnifier: S(`<circle cx="6.8" cy="6.8" r="4.2"/><path d="M9.9 9.9 14 14"/><path d="M4.8 6.8h4M6.8 4.8v4"/>`),
  /** 上一视图 */
  prevView: S(`<path d="M8 2.2 14 5.4v5.2L8 13.8 2 10.6V5.4z"/><path d="M2 5.4 8 8.6l6-3.2M8 8.6v5.2" opacity=".45"/><path d="M13.6 2.6A7 7 0 0 0 2.6 6" stroke-dasharray="2 1.4"/><path d="M1.6 3.2 2.7 6.1 5.5 5.2"/>`),
  /** 剖面视图 */
  sectionCut: S(`<path d="M2 2.6h12v10.8H2z"/><path d="M2 8h12"/><path d="M4.2 3.6 6.4 8l-2.2 4.4M11.8 3.6 9.6 8l2.2 4.4"/><path d="M2 8h12" stroke-dasharray="1.6 1.4"/>`),
  /** 显示样式（半明暗球） */
  displayStyle2: S(`<circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none" opacity=".32"/>`),
  /** 隐藏 / 显示项目（眼睛 + 齿轮） */
  hideShowItems: S(`<path d="M1.6 7.4S4 3.6 8 3.6s6.4 3.8 6.4 3.8S12 11.2 8 11.2 1.6 7.4 1.6 7.4z"/><circle cx="8" cy="7.4" r="1.8"/><path d="M5.6 13.6h5.2" opacity=".6"/>`),
  /** 应用布景（球 + 底板） */
  applyScene: S(`<circle cx="8" cy="6.4" r="4"/><path d="M2.4 13.6h11.2"/><path d="M5.4 6.4a2.6 2.6 0 0 1 5.2 0" opacity=".55"/>`),
  /** 视图设置（滑块面板） */
  viewSettings: S(`<rect x="2" y="2.6" width="12" height="10.8" rx="1.2"/><path d="M4.6 5.6h6.8M4.6 8h6.8M4.6 10.4h4.4"/><circle cx="6.6" cy="5.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.4" cy="8" r="1.1" fill="currentColor" stroke="none"/>`),
  /** 显示模式：透视 */
  perspective: S(`<path d="M2.6 3.4 8 5.4l5.4-2v9.2L8 10.6l-5.4 2z"/><path d="M8 5.4v5.2" opacity=".5"/>`),
  /** 显示模式：正投影 */
  orthographic: S(`<path d="M2.6 3.4h10.8v9.2H2.6z"/><path d="M2.6 6.6h10.8M2.6 9.6h10.8" opacity=".5"/>`),
  /** 正视于（法向视图） */
  normalTo: S(`<path d="M8 2.2 14 5.4v5.2L8 13.8 2 10.6V5.4z"/><path d="M2 5.4 8 8.6l6-3.2M8 8.6v5.2" opacity=".4"/><path d="M8 1.4v4.6"/><circle cx="8" cy="6.4" r="1.5" fill="currentColor" stroke="none"/>`),
  /** 旋转视图 */
  rotate: S(`<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.6 2.2v3.2h-3.2"/>`),
  /** 平移视图 */
  pan: S(`<path d="M8 1.8v12.4M1.8 8h12.4" opacity=".35"/><path d="M8 2.2 6.2 4M8 2.2l1.8 1.8M8 13.8 6.2 12M8 13.8l1.8-1.8M2.2 8 4 6.2M2.2 8l1.8 1.8M13.8 8 12 6.2M13.8 8l-1.8 1.8"/>`),
  /** 缩放 */
  zoom: S(`<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14"/><path d="M4.8 7h4.4"/>`),
  /** 重建（红绿灯式刷新箭头） */
  rebuildModel: S(`<path d="M3 8a5 5 0 0 1 8.5-3.6"/><path d="M13 8a5 5 0 0 1-8.5 3.6"/><path d="M11.6 2v2.6h-2.6M4.4 14v-2.6h2.6"/>`),
  /** 单位系统（砝码） */
  unit: S(`<path d="M8 2.2 10.6 7H5.4z"/><path d="M3.2 7h9.6l1.4 6.4H1.8z"/><path d="M6.6 10h2.8"/>`),
  /** 坐标系 */
  coordSystem: S(`<path d="M3 13V3M3 13h10"/><path d="M3 13 12 6" opacity=".5"/><path d="M1.8 4.4 3 3l1.2 1.4M11.6 11.8 13 13l-1.4 1.2"/>`),
  /** 选择过滤器 */
  filter: S(`<path d="M2 3.4h12l-4.6 5.2v5L6.6 12V8.6z"/>`),
  /** 快速提示（灯泡） */
  tip: S(`<path d="M8 1.8a4.2 4.2 0 0 0-2.4 7.6v1.8h4.8V9.4A4.2 4.2 0 0 0 8 1.8z"/><path d="M6.2 13.6h3.6"/><path d="M8 6.2v3" opacity=".5"/>`),
  /** 历史记录（时钟 + 箭头） */
  history: S(`<circle cx="8" cy="8" r="5.6"/><path d="M8 4.6V8l2.4 1.6"/><path d="M2.4 3.4v2.8h2.8"/>`),
  /** 注解 */
  annotation2: S(`<path d="M2 3.2h12v7.2H8l-3 3.2v-3.2H2z"/><path d="M5 6.2h6M5 8.2h3.6"/>`),
  /** 材料 */
  material: S(`<path d="M8 1.8 13.6 5v6L8 14.2 2.4 11V5z"/><path d="M2.4 5 8 8.2 13.6 5M8 8.2v6" opacity=".5"/><path d="M5.2 3.4 10.8 6.6" opacity=".35"/>`),
  /** 组合曲线 / 折线 */
  polyline: S(`<path d="M2 12.6 5.6 6 9.4 10.4 14 3.4"/><circle cx="2" cy="12.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="5.6" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.4" cy="10.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="14" cy="3.4" r="1.1" fill="currentColor" stroke="none"/>`),
  /** 3D 草图 */
  sketch3d: S(`<path d="M2 12.6 5.6 6 9.4 10.4 14 3.4"/><path d="M2 12.6V3M2 12.6h12" opacity=".4"/>`),
  /** 剪裁实体（剪刀） */
  trimEntities: S(`<path d="M4.6 2.4 11.4 10.4M11.4 2.4 4.6 10.4"/><circle cx="4.4" cy="12.4" r="1.7"/><circle cx="11.6" cy="12.4" r="1.7"/>`),
  /** 等距实体（偏移） */
  offsetEntities: S(`<path d="M2.4 4.6h5.2a3.4 3.4 0 0 1 0 6.8H2.4"/><path d="M2.4 8h5.2a1.2 1.2 0 0 0 0-2.4H2.4" stroke-dasharray="1.6 1.3"/>`),
  /** 添加几何关系 */
  addRelation2: S(`<circle cx="4.4" cy="11.4" r="2.2"/><circle cx="11.6" cy="4.6" r="2.2"/><path d="M6.2 9.8 9.8 6.2" stroke-dasharray="1.6 1.3"/>`),
  /** 显示隐藏（眼睛+箭头） */
  hideShow: S(`<path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/><path d="M8 1.2v1.8" opacity=".6"/>`),
  /** 布景/灯光 */
  lights: S(`<path d="M4.4 1.8h7.2v3.2L10 7.4H6L4.4 5z"/><path d="M6.6 9.4h2.8v2.2H6.6z"/><path d="M5.6 13.4h4.8"/>`),
  /** 相机 / 视图 */
  camera: S(`<path d="M1.8 5.4h3.4l1.2-1.8h3.2l1.2 1.8h3.4v7.2H1.8z"/><circle cx="8" cy="8.8" r="2.4"/>`),
  /** 关闭文档 */
  closeDoc: S(`<path d="M3.6 1.8h5.8L12.4 5v9.2H3.6z"/><path d="M9.4 1.8V5h3"/><path d="M6 8.2 10 12.2M10 8.2 6 12.2"/>`),
  /** 重命名 */
  rename: S(`<path d="M2.4 12.4 3 9.4 10.4 2l3 3L6 12.4z"/><path d="M9.2 3.2 12.2 6.2"/><path d="M2.4 14.4h11.2" opacity=".5"/>`),
  /** 父子关系 */
  parents: S(`<rect x="1.6" y="2.4" width="5" height="3.4" rx=".6"/><rect x="9.4" y="2.4" width="5" height="3.4" rx=".6"/><rect x="5.5" y="10.2" width="5" height="3.4" rx=".6"/><path d="M4.1 5.8v2.4h7.8V5.8M8 8.2v2"/>`),
  /** 压缩 / 抑制 */
  suppress: S(`<circle cx="8" cy="8" r="6"/><path d="M4.6 8h6.8"/>`),
  /** 解压缩 / 恢复 */
  unsuppress: S(`<circle cx="8" cy="8" r="6"/><path d="M4.6 8h6.8M8 4.6v6.8"/>`),
  /** 回退控制棒 */
  rollback: S(`<path d="M2 8h12"/><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/><path d="M2 4.4v7.2M14 4.4v7.2"/>`),
  /** 展开箭头（设计树） */
  caretRight: `<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" stroke="none"><path d="M6 3.6 10.4 8 6 12.4z"/></svg>`,
  caretDown: `<svg class="ic" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" stroke="none"><path d="M3.6 6 8 10.4 12.4 6z"/></svg>`,

  // ============ AI ============
  /** 四角星火花（AI 助手） */
  ai: S(`<path d="M6.6 1.8 7.9 5.3 11.4 6.6 7.9 7.9 6.6 11.4 5.3 7.9 1.8 6.6 5.3 5.3z"/><path d="M12.4 10.2l.65 1.75 1.75.65-1.75.65-.65 1.75-.65-1.75-1.75-.65 1.75-.65z"/>`),
  /** 命令行（自然语言输入） */
  aiPrompt: S(`<rect x="1.6" y="3" width="12.8" height="10" rx="1.6"/><path d="M4.2 6.4 6.4 8l-2.2 1.6M8 10h3.6"/>`),
};

export function icon(name: string, size = 16): string {
  return ICONS[name] || ICONS.part;
}
