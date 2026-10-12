/**
 * 草图求解器测试（纯计算，不依赖 OCCT）。
 * 运行: node tools/run-ts.mjs tools/sketch-test.ts
 */
import { solveSketch } from '../src/sketch/solver';
import {
  emptySketch,
  newId,
  ellipsePointAt,
  parabolaPointAt,
  hyperbolaPointAt,
  slotTemplate,
  reflectPoint,
  mirrorEntitiesInPlace,
  arcAngles,
  type SkConstraint,
  type Sketch,
} from '../src/sketch/types';
import {
  bsplineInterpolate,
  bsplineEval,
  bsplinePolyline,
  bsplineBasis,
  expandKnots,
} from '../src/sketch/curve';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}  ${detail}`);
  }
}
const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;

function addPoint(sk: Sketch, x: number, y: number) {
  const id = newId('p');
  sk.points[id] = { id, x, y };
  return id;
}
function addLine(sk: Sketch, a: string, b: string) {
  const id = newId('e');
  sk.entities.push({ id, kind: 'line', a, b });
  return id;
}
function addCircle(sk: Sketch, c: string, r: number) {
  const id = newId('e');
  sk.entities.push({ id, kind: 'circle', c, r });
  return id;
}
function con(sk: Sketch, c: Omit<SkConstraint, 'id'>) {
  const id = newId('c');
  sk.constraints.push({ ...c, id });
  return id;
}

// ---------- 1. 矩形：水平/垂直/尺寸 ----------
console.log('【矩形约束】');
{
  const sk = emptySketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 41, 2.5); // 故意画歪
  const p3 = addPoint(sk, 39, 26);
  const p4 = addPoint(sk, 1, 24);
  const l1 = addLine(sk, p1, p2);
  const l2 = addLine(sk, p2, p3);
  const l3 = addLine(sk, p3, p4);
  const l4 = addLine(sk, p4, p1);
  sk.points[p1].fixed = true; // 固定左下角

  con(sk, { type: 'horizontal', e1: l1 });
  con(sk, { type: 'horizontal', e1: l3 });
  con(sk, { type: 'vertical', e1: l2 });
  con(sk, { type: 'vertical', e1: l4 });
  con(sk, { type: 'length', e1: l1, value: 40 });
  con(sk, { type: 'length', e1: l2, value: 25 });

  const st = solveSketch(sk);
  check('求解成功', st.state === 'well' || st.state === 'under', `state=${st.state} dof=${st.dof} res=${st.residual.toExponential(2)}`);
  check('p1 保持固定', near(sk.points[p1].x, 0) && near(sk.points[p1].y, 0));
  check('p2 = (40, 0)', near(sk.points[p2].x, 40) && near(sk.points[p2].y, 0),
    `= (${sk.points[p2].x.toFixed(3)}, ${sk.points[p2].y.toFixed(3)})`);
  check('p3 = (40, 25)', near(sk.points[p3].x, 40) && near(sk.points[p3].y, 25),
    `= (${sk.points[p3].x.toFixed(3)}, ${sk.points[p3].y.toFixed(3)})`);
  check('p4 = (0, 25)', near(sk.points[p4].x, 0) && near(sk.points[p4].y, 25),
    `= (${sk.points[p4].x.toFixed(3)}, ${sk.points[p4].y.toFixed(3)})`);
  check('自由度 = 0（完全定义）', st.dof === 0, `dof=${st.dof}`);
}

// ---------- 2. 圆：同心 + 相切 ----------
console.log('\n【圆约束】');
{
  const sk = emptySketch();
  const c1 = addPoint(sk, 0, 0);
  const c2 = addPoint(sk, 3, 1);
  const g1 = addCircle(sk, c1, 8);
  const g2 = addCircle(sk, c2, 4);
  sk.points[c1].fixed = true;

  con(sk, { type: 'concentric', e1: g1, e2: g2 });
  con(sk, { type: 'radius', e1: g1, value: 10 });
  con(sk, { type: 'diameter', e1: g2, value: 12 });

  const st = solveSketch(sk);
  check('求解成功', st.residual < 1e-6, `res=${st.residual.toExponential(2)}`);
  check('圆心重合', near(sk.points[c2].x, 0) && near(sk.points[c2].y, 0),
    `= (${sk.points[c2].x.toFixed(3)}, ${sk.points[c2].y.toFixed(3)})`);
  const r1 = sk.entities.find((e) => e.id === g1);
  const r2 = sk.entities.find((e) => e.id === g2);
  check('半径 10 / 直径 12', r1?.kind === 'circle' && near(r1.r, 10) && r2?.kind === 'circle' && near(r2.r, 6),
    `r1=${r1?.kind === 'circle' ? r1.r.toFixed(3) : '?'} r2=${r2?.kind === 'circle' ? r2.r.toFixed(3) : '?'}`);
}

// ---------- 3. 直线与圆相切 ----------
console.log('\n【相切】');
{
  const sk = emptySketch();
  const a = addPoint(sk, -20, 10);
  const b = addPoint(sk, 20, 12);
  const cc = addPoint(sk, 0, 0);
  const l = addLine(sk, a, b);
  const g = addCircle(sk, cc, 5);
  // 只固定圆心：直线可自由平移/旋转，应被拉到与圆相切且水平
  sk.points[cc].fixed = true;

  con(sk, { type: 'horizontal', e1: l });
  con(sk, { type: 'tangent', e1: l, e2: g });
  con(sk, { type: 'radius', e1: g, value: 5 });
  con(sk, { type: 'length', e1: l, value: 40 });

  const st = solveSketch(sk);
  check('求解成功', st.residual < 1e-6, `res=${st.residual.toExponential(2)}`);
  const y1 = sk.points[a].y;
  const y2 = sk.points[b].y;
  check('直线水平', near(y1, y2, 1e-4), `y = ${y1.toFixed(4)} / ${y2.toFixed(4)}`);
  check('与圆相切（距圆心 = r = 5）', near(Math.abs(y1), 5, 1e-3), `|y| = ${Math.abs(y1).toFixed(4)}`);
  const len = Math.hypot(sk.points[b].x - sk.points[a].x, sk.points[b].y - sk.points[a].y);
  check('长度 = 40', near(len, 40, 1e-3), `= ${len.toFixed(4)}`);
}

// ---------- 4. 平行 / 垂直 / 等长 ----------
console.log('\n【平行 / 垂直 / 等长】');
{
  const sk = emptySketch();
  const a1 = addPoint(sk, 0, 0);
  const a2 = addPoint(sk, 10, 1);
  const b1 = addPoint(sk, 0, 20);
  const b2 = addPoint(sk, 8, 23);
  const l1 = addLine(sk, a1, a2);
  const l2 = addLine(sk, b1, b2);
  sk.points[a1].fixed = true;
  sk.points[b1].fixed = true;
  sk.points[a2].fixed = true;

  con(sk, { type: 'parallel', e1: l1, e2: l2 });
  con(sk, { type: 'equal', e1: l1, e2: l2 });

  const st = solveSketch(sk);
  const d1 = { x: sk.points[a2].x - sk.points[a1].x, y: sk.points[a2].y - sk.points[a1].y };
  const d2 = { x: sk.points[b2].x - sk.points[b1].x, y: sk.points[b2].y - sk.points[b1].y };
  const cross = d1.x * d2.y - d1.y * d2.x;
  check('求解成功', st.residual < 1e-6, `res=${st.residual.toExponential(2)}`);
  check('平行（叉积≈0）', near(cross, 0, 1e-4), `cross=${cross.toExponential(2)}`);
  check('等长', near(Math.hypot(d1.x, d1.y), Math.hypot(d2.x, d2.y), 1e-4),
    `${Math.hypot(d1.x, d1.y).toFixed(4)} vs ${Math.hypot(d2.x, d2.y).toFixed(4)}`);
}

// ---------- 5. 过定义检测 ----------
console.log('\n【过定义检测】');
{
  const sk = emptySketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const l = addLine(sk, a, b);
  sk.points[a].fixed = true;
  sk.points[b].fixed = true;
  con(sk, { type: 'length', e1: l, value: 10 }); // 一致
  const ok = solveSketch(sk);
  check('一致约束不报错', ok.residual < 1e-6, `res=${ok.residual.toExponential(2)}`);

  const sk2 = emptySketch();
  const a2 = addPoint(sk2, 0, 0);
  const b2 = addPoint(sk2, 10, 0);
  const l2 = addLine(sk2, a2, b2);
  sk2.points[a2].fixed = true;
  sk2.points[b2].fixed = true;
  con(sk2, { type: 'length', e1: l2, value: 30 }); // 矛盾
  const bad = solveSketch(sk2);
  check('矛盾尺寸被检出', bad.state === 'failed', `state=${bad.state} res=${bad.residual.toFixed(3)}`);
}

// ---------- 6. 欠定义计数 ----------
console.log('\n【自由度计数】');
{
  const sk = emptySketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  addLine(sk, a, b);
  // 两个自由点 = 4 个变量，无约束 → 4 自由度
  const st = solveSketch(sk);
  check('无约束时 dof = 4', st.dof === 4, `dof=${st.dof}`);
  con(sk, { type: 'horizontal', e1: sk.entities[0].id });
  const st2 = solveSketch(sk);
  check('加水平后 dof = 3', st2.dof === 3, `dof=${st2.dof}`);
  con(sk, { type: 'length', e1: sk.entities[0].id, value: 50 });
  const st3 = solveSketch(sk);
  check('再加长度后 dof = 2', st3.dof === 2, `dof=${st3.dof}`);
}

// ---------- 7. 椭圆参数方程 ----------
console.log('\n【椭圆参数方程】');
{
  const e0 = { rx: 10, ry: 5, rot: 0 };
  const p0 = ellipsePointAt(e0, 0);
  check('t=0 落在长轴端点 (rx,0)', near(p0[0], 10) && near(p0[1], 0), `= [${p0[0].toFixed(3)}, ${p0[1].toFixed(3)}]`);
  const p90 = ellipsePointAt(e0, Math.PI / 2);
  check('t=π/2 落在短轴端点 (0,ry)', near(p90[0], 0) && near(p90[1], 5), `= [${p90[0].toFixed(3)}, ${p90[1].toFixed(3)}]`);

  // 旋转 π/2 后，t=0 应指向草图 +v 方向（长轴被竖起来）
  const e90 = { rx: 10, ry: 5, rot: Math.PI / 2 };
  const q0 = ellipsePointAt(e90, 0);
  check('rot=π/2 时长轴竖立', near(q0[0], 0) && near(q0[1], 10), `= [${q0[0].toFixed(3)}, ${q0[1].toFixed(3)}]`);
  // 参数方程满足 (u/rx')²+(v/ry')²=1：任取 t 验证隐式方程
  const t = 0.7;
  const [ex, ey] = ellipsePointAt(e90, t);
  const uu = ex * Math.cos(-e90.rot) - ey * Math.sin(-e90.rot);
  const vv = ex * Math.sin(-e90.rot) + ey * Math.cos(-e90.rot);
  check('参数点满足隐式椭圆方程', near((uu / e90.rx) ** 2 + (vv / e90.ry) ** 2, 1, 1e-9),
    `= ${((uu / e90.rx) ** 2 + (vv / e90.ry) ** 2).toFixed(6)}`);
}

// ---------- 8. 直槽口模板 ----------
console.log('\n【直槽口模板】');
{
  const tpl = slotTemplate([0, 0], [40, 0], 5)!;
  check('返回 6 个点', tpl.points.length === 6, `${tpl.points.length} 个`);
  check('返回 4 个实体', tpl.entities.length === 4, `${tpl.entities.length} 个`);
  const [c1, c2, p1, p2, p3, p4] = tpl.points;
  check('c1/c2 为给定圆心', near(c1[0], 0) && near(c1[1], 0) && near(c2[0], 40) && near(c2[1], 0));
  // 水平轴 ⇒ 法向 (0,1)：p1/p2 在 +n 侧，p3/p4 在 −n 侧
  check('p1/p2 在 +n 侧（y=+r）', near(p1[0], 0) && near(p1[1], 5) && near(p2[0], 40) && near(p2[1], 5),
    `p1=[${p1}], p2=[${p2}]`);
  check('p3/p4 在 −n 侧（y=−r）', near(p3[0], 40) && near(p3[1], -5) && near(p4[0], 0) && near(p4[1], -5),
    `p3=[${p3}], p4=[${p4}]`);
  const [l1, l2, a1, a2] = tpl.entities as any[];
  check('两条直边分别为 p1→p2、p4→p3', l1.kind === 'line' && l1.a === 2 && l1.b === 3 && l2.kind === 'line' && l2.a === 4 && l2.b === 5);
  check('两端半圆圆心分别为 c1、c2', a1.kind === 'arc' && a1.c === 0 && a2.kind === 'arc' && a2.c === 1);
  check('两端半圆均为顺时针（ccw=false，槽口整体顺时针绕行）', a1.ccw === false && a2.ccw === false);
  // 用 arcAngles 验证两个端帽都向「外侧」鼓出（右帽经 +u·r、左帽经 −u·r）
  {
    const skT = emptySketch();
    const pid = tpl.points.map(([x, y]) => { const id = newId('p'); skT.points[id] = { id, x, y }; return id; });
    for (const t of tpl.entities) {
      if (t.kind === 'arc') skT.entities.push({ id: newId('e'), kind: 'arc', c: pid[t.c], a: pid[t.a], b: pid[t.b], ccw: t.ccw });
    }
    const left = arcAngles(skT, skT.entities[0] as any); // c1 端
    const right = arcAngles(skT, skT.entities[1] as any); // c2 端
    // 左帽：c1=(0,0)，经 −u 侧 → 弧中点 x = −5
    const lx = skT.points[pid[0]].x + left.r * Math.cos((left.a0 + left.a1) / 2);
    const ly = skT.points[pid[0]].y + left.r * Math.sin((left.a0 + left.a1) / 2);
    // 右帽：c2=(40,0)，经 +u 侧 → 弧中点 x = 45
    const rx = skT.points[pid[1]].x + right.r * Math.cos((right.a0 + right.a1) / 2);
    const ry = skT.points[pid[1]].y + right.r * Math.sin((right.a0 + right.a1) / 2);
    check('左端帽向 −u 鼓出（中点 x=−5）', near(lx, -5, 1e-9) && near(ly, 0, 1e-9), `= [${lx.toFixed(3)}, ${ly.toFixed(3)}]`);
    check('右端帽向 +u 鼓出（中点 x=45）', near(rx, 45, 1e-9) && near(ry, 0, 1e-9), `= [${rx.toFixed(3)}, ${ry.toFixed(3)}]`);
  }
  // 槽口面积 = 矩形(L·2r) + 圆(πr²) = 40·10 + π·25
  const area = 40 * 2 * 5 + Math.PI * 25;
  check('理论面积 = 2rL + πr²', near(area, 478.5398, 0.01), `= ${area.toFixed(4)}`);

  check('零长度返回 null', slotTemplate([0, 0], [0, 0], 5) === null);
  check('零半径返回 null', slotTemplate([0, 0], [40, 0], 0) === null);

  // 倾斜 45°：法向应垂直于轴向
  const t45 = slotTemplate([0, 0], [10, 10], 2)!;
  const ux = 1 / Math.SQRT2, uy = 1 / Math.SQRT2;
  const dxv = t45.points[2][0] - t45.points[0][0];
  const dyv = t45.points[2][1] - t45.points[0][1];
  check('倾斜槽口切点垂直于轴向', near(dxv * ux + dyv * uy, 0, 1e-9) && near(Math.hypot(dxv, dyv), 2, 1e-9));
}

// ---------- 9. 镜像实体 ----------
console.log('\n【镜像实体】');
{
  // 关于 y 轴（过 (0,0)、(0,10)）镜像
  const r1 = reflectPoint([10, 0], [0, 0], [0, 10]);
  check('点关于 y 轴镜像', near(r1[0], -10) && near(r1[1], 0), `= [${r1[0]}, ${r1[1]}]`);
  // 关于 x 轴镜像
  const r2 = reflectPoint([3, 4], [0, 0], [10, 0]);
  check('点关于 x 轴镜像', near(r2[0], 3) && near(r2[1], -4), `= [${r2[0]}, ${r2[1]}]`);
  // 关于斜线 y=x 镜像（轴方向 45°）→ (3,4) ↦ (4,3)
  const r3 = reflectPoint([3, 4], [0, 0], [10, 10]);
  check('点关于 y=x 镜像', near(r3[0], 4) && near(r3[1], 3), `= [${r3[0]}, ${r3[1]}]`);
  // 轴上点不动
  const r4 = reflectPoint([0, 7], [0, 0], [0, 10]);
  check('轴上点保持不动', near(r4[0], 0) && near(r4[1], 7));

  const sk = emptySketch();
  const A = addPoint(sk, 0, 0);
  const B = addPoint(sk, 0, 10);
  const axis = addLine(sk, A, B); // 竖直镜像轴
  const cA = addPoint(sk, 10, 3);
  const circleId = addCircle(sk, cA, 5);
  const arcC = addPoint(sk, 10, -3);
  const arcA = addPoint(sk, 15, -3);
  const arcB = addPoint(sk, 10, 2);
  const arcId = newId('e');
  sk.entities.push({ id: arcId, kind: 'arc', c: arcC, a: arcA, b: arcB, ccw: true });
  const ellC = addPoint(sk, 20, 0);
  const ellId = newId('e');
  sk.entities.push({ id: ellId, kind: 'ellipse', c: ellC, rx: 8, ry: 3, rot: 0 });

  const before = sk.entities.length;
  const n = mirrorEntitiesInPlace(sk, axis, [circleId, arcId, ellId]);
  check('镜像 3 个实体', n === 3, `n=${n}`);
  check('实体数增加 3', sk.entities.length === before + 3, `${before} → ${sk.entities.length}`);

  const newCircle = sk.entities[before] as any;
  const c2 = sk.points[newCircle.c];
  check('圆：圆心镜像到 (−10,3)，半径不变', near(c2.x, -10) && near(c2.y, 3) && near(newCircle.r, 5),
    `c=[${c2.x}, ${c2.y}] r=${newCircle.r}`);

  const newArc = sk.entities[before + 1] as any;
  check('圆弧：手性翻转 ccw → false', newArc.kind === 'arc' && newArc.ccw === false);
  const na = sk.points[newArc.a];
  const nb = sk.points[newArc.b];
  check('圆弧：端点镜像正确', near(na.x, -15) && near(na.y, -3) && near(nb.x, -10) && near(nb.y, 2),
    `a=[${na.x}, ${na.y}] b=[${nb.x}, ${nb.y}]`);

  const newEll = sk.entities[before + 2] as any;
  // 竖直轴 ⇒ 轴角 π/2 ⇒ 新 rot = 2·(π/2) − 0 = π
  check('椭圆：rot 关于轴翻转（0 → π）', near(newEll.rot, Math.PI), `rot=${newEll.rot.toFixed(4)}`);

  // 镜像轴自身不会被镜像
  const n2 = mirrorEntitiesInPlace(sk, axis, [axis, circleId]);
  check('镜像轴自身被跳过', n2 === 1, `n=${n2}`);

  // 非直线作镜像轴 → 0
  const n3 = mirrorEntitiesInPlace(sk, circleId, [arcId]);
  check('非直线作轴时返回 0', n3 === 0, `n=${n3}`);
}

// ---------- 10. 椭圆尺寸驱动 ----------
console.log('\n【椭圆尺寸驱动】');
{
  const sk = emptySketch();
  const c = addPoint(sk, 0, 0);
  const eid = newId('e');
  sk.entities.push({ id: eid, kind: 'ellipse', c, rx: 5, ry: 2, rot: 0 });
  // 中心固定 + 两个尺寸 ⇒ 完全定义
  sk.points[c].fixed = true;
  con(sk, { type: 'radius', e1: eid, value: 12 }); // 驱动长半轴 rx
  con(sk, { type: 'minorRadius', e1: eid, value: 4 }); // 驱动短半轴 ry
  const st = solveSketch(sk);
  const ell = sk.entities[0] as any;
  check('radius 约束驱动长半轴 rx=12', near(ell.rx, 12), `rx=${ell.rx.toFixed(4)}`);
  check('minorRadius 约束驱动短半轴 ry=4', near(ell.ry, 4), `ry=${ell.ry.toFixed(4)}`);
  check('椭圆两尺寸 + 固定中心 ⇒ 完全定义', st.state === 'well' && st.dof === 0, `state=${st.state} dof=${st.dof}`);
}

// ---------- 11. 抛物线参数方程 ----------
console.log('\n【抛物线参数方程】');
{
  const focal = 5;
  const p0 = parabolaPointAt({ focal, rot: 0 }, 0);
  check('顶点在原点（t=0）', near(p0[0], 0) && near(p0[1], 0), `(${p0[0]}, ${p0[1]})`);

  const p10 = parabolaPointAt({ focal, rot: 0 }, 10);
  check('X(10) = 100/(4·5) = 5', near(p10[0], 5), `x=${p10[0]}`);
  check('Y(10) = 10', near(p10[1], 10), `y=${p10[1]}`);

  // 隐式方程 y² = 4fx
  let maxImp = 0;
  for (let t = -20; t <= 20; t += 1.25) {
    const [x, y] = parabolaPointAt({ focal, rot: 0 }, t);
    maxImp = Math.max(maxImp, Math.abs(y * y - 4 * focal * x));
  }
  check('所有采样点满足 y² = 4fx', maxImp < 1e-9, `max|y²−4fx| = ${maxImp.toExponential(2)}`);

  // 参数 t 就是局部 Y 坐标（OCCT Geom_Parabola 同一套参数化）
  check('参数 t 即局部 Y 坐标', near(parabolaPointAt({ focal, rot: 0 }, -7)[1], -7));

  // 旋转 90°：局部 +X（开口方向）映射到 +v
  const pr = parabolaPointAt({ focal, rot: Math.PI / 2 }, 10);
  check('rot=90° 时开口朝 +v', pr[1] > 0 && near(pr[1], 5), `(${pr[0].toFixed(3)}, ${pr[1].toFixed(3)})`);

  // 焦点位置：局部 (focal, 0)
  const axisPt = parabolaPointAt({ focal, rot: 0 }, 0);
  check('焦点在 (focal, 0) 的对称轴上', near(axisPt[0], 0) && near(axisPt[1], 0));
}

// ---------- 12. 双曲线参数方程 ----------
console.log('\n【双曲线参数方程】');
{
  const a = 8;
  const b = 5;
  const v0 = hyperbolaPointAt({ a, b, rot: 0 }, 0);
  check('顶点在 (a, 0)', near(v0[0], a) && near(v0[1], 0), `(${v0[0]}, ${v0[1]})`);

  const h12 = hyperbolaPointAt({ a, b, rot: 0 }, 1.2);
  check('X(1.2) = a·cosh(1.2)', near(h12[0], a * Math.cosh(1.2)), `x=${h12[0].toFixed(4)}`);
  check('Y(1.2) = b·sinh(1.2)', near(h12[1], b * Math.sinh(1.2)), `y=${h12[1].toFixed(4)}`);

  // 隐式方程 x²/a² − y²/b² = 1
  let maxImp = 0;
  for (let t = -2; t <= 2; t += 0.125) {
    const [x, y] = hyperbolaPointAt({ a, b, rot: 0 }, t);
    maxImp = Math.max(maxImp, Math.abs((x * x) / (a * a) - (y * y) / (b * b) - 1));
  }
  check('所有采样点满足 x²/a² − y²/b² = 1', maxImp < 1e-9, `max = ${maxImp.toExponential(2)}`);

  // 只取右支 ⇒ X 恒 ≥ a
  let minX = Infinity;
  for (let t = -2.5; t <= 2.5; t += 0.25) minX = Math.min(minX, hyperbolaPointAt({ a, b, rot: 0 }, t)[0]);
  check('只取右支（X ≥ a）', minX >= a - 1e-9, `minX=${minX.toFixed(4)}`);
}

// ---------- 13. B 样条全局插值 ----------
console.log('\n【B 样条全局插值】');
{
  const Q: [number, number][] = [
    [0, 0],
    [10, 8],
    [20, -6],
    [30, 10],
    [40, 0],
  ];
  const d = bsplineInterpolate(Q, 3, false);
  check('插值成功', !!d);
  if (d) {
    check('次数 = 3', d.degree === 3, `deg=${d.degree}`);
    check('控制点数 = 通过点数', d.poles.length === Q.length, `${d.poles.length}`);
    const sumMult = d.mults.reduce((s, m) => s + m, 0);
    check('Σ多重度 = 控制点数 + 次数 + 1', sumMult === d.poles.length + d.degree + 1,
      `${sumMult} vs ${d.poles.length + d.degree + 1}`);

    // 曲线必须严格穿过每个通过点（弦长参数化下的 u_k）
    const U = expandKnots(d);
    const lo = U[d.degree];
    const hi = U[U.length - 1 - d.degree];
    const lens = [0];
    let tot = 0;
    for (let i = 1; i < Q.length; i++) {
      tot += Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]);
      lens.push(tot);
    }
    let maxErr = 0;
    for (let k = 0; k < Q.length; k++) {
      const [x, y] = bsplineEval(d, lo + (hi - lo) * (lens[k] / tot));
      maxErr = Math.max(maxErr, Math.hypot(x - Q[k][0], y - Q[k][1]));
    }
    check('曲线严格通过每个通过点', maxErr < 1e-6, `最大偏差 = ${maxErr.toExponential(2)} mm`);

    const poly = bsplinePolyline(d, 64);
    check('采样折线点数 = 65', poly.length === 65, `${poly.length}`);
    check('折线起点 ≈ Q0', Math.hypot(poly[0][0] - Q[0][0], poly[0][1] - Q[0][1]) < 1e-6);
    check('折线终点 ≈ Q4', Math.hypot(poly[64][0] - Q[4][0], poly[64][1] - Q[4][1]) < 1e-6);
  }

  // 基函数的单位分解性质：Σ_i N_{i,p}(u) ≡ 1
  const U2 = [0, 0, 0, 0, 0.3, 0.6, 1, 1, 1, 1];
  let worst = 0;
  for (let u = 0.0001; u < 1; u += 0.01) {
    let s = 0;
    for (let i = 0; i < 6; i++) s += bsplineBasis(i, 3, u, U2);
    worst = Math.max(worst, Math.abs(s - 1));
  }
  check('基函数单位分解 ΣN = 1', worst < 1e-9, `max|ΣN−1| = ${worst.toExponential(2)}`);

  // 点数不足时自动降次
  const d2 = bsplineInterpolate([[0, 0], [10, 10]], 3, false);
  check('2 点 → 降为 1 次（直线）', !!d2 && d2.degree === 1, `deg=${d2?.degree}`);
  if (d2) {
    const mid = bsplineEval(d2, 0.5);
    check('直线中点 = (5, 5)', near(mid[0], 5) && near(mid[1], 5), `(${mid[0].toFixed(3)}, ${mid[1].toFixed(3)})`);
  }
  check('单点无法插值', bsplineInterpolate([[1, 1]], 3, false) === null);
  check('全部重合点无法插值', bsplineInterpolate([[3, 3], [3, 3]], 3, false) === null);

  // 闭合：首尾点必须重合
  const ring: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    ring.push([10 * Math.cos(ang), 10 * Math.sin(ang)]);
  }
  const dc = bsplineInterpolate(ring, 3, true);
  check('闭合插值成功', !!dc);
  if (dc) {
    const Uc = expandKnots(dc);
    const a0 = bsplineEval(dc, Uc[dc.degree]);
    const a1 = bsplineEval(dc, Uc[Uc.length - 1 - dc.degree]);
    check('闭合曲线首尾重合', Math.hypot(a0[0] - a1[0], a0[1] - a1[1]) < 1e-6,
      `|Δ| = ${Math.hypot(a0[0] - a1[0], a0[1] - a1[1]).toExponential(2)}`);
    // 闭合曲线也穿过每个给定点
    let cerr = 0;
    for (const q of ring) {
      let best = Infinity;
      for (const p of bsplinePolyline(dc, 400)) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
      cerr = Math.max(cerr, best);
    }
    check('闭合曲线穿过每个给定点', cerr < 1e-3, `最大偏差 = ${cerr.toExponential(2)} mm`);
  }
}

// ---------- 14. 高级曲线族的镜像 ----------
console.log('\n【高级曲线族镜像】');
{
  const sk = emptySketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const axis = addLine(sk, a, b);
  const pc = addPoint(sk, 5, 3);
  sk.entities.push({ id: newId('e'), kind: 'parabola', c: pc, focal: 4, rot: 0, t0: -5, t1: 5 });
  const hc = addPoint(sk, 12, 4);
  sk.entities.push({ id: newId('e'), kind: 'hyperbola', c: hc, a: 3, b: 2, rot: 0, t0: -1.6, t1: 1.6 });
  const sp = newId('e');
  sk.entities.push({ id: sp, kind: 'bspline', pts: [[2, 2], [4, 6], [8, 5]], closed: false });

  const targets = sk.entities.filter((e) => e.id !== axis).map((e) => e.id);
  const n = mirrorEntitiesInPlace(sk, axis, targets);
  check('镜像 3 个高级曲线实体', n === 3, `n=${n}`);

  const par = sk.entities.filter((e) => e.kind === 'parabola') as any[];
  check('抛物线镜像后数量 ×2', par.length === 2, `${par.length}`);
  // 关于水平轴镜像：rot 0 → 2·0 − 0 = 0（开口方向不变）
  check('抛物线 rot 关于水平轴取反', near(par[1].rot, 0), `rot=${par[1].rot.toFixed(4)}`);

  const hyp = sk.entities.filter((e) => e.kind === 'hyperbola') as any[];
  check('双曲线镜像后数量 ×2', hyp.length === 2, `${hyp.length}`);
  check('双曲线 rot 关于水平轴取反', near(hyp[1].rot, 0), `rot=${hyp[1].rot.toFixed(4)}`);

  const bs = sk.entities.filter((e) => e.kind === 'bspline') as any[];
  check('B 样条镜像后数量 ×2', bs.length === 2, `${bs.length}`);
  // 点 (2,2) 关于 y=0 镜像 → (2,−2)
  check('B 样条通过点逐个镜像', near(bs[1].pts[0][0], 2) && near(bs[1].pts[0][1], -2),
    `(${bs[1].pts[0][0]}, ${bs[1].pts[0][1]})`);

  // 斜轴镜像：rot 0 关于 45° 轴 → 90°
  const sk2 = emptySketch();
  const a2 = addPoint(sk2, 0, 0);
  const b2 = addPoint(sk2, 10, 10);
  const axis2 = addLine(sk2, a2, b2);
  const pc2 = addPoint(sk2, 4, 0);
  sk2.entities.push({ id: newId('e'), kind: 'parabola', c: pc2, focal: 3, rot: 0, t0: -4, t1: 4 });
  mirrorEntitiesInPlace(sk2, axis2, sk2.entities.filter((e) => e.id !== axis2).map((e) => e.id));
  const par2 = sk2.entities.filter((e) => e.kind === 'parabola') as any[];
  check('斜轴（45°）镜像 rot → 90°', near(par2[1].rot, Math.PI / 2, 1e-6), `rot=${((par2[1].rot * 180) / Math.PI).toFixed(2)}°`);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
