/**
 * 「测量」工具纯几何测试（measure-math.ts）。
 *
 * 只测主线程可算的部分（点-线段/点-三角形/点-面/点-边距离、夹角）；
 * 面↔面/边↔边/面↔边 的最小距离走内核，由 browser-smoke 端到端覆盖。
 *
 * 运行: node tools/run-ts.mjs tools/measure-test.ts
 */
import {
  angleBetweenDeg,
  pointEdgeDistance,
  pointFaceDistance,
  pointSegmentDistance,
  pointTriangleDistance,
  vecDist,
} from '../src/ui/measure-math';
import type { MeshResult, Vec3 } from '../src/core/kernel-types';

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
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- 点-线段 ----
check('点-线段：垂足在线段内', near(pointSegmentDistance([0, 1, 0], [0, 0, 0], [2, 0, 0]), 1));
check('点-线段：垂足超过末端取端点', near(pointSegmentDistance([3, 1, 0], [0, 0, 0], [2, 0, 0]), Math.SQRT2));
check('点-线段：垂足在起点之前取端点', near(pointSegmentDistance([-1, 1, 0], [0, 0, 0], [2, 0, 0]), Math.SQRT2));
check('点-线段：退化线段退化为点距离', near(pointSegmentDistance([1, 1, 1], [0, 0, 0], [0, 0, 0]), Math.sqrt(3)));
check('点-线段：三维斜线段', near(pointSegmentDistance([0, 0, 1], [1, -1, 0], [1, 1, 0]), Math.SQRT2));

// ---- 点-三角形（z=3 平面上的直角三角形 (0,0),(4,0),(0,4)）-------
const A: Vec3 = [0, 0, 3];
const B: Vec3 = [4, 0, 3];
const C: Vec3 = [0, 4, 3];
check('点-三角形：垂足在内部', near(pointTriangleDistance([1, 1, 0], A, B, C), 3));
check('点-三角形：垂足在顶点区', near(pointTriangleDistance([0, 0, 0], A, B, C), 3));
check('点-三角形：垂足在斜边BC上', near(pointTriangleDistance([3, 3, 0], A, B, C), Math.sqrt(11)));
check('点-三角形：远离顶点B的精确距离', near(pointTriangleDistance([4, 0, 0], A, B, C), 3));
check('点-三角形：直角三角形斜边上方的点', near(pointTriangleDistance([2, 2, 6], A, B, C), 3));

// ---- 合成网格：面 = 两个三角形拼成的 z=0 四边形 [0,2]x[0,2] ----
const pos = new Float32Array([
  0, 0, 0, 2, 0, 0, 2, 2, 0,
  0, 0, 0, 2, 2, 0, 0, 2, 0,
]);
const idx = new Uint32Array([0, 1, 2, 3, 4, 5]);
const mesh = {
  positions: pos.buffer,
  indices: idx.buffer,
  faceRanges: [{ start: 0, count: 6 }],
  edgePolylines: [[0, 0, 0, 2, 0, 0, 2, 0, 4]],
} as unknown as MeshResult;

check('点-面：四边形正上方（平面内投影）', near(pointFaceDistance([1, 1, 5], 0, mesh), 5));
check('点-面：角点外侧（最近点=角(2,2,0)）', near(pointFaceDistance([3, 3, 4], 0, mesh), Math.sqrt(18)));
check('点-面：四边形外侧最近点在边上', near(pointFaceDistance([4, 1, 0], 0, mesh), 2));
check('点-边：折线中段上方（最近点是第二段上的(2,0,2)）', near(pointEdgeDistance([1, 0, 2], 0, mesh), 1));
check('点-边：折线末端外', near(pointEdgeDistance([3, 0, 0], 0, mesh), 1));

// ---- 夹角 ----
check('夹角：平行=0', near(angleBetweenDeg([1, 0, 0], [2, 0, 0]), 0));
check('夹角：反向取锐角=0', near(angleBetweenDeg([1, 0, 0], [-3, 0, 0]), 0));
check('夹角：垂直=90', near(angleBetweenDeg([0, 0, 1], [1, 0, 0]), 90));
check('夹角：45°', near(angleBetweenDeg([1, 0, 0], [1, 1, 0]), 45));
check('夹角：零向量返回 0', near(angleBetweenDeg([0, 0, 0], [1, 0, 0]), 0));

// ---- 向量距离 ----
check('3-4-5 距离', near(vecDist([0, 0, 0], [3, 4, 0]), 5));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
