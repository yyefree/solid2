/**
 * 草图约束求解器。
 *
 * 把草图约束编译成一组非线性方程 r(x) = 0，用 Levenberg–Marquardt 做最小二乘求解。
 * 变量 = 所有未固定点的 (x, y) + 各圆的半径。
 *
 * 选择数值雅可比（而非解析）的原因：约束类型多、每种都手推导数容易出错；
 * 草图规模通常只有几十个变量，数值雅可比的开销完全可以接受，而且新增约束类型零成本。
 */
import type { SkConstraint, SkEntity, Sketch, SolveStatus } from './types';

const EPS = 1e-9;

// ============================================================
// 变量打包
// ============================================================
interface VarMap {
  idx: Map<string, number>;
  names: string[];
  read(sk: Sketch): number[];
  write(sk: Sketch, x: number[]): void;
}

function buildVarMap(sk: Sketch): VarMap {
  const idx = new Map<string, number>();
  const names: string[] = [];
  const push = (name: string) => {
    if (!idx.has(name)) {
      idx.set(name, names.length);
      names.push(name);
    }
  };
  for (const p of Object.values(sk.points)) {
    if (p.fixed) continue;
    push(`P|${p.id}|x`);
    push(`P|${p.id}|y`);
  }
  for (const e of sk.entities) {
    if (e.kind === 'circle') push(`R|${e.id}`);
    else if (e.kind === 'ellipse') {
      // 椭圆的长/短半轴与圆的半径一样，作为求解变量（可被半径类尺寸驱动）
      push(`A|${e.id}`);
      push(`B|${e.id}`);
    }
  }

  const read = (s: Sketch): number[] => {
    const x = new Array(names.length).fill(0);
    for (const [name, i] of idx) {
      const parts = name.split('|');
      if (parts[0] === 'P') {
        const p = s.points[parts[1]];
        if (!p) continue;
        x[i] = parts[2] === 'x' ? p.x : p.y;
        continue;
      }
      const e = s.entities.find((en) => en.id === parts[1]);
      if (!e) continue;
      if (parts[0] === 'R' && e.kind === 'circle') x[i] = e.r;
      else if (e.kind === 'ellipse') x[i] = parts[0] === 'A' ? e.rx : e.ry;
    }
    return x;
  };

  const write = (s: Sketch, x: number[]): void => {
    for (const [name, i] of idx) {
      const parts = name.split('|');
      if (parts[0] === 'P') {
        const p = s.points[parts[1]];
        if (!p) continue;
        if (parts[2] === 'x') p.x = x[i];
        else p.y = x[i];
        continue;
      }
      const e = s.entities.find((en) => en.id === parts[1]);
      if (!e) continue;
      if (parts[0] === 'R' && e.kind === 'circle') e.r = x[i];
      else if (e.kind === 'ellipse') {
        if (parts[0] === 'A') e.rx = x[i];
        else e.ry = x[i];
      }
    }
  };

  return { idx, names, read, write };
}

// ============================================================
// 约束 → 残差
// ============================================================
interface Ctx {
  sk: Sketch;
  x: number[];
  idx: Map<string, number>;
  /** 取点坐标（未固定点读变量，固定点读草图原值） */
  P(id?: string): { x: number; y: number };
  E(id?: string): SkEntity | undefined;
  /** 取实体半径（圆的半径是变量，弧的半径由端点算出） */
  R(e: SkEntity): number;
  /** 椭圆的短半轴（其它实体返回 0） */
  R2(e: SkEntity): number;
}

function makeCtx(sk: Sketch, x: number[], idx: Map<string, number>): Ctx {
  const P = (id?: string) => {
    if (!id) return { x: 0, y: 0 };
    const p = sk.points[id];
    if (!p) return { x: 0, y: 0 };
    const ix = idx.get(`P|${id}|x`);
    const iy = idx.get(`P|${id}|y`);
    return { x: ix === undefined ? p.x : x[ix], y: iy === undefined ? p.y : x[iy] };
  };
  const E = (id?: string) => (id ? sk.entities.find((e) => e.id === id) : undefined);
  const R = (e: SkEntity) => {
    if (e.kind === 'circle') {
      const i = idx.get(`R|${e.id}`);
      return i === undefined ? e.r : x[i];
    }
    if (e.kind === 'arc') {
      const c = P(e.c);
      const a = P(e.a);
      return Math.hypot(a.x - c.x, a.y - c.y);
    }
    // 椭圆没有单一"半径"：取长半轴作为名义值（供相等/相切等约束做退化处理）
    if (e.kind === 'ellipse') {
      const i = idx.get(`A|${e.id}`);
      return i === undefined ? e.rx : x[i];
    }
    return 0;
  };
  const R2 = (e: SkEntity) => {
    if (e.kind !== 'ellipse') return 0;
    const i = idx.get(`B|${e.id}`);
    return i === undefined ? e.ry : x[i];
  };
  return { sk, x, idx, P, E, R, R2 };
}

/** 直线方向向量（直线用端点差；圆用半径做水平参考；椭圆用长轴方向） */
function dirOf(ctx: Ctx, e: SkEntity): { dx: number; dy: number } {
  if (e.kind === 'line') {
    const a = ctx.P(e.a);
    const b = ctx.P(e.b);
    return { dx: b.x - a.x, dy: b.y - a.y };
  }
  if (e.kind === 'circle') return { dx: ctx.R(e), dy: 0 };
  if (e.kind === 'point') return { dx: 0, dy: 0 };
  if (e.kind === 'ellipse') return { dx: Math.cos(e.rot) * e.rx, dy: Math.sin(e.rot) * e.rx };
  // 抛物线 / 双曲线：对称轴（实轴）方向
  if (e.kind === 'parabola') return { dx: Math.cos(e.rot), dy: Math.sin(e.rot) };
  if (e.kind === 'hyperbola') return { dx: Math.cos(e.rot), dy: Math.sin(e.rot) };
  // B 样条：首尾通过点连线方向
  if (e.kind === 'bspline') {
    const n = e.pts.length;
    if (n < 2) return { dx: 1, dy: 0 };
    return { dx: e.pts[n - 1][0] - e.pts[0][0], dy: e.pts[n - 1][1] - e.pts[0][1] };
  }
  const a = ctx.P(e.a);
  const b = ctx.P(e.b);
  return { dx: b.x - a.x, dy: b.y - a.y };
}

function centerOf(ctx: Ctx, e: SkEntity): { x: number; y: number } {
  if (e.kind === 'line') {
    const a = ctx.P(e.a);
    const b = ctx.P(e.b);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (e.kind === 'point') return ctx.P(e.p);
  if (e.kind === 'bspline') {
    // B 样条没有单点"中心"，取通过点重心
    const n = e.pts.length || 1;
    let sx = 0;
    let sy = 0;
    for (const p of e.pts) {
      sx += p[0];
      sy += p[1];
    }
    return { x: sx / n, y: sy / n };
  }
  return ctx.P(e.c);
}

function lineOf(ctx: Ctx, e: SkEntity): { a: { x: number; y: number }; b: { x: number; y: number } } | null {
  if (e.kind !== 'line') return null;
  return { a: ctx.P(e.a), b: ctx.P(e.b) };
}

/** 点到直线的有符号距离 */
function distPtLine(p: { x: number; y: number }, l: { a: { x: number; y: number }; b: { x: number; y: number } }): number {
  const dx = l.b.x - l.a.x;
  const dy = l.b.y - l.a.y;
  const L = Math.hypot(dx, dy) || EPS;
  return ((p.x - l.a.x) * dy - (p.y - l.a.y) * dx) / L;
}

/** 一条约束展开成若干残差（残差 = 0 即满足） */
export function constraintResiduals(ctx: Ctx, c: SkConstraint): number[] {
  const out: number[] = [];
  switch (c.type) {
    case 'coincident': {
      const a = ctx.P(c.p1);
      const b = ctx.P(c.p2);
      out.push(a.x - b.x, a.y - b.y);
      break;
    }
    case 'horizontal':
    case 'vertical': {
      const e = ctx.E(c.e1);
      if (e && e.kind === 'line') {
        const a = ctx.P(e.a);
        const b = ctx.P(e.b);
        out.push(c.type === 'horizontal' ? a.y - b.y : a.x - b.x);
      }
      break;
    }
    case 'parallel': {
      const e1 = ctx.E(c.e1);
      const e2 = ctx.E(c.e2);
      if (e1 && e2) {
        const d1 = dirOf(ctx, e1);
        const d2 = dirOf(ctx, e2);
        const L1 = Math.hypot(d1.dx, d1.dy) || EPS;
        const L2 = Math.hypot(d2.dx, d2.dy) || EPS;
        out.push((d1.dx * d2.dy - d1.dy * d2.dx) / (L1 * L2));
      }
      break;
    }
    case 'perpendicular': {
      const e1 = ctx.E(c.e1);
      const e2 = ctx.E(c.e2);
      if (e1 && e2) {
        const d1 = dirOf(ctx, e1);
        const d2 = dirOf(ctx, e2);
        const L1 = Math.hypot(d1.dx, d1.dy) || EPS;
        const L2 = Math.hypot(d2.dx, d2.dy) || EPS;
        out.push((d1.dx * d2.dx + d1.dy * d2.dy) / (L1 * L2));
      }
      break;
    }
    case 'equal': {
      const e1 = ctx.E(c.e1);
      const e2 = ctx.E(c.e2);
      if (e1 && e2) {
        if (e1.kind === 'line' && e2.kind === 'line') {
          const d1 = dirOf(ctx, e1);
          const d2 = dirOf(ctx, e2);
          out.push(Math.hypot(d1.dx, d1.dy) - Math.hypot(d2.dx, d2.dy));
        } else {
          out.push(ctx.R(e1) - ctx.R(e2));
        }
      }
      break;
    }
    case 'concentric': {
      const e1 = ctx.E(c.e1);
      const e2 = ctx.E(c.e2);
      if (e1 && e2) {
        const a = centerOf(ctx, e1);
        const b = centerOf(ctx, e2);
        out.push(a.x - b.x, a.y - b.y);
      }
      break;
    }
    case 'tangent': {
      const e1 = ctx.E(c.e1);
      const e2 = ctx.E(c.e2);
      if (e1 && e2) {
        const l1 = lineOf(ctx, e1);
        const l2 = lineOf(ctx, e2);
        if (l1 && !l2) out.push(distPtLine(centerOf(ctx, e2), l1) - ctx.R(e2));
        else if (l2 && !l1) out.push(distPtLine(centerOf(ctx, e1), l2) - ctx.R(e1));
        else {
          const a = centerOf(ctx, e1);
          const b = centerOf(ctx, e2);
          out.push(Math.hypot(a.x - b.x, a.y - b.y) - (ctx.R(e1) + ctx.R(e2)));
        }
      }
      break;
    }
    case 'distance': {
      const a = ctx.P(c.p1);
      const b = ctx.P(c.p2);
      out.push(Math.hypot(a.x - b.x, a.y - b.y) - (c.value ?? 0));
      break;
    }
    case 'length': {
      const e = ctx.E(c.e1);
      if (e) {
        const d = dirOf(ctx, e);
        out.push(Math.hypot(d.dx, d.dy) - (c.value ?? 0));
      }
      break;
    }
    case 'radius': {
      const e = ctx.E(c.e1);
      if (e) out.push(ctx.R(e) - (c.value ?? 0));
      break;
    }
    case 'minorRadius': {
      const e = ctx.E(c.e1);
      if (e) out.push(ctx.R2(e) - (c.value ?? 0));
      break;
    }
    case 'diameter': {
      const e = ctx.E(c.e1);
      if (e) out.push(2 * ctx.R(e) - (c.value ?? 0));
      break;
    }
    case 'angle': {
      const e1 = ctx.E(c.e1);
      const e2 = ctx.E(c.e2);
      if (e1 && e2) {
        const d1 = dirOf(ctx, e1);
        const d2 = dirOf(ctx, e2);
        const cross = d1.dx * d2.dy - d1.dy * d2.dx;
        const dot = d1.dx * d2.dx + d1.dy * d2.dy;
        let diff = Math.atan2(cross, dot) - (c.value ?? 0);
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        out.push(diff);
      }
      break;
    }
    case 'pointOnLine': {
      const e = ctx.E(c.e1);
      const p = ctx.P(c.p1);
      const l = e ? lineOf(ctx, e) : null;
      if (l) out.push(distPtLine(p, l));
      break;
    }
    case 'midpoint': {
      const e = ctx.E(c.e1);
      const p = ctx.P(c.p1);
      const l = e ? lineOf(ctx, e) : null;
      if (l) out.push(p.x - (l.a.x + l.b.x) / 2, p.y - (l.a.y + l.b.y) / 2);
      break;
    }
    case 'symmetric': {
      const e = ctx.E(c.e1);
      const p1 = ctx.P(c.p1);
      const p2 = ctx.P(c.p2);
      const l = e ? lineOf(ctx, e) : null;
      if (l) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        out.push(distPtLine({ x: mx, y: my }, l));
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const ex = l.b.x - l.a.x;
        const ey = l.b.y - l.a.y;
        const L1 = Math.hypot(dx, dy) || EPS;
        const L2 = Math.hypot(ex, ey) || EPS;
        out.push((dx * ex + dy * ey) / (L1 * L2));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// ============================================================
// 线性代数小工具
// ============================================================
/**
 * 解线性方程组 A x = b：LU 分解 + 部分主元 + 回代。
 *
 * ⚠️ 这里必须用"行阶梯 + 回代"，不能用高斯-约当全消元：
 * 全消元在每一步做行交换后，"第 i 行主元在第 i 列"这个不变量会被破坏，
 * 最后按 row[i][i] 归一化时就会除到 0，静默产出 NaN —— 表现为 LM 永不接受步长、代价恒定。
 */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];

    const pv = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }

  // 回代
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c];
    const d = M[i][i];
    if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
    x[i] = s / d;
  }
  for (const v of x) if (!Number.isFinite(v)) return null;
  return x;
}

/** 数值秩（行阶梯化 + 相对容差） */
function numericalRank(J: number[][], tol = 1e-7): number {
  if (!J.length || !J[0]?.length) return 0;
  const m = J.length;
  const n = J[0].length;
  const M = J.map((r) => [...r]);
  let rank = 0;
  for (let col = 0; col < n && rank < m; col++) {
    let piv = rank;
    for (let r = rank + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    let scale = 0;
    for (let r = 0; r < m; r++) scale = Math.max(scale, Math.abs(M[r][col]));
    if (scale < 1e-12 || Math.abs(M[piv][col]) / scale < tol) continue;
    [M[rank], M[piv]] = [M[piv], M[rank]];
    const pv = M[rank][col];
    for (let r = 0; r < m; r++) {
      if (r === rank) continue;
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[rank][c];
    }
    rank++;
  }
  return rank;
}

// ============================================================
// 主求解流程
// ============================================================
export interface SolveOptions {
  maxIter?: number;
  tolerance?: number;
  /** 调试：每次迭代回调 */
  trace?: (info: { iter: number; cost: number; lambda: number; accepted: boolean }) => void;
}

export function solveSketch(sk: Sketch, opts: SolveOptions = {}): SolveStatus {
  const maxIter = opts.maxIter ?? 160;
  const tol = opts.tolerance ?? 1e-9;

  const vm = buildVarMap(sk);
  const n = vm.names.length;

  const evalAt = (x: number[]): number[] => {
    const ctx = makeCtx(sk, x, vm.idx);
    const r: number[] = [];
    for (const c of sk.constraints) r.push(...constraintResiduals(ctx, c));
    return r;
  };

  const x0 = vm.read(sk);
  const m0 = evalAt(x0).length;

  if (n === 0) {
    const cost = norm2(evalAt(x0));
    return {
      dof: 0,
      state: cost < 1e-6 ? 'well' : 'failed',
      iterations: 0,
      residual: cost,
      message: cost < 1e-6 ? '已完全定义（无自由度）' : '存在无法满足的约束',
    };
  }

  let x = x0.slice();
  let r = evalAt(x);
  let cost = norm2(r);
  let lambda = 1e-3;
  let iter = 0;
  let J: number[][] = [];
  const m = r.length;

  for (; iter < maxIter; iter++) {
    if (m === 0) break;
    if (Math.sqrt(cost) < tol) break;

    // 数值雅可比
    J = new Array(m);
    for (let i = 0; i < m; i++) J[i] = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      const h = Math.max(1e-7, Math.abs(x[k]) * 1e-7);
      const xp = x.slice();
      xp[k] += h;
      const rp = evalAt(xp);
      for (let i = 0; i < m; i++) J[i][k] = (rp[i] - r[i]) / h;
    }

    // 正规方程 (JᵀJ + λ·diag) dx = −Jᵀr
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      for (let a = 0; a < n; a++) {
        const jia = Ji[a];
        if (jia === 0) continue;
        g[a] += jia * r[i];
        for (let b = a; b < n; b++) {
          const jib = Ji[b];
          if (jib === 0) continue;
          A[a][b] += jia * jib;
        }
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) A[a][b] = A[b][a];
      A[a][a] = A[a][a] * (1 + lambda) + 1e-10;
    }
    const dx = solveLinear(A, g.map((v) => -v));
    if (!dx) {
      lambda *= 10;
      if (lambda > 1e12) break;
      continue;
    }

    const xn = x.map((v, i) => v + dx[i]);
    const rn = evalAt(xn);
    const costN = norm2(rn);
    const accepted = costN < cost;
    opts.trace?.({ iter, cost, lambda, accepted });
    if (accepted) {
      x = xn;
      r = rn;
      cost = costN;
      lambda = Math.max(lambda / 3, 1e-12);
    } else {
      lambda *= 4;
      if (lambda > 1e12) break;
    }
  }

  vm.write(sk, x);
  const residual = Math.sqrt(cost);

  if (!J.length) {
    J = new Array(m);
    for (let i = 0; i < m; i++) J[i] = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      const h = 1e-6;
      const xp = x.slice();
      xp[k] += h;
      const rp = evalAt(xp);
      for (let i = 0; i < m; i++) J[i][k] = (rp[i] - r[i]) / h;
    }
  }
  const rank = numericalRank(J);
  const dof = Math.max(0, n - rank);

  let state: SolveStatus['state'];
  let message: string;
  if (residual > 1e-4) {
    state = 'failed';
    message = `约束冲突：残差 ${residual.toFixed(4)}（可能存在过定义或矛盾尺寸）`;
  } else if (dof === 0) {
    state = 'well';
    message = '完全定义';
  } else {
    state = 'under';
    message = `欠定义，剩余 ${dof} 个自由度`;
  }

  return { dof, state, iterations: iter, residual, message };
}

function norm2(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return s;
}
