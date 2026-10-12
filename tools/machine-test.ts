/**
 * 拉力机（电子万能试验机）演示模型。
 *
 * 目的：用「草图 + 拉伸」构造一台可辨识的拉力机，并
 *   ① 用真实 OCCT 内核校验几何（体积/包围盒/错误）；
 *   ② 导出 `_machine.json`（项目文件），供浏览器端「文件 → 打开」载入演示。
 *
 * 造型（世界坐标 Z 向上）：在右视基准面（法向 +X）上画剖面，
 * 沿 X 对称拉伸成厚度，剖面平面内 local x = 世界 Y（进深）、local y = 世界 Z（高度）。
 *
 * 运行: node tools/run-ts.mjs tools/machine-test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { initOcctNode } from './oc-loader.mjs';
import { setOcct } from '../src/core/occt';
import * as S from '../src/core/solid';
import { RIGHT_PLANE, newId, emptySketch, type Sketch } from '../src/sketch/types';
import { rebuildFeatures, buildMeshResult } from '../src/doc/engine';
import type { Feature } from '../src/doc/types';

type Pt = [number, number];

/** 由一组闭合多边形（每个是一圈点）生成草图 */
function sketchOf(loops: Pt[][]): Sketch {
  const sk = emptySketch();
  for (const loop of loops) {
    const ids = loop.map(([x, y]) => {
      const id = newId('p');
      sk.points[id] = { id, x, y };
      return id;
    });
    for (let i = 0; i < ids.length; i++) {
      sk.entities.push({ id: newId('e'), kind: 'line', a: ids[i], b: ids[(i + 1) % ids.length] });
    }
  }
  return sk;
}

function sketchFeature(name: string, loops: Pt[][]): Feature {
  return {
    id: newId('f'),
    type: 'sketch',
    name,
    params: { plane: 'custom', customPlane: RIGHT_PLANE, sketch: sketchOf(loops) },
  } as Feature;
}

function extrudeFeature(name: string, sketchId: string, distance: number, operation: 'new' | 'add'): Feature {
  return {
    id: newId('f'),
    type: 'extrude',
    name,
    params: { sketchId, distance, symmetric: true, operation },
  } as Feature;
}

// ---------- 造型尺寸（mm） ----------
// 机架：底座 + 双立柱 + 上横梁（一块"门形"板，中间开窗）
const FRAME_OUTER: Pt[] = [[-150, 0], [150, 0], [150, 880], [-150, 880]];
const FRAME_WINDOW: Pt[] = [[-90, 120], [90, 120], [90, 800], [-90, 800]];
// 活动横梁（中横梁）
const CROSSHEAD: Pt[] = [[-160, 380], [160, 380], [160, 470], [-160, 470]];
// 上/下夹具
const GRIP_UP: Pt[] = [[-38, 690], [38, 690], [38, 800], [-38, 800]];
const GRIP_DOWN: Pt[] = [[-38, 120], [38, 120], [38, 230], [-38, 230]];

const skFrame = sketchFeature('机架草图', [FRAME_OUTER, FRAME_WINDOW]);
const exFrame = extrudeFeature('机架', skFrame.id, 200, 'new');
const skCross = sketchFeature('横梁草图', [CROSSHEAD]);
const exCross = extrudeFeature('活动横梁', skCross.id, 260, 'add');
const skGrip = sketchFeature('夹具草图', [GRIP_UP, GRIP_DOWN]);
const exGrip = extrudeFeature('夹具', skGrip.id, 80, 'add');

const features: Feature[] = [skFrame, exFrame, skCross, exCross, skGrip, exGrip];

// ---------- 导出项目文件 ----------
const docJson = { version: 1, features };
const outPath = path.resolve('_machine.json');
fs.writeFileSync(outPath, JSON.stringify(docJson, null, 1), 'utf8');
console.log(`已写出 ${outPath}`);

// ---------- 真实内核校验 ----------
const oc = await initOcctNode();
setOcct(oc);
console.log('内核已注入\n');

const { shape, errors } = rebuildFeatures(features);
console.log('重建错误:', errors.length ? JSON.stringify(errors) : '无');
if (!shape) {
  console.error('✗ 未生成实体');
  process.exit(1);
}

const vol = S.volume(shape);
const mp = S.massProperties(shape);
const mesh = buildMeshResult(shape);
const bb = S.boundingBox({ positions: new Float32Array(mesh.positions) });
console.log('体积:', vol.toFixed(1), 'mm³');
console.log('表面积:', mp.surfaceArea.toFixed(1), 'mm²');
console.log('质心:', mp.centroid.map((v) => v.toFixed(2)).join(', '));
console.log('包围盒:', bb.min.map((v) => v.toFixed(1)).join(', '), '~', bb.max.map((v) => v.toFixed(1)).join(', '));
console.log('面数:', mesh.faceMetas.length, '边数:', mesh.edgeMetas.length);

// 期望：X 跨度 260（活动横梁最宽），Y 跨度 320，Z 跨度 880
const dx = bb.max[0] - bb.min[0];
const dy = bb.max[1] - bb.min[1];
const dz = bb.max[2] - bb.min[2];
const ok =
  errors.length === 0 &&
  Math.abs(dx - 260) < 1 &&
  Math.abs(dy - 320) < 1 &&
  Math.abs(dz - 880) < 1 &&
  vol > 0;
console.log(ok ? '\n✓ 拉力机模型校验通过' : '\n✗ 校验失败');
process.exit(ok ? 0 : 1);
