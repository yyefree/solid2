/**
 * 工程图模块。
 *
 * 隐藏线消除：把每条特征边离散成点，逐点向观察者发射线，若与实体相交则该点被遮挡，
 * 标为虚线（等价于逐点 HLR）。几何来源改为内核 Worker 回传的 MeshResult——
 * 特征边折线（edgePolylines）与三角网格都已在 Worker 算好，这里只做投影与射线，
 * 完全不 import opencascade。
 */
import * as THREE from 'three';
import type { MeshResult } from '../core/kernel-types';
import { convertLength, trim, fix, UNIT_BY_ID, type UnitSystem } from '../core/units';

export type ViewKind = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'iso';

export interface DimAnnotation {
  id: string;
  /** 标注的两个端点（视图局部 mm 坐标） */
  a: [number, number];
  b: [number, number];
  /** 尺寸线偏移（mm） */
  offset: number;
  /** 文字位置微调 */
  textOffset?: [number, number];
  /** 尺寸公差（mm）。upper/lower 均以实际正负值给出；相等时渲染 ± 形式。 */
  tolerance?: { upper: number; lower: number };
  /** 前缀，如 'φ'（直径） */
  prefix?: string;
}

/** 形位公差符号 */
export type GdtSymbol =
  | 'position' | 'flatness' | 'straightness' | 'roundness' | 'cylindricity'
  | 'perpendicularity' | 'parallelism' | 'coaxiality' | 'symmetry'
  | 'circularRunout' | 'totalRunout';

export const GDT_LABEL: Record<GdtSymbol, string> = {
  position: '位置度', flatness: '平面度', straightness: '直线度', roundness: '圆度',
  cylindricity: '圆柱度', perpendicularity: '垂直度', parallelism: '平行度',
  coaxiality: '同轴度', symmetry: '对称度', circularRunout: '圆跳动', totalRunout: '全跳动',
};

/** 几何公差标注（特征控制框） */
export interface GdtAnnotation {
  id: string;
  viewId: string;
  symbol: GdtSymbol;
  /** 公差值（mm） */
  tol: number;
  /** 基准字母，如 'A'/'A-B' */
  datum?: string;
  /** 尺寸要素标记（孔径类） */
  diameter?: boolean;
  /** 锚点（视图局部 mm 坐标），引线指向此处 */
  anchor: [number, number];
  /** 标注框左上角（图纸坐标） */
  pos: [number, number];
}

/** 工程图里的孔（由圆的棱边识别），用于孔位自动标注 */
export interface HoleMark {
  /** 圆心（视图局部 mm 坐标） */
  cx: number;
  cy: number;
  /** 真实直径（mm） */
  dia: number;
  /** 视图法向与孔轴的夹角余弦绝对值；接近 1 时孔呈正圆可见 */
  round: number;
}

export interface BomRow {
  no: number;
  name: string;
  qty: number;
  material?: string;
  note?: string;
}

export interface ProjectedEdge {
  pts: [number, number][];
  hidden: boolean;
}

export interface DrawingView {
  id: string;
  kind: ViewKind;
  label: string;
  /** 视图中心在图纸上的位置（mm） */
  cx: number;
  cy: number;
  scale: number;
  edges: ProjectedEdge[];
  dims: DimAnnotation[];
  /** 视图中识别出的孔（圆棱边投影） */
  holes: HoleMark[];
  /** 视图包围盒（图纸 mm 坐标，用于布局与拾取） */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface SheetSpec {
  w: number;
  h: number;
  margin: number;
  title: string;
  code: string;
  material: string;
}

/**
 * 工程图的序列化形态（项目文件 / 撤销快照共用）。
 *
 * 存的是**投影结果**（edges/holes/bbox）而非「重算指令」：工程图视图是 mesh 的
 * 一次性投影，重新生成需要内核在场且会丢掉用户手改的标注位置。存结果才能做到
 * 「保存时看到什么，打开后就是什么」；零件后续改动的同步仍走「重新生成视图」。
 *
 * `seq` 系列是 id 发号器，必须一起存 —— 否则重开后新视图/标注从 1 重新编号，
 * 与已有 id 撞车（`selectedRuns` 的 `viewId:runIdx` 键、删除标注都会打错目标）。
 */
export interface SerializedDrawing {
  version: 1;
  views: DrawingView[];
  sheet: SheetSpec;
  showHidden: boolean;
  fixedScale: number;
  gdts: GdtAnnotation[];
  bom: BomRow[];
  unitSystem: UnitSystem;
  seq: number;
  dimSeq: number;
  gdtSeq: number;
}

/** 从 `v12` / `dim3` / `gdt7` 这类 id 里取数字后缀的最大值（外部文件的发号器兜底） */
function maxIdSuffix(ids: string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

const VIEW_BASIS: Record<ViewKind, { f: [number, number, number]; up: [number, number, number] }> = {
  front: { f: [0, 1, 0], up: [0, 0, 1] },
  back: { f: [0, -1, 0], up: [0, 0, 1] },
  top: { f: [0, 0, -1], up: [0, 1, 0] },
  bottom: { f: [0, 0, 1], up: [0, 1, 0] },
  left: { f: [1, 0, 0], up: [0, 0, 1] },
  right: { f: [-1, 0, 0], up: [0, 0, 1] },
  iso: { f: [1, -1, -0.8], up: [0, 0, 1] },
};

export const VIEW_LABEL: Record<ViewKind, string> = {
  front: '主视图',
  back: '后视图',
  top: '俯视图',
  bottom: '仰视图',
  left: '左视图',
  right: '右视图',
  iso: '等轴测',
};

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v: [number, number, number]): [number, number, number] {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

export class Drawing {
  views: DrawingView[] = [];
  sheet: SheetSpec = {
    w: 420,
    h: 297,
    margin: 10,
    title: 'Solid2 零件',
    code: 'S2-0001',
    material: '碳钢',
  };
  /** 是否显示隐藏线 */
  showHidden = true;
  /** 全局比例（0 = 自动） */
  fixedScale = 0;
  /** 交互标注时高亮的投影边（`viewId:runIdx`） */
  selectedRuns = new Set<string>();
  /** 形位公差标注 */
  gdts: GdtAnnotation[] = [];
  /** 明细表（BOM） */
  bom: BomRow[] = [];
  /** 单位制（与 App 同步；尺寸数值与公差按此换算，内部几何恒为 mm） */
  unitSystem: UnitSystem = 'MMGS';
  private seq = 0;
  private dimSeq = 0;
  private gdtSeq = 0;

  clear(): void {
    this.views = [];
  }

  /** 由网格结果生成指定视图 */
  addView(kind: ViewKind, mesh: MeshResult, scale = 0): DrawingView | null {
    const basis = VIEW_BASIS[kind];
    const f = norm(basis.f);
    const upRaw = basis.up;
    let r = norm(cross(f, upRaw));
    let up = norm(cross(r, f));
    if (kind === 'iso') {
      const d = norm([1, -1, 0.8]);
      r = norm(cross(d, [0, 0, 1]));
      up = norm(cross(r, d));
    }

    const rayMesh = buildRaycastMesh(mesh);
    const edges = this.projectEdges(mesh, r, up, f, rayMesh);
    rayMesh.geometry.dispose();
    (rayMesh.material as THREE.Material).dispose();

    const view: DrawingView = {
      id: `v${++this.seq}`,
      kind,
      label: VIEW_LABEL[kind],
      cx: 0,
      cy: 0,
      scale: scale || 1,
      edges,
      dims: [],
      holes: this.collectHoles(mesh, r, up, f),
      bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
    };
    this.computeBBox(view);
    this.views.push(view);
    return view;
  }

  /** 从圆的棱边元数据收集孔：投影圆心 + 真实直径 + 圆度 */
  private collectHoles(mesh: MeshResult, r: [number, number, number], up: [number, number, number], f: [number, number, number]): HoleMark[] {
    const out: HoleMark[] = [];
    for (const em of mesh.edgeMetas ?? []) {
      if (em.curveType !== 'circle' || !em.axis || !em.radius) continue;
      const [cx, cy] = projectVertex(em.axis.point, r, up);
      // 圆度：孔平面法向与视线夹角的余弦绝对值
      const round = Math.abs(em.axis.dir[0] * f[0] + em.axis.dir[1] * f[1] + em.axis.dir[2] * f[2]);
      out.push({ cx, cy, dia: em.radius * 2, round });
    }
    return out;
  }

  private projectEdges(
    mesh: MeshResult,
    r: [number, number, number],
    up: [number, number, number],
    f: [number, number, number],
    rayMesh: THREE.Mesh
  ): ProjectedEdge[] {
    const out: ProjectedEdge[] = [];
    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3(-f[0], -f[1], -f[2]); // 指向观察者
    const eps = 0.02;

    for (const flat of mesh.edgePolylines) {
      if (flat.length < 6) continue;
      const pts: [number, number, number][] = [];
      for (let i = 0; i < flat.length; i += 3) {
        pts.push([flat[i], flat[i + 1], flat[i + 2]]);
      }

      let run: [number, number][] = [];
      let runHidden = false;
      const flush = () => {
        if (run.length >= 2) out.push({ pts: run, hidden: runHidden });
        run = [];
      };

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        origin.set(p[0], p[1], p[2]);
        origin.addScaledVector(dir, eps);
        raycaster.set(origin, dir);
        const hits = raycaster.intersectObject(rayMesh, false);
        const hidden = hits.length > 0;

        const uv: [number, number] = [p[0] * r[0] + p[1] * r[1] + p[2] * r[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]];

        if (run.length === 0) {
          run.push(uv);
          runHidden = hidden;
        } else if (hidden === runHidden) {
          run.push(uv);
        } else {
          run.push(uv);
          flush();
          run.push(uv);
          runHidden = hidden;
        }
      }
      flush();
    }
    return out;
  }

  private computeBBox(view: DrawingView): void {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const e of view.edges) {
      for (const p of e.pts) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    }
    if (!Number.isFinite(x0)) {
      x0 = y0 = x1 = y1 = 0;
    }
    view.bbox = { x0, y0, x1, y1 };
  }

  /** 自动布局：第三角投影标准摆放 */
  layout(): void {
    if (!this.views.length) return;
    const m = this.sheet.margin;
    const titleH = 36;
    const usableW = this.sheet.w - m * 2;
    const usableH = this.sheet.h - m * 2 - titleH;

    let maxW = 0;
    let maxH = 0;
    for (const v of this.views) {
      maxW = Math.max(maxW, v.bbox.x1 - v.bbox.x0);
      maxH = Math.max(maxH, v.bbox.y1 - v.bbox.y0);
    }
    const colCount = this.views.length <= 1 ? 1 : 2;
    const rowCount = Math.ceil(this.views.length / colCount);
    const cellW = usableW / colCount;
    const cellH = usableH / rowCount;

    let scale = this.fixedScale;
    if (!scale) {
      const sx = (cellW * 0.62) / Math.max(maxW, 1);
      const sy = (cellH * 0.62) / Math.max(maxH, 1);
      scale = Math.min(sx, sy);
      const std = [0.1, 0.2, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 10];
      scale = std.filter((s) => s <= scale).pop() ?? 0.1;
    }

    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      v.scale = scale;
      const col = i % colCount;
      const row = Math.floor(i / colCount);
      v.cx = m + cellW * (col + 0.5);
      v.cy = m + cellH * (row + 0.5);
    }
  }

  /** 视图局部坐标 → 图纸坐标 */
  toSheet(view: DrawingView, p: [number, number]): [number, number] {
    return [view.cx + p[0] * view.scale, view.cy - p[1] * view.scale];
  }

  /** 生成 SVG 字符串 */
  toSVG(): string {
    const { w, h, margin } = this.sheet;
    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" ` +
        `font-family="'Segoe UI','Microsoft YaHei',sans-serif">`
    );
    parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`);
    parts.push(
      `<rect x="${margin}" y="${margin}" width="${w - margin * 2}" height="${h - margin * 2}" ` +
        `fill="none" stroke="#111" stroke-width="0.7"/>`
    );
    parts.push(
      `<rect x="${margin + 4}" y="${margin + 4}" width="${w - margin * 2 - 8}" height="${h - margin * 2 - 8}" ` +
        `fill="none" stroke="#111" stroke-width="0.35"/>`
    );

    for (const v of this.views) {
      v.edges.forEach((e, ei) => {
        if (e.hidden && !this.showHidden) return;
        const d = e.pts.map((p) => this.toSheet(v, p).map((n) => n.toFixed(3)).join(',')).join(' ');
        const dash = e.hidden ? ' stroke-dasharray="1.6,1.1"' : '';
        const selected = this.selectedRuns.has(`${v.id}:${ei}`);
        const width = selected ? 0.95 : e.hidden ? 0.18 : 0.42;
        const color = selected ? '#2b7de9' : e.hidden ? '#8a97a5' : '#101820';
        // 组 + 透明加宽命中线：便于交互拾取（可见线本身不吃事件）
        parts.push(`<g class="d-run" data-vw="${v.id}" data-re="${ei}">`);
        parts.push(
          `<polyline class="d-hit" points="${d}" fill="none" stroke="transparent" stroke-width="2.4" pointer-events="stroke"/>`
        );
        parts.push(
          `<polyline class="d-vis" points="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash} pointer-events="none"/>`
        );
        parts.push('</g>');
      });
      for (const dim of v.dims) {
        parts.push(`<g class="d-dim" data-vw="${v.id}" data-dim="${dim.id}">`);
        parts.push(this.dimSVG(v, dim));
        parts.push('</g>');
      }
      const labelPos = this.toSheet(v, [v.bbox.x0, v.bbox.y0 - 6 / Math.max(v.scale, 1e-6)]);
      parts.push(
        `<text x="${labelPos[0].toFixed(2)}" y="${labelPos[1].toFixed(2)}" font-size="4.2" fill="#22303f">` +
          `${v.label}  1:${(1 / v.scale).toFixed(2).replace(/\.?0+$/, '')}</text>`
      );
      // 孔中心十字 + 中心线（孔位标注的图形基础）
      for (const h of v.holes) {
        const c = this.toSheet(v, [h.cx, h.cy]);
        const arm = Math.max(h.dia * v.scale * 0.75, 3.2);
        const cross = h.dia * v.scale * 0.55;
        parts.push(`<g class="d-hole" data-vw="${v.id}">`);
        parts.push(
          `<line x1="${(c[0] - arm).toFixed(2)}" y1="${c[1].toFixed(2)}" x2="${(c[0] + arm).toFixed(2)}" y2="${c[1].toFixed(2)}" stroke="#5a6b7a" stroke-width="0.16" stroke-dasharray="1.4,1"/>`
        );
        parts.push(
          `<line x1="${c[0].toFixed(2)}" y1="${(c[1] - arm).toFixed(2)}" x2="${c[0].toFixed(2)}" y2="${(c[1] + arm).toFixed(2)}" stroke="#5a6b7a" stroke-width="0.16" stroke-dasharray="1.4,1"/>`
        );
        parts.push(
          `<line x1="${(c[0] - cross).toFixed(2)}" y1="${c[1].toFixed(2)}" x2="${(c[0] + cross).toFixed(2)}" y2="${c[1].toFixed(2)}" stroke="#b53322" stroke-width="0.2"/>`
        );
        parts.push(
          `<line x1="${c[0].toFixed(2)}" y1="${(c[1] - cross).toFixed(2)}" x2="${c[0].toFixed(2)}" y2="${(c[1] + cross).toFixed(2)}" stroke="#b53322" stroke-width="0.2"/>`
        );
        parts.push('</g>');
      }
    }

    // 形位公差标注
    for (const g of this.gdts) {
      const v = this.views.find((x) => x.id === g.viewId);
      if (!v) continue;
      parts.push(`<g class="d-gdt" data-vw="${g.viewId}" data-gdt="${g.id}">`);
      parts.push(this.gdtSVG(g, v));
      parts.push('</g>');
    }

    // 明细表（BOM）
    if (this.bom.length) parts.push(this.bomSVG());

    parts.push(this.titleBlockSVG());
    parts.push('</svg>');
    return parts.join('');
  }

  private dimSVG(v: DrawingView, dim: DimAnnotation): string {
    const a = this.toSheet(v, dim.a);
    const b = this.toSheet(v, dim.b);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    let nx = -dy / L;
    let ny = dx / L;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const off = dim.offset;
    const a2: [number, number] = [a[0] + nx * off, a[1] + ny * off];
    const b2: [number, number] = [b[0] + nx * off, b[1] + ny * off];
    const sys = this.unitSystem;
    const dig = UNIT_BY_ID[sys].digits.len;
    const valMm = Math.hypot(dim.b[0] - dim.a[0], dim.b[1] - dim.a[1]) * v.scale;
    const val = trim(convertLength(valMm, sys), dig);

    const s: string[] = [];
    const arrow = 1.6;
    s.push(
      `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${(a2[0] + nx * 1.2).toFixed(2)}" y2="${(a2[1] + ny * 1.2).toFixed(2)}" stroke="#b53322" stroke-width="0.22"/>`
    );
    s.push(
      `<line x1="${b[0].toFixed(2)}" y1="${b[1].toFixed(2)}" x2="${(b2[0] + nx * 1.2).toFixed(2)}" y2="${(b2[1] + ny * 1.2).toFixed(2)}" stroke="#b53322" stroke-width="0.22"/>`
    );
    s.push(
      `<line x1="${a2[0].toFixed(2)}" y1="${a2[1].toFixed(2)}" x2="${b2[0].toFixed(2)}" y2="${b2[1].toFixed(2)}" stroke="#b53322" stroke-width="0.25"/>`
    );
    const ux = (b2[0] - a2[0]) / L;
    const uy = (b2[1] - a2[1]) / L;
    s.push(
      `<path d="M ${a2[0].toFixed(2)} ${a2[1].toFixed(2)} l ${(ux * arrow).toFixed(2)} ${(uy * arrow).toFixed(2)} l ${(-uy * arrow * 0.35).toFixed(2)} ${(ux * arrow * 0.35).toFixed(2)} z" fill="#b53322"/>`
    );
    s.push(
      `<path d="M ${b2[0].toFixed(2)} ${b2[1].toFixed(2)} l ${(-ux * arrow).toFixed(2)} ${(-uy * arrow).toFixed(2)} l ${(uy * arrow * 0.35).toFixed(2)} ${(-ux * arrow * 0.35).toFixed(2)} z" fill="#b53322"/>`
    );
    const mx = (a2[0] + b2[0]) / 2 + (dim.textOffset?.[0] ?? 0);
    const my = (a2[1] + b2[1]) / 2 + (dim.textOffset?.[1] ?? -1.1);
    const prefix = dim.prefix ?? '';
    const valTxt = `${prefix}${val}`;
    const tol = dim.tolerance;
    if (tol) {
      // 对称 ±（上下偏差互为相反数）；否则上下堆叠
      if (Math.abs(tol.upper + tol.lower) < 1e-9 && Math.abs(tol.upper - tol.lower) >= 1e-9) {
        const sym = trim(convertLength(tol.upper, sys), dig).replace(/0+$/, '').replace(/\.$/, '');
        s.push(
          `<text x="${mx.toFixed(2)}" y="${my.toFixed(2)}" font-size="3.4" fill="#b53322" text-anchor="middle">${valTxt} ±${sym}</text>`
        );
      } else {
        const up = (tol.upper >= 0 ? '+' : '') + fix(convertLength(tol.upper, sys), 2);
        const lo = (tol.lower >= 0 ? '+' : '') + fix(convertLength(tol.lower, sys), 2);
        s.push(
          `<text x="${mx.toFixed(2)}" y="${my.toFixed(2)}" font-size="3.4" fill="#b53322" text-anchor="middle">${valTxt}` +
            `<tspan dx="1.6" dy="-1.5" font-size="2.6">${up}</tspan>` +
            `<tspan dx="0" dy="2.4" font-size="2.6">${lo}</tspan></text>`
        );
      }
    } else {
      s.push(
        `<text x="${mx.toFixed(2)}" y="${my.toFixed(2)}" font-size="3.4" fill="#b53322" text-anchor="middle">${valTxt}</text>`
      );
    }
    return s.join('');
  }

  private titleBlockSVG(): string {
    const { w, h, margin, title, code, material } = this.sheet;
    const bw = 108;
    const bh = 32;
    const x = w - margin - bw;
    const y = h - margin - bh;
    const rows: [string, string][] = [
      ['名称', title],
      ['图号', code],
      ['材料', material],
      ['比例', this.views[0] ? `1:${(1 / this.views[0].scale).toFixed(2).replace(/\.?0+$/, '')}` : '1:1'],
    ];
    const s: string[] = [];
    s.push(`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="none" stroke="#111" stroke-width="0.5"/>`);
    const rh = bh / rows.length;
    rows.forEach((r, i) => {
      const ry = y + rh * i;
      if (i > 0) s.push(`<line x1="${x}" y1="${ry}" x2="${x + bw}" y2="${ry}" stroke="#111" stroke-width="0.3"/>`);
      s.push(`<line x1="${x + 22}" y1="${ry}" x2="${x + 22}" y2="${ry + rh}" stroke="#111" stroke-width="0.3"/>`);
      s.push(
        `<text x="${x + 3}" y="${ry + rh * 0.7}" font-size="3.2" fill="#111">${r[0]}</text>`
      );
      s.push(
        `<text x="${x + 25}" y="${ry + rh * 0.7}" font-size="3.6" fill="#111" font-weight="600">${escapeXml(r[1])}</text>`
      );
    });
    s.push(
      `<text x="${x - 2}" y="${y - 2}" font-size="3" fill="#556" text-anchor="end">Solid2 · 由几何内核自动生成</text>`
    );
    return s.join('');
  }

  // ============================================================
  // 交互式尺寸标注
  // ============================================================
  /** 为一条投影边添加长度标注（两端点之间） */
  dimensionRun(viewId: string, runIdx: number, offset = 9): DimAnnotation | null {
    const v = this.views.find((x) => x.id === viewId);
    const e = v?.edges[runIdx];
    if (!v || !e || e.pts.length < 2) return null;
    return this.addDim(v, e.pts[0], e.pts[e.pts.length - 1], offset, runIdx);
  }

  /** 为两条投影边的最近端点添加距离标注 */
  dimensionBetweenRuns(viewId: string, a: number, b: number, offset = 9): DimAnnotation | null {
    if (a === b) return this.dimensionRun(viewId, a, offset);
    const v = this.views.find((x) => x.id === viewId);
    const ea = v?.edges[a];
    const eb = v?.edges[b];
    if (!v || !ea || !eb || ea.pts.length < 2 || eb.pts.length < 2) return null;
    const A = [ea.pts[0], ea.pts[ea.pts.length - 1]];
    const B = [eb.pts[0], eb.pts[eb.pts.length - 1]];
    let best = Infinity;
    let pa = A[0];
    let pb = B[0];
    for (const x of A) {
      for (const y of B) {
        const dd = Math.hypot(x[0] - y[0], x[1] - y[1]);
        if (dd < best) {
          best = dd;
          pa = x;
          pb = y;
        }
      }
    }
    return this.addDim(v, pa, pb, offset, a);
  }

  /** 标注的真实长度（mm，已乘视图比例） */
  dimensionValue(view: DrawingView, dim: DimAnnotation): number {
    return Math.hypot(dim.b[0] - dim.a[0], dim.b[1] - dim.a[1]) * view.scale;
  }

  removeDim(viewId: string, dimId: string): void {
    const v = this.views.find((x) => x.id === viewId);
    if (!v) return;
    v.dims = v.dims.filter((d) => d.id !== dimId);
  }

  clearDims(): void {
    for (const v of this.views) v.dims = [];
    this.selectedRuns.clear();
  }

  /** 编辑已有标注的元数据：公差 + 前缀（如 φ） */
  setDimMeta(viewId: string, dimId: string, meta: { tolerance?: { upper: number; lower: number }; prefix?: string }): boolean {
    const v = this.views.find((x) => x.id === viewId);
    const dim = v?.dims.find((d) => d.id === dimId);
    if (!v || !dim) return false;
    if (meta.tolerance !== undefined) dim.tolerance = meta.tolerance;
    if (meta.prefix !== undefined) dim.prefix = meta.prefix === '' ? undefined : meta.prefix;
    return true;
  }

  // ------------------------------------------------------------
  // 形位公差（GD&T）
  // ------------------------------------------------------------
  /**
   * 添加一个特征控制框标注。anchor 为视图局部坐标的锚点（引线指向处），
   * pos 为图纸坐标的框定位；传 null 时自动放在锚点右上方。
   */
  addGdt(
    viewId: string,
    symbol: GdtSymbol,
    tol: number,
    opts: { datum?: string; diameter?: boolean; anchor?: [number, number] } = {}
  ): GdtAnnotation | null {
    const v = this.views.find((x) => x.id === viewId);
    if (!v) return null;
    const anchor: [number, number] = opts.anchor ?? [v.bbox.x0 + (v.bbox.x1 - v.bbox.x0) / 2, v.bbox.y0 + (v.bbox.y1 - v.bbox.y0) / 2];
    const aSheet = this.toSheet(v, anchor);
    const pos: [number, number] = [aSheet[0] + 12, aSheet[1] - 8];
    const g: GdtAnnotation = {
      id: `gdt${++this.gdtSeq}`,
      viewId,
      symbol,
      tol,
      datum: opts.datum,
      diameter: opts.diameter,
      anchor: [anchor[0], anchor[1]],
      pos,
    };
    this.gdts.push(g);
    return g;
  }

  removeGdt(id: string): void {
    this.gdts = this.gdts.filter((g) => g.id !== id);
  }

  clearGdts(): void {
    this.gdts = [];
  }

  /** 特征控制框 SVG */
  private gdtSVG(g: GdtAnnotation, v: DrawingView): string {
    const s: string[] = [];
    const anchorS = this.toSheet(v, g.anchor);
    const [px, py] = g.pos;
    const fh = 4.6;
    const cwSym = 5.4;
    const cwTol = 8.6;
    const cwDat = g.datum ? 4.8 : 0;
    const totalW = cwSym + cwTol + cwDat;
    const midY = py + fh / 2;
    // 引线：框左缘中点 → 锚点
    s.push(
      `<line x1="${px.toFixed(2)}" y1="${midY.toFixed(2)}" x2="${anchorS[0].toFixed(2)}" y2="${anchorS[1].toFixed(2)}" stroke="#b53322" stroke-width="0.28"/>`
    );
    s.push(`<rect x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${totalW.toFixed(2)}" height="${fh.toFixed(2)}" fill="none" stroke="#b53322" stroke-width="0.4"/>`);
    let x = px;
    if (cwSym > 0) s.push(`<line x1="${(x + cwSym).toFixed(2)}" y1="${py.toFixed(2)}" x2="${(x + cwSym).toFixed(2)}" y2="${(py + fh).toFixed(2)}" stroke="#b53322" stroke-width="0.3"/>`);
    const glyphY = py + 0.4;
    s.push(this.gdtGlyph(g.symbol, px + 0.5, glyphY, cwSym - 1, fh - 0.8));
    x += cwSym;
    const tolTxt = (g.diameter ? '⌀' : '') + trim(convertLength(g.tol, this.unitSystem), UNIT_BY_ID[this.unitSystem].digits.len);
    s.push(`<text x="${(x + cwTol / 2).toFixed(2)}" y="${(py + fh * 0.72).toFixed(2)}" font-size="3.6" fill="#b53322" text-anchor="middle">${tolTxt}</text>`);
    if (cwDat > 0) {
      s.push(`<line x1="${(x + cwTol).toFixed(2)}" y1="${py.toFixed(2)}" x2="${(x + cwTol).toFixed(2)}" y2="${(py + fh).toFixed(2)}" stroke="#b53322" stroke-width="0.3"/>`);
      s.push(`<text x="${(x + cwTol + cwDat / 2).toFixed(2)}" y="${(py + fh * 0.72).toFixed(2)}" font-size="3.6" fill="#b53322" text-anchor="middle">${escapeXml(g.datum!)}</text>`);
    }
    return s.join('');
  }

  /** 形位公差符号小图形（在格子内绘制） */
  private gdtGlyph(sym: GdtSymbol, x: number, y: number, w: number, h: number): string {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const sc = Math.min(w, h);
    const L = (x1: number, y1: number, x2: number, y2: number, dash = '') =>
      `<line x1="${(x + x1).toFixed(2)}" y1="${(y + y1).toFixed(2)}" x2="${(x + x2).toFixed(2)}" y2="${(y + y2).toFixed(2)}" stroke="#b53322" stroke-width="0.32"${dash}/>`;
    const C = (r: number) => `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(r * sc * 0.36).toFixed(2)}" fill="none" stroke="#b53322" stroke-width="0.3"/>`;
    switch (sym) {
      case 'position': // 圆 + 十字
        return C(1) + L(w / 2 - 0.45, h / 2, w / 2 + 0.45, h / 2) + L(w / 2, h / 2 - 0.45, w / 2, h / 2 + 0.45);
      case 'flatness': // 平行四边形（两斜向平行线）
        return L(0.2, h * 0.3, w - 0.3, h * 0.7) + L(0.5, h * 0.3, w - 0.1, h * 0.68);
      case 'straightness': // 水平直线
        return L(0.15, h / 2, w - 0.15, h / 2);
      case 'roundness':
        return C(1);
      case 'cylindricity': // 两同心圆
        return C(1) + C(0.5);
      case 'perpendicularity': // ⊥
        return L(w / 2, h * 0.12, w / 2, h * 0.85) + L(0.18, h * 0.85, w - 0.18, h * 0.85);
      case 'parallelism': // 两条斜线
        return L(0.15, h * 0.2, w - 0.4, h * 0.8) + L(0.55, h * 0.2, w - 0.15, h * 0.8);
      case 'coaxiality': // 同心（大圆心点）
        return C(1) + `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="0.45" fill="#b53322"/>`;
      case 'symmetry': // 三横线（中线虚线）
        return L(0.15, h * 0.18, w - 0.15, h * 0.18) + L(0.15, h / 2, w - 0.15, h / 2, ' stroke-dasharray="0.7,0.5"') + L(0.15, h * 0.82, w - 0.15, h * 0.82);
      case 'circularRunout': // 45° 箭头
        return `<path d="M ${(x + 0.2).toFixed(2)} ${(y + h * 0.78).toFixed(2)} L ${(x + w - 0.3).toFixed(2)} ${(y + h * 0.22).toFixed(2)}" fill="none" stroke="#b53322" stroke-width="0.32"/>` +
          `<path d="M ${(x + w - 0.8).toFixed(2)} ${(y + h * 0.28).toFixed(2)} l 0.9 -0.35 l -0.1 0.9 z" fill="#b53322"/>`;
      case 'totalRunout':
        return `<path d="M ${(x + 0.2).toFixed(2)} ${(y + h * 0.88).toFixed(2)} L ${(x + w - 0.3).toFixed(2)} ${(y + h * 0.32).toFixed(2)}" fill="none" stroke="#b53322" stroke-width="0.32"/>` +
          `<path d="M ${(x + 0.4).toFixed(2)} ${(y + h * 0.28).toFixed(2)} L ${(x + w - 0.5).toFixed(2)} ${(y + h * 0.72).toFixed(2)}" fill="none" stroke="#b53322" stroke-width="0.32"/>` +
          `<path d="M ${(x + w - 0.85).toFixed(2)} ${(y + h * 0.68).toFixed(2)} l 0.9 -0.35 l -0.1 0.9 z" fill="#b53322"/>`;
      default:
        return '';
    }
  }

  // ------------------------------------------------------------
  // 孔位自动标注
  // ------------------------------------------------------------
  /** 为每个视图的孔添加中心定位尺寸（相对视图左下角基准）+ 正视圆的直径标注 */
  autoDimensionHoles(): number {
    let n = 0;
    for (const v of this.views) {
      for (const h of v.holes) {
        const { x0, y0 } = v.bbox;
        // X / Y 位置（相对视图基准角）
        if (Math.abs(h.cx - x0) > 1e-6) {
          this.addDim(v, [x0, h.cy], [h.cx, h.cy], 8, null);
          n += 1;
        }
        if (Math.abs(h.cy - y0) > 1e-6) {
          this.addDim(v, [h.cx, y0], [h.cx, h.cy], 8, null);
          n += 1;
        }
        // 直径标注（孔呈正圆可见时）
        if (h.round >= 0.95) {
          this.addDim(v, [h.cx - h.dia / 2, h.cy], [h.cx + h.dia / 2, h.cy], 8, null);
          const last = v.dims[v.dims.length - 1];
          last.prefix = '⌀';
          n += 1;
        }
      }
    }
    this.selectedRuns.clear();
    return n;
  }

  // ------------------------------------------------------------
  // 明细表（BOM）
  // ------------------------------------------------------------
  setBom(rows: Omit<BomRow, 'no'>[]): void {
    this.bom = rows.map((r, i) => ({ no: i + 1, ...r }));
  }

  clearBom(): void {
    this.bom = [];
  }

  /** 零件明细表 SVG（放在标题栏上方） */
  private bomSVG(): string {
    const { w, h, margin, material } = this.sheet;
    const cols = [8, 0, 0, 14, 22]; // 序号/名称(弹性)/数量/材料/备注
    const colName = w - margin * 2 - cols[0] - cols[2] - cols[3] - cols[4];
    const widths = [cols[0], colName, cols[2], cols[3], cols[4]];
    const rowH = 6;
    const headerH = 6.4;
    const x = margin;
    const tableH = headerH + rowH * this.bom.length;
    const y = Math.max(h - margin - 42 - tableH, margin + 8);
    const heads = ['序号', '名称', '数量', '材料', '备注'];
    const s: string[] = [];
    s.push(`<g class="d-bom">`);
    s.push(`<text x="${x.toFixed(2)}" y="${(y - 2).toFixed(2)}" font-size="4" fill="#22303f" font-weight="600">零件明细表</text>`);
    let xx = x;
    const drawRow = (rowY: number, cells: string[], rh: number, bold = false) => {
      xx = x;
      let right = 0;
      for (let i = 0; i < widths.length; i++) {
        right = xx + widths[i];
        s.push(`<rect x="${xx.toFixed(2)}" y="${rowY.toFixed(2)}" width="${widths[i].toFixed(2)}" height="${rh.toFixed(2)}" fill="none" stroke="#111" stroke-width="0.3"/>`);
        const cx = xx + widths[i] / 2;
        s.push(`<text x="${cx.toFixed(2)}" y="${(rowY + rh * 0.68).toFixed(2)}" font-size="${(bold ? 3.6 : 3.3).toFixed(1)}" fill="#111" text-anchor="middle" font-weight="${bold ? 600 : 400}">${escapeXml(cells[i] ?? '')}</text>`);
        xx = right;
      }
      s.push(`<line x1="${x.toFixed(2)}" y1="${(rowY + rh).toFixed(2)}" x2="${right.toFixed(2)}" y2="${(rowY + rh).toFixed(2)}" stroke="#111" stroke-width="0.3"/>`);
    };
    drawRow(y, heads, headerH, true);
    this.bom.forEach((r, i) => {
      const rowY = y + headerH + rowH * i;
      drawRow(rowY, [String(r.no), r.name, String(r.qty), r.material ?? material, r.note ?? ''], rowH);
    });
    s.push('</g>');
    return s.join('');
  }

  /** 自动标注：`overall` 只标每个视图的总宽/总高；`all` 再标每条直线边。 */
  autoDimension(mode: 'overall' | 'all' = 'overall'): number {
    let n = 0;
    for (const v of this.views) {
      const { x0, y0, x1, y1 } = v.bbox;
      const w = x1 - x0;
      const h = y1 - y0;
      if (w > 1e-6) {
        this.addDim(v, [x0, y0], [x1, y0], 10, null);
        n += 1;
      }
      if (h > 1e-6) {
        this.addDim(v, [x0, y0], [x0, y1], 10, null);
        n += 1;
      }
      if (mode === 'all') {
        for (let i = 0; i < v.edges.length; i++) {
          const e = v.edges[i];
          if (e.pts.length !== 2) continue; // 仅直线段
          const [a, b] = e.pts;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < Math.max(w, h) * 0.15) continue; // 跳过过短边，避免拥挤
          this.addDim(v, a, b, 8, i);
          n += 1;
        }
      }
    }
    this.selectedRuns.clear();
    return n;
  }

  private addDim(
    v: DrawingView,
    a: [number, number],
    b: [number, number],
    offset: number,
    runIdx: number | null
  ): DimAnnotation {
    const dim: DimAnnotation = { id: `dim${++this.dimSeq}`, a: [a[0], a[1]], b: [b[0], b[1]], offset };
    v.dims.push(dim);
    if (runIdx !== null) {
      this.selectedRuns.clear();
      this.selectedRuns.add(`${v.id}:${runIdx}`);
    }
    return dim;
  }

  /** 统计信息（BOM / 视图表） */
  summary(): { views: number; edges: number; hidden: number } {
    let edges = 0;
    let hidden = 0;
    for (const v of this.views) {
      edges += v.edges.length;
      hidden += v.edges.filter((e) => e.hidden).length;
    }
    return { views: this.views.length, edges, hidden };
  }

  /**
   * 纯数据快照。`selectedRuns` 是交互高亮的会话态，不存（恢复后应为空）。
   * ⚠️ 必须深拷贝到每一层数组：撤销快照直接存本结果，浅拷贝会让快照与实时对象
   * 共享 `edges[].pts` / `dims[].a`，后续排版或标注原地改写会连快照一起改。
   */
  toJSON(): SerializedDrawing {
    return structuredClone({
      version: 1 as const,
      views: this.views,
      sheet: this.sheet,
      showHidden: this.showHidden,
      fixedScale: this.fixedScale,
      gdts: this.gdts,
      bom: this.bom,
      unitSystem: this.unitSystem,
      seq: this.seq,
      dimSeq: this.dimSeq,
      gdtSeq: this.gdtSeq,
    });
  }

  /** 从 `toJSON` 结果重建；输入非法时返回空工程图（不抛，打开旧文件要能继续） */
  static fromJSON(data: unknown): Drawing {
    const d = new Drawing();
    const rec = (data ?? null) as Partial<SerializedDrawing> | null;
    if (!rec || typeof rec !== 'object') return d;

    if (Array.isArray(rec.views)) {
      d.views = rec.views
        .filter((v) => !!v && typeof v.id === 'string' && Array.isArray(v.edges))
        .map((v) => ({
          ...v,
          dims: Array.isArray(v.dims) ? v.dims : [],
          holes: Array.isArray(v.holes) ? v.holes : [],
          bbox: v.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
        }));
    }
    if (rec.sheet && typeof rec.sheet === 'object') d.sheet = { ...d.sheet, ...rec.sheet };
    if (typeof rec.showHidden === 'boolean') d.showHidden = rec.showHidden;
    if (typeof rec.fixedScale === 'number' && Number.isFinite(rec.fixedScale)) d.fixedScale = rec.fixedScale;
    if (Array.isArray(rec.gdts)) d.gdts = rec.gdts.filter((g) => !!g && typeof g.id === 'string');
    if (Array.isArray(rec.bom)) d.bom = rec.bom.filter((r) => !!r && typeof r.name === 'string');
    if (rec.unitSystem && rec.unitSystem in UNIT_BY_ID) d.unitSystem = rec.unitSystem;

    // 发号器：文件里的值与本文件实际 id 取最大，防止手工编辑/旧版本把 seq 写小后 id 撞车
    const dimIds = d.views.flatMap((v) => v.dims.map((x) => x.id));
    d.seq = Math.max(typeof rec.seq === 'number' ? rec.seq : 0, maxIdSuffix(d.views.map((v) => v.id), 'v'));
    d.dimSeq = Math.max(typeof rec.dimSeq === 'number' ? rec.dimSeq : 0, maxIdSuffix(dimIds, 'dim'));
    d.gdtSeq = Math.max(typeof rec.gdtSeq === 'number' ? rec.gdtSeq : 0, maxIdSuffix(d.gdts.map((g) => g.id), 'gdt'));
    return d;
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

/** 由网格结果生成标准三视图 + 等轴测 */
export function generateStandardViews(
  drawing: Drawing,
  mesh: MeshResult,
  kinds: ViewKind[] = ['front', 'top', 'right', 'iso']
): void {
  drawing.clear();
  for (const k of kinds) drawing.addView(k, mesh, 0);
  drawing.layout();
}

/** 构造一个用于射线求交的网格（与显示用的独立，避免受材质影响） */
export function buildRaycastMesh(mesh: MeshResult): THREE.Mesh {
  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  const indices = new Uint32Array(mesh.indices);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  m.updateMatrixWorld(true);
  return m;
}

/** 供外部使用：把 3D 顶点投影成 2D（标注用） */
export function projectVertex(p: [number, number, number], r: [number, number, number], up: [number, number, number]): [number, number] {
  return [p[0] * r[0] + p[1] * r[1] + p[2] * r[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]];
}
