/**
 * 内核集成测试 —— 验证 src/core/* 的封装是否真的可用。
 * 运行: node tools/run-kernel-test.mjs
 */
import { initOcctNode } from './oc-loader.mjs';
import { setOcct, gp, trsfEuler, trsfTranslate, deg2rad } from '../src/core/occt';
import * as S from '../src/core/solid';
import { tessellate, extractEdges, extractSharpEdges } from '../src/core/mesh';
import { exportSTEP, importSTEP } from '../src/core/io';
import { exportSTLBinary, exportOBJ } from '../src/core/meshexport';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${label}  ${detail}`); }
}
function near(a: number, b: number, tol = 1e-2) { return Math.abs(a - b) <= tol; }

const oc = await initOcctNode();
setOcct(oc);
console.log('内核已注入\n');

// ---------- 基本体 ----------
console.log('【基本体】');
const box = S.primitives.box(40, 25, 15);
check('长方体体积', near(S.volume(box), 15000), `= ${S.volume(box).toFixed(2)} / 15000`);
const cyl = S.primitives.cylinder(6, 30);
check('圆柱体积', near(S.volume(cyl), Math.PI * 36 * 30), `= ${S.volume(cyl).toFixed(2)}`);
const sph = S.primitives.sphere(10);
check('球体积', near(S.volume(sph), (4 / 3) * Math.PI * 1000), `= ${S.volume(sph).toFixed(2)}`);
const cone = S.primitives.cone(6, 2, 10);
check('圆锥体积', near(S.volume(cone), (Math.PI * 10 / 3) * (36 + 12 + 4)), `= ${S.volume(cone).toFixed(2)}`);
const tor = S.primitives.torus(10, 2);
check('圆环体积', near(S.volume(tor), 2 * Math.PI * Math.PI * 10 * 4), `= ${S.volume(tor).toFixed(2)}`);

// ---------- 布尔 ----------
console.log('\n【布尔运算】');
const hole = S.primitives.cylinderOn([20, 12.5, -5], [0, 0, 1], 6, 25);
const cutRes = S.cut(box, hole);
check('差集体积', near(S.volume(cutRes), 15000 - Math.PI * 36 * 15), `= ${S.volume(cutRes).toFixed(2)}`);
const fused = S.fuse(box, S.translate(S.primitives.box(40, 25, 15), 40, 0, 0));
check('并集体积', near(S.volume(fused), 30000), `= ${S.volume(fused).toFixed(2)}`);
const inter = S.common(box, S.translate(S.primitives.box(40, 25, 15), 20, 0, 0));
check('交集体积', near(S.volume(inter), 7500), `= ${S.volume(inter).toFixed(2)}`);

// ---------- 草图 → 拉伸 ----------
console.log('\n【草图 → 拉伸 → 圆角】');
const profileFace = S.faceFromPoints([[0, 0, 0], [40, 0, 0], [40, 25, 0], [0, 25, 0]]);
const extruded = S.extrude(profileFace, [0, 0, 1], 15);
check('拉伸体积', near(S.volume(extruded), 15000), `= ${S.volume(extruded).toFixed(2)}`);

const circleFace = S.faceFromWire(S.circleWire([20, 12.5, 0], [0, 0, 1], 6));
const cutExtrude = S.cut(extruded, S.extrude(circleFace, [0, 0, 1], 15));
check('拉伸切除体积', near(S.volume(cutExtrude), 15000 - Math.PI * 36 * 15), `= ${S.volume(cutExtrude).toFixed(2)}`);

const eList = S.edges(cutExtrude);
const filleted = S.fillet(cutExtrude, eList.slice(0, 4), 3);
check('圆角', S.volume(filleted) < S.volume(cutExtrude), `体积 ${S.volume(cutExtrude).toFixed(1)} → ${S.volume(filleted).toFixed(1)}`);

const chamfered = S.chamfer(cutExtrude, eList.slice(0, 4), 2);
check('倒角', S.volume(chamfered) < S.volume(cutExtrude), `体积 ${S.volume(chamfered).toFixed(1)}`);

// ---------- 抽壳 ----------
console.log('\n【抽壳】');
const topFaces = S.faces(box).filter((f) => {
  const m = tessellate(f);
  let z = 0;
  for (let i = 2; i < m.positions.length; i += 3) z += m.positions[i];
  return z / (m.positions.length / 3) > 14;
});
check('找到顶面', topFaces.length === 1, `找到 ${topFaces.length} 个`);
if (topFaces.length) {
  const shelled = S.shell(box, topFaces, 2);
  // 外形 40×25×15，去掉顶面、壁厚 2 → 内腔 36×21×13
  const expectShell = 15000 - 36 * 21 * 13;
  check('抽壳体积', near(S.volume(shelled), expectShell, 1), `= ${S.volume(shelled).toFixed(2)} / 预期 ${expectShell}`);
}

// ---------- 旋转 / 放样 / 扫掠 ----------
console.log('\n【旋转 / 放样 / 扫掠】');
const revProfile = S.faceFromPoints([[2, 0, 0], [6, 0, 0], [6, 0, 10], [2, 0, 10]]);
const revolved = S.revolve(revProfile, [0, 0, 0], [0, 0, 1], Math.PI * 2);
check('旋转成型体积', near(S.volume(revolved), Math.PI * 32 * 10, 1), `= ${S.volume(revolved).toFixed(2)}`);

const loftA = S.circleWire([0, 0, 0], [0, 0, 1], 10);
const loftB = S.circleWire([0, 0, 20], [0, 0, 1], 5);
const lofted = S.loft([loftA, loftB], true, false);
check('放样体积', near(S.volume(lofted), (Math.PI * 20 / 3) * (100 + 50 + 25), 1), `= ${S.volume(lofted).toFixed(2)}`);

const spine = S.wireFromPoints([[0, 0, 0], [0, 0, 20]], false);
const swept = S.sweep(spine, S.faceFromPoints([[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]]));
check('扫掠体积', S.volume(swept) > 300, `= ${S.volume(swept).toFixed(2)}`);

// ---------- 阵列 / 镜像 ----------
console.log('\n【阵列 / 镜像】');
const linPat = S.linearPattern(S.primitives.box(5, 5, 5), [1, 0, 0], 10, 4);
check('线性阵列体积', near(S.volume(linPat), 500), `= ${S.volume(linPat).toFixed(2)}`);
const cirPat = S.circularPattern(S.primitives.box(2, 2, 2), [0, 0, 0], [0, 0, 1], 4, Math.PI * 2);
check('圆周阵列体积', near(S.volume(cirPat), 32, 0.5), `= ${S.volume(cirPat).toFixed(2)}`);
// 不合并（merge=false）必须返回含**全部**实例的复合体，而不是只返回第一个实例。
// 回归：旧实现 return instances[0] 会静默丢掉其余 count-1 个实例（只剩 1 个实体）。
const linPatSep = S.linearPattern(S.primitives.box(5, 5, 5), [1, 0, 0], 10, 4, false);
check('线性阵列(不合并)含全部 4 个实例', S.solids(linPatSep).length === 4, `= ${S.solids(linPatSep).length} 实体`);
const cirPatSep = S.circularPattern(S.primitives.box(2, 2, 2), [0, 0, 0], [0, 0, 1], 4, Math.PI * 2, false);
check('圆周阵列(不合并)含全部 4 个实例', S.solids(cirPatSep).length === 4, `= ${S.solids(cirPatSep).length} 实体`);
const mirrored = S.mirrorPlane(S.primitives.box(10, 10, 10), [0, 0, 0], [1, 0, 0]);
const mProps = S.massProperties(mirrored);
check('镜像后质心 X 反向', near(mProps.centroid[0], -5, 0.1), `x = ${mProps.centroid[0].toFixed(2)}`);

// ---------- 变换 ----------
console.log('\n【变换】');
// 绕 Z 轴转 90°：(x,y) → (-y,x)，质心 (20,12.5) → (-12.5,20)，再沿 X 平移 100
const eulerMoved = S.transform(box, trsfEuler(0, 0, deg2rad(90), [100, 0, 0]));
const em = S.massProperties(eulerMoved);
check('欧拉角变换后质心', near(em.centroid[0], 87.5, 0.5) && near(em.centroid[1], 20, 0.5),
  `= (${em.centroid.map((v) => v.toFixed(1)).join(', ')}) 期望 (87.5, 20, 7.5)`);
// 纯平移矩阵
const movedT = S.transform(box, [1, 0, 0, 5, 0, 1, 0, -3, 0, 0, 1, 2]);
const mt = S.massProperties(movedT);
check('矩阵平移后质心', near(mt.centroid[0], 25, 0.5) && near(mt.centroid[1], 9.5, 0.5) && near(mt.centroid[2], 9.5, 0.5),
  `= (${mt.centroid.map((v) => v.toFixed(1)).join(', ')})`);

// ---------- 网格 ----------
console.log('\n【网格化】');
const mesh = tessellate(filleted, { linearDeflection: 0.1 });
check('顶点数 > 0', mesh.vertexCount > 0, `${mesh.vertexCount} 顶点`);
check('三角形数 > 0', mesh.triangleCount > 0, `${mesh.triangleCount} 三角形`);
check('面区间数量 = 面数', mesh.faceRanges.length === S.faces(filleted).length,
  `${mesh.faceRanges.length} vs ${S.faces(filleted).length}`);
check('索引不越界', mesh.indices.every((i) => i < mesh.vertexCount));
const bb = S.boundingBox(mesh);
check('包围盒', near(bb.min[0], 0, 0.01) && near(bb.max[0], 40, 0.01),
  `[${bb.min.map((v) => v.toFixed(1))}] ~ [${bb.max.map((v) => v.toFixed(1))}]`);

const edgePolys = extractEdges(filleted);
check('边折线提取', edgePolys.length > 0, `${edgePolys.length} 条边`);
check('每条边至少 2 点', edgePolys.every((e) => e.points.length >= 2));
const sharp = extractSharpEdges(box, 25);
check('特征边筛选', sharp.length === 12, `${sharp.length} 条特征边（长方体 12 条棱）`);
check('拓扑去重', S.edges(box).length === 12 && S.vertices(box).length === 8,
  `边 ${S.edges(box).length} / 顶点 ${S.vertices(box).length}（期望 12 / 8）`);

// ---------- 文件 ----------
console.log('\n【文件导出导入】');
const stepBytes = exportSTEP(filleted);
const stepHead = new TextDecoder().decode(stepBytes.slice(0, 13));
check('STEP 导出', stepBytes.length > 1000 && stepHead.includes('ISO-10303-21'),
  `${stepBytes.length} 字节, 头="${stepHead.trim()}"`);
const reimported = importSTEP(stepBytes);
check('STEP 往返体积一致', near(S.volume(reimported), S.volume(filleted), 0.5),
  `${S.volume(reimported).toFixed(2)} vs ${S.volume(filleted).toFixed(2)}`);

const stl = exportSTLBinary(mesh);
check('STL 二进制导出', stl.byteLength === 84 + mesh.triangleCount * 50,
  `${stl.byteLength} 字节 (84 + ${mesh.triangleCount}×50)`);
const obj = exportOBJ(mesh);
check('OBJ 导出', obj.includes('v ') && obj.includes('f '), `${obj.split('\n').length} 行`);

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
