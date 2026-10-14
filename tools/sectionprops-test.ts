/**
 * 截面属性纯几何单测（对应 src/core/sectionprops.ts）。
 * 运行：node tools/run-ts.mjs tools/sectionprops-test.ts
 */
import { sliceMeshPlane, computeSectionProps, planeThrough } from '../src/core/sectionprops';

let pass = 0;
let fail = 0;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}  ${extra}`); }
}

/** 构造一个边长 1、中心在 c 的立方体网格（12 三角形） */
function cube(cx: number, cy: number, cz: number): { pos: Float32Array; idx: Uint32Array } {
  const h = 0.5;
  const v = [
    [cx - h, cy - h, cz - h], [cx + h, cy - h, cz - h], [cx + h, cy + h, cz - h], [cx - h, cy + h, cz - h],
    [cx - h, cy - h, cz + h], [cx + h, cy - h, cz + h], [cx + h, cy + h, cz + h], [cx - h, cy + h, cz + h],
  ];
  const tris = [
    [0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7], [0, 3, 7], [0, 7, 4],
    [1, 2, 6], [1, 6, 5], [0, 1, 5], [0, 5, 4], [3, 2, 6], [3, 6, 7],
  ];
  const pos = new Float32Array(v.length * 3);
  v.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => { idx[i * 3] = t[0]; idx[i * 3 + 1] = t[1]; idx[i * 3 + 2] = t[2]; });
  return { pos, idx };
}

console.log('截面切片（立方体）');
{
  const { pos, idx } = cube(0, 0, 0);
  const z0 = sliceMeshPlane(pos, idx, planeThrough('top', 0)); // 上视基准面 = XY 平面 (z=0)
  check('z=0 切立方体得到 1 个环', z0.length === 1, `${z0.length}`);
  const props = computeSectionProps(z0);
  check('截面面积 = 1', !!props && near(props.area, 1, 1e-6), `${props?.area}`);
  check('形心 ≈ (0,0)', !!props && near(props.cx, 0) && near(props.cy, 0), `${props?.cx},${props?.cy}`);
  check('Ixx = 1/12', !!props && near(props.Ixx, 1 / 12, 1e-9), `${props?.Ixx}`);
  check('Iyy = 1/12', !!props && near(props.Iyy, 1 / 12, 1e-9), `${props?.Iyy}`);
  check('Ixy ≈ 0', !!props && near(props.Ixy, 0, 1e-9), `${props?.Ixy}`);
  check('Izz = Ixx+Iyy', !!props && near(props.Izz, 1 / 6, 1e-9), `${props?.Izz}`);
  check('主惯性矩 Ix1 ≥ Iy1', !!props && props.Ix1 >= props.Iy1 - 1e-12);
  check('回转半径 Rx ≈ sqrt(1/12)', !!props && near(props.Rx, Math.sqrt(1 / 12), 1e-9), `${props?.Rx}`);
}

console.log('偏移仍给出相同截面（平行于面的任意剖切）');
{
  const { pos, idx } = cube(0, 0, 0);
  const p = planeThrough('top', 0.25); // z=0.25，仍在立方体内
  const props = computeSectionProps(sliceMeshPlane(pos, idx, p));
  check('面积仍为 1', !!props && near(props.area, 1, 1e-6), `${props?.area}`);
  check('Ixx 仍为 1/12', !!props && near(props.Ixx, 1 / 12, 1e-9), `${props?.Ixx}`);
}

console.log('平面未与实体相交');
{
  const { pos, idx } = cube(0, 0, 0);
  const props = computeSectionProps(sliceMeshPlane(pos, idx, planeThrough('top', 1.0))); // z=1，错过
  check('返回 null', props === null);
  const miss = sliceMeshPlane(pos, idx, planeThrough('top', 1.0));
  check('切片返回空数组', miss.length === 0, `${miss.length}`);
}

console.log('多实体（两个立方体）→ 两个环，面积叠加');
{
  const a = cube(-1.5, 0, 0);
  const b = cube(1.5, 0, 0);
  // 合并两份网格
  const pos = new Float32Array(a.pos.length + b.pos.length);
  pos.set(a.pos, 0); pos.set(b.pos, a.pos.length);
  const idx = new Uint32Array(a.idx.length + b.idx.length);
  idx.set(a.idx, 0);
  b.idx.forEach((v, i) => (idx[a.idx.length + i] = v + a.pos.length / 3));
  const loops = sliceMeshPlane(pos, idx, planeThrough('top', 0));
  check('得到 2 个环', loops.length === 2, `${loops.length}`);
  const props = computeSectionProps(loops);
  check('总面积 ≈ 2', !!props && near(props.area, 2, 1e-6), `${props?.area}`);
  check('环数 = 2', !!props && props.loops === 2, `${props?.loops}`);
}

console.log(`\n截面属性单测：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
