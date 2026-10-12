/**
 * 实体 → three.js 对象。
 *
 * 关键变化（方案1）：不再从 TopoDS_Shape 直接建模，而是消费内核 Worker 回传的
 * **可序列化 MeshResult**（positions/normals/indices + faceRanges/edgePolylines +
 * faceMetas/edgeMetas）。本模块完全不 import opencascade——几何计算（三角剖分、
 * 特征边提取、面/边元数据）都在 Worker 里完成，这里只做渲染与拾取。
 *
 * 拾取：射线命中 triangleIndex → 二分查 faceRanges 反查面索引；特征边用屏幕空间
 * 距离判定（polyline 已在 MeshResult 里）。全程不需要任何 OCCT 句柄。
 */
import * as THREE from 'three';
import type { MeshResult, FaceMeta, EdgeMeta } from '../core/kernel-types';
import { COLORS, bodyMaterial, edgeMaterial, softEdgeMaterial } from './materials';

export type DisplayStyle = 'shadedEdges' | 'shaded' | 'wireframe' | 'hidden' | 'transparent';

export interface ShapeViewOptions {
  style?: DisplayStyle;
  edgeColor?: number;
  bodyColor?: number;
  showEdges?: boolean;
}

export class ShapeView {
  readonly group: THREE.Group;
  readonly mesh: THREE.Mesh;
  readonly edgeLines: THREE.LineSegments;
  readonly meshResult: MeshResult;
  readonly faceMetas: FaceMeta[];
  readonly edgeMetas: EdgeMeta[];
  private material: THREE.MeshStandardMaterial;
  private edgeMat: THREE.LineBasicMaterial;
  private style: DisplayStyle;

  constructor(mesh: MeshResult, opts: ShapeViewOptions = {}) {
    this.style = opts.style ?? 'shadedEdges';
    this.meshResult = mesh;
    this.faceMetas = mesh.faceMetas;
    this.edgeMetas = mesh.edgeMetas;

    const positions = new Float32Array(mesh.positions);
    const normals = new Float32Array(mesh.normals);
    const indices = new Uint32Array(mesh.indices);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    mesh.faceRanges.forEach((r, i) => geo.addGroup(r.start, r.count, i));
    geo.computeBoundingSphere();

    this.material = bodyMaterial();
    if (opts.bodyColor !== undefined) this.material.color.setHex(opts.bodyColor);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'body';
    this.mesh.userData.kind = 'solid';

    // ---- 特征边（线框）----
    const epts: number[] = [];
    for (const flat of mesh.edgePolylines) {
      for (let i = 3; i < flat.length; i += 3) {
        epts.push(flat[i - 3], flat[i - 2], flat[i - 1], flat[i], flat[i + 1], flat[i + 2]);
      }
    }
    const egeo = new THREE.BufferGeometry();
    egeo.setAttribute('position', new THREE.Float32BufferAttribute(epts, 3));
    this.edgeMat = edgeMaterial();
    if (opts.edgeColor !== undefined) this.edgeMat.color.setHex(opts.edgeColor);
    this.edgeLines = new THREE.LineSegments(egeo, this.edgeMat);
    this.edgeLines.name = 'edges';
    this.edgeLines.userData.kind = 'edges';

    this.group = new THREE.Group();
    this.group.name = 'shape';
    this.group.add(this.mesh);
    this.group.add(this.edgeLines);
    this.applyStyle(this.style);
  }

  /** 三角索引 → 面索引 */
  faceIndexFromTriangle(tri: number): number {
    const ranges = this.meshResult.faceRanges;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (tri * 3 < r.start) hi = mid - 1;
      else if (tri * 3 >= r.start + r.count) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  faceAt(tri: number): number {
    return this.faceIndexFromTriangle(tri);
  }

  /** 取某个面的独立网格（用于高亮） */
  faceGeometry(faceIndex: number): THREE.BufferGeometry | null {
    const r = this.meshResult.faceRanges[faceIndex];
    if (!r) return null;
    const positions = new Float32Array(this.meshResult.positions);
    const normals = new Float32Array(this.meshResult.normals);
    const indices = new Uint32Array(this.meshResult.indices);
    const md = { positions, normals, indices };
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(r.count * 3);
    const nrm = new Float32Array(r.count * 3);
    const idx = new Uint32Array(r.count);
    const map = new Map<number, number>();
    for (let k = 0; k < r.count; k++) {
      const src = md.indices[r.start + k];
      let dst = map.get(src);
      if (dst === undefined) {
        dst = map.size;
        map.set(src, dst);
        pos[dst * 3] = md.positions[src * 3];
        pos[dst * 3 + 1] = md.positions[src * 3 + 1];
        pos[dst * 3 + 2] = md.positions[src * 3 + 2];
        nrm[dst * 3] = md.normals[src * 3];
        nrm[dst * 3 + 1] = md.normals[src * 3 + 1];
        nrm[dst * 3 + 2] = md.normals[src * 3 + 2];
      }
      idx[k] = dst;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, map.size * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, map.size * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /** 取某条边的折线几何（用于高亮） */
  edgeGeometry(edgeIndex: number): THREE.BufferGeometry | null {
    const flat = this.meshResult.edgePolylines[edgeIndex];
    if (!flat || flat.length < 6) return null;
    const pts: number[] = [];
    for (let i = 3; i < flat.length; i += 3) {
      pts.push(flat[i - 3], flat[i - 2], flat[i - 1], flat[i], flat[i + 1], flat[i + 2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  }

  applyStyle(style: DisplayStyle): void {
    this.style = style;
    const mat = this.material;
    switch (style) {
      case 'shaded':
        this.mesh.visible = true;
        this.edgeLines.visible = false;
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = true;
        this.mesh.material = mat;
        break;
      case 'shadedEdges':
        this.mesh.visible = true;
        this.edgeLines.visible = true;
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = true;
        this.mesh.material = mat;
        break;
      case 'wireframe': {
        this.mesh.visible = true;
        this.edgeLines.visible = true;
        const wire = new THREE.MeshBasicMaterial({
          color: COLORS.body,
          wireframe: true,
          transparent: true,
          opacity: 0.5,
        });
        this.mesh.material = wire;
        break;
      }
      case 'hidden':
        this.mesh.visible = true;
        this.edgeLines.visible = true;
        mat.transparent = true;
        mat.opacity = 0.14;
        mat.depthWrite = false;
        this.mesh.material = mat;
        break;
      case 'transparent':
        this.mesh.visible = true;
        this.edgeLines.visible = true;
        mat.transparent = true;
        mat.opacity = 0.42;
        mat.depthWrite = false;
        this.mesh.material = mat;
        break;
    }
    if (style !== 'wireframe') this.mesh.material = mat;
  }

  setEdgeColor(hex: number): void {
    this.edgeMat.color.setHex(hex);
  }

  setBodyColor(hex: number): void {
    this.material.color.setHex(hex);
  }

  setGhost(g: boolean): void {
    if (g) {
      this.material.transparent = true;
      this.material.opacity = 0.3;
      this.material.depthWrite = false;
      this.edgeMat.opacity = 0.35;
    } else {
      this.applyStyle(this.style);
      this.edgeMat.opacity = 0.85;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.edgeLines.geometry.dispose();
    this.material.dispose();
    this.edgeMat.dispose();
    (this.edgeLines.material as THREE.Material).dispose();
  }
}

/** 由若干折线构造 LineSegments 几何 */
export function polylinesGeometry(polys: [number, number, number][][]): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const poly of polys) {
    for (let i = 1; i < poly.length; i++) {
      pts.push(...poly[i - 1], ...poly[i]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

export { softEdgeMaterial };
