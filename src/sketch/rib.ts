/**
 * 筋（Rib）几何：把草图的**开口轮廓**在平面内偏置成一条有厚度的封闭多边形，
 * 供引擎沿草图法向拉伸成薄壁。全部为纯 2D 计算，不依赖几何内核，可单独测试。
 *
 * 思路：折线左右各偏置 thickness/2（角点用相邻段法向的平均做斜接），
 * 左链正向 + 右链反向拼成封闭"带状"多边形；将其贴到草图平面拉伸即为筋。
 */
import type { SkArc, SkLine, Sketch } from './types';
import { arcAngles } from './types';

type Pt = [number, number];

/** 采样单个实体为局部 2D 点列（始终按几何起点 a → 终点 b；圆弧按几何走向） */
function sampleEntity2D(sk: Sketch, e: SkLine | SkArc, segs = 16): Pt[] {
  if (e.kind === 'line') {
    const a = sk.points[e.a];
    const b = sk.points[e.b];
    return [
      [a.x, a.y],
      [b.x, b.y],
    ];
  }
  const { a0, a1, r } = arcAngles(sk, e);
  const c = sk.points[e.c];
  const n = Math.max(2, Math.ceil(segs * (Math.abs(a1 - a0) / (Math.PI * 2))));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    out.push([c.x + r * Math.cos(t), c.y + r * Math.sin(t)]);
  }
  return out;
}

export interface Chain {
  /** 有序的 2D 点列（相邻重复点已去除） */
  pts: Pt[];
  /** 是否首尾闭合 */
  closed: boolean;
}

/** 把草图的开放实体串成一条连续折线；无法串成单链时返回 null。 */
export function buildChain(sk: Sketch): Chain | null {
  const ents = sk.entities.filter((e) => !e.construction && e.kind !== 'circle') as (SkLine | SkArc)[];
  if (!ents.length) return null;

  const atPoint = new Map<string, (SkLine | SkArc)[]>();
  for (const e of ents) {
    for (const p of [e.a, e.b]) {
      if (!atPoint.has(p)) atPoint.set(p, []);
      atPoint.get(p)!.push(e);
    }
  }
  const deg = (p: string) => (atPoint.get(p) ?? []).length;

  // 起点：优先取度为 1 的端点（开口链）；若全为 2 则视为闭环
  let startEnt = ents[0];
  let startPt = startEnt.a;
  const endpoint = [...atPoint.keys()].find((p) => deg(p) === 1);
  if (endpoint) {
    startEnt = atPoint.get(endpoint)![0];
    startPt = endpoint;
  } else {
    startPt = startEnt.a;
  }

  const used = new Set<SkLine | SkArc>();
  const pts: Pt[] = [];
  let cur: SkLine | SkArc | null = startEnt;
  let from = startPt;
  let closed = false;

  for (let guard = 0; guard <= ents.length + 1 && cur; guard++) {
    used.add(cur);
    let seg = sampleEntity2D(sk, cur);
    if (cur.a !== from) seg = seg.slice().reverse(); // 保证从 from 出发
    for (const p of seg) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-9) pts.push(p);
    }
    const to = from === cur.a ? cur.b : cur.a;
    if (to === startPt) {
      closed = true;
      break;
    }
    const next = (atPoint.get(to) ?? []).find((e) => !used.has(e)) ?? null;
    from = to;
    cur = next;
  }

  if (pts.length < 2) return null;
  return { pts, closed };
}

/** 折线 → 有厚度的封闭带状多边形（局部 2D）。 */
export function offsetRibbon(pts: Pt[], thickness: number): Pt[] {
  const h = Math.max(thickness, 1e-3) / 2;
  // 去重相邻点
  const p: Pt[] = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(last[0] - q[0], last[1] - q[1]) > 1e-9) p.push(q);
  }
  const n = p.length;
  if (n < 2) return [];

  // 每段的左法向
  const segN: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i + 1][0] - p[i][0];
    const dy = p[i + 1][1] - p[i][1];
    const L = Math.hypot(dx, dy) || 1;
    segN.push([-dy / L, dx / L]);
  }

  // 每个顶点的偏置方向（端点取相邻段法向，内部取平均后归一化 = 斜接）
  const vN: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let nx: number;
    let ny: number;
    if (i === 0) {
      [nx, ny] = segN[0];
    } else if (i === n - 1) {
      [nx, ny] = segN[n - 2];
    } else {
      nx = segN[i - 1][0] + segN[i][0];
      ny = segN[i - 1][1] + segN[i][1];
    }
    const L = Math.hypot(nx, ny) || 1;
    vN.push([nx / L, ny / L]);
  }

  const left: Pt[] = p.map((q, i) => [q[0] + h * vN[i][0], q[1] + h * vN[i][1]]);
  const right: Pt[] = p.map((q, i) => [q[0] - h * vN[i][0], q[1] - h * vN[i][1]]);
  return [...left, ...right.reverse()];
}

/** 一步到位：草图 → 筋的封闭轮廓（局部 2D）。闭环草图不适用。 */
export function buildRibProfile(sk: Sketch, thickness: number): Pt[] | null {
  const chain = buildChain(sk);
  if (!chain || chain.closed || chain.pts.length < 2) return null;
  const poly = offsetRibbon(chain.pts, thickness);
  return poly.length >= 3 ? poly : null;
}
